# PaySwap P2 live 验收 harness —— 仓控可复现包

> **这是什么**：P2「real Stripe conversational」验收的 live 证明工具链（PR #33
> 登记的 `payswap-connection-live.test.ts` + `live-harness-main.cjs` 及其 E2B
> 驱动脚本的**仓库内重建**）。原工件于 2026-11-14 在 E2B 沙箱与本机
> `/home/z/stripe-signup/` 产生，未入仓控即随沙箱 TTL 与宿主回收丢失 —— 本包
> 把它们置于版本控制下，使 live 证据**可从 fresh checkout 复现**。
> 登记证据与重建溯源见
> [docs/payswap/p2/live-acceptance-evidence.md](../../../docs/payswap/p2/live-acceptance-evidence.md)。

## 组成

| 文件 | 角色 |
|---|---|
| `packages/desktop/test/e2e/payswap-connection-live.test.ts` | **E2E live spec**：真实受限只读键经真实连接 UI（connect → verified read-back → revoke + at-rest 无键明文）。env-gated on `ZCODE_E2E_STRIPE_LIVE_KEY`；stronger-than-CI（闭集收敛到必需结局）。**不在 CI 电池清单**（需真实网络，与 `--network none` 回放隔离不相容）。 |
| `scripts/payswap/live/main.cjs` | **对话面 harness 入口**（真实 Electron main 进程）：真 OS 钥匙串键仓 → 受监督运行时（单写者账户服务）→ MessageChannelMain 桥铸造 → 法则客户端 → `get_account_overview` 直连与对话面两跳两种形态。步骤 1 的「真实 OS 钥匙串」门**平台感知**（`safe-storage-backend-gate.cjs`：linux=后端名闭集〔gnome_libsecret 缺省，`ZCODE_PAYSWAP_LIVE_EXPECT_BACKEND` 可覆盖〕；win32=DPAPI 可用性；darwin=Keychain 可用性 —— **Linux-only API 不得在非 linux 平台触碰**，与生产 `pspSafeStorageBackendPolicy` 法则 2 同款）。**设计内 typed 拒绝不短路**：直连形态拒绝时桥形态 detail 步照样执行（两种形态的拒绝边界都登记 —— 2026-11-15 架构师评审跟进）；只有意外异常才 abort-on-first-failure。 |
| `scripts/payswap/live/build-live-harness.mjs` | harness 构建器：真实 law 模块（desktop payswap 装配 + services 运行时 + shared 法则）从源码 tsup 编译为单文件 CJS bundle + `createRequire` import_meta shim 修补（**打包侧修补，不改生产源码** —— 架构师 2026-11-15 裁决）。 |
| `scripts/payswap/live/sqlite-stub.cjs` | bundle 化 `node:sqlite`→`sqlite` 说明符改写的 throws-on-use stub（P2 账户流不触 session DB）。 |
| `scripts/payswap/live/vm-mega-setup.sh` | VM 一次性 setup：Electron 运行库 + dbus/gnome-keyring + Xvfb/xauth + frozen install + desktop 构建 + chromedriver preflight。 |
| `scripts/payswap/live/vm-run-live.sh` | E2E live spec 运行器（真 Secret Service 腿 recipe + 在场自证 + 产物导出）。 |
| `scripts/payswap/live/vm-harness-only.sh` | 对话面 harness 运行器（同腿 recipe；产物 = 证据 JSON + RESULT）。 |
| `scripts/payswap/live/e2b-drive.mjs` | 操作机侧 E2B 驱动器（一臂一沙箱；键经 env 注入；产物取回前**字节级**泄漏自检）。**完整性判定层**（2026-11-15 架构师评审跟进）：期望工件齐备断言（REQUIRED + 条件期望，缺失即 FATAL）+ RESULT 文件可解析且与结构化工件互证 + `--env-file` 0600 权限断言 + 取回经 tar.gz/base64（二进制安全，截断即 fail loud）。 |
| `scripts/payswap/live/safe-storage-backend-gate.cjs` + `.test.mjs` | 步骤 1 的平台感知门（纯函数，IO 全注入）与其 12 行回归矩阵 —— win32/darwin 以 throwing spy 钉死「永不调用 Linux-only `getSelectedStorageBackend`」（环境就绪审计 2026-11-17 修复；CI 挂载于 `payswap-roadmap.yml`）。 |
| `scripts/payswap/preflight-env.cjs` + `scripts/payswap/electron-safe-storage-probe.cjs` | **环境预检**（OS/工具链/桌面会话/Electron/safeStorage 真运行时探针/Stripe 可达性/键在场〔值永不回显〕/五分类可执行裁决；fail 级检查 → exit 1）与**真 Electron DPAPI/Keychain/Libsecret 探针**。 |
| `scripts/payswap/windows/run-p2-acceptance.cjs` | **原生 Windows 五分类验收 runner**（windows-build / windows-secure-storage / windows-desktop-e2e / stripe-live / conversation-acceptance；PASS/FAIL/BOUNDARY/SKIP/MANUAL-PENDING 闭集；SKIP 永不让 run 变绿；消毒工件 + 泄漏自检 + SHA-256 manifest）。 |

## 复现步骤（任意 Ubuntu + Node 24 + 网络的 VM；E2B 为既定操作环境）

