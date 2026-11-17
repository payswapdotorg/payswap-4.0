# P2 环境就绪审计与整改报告（Environment readiness audit and remediation）

> **TL 维护** · 审计日期：2026-11-17 · 审计环境：TL Linux 沙箱（Debian 13 容器）
> · 审计基线：`main` @ `8d595ed32cd48858ecfe3f0b32f6cc4996caa93d`（PR #44 合并点）
> · 整改分支：`p2/environment-readiness-audit`（本 PR）。
>
> **定位声明**：本报告**不是**里程碑状态登记 —— 里程碑状态的唯一权威登记仍是
> [docs/payswap/p0/10-roadmap.md](../p0/10-roadmap.md) 的 Live delivery status
> register。本报告承载：环境能力清单、验收-能力矩阵、确切阻塞项、证据、整改与
> 成本权衡。P2 在本报告落笔时保持 `in_progress`。

---

## 1. 最终裁决（executive verdict）

| 裁决项 | 结论 |
|---|---|
| 原 TL 环境（Linux 沙箱）足以关闭 P2 吗 | **否**。原生 Windows 验收在本环境**结构性不可执行**（无 Windows 内核、无桌面会话、无 DPAPI）—— 基础设施边界，不可在沙箱内修复。 |
| 原 TL 环境已能证明什么 | Linux 侧回归（法则测试、ubuntu 容器 E2E 电池、E2B live 配方）、网络可达性、仓库治理（lint/architecture/roadmap 校验）。 |
| 已确认并修复的缺陷 | **harness 平台缺陷**：`scripts/payswap/live/main.cjs` 步骤 1 无条件调用 Linux-only API `safeStorage.getSelectedStorageBackend()` —— win32 上即 `TypeError`，live harness 在原生 Windows 上无法起步。已修复并以 12 行回归测试钉死（§5）。 |
| 整改后的充分环境是什么 | **本地 Windows agent 机器**（原生 Win10/11 交互桌面）+ **已激活的 Stripe test 账户** + 经 0600 env 文件供给的受限只读键。本 PR 把该路径做成可复现工具链（preflight + 五分类 runner + 交接文档）。 |
| P2 因此关闭了吗 | **否**。环境就绪 ≠ P2 完成 —— live 验收工作流仍须实际执行（§11 列出剩余项）。 |

**使命边界如实声明**：环境就绪审计的首要问题是「环境是否足以证明 P2」，而不是
「CI/E2B/桌面构建绿了所以大概行」。本审计的每个结论都有命令级证据支撑（附录 E 表），
跑不了的测试一律不记为通过。

---

## 2. 审计环境清单（TL 沙箱，2026-11-17）

