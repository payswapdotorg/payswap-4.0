/**
 * PaySwap 批准 origin 法则（addendum §1.6.2 items 3–4 —— 受信 renderer origin 与
 * 批准事件判别；N13/N16/N26/N17；playbook P1.7）。
 *
 * 法则（normative）：
 * - **三检**（§1.6.2 item 3，desktop）：批准事件必须过三道检查，任何一道失败即
 *   拒绝且无 grant（N13 扩展到 frame 与 origin 失败）：
 *   1. expected webContents —— `event.sender.id` === 签发 challenge 时记录的
 *      webContents id（上游先例 webRemoteControlRendererReconnect.ts:33-36）；
 *   2. expected main frame —— `event.senderFrame === event.sender.mainFrame`
 *      （上游先例 browser-local-preview 的 navigation owner 检查）；
 *   3. trusted application origin —— 发送 frame 的 URL 必须是应用 shell 自己的
 *      受信 origin。**显式拒绝**：任何插件沙箱 origin（`zcode-sandbox://`）、任何
 *      `ui://` 资源 origin、任何远端/未知 origin。该组合是 PaySwap 新要求。
 * - **fail-closed 默认**：trusted origin 集未配置（空）→ 每个 desktop frame 都
 *   拒绝（P1.7 部署必须显式配置；desktop 装配在 P1.8 接线时供给真实值）。
 * - **operator_connection 发送者**：server 部署的批准事件骑在已认证 operator
 *   客户端的通道上 —— 传输层法则（两级握手、撤销/过期、principal 绑定）由 P1.6
 *   的 handshake/registry 法则拥有并在其边界套件证明；本层恒接受（结构上无第二
 *   个可到达的传输）。
 * - **事件判别**（§1.6.2 item 4）：只有批准通道的类型化事件形状
 *   {proposalId, challengeId, challengeSecret, decision: approve|deny}（strict）是
 *   批准事件。plugin-UI 回调路径（`mcp/uiCallTool` 形状 —— 上游 params 携
 *   toolName/callId + pluginScope 字段）与 `ui://` 交互**不是**批准事件
 *   （N26）；模型文本（任何其它字符串）不是事件（N17）；其余对象 = malformed。
 *   不存在从这些形状到 grant 的代码路径。
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// 发送者描述（renderer 无关 —— Electron IPC 装配在 P1.8 把真实事件映射到此面）
// ---------------------------------------------------------------------------

export interface PayswapDesktopFrameSender {
  kind: "desktop_frame";
  webContentsId: number;
  isMainFrame: boolean;
  frameUrl: string;
}

export interface PayswapOperatorConnectionSender {
  kind: "operator_connection";
  sessionId: string;
}

export type PayswapApprovalSender = PayswapDesktopFrameSender | PayswapOperatorConnectionSender;

export type PayswapApprovalSenderVerdict =
  | { status: "accepted" }
  | {
      status: "rejected";
      reason: "sender_mismatch" | "subframe_event" | "untrusted_origin";
      origin?: string;
    };

/** 插件沙箱 origin（zcode-sandbox://plugin-<appIdentity>/… —— 永不受信）。 */
export function isPayswapPluginSandboxUrl(url: string): boolean {
  return url.startsWith("zcode-sandbox://");
}

/** 插件 UI 资源 origin（ui://… —— 永不受信）。 */
export function isPayswapPluginUiResourceUrl(url: string): boolean {
  return url.startsWith("ui://");
}

function originOf(url: string): string {
  const separator = url.indexOf("://");
  if (separator <= 0) return url;
  const rest = url.slice(separator + 3);
  const pathSeparator = rest.indexOf("/");
  return pathSeparator === -1 ? url : url.slice(0, separator + 3 + pathSeparator);
}

/**
 * frame URL → origin（scheme://host[:port] 前缀域；无路径分隔符时整个 URL）。单一实现 ——
 * 法则三检的第 3 检与 D12.7 接线的生产受信 origin 派生共用（字节一致才可比）。
 */
export function payswapFrameOriginOf(url: string): string {
  return originOf(url);
}

