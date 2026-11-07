/**
 * PaySwap 插件 bridge 接线（契约 w2-01 §0 迁移、§6.2、§7.1；ADR-9 D9.7 + ADR-10）。
 *
 * 职责：
 * - `armPayswapBridgeFromEnv`：读受信注入的五键组（§4.2/§4.4(1) all-or-nothing），
 *   齐且合法 → 以共享模块的 bridge client 武装；否则 null（Wave-1 快照拒绝路径照旧）。
 * - `sessionHintFromRequestMeta`：会话 hint **只**取 host client 写入的命名空间
 *   `com.zcode/request-context` 的 `session_id`（node_repl 同款安全边界：顶层 `_meta`
 *   是第三方可扩展字段，不得成为会话路由凭据）；hint 只是路由提示，会话由 broker
 *   权威解析（§8.1 resolved-not-asserted）。
 * - `payswapBridgeResultEnvelopeText`：bridge 调用结果 → 工具信封文本。已验签的成功体
 *   → `data` 即业务信封（§6.2）；已验签的 §6.3 桥接错误与 child 侧 typed 失败 →
 *   `kind:"bridge_failure"`（与三码业务拒绝 `kind:"refused"` 永不混淆，§6.2）。
 */

import {
  createPayswapBridgeClient,
  readPayswapBrokerCredentialTupleFromEnv,
  type PayswapBridgeCallResult,
  type PayswapBridgeClient,
  type PayswapBrokerOp,
} from "@zcode/shared/payswap";

/** host client 写入 MCP `_meta` 的请求上下文命名空间（adapters/mcp mcpRequestMeta 同键）。 */
export const REQUEST_CONTEXT_META_KEY = "com.zcode/request-context";

/**
 * 从工具调用的 `_meta` 提取会话 hint：只认 host 命名空间内的字符串 `session_id`
 * （trim 后非空）；顶层键、缺失、非字符串、空白 → null（fail-closed）。
 */
export function sessionHintFromRequestMeta(meta: unknown): string | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const namespaced = (meta as Record<string, unknown>)[REQUEST_CONTEXT_META_KEY];
  if (typeof namespaced !== "object" || namespaced === null || Array.isArray(namespaced)) return null;
  const sessionId = (namespaced as Record<string, unknown>).session_id;
  if (typeof sessionId !== "string") return null;
  const trimmed = sessionId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** `_meta` 命名空间内的 shipped trace 三元组 → §6.1 `trace`（无 trace_id → undefined）。 */
export function traceFromRequestMeta(
  meta: unknown,
): { traceId: string; spanId?: string; parentSpanId?: string } | undefined {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  const namespaced = (meta as Record<string, unknown>)[REQUEST_CONTEXT_META_KEY];
  if (typeof namespaced !== "object" || namespaced === null || Array.isArray(namespaced)) return undefined;
  const record = namespaced as Record<string, unknown>;
  const traceId = typeof record.trace_id === "string" ? record.trace_id.trim() : "";
  if (traceId.length === 0) return undefined;
  const spanId = typeof record.span_id === "string" && record.span_id.trim().length > 0 ? record.span_id.trim() : undefined;
  const parentSpanId =
    typeof record.parent_span_id === "string" && record.parent_span_id.trim().length > 0
      ? record.parent_span_id.trim()
      : undefined;
  return { traceId, ...(spanId !== undefined ? { spanId } : {}), ...(parentSpanId !== undefined ? { parentSpanId } : {}) };
}

/**
 * 读 env 中的五键组并武装 bridge（§4.4(1)：五键齐全且逐键合法才有效；半组/全缺 → null，
 * 子进程走 Wave-1 fail-closed 无凭据路径）。
 */
export function armPayswapBridgeFromEnv(env: NodeJS.ProcessEnv): PayswapBridgeClient | null {
  const tuple = readPayswapBrokerCredentialTupleFromEnv(env);
  if (tuple === null) return null;
  return createPayswapBridgeClient({ tuple });
}

/** 工具名 → 操作名（§7.1 闭集 1:1：`payswap_<op>`）。 */
export function toolToOp(toolName: string): PayswapBrokerOp {
  const op = toolName.replace(/^payswap_/, "") as PayswapBrokerOp;
  return op;
}

/**
 * bridge 调用结果 → 工具信封文本（§6.2）：
 * - 已验签成功体：`data` 即工具信封（业务拒绝/将来的 ok 数据），原样序列化；
 * - 已验签 §6.3 桥接错误：`kind:"bridge_failure"`，failure = broker 的 typed 错误三元组；
 * - child 侧 typed 失败（含 §6.5(3) 整封拒绝）：`kind:"bridge_failure"`，failure =
 *   client 的 typed 码（被拒响应的字段一个都不外露）。
 */
export function payswapBridgeResultEnvelopeText(result: PayswapBridgeCallResult): string {
  if (result.kind === "answered") {
    if (result.body.ok) {
      return JSON.stringify(result.body.data);
    }
    return JSON.stringify({ kind: "bridge_failure", failure: result.body.error });
  }
  return JSON.stringify({
    kind: "bridge_failure",
    failure: { code: result.code, message: result.message, retryable: result.retryable },
  });
}
