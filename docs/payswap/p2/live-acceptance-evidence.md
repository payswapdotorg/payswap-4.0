# P2 live-acceptance evidence register（消毒登记 + 可复现工具链）

> **TL 维护** · 登记日期：2026-11-15 · 上游：PR #33（main @ `9bea2083`）。
> 本文件是 P2「real Stripe conversational」live 实证的**仓库内登记面**：证据
> 事实、消毒工件指针（含 SHA-256）、复现工具链、以及重建溯源。roadmap P2 行
> 是里程碑状态的唯一权威登记（本文件不重复状态裁决，只承载证据细节）。

## 1. 证据事实（2026-11-14，两次独立 E2B 沙箱复现）

环境：E2B 云 VM（Ubuntu + Node 24；真实 gnome-keyring Secret Service 腿 +
`--password-store=gnome-libsecret` + 真实网络）。账户：真实 Stripe test 账户
`acct_1UblugEz3o7yd7Uo`，以**受限只读键**操作（`rk_test_*`；Read on
Account/Accounts/Balance/Charges/Customers/Disputes —— 恰为 P2 读面；权限面
经五端点 live 200 验证：`/v1/account` `/v1/balance` `/v1/charges` `/v1/customers`
`/v1/disputes`）。

### 1.1 E2E live spec —— 3/3，两次复现

`payswap-connection-live.test.ts`（env-gated on `ZCODE_E2E_STRIPE_LIVE_KEY` +
gnome-libsecret 腿；stronger-than-CI —— 闭集收敛到必需结局）：

1. **live connect**：真实键经真实连接 UI → `connected`；at-rest 双 store 含
   connectionId、零键明文（连接记录 + 凭据密文直查）。
2. **live refresh**：真实 provider 读回（api.stripe.com）→ **`verified`**；
   状态保持 connected。
3. **live revoke**：终态 `revoked` + at-rest 本地秘密删除（记录仍在）。

### 1.2 对话面 harness —— 生产装配 × live（9 步骤，前 8 ok）

`live-harness-main.cjs`（真实 law 模块源码编译；真键仓 → 受监督运行时 →
MessageChannelMain 桥铸造 → 法则客户端）：

| # | 步骤 | 结局 |
|---|---|---|
| 1 | safeStorage 后端 = 真实 OS 钥匙串后端 | ✓ `gnome_libsecret` |
| 2 | app-ready warmup：PSP 键可从真钥匙串获得 | ✓ keyAvailable |
| 3 | 真实受限键 connect → connected | ✓（connectionId 落 record） |
| 4 | at-rest：连接记录含 connection、永不含键明文 | ✓ |
| 5 | at-rest：凭据 store 含 connection id、永不含键明文 | ✓ |
| 6 | refresh 打真 api.stripe.com | ✓ verified + `providerAccountId=acct_1UblugEz3o7yd7Uo` |
| 7 | 桥铸造产出真 MessageChannelMain 转移面 | ✓ |
| 8 | 对话面 overview 经真桥两跳形态应答 | ✓ count:1（连接在列） |
| 9 | 直连服务 `getOverviewData`（`get_account_overview` detail 面） | **typed `read_back_unavailable` 拒绝**（by design：全新未激活账户 capabilities 空 → 无能力证据 → evidence-backed 概览 fail-closed —— roadmap「typed refusals where unconfigured」条款的运行） |

`RESULT_HARNESS=1`：链路证到**拒绝边界**（lawful fail-closed，非缺陷）。

### 1.3 如实边界（P2 行保持 in_progress 的依据）

四类别对话**数据**流（`get_account_overview` 携 balance/payment_objects/
customers/disputes 数据）待账户**邮箱验证激活**：Stripe test 模式禁 API 自更新
（"Only live keys"）；dashboard 激活流 `email_verification_required`（验证邮件
在操作者 Gmail 收件箱 —— plus-alias 投递）。激活后 capabilities 填充、detail
即答数据。HTTP 层五端点 200 + 对话链证到拒绝边界 ≠ 四类别数据落地。

## 2. 消毒工件（仓库内，SHA-256 基准）

`evidence/live-acceptance/`：`live-conversational-evidence.json`（结构化 9 步）、
`payswap-connections-at-rest.json`（at-rest 连接记录快照）、`RESULT-harness.txt`、
`MANIFEST.md`（哈希 + 遗失工件如实登记 —— 155KB wdio 全量日志与 harness 控制台
日志随 2026-11-15 宿主回收遗失，事实以本登记与 PR #33 正文为准）。

## 3. 可复现工具链（`scripts/payswap/live/`，仓控重建版）

