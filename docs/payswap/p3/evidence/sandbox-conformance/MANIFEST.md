# P3 sandbox-conformance evidence manifest（消毒工件登记）

> 登记者：TL · 登记日期：2026-11-16 · 上游：PR #40 复核的 Finding 后随步骤
> （roadmap P3 行「sandbox conformance」）。
> 本目录只含**消毒工件**：零凭据材料（client id/secret/token 一律不入库 ——
> 凭据只经 env 注入一次运行；报告只记非秘密摘要：HTTP 状态、scope 授予清单、
> 字段形状、金额/货币形状）。原始凭据永不入库、不入任何 commit。

## 存活工件（2026-11-16 校验；SHA-256 即复现比对的基准）

| 文件 | 字节 | SHA-256 |
|---|---|---|
| `run-2026-11-16T14-18-51Z-default-app-baseline.md` | 3,127 | `c8561a4dd994c120c88caa7d8414a39a254b7c16348621691fd67209324bed89` |
| `run-2026-11-16T14-19-54Z-transaction-search-enabled.md` | 2,059 | `1f59ad63fc6a44b42c91d7b9abe701995b44617c9a1662258c7039ab87eb8f05` |

## 运行事实

- run 1（基线）：Default Application 原样配置。mint 200（app_id 在场；15 枚
  scope，**无 reporting 族**）；balances/transactions 403 NOT_AUTHORIZED；
  disputes 200（0 行）；customers typed unsupported_operation（不触网）。
- run 2（启用 Transaction search 后 ~1 分钟）：dashboard 确认保存成功；
  grant 清单不变（15 枚，无 reporting）。传播复查：启用后 3–8 分钟四次 fresh
  mint 恒无 reporting scope。如实登记为「启用后 8 分钟内不传播」—— PayPal
  权限传播可能更滞后或需要账户级 entitlement；若后续 run 出现 reporting
  scope，以新 run 补记。
- 运行器：`scripts/p3/paypal-sandbox-conformance.ts`（本机
  `NODE_OPTIONS=--use-system-ca` —— Windows 本机 Node 不读系统 CA 库，
  无此旗标 TLS 校验失败；curl 与 CI 均不受影响）。
- 结论面（⚠ 项 2 的回答）：scope 授予 = app 特性配置决定；Default
  Application 的 client-credentials mint 不含 reporting scope →
  balances/transactions 按 `insufficient_permission` typed 拒绝呈现，
  disputes 为唯一 live-read 200 类别。

## 复现

需要操作员自备 sandbox app 凭据（developer dashboard 的 Default
Application 即可）：

```
PAYPAL_SANDBOX_CLIENT_ID=… PAYPAL_SANDBOX_CLIENT_SECRET=… \
  pnpm exec tsx scripts/p3/paypal-sandbox-conformance.ts
```

报告经 stdout 输出（消毒）；与本目录 run 文件比对即复现基准。