| 项 | 事实 | 证据 |
|---|---|---|
| 操作系统 | Debian GNU/Linux 13 (trixie)，内核 `5.10.134-013.15.kangaroo.al8.x86_64`，x86_64 | E-01 |
| 环境形态 | Linux 容器（`/.dockerenv` 在场）。**非**原生 Windows、**非** WSL2（容器本身即工作面，宿主为 Linux 内核）、非 E2B | E-01 |
| 真实 Windows 桌面会话 | **无**。`DISPLAY`/`WAYLAND_DISPLAY` 皆空（headless） | E-01 |
| Electron 桌面应用可运行性 | **不可**（无显示服务；Linux 上 Electron 无头启动仅对 CLI 形态有意义，且 `safeStorage` 在无 Secret Service 的无头容器里不可用 —— repo 自身在 `scripts/payswap/live/README.md` 的环境要求一节已有此结论） | E-01, E-12 |
| Node.js | v24.22.3（repo 引擎 `>=24.0.0` ✓） | E-02 |
| npm | 11.19.1 | E-02 |
| pnpm | 审计时**缺席**；经 corepack 安装 `pnpm@10.33.2`（与 `packageManager` 钉版一致） | E-03 |
| git | 2.47.3 | E-02 |
| PowerShell | **无**（`pwsh`/`powershell` 均不在） | E-02 |
| Electron 二进制 | 初始无；`pnpm install --frozen-lockfile` 后 44.7.0（desktop 钉版）落位 | E-04 |
| 编译/构建工具 | gcc/g++/make 在场（Linux 原生模块重建已由 postinstall 完成） | E-02 |
| 资源 | 2 vCPU / 4.1 GB RAM / 安装前 7.6 GB 可用磁盘（低于桌面构建的舒适线，够 workspace 安装） | E-01 |
| 网络 — GitHub | `github.com` 200、`api.github.com` 匿名 403（限流面，认证后正常） | E-05 |
| 网络 — Stripe | `GET https://api.stripe.com/v1/balance`（无认证）→ **HTTP 401**：api.stripe.com **可达**（401 正是无认证的预期应答） | E-06 |
| 浏览器自动化 | 无预装浏览器/Playwright 运行面；repo 的 wdio/wdio-electron-service 依赖已随 install 落位（Linux 容器 E2E 电池形态 —— CI 已有 ubuntu 容器腿承载，无需本沙箱重复） | E-04 |
| CI / 工件存储 | GitHub Actions 可达（repo 公有，PR CI 三工作流：`ci.yml`、`payswap-desktop-e2e.yml`、`payswap-roadmap.yml`） | E-05, §3 |
| 秘密供给通道 | **受限**：本沙箱的 env 变量经工具调用注入即进入会话转录 —— **不是**合格的真实键供给通道。真实键只应在验收机本地经 0600 env 文件供给（§7、handoff）。TL 环境因此**不持有**也**不应持有** `ZCODE_E2E_STRIPE_LIVE_KEY` | 审计判断（通道性质） |

---

## 3. 审计时点的仓库状态（以仓库为准，不采信旧交接摘要）

- `main` HEAD = `8d595ed32cd48858ecfe3f0b32f6cc4996caa93d`（Merge PR #44 `p2/win-tar-drive-colon`，2026-11-16 18:23:01 +0000）；工作树干净、无未提交改动。E-07
- P2 证据登记面（[live-acceptance-evidence.md](live-acceptance-evidence.md)）：2026-11-14 两次独立 E2B 复现 —— E2E live spec **3/3**（connect connected / refresh **verified** / revoke + at-rest 删除）；对话面 harness 步骤 1–8 ok、步骤 9 落 **typed `read_back_unavailable` 拒绝边界**（`RESULT_HARNESS=1`，lawful fail-closed）。E-08
- 里程碑登记（10-roadmap.md）：**P2 `in_progress`** —— 末项「四类别 live read-back」阻塞于**账户激活**；P3 的验证/契约层已开工但 P2 仍是顶层阻塞。E-09
- 既有 Windows 覆盖：`ci.yml` 的 `gates-windows`（windows-latest）**只承载 P1.3 broker peer-verification 平台行**（bootstrap 工作区构建 + peer 套件）—— **不含**桌面构建、桌面 E2E、safeStorage/DPAPI、live Stripe。E-10
- 桌面 E2E 电池的 CI 承载：`payswap-desktop-e2e.yml` 在 **ubuntu-22.04 容器**跑（absent / gnome-libsecret 两腿）—— Windows 桌面 E2E 无 CI 承载。E-10
- repo 自身的桌面 E2E 入口 `pnpm --filter @zcode/desktop test:e2e` = `run-windows-e2e-shards.mjs`（Windows 形态的本地分片 runner）—— 运营模式本身预期一台本地 Windows 机器承载桌面 E2E。E-10
- 既有 P2 脚本/测试资产：`scripts/payswap/live/`（harness 全家）、`packages/desktop/test/payswap-*`（法则电池，CI `gates` 的 P2 engineering battery 已注册 13 文件）、`e2b-drive.mjs`（完整性判定层）。E-08

---

## 4. 验收-环境能力矩阵（P2 验收要求 → 环境能力）

状态词汇：**PASS** = 本环境可执行并证明；**PARTIAL** = 可执行部分相关测试但不足以
证明完整要求；**BLOCKED** = 本环境无法执行该证明。「本环境」= TL Linux 沙箱。