live spec（`packages/desktop/test/e2e/payswap-connection-live.test.ts`）+ 对话面
harness（`main.cjs` + `build-live-harness.mjs` + `sqlite-stub.cjs`）+ VM 运行器
（`vm-mega-setup.sh` / `vm-run-live.sh` / `vm-harness-only.sh`）+ E2B 驱动器示例
（`e2b-drive.mjs`）。用法与环境要求见该目录 `README.md`。

**验收判定**：`RESULT_E2E=0` 且 `RESULT_HARNESS=0`（后者当且仅当四类别数据经
直连与桥两跳两种形态落地）= P2 live 终局证据；`RESULT_HARNESS=1` = 拒绝边界
（账户未激活 —— 激活后重跑 harness 即得终局证据）。

## 4. 重建溯源（如实声明）

本工具链是 2026-11-15 的**仓控重建**，非 2026-11-14 产生原始证据的字节原件
（原件位于 E2B 沙箱与操作机 `/home/z/stripe-signup/`，未入仓控即随 TTL/回收
遗失 —— 架构师评审指出的可复现性缺口，本 PR 收口）。重建依据：PR #33 正文
（两工件的验收行为逐条记录）、登记证据 JSON（harness 步骤名/序/结局词汇逐字
保留）、连续性状态文件的战术记录（tsup 根目录编译、import_meta 修补、sqlite
stub、MessagePortMain 客户端 start()、ZCODE_DATA_BASE_DIR 跨 bundle 实例）。
与原件的**有意差异**：(a) 步骤 10 为重建新增（`get_account_overview` 的桥两跳
detail 形态 —— 「read-only ops run conversationally」条款的对话面 detail 半，
原件只记录了直连形态）；(b) bundle 编译改为单文件入口 + 显式 `.cjs` 扩展 +
fail-loud 修补验证（原件为根目录结构化编译 + 手工 sed）；(c) E2B 驱动器为最小
示例（原 `e2b-drive.cjs` 的会话管理/重试策略未逐字复原）。重建后的工具链**尚未
重跑 live 验收**（待账户激活后随终局四类别运行一并执行 —— 届时以本 manifest
的复现基准对照）。

## 5. 打包侧 ESM 语义裁决（架构师 2026-11-15，执行记录）

生产源码 `packages/services/src/terminal/terminalService.ts:16` 的
`createRequire(import.meta.url)` 是 **ESM 合法形态**（services 包
`"type":"module"`）—— **不是生产缺陷，不改生产源码**。2026-11-14 的 5 连败
根因是 harness 的 CJS bundle 化把 `import.meta` shim 成空对象（esbuild 输出
形态 `(0, import_node_module.createRequire)(import_meta.url)`）；修补住
**bundle 后处理**（`build-live-harness.mjs` 的单点替换 + 残留 fail-loud），
与 `node:sqlite` 说明符改写（`main.cjs` resolve 钩子 → throws-on-use stub）
同属打包侧适配。

## 6. 工具链加固（2026-11-15，架构师评审跟进 —— 第 2/3 项）

架构师对 PR #34 的评审提出三项跟进，其中两项为工具链缺陷，本节登记收口
（第 1 项「重建工具链尚未重跑 live 验收」**仍然如实未收**：阻塞于账户邮箱
验证激活〔§1.3〕，激活后以本工具链执行终局运行 —— 届时 §2 的 SHA-256
复现基准对照 + §3 判定语义适用）：

1. **桥形态 detail 的执行依赖**（评审第 2 项）：原 harness 在直连
   `getOverviewData` 落入设计内 typed 拒绝时短路，步骤 10（桥两跳 detail）
   不再执行 —— 桥形态的拒绝边界因此从未被登记。收口：`main.cjs` 的步骤
   语义改为**异常短路、设计内拒绝不短路** —— 步骤 9 拒绝时步骤 10 照常
   执行，未激活账户的运行自此同时登记两种形态的 typed 拒绝；激活后的
   终局运行同样两种形态都测。RESULT 语义不变（0 当且仅当全部步骤 ok）。
2. **E2B 证据收集器的断言强度**（评审第 3 项）：原驱动器取回工件后不校验
   齐备性、不验证 RESULT 文件即报完成，且不校验 env 文件的实际权限。收口
   （`e2b-drive.mjs` 完整性判定层）：(a) 期望工件齐备断言 —— 每臂 REQUIRED
   工件（harness：RESULT-harness.txt + live-conversational-evidence.json；
   e2e：RESULT.txt）缺失即 FATAL，条件期望（connect ok ⇒ at-rest 快照）
   缺失即 FATAL，不再接受空取回面静默通过；(b) RESULT 文件必须可解析且与
   结构化 evidence 互证（`RESULT_HARNESS=n` ⟺ all-steps-ok；不一致 =
   FATAL —— 工件完整性违规）；(c) `--env-file` 通告 0600 的键文件必须实际
   0600（组/他任一权限位即 FATAL）；(d) 取回改经 `tar.gz + base64`
   （二进制安全、支持嵌套目录、截断/损坏在本地解包校验时 fail loud），
   泄漏自检升级为逐文件**字节级**且在工件离开临时目录**之前**执行。
   驱动器退出码：0 绿 / 2 用法 / 3 泄漏 / 4 完整性不足（不得按完成报告）/
   5 验收非零（证据已取回判定）。负向路径（工件缺失、互证不一致、泄漏、
   权限违规、工件包截断）已各以桩沙箱独立验证。

