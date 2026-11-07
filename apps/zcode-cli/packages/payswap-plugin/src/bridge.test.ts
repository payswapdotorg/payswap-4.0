import { generateKeyPairSync, randomBytes, randomUUID, sign as edSign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  canonicalJsonStringify,
  exportPublicKeyBase64,
  mintBrokerBootState,
  requestLineDigest,
  type PayswapBrokerBootState,
  type PayswapBrokerOp,
  type PayswapBrokerResponseBody,
} from "@zcode/shared/payswap";
import { afterEach, describe, expect, it } from "vitest";
import { FINANCIAL_WORKSPACE_ENV, TOOL_NAMES } from "./contract.ts";
import { createPayswapServer } from "./server.ts";

/**
 * PaySwap Wave-2 Step 7 —— 插件 server 的 bridge 接线（契约 w2-01 §0 迁移、§6.2、§7.1；
 * ADR-9 D9.7 + ADR-10）。
 *
 * 法则：五键组在 env（受信注入）→ 六工具从 Wave-1 env 快照拒绝迁移为经 bridge 的 thin
 * proxy；无五键组 → Wave-1 行为原样保留（S0b/S1 保存纪律，merged PR #3 的表面不变）。
 * 会话 hint 只取 host client 写入的命名空间 `com.zcode/request-context` 的 `session_id`
 * （node_repl 同款安全边界：顶层 _meta 是第三方可扩展字段）。
 * bridge 失败（§6.3 桥接码 + child 侧 typed 码）以 `kind:"bridge_failure"` 信封面呈 ——
 * 与三码业务拒绝（`kind:"refused"`）永不混淆（§6.2）。
 *
 * 对端是真实 UDS listener（共享 signResponseEnvelope 铸签名行）—— 非 mock。
 * RED 形状注记：bridge helper 经动态 import + 形状断言取用（P1.6 同款诚实 RED）。
 */

// ---------------------------------------------------------------------------
// 测试协议对端
// ---------------------------------------------------------------------------

interface TestPeer {
  path: string;
  requests: string[];
  setRespond(respond: (line: string) => string): void;
  close(): Promise<void>;
}