| # | 验收要求 | 所需环境能力 | 状态 | 证据 | 缺口 |
|---|---|---|---|---|---|
| 1 | Windows 桌面构建 | 原生 Windows 构建工具链 | **BLOCKED** | E-01 | 无 Windows（Linux 容器）。CI 的 `gates-windows` 也不含桌面构建（E-10） |
| 2 | Electron 真实启动 | 真实 Windows 桌面会话 | **BLOCKED** | E-01 | headless Linux；无桌面会话 |
| 3 | DPAPI 凭据存储 | Windows Electron safeStorage（DPAPI） | **BLOCKED** | E-01, E-12 | Linux 上 safeStorage 走 libsecret（gnome_libsecret 腿），**不是** DPAPI 证明 |
| 4 | 加密往返（原生） | 真运行时加密/解密测试 | **BLOCKED**（Windows 面） | E-12 | E2B/Linux 往返已证（2026-11-14），但不迁移为 Windows 证明 |
| 5 | at-rest 检查 | 访问真实 Windows 凭据存储面 | **BLOCKED** | E-01 | 同上 |
| 6 | 连接 UI | 桌面交互 | **PARTIAL** | E-08, E-10 | ubuntu 容器 E2E（connection-ui spec）+ E2B live spec 已证 UI 旅程；Windows 原生窗口证明缺 |
| 7 | Stripe 认证 | 受保护的真实测试键 | **BLOCKED**（TL 沙箱内） | §2 秘密通道行 | 键不在 TL 环境；且聊天转录不是合格秘密通道 —— 键须在验收机本地经 0600 env 文件供给 |
| 8 | Stripe 读回 | 到 Stripe 的真实网络 | **PARTIAL** | E-06 | api.stripe.com 可达（401 探针）；实际读回需键（本环境无） |
| 9 | 账户证据 | 已激活的 Stripe test 账户 | **BLOCKED**（外部依赖） | E-08 §1.3 | 账户存在（`acct_1UblugEz3o7yd7Uo`）、键权限面五端点 200 已证（2026-11-14）；**邮箱验证激活未完成** → capabilities 空 |
| 10 | 四类别数据检索 | 真实 provider 数据 + 足够权限 | **BLOCKED** | E-08 §1.3 | 双重阻塞：键不在本环境 + 账户未激活（激活前 detail 恒为 typed 拒绝 —— lawful fail-closed） |
| 11 | reader 桥 | 真实认证桌面桥 | **PARTIAL** | E-08 步骤 7–8 | 桥铸造与两跳形态已在 Linux/E2B 证；Windows 原生证明缺 |
| 12 | New Task 对话 | 真实运行中的 PaySwap 应用 | **PARTIAL** | E-08 步骤 8 | 对话面 overview/detail 的桥形态已在 Linux 证（步骤 8；步骤 10 待激活后）；真应用交互式 New Task 验收须在 Windows 桌面（本环境无） |
| 13 | 重启持久性 | 应用终止与重启能力 | **PARTIAL** | E-10 | connection-ui spec 的 corrupted-key restart 臂在 ubuntu CI 电池；**完整**重启持久性（正常重启后连接保持 + 免重连刷新）在 Windows 待证（runner 人工清单步骤 6–7） |
| 14 | 撤销 | 应用与凭据存储访问 | **PARTIAL** | E-08 | revoke 终态 + at-rest 删除已在 E2B live spec 证（Linux）；Windows 面待证 |
| 15 | 回归套件 | 完整仓库测试/构建环境 | **PARTIAL** | E-04, E-10, E-11 | Linux 面全绿（安装/lint/architecture/42 法则行/roadmap 校验）；Windows 面仅 P1.3 broker 行有 CI |
| 16 | 证据捕获 | 消毒、可复现日志与工件 | **PASS** | E-08, E-13, E-14 | 既有 e2b-drive 完整性判定层 + 证据登记纪律；本 PR 新增 Windows runner 的消毒工件面（leak-scan + SHA-256 manifest） |

