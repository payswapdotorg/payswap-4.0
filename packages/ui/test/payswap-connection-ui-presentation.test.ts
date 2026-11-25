/**
 * PaySwap P2.2 slice 8 —— 连接 UI 呈现法则电池（ADR-P2-2 Decision 4 的 renderer
 * 呈现半；roadmap P2 行「platform-shell connection/onboarding UI」；Gate E2 的
 * E2E 条款「typed error surfaced in the connection UI」的 UI 消费法则）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **呈现分流按 code，永不匹配 message**：typed refusal（账户服务闭集五码）与
 *    通道失败（malformed/internal）的呈现一律按 code 分流到 i18n key —— message
 *    是操作员可读文案、不是判定输入（account-connection 法则 5「连接 UI 按 code
 *    分流，永不匹配 message」的 renderer 半）。结构性证明：呈现函数的入参类型上
 *    不接受 message。
 * 2. **响应闭集直消费**（连续性接缝法则）：连接 UI 直接消费 RPC 响应闭集 ——
 *    ok:true 的 per-op 结果联合 / ok:false 的通道码。`unauthorized_origin` 不达
 *    renderer（三检先于载荷解析，受信 renderer 恒过三检）：它**不**在键位映射表
 *    中（呈现映射对它没有专属文案 = 非预期值），运行时若出现落 generic 桶
 *    （fail-safe 呈现，不崩不吞）。
 * 3. **闭集全集性 + 单射**：拒绝码五枚、通道码两枚各映射到**互不相同**的 i18n
 *    key —— Gate E2 的存储 typed 拒绝（PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE）
 *    有自己的专属呈现位（danger tone），不与任何输入类拒绝共享文案。
 * 4. **i18n key 双语在场**：一切映射产物 + 分区静态文案 key 在 en-US 与 zh-CN
 *    两份 locale 同时在场（缺失 = 呈现层字符串裸键 —— 法则级缺陷）。
 * 5. **运行时漂移防御**：未知 code/状态/模式字符串（schema 漂移或未来词汇）→
 *    generic 桶（fail-safe 呈现）；呈现函数对任意字符串输入永不抛出。
 * 6. **状态/模式词汇**：投影行 status（connected/expired/revoked）与 mode
 *    （test/live）各有 label key + status tone（connected=positive、
 *    expired=warning、revoked=muted —— 语义可区分的视觉投影）。
 * 7. **operatorSecret 单向性（结构性）**：呈现模块的一切输入/输出形状无秘密位
 *    （notice 至多携带 refusal/通道 code 与非秘密证据摘要 providerAccountId）。
 */

import { describe, expect, it } from "vitest";
import {
  PAYSWAP_CONNECTIONS_STATIC_I18N_KEYS,
  PAYSWAP_CONNECTION_CHANNEL_ERROR_I18N_KEYS,
  PAYSWAP_CONNECTION_GENERIC_I18N_KEY,
  PAYSWAP_CONNECTION_REFUSAL_I18N_KEYS,
  payswapChannelErrorI18nKey,
  payswapConnectionModeI18nKey,
  payswapConnectionStatusI18nKey,
  payswapConnectionStatusTone,
  payswapRefusalI18nKey,
  presentPayswapConnectResponse,
  presentPayswapRefreshResponse,
  presentPayswapRevokeResponse,
} from "@/payswap/connectionUiPresentation.js";
import type { PayswapConnectionRpcResponse } from "@zcode/shared/payswap";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

const REFUSAL_CODES = [
  "validation_failed",
  "unsupported_provider",
  "unknown_connection",
  "read_back_unavailable",
  "PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE",
] as const;

const CHANNEL_CODES_AT_RENDERER = ["malformed_request", "internal_error"] as const;

function refusalResponse(code: string): PayswapConnectionRpcResponse {
  return {
    ok: true,
    op: "connect",
    result: { kind: "refused", refusal: { code, message: `operator-readable ${code}` } },
  };
}

function channelResponse(code: string): PayswapConnectionRpcResponse {
  return { ok: false, code, message: `channel ${code}` } as PayswapConnectionRpcResponse;
}