加固不改变 §1 已登记事实与 §2 哈希基准；重建工具链「尚未重跑」的边界
（§4 末段）保持不变。

## 7. 环境就绪审计（2026-11-17，TL Linux 沙箱 —— Linux 补充证据，非 Windows 验收）

> 审计与整改全文见 [environment-readiness-report.md](environment-readiness-report.md)；
> 交接执行手册见 [ENVIRONMENT-READINESS-HANDOFF.md](ENVIRONMENT-READINESS-HANDOFF.md)。
> 本节只登记**实际执行过**的命令与结局；不重复里程碑状态裁决（roadmap 仍为唯一
> 权威）。**明确非声明**：本节无任何 Windows 证明、无任何真实 Stripe 调用（TL
> 环境无键 —— §7.4）、无任何秘密面。

### 7.1 审计环境与基线

- 环境：TL Linux 沙箱（Debian 13 trixie 容器，内核 5.10.134，x86_64，headless：
  `DISPLAY`/`WAYLAND_DISPLAY` 空，2 vCPU / 4.1 GB RAM）。**非**原生 Windows/WSL2。
- 基线：`main` @ `8d595ed32cd48858ecfe3f0b32f6cc4996caa93d`（PR #44），工作树干净。
- 工具版本：node v24.22.3、git 2.47.3、pnpm 10.33.2（corepack 安装 —— 审计时
  缺席，属环境配置项非仓库缺陷）。

### 7.2 harness 平台缺陷的确认与收口（本 PR）

- **确认**：`scripts/payswap/live/main.cjs` 步骤 1 无条件调用
  `safeStorage.getSelectedStorageBackend()` —— Electron 的 Linux-only API（源码
  `#if BUILDFLAG(IS_LINUX)` 编译期裁剪）；win32 运行时上方法不存在 → `TypeError`
  → live harness 在原生 Windows 无法起步。生产键仓（`pspCredentialKeyStore.ts`）
  的同名查询本就按平台门住（`pspSafeStorageBackendPolicy` 法则 2）—— 缺陷纯
  harness 侧；伴生死缺省值（win32→"dpapi"，无 API 可比较）一并移除。
- **收口**：`scripts/payswap/live/safe-storage-backend-gate.cjs`（平台感知门；
  linux=后端名闭集 / win32=DPAPI 可用性 / darwin=Keychain 可用性 / 其余
  fail-closed；不发明 Windows 后端名 API）+ `main.cjs` 步骤 1 改用该门（Linux
  行为逐字节保持）+ `safe-storage-backend-gate.test.mjs`（12 行回归矩阵 ——
  win32/darwin 以 throwing spy 钉死「永不调用 Linux-only API」）+ CI 挂载
  （`payswap-roadmap.yml` 新步骤）。
- **新增工具链**（Windows 验收执行面）：`scripts/payswap/preflight-env.cjs`（预检
  + 五分类可执行裁决）、`scripts/payswap/electron-safe-storage-probe.cjs`（真
  Electron DPAPI/Keychain/Libsecret 探针）、`scripts/payswap/windows/run-p2-acceptance.cjs`
  （五分类验收 runner：PASS/FAIL/BOUNDARY/SKIP/MANUAL-PENDING 闭集；SKIP 永不让
  run 变绿；键值落盘前置换 + 工件字节级泄漏自检 + SHA-256 manifest）。