**矩阵读法**：16 行中 0 行 PASS-only-for-Windows；凡要求原生 Windows 的行
（1–5、13 的 Windows 半）在 TL 沙箱全部 BLOCKED —— 这是**基础设施**边界，
不是工具链缺口。跑不了的测试一律不记通过。

---

## 5. 已确认的 harness 平台缺陷与修复（Worker A 裁决）

### 5.1 缺陷确认（仓库源码为证）

`scripts/payswap/live/main.cjs` 步骤 1（审计基线的 237 行）：

```js
const backendSelected = safeStorage.getSelectedStorageBackend();  // ← 无平台门
if (backendSelected !== EXPECTED_BACKEND) { throw ... }
```

事实链：

1. `safeStorage.getSelectedStorageBackend()` 是 Electron 的 **Linux-only** API ——
   Chromium/Electron 源码以 `#if BUILDFLAG(IS_LINUX)` 编译期裁剪
   （`shell/browser/api/electron_api_safe_storage.cc`，Electron 37 线源码可查）；
   Electron 官方文档标注 *getSelectedStorageBackend() Linux*。win32 运行时上该方法
   **不存在**，调用即 `TypeError: safeStorage.getSelectedStorageBackend is not a
   function` —— live harness 在原生 Windows 上**第一步就崩**，无从起步。
2. 生产侧早已正确：`pspCredentialKeyStore.ts` 的查询按
   `dependencies.platform === "linux" ? ... : undefined` 门住；
   `pspSafeStorageBackendPolicy.ts` **法则 2** 明文「调用方不得在非 Linux 平台
   查询后端名」。缺陷纯属 harness 侧违反自家法则。
3. 伴生的潜伏设计错误：`main.cjs` 头注与缺省值宣称 `win32 → "dpapi"` —— 但
   Windows 上**不存在**任何返回后端名的 API，「期望 dpapi」无从比较（不得发明
   Windows 后端名 API —— 见下）。

### 5.2 修复（本 PR）

| 文件 | 角色 |
|---|---|
| `scripts/payswap/live/safe-storage-backend-gate.cjs`（新） | 平台感知门的纯函数模块：linux = 后端名闭集（缺省 `gnome_libsecret`，`ZCODE_PAYSWAP_LIVE_EXPECT_BACKEND` 可覆盖 kwallet 腿；API 缺席 = fail-closed）；win32 = `isEncryptionAvailable()` 门（DPAPI）；darwin = 同（Keychain）；其余平台 fail-closed。IO 全注入 —— 与生产模块同款法则级可测形态 |
| `scripts/payswap/live/main.cjs`（改） | 步骤 1 改用门模块；`EXPECTED_BACKEND` 收敛为**仅 linux 消费**（win32/darwin 的 "dpapi"/"keychain" 缺省值删除 —— 无 API 可比较的死值）；头注同步。Linux 行为**逐字节保持**（同缺省、同 env 覆盖、同失败语义） |
| `scripts/payswap/live/safe-storage-backend-gate.test.mjs`（新） | 12 行回归矩阵：**win32/darwin 永不调用 Linux-only API**（throwing spy 钉死 —— 任何回归性无条件调用立即红）；win32/darwin 不可用即 fail-closed；linux 闭集（basic_text/unknown/未知名拒绝）；kwallet5 覆盖腿；unsupported 平台 fail-closed；「expectedBackend 在 win32 不被消费且永不编造后端名」 |
| `.github/workflows/payswap-roadmap.yml`（改） | 新增步骤跑上述测试（与 validate-roadmap 同节点、零依赖秒级；PR + main 双触发） |

### 5.3 边界保持（审计确认未破坏项）

- **Gate E2 语义零改动**：两级 fail-closed 存储判、`PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE` / `PAYSWAP_PSP_KEY_UNWRAP_FAILED` typed 拒绝、首写往返验证、无静默轮换 —— 生产模块一行未动（`pnpm exec vitest run --project engineering` 的 6 套 P2 法则电池 42/42 绿，E-11）。
- **未发明 Windows 后端名 API**；**未引入任何 fallback 加密**；win32 的「真实 OS 钥匙串」证明 = DPAPI 可用性 + 加解密往返（真 Electron 运行时探针承载，见 §8 preflight/probe）。
- Linux live 配方（vm-*.sh / e2b-drive）行为不变 —— `vm-harness-only.sh` 无需改动（其对步骤 1 的消费面只依赖步骤名与退出码语义）。

