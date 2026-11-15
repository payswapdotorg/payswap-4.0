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
