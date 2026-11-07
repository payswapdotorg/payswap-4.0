import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  PANEL_MIME_TYPE,
  SURFACES,
  TOOL_NAMES,
  envelopeText,
  readFinancialWorkspaceSnapshot,
  snapshotRefusal,
  type PayswapToolEnvelope,
  type PayswapToolName,
} from "./contract.ts";
import {
  armPayswapBridgeFromEnv,
  payswapBridgeResultEnvelopeText,
  sessionHintFromRequestMeta,
  toolToOp,
  traceFromRequestMeta,
} from "./bridge.ts";
import { renderPanelHtml } from "./panels.ts";

/**
 * PaySwap MCP server（Wave 2 Step 7：五键组在 env → 经认证 broker 桥的 thin proxy）。
 *
 * - 六个 `payswap_*` 工具全部注册（模型可见、`readOnlyHint`、无 `alwaysLoad` —— S1 的
 *   upstream 默认 deferral 语义，附录 §2 表格 S1 行）。
 * - 三个 Class A `ui://` 面板资源（信息性；authorization 卡是 Class B，由 host 渲染——
 *   本 server 永不提供授权内容，N25）。
 * - **bridge 模式（§0 迁移）**：受信注入的五键组在 env 时，工具经 bridge 调 broker
 *   （op 1:1、params 原样、会话 hint 取 host 命名空间 `_meta`）；broker 的 live 三码
 *   法则回答成为工具结果。无五键组（S0b/S1/第三方直连）→ Wave-1 env 快照拒绝照旧
 *   （merged PR #3 的表面不变，保存纪律）。
 * - bridge 失败（§6.3 桥接码 + child 侧 typed 码）以 `kind:"bridge_failure"` 面呈，
 *   永不与三码业务拒绝混淆（§6.2）；stderr 日志只带 tool 名与 typed 码，零凭据材料（§11）。
 */

const REFUSAL_NOTE =
  "Answers come from the authenticated host broker when the financial workspace is armed; otherwise a typed refusal is returned.";

export interface PayswapServerOptions {
  env?: NodeJS.ProcessEnv;
}

/** registerTool 回调的 extra 面（SDK RequestHandlerExtra 的最小投影）。 */
interface ToolCallExtra {
  signal?: AbortSignal;
  _meta?: unknown;
}

export function createPayswapServer(options: PayswapServerOptions = {}): McpServer {
  const server = new McpServer({ name: "payswap", version: "0.1.0" });
  const env = options.env ?? process.env;
  const financialWorkspace = readFinancialWorkspaceSnapshot(env);
  const refusal = snapshotRefusal(financialWorkspace);
  // Wave-2 §0 迁移：五键组在 env → bridge 武装；否则 Wave-1 快照拒绝臂照旧。
  const bridge = armPayswapBridgeFromEnv(env);

  const refusalResult = (tool: string) => {
    const envelope: PayswapToolEnvelope = { kind: "refused", refusal: { ...refusal } };
    process.stderr.write(`[payswap] ${tool}: refused ${refusal.code}\n`);
    return { content: [{ type: "text" as const, text: envelopeText(envelope) }] };
  };

  /** bridge 模式的统一工具面：op 1:1、hint/trace 取命名空间 `_meta`、结果信封化。 */
  const bridgedResult = async (tool: PayswapToolName, args: unknown, extra: ToolCallExtra) => {
    const trace = traceFromRequestMeta(extra._meta);
    const result = await bridge!.callOp(toolToOp(tool), (args ?? {}) as Record<string, unknown>, sessionHintFromRequestMeta(extra._meta), {
      ...(extra.signal ? { signal: extra.signal } : {}),
      ...(trace !== undefined ? { trace } : {}),
    });
    // §11 日志纪律：只带 tool 名与 typed 码（answered 的错误码或 client 失败码），零凭据材料。
    const note =
      result.kind === "answered"
        ? result.body.ok
          ? "answered"
          : `answered ${result.body.error.code}`
        : `failed ${result.code}`;
    process.stderr.write(`[payswap] ${tool}: bridge ${note}\n`);
    return { content: [{ type: "text" as const, text: payswapBridgeResultEnvelopeText(result) }] };
  };

  /** 每个工具的面：bridge 武装 → thin proxy；否则 Wave-1 快照拒绝。 */
  const toolHandler = (tool: PayswapToolName) => async (args: unknown, extra: ToolCallExtra) =>
    bridge === null ? refusalResult(tool) : bridgedResult(tool, args, extra);

  server.registerTool(
    TOOL_NAMES[0],
    {
      title: "Compile a payment intent",
      description:
        "Compile a natural-language payment description into a structured PaySwap intent. " +
        "Read-only analysis; never moves money. " +
        REFUSAL_NOTE,
      inputSchema: {
        description: z.string().min(1).describe("What the user wants to pay for or do, in their words."),
        amount: z.string().optional().describe("Decimal-string amount, if stated (never a float)."),
        currency: z.string().optional().describe("ISO-4217 currency code, if stated."),
        recipient: z.string().optional().describe("Recipient identifier as stated."),
        reference: z.string().optional().describe("User-supplied reference/invoice note, if any."),
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(TOOL_NAMES[0]) as never,
  );

  server.registerTool(
    TOOL_NAMES[1],
    {
      title: "Check intent eligibility",
      description:
        "Check a compiled intent against connection capabilities and policy (AML classification, " +
        "restrictions). Read-only. " + REFUSAL_NOTE,
      inputSchema: {
        intentId: z.string().min(1).describe("Identifier of the compiled intent."),
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(TOOL_NAMES[1]) as never,
  );

  server.registerTool(
    TOOL_NAMES[2],
    {
      title: "Discover candidate routes",
      description:
        "List candidate provider routes for a compiled intent, always including the direct-route " +
        "baseline. Read-only. " + REFUSAL_NOTE,
      inputSchema: {
        intentId: z.string().min(1).describe("Identifier of the compiled intent."),
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(TOOL_NAMES[2]) as never,
  );

  server.registerTool(
    TOOL_NAMES[3],
    {
      title: "Request transaction authorization",
      description:
        "Ask the host to create a transaction-authorization grant proposal for an intent. " +
        "Approval is rendered by the host (Class B authorization card), never by a plugin surface. " +
        "Returns a typed refusal unless a proposal can be created. " + REFUSAL_NOTE,
      inputSchema: {
        intentId: z.string().min(1).describe("Identifier of the compiled intent to authorize."),
      },
    },
    toolHandler(TOOL_NAMES[3]) as never,
  );

  server.registerTool(
    TOOL_NAMES[4],
    {
      title: "Get execution status",
      description:
        "Read the current status of an execution (or all executions of an intent). Read-only. " +
        REFUSAL_NOTE,
      inputSchema: {
        executionId: z.string().min(1).optional().describe("Identifier of a specific execution."),
        intentId: z.string().min(1).optional().describe("Identifier of the owning intent."),
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(TOOL_NAMES[4]) as never,
  );

  server.registerTool(
    TOOL_NAMES[5],
    {
      title: "Get account overview",
      description:
        "Redacted, evidence-based overview of connected financial accounts. Read-only. " +
        REFUSAL_NOTE,
      inputSchema: {
        connectionId: z.string().min(1).optional().describe("Restrict to one connection, if known."),
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(TOOL_NAMES[5]) as never,
  );

  for (const surface of SURFACES) {
    server.registerResource(
      surface.id,
      surface.resourceUri,
      { mimeType: PANEL_MIME_TYPE },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: PANEL_MIME_TYPE,
            text: renderPanelHtml(surface.id),
          },
        ],
      }),
    );
  }

  return server;
}