### 7.3 实际执行的命令与结局（全部 Linux 沙箱；TL 环境补充证据）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `git clone https://github.com/payswapdotorg/payswap-4.0.git`（匿名） | 0 | 365 MB 工作副本 |
| `git rev-parse HEAD` / `git status --short` | 0 | `8d595ed3…`；干净 |
| `corepack prepare pnpm@10.33.2 --activate` | 0 | `pnpm 10.33.2` |
| `pnpm install --frozen-lockfile` | 0 | 58.3 s；node-pty Linux 重建完成 |
| `pnpm lint` | 0 | 0 errors（97 条既有 warnings —— 门只看 errors） |
| `node scripts/architecture/architecture-check.mjs check` | 0 | violations 0 |
| `node scripts/payswap/validate-roadmap.mjs` | 0 | 单一权威 roadmap 通过 |
| `node --test scripts/payswap/validate-roadmap.test.mjs` | 0 | 全绿 |
| `node --test scripts/payswap/live/safe-storage-backend-gate.test.mjs`（新） | 0 | **12/12** |
| `pnpm exec vitest run --project engineering packages/desktop/test/payswap-psp-key-store.test.ts packages/desktop/test/payswap-psp-storage-backend-policy.test.ts packages/desktop/test/payswap-account-runtime-wiring.test.ts packages/desktop/test/payswap-account-connection-ipc.test.ts packages/desktop/test/payswap-psp-warmup.test.ts packages/desktop/test/payswap-reader-bridge-entry.test.ts` | 0 | **42/42** |
| `node scripts/payswap/preflight-env.cjs`（沙箱自跑） | 1 | **按设计 fail-closed**（pnpm 当时缺席/磁盘 7.6 GB 低于 8 GB 线/electron 当时未装 —— hint 逐项给出；Windows 分类 N/A、stripe-live GATED） |
| `node scripts/payswap/windows/run-p2-acceptance.cjs --dry-run`（沙箱） | 2 | **按设计不转绿**：五分类全 SKIP（Linux + 无键），汇总表明示 NOT GREEN |
| `node scripts/payswap/windows/run-p2-acceptance.cjs --stage bogus` | 3 | 用法错误路径正确 |
| `curl -sS -o /dev/null -w '%{http_code}' https://api.stripe.com/v1/balance` | 0 | `401`（无认证预期应答 —— 可达性） |
| `node --check`（新/改 .cjs × 4：gate、main、preflight、probe、runner） | 0 | 语法面通过 |

消毒工件（仓内登记，SHA-256 基准）：

- `evidence/environment-readiness/preflight-linux-2026-11-17.json` ——
  SHA-256 `bfa1a0e8e1bb3385da1ecae5693577df3752d0dd543890a622809c15dc7ba179`
- `evidence/environment-readiness/runner-dryrun-summary-linux-2026-11-17.json` ——
  SHA-256 `814cd7ae7d774e30ad35f2f9e026f3519e3de7fc1a243fb8728b09bec92a980a`
- （两件的生成时刻为整改工作树（本 PR 内容）；工件内 `commit` 字段为当时 HEAD
  `8d595ed3`，如实录。）

### 7.4 如实边界（本节证据**不**构成的事项）

- 原生 Windows 验收（DPAPI/桌面/E2E/对话面）：**未执行** —— TL 沙箱结构性
  BLOCKED；待本地 Windows agent 按 handoff 执行 `windows-build` →
  `windows-secure-storage` → `windows-desktop-e2e` → `stripe-live` →
  `conversation-acceptance`，证据回传后在本登记面开 §8（Windows）小节。
- 真实 Stripe 调用：**未执行**（TL 环境无 `ZCODE_E2E_STRIPE_LIVE_KEY`；聊天转录
  非合格秘密通道 —— 键须在验收机本地经 0600 env 文件供给）。
- §1.3 的账户激活边界**保持不变**：四类别数据落地仍待 Stripe 邮箱验证激活；
  激活后 `stripe-live` 分类复跑即本登记面的终局运行。
- P2 里程碑状态：**不变**（roadmap P2 行保持 `in_progress` —— 环境就绪 ≠ P2
  完成）。


## 8. P2-Linux 腿 —— TL Linux 沙箱五分类验收运行（2026-11-17，Linux 补充证据）

> 本节登记 **P2-Linux 里程碑分解后**的 Linux 腿验收执行：环境、命令、结局与
> 如实边界。状态裁决仍在 roadmap 的 P2-Linux 行（唯一权威）。

### 8.1 运行环境与基线

- 环境：TL Linux 沙箱（Debian 13 trixie 容器，内核 5.10.134，x86_64，headless；
  2 vCPU / 4GiB cgroup / 0 swap）。**真 Linux 桌面腿** = Xvfb :99（runner 命令
  生命周期内自持）+ dbus-run-session + gnome-keyring 48 Secret Service（
  `org.freedesktop.secrets` 会话总线在场自证，缺席即 FATAL）+ Electron
  `--password-store=gnome-libsecret`；栈来自 debs 前缀解包
  （`PAYSWAP_LINUX_LEG_STACK`，leg-stack.cjs 统一解析）。
- 工具：Node 24.22.3、pnpm 10.33.2、git 2.47.3、Electron 44.7.0（repo 钉版）、
  chromedriver 152.0.7977.82（Electron↔Chromium 152.0.7977.130 的兼容回退版，
  `chromedriver-preflight.mjs` 解析 + `CHROMEDRIVER_PATH` 注入）。
