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
 * authSpec 的 P2 形态（operator-supplied-secret）。oauth-authorization-code 与
 * client-credentials 形态随 P3 的 provider 评估落地 —— 不提前发明 URL/scope 事实。
 */
export type PayswapAuthSpec = PayswapOperatorSecretAuthSpec;

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
      .strict(),
  })
  .strict();
export type PayswapAccountCapabilityEvidence = z.infer<
  typeof payswapAccountCapabilityEvidenceSchema
>;

/**
 * 读回结局（strict 闭集）：
 * - `verified` —— provider 认证了凭据并返回账户读回（`providerAccountId` 是
 *   非秘密证据摘要，如 Stripe 的 `acct_*`；`evidence` 是能力证据摘要 ——
 *   doc 04 §1.2 capabilities/requirements 读回，ADR-P2-1 起可选携带，概览
 *   detail 面要求其在场）；
 * - `auth-failed` —— provider 拒绝了凭据（**唯一的 expiry 证据**）；
 * - `unavailable` —— 网络/未知结局（**不是** expiry 证据 —— doc 05 §6.4 的
 *   unknown 纪律：读回失败永不假装成功，也永不假装 auth 失败）。
 */
export type PayswapAccountReadBackOutcome =
  | {
      readonly kind: "verified";
      readonly providerAccountId: string;
      /** 能力证据（doc 04 §1.2；可选 —— 未携带时概览 detail 面 fail-closed 拒绝）。 */
      readonly evidence?: PayswapAccountCapabilityEvidence;
    }
  | { readonly kind: "auth-failed"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string };

/** 结局面 strict 闭集（畸形结局无证据 —— 服务侧 fail-closed 拒绝，永不翻状态）。 */
export const payswapAccountReadBackOutcomeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("verified"),
      providerAccountId: z.string().min(1),
      evidence: payswapAccountCapabilityEvidenceSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("auth-failed"), detail: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("unavailable"), detail: z.string().min(1) }).strict(),
]);

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
 *   —— unknown ≠ expired，状态不变（fail-closed 不猜）。
 */
export type PayswapAccountRefusalCode =
  | "validation_failed"
  | "unsupported_provider"
  | "unknown_connection"
  | "read_back_unavailable"
  | typeof PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE_CODE;

/** 账户服务存储 fail-closed 拒绝码（Gate E2 常量的单一事实源再导出）。 */
export const PAYSWAP_ACCOUNT_SECURE_STORAGE_REFUSAL_CODE =
  PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE_CODE;

export interface PayswapAccountRefusal {
  readonly code: PayswapAccountRefusalCode;
  /** 操作员可读、零凭据材料。 */
  readonly message: string;
}

export type PayswapConnectResult =
  | { readonly kind: "connected"; readonly connection: PayswapConnectionStatusProjection }
  | { readonly kind: "refused"; readonly refusal: PayswapAccountRefusal };

export type PayswapRevokeResult =
  | { readonly kind: "revoked"; readonly connection: PayswapConnectionStatusProjection }
  | { readonly kind: "refused"; readonly refusal: PayswapAccountRefusal };

/**
 * refreshEvidence 的结果（doc 06 §2.2；四值）：
 * - `verified` —— provider 读回认证了凭据（携带 `providerAccountId` 证据摘要）；
 *    `expired` 记录翻回 `connected`（恢复行），`connected` 保持；
 * - `expired` —— provider 拒绝了凭据（auth-failed 证据）；`connected` 翻 `expired`；
 * - `revoked` —— 终态（delete-local-only 已删秘密）：不触端口，直回投影；
 * - `refused` —— typed 拒绝（unknown_connection / 存储 fail-closed /
 *   read_back_unavailable）；状态不变。
 */
export type PayswapRefreshResult =
  | {
      readonly kind: "verified";
      readonly connection: PayswapConnectionStatusProjection;
      readonly providerAccountId: string;
    }
  | { readonly kind: "expired"; readonly connection: PayswapConnectionStatusProjection }
  | { readonly kind: "revoked"; readonly connection: PayswapConnectionStatusProjection }
  | { readonly kind: "refused"; readonly refusal: PayswapAccountRefusal };
