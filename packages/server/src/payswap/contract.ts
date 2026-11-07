/**
 * server-payswap 对外契约（P1.6 —— addendum §1.6.3；ADR-11）。
 *
 * 模块级摘要：server 部署的 operator-principal 状态 owner 与 /ws 两级握手接线。
 * 法则（凭据/注册表/会话/挑战/握手评估）的唯一实现住 shared-payswap；本模块组装
 * 持久化（0600 原子写）、连接生命周期（撤销的 server 侧关闭）与 Hono 装配面。
 */

/** N27：请求 financial 而无 deployment 凭据 → 激活拒绝（typed code）。 */
export const PAYSWAP_FINANCIAL_ACTIVATION_REFUSAL = "financial_mode_deployment_auth_required" as const;

/** 注册表状态文件加载失败（存在但损坏/不可读）→ 构造抛错（fail-closed）。 */
export const PAYSWAP_OPERATOR_REGISTRY_LOAD_FAILED = "payswap_operator_registry_load_failed" as const;

/** financial 部署上被禁用的 URL 凭据传输（§1.6.3 item 7 —— ?token= 查询分支）。 */
export const PAYSWAP_DISABLED_URL_CREDENTIAL_TRANSPORT = "?token=" as const;

/** operator-session cookie 的作用域三属性（Path=/ws + HttpOnly + SameSite=Strict）。 */
export const PAYSWAP_OPERATOR_SESSION_COOKIE_ATTRS = [
  "Path=/ws",
  "HttpOnly",
  "SameSite=Strict",
] as const;