- 基线：分支 `p2/acceptance-runner-fail-closed` @ `a6b94740d1961f3890be38dba011af86fc879428`（含 E2B 侧
  修复合并 `57669794`、构建开关 `1bd675dd`、Linux 执行面与里程碑拆分提交）。
- 命令：`PAYSWAP_LINUX_LEG_STACK=<prefix> node scripts/payswap/linux/run-p2-acceptance.cjs`
  （单次完整 run、零假设 —— 唯一能把退出码打到 0 的形态）。

### 8.2 结局（词汇闭集：PASS/FAIL/BOUNDARY/SKIP/MANUAL-PENDING）

| 阶段 | 结局 | 证据要点 |
|---|---|---|
| linux-build | **PASS** | frozen install（exit 0）+ e2e-report build:node + `@zcode/desktop...` 全链构建 + E2E store-bridge renderer（编译标记断言过）。内存受限形态（`ZCODE_DESKTOP_BUILD_SOURCEMAPS=off`；完整生产 sourcemap 面在该 4GiB cgroup 实测 OOM —— SIGKILL at anon-rss 3347MB，sourcemap 合并为 native 内存，堆上限无效；开关登记于 vite.config.ts 与提交 `1bd675dd`） |
| linux-secure-storage | **PASS** | 显示腿内真 Electron 探针：`backendSelected=gnome_libsecret`、`isEncryptionAvailable=true`、`roundTrip=ok`；P2 法则电池 13 套件 **129/129**（CI 同款调用面）；harness 平台门回归 **12/12**（Linux 后端名闭集钉死） |
| linux-desktop-e2e | **PASS** | `payswap-connection-ui` spec **7/7、首过率 100%**（真窗口/真 ipcMain/真 store 文件；四个存储臂在真 gnome_libsecret 后端上执行：connected + at-rest 密文、refresh 闭集、revoke 删除、损坏键真实重启 → typed 存储 refusal） |
| stripe-live | **SKIP** | `ZCODE_E2E_STRIPE_LIVE_KEY` 缺席（本环境无键；聊天转录非合格秘密通道 —— 键须在验收机本地经 0600 env 文件供给）。preflight 裁决 GATED，runner 诚实 SKIP |
| conversation-acceptance | **SKIP** | 依赖 stripe-live（对话面需已连接的真账户） |

**run 退出码 = 2**（SKIP 永不转绿；`--allow-skip` 只记录承认）。**不是 P2-Linux
终局证据** —— 终局 = 五分类全 PASS（stripe-live 携 `RESULT_E2E=0`、
`RESULT_HARNESS=0`）+ 13 步回执严格校验。剩余两阶段被两个操作者控制步门控
（键供给 + 账户 onboarding 身份段 —— 精确动作与复跑命令见
[LINUX-P2-CLOSURE-HANDOFF.md](LINUX-P2-CLOSURE-HANDOFF.md)）。

### 8.3 消毒工件（SHA-256 基准；secretPresent=false —— 本 run 无键材料）

工件目录 `artifacts/p2-acceptance-linux/2026-11-17T18-00-57-381Z/`：

- `summary.json` —— SHA-256 `4914af6eeaae859276cd1c61f010a1c511b4e2a597eaeff0bddd7ed189831408`
- `MANIFEST-sha256.txt` —— SHA-256 `5aa32b8bc1aa098aca9fb31122ac1cd99edc37351df51c62c712fdcba652cdac`（8 文件清单；
  复核一致）
- `preflight.json` —— SHA-256 `92d8cf836b7850d190411b73c27d8c8372b05df701886ae4822b14d2150684eb`
- `linux-build/linux-build.log` —— SHA-256 `1f9f2ec5bf9f92a5c71b45c53d19d72e424d52a051b3888f426fcf27f8631f1d`
- `linux-secure-storage/linux-secure-storage.log` —— SHA-256 `76c9aa7f92b40ec8e78f2901dfa3ee18fd8f9b2b093542d040bd9e60eaba3e05`
- `linux-secure-storage/probe.log` —— SHA-256 `6f3ab1c5d8dfdd64df577ae7f0fc74c32d851ded35040eb19a040bbf7ecf7a24`
- `linux-desktop-e2e/linux-desktop-e2e.log` —— SHA-256 `81ce3040946531c61bb603ffc61a21710ededd1f36e0c1d1117d7432715d43d5`
- `linux-desktop-e2e/wdio-connection-ui.log` —— SHA-256 `b18dc0e9b3170f527bbf1eec803752fa2ca49027f9532134da10d8649078d878`
- `linux-desktop-e2e/chromedriver-preflight.log` —— SHA-256 `cd4285b1ad154306aadbc993cd510789f47529fad5dbcf7a7eeb0e69d21eaa98`

