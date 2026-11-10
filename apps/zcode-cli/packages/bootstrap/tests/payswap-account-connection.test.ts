/**
 * PaySwap P2.2 —— 账户连接法则（deliverable 05 §5 认证面 + deliverable 06 §2.2
 * 账户服务状态法则；Gate E2 落地后的第一条 P2 垂直切片「Stripe read-only vertical」
 * 的连接半）。
 *
 * 法则（normative）：
 * - **存储键模板**（doc 05 §5）：`payswap:psp:<providerId>:<connectionId>:<secretKind>`
 *   是 PSP 秘密的唯一存储键形态 —— 实例化后的键必须落在 Gate E2 的 PSP 命名空间
 *   （`payswap:psp:*`）内，从而无条件继承 §5.2 的键级加密政策（safeStorage/secret/
 *   fail-closed）。段值空或含冒号 = 编程错误，fail-closed 抛出。
 * - **连接记录**（doc 06 §2.2）：connection record 只含非秘密元数据（provider、
 *   mode test/live、display name、status、secretKinds 清单、时间戳）—— 秘密永不
 *   落在这里，只落 ICredentialService。schema `.strict()`：未知字段拒绝。
 * - **状态投影**（doc 05 §5「The renderer and the agent never receive secret
 *   values — only opaque connection status」）：投影面是连接记录的去秘密子集；
 *   投影 schema 对携带任何秘密形字段（secret/apiKey/operatorSecret）的载荷
 *   schema 级拒绝 —— 渲染层/模型侧在类型面上拿不到秘密。
 * - **读回半（slice 2）**：状态词汇补全 `expired`（doc 05 §5「expiry is
 *   projected as connection status」—— provider read-back 的 auth-failed 证据把
 *   connected 翻 expired，verified 证据翻回；revoked 终态）。provider 读回端口
 *   三值结局（verified〔携带 providerAccountId 非秘密证据摘要〕/ auth-failed /
 *   unavailable〔unknown ≠ expired，doc 05 §6.4〕）是 strict schema；畸形结局
 *   无证据 = fail-closed 拒绝，永不翻状态。
 * - **Stripe authSpec 事实**（doc 04，检索记录在案）：operator-supplied-secret、
 *   key-prefix 模式区分（sk/rk × test/live）、secretKinds 恰 ["api-key"]、
 *   revoke = delete-local-only；formatCheck 是防御性检查，最终权威是 provider
 *   read-back（后续切片）。
 * - **模式推导**：key-prefix 规格按前缀推导 test/live；无匹配前缀 → null
 *   （fail-closed，宁可拒绝不可猜）。
 * - **typed refusal 单一事实源**：账户服务对存储 fail-closed 的拒绝码逐字复用
 *   Gate E2 的 `PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE`（addendum §5.2「typed
 *   error surfaced in the connection UI」—— 连接 UI 按 code 分流，永不匹配
 *   message）。
 *
 * 两级证明的另一级（services 真实凭据库 + 真实连接记录 store 的账户服务行）住
 * `packages/services/test/payswap-account-service.test.ts`。
 *
 * 本套件是法则级：纯 shared 模块，无 IO。
 */

import {
  derivePayswapSecretKeyMode,
  isPayswapPspCredentialKey,
  mintPayswapConnectionId,
  PAYSWAP_ACCOUNT_SECURE_STORAGE_REFUSAL_CODE,
  PAYSWAP_STRIPE_AUTH_SPEC,
  payswapAccountReadBackOutcomeSchema,
  payswapConnectionRecordSchema,
  payswapConnectionStatusProjectionSchema,
  payswapPspSecretCredentialKey,
  PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE_CODE,
  projectPayswapConnectionStatus,
  type PayswapConnectionRecord,
} from "@zcode/shared/payswap";
import { describe, expect, it } from "vitest";

