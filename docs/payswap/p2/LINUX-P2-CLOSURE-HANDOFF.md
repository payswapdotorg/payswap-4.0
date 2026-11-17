# P2-Linux 关闭交接（LINUX P2 CLOSURE HANDOFF）

> **维护**：TL，2026-11-17（晚间）· **分支**：`p2/acceptance-runner-fail-closed`
> （含合并 `57669794` = `p2/vm-scripts-repo-root` 的 E2B 侧修复；runner 交付 +
> 里程碑拆分在其上）· **对象**：任何要完成 P2-Linux 关闭的操作者/agent。
> **纪律**：里程碑状态的唯一权威登记是
> [docs/payswap/p0/10-roadmap.md](../p0/10-roadmap.md) 的 P2-Linux 行；本文件是
> 执行交接，不重复状态裁决。

---

## 0. 一屏现状（2026-11-17 晚）

| 项 | 状态 |
|---|---|
| Linux 验收执行面 | **已交付**：`scripts/payswap/linux/`（腿栈解析 + 显示腿包装器 + 五分类 runner + 14 例回归矩阵）；preflight 的 Linux 阶段裁决就位 |
| linux-build | **PASS**（TL Linux 腿实测：install + e2e-report + desktop 链 + E2E renderer 面，内存受限形态） |
| linux-secure-storage | **PASS**（真 Electron gnome_libsecret 探针〔显示腿内〕+ 13 套件 129/129 + 平台门 12/12） |
| linux-desktop-e2e | **PASS**（payswap-connection-ui 7/7，首过率 100%——四个存储臂在真 gnome_libsecret 后端上执行） |
| stripe-live | **SKIP** —— 无 `ZCODE_E2E_STRIPE_LIVE_KEY`（本环境无键；聊天转录不是合格秘密通道） |
| conversation-acceptance | **SKIP** —— 依赖 stripe-live |
| 里程碑拆分 | **已落地**（P2 → P2-Linux + P2-Windows；validator/playbook 同步；P2-Linux 行 in_progress） |
| 工件 | `artifacts/p2-acceptance-linux/<时间戳>/`：summary.json + MANIFEST-sha256.txt + 各阶段日志（无秘密材料 —— secretPresent=false） |

**结论**：P2-Linux 的**可独立推进半边已全绿**；剩余两阶段被两个**操作者控制步**
门控（键供给 + 账户 onboarding 身份段）。SKIP 如实登记，绝不冒充完成。

## 1. 剩余的用户控制步（精确识别，不得绕过）

### 步骤 A —— 受限只读键供给

- **现状**：键 `rk_test_*`（名 `payswap-p2-live-ro`，恰好五读面：Accounts /
  Balance / Charges+Refunds / Customers / Payment Disputes，2026-11-16 建）在
  **Windows 操作机** `~/.payswap-keys.env`（0600）。账户
  `acct_1UblugEz3o7yd7Uo`（`ekontetevi+p2acceptance@gmail.com`）。
- **TL 沙箱无键且无合法通道**：会话转录会记录一切经工具注入的值 —— 键只经
  **验收机本地的 0600 env 文件**供给（handoff §1 的硬法则）。
- **操作**（二选一）：
  1. **在 Windows 操作机跑 E2B 双臂**（canonical，驱动器自带腿）：
     ```bash
     . ~/.payswap-keys.env
     cd <repo checkout on p2/acceptance-runner-fail-closed>
     PAYSWAP_E2B_TEMPLATE=aise-android-station \
       node scripts/payswap/live/e2b-drive.mjs --arm both
     ```
  2. **或在一台 Linux 验收机（可以是 TL 腿形态：PAYSWAP_LINUX_LEG_STACK 前缀
     或系统安装栈）直接跑 Linux runner**：
     ```bash
     # 一次性（0600，勿入命令行历史/转录）：
     #   printf 'ZCODE_E2E_STRIPE_LIVE_KEY=rk_test_...\n' > ~/.payswap-live.env
     #   chmod 600 ~/.payswap-live.env
     set -a; . ~/.payswap-live.env; set +a
     PAYSWAP_LINUX_LEG_STACK=/path/to/linux-stack \
       node scripts/payswap/linux/run-p2-acceptance.cjs \
       --stage linux-secure-storage --assume-stage-passed linux-build \
       --stage stripe-live --assume-stage-passed linux-desktop-e2e
     ```
     （前提阶段在同机会话已绿时用 `--assume-stage-passed` 显式承认；assumption
     使退出码为 2 —— 唯一能把退出码打到 0 的形态是**单次完整 run、零假设**：
     `node scripts/payswap/linux/run-p2-acceptance.cjs`。）