### 8.4 如实边界（本节证据不构成的事项）

- 真实 Stripe 调用：**未执行**（无键）。§1 的 2026-11-14 E2B 双复现
  （live spec 3/3 + harness 步骤 1–8）仍是本腿的既有 live 证据；激活/键边界
  见 §1.3 与 LINUX-P2-CLOSURE-HANDOFF.md §1。
- 交互式 New Task 13 步回执：**未执行**（依赖真键真账户）。
- P2-Linux 里程碑状态：**不变**（roadmap P2-Linux 行 `in_progress`；本节是
  可独立执行半边的执行证据，非关闭登记）。
- Windows 腿：本节无任何 Windows 证明（见 P2-Windows 行与
  ENVIRONMENT-READINESS-HANDOFF.md）。

### 8.5 沙箱回收后零假设复跑（可复现性补强，2026-11-17T18:25:49Z）

> 同一 TL Linux 沙箱在会话间隔后经历了**进程全面回收**（文件系统保留、
> Xvfb/D-Bus/keyring 等一切运行时进程不在）—— 复跑证明验收腿可从该冷态
> **原地重建**，且基线推进到将合入的 HEAD。

- **基线**：分支 `p2/acceptance-runner-fail-closed` @
  `80c42ba1a7c263479f283aad99b968344d6347d8`（= §8 登记运行之后的两提交：
  §8 证据登记 `2c086515` + runner lint `80c42ba1`；即待合入面本身）。
- **命令**：与 §8.1 相同（`PAYSWAP_LINUX_LEG_STACK=<prefix> node
  scripts/payswap/linux/run-p2-acceptance.cjs`），单次完整、零假设
  （`assumedStagesPassed: []`）、`dryRun: false`、`secretPresent: false`。
- **结局**：与 §8.2 逐字一致 —— linux-build **PASS** / linux-secure-storage
  **PASS**（探针 `gnome_libsecret` + `isEncryptionAvailable=true` +
  `roundTrip=ok`；法则电池 **129/129**；平台门 12/12）/ linux-desktop-e2e
  **PASS**（`payswap-connection-ui` **7/7**，七臂逐条 ✓）/ stripe-live
  **SKIP** / conversation-acceptance **SKIP**。耗时 18:25:49Z→18:31:28Z
  （≈5.6 分钟，与 §8 运行同量级）。
- **消毒工件**：`artifacts/p2-acceptance-linux/2026-11-17T18-25-49-176Z/`，
  MANIFEST 8 文件复核一致 —— `MANIFEST-sha256.txt` SHA-256
  `4a8671de5be1d1ef9136af270d76312df5f1d4dd31bea6cc8c66f90877a5ce2c`；
  `summary.json` SHA-256
  `2d53db0392af994e5990260f7add4109f94f4d04669fd5d5c5aa286574259c18`；
  `preflight.json` SHA-256
  `8179e4a0077330916305cebc422a3bfc696a70087a5dfc720200e2d0fb8b43b4`
  （阶段日志八文件清单见该 run 自身的 MANIFEST，逐项 OK）。
- **运维观察（2026-11-17 深夜更正：runner 无缺陷，根因在外层）**：本节初版
  曾把「manifest 落盘后 runner 退出相位被残留子句柄拖住」登记为疑似 runner
  缺陷。后续四次受控复跑（storage/e2e 两阶段 × 文件重定向/直连管道两形态）
  + 一次带仪表的完整零假设直连管道复跑（时间线 + 进程快照落盘取证）证明：
  **runner 在全部形态下干净退出**（完整 run 335 秒 rc=2，退出时刻进程快照
  零残留，shell 全部后续命令执行完毕）——挂起发生在 TL 沙箱**工具外层**
  （大体积输出直连管道时外层的 EOF 判定），与 runner 无关。已登记的正确
  用法本就是文件重定向形态（§4 备忘与交接文档的命令面）；无需 runner 改动。
- **二次回收复跑（wipe→bundle 恢复→零假设 run，2026-11-17T19:15:25Z）**：
  沙箱再次回收且本次**清空了 repo 工作树**（文件系统保留其余目录）；从交付
  bundle 恢复分支 @ `5bdd6900` 后完整零假设 run 再次全绿 —— build/storage/e2e
  **PASS** + 两操作者门控阶段诚实 **SKIP**，manifest 8/8 OK（`summary.json`
  SHA-256 `fcc631bb18cdd2633b22c6eb5a82a41a6e9eb1e9737000088f4d2e6b0652f106`；
  工件 `artifacts/p2-acceptance-linux/2026-11-17T19-15-25-296Z/`）。交付
  bundle 的可恢复性由此实证。
