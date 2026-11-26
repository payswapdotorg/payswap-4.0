/**
 * `services-payswap` —— PaySwap 账户服务的 services 侧公共入口（P2.2，
 * deliverable 06 §2.2；deliverable 05 §5 认证面的 host-service 半）。
 *
 * 公共面（architecture-governance managed 模块的 publicEntrypoint 桶）：
 * - 账户服务工厂 `createPayswapAccountService`（connect/revoke/listConnections 的
 *   单一写者；秘密只落 ICredentialService 的 payswap:psp:* 键）。
 * - 连接记录 store 工厂 `createPayswapConnectionRecordStore`（非秘密元数据 JSON
 *   store：0600 原子写 + 跨进程文件锁 + corrupt-refuse-overwrite）。
 * - 真实 Stripe 读回 adapter `createStripeAccountReadBackPort`（slice 3，doc 06
 *   §2.9 provider 运行时；`PayswapAccountReadBackPort` 的 Stripe 实现 ——
 *   GET /v1/account + Bearer，401 唯一 auth-failed 证据，其余 unknown ≠
 *   expired；秘密只进 Authorization 头）。
 *
 * 法则（schema/模板/投影/authSpec/typed refusal）住 `@zcode/shared/payswap` 的
 * account-connection.ts —— 本模块与 law 级测试共用同一份实现，永不漂移。
 * host 侧装配（additive RPC channel、平台壳连接 UI、desktop 入口接线）随 P2.2
 * 后续切片（D12.7 纪律：法则与模块先行，入口接线随活的窗口证明）。
 */

export {
  createCustodianRequiredRefusingCredentialPort,
  createPayswapAccountService,
  createPayswapCustodianUnavailableError,
  CUSTODIAN_SECRET_MARKER,
  type PayswapAccountCredentialPort,
  type PayswapAccountService,
  type PayswapAccountServiceDependencies,
} from "./accounts/accountService.js";
export {
  createPayswapConnectionRecordStore,
  createPayswapConnectionsStoreCorruptError,
  isPayswapConnectionsStoreCorruptError,
  PAYSWAP_CONNECTIONS_STORE_CORRUPT_CODE,
  PAYSWAP_CONNECTIONS_STORE_FILE_NAME,
  type PayswapConnectionRecordStore,
  type PayswapConnectionRecordStoreDependencies,
} from "./accounts/connectionRecordStore.js";
export {
  createStripeAccountReadBackPort,
  type PayswapStripeReadBackDependencies,
} from "./providers/stripe/readBackAccount.js";
export {
  createPaystackAccountReadBackPort,
  type PayswapPaystackReadBackDependencies,
} from "./providers/paystack/readBackAccount.js";
export {
  createPaypalAccountReadBackPort,
  type PayswapPaypalCustodianTokenPost,
  type PayswapPaypalReadBackDependencies,
} from "./providers/paypal/readBackAccount.js";
export {
  createPaypalAccountDataReadPort,
  type PayswapPaypalDataReadDependencies,
} from "./providers/paypal/readAccountData.js";
export {
  createPaystackAccountDataReadPort,
  type PayswapPaystackDataReadDependencies,
} from "./providers/paystack/readAccountData.js";
export {
  createPayswapAccountDataReadRouter,
  type PayswapAccountDataReadRouterDependencies,
} from "./providers/readAccountDataRouter.js";
export {
  createPayswapCapabilityRegistry,
  derivePayswapCapabilityRecord,
  PAYSWAP_CAPABILITY_OPERATION_VOCABULARY,
  payswapCapabilityRestrictionSchema,
  payswapCapabilityRecordSchema,
  type PayswapCapabilityDerivationInput,
  type PayswapCapabilityRecord,
  type PayswapCapabilityRegistry,
} from "./capability/capabilityRegistry.js";
export {
  evaluatePayswapEligibility,
  payswapEligibilityAnswerSchema,
  payswapEligibilityConstraintsSchema,
  payswapEligibilityQuerySchema,
  PAYSWAP_ELIGIBILITY_REFUSAL_CODES,
  type PayswapEligibilityAnswer,
  type PayswapEligibilityEvaluationInput,
  type PayswapEligibilityQuery,
  type PayswapEligibilityRefusalCode,
} from "./eligibility/eligibilityEngine.js";
// PaySwap P4 wave 4：money-movement intent 编译器 + 进程内不可变 intent 注册表
// （shared CONTRACT「P4 wave 4」—— 纯确定性编译，draft-vs-evidence 分离；
// broker check_eligibility 接线随 wave-4 PR(b)）。
export {
  compilePayswapIntent,
  PAYSWAP_INTENT_KINDS,
  PAYSWAP_INTENT_OPERATION_MAP,
  PAYSWAP_INTENT_REFUSAL_CODES,
  payswapFinancialIntentSchema,
  payswapIntentDraftSchema,
  type PayswapClarificationRequest,
  type PayswapFinancialIntent,
  type PayswapIntentCompileInput,
  type PayswapIntentCompileOutcome,
  type PayswapIntentDraft,
  type PayswapIntentKind,
  type PayswapIntentRefusalCode,
} from "./intent/intentCompiler.js";
export {
  createPayswapIntentRegistry,
  type PayswapIntentRegistry,
} from "./intent/intentRegistry.js";
export {
  createPayswapAccountReadBackRouter,
  type PayswapAccountReadBackRouterDependencies,
} from "./providers/readBackRouter.js";
export {
  createStripeAccountDataReadPort,
  type PayswapStripeDataReadDependencies,
} from "./providers/stripe/readAccountData.js";
export {
  createPayswapAccountRuntime,
  type PayswapAccountRuntime,
  type PayswapAccountRuntimeDependencies,
  type PayswapCustodianBridge,
} from "./runtime.js";
export {
  PAYSWAP_X402_CONSUMED_CREDENTIAL_RETENTION_MAX,
  createPayswapProtocolChallengeRegistry,
  type PayswapChallengeConsumeOutcome,
  type PayswapMppChallengeConsumeInput,
  type PayswapMppChallengeIssueInput,
  type PayswapMppChallengeRegistryFace,
  type PayswapProtocolChallengeRecord,
  type PayswapProtocolChallengeRegistry,
  type PayswapX402AdvertiseInput,
  type PayswapX402CredentialConsume,
  type PayswapX402PaymentRegistryFace,
  type PayswapX402RequirementsMatch,
  type PayswapX402RequirementsRecord,
} from "./protocols/challengeRegistry.js";
export {
  createPayswapHostEvidenceAuthority,
  type PayswapHostEvidenceAuthority,
  type PayswapHostEvidenceClaim,
} from "./protocols/evidenceAuthority.js";
export {
  createPayswapProtocolHost,
  type PayswapProtocolHost,
  type PayswapProtocolHostInboundOutcome,
  type PayswapProtocolHostOptions,
} from "./protocols/host.js";
export {
  createPayswapProtocolRuntime,
  type PayswapProtocolRuntime,
  type PayswapProtocolRuntimeDependencies,
} from "./protocols/protocolRuntime.js";
