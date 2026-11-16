/**
 * PaySwap P2.2 slice 8 —— 连接 UI 呈现法则（ADR-P2-2 Decision 4 的 renderer 呈现半；
 * roadmap P2 行「platform-shell connection/onboarding UI」；Gate E2 的 E2E 条款
 * 「typed error surfaced in the connection UI」的 UI 消费法则）。
 *
 * 法则（normative；违反即实现缺陷；电池 =
 * packages/ui/test/payswap-connection-ui-presentation.test.ts）：
 * 1. **呈现分流按 code，永不匹配 message**：typed refusal 与通道失败的呈现一律按
 *    code 分流到 i18n key —— message 是操作员可读文案、不是判定输入
 *    （account-connection 法则 5「连接 UI 按 code 分流，永不匹配 message」）。
 *    结构性证明：本模块一切函数的入参类型上不接受 message。
 * 2. **响应闭集直消费**（连续性接缝法则）：呈现直接消费 RPC 响应闭集 —— ok:true
 *    的 per-op 结果联合 / ok:false 的通道码。`unauthorized_origin` 不达 renderer
 *    （三检先于载荷解析，受信 renderer 恒过三检）：它不进键位映射表，运行时若
 *    出现落 generic 桶（fail-safe 呈现，不崩不吞）。
 * 3. **闭集全集性 + 单射**：拒绝码五枚（Record 类型面 = 全集性，缺码即 typecheck
 *    失败）、通道码两枚各映射到互不相同的 i18n key；Gate E2 的存储 typed 拒绝
 *    （PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE）有专属呈现位（danger tone）。
 * 4. **i18n key 双语在场**：映射产物 + 分区静态 key 在 en-US 与 zh-CN 同时在场
 *    （电池逐 key 断言；缺失 = 裸键呈现，法则级缺陷）。
 * 5. **运行时漂移防御**：未知字符串（schema 漂移/未来词汇/原型名）→ generic 桶；
 *    一切查找用 Object.prototype.hasOwnProperty，呈现函数永不抛出。
 * 6. **无 Electron/无秘密位**：类型经 type-only 导入自 shared-payswap 桶
 *    （编译期擦除 —— 桶内 node:crypto 模块不进浏览器 chunk，与授权卡的
 *    `import type { PayswapDesktopCardEvent }` 同款纪律）；notice 至多携带
 *    code（refusal/通道码，E2E 断言面）与非秘密证据摘要（providerAccountId）。
 */

import type {
  PayswapAccountRefusalCode,
  PayswapConnectionRpcResponse,
} from "@zcode/shared/payswap";

/** 呈现横幅的语气（视觉投影 —— 与状态徽章 tone 同词汇域）。 */
export type PayswapConnectionNoticeTone = "positive" | "warning" | "danger" | "muted";