### 步骤 B —— 账户 onboarding 身份段完成

- **现状**：邮箱已验证 ✓；向导停在 **3/5 "Secure your account"（2FA）**——
  "Add authenticator app" 对话框在场，`Enter code manually` 显示 TOTP secret。
- **为什么阻塞**：`/v1/account` 在 onboarding 身份段完成前**没有 `requirements`
  对象** → `captureCapabilityEvidence` 的全有或无法则（`readBackAccount.ts`）
  → `get_account_overview` detail 恒为 typed `read_back_unavailable`（lawful
  fail-closed，非缺陷；harness `RESULT_HARNESS=1` 的边界语义）。
- **操作**：完成 2FA（TOTP secret 存 `~/.payswap-keys.env` 的
  `STRIPE_P2_TOTP_SECRET`，本地生成 6 位码）→ 4/5（可跳则跳）→ 5/5 提交。
  然后验证门槛输入：
  ```bash
  curl -s -u "$ZCODE_E2E_STRIPE_LIVE_KEY:" https://api.stripe.com/v1/account \
    | jq '.requirements, (.capabilities|length)'
  # 需要：requirements.currently_due/past_due 数组在场 + capabilities 非空
  ```
  若提交后 requirements 仍缺席：等几分钟再查（异步填充）；持续缺席 = 边界
  确实不可达 → 如实登记为操作者依赖，**STOP，不翻 roadmap**。

### 步骤 C —— 终局运行（A+B 就绪后）

```bash
# 单次完整 run、零假设（唯一能把退出码打到 0 的形态）：
set -a; . ~/.payswap-live.env; set +a
PAYSWAP_LINUX_LEG_STACK=/path/to/linux-stack \
  node scripts/payswap/linux/run-p2-acceptance.cjs
# 期望：五阶段全 PASS（stripe-live 内 RESULT_E2E=0 且 RESULT_HARNESS=0 ——
# 四类别数据经直连与桥两跳落地）→ exit 0
# conversation-acceptance 的交互清单照 runner 输出的 manual-new-task-checklist.md
# 走真人+真应用 13 步，回执存 manual-new-task-evidence.md 后 --manual-evidence 复跑。
```

## 2. 证据登记动作（终局运行后）

1. 把 run 的 verdict、summary.json、MANIFEST-sha256.txt、live-harness 输出、
   探针 JSON 按 [live-acceptance-evidence.md](live-acceptance-evidence.md) 的
   登记格式追加（UTC 时间戳、tested SHA、工件哈希；无 `rk_test_`/`sk_` 字样）。
2. roadmap P2-Linux 行：由 TL 在评审合并时按其词汇推进（`gate_passed` →
   `complete`）；**runner 输出不替代该登记**。
3. 合并本分支（PR #46 已含全部 runner/拆分/修复）；AGENT-HANDOFF.md 在 P2
   两腿都关闭的 PR 中删除（其自身条款）。

## 3. 不要做（边界 —— 违反即返工）

- 不把键放进聊天/工单转录、命令行参数、plugin `userConfig`、任何仓库文件。
- 不用 `--allow-skip`/`--assume-stage-passed` 把 run 洗绿（它们只记录承认）。
- 不把 typed 拒绝（`read_back_unavailable` / BOUNDARY）冒充数据落地。
- 不为无钥匙串环境发明 fallback 加密；不弱化 Gate E2 / 消毒 / 泄漏自检。
- 不把 E2B/Linux 结果冒充 Windows 验收（反向同理 —— 两腿互不替代）。
- P2 保持只读：无支付/退款/出金/争议应答面。

## 4. TL 沙箱运行形态备忘（可复现性）

- 环境：Debian 13 trixie 容器（内核 5.10.134，x86_64，2 vCPU，4GiB cgroup，
  headless），Node 24.22.3，pnpm 10.33.2（npm 全局安装），git 2.47.3。
- 腿栈：`PAYSWAP_LINUX_LEG_STACK=/home/z/my-project/linux-stack`（debs 前缀
  解包：gnome-keyring 48、libsecret 0.21、p11-kit 0.25、dbus-x11 1.16 等）。
- 构建形态：`ZCODE_DESKTOP_BUILD_SOURCEMAPS=off`（见 vite.config.ts 注释与
  提交 `1bd675dd` 的登记）；大内存机可 `PAYSWAP_LINUX_FULL_MEMORY_BUILD=1`。
- chromedriver：152.0.7977.82（Electron 44.7.0 ↔ Chromium 152.0.7977.130 的
  兼容回退版；经 `chromedriver-preflight.mjs path` + `CHROMEDRIVER_PATH` 注入
  —— CI 容器脚本同源机制）。