- **边界不变**：本节仍是可独立执行半边的证据 —— 键供给与账户 onboarding
  身份段两操作者控制步（LINUX-P2-CLOSURE-HANDOFF.md §1）未变，P2-Linux
  状态裁决仍以 roadmap 的 P2-Linux 行为准。

## 9. P2-Windows 腿 —— 真实 New Task 四分类会话证据（2026-11-18，native Windows）

> 本节是 P2-Windows 的**会话半边**新证据：不是 runner 阶段产物，而是真实桌面应用
> 内的 New Task 对话（模型 = GLM-5.3，Z.ai Start Plan）。运行环境为**隔离数据根**
> （`ZCODE_DATA_BASE_DIR=C:\Users\Lenovo\payswap-dev-data` —— 与已安装产品的
> `~/.zcode` 完全分离；该分离本身源于 2026-11-18 的共享凭据文件踩踏事故，见
> TL-PROGRESS.md）。测试分支状态：`p2/acceptance-runner-fail-closed` @ `15d1eca6`。

**先决修复（同分支三提交，TL 已复核）**：`feb6837f`（broker helper 供给快照转发
→ boot `peer_verified`）、`e017b5a8`（gateway `alwaysLoad` + 单账户确定性消歧）、
`15d1eca6`（reader 桥端口铸造器移入 `SpawnHostProcessOptions` 第 5 参 → host 中继
首次 live）。

| 证据臂 | 结果 | 审计/工件 |
|---|---|---|
| broker boot（无操作者 env 注入） | `peer_verified`，`helperSupplyPresent {true,true}` | `evidence/newtask-2026-11-18/broker-audit.jsonl` |
| relay 挂接 | `[payswap-reader-bridge-relay] main port attached (reader bridge relay live)`（首次出现） | `evidence/newtask-2026-11-18/reader-bridge-relay-lines.txt` |
| 四分类会话读 | 模型调用 `payswap_get_account_overview`（无 connectionId）→ `dispatched op:get_account_overview peerPid:5488` → **四类别同答全 ok**（余额 USD 69,854.06 + EUR 147.48；10 笔支付对象 8✅/2❌；10 条脱敏客户投影——零 PII；争议空） | 会话转录摘录 + 审计行，已消毒入库 |
| 撤销（步骤 12） | Settings → Payment connections → Revoke → "Connection revoked. The locally stored secret was deleted."（store 行 `status=revoked`，updatedAt 2026-11-18T18:54:09.236Z） | 同上转录文件 |
| 撤销后读（步骤 13） | typed refusal：四类别逐条 unavailable — connection revoked；模型如实转述并将再授权指向 UI —— **零即兴、零凭据触达** | 同上转录文件 |

**消毒证据（已入仓，SHA-256 复核清单）**：
`docs/payswap/p2/evidence/newtask-2026-11-18/MANIFEST-sha256.txt` —
`broker-audit.jsonl`
`a9601e3242390433098b968fe3614b0e3802c9d515a62d4e4e466ca94c49a05f`；
`reader-bridge-relay-lines.txt`
`fc60368147a9b509e398f971fd5ad9c5d1d84ca5a46d19260a4baff43e13f2ed`；
`newtask-conversation-redacted.md`
`31af44246ad38ef462ce3d1244b18623cc67da61d03571244d9a8a7402a56841`。

**单账户消歧契约（TL review §C 修正后）**：省略 connectionId 时仅 `status
"connected"` 行参与消歧（恰一行 → detail 同答；零/多行 → 无 detail）；
revoked/expired 行永远保留在清单投影里。混合状态 battery 见
`payswap-broker-dispatch.test.ts`（27 通过）。

**边界声明**：本节证明的是**真实会话半边**（New Task → 插件工具 → broker →
reader 桥 → 账户服务 → provider 只读）。P2-Windows 的形式裁决仍差：13 步手工
回执 + 五阶段 runner `--manual-evidence`（§4 形态）+ 本节的独立复核。roadmap
P2-Windows 行维持 `in_progress` 直至 §10 的安全项与上述门全部通过。

## 10. 凭据安全状态（2026-11-18，如实声明 —— 未关闭）

**历史暴露的遏制（部分完成，操作者步未完成）**：
- 恢复面为 `acct_1FPs7UAkPdhgtN6I`（Cattyz）的 `rk_test_*` 只读受限键（API 复核：
  capabilities 13 项）。该键仍以 0600 ACL 存于
  `C:\Users\Lenovo\.payswap-live.env`（owner-only，继承已断）。
