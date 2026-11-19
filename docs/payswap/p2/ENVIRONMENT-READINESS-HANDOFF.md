# P2 环境就绪交接 —— 本地 Windows agent 执行手册

> **对象**：下一个 worker / 本地 Windows agent。**上游**：
> [environment-readiness-report.md](environment-readiness-report.md)（2026-11-17 审计
> 与整改）。**使命**：在原生 Windows 桌面机上执行 P2 验收五分类并取回消毒证据。
> **纪律**：本手册不改变任何验收要求；跑不了的测试如实记 SKIP，永不静默转绿。

---

## 0. 前置事实（为什么是你）

TL 审计结论：TL Linux 沙箱对原生 Windows 验收**结构性 BLOCKED**（无 Windows 内核/
桌面/DPAPI）。harness 平台缺陷已修复（`main.cjs` 步骤 1 不再在 win32 上调用
Linux-only API），工具链已就绪 —— 剩下的执行面就是一台真实 Windows 桌面机。

## 1. 机器要求（preflight 会逐项自证，先自查）

| 项 | 要求 |
|---|---|
| OS | 原生 Windows 10/11，**交互桌面会话**（本机控制台或 RDP —— 服务/session-0 上下文不合格） |
| Node | 24.x（repo 引擎 `>=24.0.0`；`node --version` 自查） |
| pnpm | 10.33.2（`corepack enable && corepack prepare pnpm@10.33.2 --activate`） |
| git | 任意现代版（husky prepare 需要） |
| 磁盘 | ≥ 8 GB 可用（建议 20 GB：workspace + electron + 构建产物 + 工件） |
| 网络 | 可达 api.stripe.com（stripe-live 分类需要） |
| 键 | `ZCODE_E2E_STRIPE_LIVE_KEY` = 受限只读测试键 `rk_test_*`（Read on Account/Accounts/Balance/Charges/Customers/Disputes） |

**秘密纪律（硬法则）**：

- 键只经 **0600 权限的 env 文件**供给，例如（PowerShell）：

  ```powershell
  # 一次性创建（记着删掉历史里的明文命令；或用编辑器写入）
  New-Item -Path $HOME\.payswap-live.env -ItemType File | Out-Null
  icacls $HOME\.payswap-live.env /inheritance:r /grant:r "$env:USERNAME:R"   # 仅本人可读
  notepad $HOME\.payswap-live.env   # 写入一行： ZCODE_E2E_STRIPE_LIVE_KEY=rk_test_...
  ```

- **永不**把键放进：聊天/工单转录、命令行参数（会进 shell 历史）、PR/日志截图、
  plugin `userConfig`、任何仓库文件。
- 加载方式（每会话）：`Get-Content $HOME\.payswap-live.env | ForEach-Object { $k,$v = $_.split('=',2); Set-Item -Path "Env:$k" -Value $v }`

## 2. 一步步执行

```powershell
# 0) 取代码（或在你已有的 checkout 上切到本 PR 分支）
git clone https://github.com/payswapdotorg/payswap-4.0.git C:\work\payswap
cd C:\work\payswap
git checkout p2/environment-readiness-audit     # 或本 PR 合入后的 main

# 1) 预检（零依赖；逐项自证 + 修复 hint + 五分类可执行裁决）
node scripts\payswap\preflight-env.cjs
#    全绿后再继续；红项按 hint 修（装 pnpm / 装 electron 后重跑等）。

# 2) 五分类验收 runner（按序全跑；工件落 artifacts\p2-acceptance\<时间戳>\）
#    **首选终局验收命令：完整五阶段单次 run、零假设** —— 这是唯一能把退出码
#    打到 0 的形态。分阶段重跑是调试手段，不是验收形态。
node scripts\payswap\windows\run-p2-acceptance.cjs

#    —— 分阶段重跑（调试用；阶段依赖在同一 run 内强制）——
#    依赖表：secure-storage←build；desktop-e2e←build；
#            stripe-live←build+secure-storage；conversation-acceptance←stripe-live。
#    单独重跑时，先行阶段要么同次 --stage 且 PASS，要么 --assume-stage-passed
#    显式承认 —— 而 assumption 使 run 退出码 2（永不绿）。假设永远不能把 run
#    洗成绿色；先行阶段没真正跑过就不存在 PASS。
node scripts\payswap\windows\run-p2-acceptance.cjs --stage windows-build --stage windows-secure-storage

# 3) stripe-live 前先加载键（§1 的 env 文件），然后（含其全部先行阶段的完整 run）：
node scripts\payswap\windows\run-p2-acceptance.cjs --stage windows-build --stage windows-secure-storage --stage stripe-live

# 4) conversation-acceptance：runner 会先吐出交互清单 —— 真人真应用走完 13 步，
#    填成 manual-new-task-evidence.md 后回执校验（回执校验是严格的：13/13 步
#    各自非空 Observed + Result: PASS + 完整 attestation；FAIL/BLOCKED/SKIP/
#    缺步/重步/未知值一律不过）：
node scripts\payswap\windows\run-p2-acceptance.cjs --stage stripe-live `
  --assume-stage-passed stripe-live `
  --manual-evidence C:\work\payswap\artifacts\p2-acceptance\<时间戳>\conversation-acceptance\manual-new-task-evidence.md
```