---

## 6. 原生 Windows 就绪裁决与研究（Worker A + 环境研究）

### 6.1 裁决

- **TL Linux 沙箱：BLOCKED（基础设施）** —— 无 Windows 内核/桌面/DPAPI，且此边界
  不可由沙箱内的任何「环境改进」消除（装 Wine/容器化 Windows 均不构成原生桌面
  验收环境，见 §6.3）。
- **本 PR 之后：路径就绪** —— 本地 Windows agent 按交接文档执行
  `preflight → 五分类 runner`，即可产出原生 Windows 验收证据（机器要求见 §8 与
  [ENVIRONMENT-READINESS-HANDOFF.md](ENVIRONMENT-READINESS-HANDOFF.md)）。

### 6.2 Windows CI runner（补充证据的可行性与边界）

以主源核查的事实（Electron 官方文档/源码、GitHub runner-images 仓库与文档、
Playwright 官方文档；来源清单见附录 E-15）：

- GitHub-hosted `windows-latest`（Windows Server 2025）/`windows-2022` 是**真实
  单用 Windows VM**，以管理员运行且**存在交互桌面会话**（Electron 团队成员在
  actions/runner-images #14069 的陈述 + 自动登录史实 #629）—— Playwright Electron
  测试与 Electron 自家 CI 在其上运行是既成事实。
- 边界：**无 RDP 人工介入面、机器临时、镜像每周漂移、首登弹窗偶发** —— 适合承载
  **自动化** Windows 证据（构建/法则/E2E/safeStorage 探针），**不能**替代本地
  机器的交互式验收（对话级验收需要真人 + 真应用）。handoff 的原则成立：CI 可
  **补充**，不可**替代**原生桌面验收。
- **建议（未在本 PR 实施 —— 范围纪律）**：后续可加 windows-latest 工作流跑
  `windows-build` + `windows-secure-storage` 两分类（`gates-windows` 之外新增，
  复用本 PR 的 preflight/探针/回归测试；约 10–15 min/job，公有仓库免费）。
  本 PR 不动 CI 布局 —— Windows 验收以本地 agent 为既定运营路径。

### 6.3 备选环境研究（若本地 Windows 不可得）

