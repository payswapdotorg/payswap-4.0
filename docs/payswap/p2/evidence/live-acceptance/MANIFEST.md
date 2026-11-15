# P2 live-acceptance evidence manifest（消毒工件登记）

> 登记者：TL · 登记日期：2026-11-15 · 上游登记：PR #33（main @ `9bea2083`，
> roadmap P2 行 live 实证注册段）。
> 本目录只含**消毒工件**（零凭据材料 —— 账户 id/连接 id/typed 拒绝非秘密）。
> 真实受限键（`rk_test_*`）与原始粗日志**永不入库**（键只经 env 注入；
> 155KB wdio 全量日志含环境噪音，以摘要 + 本目录结构化工件为准）。

## 存活工件（2026-11-15 校验；SHA-256 即复现比对的基准）

| 文件 | 字节 | SHA-256 |
|---|---|---|
| `live-conversational-evidence.json` | 1,862 | `b09f6c65eca23c8f2f81d11f51740bfb0d250a1eafcf0bccf240663d641c0b72` |
| `payswap-connections-at-rest.json` | 325 | `0b63cae37199e4b3f092a997afcdfc812e92003d223ec534c252c8a6197742c6` |
| `RESULT-harness.txt` | 17 | `61cfde61f3d02d1b0e954c53334bcaf0b25ec90ac5f3297601720b96aade2eb1` |

产生：2026-11-14 22:53–23:0xZ，E2B 云 VM（第三只验收沙箱），真实 Libsecret
后端 + 真实网络；账户 `acct_1UblugEz3o7yd7Uo`（受限只读键，Read on
Account/Balance/Charges/Customers/Disputes）。

## 遗失工件（如实登记 —— 2026-11-15 宿主回收所致，不可再校验）

| 原工件 | 事实记录来源 |
|---|---|
| `e2e-live.log`（155KB 全量 wdio 日志，3/3 live 臂 ×2） | PR #33 正文（3/3 两次复现的逐臂断言记录）+ roadmap P2 行 |
| `harness2.log`（harness 全量控制台日志） | 同上（9 步骤结构化结果以 `live-conversational-evidence.json` 为准 —— 摘要即全文事实） |
| `p2-live-evidence/`（E2E 侧 summary/ndjson/manifest 家族，取回件） | PR #33 正文（其内容要点已逐条入 PR 正文与 roadmap） |

遗失不改变已登记结论：结构化工件 + PR #33 正文是充分登记面；复现基准以本
manifest 的 SHA-256 + 可从 fresh checkout 重跑的工具链
（`scripts/payswap/live/`）为准。

## 复现

见 [`scripts/payswap/live/README.md`](../../../../scripts/payswap/live/README.md)
（工具链为仓控重建版 —— 溯源与差异说明见
[`../live-acceptance-evidence.md`](../live-acceptance-evidence.md)）。
