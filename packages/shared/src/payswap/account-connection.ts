/**
 * PaySwap P2.2 —— 账户连接法则（deliverable 05 §5 认证面 + deliverable 06 §2.2
 * 账户服务状态；「Stripe read-only vertical」的连接半，Gate E2 落地后的第一条
 * P2 垂直切片）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **存储键模板**：`payswap:psp:<providerId>:<connectionId>:<secretKind>` 是 PSP
 *    秘密经 ICredentialService 落盘的唯一键形态。实例化后的键落在 Gate E2 的 PSP
 *    命名空间（`payswap:psp:*`，credential-security.ts）内 —— 模板即继承 §5.2 的
 *    键级加密政策，无需第二处判断。段值空/含冒号 = 编程错误，抛出（fail-closed：
 *    宁可拒绝，不可产出绕过段结构的畸形键）。
 * 2. **连接记录**：connection record 只含非秘密元数据（doc 06 §2.2「Secrets never
 *    live here」）。schema `.strict()`：未知字段（尤其任何秘密形字段）拒绝。
 *    `status` 词汇：`connected | expired | revoked` —— `expired` 由 provider
 *    read-back 的 auth-failed 证据翻入、verified 证据翻回（doc 05 §5「expiry
 *    is projected as connection status」）；`revoked` 终态。
 * 3. **状态投影**（doc 05 §5「The renderer and the agent never receive secret
 *    values — only opaque connection status」）：投影是记录的去秘密子集（恰五字
 *    段）；投影 schema 对秘密形载荷 schema 级拒绝 —— 渲染层/模型侧在类型面上
 *    拿不到秘密，这是投影面的法则证明。
 * 4. **authSpec**：per-provider 认证规格的唯一形态（doc 05 §5 `PayswapAuthSpec`
 *    的 P2 子集 —— operator-supplied-secret + key-prefix 模式区分；oauth /
 *    client-credentials 形态随 P3 的 provider 评估落地，不提前发明）。Stripe
 *    事实源自 doc 04（检索日期在案）：sk/rk × test/live，revoke =
 *    delete-local-only。formatCheck 是防御性检查；**最终权威是 provider
 *    read-back**（refreshEvidence），本模块永不声称格式通过即凭据有效。
 * 5. **typed refusal**：账户服务的存储 fail-closed 拒绝码逐字复用 Gate E2 的
 *    `PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE`（addendum §5.2「typed error
 *    surfaced in the connection UI」）—— 单一事实源，连接 UI 按 code 分流。
 * 6. **provider 读回端口**（doc 05 §5「final authority is provider read-back」+
 *    §6.4 unknown 结局纪律 + doc 06 §2.2 refreshEvidence）：三值结局 strict
 *    schema —— `verified`（携带 `providerAccountId` 非秘密证据摘要）/ `auth-failed`
 *    （provider 拒绝凭据 —— 唯一能把状态翻到 `expired` 的证据）/ `unavailable`
 *    （网络/未知结局 —— 不是 expiry 证据）。端口在 host 进程内执行；秘密只经
 *    参数入，端口永不持久化/日志/投影秘密；结局面永不携带秘密材料。畸形结局
 *    无证据 = fail-closed 拒绝，永不翻状态。
 *
 * 本模块无 IO、无时间源（时间由调用方注入）；node:crypto 的 randomUUID 是系统
 * 原语（与 broker-identity 同一纪律）。
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PAYSWAP_PSP_CREDENTIAL_KEY_PREFIX, PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE_CODE } from "./credential-security.js";

// ---------------------------------------------------------------------------
// 秘密种类（doc 05 §5 secretKinds 的封闭枚举）
// ---------------------------------------------------------------------------

/** PSP 秘密种类的封闭枚举（doc 05 §5；P2 只用 api-key，其余随 P3 provider 落地）。 */
export const PAYSWAP_PSP_SECRET_KINDS = [
  "api-key",
  "client-id",
  "client-secret",
  "refresh-token",
  "webhook-secret",
  "webhook-id",
] as const;

export type PayswapPspSecretKind = (typeof PAYSWAP_PSP_SECRET_KINDS)[number];

// ---------------------------------------------------------------------------
// 存储键模板（doc 05 §5 storageKeyTemplate 的实例化）
// ---------------------------------------------------------------------------

function requireKeySegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Payswap PSP storage key segment ${label} must be non-empty`);
  }
  if (trimmed.includes(":")) {
    throw new Error(
      `Payswap PSP storage key segment ${label} must not contain ':' (template segments are indivisible)`,
    );
  }
  return trimmed;
}

/**
 * 实例化 PSP 秘密的 credential store 键：
 * `payswap:psp:<providerId>:<connectionId>:<secretKind>`（doc 05 §5 模板）。
 * 段值空/含冒号 → 抛出（编程错误，fail-closed）。
 */
export function payswapPspSecretCredentialKey(
  providerId: string,
  connectionId: string,
  secretKind: string,
): string {
  return `${PAYSWAP_PSP_CREDENTIAL_KEY_PREFIX}${requireKeySegment(providerId, "providerId")}:${requireKeySegment(connectionId, "connectionId")}:${requireKeySegment(secretKind, "secretKind")}`;
}

// ---------------------------------------------------------------------------
// 连接记录（doc 06 §2.2：非秘密元数据，strict）
// ---------------------------------------------------------------------------

export const payswapConnectionRecordSchema = z
  .object({
    connectionId: z.string().min(1),
    providerId: z.string().min(1),
    mode: z.enum(["test", "live"]),
    displayName: z.string().trim().min(1).max(120),
    status: z.enum(["connected", "expired", "revoked"]),
    /** 该连接实际落盘的秘密种类清单（撤销时逐项删除；种类名不是秘密）。 */
    secretKinds: z.array(z.enum(PAYSWAP_PSP_SECRET_KINDS)).min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export type PayswapConnectionRecord = z.infer<typeof payswapConnectionRecordSchema>;

// ---------------------------------------------------------------------------
// 状态投影（doc 05 §5：渲染层/模型侧只见不透明状态）
// ---------------------------------------------------------------------------

export const payswapConnectionStatusProjectionSchema = z
  .object({
    connectionId: z.string().min(1),
    providerId: z.string().min(1),
    mode: z.enum(["test", "live"]),
    displayName: z.string().trim().min(1).max(120),
    status: z.enum(["connected", "expired", "revoked"]),
  })
  .strict();

export type PayswapConnectionStatusProjection = z.infer<
  typeof payswapConnectionStatusProjectionSchema
>;

/** 记录 → 状态投影（去秘密子集；投影面永不携带 createdAt/updatedAt/secretKinds）。 */
export function projectPayswapConnectionStatus(
  record: PayswapConnectionRecord,
): PayswapConnectionStatusProjection {
  return {
    connectionId: record.connectionId,
    providerId: record.providerId,
    mode: record.mode,
    displayName: record.displayName,
    status: record.status,
  };
}

// ---------------------------------------------------------------------------
// authSpec（doc 05 §5 的 P2 子集：operator-supplied-secret + key-prefix）
// ---------------------------------------------------------------------------

/** key-prefix 模式区分的前缀表（证据源自 doc 04 的 per-provider 事实）。 */
export interface PayswapSecretModePrefix {
  readonly prefix: string;
  readonly mode: "test" | "live";
}

export interface PayswapOperatorSecretAuthSpec {
  readonly providerId: string;
  readonly acquisition: {
    readonly kind: "operator-supplied-secret";
    readonly label: string;
    /** 永远是占位符形态（doc 04 §0：never a real key）。 */
    readonly placeholder: string;
    /** 防御性模式；最终权威是 provider read-back。 */
    readonly formatCheck: RegExp;
    readonly modeDistinguishable: "key-prefix";
    readonly modePrefixes: readonly PayswapSecretModePrefix[];
  };
  readonly secretKinds: readonly PayswapPspSecretKind[];
  readonly revoke: "delete-local-only" | "delete-and-provider-deauthorize";
}

/**
 * Stripe authSpec（doc 04 §1 的事实，检索日期在案）：operator-supplied secret
 * key；sk（secret）/rk（restricted）× test/live 前缀区分模式；revoke =
 * delete-local-only。restricted key 优先（doc 04 §4 最小权限）。
 */
export const PAYSWAP_STRIPE_AUTH_SPEC: PayswapOperatorSecretAuthSpec = {
  providerId: "stripe",
  acquisition: {
    kind: "operator-supplied-secret",
    label: "Stripe secret key (restricted key preferred)",
    placeholder: "sk_live_<placeholder>",
    formatCheck: /^(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{16,}$/,
    modeDistinguishable: "key-prefix",
    modePrefixes: [
      { prefix: "sk_test_", mode: "test" },
      { prefix: "rk_test_", mode: "test" },
      { prefix: "sk_live_", mode: "live" },
      { prefix: "rk_live_", mode: "live" },
    ],
  },
  secretKinds: ["api-key"],
  revoke: "delete-local-only",
};

/**
 * P3 provider-facts pin 的形态（doc 04 §5 dated-evidence discipline 的 provider
 * 面 —— 与 protocols/ 的协议 pin 同纪律：每个编码事实都有官方 URL、检索日期与
 * 再验证清单；未证实的事实绝不入实现）。
 */
export interface PayswapProviderEvidencePin {
  readonly providerId: string;
  /** 官方证据面（全部 https；逐条对应 verifiedBoundaryFacts 的来源）。 */
  readonly officialSourceUrls: readonly string[];
  /** 全部事实的检索日期（ISO 8601 — 重检索时整体翻新并记录新日期）。 */
  readonly factsRetrievedAt: string;
  /** 已验证的边界事实（实现只允许编码这里列出的面）。 */
  readonly verifiedBoundaryFacts: readonly string[];
  /** 再验证清单（非空 = 有在案的关注面；适配器使用的前置条件）。 */
  readonly reverifyBeforeAdapterUse: readonly string[];
}

/**
 * Paystack 官方事实 pin（P3 provider half，检索 2026-11-20）：
 * - https://paystack.com/docs/api/authentication/ — Bearer SECRET_KEY；sk_test_/
 *   sk_live_（secret，backend-only）与 pk_test_/pk_live_（public，frontend-only，
 *   绝不作连接秘密）；无效凭据 401 Unauthorized；测试环境不处理结算。
 * - https://paystack.com/docs/api/ — base URL https://api.paystack.co（test/live
 *   同端点，键决定环境）；响应封套 {status: boolean, message, data}；金额为货币
 *   最小单位。
 * - https://paystack.com/docs/api/transfer-control/ — GET /balance「Fetch the
 *   available balance on your integration」→ data: [{currency, balance}]。
 * - https://paystack.com/docs/api/settlement/ — GET /settlement 条目含 integration
 *   数值 id（商户身份的唯一官方踪迹；测试模式不产生结算 —— 见再验证清单）。
 * 结构性缺口（typed 面，见 reverifyBeforeAdapterUse；ADR-P2-1 修订 2026-11-24）：
 * 官方 API 无 merchant/business self-identity 端点 —— `verified` 结局的
 * providerAccountId 对 Paystack 没有官方事实来源；官方 API reference 也无能力读回
 * 面。读回端口把成功的 balance 读回映射为 `verified` + `providerAccountId: null`
 * + `identityGap` + `capabilityGap`（凭据被认证是事实；身份与能力缺席是 typed 缺口
 * —— 401 的 expiry 证据不受影响）。
 */
export const PAYSWAP_PAYSTACK_EVIDENCE_PIN: PayswapProviderEvidencePin = {
  providerId: "paystack",
  officialSourceUrls: [
    "https://paystack.com/docs/api/authentication/",
    "https://paystack.com/docs/api/",
    "https://paystack.com/docs/api/transfer-control/",
    "https://paystack.com/docs/api/settlement/",
  ],
  factsRetrievedAt: "2026-11-20",
  verifiedBoundaryFacts: [
    "Authorization: Bearer SECRET_KEY (secret key, backend API requests only; the public key pk_* is frontend-only and never a connection secret)",
    "Base URL https://api.paystack.co for both test and live environments; the key determines the environment",
    "Secret key prefixes sk_test_ (test) and sk_live_ (live)",
    "Unauthenticated/invalid requests fail with HTTP 401 Unauthorized",
    "JSON response envelope {status: boolean, message: string, data: ...}; amounts in currency subunits",
    "GET /balance fetches the available balance on the integration (data: [{currency, balance}])",
    "GET /settlement items carry an integration numeric id; settlements are not processed in test mode",
    "No merchant/business self-identity endpoint exists in the official API reference (checked 2026-11-20)",
    "No capability/features/permissions/requirements read-back resource exists in the official API reference (https://paystack.com/docs/api/ — all 32 resource groups enumerated; checked 2026-11-24)",
  ],
  reverifyBeforeAdapterUse: [
    "Merchant/integration self-identity endpoint: none in the official API reference as of 2026-11-20 — when officially published, map the balance read-back's verified outcome to the official identifier instead of the typed identity gap",
    "Capability read-back surface: none in the official API reference as of 2026-11-24 — when officially published, capture it as capability evidence instead of declaring capabilityGap",
    "Paystack-Version header / API versioning: not documented on the official authentication page as of 2026-11-20",
    "/balance currency coverage beyond the documented NGN samples",
  ],
};

/**
 * Paystack authSpec（P3 provider half；PAYSWAP_PAYSTACK_EVIDENCE_PIN 的事实，
 * 检索 2026-11-20 在案）：operator-supplied secret key；sk_test_/sk_live_ 前缀
 * 区分模式；public key（pk_*）是 frontend-only —— 绝不是连接秘密（formatCheck
 * 拒绝）；revoke = delete-local-only（官方 deauthorize 面未证实 —— 不发明）。
 */
export const PAYSWAP_PAYSTACK_AUTH_SPEC: PayswapOperatorSecretAuthSpec = {
  providerId: "paystack",
  acquisition: {
    kind: "operator-supplied-secret",
    label: "Paystack secret key",
    placeholder: "sk_live_<placeholder>",
    formatCheck: /^sk_(?:test|live)_[A-Za-z0-9]{10,}$/,
    modeDistinguishable: "key-prefix",
    modePrefixes: [
      { prefix: "sk_test_", mode: "test" },
      { prefix: "sk_live_", mode: "live" },
    ],
  },
  secretKinds: ["api-key"],
  revoke: "delete-local-only",
};

/**
 * PayPal 官方事实 pin（P3 provider half，检索 2026-11-20）：
 * - https://developer.paypal.com/api/rest/authentication/ — OAuth2 client
 *   credentials：POST /v1/oauth2/token（sandbox 官方示例 base
 *   https://api-m.sandbox.paypal.com），HTTP Basic（CLIENT_ID:CLIENT_SECRET 的
 *   Base64），form body grant_type=client_credentials；token 响应字段
 *   {scope, access_token, token_type: "Bearer", app_id, expires_in, nonce}；
 *   后续调用 Bearer ACCESS-TOKEN；过期则重取。
 * - https://developer.paypal.com/api/rest/ — 凭据经 Developer Dashboard
 *   「Apps & Credentials」取得（「Copy the client ID and client secret」）；
 *   client id 标识 app、client secret 认证 client id；官方不记载凭据字符模式。
 * - https://developer.paypal.com/api/rest/requests/ — 服务 URL 官方直接记载
 *   （检索 2026-11-21）："The URL to the API service is either: Sandbox.
 *   https://api-m.sandbox.paypal.com — Live. https://api-m.paypal.com"。
 * - https://developer.paypal.com/api/rest/test-go-live/ — 官方 go-live 清单：
 *   换基址（sandbox → live host）+ 换 live 凭据。
 * - https://developer.paypal.com/api/identity/v1/ — 官方 identity 面是
 *   OpenID Connect userinfo（/v1/identity/openidconnect/userinfo），其 scopes
 *   绑定 client ID —— client_credentials token 可达性官方未证实，不采用。
 * **身份面决策**：token 响应的 app_id 是官方记载的非秘密 app 标识 —— PayPal
 * 读回 = token 交换本身，verified{providerAccountId: app_id}（与 Paystack 的
 * 结构性身份缺口相反，PayPal 有官方身份面）。
 */
export const PAYSWAP_PAYPAL_EVIDENCE_PIN: PayswapProviderEvidencePin = {
  providerId: "paypal",
  officialSourceUrls: [
    "https://developer.paypal.com/api/rest/authentication/",
    "https://developer.paypal.com/api/rest/",
    "https://developer.paypal.com/api/identity/v1/",
    "https://developer.paypal.com/api/rest/requests/",
    "https://developer.paypal.com/api/rest/test-go-live/",
  ],
  factsRetrievedAt: "2026-11-20",
  verifiedBoundaryFacts: [
    "OAuth2 client credentials: POST /v1/oauth2/token with HTTP Basic auth (CLIENT_ID:CLIENT_SECRET Base64) and form body grant_type=client_credentials",
    "Token response fields: {scope, access_token, token_type: \"Bearer\", app_id, expires_in (seconds), nonce}",
    "Subsequent API calls carry Authorization: Bearer ACCESS-TOKEN; on expiry request a new token",
    "Credentials are created in the Developer Dashboard (Apps & Credentials: client ID identifies the app, client secret authenticates it); no official character-pattern documentation for either value",
    "Service URLs are directly documented on the official API requests page (retrieved 2026-11-21): \"The URL to the API service is either: Sandbox. https://api-m.sandbox.paypal.com — Live. https://api-m.paypal.com\"; the official go-live checklist (developer.paypal.com/api/rest/test-go-live) instructs switching the base URL from the sandbox host to https://api-m.paypal.com",
    "The official identity surface is the OpenID Connect userinfo endpoint (/v1/identity/openidconnect/userinfo) with scopes bound to the client ID — client_credentials reachability is NOT officially evidenced",
    "No capability/features/permissions/requirements read-back endpoint exists in the official REST API documentation (https://developer.paypal.com/api/rest/; checked 2026-11-24) — the token response's scope list is informational and has no officially documented mapping to merchant capabilities",
  ],
  reverifyBeforeAdapterUse: [
    "client_credentials access to identity/userinfo surfaces: not officially evidenced as of 2026-11-20 — do not adopt without official documentation",
    "Capability read-back surface / an official scope-to-capability mapping: none as of 2026-11-24 — do not derive capability evidence from token scopes without official documentation; until then the read-back declares capabilityGap",
    "Client id/secret character patterns: not officially documented — keep formatCheck permissive (non-whitespace) unless PayPal publishes a pattern",
  ],
};

/**
 * PayPal authSpec（P3 provider half；PAYSWAP_PAYPAL_EVIDENCE_PIN 的事实，检索
 * 2026-11-20 在案）：OAuth2 client credentials 凭据对（client-id + client-secret
 * 两个秘密种类，[0] = client-secret 主秘密）；模式 = operator-declared
 * （sandbox/live 各有独立 app 凭据，官方无前缀记载 —— 连接输入显式携带 mode，
 * 不猜）；revoke = delete-local-only（官方未证实 credential 自动撤销面）。
 */
export const PAYSWAP_PAYPAL_AUTH_SPEC: PayswapClientCredentialsAuthSpec = {
  providerId: "paypal",
  acquisition: {
    kind: "oauth-client-credentials",
    label: "PayPal REST API app credentials",
    clientIdLabel: "PayPal client ID",
    clientIdPlaceholder: "<client-id>",
    clientSecretLabel: "PayPal client secret",
    clientSecretPlaceholder: "<client-secret>",
    clientSecretFormatCheck: /^\S{8,}$/,
    apiBaseUrl: {
      test: "https://api-m.sandbox.paypal.com",
      live: "https://api-m.paypal.com",
    },
    tokenPath: "/v1/oauth2/token",
  },
  secretKinds: ["client-secret", "client-id"],
  revoke: "delete-local-only",
};

// ---------------------------------------------------------------------------
// client-credentials authSpec 形态（P3 provider half —— PayPal 首个落地；
// shared 头注释「oauth-authorization-code 与 client-credentials 形态随 P3 的
// provider 评估落地」的兑现）。
// ---------------------------------------------------------------------------

/** PayPal client-credentials 形态的 acquisition（凭据对 + 环境声明的端点面）。 */
export interface PayswapClientCredentialsAcquisition {
  readonly kind: "oauth-client-credentials";
  readonly label: string;
  readonly clientIdLabel: string;
  readonly clientIdPlaceholder: string;
  readonly clientSecretLabel: string;
  readonly clientSecretPlaceholder: string;
  /**
   * 防御性检查（client-secret）；最终权威是 provider read-back（token 交换）。
   * PayPal 官方文档不记载凭据字符模式 —— 本检查刻意宽松（非空、无空白），
   * 绝不编码未证实的格式事实。
   */
  readonly clientSecretFormatCheck: RegExp;
  /** 环境端点面（官方 server URL；token 请求 = base + tokenPath）。 */
  readonly apiBaseUrl: { readonly test: string; readonly live: string };
  readonly tokenPath: string;
}

/**
 * client-credentials authSpec：凭据对（client-id + client-secret，两个秘密种类）
 * 存凭据 store；模式不可由凭据值推导（sandbox/live 各有独立 app 凭据，官方无
 * 前缀记载）—— **operator-declared**：连接输入显式携带 mode，不猜。
 */
export interface PayswapClientCredentialsAuthSpec {
  readonly providerId: string;
  readonly acquisition: PayswapClientCredentialsAcquisition;
  /** 恰两种秘密；[0] = 主秘密（client-secret —— wire 认证的另一半经 clientId）。 */
  readonly secretKinds: readonly ["client-secret", "client-id"];
  readonly revoke: "delete-local-only";
}

export type PayswapAuthSpec = PayswapOperatorSecretAuthSpec | PayswapClientCredentialsAuthSpec;

/** client-credentials 形态的类型守卫（连接流按 acquisition.kind 分派的窄化面）。 */
export function isPayswapClientCredentialsAuthSpec(
  spec: PayswapAuthSpec,
): spec is PayswapClientCredentialsAuthSpec {
  return spec.acquisition.kind === "oauth-client-credentials";
}

/**
 * 按前缀推导连接模式（key-prefix 型规格）。无匹配前缀 → null（fail-closed：
 * 宁可拒绝，不可猜）。推导只是记录元数据；凭据有效性的最终权威是 provider
 * read-back（后续切片）。
 */
export function derivePayswapSecretKeyMode(
  secret: string,
  spec: PayswapOperatorSecretAuthSpec,
): "test" | "live" | null {
  const trimmed = secret.trim();
  const match = spec.acquisition.modePrefixes.find((entry) => trimmed.startsWith(entry.prefix));
  return match?.mode ?? null;
}

// ---------------------------------------------------------------------------
// provider 读回端口（doc 05 §5「final authority is provider read-back」+ §6.4
// unknown 结局纪律 + doc 06 §2.2 refreshEvidence；slice 2）
// ---------------------------------------------------------------------------

/** 读回端口的输入（host 进程内执行；秘密只经参数入）。 */
export interface PayswapAccountReadBackInput {
  readonly providerId: string;
  readonly mode: "test" | "live";
  readonly secretKind: PayswapPspSecretKind;
  /** 连接秘密（host 进程内从凭据 store 读出；端口永不持久化/日志/投影它）。 */
  readonly secret: string;
  /**
   * client-credentials 形态的 client id（P3 —— PayPal 读回的 Basic 认证另一半；
   * operator-supplied-secret 记录缺省缺席，wire 行为不变）。
   */
  readonly clientId?: string;
}


// ---------------------------------------------------------------------------
// 能力证据（doc 04 §1.2 —— capabilities + requirements 读回是能力注册表应消费的
// 证据；ADR-P2-1：读回 verified 结局可选携带，概览 detail 面要求其在场）
// ---------------------------------------------------------------------------

/** 能力状态三值（doc 04 §1.2：per-capability status (active/inactive/pending)）。 */
export const payswapCapabilityStatusSchema = z.enum(["active", "inactive", "pending"]);
export type PayswapCapabilityStatus = z.infer<typeof payswapCapabilityStatusSchema>;

/**
 * 账户能力证据（provider 读回的非秘密摘要；doc 04 §1.2「capabilities come from
 * the account's actual state, never from hardcoded claims」）。`requirements` 是
 * 去标识摘要：due 数组只保留计数（currently_due/past_due 的元素是 provider 的
 * requirement id —— 非秘密，但计数已足够 P2 的能力面；后续里程碑需要明细时再扩）。
 *
 * `requirements: null` 是**显式的 provider 缺席证据**（ADR-P2-1 修订 2026-11-17）：
 * Stripe 对 standard 账户的受限键自读（/v1/account 与 /v1/accounts/{id}）返回
 * `capabilities` 但**整个省略 `requirements` 字段**（live 实证 acct_1FPs7UAkPdhgtN6I）。
 * 缺席 ≠ 捏造零值 —— null 表示「provider 本次读回未暴露 requirements」，
 * capabilities 半区仍全部来自 provider（evidence, never claims 不变；present-but-
 * 畸形的 requirements 仍是全有或全无的 fail-closed）。
 */
export const payswapAccountCapabilityEvidenceSchema = z
  .object({
    capabilities: z
      .array(
        z
          .object({
            name: z.string().min(1),
            status: payswapCapabilityStatusSchema,
          })
          .strict(),
      )
      .min(1),
    requirements: z
      .object({
        disabledReason: z.string().min(1).nullable(),
        currentlyDueCount: z.number().int().nonnegative(),
        pastDueCount: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type PayswapAccountCapabilityEvidence = z.infer<
  typeof payswapAccountCapabilityEvidenceSchema
>;

// ---------------------------------------------------------------------------
// provider 缺席面（typed；ADR-P2-1 修订 2026-11-24）—— evidence, never claims 的
// 对偶：provider 官方不暴露的面以 typed 缺口作答，绝不以缺席推断、绝不捏造
// ---------------------------------------------------------------------------

/** 身份缺口码：provider 认证了凭据，但官方 API 不暴露 provider 账户标识。 */
export const PAYSWAP_ACCOUNT_IDENTITY_GAP_CODE = "provider_identity_not_exposed" as const;

/** 身份缺口（读回 `verified` 的 `providerAccountId: null` 时必在场）。 */
export const payswapAccountIdentityGapSchema = z
  .object({
    code: z.literal(PAYSWAP_ACCOUNT_IDENTITY_GAP_CODE),
    /** 操作员/模型可读、零凭据材料；携带官方检索日期（事实引用）。 */
    message: z.string().min(1),
  })
  .strict();
export type PayswapAccountIdentityGap = z.infer<typeof payswapAccountIdentityGapSchema>;

/**
 * 能力证据缺口码：provider 官方 API 不暴露能力读回面 —— 能力未知（doc 05 §4
 * 「Unknown = `unavailable`, not optimistic defaults」）。adapter 只允许为证据 pin
 * 已钉住的官方事实声明它。
 */
export const PAYSWAP_CAPABILITY_EVIDENCE_REFUSAL_CODE = "capability_evidence_not_exposed" as const;

/** 能力证据缺口（与类别读的 `refused` 同一词汇纪律：code + 零凭据 message）。 */
export const payswapAccountCapabilityRefusalSchema = z
  .object({
    code: z.literal(PAYSWAP_CAPABILITY_EVIDENCE_REFUSAL_CODE),
    message: z.string().min(1),
  })
  .strict();
export type PayswapAccountCapabilityRefusal = z.infer<
  typeof payswapAccountCapabilityRefusalSchema
>;

/**
 * 读回结局（strict 闭集）：
 * - `verified` —— provider 认证了凭据并返回账户读回。`providerAccountId` 是非秘密
 *   证据摘要（如 Stripe 的 `acct_*`）；**`null` = 官方 API 不暴露账户标识**，当且
 *   仅当 `identityGap` 在场（P3 身份缺口 provider，如 Paystack）。`evidence` 是能力
 *   证据摘要（doc 04 §1.2 capabilities/requirements 读回）；`capabilityGap` 是 typed
 *   能力缺口 —— 与 `evidence` 互斥，adapter 对已钉住官方事实的显式声明；
 * - `auth-failed` —— provider 拒绝了凭据（**唯一的 expiry 证据**）；
 * - `unavailable` —— 网络/未知结局（**不是** expiry 证据 —— doc 05 §6.4 的
 *   unknown 纪律：读回失败永不假装成功，也永不假装 auth 失败）。
 */
export type PayswapAccountReadBackOutcome =
  | {
      readonly kind: "verified";
      readonly providerAccountId: string | null;
      /** 能力证据（doc 04 §1.2；可选 —— 与 capabilityGap 互斥）。 */
      readonly evidence?: PayswapAccountCapabilityEvidence;
      /** 身份缺口（typed）—— providerAccountId 为 null 时必在场。 */
      readonly identityGap?: PayswapAccountIdentityGap;
      /** 能力证据缺口（typed）—— 在场时 evidence 必缺席。 */
      readonly capabilityGap?: PayswapAccountCapabilityRefusal;
    }
  | { readonly kind: "auth-failed"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string };

/**
 * 结局面 strict 闭集（畸形结局无证据 —— 服务侧 fail-closed 拒绝，永不翻状态）。
 * `verified` 的三个缺席面不变量在 union 层裁决：`null ⇔ identityGap`、
 * `evidence ⊕ capabilityGap`。
 */
export const payswapAccountReadBackOutcomeSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("verified"),
        providerAccountId: z.string().min(1).nullable(),
        evidence: payswapAccountCapabilityEvidenceSchema.optional(),
        identityGap: payswapAccountIdentityGapSchema.optional(),
        capabilityGap: payswapAccountCapabilityRefusalSchema.optional(),
      })
      .strict(),
    z.object({ kind: z.literal("auth-failed"), detail: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("unavailable"), detail: z.string().min(1) }).strict(),
  ])
  .superRefine((outcome, ctx) => {
    if (outcome.kind !== "verified") return;
    if (outcome.providerAccountId === null && outcome.identityGap === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["identityGap"],
        message: "verified with a null providerAccountId requires an identityGap",
      });
    }
    if (outcome.providerAccountId !== null && outcome.identityGap !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["identityGap"],
        message: "identityGap is only valid when providerAccountId is null",
      });
    }
    if (outcome.evidence !== undefined && outcome.capabilityGap !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["capabilityGap"],
        message: "capabilityGap and evidence are mutually exclusive",
      });
    }
  });

/** provider 读回端口（host 进程内的 adapter 函数面；真实 Stripe 实现随 provider 运行时切片）。 */
export type PayswapAccountReadBackPort = (
  input: PayswapAccountReadBackInput,
) => Promise<PayswapAccountReadBackOutcome>;

// ---------------------------------------------------------------------------
// 连接 ID 铸造 + 账户服务 typed refusal
// ---------------------------------------------------------------------------

/** 铸造新连接 ID（UUID v4 形态；随机性源自 node:crypto 系统原语）。 */
export function mintPayswapConnectionId(): string {
  return randomUUID();
}

/**
 * 账户服务的 typed refusal 码（host-service 面）：
 * - `validation_failed` 逐字复用 doc 05 §6.6 词汇（语义精确匹配：输入形状/格式）；
 * - `unsupported_provider` / `unknown_connection` / `read_back_unavailable` 是
 *   host-service 范围的码（§6.6 是 adapter 操作面的词汇表，不越界借用）；
 * - 存储 fail-closed 逐字复用 Gate E2 常量（addendum §5.2「typed error surfaced
 *   in the connection UI」—— 连接 UI 按 code 分流，永不匹配 message）；
 * - `read_back_unavailable` = 读回无法完成（端口缺席/传输失败/畸形结局/秘密缺失）
 *   —— unknown ≠ expired，状态不变（fail-closed 不猜）；
 * - `custodian_unavailable` = ADR-P2-3 custodian-required 路径上托管缺席/拒绝
 *   （服务未安装/未运行/注册或推送被拒）—— 绝不静默回退 legacy 凭据存储；
 *   连接/撤销按 typed refusal 呈现，操作员处置（装服务/重连）。
 */
export type PayswapAccountRefusalCode =
  | "validation_failed"
  | "unsupported_provider"
  | "unknown_connection"
  | "read_back_unavailable"
  | typeof PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE_CODE
  | typeof PAYSWAP_ACCOUNT_CUSTODIAN_UNAVAILABLE_CODE;

/** 账户服务存储 fail-closed 拒绝码（Gate E2 常量的单一事实源再导出）。 */
export const PAYSWAP_ACCOUNT_SECURE_STORAGE_REFUSAL_CODE =
  PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE_CODE;

/** 账户服务 custodian fail-closed 拒绝码（ADR-P2-3 —— 托管缺席的 typed 词）。 */
export const PAYSWAP_ACCOUNT_CUSTODIAN_UNAVAILABLE_CODE = "custodian_unavailable" as const;

export interface PayswapAccountCustodianUnavailableError extends Error {
  code: typeof PAYSWAP_ACCOUNT_CUSTODIAN_UNAVAILABLE_CODE;
}

/** custodian 托管缺席 typed 错误（runtime 的 refusing port / custodian 桥抛出）。 */
export function createPayswapCustodianUnavailableError(
  message: string,
): PayswapAccountCustodianUnavailableError {
  return Object.assign(new Error(message), {
    code: PAYSWAP_ACCOUNT_CUSTODIAN_UNAVAILABLE_CODE,
  });
}

export function isPayswapCustodianUnavailableError(
  error: unknown,
): error is PayswapAccountCustodianUnavailableError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === PAYSWAP_ACCOUNT_CUSTODIAN_UNAVAILABLE_CODE
  );
}

export interface PayswapAccountRefusal {
  readonly code: PayswapAccountRefusalCode;
  /** 操作员可读、零凭据材料。 */
  readonly message: string;
}

/**
 * 账户服务 typed refusal 的 strict 校验器（ADR-P2-2 账户 reader 桥起，refusal 是
 * **跨进程值**—— 桥两端与一切后续消费面共用这一份校验法则；接口与 schema 共declare，
 * 漂移即违约）。
 */
export const payswapAccountRefusalSchema = z
  .object({
    code: z.enum([
      "validation_failed",
      "unsupported_provider",
      "unknown_connection",
      "read_back_unavailable",
      PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE_CODE,
      PAYSWAP_ACCOUNT_CUSTODIAN_UNAVAILABLE_CODE,
    ]),
    message: z.string().min(1),
  })
  .strict();

export type PayswapConnectResult =
  | { readonly kind: "connected"; readonly connection: PayswapConnectionStatusProjection }
  | { readonly kind: "refused"; readonly refusal: PayswapAccountRefusal };

export type PayswapRevokeResult =
  | { readonly kind: "revoked"; readonly connection: PayswapConnectionStatusProjection }
  | { readonly kind: "refused"; readonly refusal: PayswapAccountRefusal };

/**
 * refreshEvidence 的结果（doc 06 §2.2；四值）：
 * - `verified` —— provider 读回认证了凭据（携带 `providerAccountId` 证据摘要；
 *    `null` + `identityGap` = 官方 API 不暴露账户标识 —— 凭据仍被认证，恢复行
 *    同样成立）；`expired` 记录翻回 `connected`（恢复行），`connected` 保持；
 * - `expired` —— provider 拒绝了凭据（auth-failed 证据）；`connected` 翻 `expired`；
 * - `revoked` —— 终态（delete-local-only 已删秘密）：不触端口，直回投影；
 * - `refused` —— typed 拒绝（unknown_connection / 存储 fail-closed /
 *   read_back_unavailable）；状态不变。
 */
export type PayswapRefreshResult =
  | {
      readonly kind: "verified";
      readonly connection: PayswapConnectionStatusProjection;
      /** provider 签发的账户标识；null = 官方 API 不暴露（identityGap 必在场）。 */
      readonly providerAccountId: string | null;
      readonly identityGap?: PayswapAccountIdentityGap;
    }
  | { readonly kind: "expired"; readonly connection: PayswapConnectionStatusProjection }
  | { readonly kind: "revoked"; readonly connection: PayswapConnectionStatusProjection }
  | { readonly kind: "refused"; readonly refusal: PayswapAccountRefusal };

// ---------------------------------------------------------------------------
// 结果联合的 strict 校验器（P2.2 slice 7 起是跨进程值 —— 连接 RPC 通道的响应
// per-op 法则；接口与 schema 共 declare，漂移即违约 —— refusal schema 同款纪律）
// ---------------------------------------------------------------------------

export const payswapConnectResultSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("connected"),
        connection: payswapConnectionStatusProjectionSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("refused"),
        refusal: payswapAccountRefusalSchema,
      })
      .strict(),
  ] as const);

export const payswapRevokeResultSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("revoked"),
        connection: payswapConnectionStatusProjectionSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("refused"),
        refusal: payswapAccountRefusalSchema,
      })
      .strict(),
  ] as const);

export const payswapRefreshResultSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("verified"),
        connection: payswapConnectionStatusProjectionSchema,
        providerAccountId: z.string().min(1).nullable(),
        identityGap: payswapAccountIdentityGapSchema.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("expired"),
        connection: payswapConnectionStatusProjectionSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("revoked"),
        connection: payswapConnectionStatusProjectionSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("refused"),
        refusal: payswapAccountRefusalSchema,
      })
      .strict(),
  ] as const)
  .superRefine((result, ctx) => {
    if (result.kind !== "verified") return;
    // 与读回结局同一不变量：null ⇔ identityGap（RPC 是跨进程值 —— 两端同一法则）。
    const hasGap = result.identityGap !== undefined;
    if ((result.providerAccountId === null) !== hasGap) {
      ctx.addIssue({
        code: "custom",
        path: ["providerAccountId"],
        message: "a null providerAccountId and an identityGap must appear together",
      });
    }
  });