- **轮换尚未执行**：受限键无法经 API 自铸（无管理能力）——轮换必须在 Cattyz
  dashboard（ekontetevi@gmail.com 登录）删除旧键并铸造新键；属操作者控制步。
  轮换后须更新 `~/.payswap-live.env` 并重跑会话臂以绑定新键。
- 已检面：当日 CLI 审计日志与工作区转录的密钥形模式清扫为 0 命中（2026-11-18）。

**复发防护（架构性）——如实声明：尚未解决**。本分支三提交均未改变
"同用户任意进程可解密 DPAPI 包裹的 PSP 凭据" 的 Windows 事实模型
（Electron safeStorage/DPAPI 明示不防同用户进程）。2026-11-18 会话未发生凭据
恢复**不构成**能力消失的证明。既定缓解（TL 复述）= PSP 凭据读取移入独立保护
身份（专用服务账户/service SID 或 AppContainer 模型侧限制）+ 窄 RPC 面 ——
登记为独立里程碑（安全加固），不并入 P2-Windows 形式裁决的既有门；P2 关闭时
本节按上表如实转述，不宣称已防护。

**回归保护增量（TL review §3 B 已落地）**：`e41f1a85` —— reader 桥第 5 参契约
battery、混合状态消歧 battery、alwaysLoad 双层断言。

### §9.1 形式验收运行补全（同日稍晚 —— TL closure mission Priority 3）

**零假设五阶段运行 + 13 步手工回执（全 PASS，exit 0）**：测试 SHA
`9dabf63ab39034dc523f5826efafd3cde3185a5a`（win32 10.0.26200，node 24.14.0）。

| 阶段 | 裁决 |
|---|---|
| windows-build | PASS（install + build:bootstrap，exit 0） |
| windows-secure-storage | PASS（DPAPI probe + 法则电池） |
| windows-desktop-e2e | PASS |
| stripe-live | PASS |
| conversation-acceptance | **PASS（13 步手工回执经严格校验）** |

工件：`artifacts/p2-acceptance/2026-11-18T20-12-16-275Z/`（summary.json +
MANIFEST-sha256.txt 10/10 复核一致）。人工回执副本（消毒）+
最终 summary/manifest 已入仓：`docs/payswap/p2/evidence/newtask-2026-11-18/`
（`manual-new-task-evidence.md`、`final-run-summary.json`、
`final-run-MANIFEST-sha256.txt`、更新后的 `MANIFEST-sha256.txt`）。

13 步回执要点（全 PASS，attestation：operator = Lenovo/payswapdotorg continuation
agent；winver `Microsoft Windows [Version 10.0.26200.9974]`；SHA = 测试提交）：
连接（真实 UI + 真键）→ at-rest 检查（`enc` 前缀包裹 blob，137 B 密文，
v2 全树零键明文形）→ 刷新免重输 → 全退出重启后连接持久 + 再刷新 → New Task
四分类会话（审计 `dispatched op:get_account_overview peerPid:1940`）→ 转录/日志
零密钥材料零 PII → Revoke（"locally stored secret was deleted"）→ 撤销后读 =
typed refusal（四类别逐条 unavailable，模型如实转述，零即兴）。

### §10 补全：凭据安全验证探针（TL closure mission Priority 1 —— 如实声明）

**探针问题**：同用户、非 Electron 的普通进程能否恢复一份新鲜的 PSP 凭据？
**结果：能（RECOVERED）** —— 完整链已实证（全部格式来自仓内公开代码，键明文
零打印零落盘）：
1. `%APPDATA%/ZCode Dev/session/Local State` 的 `os_crypt.encrypted_key`
   （"DPAPI" 前缀 283 B）→ 普通 .NET DPAPI unprotect → **32 字节主键恢复**；
2. `v2/payswap-psp-safe-storage-key`（"v10" Chromium os_crypt blob）→ 主键
   AES-256-GCM 解包 → **64-hex 文件键恢复**；
3. 新鲜连接的 `enc:v1:` 槽位 → sha256(file-key) → AES-256-GCM → **受限键明文
   恢复（107 字符，形状确认后立即丢弃）**。

探针全程只读键材料；演示后新鲜槽位即刻撤销（密文删除）。完整记录：
`docs/payswap/p2/evidence/newtask-2026-11-18/security-probe-result.txt`。

**结论（与 TL 复核 §3-A 一致，且加强）**：P2-Windows 的凭据边界在当前架构下
**不**阻断同用户模型侧进程 —— Electron 44 的 os_crypt/DPAPI 方案不改变同用户
边界。遏制（轮换）仍是操作者 dashboard 步；架构加固（计划 §4：独立保护身份 +
窄 RPC 面）按独立里程碑推进。P2-Windows 关闭时按本节如实转述。
