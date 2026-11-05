import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { FINANCIAL_WORKSPACE_ENV, SURFACES, TOOL_NAMES } from "./contract.ts";
import { renderPanelHtml } from "./panels.ts";
import { createPayswapServer } from "./server.ts";

/**
 * Wave 1 工程测试：六工具注册 + typed refusal 语义（S1 `not_opted_in` / S2 `not_connected`）
 * + 三个 Class A 面板资源的可读性与信息性纪律。经 SDK 的 InMemoryTransport 走完整
 * client↔server 协议路径（与 stdio 等价的传输语义，无需子进程）。
 */

async function connectClient(env: NodeJS.ProcessEnv) {
  const server = createPayswapServer({ env });
  const client = new Client({ name: "payswap-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

let closer: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closer?.();
  closer = undefined;
});

describe("tool registration (S1 upstream default shape)", () => {
  it("registers exactly the six payswap_* tools, all readOnly-hinted", async () => {
    const { client, server } = await connectClient({ [FINANCIAL_WORKSPACE_ENV]: "false" });
    closer = async () => {
      await client.close();
      await server.close();
    };
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect([...names].sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools.tools) {
      // S1 纪律：readOnlyHint（request_authorization 除外——它创建提案，修改环境）。
      if (tool.name === "payswap_request_authorization") continue;
      expect(tool.annotations?.readOnlyHint, `${tool.name} should be readOnlyHint`).toBe(true);
    }
  });
});

describe("typed refusals (P0 addendum §2.1 taxonomy)", () => {
  const cases: Array<{ env: NodeJS.ProcessEnv; code: "not_opted_in" | "not_connected" }> = [
    { env: {}, code: "not_opted_in" },
    { env: { [FINANCIAL_WORKSPACE_ENV]: "false" }, code: "not_opted_in" },
    { env: { [FINANCIAL_WORKSPACE_ENV]: "true" }, code: "not_connected" },
  ];
  for (const { env, code } of cases) {
    it(`every tool refuses ${code} when env is ${JSON.stringify(env)}`, async () => {
      const { client, server } = await connectClient(env);
      closer = async () => {
        await client.close();
        await server.close();
      };
      const inputs: Record<string, Record<string, unknown>> = {
        payswap_compile_intent: { description: "pay invoice INV-1" },
        payswap_check_eligibility: { intentId: "intent_1" },
        payswap_discover_routes: { intentId: "intent_1" },
        payswap_request_authorization: { intentId: "intent_1" },
        payswap_get_execution_status: { executionId: "exec_1" },
        payswap_get_account_overview: {},
      };
      for (const tool of TOOL_NAMES) {
        const result = await client.callTool({ name: tool, arguments: inputs[tool] });
        expect(result.isError, `${tool} should not be a protocol error`).toBeFalsy();
        const text = (result.content as Array<{ type: string; text?: string }>).find(
          (entry) => entry.type === "text",
        )?.text;
        expect(text, `${tool} should return text content`).toBeTruthy();
        const envelope = JSON.parse(text as string);
        expect(envelope, `${tool} envelope shape`).toEqual({
          kind: "refused",
          refusal: { code, message: expect.any(String) },
        });
        expect(envelope.refusal.message.length, "refusal message is non-empty").toBeGreaterThan(0);
      }
    });
  }

  it("never conflates the two reachable codes", async () => {
    const { client, server } = await connectClient({ [FINANCIAL_WORKSPACE_ENV]: "true" });
    closer = async () => {
      await client.close();
      await server.close();
    };
    const result = await client.callTool({
      name: "payswap_get_account_overview",
      arguments: {},
    });
    const envelope = JSON.parse(
      (result.content as Array<{ type: string; text?: string }>)[0].text as string,
    );
    expect(envelope.refusal.code).toBe("not_connected");
    expect(envelope.refusal.code).not.toBe("not_opted_in");
  });
});

describe("Class A informational surfaces (P0 addendum §1.6.0)", () => {
  it("serves every declared ui:// resource with the mcp-app mime", async () => {
    const { client, server } = await connectClient({ [FINANCIAL_WORKSPACE_ENV]: "false" });
    closer = async () => {
      await client.close();
      await server.close();
    };
    for (const surface of SURFACES) {
      const resource = await client.readResource({ uri: surface.resourceUri });
      expect(resource.contents).toHaveLength(1);
      const entry = resource.contents[0];
      expect(entry.mimeType).toBe("text/html;profile=mcp-app");
      expect(entry, `${surface.id} serves text content`).toHaveProperty("text");
      expect(String((entry as { text?: string }).text)).toContain("PaySwap");
    }
  });

  it("panels stay informational: no authorization semantics, no financial data placeholders", () => {
    for (const surface of SURFACES) {
      const html = renderPanelHtml(surface.id);
      const lowered = html.toLowerCase();
      // 信息性纪律（§1.6.0 Class A）：面板文案不携带授权动作语义。
      for (const forbidden of ["approve", "authorization card", "grant proposal", "confirm payment"]) {
        expect(lowered.includes(forbidden), `${surface.id} must not mention "${forbidden}"`).toBe(
          false,
        );
      }
      // Wave 1 纪律：不渲染任何占位金融数据。
      for (const forbidden of ["balance: $", "amount: $", "usd 0.00"]) {
        expect(lowered.includes(forbidden), `${surface.id} must not render placeholder data`).toBe(
          false,
        );
      }
      // 零外部依赖：无外链脚本/样式/图片。
      for (const forbidden of ["<script src", '<link rel="stylesheet"', "<img src=\"http"]) {
        expect(html.includes(forbidden), `${surface.id} must stay dependency-free`).toBe(false);
      }
    }
  });
});