/** 合法记录夹具（schema 形状参考；秘密永不入记录）。 */
function validRecordFixture(): PayswapConnectionRecord {
  return {
    connectionId: "11111111-1111-4111-8111-111111111111",
    providerId: "stripe",
    mode: "test",
    displayName: "Stripe (test)",
    status: "connected",
    secretKinds: ["api-key"],
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// 存储键模板（doc 05 §5 storageKeyTemplate 的实例化法则）
// ---------------------------------------------------------------------------

describe("payswap account connection — PSP secret storage key template", () => {
  it("实例化键形如 payswap:psp:<providerId>:<connectionId>:<secretKind> 且落在 PSP 命名空间内", () => {
    const key = payswapPspSecretCredentialKey(
      "stripe",
      "11111111-1111-4111-8111-111111111111",
      "api-key",
    );
    expect(key).toBe("payswap:psp:stripe:11111111-1111-4111-8111-111111111111:api-key");
    // Gate E2 的 PSP 键级政策（§5.2）按命名空间前缀生效 —— 模板实例化即继承。
    expect(isPayswapPspCredentialKey(key)).toBe(true);
  });

  it("段值校验 fail-closed：空段 / 含冒号段 / 纯空白段一律抛出（不产出畸形键）", () => {
    expect(() => payswapPspSecretCredentialKey("", "conn-1", "api-key")).toThrow();
    expect(() => payswapPspSecretCredentialKey("stripe", "", "api-key")).toThrow();
    expect(() => payswapPspSecretCredentialKey("stripe", "conn-1", "")).toThrow();
    expect(() => payswapPspSecretCredentialKey("  ", "conn-1", "api-key")).toThrow();
    // 段内冒号会破坏模板段结构（<providerId>:<connectionId>:<secretKind> 不可再分）。
    expect(() => payswapPspSecretCredentialKey("stripe:extra", "conn-1", "api-key")).toThrow();
    expect(() => payswapPspSecretCredentialKey("stripe", "conn:1", "api-key")).toThrow();
    expect(() => payswapPspSecretCredentialKey("stripe", "conn-1", "api:key")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 连接记录 schema（doc 06 §2.2：非秘密元数据，strict）
// ---------------------------------------------------------------------------

describe("payswap account connection — connection record schema", () => {
  it("合法记录通过；未知字段拒绝（strict）", () => {
    const record = validRecordFixture();
    expect(payswapConnectionRecordSchema.parse(record)).toEqual(record);
    expect(
      payswapConnectionRecordSchema.safeParse({ ...record, apiKey: "sk_test_x" }).success,
    ).toBe(false);
    expect(
      payswapConnectionRecordSchema.safeParse({ ...record, secret: "anything" }).success,
    ).toBe(false);
    expect(payswapConnectionRecordSchema.safeParse({ ...record, extra: 1 }).success).toBe(false);
  });

  it("枚举与下界：mode/status 枚举外拒绝；secretKinds 空数组拒绝", () => {
    const record = validRecordFixture();
    expect(payswapConnectionRecordSchema.safeParse({ ...record, mode: "sandbox" }).success).toBe(
      false,
    );
    // slice 2：expired 进状态词汇（doc 05 §5「expiry is projected as connection
    // status」）—— 记录与投影都接受；词汇外（pending/unknown）仍拒绝。
    expect(payswapConnectionRecordSchema.parse({ ...record, status: "expired" }).status).toBe(
      "expired",
    );
    expect(payswapConnectionRecordSchema.safeParse({ ...record, status: "pending" }).success).toBe(
      false,
    );
    expect(
      payswapConnectionRecordSchema.safeParse({ ...record, secretKinds: [] }).success,
    ).toBe(false);
    // 空白显示名拒绝（UI 面永不出现空名连接）。
    expect(
      payswapConnectionRecordSchema.safeParse({ ...record, displayName: "   " }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 状态投影（doc 05 §5：渲染层/模型侧只见不透明状态，秘密在类型面上不可达）
// ---------------------------------------------------------------------------

describe("payswap account connection — status projection law", () => {
  it("投影是记录的去秘密子集：恰五字段，无 createdAt/updatedAt/secretKinds", () => {
    const projection = projectPayswapConnectionStatus(validRecordFixture());
    expect(projection).toEqual({
      connectionId: "11111111-1111-4111-8111-111111111111",
      providerId: "stripe",
      mode: "test",
      displayName: "Stripe (test)",
      status: "connected",
    });
    expect(Object.keys(projection).sort()).toEqual(
      ["connectionId", "displayName", "mode", "providerId", "status"].sort(),
    );
  });

  it("投影 schema 对携带秘密形字段的载荷 schema 级拒绝（渲染面不可携带秘密）", () => {
    const projection = projectPayswapConnectionStatus(validRecordFixture());
    expect(payswapConnectionStatusProjectionSchema.parse(projection)).toEqual(projection);
    for (const secretField of [
      { secret: "sk_test_redacted" },
      { apiKey: "sk_test_redacted" },
      { operatorSecret: "sk_test_redacted" },
      { secretKinds: ["api-key"] },
    ]) {
      expect(
        payswapConnectionStatusProjectionSchema.safeParse({ ...projection, ...secretField })
          .success,
      ).toBe(false);
    }
  });

  it("expired 状态进投影词汇：expired 记录投影携带 expired（投影与记录词汇同步）", () => {
    const expiredRecord = { ...validRecordFixture(), status: "expired" as const };
    const projection = projectPayswapConnectionStatus(expiredRecord);
    expect(projection.status).toBe("expired");
    expect(payswapConnectionStatusProjectionSchema.parse(projection)).toEqual(projection);
    // 词汇外状态在投影面同样拒绝。
    expect(
      payswapConnectionStatusProjectionSchema.safeParse({ ...projection, status: "pending" })
        .success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// provider 读回端口（doc 05 §5「final authority is provider read-back」+ §6.4
// unknown 结局纪律 + doc 06 §2.2 refreshEvidence；slice 2）
// ---------------------------------------------------------------------------

describe("payswap account connection — provider read-back outcome law (slice 2)", () => {
  it("三值结局 strict schema：verified/auth-failed/unavailable 通过；未知 kind 与未知字段拒绝", () => {
    expect(
      payswapAccountReadBackOutcomeSchema.parse({
        kind: "verified",
        providerAccountId: "acct_1A2b3C",
      }),
    ).toEqual({ kind: "verified", providerAccountId: "acct_1A2b3C" });
    expect(
      payswapAccountReadBackOutcomeSchema.parse({ kind: "auth-failed", detail: "invalid_api_key" }),
    ).toEqual({ kind: "auth-failed", detail: "invalid_api_key" });
    expect(
      payswapAccountReadBackOutcomeSchema.parse({ kind: "unavailable", detail: "network timeout" }),
    ).toEqual({ kind: "unavailable", detail: "network timeout" });

    // 未知 kind 拒绝（闭集）；strict：任何额外字段拒绝（秘密形字段尤其 —— 结局面
    // 永不携带秘密材料）。
    expect(payswapAccountReadBackOutcomeSchema.safeParse({ kind: "unknown" }).success).toBe(false);
    expect(
      payswapAccountReadBackOutcomeSchema.safeParse({
        kind: "verified",
        providerAccountId: "acct_1A2b3C",
        secret: "sk_test_redacted",
      }).success,
    ).toBe(false);
    expect(
      payswapAccountReadBackOutcomeSchema.safeParse({ kind: "auth-failed", detail: "x", extra: 1 })
        .success,
    ).toBe(false);
  });

  it("verified 必须携带非空 providerAccountId（证据摘要）；auth-failed/unavailable 必须携带 detail", () => {
    expect(
      payswapAccountReadBackOutcomeSchema.safeParse({ kind: "verified" }).success,
    ).toBe(false);
    expect(
      payswapAccountReadBackOutcomeSchema.safeParse({ kind: "verified", providerAccountId: "" })
        .success,
    ).toBe(false);
    expect(payswapAccountReadBackOutcomeSchema.safeParse({ kind: "auth-failed" }).success).toBe(
      false,
    );
    expect(payswapAccountReadBackOutcomeSchema.safeParse({ kind: "unavailable" }).success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Stripe authSpec 事实（doc 04 §1；证据检索日期在 doc 04 记录）
// ---------------------------------------------------------------------------

describe("payswap account connection — stripe auth spec facts", () => {
  it("operator-supplied-secret + key-prefix 模式区分 + 恰一 secretKind + delete-local-only", () => {
    expect(PAYSWAP_STRIPE_AUTH_SPEC.providerId).toBe("stripe");
    expect(PAYSWAP_STRIPE_AUTH_SPEC.acquisition.kind).toBe("operator-supplied-secret");
    expect(PAYSWAP_STRIPE_AUTH_SPEC.acquisition.modeDistinguishable).toBe("key-prefix");
    expect(PAYSWAP_STRIPE_AUTH_SPEC.secretKinds).toEqual(["api-key"]);
    expect(PAYSWAP_STRIPE_AUTH_SPEC.revoke).toBe("delete-local-only");
    // 占位符永不携带真实键材料（doc 04 §0：key examples always use placeholder forms）。
    expect(PAYSWAP_STRIPE_AUTH_SPEC.acquisition.placeholder).toBe("sk_live_<placeholder>");
  });

  it("formatCheck 是防御性模式：sk/rk × test/live 通过；publishable/whsec/畸形拒绝", () => {
    const { formatCheck } = PAYSWAP_STRIPE_AUTH_SPEC.acquisition;
    expect(formatCheck.test(`sk_test_${"a".repeat(24)}`)).toBe(true);
    expect(formatCheck.test(`rk_test_${"a".repeat(24)}`)).toBe(true);
    expect(formatCheck.test(`sk_live_${"a".repeat(24)}`)).toBe(true);
    expect(formatCheck.test(`rk_live_${"a".repeat(24)}`)).toBe(true);
    // publishable key（pk_）与 webhook secret（whsec_）不是连接秘密。
    expect(formatCheck.test(`pk_live_${"a".repeat(24)}`)).toBe(false);
    expect(formatCheck.test(`whsec_${"a".repeat(24)}`)).toBe(false);
    expect(formatCheck.test("sk_test_short")).toBe(false);
    expect(formatCheck.test("")).toBe(false);
  });

  it("模式推导：四种前缀 → test/live；无匹配前缀 → null（fail-closed）", () => {
    expect(derivePayswapSecretKeyMode(`sk_test_${"a".repeat(24)}`, PAYSWAP_STRIPE_AUTH_SPEC)).toBe(
      "test",
    );
    expect(derivePayswapSecretKeyMode(`rk_test_${"a".repeat(24)}`, PAYSWAP_STRIPE_AUTH_SPEC)).toBe(
      "test",
    );
    expect(derivePayswapSecretKeyMode(`sk_live_${"a".repeat(24)}`, PAYSWAP_STRIPE_AUTH_SPEC)).toBe(
      "live",
    );
    expect(derivePayswapSecretKeyMode(`rk_live_${"a".repeat(24)}`, PAYSWAP_STRIPE_AUTH_SPEC)).toBe(
      "live",
    );
    expect(derivePayswapSecretKeyMode(`pk_live_${"a".repeat(24)}`, PAYSWAP_STRIPE_AUTH_SPEC)).toBeNull();
    expect(derivePayswapSecretKeyMode(`whsec_${"a".repeat(24)}`, PAYSWAP_STRIPE_AUTH_SPEC)).toBeNull();
    expect(derivePayswapSecretKeyMode("garbage", PAYSWAP_STRIPE_AUTH_SPEC)).toBeNull();
    expect(derivePayswapSecretKeyMode("", PAYSWAP_STRIPE_AUTH_SPEC)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 连接 ID 铸造 + typed refusal 单一事实源
// ---------------------------------------------------------------------------

describe("payswap account connection — connection id minting and refusal single source", () => {
  it("连接 ID 是 UUID 形态且每次铸造不同", () => {
    const first = mintPayswapConnectionId();
    const second = mintPayswapConnectionId();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(second).not.toBe(first);
  });

  it("账户服务的存储 fail-closed 拒绝码逐字复用 Gate E2 常量（连接 UI 按 code 分流）", () => {
    expect(PAYSWAP_ACCOUNT_SECURE_STORAGE_REFUSAL_CODE).toBe(
      PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE_CODE,
    );
    expect(PAYSWAP_ACCOUNT_SECURE_STORAGE_REFUSAL_CODE).toBe(
      "PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE",
    );
  });
});