```bash
# 0) 操作机（需临时 npm i e2b@^1；E2B_API_KEY 就位；键在 0600 env 文件）
node scripts/payswap/live/e2b-drive.mjs --arm both --env-file ~/.payswap-live.env

# —— 或手动（VM 内）——
git clone --depth 1 https://github.com/payswapdotorg/payswap-4.0.git /workspace/payswap
cd /workspace/payswap
bash scripts/payswap/live/vm-mega-setup.sh

# E2E live spec（真实键经真实连接 UI）
ZCODE_E2E_STRIPE_LIVE_KEY=rk_test_... bash scripts/payswap/live/vm-run-live.sh

# 对话面 harness（生产装配 × 真桥 × 真键）
ZCODE_E2E_STRIPE_LIVE_KEY=rk_test_... bash scripts/payswap/live/vm-harness-only.sh
```

### 原生 Windows 路径（2026-11-17 起）

Windows 上无 dbus/gnome-libsecret 腿 —— safeStorage 走 DPAPI（`isEncryptionAvailable`
门，无后端名 API）。harness 直接以 electron 驱动（无需 vm-*.sh 的 Secret Service
recipe）：

```powershell
# 预检（含真 Electron DPAPI 探针 + 五分类可执行裁决）
node scripts\payswap\preflight-env.cjs
# 五分类验收（构建 / 安全存储 / 桌面 E2E / stripe-live / 对话级）—— 见 handoff
node scripts\payswap\windows\run-p2-acceptance.cjs
# 或仅对话面 harness（stripe-live 阶段的内嵌步骤，亦可单独直跑）：
node scripts\payswap\live\build-live-harness.mjs
node packages\desktop\node_modules\electron\cli.js scripts\payswap\live\main.cjs
#   （env：ZCODE_E2E_STRIPE_LIVE_KEY 必需；ZCODE_PAYSWAP_LIVE_EXPECT_BACKEND 仅
#    linux 消费 —— win32 上步骤 1 由 DPAPI 可用性门住，不查后端名）
```

## 验收判定

- **E2E live spec**：`RESULT_E2E=0` = 3/3（connect connected + at-rest 无键明文 /
  refresh **verified**〔真 api.stripe.com 读回〕/ revoke 终态 + 秘密删除）。
- **对话面 harness**：`RESULT_HARNESS=0` = 全步骤 ok —— **四类别对话数据落地**
  （`get_account_overview` 携 balance/payment_objects/customers/disputes 数据，
  直连与桥两跳两种形态）。`RESULT_HARNESS=1` = 链路证到**拒绝边界**：未激活
  Stripe 账户（capabilities 空）的 typed `read_back_unavailable` 拒绝 —— lawful
  fail-closed，但不是 P2 终局证据（需账户邮箱验证激活后重跑）。未激活账户的
  运行会**同时登记直连与桥两种形态的拒绝**（步骤 10 不以步骤 9 成功为前提）。

## E2B 驱动器退出码（完整性判定层 —— 2026-11-15 加固）

| 退出码 | 含义 |
|---|---|
| `0` | 所有臂 `RESULT=0` —— 验收绿，工件已验证并落 `p2-live-<arm>-evidence/` |
| `2` | 用法/环境缺失（键缺席、`e2b` 包缺席、env 文件权限不是 0600 等） |
| `3` | 键泄漏事故 —— 某证据文件含键明文；临时目录已删除，处置后重跑 |
| `4` | 完整性不足：工件不全（REQUIRED/条件期望缺失）、工件包损坏（传输截断）、`RESULT_*` 行不可解析、或 RESULT 码与结构化 evidence 不一致 —— 证据不可信，**不得**按完成报告 |
| `5` | 验收判定非零：工件完整且已验证，但 `RESULT≠0`（如未激活账户的拒绝边界 = 1）—— 证据已取回，按边界语义解读 |

驱动器判定次序：泄漏自检（临时目录内、落盘前）→ 期望工件齐备 → RESULT 解析与
结构化互证 → 移入最终目录 → 逐臂 VERDICT。操作机另需 `tar`（工件经
`tar.gz + base64` 取回 —— 二进制安全；截断/损坏在本地解包校验时 fail loud）。

## 环境要求（关键事实，2026-11-14 实战记录）

- **真 OS 钥匙串后端**：Linux 上必须 gnome_libsecret（`--password-store=gnome-libsecret`
  + org.freedesktop.secrets 在会话总线；运行器自带在场自证 —— basic_text/unknown
  后端上 live 实证不得成立）。dev 沙箱容器无法满足（module-load 宽树缺陷 +
  无 Secret Service）—— **live 验收一律在 VM/E2B 跑**。
- **真实受限只读键**：`rk_test_*`，权限恰为 Read on Account/Accounts/Balance/
  Charges/Customers/Disputes（P2 读面）。键只经 env 注入；harness/spec/驱动器
  永不打印它；证据文件取回前跑泄漏自检。
- **VM 硬 TTL**（E2B 1h）：一臂一沙箱；跑完立即取回产物。
- **打包侧 ESM 语义**：生产 `terminalService.ts` 的 `createRequire(import.meta.url)`
  是合法 ESM（services 包 `"type":"module"`）—— CJS bundle 化的 `import.meta`
  空 shim 由构建器后处理修补（bundle 内单点 sed + fail-loud 验证）；**永不**为
  harness 打包便利修改生产源码（架构师 2026-11-15 裁决）。