function normalizeTrustedOrigins(
  origins: ReadonlySet<string> | readonly string[],
): ReadonlySet<string> {
  return origins instanceof Set ? origins : new Set(origins);
}

/**
 * 三检法则（纯）。trustedAppOrigins 匹配的是 origin（scheme://host[:port] 前缀域）
 * —— 显式配置值；空集 = fail-closed（全部拒绝）。
 */
export function evaluatePayswapApprovalSender(input: {
  sender: PayswapApprovalSender;
  expectedWebContentsId?: number;
  trustedAppOrigins: ReadonlySet<string> | readonly string[];
}): PayswapApprovalSenderVerdict {
  const { sender } = input;
  if (sender.kind === "operator_connection") {
    // 传输层法则由 P1.6 两级握手拥有（server 边界套件证明）—— 本层恒接受。
    return { status: "accepted" };
  }
  if (input.expectedWebContentsId !== undefined && sender.webContentsId !== input.expectedWebContentsId) {
    return { status: "rejected", reason: "sender_mismatch" };
  }
  if (!sender.isMainFrame) {
    return { status: "rejected", reason: "subframe_event" };
  }
  const trusted = normalizeTrustedOrigins(input.trustedAppOrigins);
  const origin = originOf(sender.frameUrl);
  if (
    isPayswapPluginSandboxUrl(sender.frameUrl) ||
    isPayswapPluginUiResourceUrl(sender.frameUrl) ||
    !trusted.has(origin)
  ) {
    return { status: "rejected", reason: "untrusted_origin", origin };
  }
  return { status: "accepted" };
}

// ---------------------------------------------------------------------------
// 批准事件形状与判别（N26/N17）
// ---------------------------------------------------------------------------

/** 批准通道的唯一事件形状（strict —— 无 tuple 位：不存在呈现 tuple 的字段）。 */
export const payswapApprovalResolutionEventSchema = z
  .object({
    proposalId: z.string().min(1),
    challengeId: z.string().min(1),
    challengeSecret: z.string().min(1),
    decision: z.enum(["approve", "deny"]),
  })
  .strict();

export type PayswapApprovalResolutionEvent = z.infer<typeof payswapApprovalResolutionEventSchema>;

export type PayswapApprovalEventClassification =
  | { kind: "approval_event"; event: PayswapApprovalResolutionEvent }
  | {
      kind: "not_an_approval_event";
      reason: "plugin_callback_path" | "model_text" | "malformed_event";
    };

/** mcp/uiCallTool 回调的判别标记（上游 params：toolName/callId + pluginScope 字段）。 */
const PLUGIN_CALLBACK_MARKERS = ["toolName", "callId", "appIdentity", "surfaceId"] as const;

function hasPluginCallbackMarker(value: Record<string, unknown>): boolean {
  return PLUGIN_CALLBACK_MARKERS.some((marker) => typeof value[marker] === "string");
}

/**
 * 事件判别法则（纯）：批准事件 / plugin 回调路径 / 模型文本 / malformed。
 * 只有第一种进入批准流 —— 其余形状不存在到 grant 的路径（N26/N17）。
 */
export function classifyPayswapApprovalEventInput(input: unknown): PayswapApprovalEventClassification {
  if (typeof input === "string") {
    // ui:// 交互字符串走插件回调路径；其余字符串 = 模型文本（N17）。
    return isPayswapPluginUiResourceUrl(input)
      ? { kind: "not_an_approval_event", reason: "plugin_callback_path" }
      : { kind: "not_an_approval_event", reason: "model_text" };
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { kind: "not_an_approval_event", reason: "malformed_event" };
  }
  const record = input as Record<string, unknown>;
  if (hasPluginCallbackMarker(record)) {
    return { kind: "not_an_approval_event", reason: "plugin_callback_path" };
  }
  const parsed = payswapApprovalResolutionEventSchema.safeParse(record);
  if (!parsed.success) {
    return { kind: "not_an_approval_event", reason: "malformed_event" };
  }
  return { kind: "approval_event", event: parsed.data };
}
