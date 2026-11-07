/**
 * server-payswap 公共入口（P1.6；addendum §1.6.3；ADR-11）。
 *
 * 消费方：packages/server/src/http.ts（financial 部署的中间件变体 + /ws 两级
 * 握手 + operator-session 端点装配）与 entry-http.ts（部署级激活法则）。
 * 法则实现与类型从 shared-payswap 原样再导出（单一实现纪律）。
 */

export {
  PAYSWAP_FINANCIAL_ACTIVATION_REFUSAL_CODE,
  PAYSWAP_FINANCIAL_MODE_ENV_KEY,
  readPayswapFinancialModeRequested,
  resolvePayswapFinancialActivation,
  type PayswapFinancialActivation,
} from "./config.js";
export {
  PAYSWAP_OPERATOR_STORE_LOAD_FAILED_CODE,
  createPayswapOperatorStore,
  type PayswapClosableSocket,
  type PayswapOperatorStore,
  type PayswapOperatorStoreOptions,
  type PayswapOperatorSessionCookieMint,
} from "./operator-store.js";
export { installPayswapOperatorAuth, type PayswapOperatorAuthWiring } from "./http-wiring.js";
export {
  PAYSWAP_APPROVAL_CHANNEL_NAME,
  PAYSWAP_APPROVAL_CHANNEL_UNAUTHORIZED,
  createPayswapApprovalHost,
  payswapApprovalChannelDescriptor,
  type PayswapApprovalChannel,
  type PayswapApprovalHost,
  type PayswapProposalIssueVerdict,
} from "./approval-service.js";
export { serverPayswapModule } from "./module.js";
export {
  PAYSWAP_FINANCIAL_ACTIVATION_REFUSAL,
  PAYSWAP_OPERATOR_REGISTRY_LOAD_FAILED,
  PAYSWAP_OPERATOR_SESSION_COOKIE_ATTRS,
  PAYSWAP_DISABLED_URL_CREDENTIAL_TRANSPORT,
} from "./contract.js";