async function startTestPeer(): Promise<TestPeer> {
  const dir = await mkdtemp(join(tmpdir(), "payswap-plugin-peer-"));
  const path = join(dir, "peer.sock");
  const requests: string[] = [];
  let respond: (line: string) => string = () => "{}";
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      buffer = "";
      requests.push(line);
      socket.end(`${respond(line)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    path,
    requests,
    setRespond(next) {
      respond = next;
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { force: true, recursive: true });
    },
  };
}

function bootMaterial(): { bootState: PayswapBrokerBootState; tuple: Record<string, string> } {
  const bootState = mintBrokerBootState();
  return {
    bootState,
    tuple: {
      PAYSWAP_BROKER_SOCKET: "placeholder", // 由用例回填 peer.path
      PAYSWAP_BROKER_TOKEN: randomBytes(32).toString("hex"),
      PAYSWAP_BROKER_INSTANCE_ID: randomUUID(),
      PAYSWAP_BROKER_HOST_ID: bootState.hostId,
      PAYSWAP_BROKER_VERIFY_KEY: exportPublicKeyBase64(bootState.keyPair.publicKey),
    },
  };
}

function signedOkLine(
  bootState: PayswapBrokerBootState,
  tuple: Record<string, string>,
  requestLine: string,
  op: PayswapBrokerOp,
  data: unknown,
): string {
  const request = JSON.parse(requestLine) as { seq: number; instanceId: string };
  const envelope = {
    v: 1,
    hostInstanceId: bootState.hostId,
    instanceId: tuple.PAYSWAP_BROKER_INSTANCE_ID,
    seq: request.seq,
    op,
    requestDigest: requestLineDigest(requestLine),
    response: { ok: true, seq: request.seq, data } satisfies PayswapBrokerResponseBody,
  };
  const signature = edSign(null, Buffer.from(canonicalJsonStringify(envelope), "utf8"), bootState.keyPair.privateKey).toString("base64");
  return JSON.stringify({ envelope, signature });
}

// ---------------------------------------------------------------------------
// bridge helper 动态加载（RED 形状门）
// ---------------------------------------------------------------------------

interface BridgeHelpers {
  sessionHintFromRequestMeta(meta: unknown): string | null;
  armPayswapBridgeFromEnv(env: NodeJS.ProcessEnv): unknown;
}

let bridgeHelpers: BridgeHelpers | null = null;

async function loadBridgeHelpers(): Promise<BridgeHelpers> {
  if (bridgeHelpers === null) {
    const mod = (await import("./bridge.ts")) as unknown as Record<string, unknown>;
    expect(
      mod.sessionHintFromRequestMeta,
      "Step 7: the plugin must own a session-hint reader for the host-namespaced request context",
    ).toBeTypeOf("function");
    expect(
      mod.armPayswapBridgeFromEnv,
      "Step 7: the plugin must arm its bridge from the injected five-key env tuple",
    ).toBeTypeOf("function");
    bridgeHelpers = {
      sessionHintFromRequestMeta: mod.sessionHintFromRequestMeta as BridgeHelpers["sessionHintFromRequestMeta"],
      armPayswapBridgeFromEnv: mod.armPayswapBridgeFromEnv as BridgeHelpers["armPayswapBridgeFromEnv"],
    };
  }
  return bridgeHelpers;
}

// ---------------------------------------------------------------------------
// MCP client 装配
// ---------------------------------------------------------------------------

async function connectServer(env: NodeJS.ProcessEnv): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createPayswapServer({ env });
  const client = new Client({ name: "payswap-bridge-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function toolResultText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  for (const entry of content) {
    if (typeof entry === "object" && entry !== null && (entry as { type?: string }).type === "text") {
      return String((entry as { text?: unknown }).text ?? "");
    }
  }
  return "";
}

const REQUEST_CONTEXT_META = {
  "com.zcode/request-context": { session_id: "sess-bridge-1", trace_id: "trace-bridge-1" },
};

let activePeer: TestPeer | undefined;
let activeClose: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (activeClose) await activeClose();
  activeClose = undefined;
  if (activePeer) await activePeer.close();
  activePeer = undefined;
});

// ---------------------------------------------------------------------------
// 套件
// ---------------------------------------------------------------------------

describe("payswap plugin bridge wiring (contract §0 migration, §6.2, §7.1; ADR-10)", () => {
  it("exports the bridge helpers (shape gate)", async () => {
    await loadBridgeHelpers();
  });

  it("sessionHintFromRequestMeta reads ONLY the host-namespaced request context (top-level _meta is untrusted)", async () => {
    const helpers = await loadBridgeHelpers();
    expect(helpers.sessionHintFromRequestMeta(REQUEST_CONTEXT_META)).toBe("sess-bridge-1");
    // 顶层 session_id（第三方可写）不得被采纳。
    expect(helpers.sessionHintFromRequestMeta({ session_id: "attacker-hint" })).toBeNull();
    expect(helpers.sessionHintFromRequestMeta(undefined)).toBeNull();
    expect(helpers.sessionHintFromRequestMeta({})).toBeNull();
    // 命名空间内非字符串/空白 → null（fail-closed）。
    expect(
      helpers.sessionHintFromRequestMeta({ "com.zcode/request-context": { session_id: 42 } }),
    ).toBeNull();
    expect(
      helpers.sessionHintFromRequestMeta({ "com.zcode/request-context": { session_id: "   " } }),
    ).toBeNull();
  });

  it("armPayswapBridgeFromEnv: a complete five-key tuple arms the bridge; partial/absent does not (§4.4(1) all-or-nothing)", async () => {
    const helpers = await loadBridgeHelpers();
    const { tuple } = bootMaterial();
    const armed = helpers.armPayswapBridgeFromEnv(tuple as NodeJS.ProcessEnv);
    expect(armed).not.toBeNull();
    // 半组（缺 verify key）→ null。
    const partial = { ...tuple } as Record<string, string>;
    delete partial.PAYSWAP_BROKER_VERIFY_KEY;
    expect(helpers.armPayswapBridgeFromEnv(partial as NodeJS.ProcessEnv)).toBeNull();
    // 全缺 → null。
    expect(helpers.armPayswapBridgeFromEnv({})).toBeNull();
  });

  it("bridge mode: a tool call with a session hint reaches the broker and returns its verified envelope (§0 thin proxy)", async () => {
    const peer = await startTestPeer();
    activePeer = peer;
    const { bootState, tuple } = bootMaterial();
    const env = {
      ...tuple,
      PAYSWAP_BROKER_SOCKET: peer.path,
      [FINANCIAL_WORKSPACE_ENV]: "false", // env 快照与 broker live 状态相反 —— live 才是权威
    } as NodeJS.ProcessEnv;
    peer.setRespond((line) =>
      signedOkLine(bootState, tuple, line, "get_account_overview", {
        kind: "refused",
        refusal: { code: "not_connected", message: "live broker answer" },
      }),
    );

    const connection = await connectServer(env);
    activeClose = connection.close;
    const result = await connection.client.callTool({
      name: "payswap_get_account_overview",
      arguments: {},
      _meta: REQUEST_CONTEXT_META,
    });
    // broker 的 data 信封原样成为工具结果（§6.2：业务信封骑在 data 里）。
    expect(JSON.parse(toolResultText(result))).toEqual({
      kind: "refused",
      refusal: { code: "not_connected", message: "live broker answer" },
    });
    // 请求行到达对端：hint、op、params 1:1。
    expect(peer.requests).toHaveLength(1);
    const sent = JSON.parse(peer.requests[0]!) as Record<string, unknown>;
    expect(sent.op).toBe("get_account_overview");
    expect(sent.sessionId).toBe("sess-bridge-1");
    expect(sent.params).toEqual({});
    expect(sent.instanceId).toBe(tuple.PAYSWAP_BROKER_INSTANCE_ID);
  });

  it("bridge mode: every tool maps 1:1 onto its operation (§7.1 closed table, no seventh op)", async () => {
    const peer = await startTestPeer();
    activePeer = peer;
    const { bootState, tuple } = bootMaterial();
    const env = {
      ...tuple,
      PAYSWAP_BROKER_SOCKET: peer.path,
    } as NodeJS.ProcessEnv;
    peer.setRespond((line) => {
      const request = JSON.parse(line) as { op: PayswapBrokerOp };
      return signedOkLine(bootState, tuple, line, request.op, {
        kind: "refused",
        refusal: { code: "not_connected", message: "typed" },
      });
    });

    const connection = await connectServer(env);
    activeClose = connection.close;
    const inputs: Record<string, Record<string, unknown>> = {
      payswap_compile_intent: { description: "pay invoice INV-1" },
      payswap_check_eligibility: { intentId: "i-1" },
      payswap_discover_routes: { intentId: "i-1" },
      payswap_request_authorization: { intentId: "i-1" },
      payswap_get_execution_status: { executionId: "e-1" },
      payswap_get_account_overview: {},
    };
    for (const tool of TOOL_NAMES) {
      const result = await connection.client.callTool({
        name: tool,
        arguments: inputs[tool] ?? {},
        _meta: REQUEST_CONTEXT_META,
      });
      expect(JSON.parse(toolResultText(result)).refusal?.code, tool).toBe("not_connected");
    }
    const ops = peer.requests.map((line) => (JSON.parse(line) as { op: string }).op).sort();
    expect(ops).toEqual([
      "check_eligibility",
      "compile_intent",
      "discover_routes",
      "get_account_overview",
      "get_execution_status",
      "request_authorization",
    ]);
  });

  it("bridge mode without a session hint: typed bridge_failure(session_hint_missing) — never a business refusal", async () => {
    const peer = await startTestPeer();
    activePeer = peer;
    const { tuple } = bootMaterial();
    const env = {
      ...tuple,
      PAYSWAP_BROKER_SOCKET: peer.path,
    } as NodeJS.ProcessEnv;
    const connection = await connectServer(env);
    activeClose = connection.close;
    const result = await connection.client.callTool({
      name: "payswap_get_account_overview",
      arguments: {},
      // 无 _meta —— 第三方 client 直连形状。
    });
    const envelope = JSON.parse(toolResultText(result));
    expect(envelope).toEqual({
      kind: "bridge_failure",
      failure: { code: "session_hint_missing", message: expect.any(String), retryable: false },
    });
    // 无 hint → 不可成请求（§6.1 sessionId min(1)）→ 零连接。
    expect(peer.requests).toHaveLength(0);
  });

  it("bridge mode against a fabricated endpoint: the rejection is surfaced typed and NOTHING from the fabricated response leaks (§6.5(3)/§6.5(4))", async () => {
    const peer = await startTestPeer();
    activePeer = peer;
    const { tuple } = bootMaterial();
    const env = {
      ...tuple,
      PAYSWAP_BROKER_SOCKET: peer.path,
    } as NodeJS.ProcessEnv;
    // 替换端点用自己的钥签名（伪造）—— 真实钥不可得。
    peer.setRespond((line) => {
      const request = JSON.parse(line) as { seq: number };
      const attacker = generateKeyPairSync("ed25519");
      const envelope = {
        v: 1,
        hostInstanceId: tuple.PAYSWAP_BROKER_HOST_ID,
        instanceId: tuple.PAYSWAP_BROKER_INSTANCE_ID,
        seq: request.seq,
        op: "get_account_overview",
        requestDigest: requestLineDigest(line),
        response: { ok: true, seq: request.seq, data: { leak: "FABRICATED-CANARY" } },
      };
      const signature = edSign(null, Buffer.from(canonicalJsonStringify(envelope), "utf8"), attacker.privateKey).toString("base64");
      return JSON.stringify({ envelope, signature });
    });

    const connection = await connectServer(env);
    activeClose = connection.close;
    const result = await connection.client.callTool({
      name: "payswap_get_account_overview",
      arguments: {},
      _meta: REQUEST_CONTEXT_META,
    });
    const text = toolResultText(result);
    expect(text).not.toMatch(/FABRICATED-CANARY/);
    expect(JSON.parse(text)).toEqual({
      kind: "bridge_failure",
      failure: { code: "response_rejected", message: expect.any(String), retryable: false },
    });
  });

  it("no five-key tuple in env: Wave-1 snapshot refusals are preserved exactly (S0b/S1 discipline, merged PR #3)", async () => {
    const peer = await startTestPeer();
    activePeer = peer;
    const connection = await connectServer({ [FINANCIAL_WORKSPACE_ENV]: "false" });
    activeClose = connection.close;
    const result = await connection.client.callTool({
      name: "payswap_get_account_overview",
      arguments: {},
      _meta: REQUEST_CONTEXT_META,
    });
    expect(JSON.parse(toolResultText(result))).toEqual({
      kind: "refused",
      refusal: { code: "not_opted_in", message: expect.any(String) },
    });
    // 无凭据 → 无 bridge → 零连接。
    expect(peer.requests).toHaveLength(0);
  });

  it("§7.4 dormant grant hook: an authorizationId submission never reaches grant logic — the answer stays the three-code law", async () => {
    const peer = await startTestPeer();
    activePeer = peer;
    const { bootState, tuple } = bootMaterial();
    const env = {
      ...tuple,
      PAYSWAP_BROKER_SOCKET: peer.path,
    } as NodeJS.ProcessEnv;
    peer.setRespond((line) => {
      const request = JSON.parse(line) as { op: PayswapBrokerOp; params?: Record<string, unknown> };
      // 到达 broker 的 params 里没有 authorizationId（工具 schema 面剥离）—— 若出现即违约。
      if ("authorizationId" in (request.params ?? {})) {
        throw new Error("authorizationId reached the broker params (contract §7.4 violation)");
      }
      return signedOkLine(bootState, tuple, line, request.op, {
        kind: "refused",
        refusal: { code: "not_connected", message: "typed" },
      });
    });

    const connection = await connectServer(env);
    activeClose = connection.close;
    const result = await connection.client.callTool({
      name: "payswap_request_authorization",
      arguments: { intentId: "i-1", authorizationId: "grant-attempt" },
      _meta: REQUEST_CONTEXT_META,
    });
    // 答案是三码法则（业务拒绝），绝不是 grant 语义。
    expect(JSON.parse(toolResultText(result))).toEqual({
      kind: "refused",
      refusal: { code: "not_connected", message: expect.any(String) },
    });
  });
});