## 3. 阶段语义速查（runner 输出词汇闭集）

| 阶段 | 证明什么 | 何时算过 |
|---|---|---|
| `windows-build` | 原生 Windows 构建链（frozen install + CI 证明的 `build:bootstrap` 序列） | 两步 exit 0 |
| `windows-secure-storage` | **真 Electron DPAPI**：`isEncryptionAvailable` + 加解密往返（探针）；生产 P2 法则电池（vitest `--project engineering`，CI 同款 13 套件）；harness 平台门回归（win32 永不碰 Linux-only API） | 三步全绿 |
| `windows-desktop-e2e` | 真窗口连接旅程（`payswap-connection-ui` spec：fail-closed 拒绝、connected + at-rest 密文、refresh 闭集、revoke、corrupted-key restart） | wdio exit 0 |
| `stripe-live` | 真键真网：E2E live spec（connect→**verified**→revoke，stronger-than-CI）+ 对话面 harness（`RESULT_HARNESS=0` = 四类别数据经直连+桥两跳） | spec 绿 **且** RESULT_HARNESS=0 |
| `conversation-acceptance` | 交互式 New Task 全流程（13 步清单：连接→at-rest→重启持久→四类别自然语言问答→无泄漏→撤销→撤销后 typed 拒绝） | 回执文件校验通过 |

**退出码**：0 = 所选阶段全 PASS；1 = 有 FAIL 或 **BOUNDARY**；2 = 有 SKIP /
MANUAL-PENDING / 显式 assumption；3 = 用法错误。**BOUNDARY** = harness 落在 lawful
typed 拒绝边界（如账户未激活的 `read_back_unavailable`）—— 证据已取回但**不是**
终局，不得按绿报告（语义见 live-acceptance-evidence.md §1.3）。

## 4. 失败分诊表

| 症状 | 可能原因 | 动作 |
|---|---|---|
| preflight: `pnpm not invocable` | corepack 未启用 | `corepack enable && corepack prepare pnpm@10.33.2 --activate`（hint 自带） |
| preflight: `electron package not installed` | 未 install | `pnpm install --frozen-lockfile` 后重跑 preflight |
| preflight: `SESSIONNAME` 非 Console/RDP | 服务/session-0 上下文 | 换交互桌面会话执行（RDP 或本机） |
| 探针 `isEncryptionAvailable=false`（win32） | app-ready 前调用/异常态 | **如实记 FAIL 并上报** —— Windows 上该值为异常态，禁止绕过（不发明 fallback 加密） |
| 探针 `roundTrip=mismatch` | DPAPI 往返破坏 | 同上，如实 FAIL；附探针 JSON |
| stripe-live 的 E2E spec 红、connect 落 `PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE` | DPAPI 不可用被生产法则 fail-closed | 先修 secure-storage 阶段，勿重跑 live |
| harness `RESULT_HARNESS=1` | 账户未激活（typed 拒绝边界） | **不是缺陷**：完成 Stripe 邮箱验证激活后复跑；若账户已激活仍 1 → 附 evidence JSON 上报（adapter/evidence 面排查） |
| 授权探针 401 / `invalid_api_key` | 键失效/权限缩水 | dashboard 复核受限键权限（五读面）后重跑 preflight |
| 阶段 SKIP（preflight gate） | 能力缺失 | 按 reasons 修环境；**不得**用 `--allow-skip` 把 SKIP 洗成绿（它只记录承认） |

## 5. 证据回传（消毒纪律）

- 工件目录：`artifacts\p2-acceptance\<时间戳>\`（`summary.json` +
  `MANIFEST-sha256.txt` + 各阶段日志 + live-harness 输出 + 交互清单）。
- runner 已做：键值落盘前置换、逐文件字节级泄漏自检、SHA-256 manifest。
- 回传 TL 时**只摘录**：各阶段 verdict、`summary.json`、`MANIFEST-sha256.txt`、
  `live-conversational-evidence.json`（结构化步骤）、探针 JSON、
  `manual-new-task-evidence.md`。**检查一遍再发**：无 `rk_test_`/`sk_` 字样、
  无客户 PII、截图无键值。
- 登记：按 live-acceptance-evidence.md 的登记格式把「平台/OS build、工具版本、
  commit SHA、命令、退出码、结果、工件哈希、native-Windows 与真 Stripe 标记」
  追加进 §7 起的对应小节；roadmap P2 行的推进由 TL 在评审合并时执行。

## 6. 不要做（架构与安全边界 —— 违反即返工）

- 不加第二 agent 运行时 / 第二账户注册表 / 第二凭据仓。
- 不把 PSP 凭据暴露给模型；不把键写进 plugin `userConfig`。
- 不为让测试变绿而弱化 Gate E2 / 安全检查；不引入 fallback 加密。
- 不把 E2B/WSL2/Linux 结果冒充 Windows 验收；不把 typed 拒绝冒充数据落地。
- 不另建 Stripe 聊天面 / 模型直连 Stripe；P2 保持只读（无支付/退款/出金/争议应答）。
- P3 的 Paystack/PayPal/支付执行工作不在本手册范围。
