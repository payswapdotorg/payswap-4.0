# PaySwap P3 — PayPal sandbox conformance run（run 1：Default Application 基线）

run_at_utc: 2026-11-16T14:18:51.338Z
target: https://api-m.sandbox.paypal.com (sandbox — P-3)
app: Default Application（developer.paypal.com sandbox 模式；app 原样配置，
Transaction search 未启用）
credential_source: env（never logged; access_token in-memory only）
no_provider_writes: one token mint + three GETs only
runner: scripts/p3/paypal-sandbox-conformance.ts（NODE_OPTIONS=--use-system-ca —
Windows 本机 Node 不读系统 CA 库，无此旗标 TLS 校验失败）

## token-mint
- request: POST /v1/oauth2/token
- http: 200
- outcome: VERIFIED (mint ok — app_id present: yes)
- observed: {"app_id":"APP-80W2…(shape)","scope_granted":["https://api.paypal.com/v1/payments/.*","https://api.paypal.com/v1/vault/credit-card","https://api.paypal.com/v1/vault/credit-card/.*","https://uri.paypal.com/payments/payouts","https://uri.paypal.com/services/applications/webhooks","https://uri.paypal.com/services/disputes/read-buyer","https://uri.paypal.com/services/disputes/read-seller","https://uri.paypal.com/services/disputes/update-seller","https://uri.paypal.com/services/invoicing","https://uri.paypal.com/services/payments/futurepayments","https://uri.paypal.com/services/payments/payment/authcapture","https://uri.paypal.com/services/payments/realtimepayment","https://uri.paypal.com/services/payments/refund","https://uri.paypal.com/services/subscriptions","openid"],"expires_in_reported":32400,"error_code":null,"token":"<present>"}

关键观察：grant 清单 15 枚 scope，**无任何 `reporting` scope**（无
`https://uri.paypal.com/services/reporting/search/read`、无 balances 相关 scope）。

## read:balance
- request: GET /v1/reporting/balances
- http: 403
- outcome: REFUSED insufficient_permission（新鲜 mint + 403 —— 直接回答 scope 授予问题）
- observed: body={"name":"NOT_AUTHORIZED","debug_id":"…","message":"Authorization failed due to insufficient permissions.","details":[{"issue":"NOT_AUTHORIZED","description":"Authorization failed due to insufficient permissions."}]}

## read:payment_objects
- request: GET /v1/reporting/transactions
- http: 403
- outcome: REFUSED insufficient_permission（同 balance —— reporting scope 不在 grant 清单）
- observed: body={"name":"NOT_AUTHORIZED",…同 balance 形状}

## read:disputes
- request: GET /v1/customer/disputes
- http: 200
- outcome: OK (0 rows)（grant 清单含 disputes/read-seller —— disputes 类别读面可用；0 行 =
  sandbox 无争议单，容器形状不可观察）

## read:customers
- request: (no wire — PayPal's verified read plane has no customer-list surface)
- http: n/a
- outcome: REFUSED unsupported_operation（by construction —— adapter 永不接线此类别）

## 结论（⚠ 项 2 的回答）
Default Application 基线配置下，client-credentials mint 的 scope 授予清单不含
reporting 族 scope → balances/transactions 恒 403 NOT_AUTHORIZED；disputes 200
可读。scope 授予问题 = **app 特性配置决定**，不是凭据/端点形状问题。