describe("P2.2 连接 UI 呈现法则 —— code 分流（法则 1/2/3）", () => {
  it("拒绝码闭集五枚各映射到互不相同的 i18n key（单射）", () => {
    const keys = REFUSAL_CODES.map((code) => payswapRefusalI18nKey(code));
    expect(new Set(keys).size).toBe(REFUSAL_CODES.length);
    for (const code of REFUSAL_CODES) {
      expect(payswapRefusalI18nKey(code)).not.toBe(PAYSWAP_CONNECTION_GENERIC_I18N_KEY);
    }
  });

  it("存储 typed 拒绝（Gate E2 条款码）有专属呈现位", () => {
    expect(PAYSWAP_CONNECTION_REFUSAL_I18N_KEYS).toHaveProperty(
      "PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE",
    );
    const key = payswapRefusalI18nKey("PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE");
    expect(key).toContain("secure_storage");
  });

  it("通道码两枚（malformed/internal）各映射到互不相同的专属 key", () => {
    const keys = CHANNEL_CODES_AT_RENDERER.map((code) => payswapChannelErrorI18nKey(code));
    expect(new Set(keys).size).toBe(CHANNEL_CODES_AT_RENDERER.length);
    for (const code of CHANNEL_CODES_AT_RENDERER) {
      expect(payswapChannelErrorI18nKey(code)).not.toBe(PAYSWAP_CONNECTION_GENERIC_I18N_KEY);
    }
    expect(Object.keys(PAYSWAP_CONNECTION_CHANNEL_ERROR_I18N_KEYS).sort()).toEqual([
      "internal_error",
      "malformed_request",
    ]);
  });

  it("unauthorized_origin 不在呈现映射表 —— 运行时出现落 generic 桶（法则 2）", () => {
    expect(
      Object.keys(PAYSWAP_CONNECTION_CHANNEL_ERROR_I18N_KEYS),
    ).not.toContain("unauthorized_origin");
    expect(payswapChannelErrorI18nKey("unauthorized_origin")).toBe(
      PAYSWAP_CONNECTION_GENERIC_I18N_KEY,
    );
  });

  it("未知 code 字符串 → generic 桶，永不抛出（法则 5）", () => {
    expect(payswapRefusalI18nKey("totally_new_future_code")).toBe(
      PAYSWAP_CONNECTION_GENERIC_I18N_KEY,
    );
    expect(payswapChannelErrorI18nKey("")).toBe(PAYSWAP_CONNECTION_GENERIC_I18N_KEY);
    expect(payswapRefusalI18nKey("constructor")).toBe(PAYSWAP_CONNECTION_GENERIC_I18N_KEY);
    expect(payswapChannelErrorI18nKey("toString")).toBe(PAYSWAP_CONNECTION_GENERIC_I18N_KEY);
  });
});

describe("P2.2 连接 UI 呈现法则 —— 响应闭集直消费（法则 2/7）", () => {
  it("connect：ok+connected → positive + 专属 key；code 不出现", () => {
    const notice = presentPayswapConnectResponse({
      ok: true,
      op: "connect",
      result: {
        kind: "connected",
        connection: {
          connectionId: "conn-1",
          providerId: "stripe",
          mode: "test",
          displayName: "Main",
          status: "connected",
        },
      },
    });
    expect(notice.tone).toBe("positive");
    expect(notice.i18nKey).toContain("connected");
    expect(notice.code).toBeUndefined();
  });

  it("connect：ok+refused 逐码 → refusal key + code 透传（E2E 断言面）", () => {
    for (const code of REFUSAL_CODES) {
      const notice = presentPayswapConnectResponse(refusalResponse(code));
      expect(notice.i18nKey).toBe(payswapRefusalI18nKey(code));
      expect(notice.code).toBe(code);
      expect(notice.tone).toBe(
        code === "PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE" ? "danger" : "warning",
      );
    }
  });

  it("connect：ok:false 逐通道码 → channel key + code 透传 + danger tone", () => {
    for (const code of CHANNEL_CODES_AT_RENDERER) {
      const notice = presentPayswapConnectResponse(channelResponse(code));
      expect(notice.i18nKey).toBe(payswapChannelErrorI18nKey(code));
      expect(notice.code).toBe(code);
      expect(notice.tone).toBe("danger");
    }
  });

  it("connect：op 不匹配（法则外值）→ generic（防御呈现）", () => {
    const mismatched = presentPayswapConnectResponse({
      ok: true,
      op: "list",
      result: [],
    });
    expect(mismatched.i18nKey).toBe(PAYSWAP_CONNECTION_GENERIC_I18N_KEY);
  });

  it("refresh：verified → positive + providerAccountId 作非秘密证据摘要", () => {
    const notice = presentPayswapRefreshResponse({
      ok: true,
      op: "refresh",
      result: {
        kind: "verified",
        connection: {
          connectionId: "conn-1",
          providerId: "stripe",
          mode: "test",
          displayName: "Main",
          status: "connected",
        },
        providerAccountId: "acct_e2e",
      },
    });
    expect(notice.tone).toBe("positive");
    expect(notice.detail).toBe("acct_e2e");
  });

  // P3（ADR-P2-1 修订 2026-11-24）：身份缺口 provider（如 Paystack —— 官方 API 不暴露
  // 账户标识）的 verified 携 providerAccountId: null + identityGap。凭据确已被 provider
  // 认证 → 仍是 positive；但没有可展示的标识 → detail 不出现（绝不渲染 "null"、绝不
  // 渲染缺口 message 当作标识）。
  it("refresh：verified with a null providerAccountId (identity-gap provider) → positive with NO detail; the literal null is never rendered", () => {
    const notice = presentPayswapRefreshResponse({
      ok: true,
      op: "refresh",
      result: {
        kind: "verified",
        connection: {
          connectionId: "conn-1",
          providerId: "paystack",
          mode: "test",
          displayName: "Paystack",
          status: "connected",
        },
        providerAccountId: null,
        identityGap: {
          code: "provider_identity_not_exposed",
          message: "The provider exposes no account identifier.",
        },
      },
    });
    expect(notice.tone).toBe("positive");
    expect(notice.i18nKey).toBe("payswap.connections.result.verified");
    expect(notice.detail).toBeUndefined();
    expect(JSON.stringify(notice)).not.toMatch(/null/);
  });

  it("refresh：expired → warning；refused 逐码 → refusal 呈现", () => {
    const expired = presentPayswapRefreshResponse({
      ok: true,
      op: "refresh",
      result: {
        kind: "expired",
        connection: {
          connectionId: "conn-1",
          providerId: "stripe",
          mode: "test",
          displayName: "Main",
          status: "expired",
        },
      },
    });
    expect(expired.tone).toBe("warning");

    for (const code of REFUSAL_CODES) {
      const notice = presentPayswapRefreshResponse({
        ok: true,
        op: "refresh",
        result: {
          kind: "refused",
          refusal: { code, message: `operator-readable ${code}` },
        },
      });
      expect(notice.i18nKey).toBe(payswapRefusalI18nKey(code));
      expect(notice.code).toBe(code);
    }
  });

  it("revoke：revoked → muted + 专属 key；refused 逐码 → refusal 呈现", () => {
    const revoked = presentPayswapRevokeResponse({
      ok: true,
      op: "revoke",
      result: {
        kind: "revoked",
        connection: {
          connectionId: "conn-1",
          providerId: "stripe",
          mode: "test",
          displayName: "Main",
          status: "revoked",
        },
      },
    });
    expect(revoked.tone).toBe("muted");
    expect(revoked.i18nKey).toContain("revoked");

    for (const code of REFUSAL_CODES) {
      const notice = presentPayswapRevokeResponse({
        ok: true,
        op: "revoke",
        result: {
          kind: "refused",
          refusal: { code, message: `operator-readable ${code}` },
        },
      });
      expect(notice.i18nKey).toBe(payswapRefusalI18nKey(code));
      expect(notice.code).toBe(code);
    }
  });

  it("presenters 对 ok:false 一律按通道码呈现（三 op 同律）", () => {
    for (const presenter of [
      presentPayswapConnectResponse,
      presentPayswapRefreshResponse,
      presentPayswapRevokeResponse,
    ]) {
      const notice = presenter(channelResponse("internal_error"));
      expect(notice.i18nKey).toBe(payswapChannelErrorI18nKey("internal_error"));
      expect(notice.tone).toBe("danger");
    }
  });
});