/** 连接操作的呈现横幅（i18n key + tone + 可选 code/非秘密证据摘要）。 */
export interface PayswapConnectionNotice {
  readonly i18nKey: string;
  readonly tone: PayswapConnectionNoticeTone;
  /** 拒绝码/通道码（E2E 的 data 断言面；ok 类结果无 code）。 */
  readonly code?: string;
  /** 非秘密证据摘要（refresh verified 的 providerAccountId）。 */
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// i18n key 映射（法则 1/3）
// ---------------------------------------------------------------------------

/** typed refusal 闭集五码 → 专属 i18n key（Record 全集性 = typecheck 证明）。 */
export const PAYSWAP_CONNECTION_REFUSAL_I18N_KEYS: Readonly<
  Record<PayswapAccountRefusalCode, string>
> = {
  validation_failed: "payswap.connections.refusal.validation_failed",
  unsupported_provider: "payswap.connections.refusal.unsupported_provider",
  unknown_connection: "payswap.connections.refusal.unknown_connection",
  read_back_unavailable: "payswap.connections.refusal.read_back_unavailable",
  PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE:
    "payswap.connections.refusal.secure_storage_unavailable",
};

/**
 * 通道失败码 → 专属 i18n key。恰 malformed_request/internal_error 两枚 ——
 * `unauthorized_origin` 不达 renderer（法则 2），不在此表（运行时出现落 generic）。
 */
export const PAYSWAP_CONNECTION_CHANNEL_ERROR_I18N_KEYS: Readonly<
  Record<"malformed_request" | "internal_error", string>
> = {
  malformed_request: "payswap.connections.channel_error.malformed_request",
  internal_error: "payswap.connections.channel_error.internal_error",
};

/** generic 呈现桶（未知码/op 不匹配/未来词汇 —— fail-safe，永不裸键）。 */
export const PAYSWAP_CONNECTION_GENERIC_I18N_KEY = "payswap.connections.result.unexpected";

function lookupKey(map: Readonly<Record<string, string>>, code: string): string | null {
  // 法则 5：hasOwnProperty 查找（原型名/未知串永不命中），永不抛出。
  if (!Object.prototype.hasOwnProperty.call(map, code)) return null;
  return map[code] ?? null;
}

/** 拒绝码 → i18n key（未知串 → generic 桶）。 */
export function payswapRefusalI18nKey(code: string): string {
  return lookupKey(PAYSWAP_CONNECTION_REFUSAL_I18N_KEYS, code) ?? PAYSWAP_CONNECTION_GENERIC_I18N_KEY;
}

/** 通道码 → i18n key（unauthorized_origin/未知串 → generic 桶）。 */
export function payswapChannelErrorI18nKey(code: string): string {
  return (
    lookupKey(PAYSWAP_CONNECTION_CHANNEL_ERROR_I18N_KEYS, code) ??
    PAYSWAP_CONNECTION_GENERIC_I18N_KEY
  );
}

// ---------------------------------------------------------------------------
// 状态/模式词汇（法则 6）
// ---------------------------------------------------------------------------

/** 投影行 status 徽章 tone（connected=positive、expired=warning、revoked=muted）。 */
export function payswapConnectionStatusTone(status: string): "positive" | "warning" | "muted" {
  if (status === "connected") return "positive";
  if (status === "expired") return "warning";
  return "muted";
}

/** 投影行 status → label key（未知词汇 → unknown fail-safe）。 */
export function payswapConnectionStatusI18nKey(status: string): string {
  if (status === "connected") return "payswap.connections.status.connected";
  if (status === "expired") return "payswap.connections.status.expired";
  if (status === "revoked") return "payswap.connections.status.revoked";
  return "payswap.connections.status.unknown";
}

/** 投影行 mode → label key（未知词汇 → unknown fail-safe）。 */
export function payswapConnectionModeI18nKey(mode: string): string {
  if (mode === "test") return "payswap.connections.mode.test";
  if (mode === "live") return "payswap.connections.mode.live";
  return "payswap.connections.mode.unknown";
}

// ---------------------------------------------------------------------------
// 响应闭集呈现（法则 2/3/7）
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function refusalNotice(refusal: unknown): PayswapConnectionNotice {
  // 拒绝值的闭集校验在 main 侧 per-op 法则（防御纵深）；这里只做呈现面的最小防御。
  const code = isRecord(refusal) && typeof refusal.code === "string" ? refusal.code : "";
  return {
    i18nKey: payswapRefusalI18nKey(code),
    tone: code === "PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE" ? "danger" : "warning",
    code,
  };
}

function channelNotice(code: string): PayswapConnectionNotice {
  return { i18nKey: payswapChannelErrorI18nKey(code), tone: "danger", code };
}

function genericNotice(): PayswapConnectionNotice {
  return { i18nKey: PAYSWAP_CONNECTION_GENERIC_I18N_KEY, tone: "danger" };
}

/** connect 响应的呈现（ok+connected / ok+refused / ok:false 通道码 / 其它 generic）。 */
export function presentPayswapConnectResponse(
  response: PayswapConnectionRpcResponse,
): PayswapConnectionNotice {
  if (!response.ok) return channelNotice(response.code);
  if (response.op !== "connect" || !isRecord(response.result)) return genericNotice();
  const result = response.result;
  if (result.kind === "connected") {
    return { i18nKey: "payswap.connections.result.connected", tone: "positive" };
  }
  if (result.kind === "refused") {
    return refusalNotice(result.refusal);
  }
  return genericNotice();
}

/** refresh 响应的呈现（verified〔providerAccountId 证据摘要〕/expired/refused/通道）。 */
export function presentPayswapRefreshResponse(
  response: PayswapConnectionRpcResponse,
): PayswapConnectionNotice {
  if (!response.ok) return channelNotice(response.code);
  if (response.op !== "refresh" || !isRecord(response.result)) return genericNotice();
  const result = response.result;
  if (result.kind === "verified") {
    return {
      i18nKey: "payswap.connections.result.verified",
      tone: "positive",
      detail: typeof result.providerAccountId === "string" ? result.providerAccountId : undefined,
    };
  }
  if (result.kind === "expired") {
    return { i18nKey: "payswap.connections.result.expired", tone: "warning" };
  }
  if (result.kind === "revoked") {
    return { i18nKey: "payswap.connections.result.revoked", tone: "muted" };
  }
  if (result.kind === "refused") {
    return refusalNotice(result.refusal);
  }
  return genericNotice();
}

/** revoke 响应的呈现（revoked/refused/通道）。 */
export function presentPayswapRevokeResponse(
  response: PayswapConnectionRpcResponse,
): PayswapConnectionNotice {
  if (!response.ok) return channelNotice(response.code);
  if (response.op !== "revoke" || !isRecord(response.result)) return genericNotice();
  const result = response.result;
  if (result.kind === "revoked") {
    return { i18nKey: "payswap.connections.result.revoked", tone: "muted" };
  }
  if (result.kind === "refused") {
    return refusalNotice(result.refusal);
  }
  return genericNotice();
}

// ---------------------------------------------------------------------------
// 分区静态文案 key 清单（法则 4 的电池断言面 —— 与组件字面 key 单一来源）
// ---------------------------------------------------------------------------

export const PAYSWAP_CONNECTIONS_STATIC_I18N_KEYS: readonly string[] = [
  "settings.payswap.title",
  "payswap.connections.description",
  "payswap.connections.unavailable",
  "payswap.connections.providerLabel",
  "payswap.connections.provider.stripe",
  "payswap.connections.provider.paypal",
  "payswap.connections.secretLabel",
  "payswap.connections.secretPlaceholder",
  "payswap.connections.secretHint",
  "payswap.connections.modeLabel",
  "payswap.connections.clientIdLabel",
  "payswap.connections.clientIdPlaceholder",
  "payswap.connections.clientSecretLabel",
  "payswap.connections.clientSecretPlaceholder",
  "payswap.connections.clientSecretHint",
  "payswap.connections.displayNameLabel",
  "payswap.connections.displayNamePlaceholder",
  "payswap.connections.connect",
  "payswap.connections.connecting",
  "payswap.connections.listTitle",
  "payswap.connections.listLoading",
  "payswap.connections.listEmpty",
  "payswap.connections.columnName",
  "payswap.connections.columnProvider",
  "payswap.connections.columnMode",
  "payswap.connections.columnStatus",
  "payswap.connections.columnActions",
  "payswap.connections.actionRefresh",
  "payswap.connections.actionRevoke",
];
