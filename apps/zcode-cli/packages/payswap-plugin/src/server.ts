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
} from "./contract.ts";
import { renderPanelHtml } from "./panels.ts";

/**
 * PaySwap MCP server（Wave 1 骨架）。
 *
 * - 六个 `payswap_*` 工具全部注册（模型可见、`readOnlyHint`、无 `alwaysLoad` —— S1 的
 *   upstream 默认 deferral 语义，附录 §2 表格 S1 行）。
 * - 三个 Class A `ui://` 面板资源（信息性；authorization 卡是 Class B，由 host 渲染——
 *   本 server 永不提供授权内容，N25）。
 * - 工具是 thin proxy：Wave 1 无 broker，所有调用返回 typed refusal（信封化 JSON），
 *   不持有金融状态、凭据或账本访问（附录 §9）。参数 schema 是面向 broker 的最小
 *   合理形状（§6.2 的操作请求投影），真实语义由 Wave 2+ 的 broker 端点实现。
 */

const REFUSAL_NOTE =
  "Wave 1 note: this tool currently returns typed refusals only; live data arrives with the authenticated host broker (P0 addendum §3).";

export interface PayswapServerOptions {
  env?: NodeJS.ProcessEnv;
}

export function createPayswapServer(options: PayswapServerOptions = {}): McpServer {
  const server = new McpServer({ name: "payswap", version: "0.1.0" });
  const financialWorkspace = readFinancialWorkspaceSnapshot(options.env ?? process.env);
  const refusal = snapshotRefusal(financialWorkspace);

  const refusalResult = (tool: string) => {
    const envelope: PayswapToolEnvelope = { kind: "refused", refusal: { ...refusal } };
    process.stderr.write(`[payswap] ${tool}: refused ${refusal.code}\n`);
    return { content: [{ type: "text" as const, text: envelopeText(envelope) }] };
  };

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
    async () => refusalResult(TOOL_NAMES[0]),
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
    async () => refusalResult(TOOL_NAMES[1]),
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
    async () => refusalResult(TOOL_NAMES[2]),
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
    async () => refusalResult(TOOL_NAMES[3]),
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
    async () => refusalResult(TOOL_NAMES[4]),
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
    async () => refusalResult(TOOL_NAMES[5]),
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