| 方案 | 交互桌面 | 快照/重置 | 成本（2026-11 查证） | 裁决 |
|---|---|---|---|---|
| 本地 Windows agent | ✓ | 手工 | 已有机器（零增量） | **首选**（handoff 既定路径） |
| Windows 365 Cloud PC | ✓（真 Win11 桌面，RDP/Web） | reprovision（重置） | $25.60–56/用户/月 | 无本地机时的**首选租赁**（保真度最高） |
| Azure VM（Windows Server） | ✓（RDP） | 磁盘快照 | B2s $0.0496/hr；D2s_v5 $0.188/hr + 磁盘 | 自动化长跑经济；注意是 Server 版 |
| AWS EC2（Windows Server） | ✓（RDP） | EBS 快照/AMI | t3.medium $0.06/hr；t3.large $0.1108/hr | 同上 |
| Paperspace（DO） | ✓ | 模板/快照 | $22–35/月（含许可） | 低价真桌面备选 |
| GitHub windows runner | 会话在场但无人工面 | ✗（临时） | 公有仓库 $0；私有 $0.010/min | 仅自动化补充证据 |
| Windows 容器（mcr/windows/*） | **✗**（Server Core 无桌面、无交互会话） | ✓ | 低 | **不可替代**桌面验收（判死） |
| WSL2 | ✗（Linux 面；DPAPI 不经 WSL2 的 Electron 形态证明） | — | — | 不构成 Windows 桌面验收（handoff 原则） |

### 6.4 桌面自动化与证据能力（Worker C）

Playwright/wdio Electron 面（`_electron.launch`、main 进程 `evaluate`、截图、
a11y 快照）在 Windows 一等支持 —— repo 的 wdio 电池（`payswap-connection-ui` /
`payswap-connection-live`）即是该形态，直接在 Windows 机器上可跑。本 PR runner
的工件面（消毒日志 + `summary.json` + SHA-256 manifest + 字节级泄漏自检）保证
「凭据不因自动化泄漏进转录/日志/截图」：键值置换发生在**落盘前**，工件定稿前
逐文件字节扫描，命中即 FAIL（绝不静默擦除掩盖产品缺陷）。

---

## 7. Stripe 测试账户就绪裁决（Worker B）

以仓库证据登记为源（本 TL 环境无键、无账户访问面 —— 不编造）：

| 项 | 状态 | 证据 |
|---|---|---|
| 账户存在 | ✓ 真实 test 账户 `acct_1UblugEz3o7yd7Uo` | E-08 §1 |
| 受限键权限面 | ✓ `rk_test_*`，Read on Account/Accounts/Balance/Charges/Customers/Disputes —— 五端点 live 200 验证（2026-11-14） | E-08 §1 |
| 连接/刷新/撤销链 | ✓ E2E live spec 3/3 两次复现（Linux/E2B） | E-08 §1.1 |
| **账户激活** | **✗ 未完成** —— 邮箱验证激活待办（验证邮件在操作者 Gmail 收件箱 plus-alias 投递；test 模式禁 API 自激活 ——「Only live keys」） | E-08 §1.3 |
| 四类别数据 | **✗ 未落地** —— 激活前 capabilities 空 → `get_account_overview` detail 恒为 typed `read_back_unavailable`（lawful fail-closed，非缺陷） | E-08 §1.2–1.3 |

**确切的缺项与正当动作**：在 Stripe dashboard 完成账户激活的**邮箱验证**一步
（操作者 Gmail 收件箱），激活后 capabilities 填充。这是**外部依赖**，不是环境
问题、也不是 adapter/桥/对话面的缺陷 —— 不得把 provider 拒绝误分类为环境阻塞。
激活后的复跑即 `stripe-live` 分类（E2E live spec + harness）；预期 `RESULT_HARNESS=0`
（四类别数据经直连与桥两跳落地）。

新增的先导自证：preflight 的授权探针（键在场时 `GET /v1/balance` 带 Bearer →
只报状态/对象/account id，**永不回显键值**）在长跑前即发现键被吊销/权限缩水，
避免 45 分钟 E2E 后才发现键失效。

---

## 8. 环境整改实施清单（本 PR）与缺口分类

按 handoff §8 的分类法：

| 分类 | 项 | 处置 |
|---|---|---|
| Harness 缺陷 | main.cjs 无平台门 + 死缺省值 | **已修复**（§5：门模块 + 修复 + 12 行回归 + CI 挂载） |
| 环境配置 | TL 沙箱 pnpm 缺席 | 会话内 corepack 安装 10.33.2（E-03）；Windows 机器由 preflight 的 hint 指引同款动作 |
| 环境配置 | 验收机自证（OS/工具链/桌面会话/Electron/safeStorage/网络/键在场） | **已交付** `scripts/payswap/preflight-env.cjs`（+ `electron-safe-storage-probe.cjs` 真 Electron 探针）：逐项 pass/warn/fail/skip + 修复 hint + 五分类可执行裁决 + `--json` 机读面；fail-closed（fail 级检查 → exit 1） |
| 基础设施 | 原生 Windows 验收执行面 | **已交付** `scripts/payswap/windows/run-p2-acceptance.cjs`：五分类 runner（build / secure-storage / desktop-e2e / stripe-live / conversation-acceptance），结论词汇闭集 PASS/FAIL/BOUNDARY/SKIP/MANUAL-PENDING，**任何 SKIP/MANUAL-PENDING/assumption 都不让 run 变绿**（exit 0/1/2/3），消毒工件 + 泄漏自检 + SHA-256 manifest。执行本体移交本地 Windows agent（§6.3 备选租赁方案已给出成本） |
| 基础设施 | Windows CI 补充 | 建议 + 片段（§6.2）—— 未实施（范围纪律：Windows 验收以本地 agent 为既定路径） |
| 外部依赖 | Stripe 账户激活 | **不可由本环境消除** —— 正当动作已明确（§7）；激活后复跑 `stripe-live` |
| 环境配置 | 秘密通道 | handoff 明确 0600 env 文件纪律；preflight/runner 的键面只做在场/格式/授权检查，永不出值 |

**执行细节**（preflight/runner 的完整用法、失败分诊表、证据登记动作）见
[ENVIRONMENT-READINESS-HANDOFF.md](ENVIRONMENT-READINESS-HANDOFF.md)。

---

## 9. 本审计实际执行的验证（全部在 TL Linux 沙箱；Linux 补充证据，**非** Windows 验收）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `git clone https://github.com/payswapdotorg/payswap-4.0.git`（匿名） | 0 | 365 MB 工作副本（公有仓库） |
| `git rev-parse HEAD` / `git status --short` | 0 | `8d595ed3…`；工作树干净 |
| `corepack enable --install-directory ~/.local/bin && corepack prepare pnpm@10.33.2 --activate` | 0 | `pnpm 10.33.2`（钉版一致） |
| `pnpm install --frozen-lockfile` | 0 | 58.3s；postinstall node-pty Linux 重建完成 |
| `pnpm lint`（oxlint 0-errors 门） | 0 | 0 errors（97 条**既有** warnings —— 门只看 errors） |
| `node scripts/architecture/architecture-check.mjs check` | 0 | violations 0 |
| `node scripts/payswap/validate-roadmap.mjs` | 0 | 单一权威 roadmap 通过 |
| `node --test scripts/payswap/validate-roadmap.test.mjs` | 0 | 全绿 |
| `node --test scripts/payswap/live/safe-storage-backend-gate.test.mjs`（新） | 0 | **12/12**（win32/darwin 不触碰 Linux-only API 的回归行在内） |
| `pnpm exec vitest run --project engineering`（6 个 P2 法则套件） | 0 | **42/42**（key-store / storage-policy / runtime-wiring / ipc / warmup / reader-bridge-entry） |
| `node scripts/payswap/preflight-env.cjs`（本沙箱） | 1 | **按设计 fail-closed**：pnpm（当时）缺席、磁盘 7.6 GB 低于 8 GB 线、electron（当时）未装 —— 修复 hint 逐项给出；Windows 分类全部 N/A、stripe-live GATED |
| `node scripts/payswap/windows/run-p2-acceptance.cjs --dry-run`（本沙箱） | 2 | **按设计不转绿**：五分类全 SKIP（Linux 沙箱 + 无键），汇总表明示 NOT GREEN |
| `node scripts/payswap/windows/run-p2-acceptance.cjs --stage bogus` | 3 | 用法错误路径正确 |
| `curl -sS -o /dev/null -w '%{http_code}' https://api.stripe.com/v1/balance` | 0 | `401`（无认证预期应答 —— 可达性证明） |
| `node --check`（4 个新/改 .cjs） | 0 | 语法面通过 |

同一批结果已按登记纪律追加进
[live-acceptance-evidence.md](live-acceptance-evidence.md) §7（含工件指针与
SHA-256）。

---

## 10. 成本与运营权衡（ remediation 决策记录）

| 路径 | 增量成本 | 运营复杂度 | 证据保真度 | 决策 |
|---|---|---|---|---|
| 本地 Windows agent + 本 PR 工具链 | 0（既有机器） | 低（handoff 命令即抄即用） | 最高（真桌面、真 DPAPI、可交互） | **采用** |
| + windows-latest CI 补充 | ~0（公有仓库）/ $0.010/min（私有） | 中（新工作流 + 镜像漂移维护） | 自动化面高、交互面无 | 建议（后续 PR） |
| Windows 365 租赁 | $25.60–56/用户/月 | 低-中 | 高（真 Win11 桌面） | 无本地机时备选 |
| Azure/AWS/Paperspace VM | $0.05–0.19/hr + 磁盘 / $22+/月 | 中（自助运维 + 快照纪律） | 高（Server 版注意） | 自动化长跑备选 |
| Windows 容器 | 低 | 低 | **无桌面面 —— 不合格** | 否决 |

---

## 11. P2 关闭前剩余项（本使命不宣称 P2 完成）

1. 本地 Windows agent 执行 `windows-build` → `windows-secure-storage` →
   `windows-desktop-e2e` 三分类（handoff 命令），证据入登记面。
2. Stripe 账户完成**邮箱验证激活**（操作者动作，§7）。
3. 复跑 `stripe-live` 分类：E2E live spec 3/3（Windows 面）+ harness
   `RESULT_HARNESS=0`（四类别数据经直连与桥两跳落地）。
4. `conversation-acceptance`：交互式 New Task 全流程（13 步清单）→ 证据回执
   校验通过。
5. 以上证据经评审合入后，roadmap P2 行按其自身词汇（`gate_passed` → `complete`）
   由 TL 更新 —— 本报告与 runner 输出都不替代该登记。

---

## 附录 E：证据参考

| 编号 | 内容 | 采集 |
|---|---|---|
| E-01 | `uname -a`、`/etc/os-release`、`/.dockerenv`、`DISPLAY`/`WAYLAND_DISPLAY`、`nproc`/`free -h`/`df -h`（2026-11-17，TL 沙箱） | 本审计 §2；登记面 §7 |
| E-02 | `node --version` / `npm --version` / `git --version` / `command -v pwsh powershell electron code gcc make cmake` | 同上 |
| E-03 | corepack 安装与 `pnpm --version` → 10.33.2 | §9 |
| E-04 | `pnpm install --frozen-lockfile` 完整日志（58.3s，exit 0） | §9 |
| E-05 | `curl` github.com 200 / api.github.com 403（匿名限流面） | §9 |
| E-06 | `curl` api.stripe.com/v1/balance → 401 | §9 |
| E-07 | `git rev-parse HEAD` / `git log -1` / `git status --short --branch` | §3 |
| E-08 | [live-acceptance-evidence.md](live-acceptance-evidence.md) §1–§6（2026-11-14 E2B 双复现 + 工具链重建溯源） | 仓库登记面 |
| E-09 | [10-roadmap.md](../p0/10-roadmap.md) P2 行（in_progress；四类别 read-back 阻塞于账户激活） | 仓库登记面 |
| E-10 | `.github/workflows/ci.yml`（gates / gates-macos / gates-windows 三 job 的步骤面）、`payswap-desktop-e2e.yml`（ubuntu-22.04 两腿）、`packages/desktop/package.json`（test:e2e = run-windows-e2e-shards.mjs） | §3 |
| E-11 | `pnpm exec vitest run --project engineering`（6 套件 42/42）+ `pnpm lint`（0 errors）+ architecture check（0 violations）+ roadmap 校验 | §9 |
| E-12 | `scripts/payswap/live/README.md` 环境要求一节（dev 沙箱容器无 Secret Service —— live 一律 VM/E2B）；Electron 官方 safeStorage 文档（Windows=DPAPI；getSelectedStorageBackend Linux-only） | 仓库 + Electron 官方文档 |
| E-13 | preflight 本沙箱运行输出（fail-closed 演示；工件 `/tmp/p2-dryrun-artifacts/preflight.json`，SHA-256 见登记面 §7） | §9 |
| E-14 | runner dry-run 本沙箱输出（全 SKIP / exit 2 / NOT GREEN；工件 `summary.json` 同目录） | §9 |
| E-15 | 环境研究主源：electronjs.org/docs/latest/api/safe-storage；github.com/electron/electron（`electron_api_safe_storage.cc`，`#if BUILDFLAG(IS_LINUX)`）；docs.github.com runners/定价；github.com/actions/runner-images#14069 与 #629；azure.com/api/retail/prices；aws ec2 on-demand 定价端点；microsoft.com/windows-365 与 virtualization/container 文档；playwright.dev/docs/api/class-electron | §6.2–§6.4 |