describe("P2.2 连接 UI 呈现法则 —— 状态/模式词汇（法则 6）", () => {
  it("status 三词汇各有 label key 与可区分 tone", () => {
    expect(payswapConnectionStatusTone("connected")).toBe("positive");
    expect(payswapConnectionStatusTone("expired")).toBe("warning");
    expect(payswapConnectionStatusTone("revoked")).toBe("muted");
    const keys = ["connected", "expired", "revoked"].map((status) =>
      payswapConnectionStatusI18nKey(status),
    );
    expect(new Set(keys).size).toBe(3);
  });

  it("mode 两词汇各有 label key；未知词汇 fail-safe（法则 5）", () => {
    expect(payswapConnectionModeI18nKey("test")).not.toBe(
      payswapConnectionModeI18nKey("live"),
    );
    expect(payswapConnectionStatusI18nKey("future_status")).toContain("unknown");
    expect(payswapConnectionModeI18nKey("future_mode")).toContain("unknown");
  });
});

describe("P2.2 连接 UI 呈现法则 —— i18n 双语在场（法则 4）", () => {
  const allMappedKeys = [
    ...Object.values(PAYSWAP_CONNECTION_REFUSAL_I18N_KEYS),
    ...Object.values(PAYSWAP_CONNECTION_CHANNEL_ERROR_I18N_KEYS),
    PAYSWAP_CONNECTION_GENERIC_I18N_KEY,
    payswapConnectionStatusI18nKey("connected"),
    payswapConnectionStatusI18nKey("expired"),
    payswapConnectionStatusI18nKey("revoked"),
    payswapConnectionStatusI18nKey("unknown-fallback"),
    payswapConnectionModeI18nKey("test"),
    payswapConnectionModeI18nKey("live"),
    payswapConnectionModeI18nKey("unknown-fallback"),
    ...PAYSWAP_CONNECTIONS_STATIC_I18N_KEYS,
  ];

  it.each([
    ["en-US", enUS],
    ["zh-CN", zhCN],
  ] as const)("一切呈现/静态 key 在 %s 在场", (_locale, messages) => {
    for (const key of allMappedKeys) {
      expect(messages, `locale 缺 key: ${key}`).toHaveProperty(key);
      expect(
        typeof (messages as Record<string, string>)[key],
        `locale key 非字符串: ${key}`,
      ).toBe("string");
    }
  });

  it("静态 key 清单无重复", () => {
    expect(new Set(PAYSWAP_CONNECTIONS_STATIC_I18N_KEYS).size).toBe(
      PAYSWAP_CONNECTIONS_STATIC_I18N_KEYS.length,
    );
  });
});
