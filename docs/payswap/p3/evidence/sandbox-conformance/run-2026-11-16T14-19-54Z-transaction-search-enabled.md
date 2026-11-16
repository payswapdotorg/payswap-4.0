# PaySwap P3 — PayPal sandbox conformance run（run 2：Transaction search 启用后）

run_at_utc: 2026-11-16T14:19:54.444Z
target: https://api-m.sandbox.paypal.com (sandbox — P-3)
app: Default Application（dashboard 勾选「Transaction search — View your PayPal
transaction history」并 Save Changes；dashboard 确认「Application was saved
successfully.」）
credential_source: env（never logged; access_token in-memory only）
no_provider_writes: one token mint + three GETs only
runner: scripts/p3/paypal-sandbox-conformance.ts（NODE_OPTIONS=--use-system-ca）

## token-mint
- request: POST /v1/oauth2/token
- http: 200
- outcome: VERIFIED (mint ok — app_id present: yes)
- observed: {"app_id":"APP-80W2…(shape)","scope_granted":[与 run 1 相同的 15 枚
  scope，仍无 reporting 族],"expires_in_reported":32336,"error_code":null,"token":"<present>"}

## read:balance
- request: GET /v1/reporting/balances
- http: 403
- outcome: REFUSED insufficient_permission（grant 清单仍无 reporting scope）

## read:payment_objects
- request: GET /v1/reporting/transactions
- http: 403
- outcome: REFUSED insufficient_permission

## read:disputes
- request: GET /v1/customer/disputes
- http: 200
- outcome: OK (0 rows)

## read:customers
- request: (no wire)
- http: n/a
- outcome: REFUSED unsupported_operation（by construction）

## 结论
启用 Transaction search 后立即（~1 分钟内）重跑：scope 授予清单未变。两种可能：
PayPal 权限传播延迟（分钟～小时级）或该 app/账户的 entitlement 尚未生效。本 run
如实记录为「启用后即刻状态」；若传播后 scope 出现，将以后续 run 补记。

## 传播复查（2026-11-16T14:22:42Z–14:27:15Z）
启用后 ~3–8 分钟内四次 fresh mint 复查：grant 清单恒 15 枚、reporting scope
恒缺席（`check 1..4 | total: 15 | reporting: []`）。至此以「启用后 8 分钟内不传播」
为登记事实；是否更长时间传播或需要账户级 entitlement，留待后续 run 判定 ——
本记录不猜测。
