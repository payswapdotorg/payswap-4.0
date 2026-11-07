import { generateKeyPairSync, randomBytes, randomUUID, sign as edSign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJsonStringify,
  mintBrokerBootState,
  PAYSWAP_MAX_LINE_BYTES,
  requestLineDigest,
  type PayswapBrokerBootState,
  type PayswapBrokerErrorCode,
  type PayswapBrokerOp,
  type PayswapBrokerResponseBody,
  type PayswapBrokerResponseRejectionReason,
  type PayswapSequenceAllocator,
} from "@zcode/shared/payswap";
import { afterEach, describe, expect, it } from "vitest";

/**
 * PaySwap Wave-2 Step 7 —— 子进程侧 bridge transport（契约 w2-01 §3.3、§6.1(5)、§6.5(3)、
 * §9.3(5)/(6)；ADR-9 D9.7：transport shell 随 Step 7 落地；ADR-10 as-built）。
 *
 * 被测对象：`@zcode/shared/payswap` 的 `createPayswapBridgeClient` —— child 侧唯一的
 * broker 访问通道（UDS connect → 行写 → §6.5(3) 验签接线 → 分配器上的重试环）。
 * 对端是**真实 UDS listener**（测试铸造的协议对端，经共享 signResponseEnvelope 签名），
 * 非 mock —— 与 P1.3-P1.6 套件的"真实对端"纪律一致。
 *
 * 法则（normative）：
 * - §9.3(5) 发送边界分配：allocate() 与写发起原子；发送前取消/超限不消耗 seq；
 *   不确定投递保留 seq 同逻辑请求重试（同 seq、字节等价）；可证未投递可同 seq 重试或
 *   退役；放弃（永不重发）经 retire() 入声明队列，由后续载体携带（≤8 严格递增）。
 * - §6.1(5) child 侧尺寸预检：序列化超 1 MiB 的逻辑请求在**分配之前**拒绝（不烧 seq）。
 * - §6.5(3) 每 attempt 读时限（SHOULD 30s）喂入同一重试预算；验签失败整封拒绝
 *   （(a)-(h) 每步机器可读 reason），被拒响应的字段一个都不外露；v1 无未签名模式。
 * - §6.4(3) null-bound 信封永不满足子进程绑定（signed-refusal oracle 的 fail-closed 解）。
 *
 * RED 形状注记：bridge client 符号经动态 import + 形状断言取用 —— 落地前以
 * "shared module must export …" 断言失败呈现（P1.6 同款诚实 RED）；行为行在 RED 态
 * 同样以断言失败呈现（当前头无 bridge client 可用）。
 */

// ---------------------------------------------------------------------------
// 协议对端 listener（真实 UDS；捕获请求行、按剧本回行）
// ---------------------------------------------------------------------------

interface CapturedRequest {
  line: string;
  /** 本连接序（第几条连接 —— 一请求一连接，§3.3(1)）。 */
  connectionIndex: number;
}

type ResponderScript = (request: CapturedRequest) => string | { suppress: true } | { destroy: true };

interface TestPeer {
  path: string;
  requests: CapturedRequest[];
  connectionCount: number;
  setScript(script: ResponderScript | null): void;
  close(): Promise<void>;
}

async function startTestPeer(): Promise<TestPeer> {
  const dir = await mkdtemp(join(tmpdir(), "payswap-bridge-peer-"));
  const path = join(dir, "peer.sock");
  const requests: CapturedRequest[] = [];
  const peer: TestPeer = {
    path,
    requests,
    connectionCount: 0,
    setScript() {},
    close: () => Promise.resolve(),
  };
  let script: ResponderScript | null = () => JSON.stringify({ error: "no script" });
  peer.setScript = (next) => {
    script = next;
  };
  const server = net.createServer((socket) => {
    const connectionIndex = peer.connectionCount++;
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      buffer = "";
      const request: CapturedRequest = { line, connectionIndex };
      requests.push(request);
      const action = script ? script(request) : { destroy: true } as const;
      if (typeof action === "string") {
        socket.end(`${action}\n`);
      } else if ("suppress" in action) {
        // 收到请求但不回应：持连接挂死（deadline 行）或直接半关不写（不确定投递行）
        socket.resume();
      } else {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  peer.close = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await rm(dir, { force: true, recursive: true });
  };
  return peer;
}

/** 静默吞掉请求、挂住连接不回（deadline / suppress 剧本）。 */
const SUPPRESS: ResponderScript = () => ({ suppress: true });
/** 读到行即销毁连接（不确定投递：字节已交付、无响应，§9.3(5)）。 */
const DESTROY_AFTER_READ: ResponderScript = () => ({ destroy: true });

// ---------------------------------------------------------------------------
// 受测 child 材料（host-boot 铸造 + 五键组）
// ---------------------------------------------------------------------------

interface ChildMaterial {
  bootState: PayswapBrokerBootState;
  tuple: {
    socket: string;
    token: string;
    instanceId: string;
    hostId: string;
    verifyKeyBase64: string;
  };
}

function makeChildMaterial(socketPath: string): ChildMaterial {
  const bootState = mintBrokerBootState();
  return {
    bootState,
    tuple: {
      socket: socketPath,
      token: randomBytes(32).toString("hex"),
      instanceId: randomUUID(),
      hostId: bootState.hostId,
      verifyKeyBase64: "",
    },
  };
}

// ---------------------------------------------------------------------------
// bridge client 动态加载（RED 形状门）
// ---------------------------------------------------------------------------

interface BridgeCallOptionsLike {
  signal?: AbortSignal;
  trace?: { traceId: string; spanId?: string; parentSpanId?: string };
}

interface BridgeCallResultLike {
  kind: "answered" | "failed";
  body?: { ok: boolean; seq: number; data?: unknown; error?: { code: string; message: string; retryable: boolean } };
  code?: string;
  message?: string;
  retryable?: boolean;
  rejectionReason?: string;
}

interface BridgeClientLike {
  callOp(
    op: PayswapBrokerOp,
    params: Record<string, unknown>,
    sessionHint: string | null | undefined,
    options?: BridgeCallOptionsLike,
  ): Promise<BridgeCallResultLike>;
  allocator: PayswapSequenceAllocator;
}

interface BridgeExports {
  createPayswapBridgeClient: (options: {
    tuple: ChildMaterial["tuple"];
    readDeadlineMs?: number;
    retryBudget?: number;
    allocator?: PayswapSequenceAllocator;
  }) => BridgeClientLike;
}

let bridgeExports: BridgeExports | null = null;

/** RED 证据点：共享协议模块必须导出子进程 bridge client（ADR-9 D9.7）。 */
async function loadBridgeExports(): Promise<BridgeExports> {
  if (bridgeExports === null) {
    const mod = (await import("@zcode/shared/payswap")) as unknown as Record<string, unknown>;
    expect(
      mod.createPayswapBridgeClient,
      "ADR-9 D9.7: the child-side bridge transport must live in the shared protocol module",
    ).toBeTypeOf("function");
    bridgeExports = {
      createPayswapBridgeClient: mod.createPayswapBridgeClient as BridgeExports["createPayswapBridgeClient"],
    };
  }
  return bridgeExports;
}

// 说明：verifyKey（exportPublicKeyBase64）与 boot 状态经静态导入可用（已存在）；每行内
// 再次动态取用仅为与形状门同构，实际取的是同一模块实例。

// ---------------------------------------------------------------------------
// 清理簿记
// ---------------------------------------------------------------------------

const activePeers: TestPeer[] = [];
const activeTempDirs: string[] = [];

afterEach(async () => {
  for (const peer of activePeers.splice(0)) {
    await peer.close().catch(() => {});
  }
  for (const dir of activeTempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 帮助函数：协议构造
// ---------------------------------------------------------------------------

function signedLine(
  bootState: PayswapBrokerBootState,
  binding: {
    instanceId: string | null;
    seq: number | null;
    op: PayswapBrokerOp | null;
    requestDigest: string;
    response: PayswapBrokerResponseBody;
  },
  hostIdOverride?: string,
): string {
  // hostIdOverride：用 child 的钥签名但声称另一个 host-boot id（(c) 行专用）。
  const envelope = {
    v: 1,
    hostInstanceId: hostIdOverride ?? bootState.hostId,
    instanceId: binding.instanceId,
    seq: binding.seq,
    op: binding.op,
    requestDigest: binding.requestDigest,
    response: binding.response,
  };
  const canonical = canonicalJsonStringify(envelope);
  const signature = edSign(null, Buffer.from(canonical, "utf8"), bootState.keyPair.privateKey).toString("base64");
  return JSON.stringify({ envelope, signature });
}

function okBody(seq: number, data: unknown): PayswapBrokerResponseBody {
  return { ok: true, seq, data };
}

function errorBody(seq: number, code: PayswapBrokerErrorCode, retryable: boolean): PayswapBrokerResponseBody {
  return { ok: false, seq, error: { code, message: `test refusal: ${code}`, retryable } };
}

/** 从捕获的请求行解析 JSON（断言用）。 */
function parseRequestLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 套件
// ---------------------------------------------------------------------------

describe("payswap child bridge client (contract §3.3/§6.1(5)/§6.5(3)/§9.3(5)-(6); ADR-9 D9.7, ADR-10)", () => {
  it("exports the bridge client from the shared protocol module (shape gate)", async () => {
    await loadBridgeExports();
  });

  it("happy path: a validly signed success envelope is answered; the request line carries the exact schema shape (§6.1)", async () => {
    const exports = await loadBridgeExports();
    const peer = await startTestPeer();
    activePeers.push(peer);
    const material = makeChildMaterial(peer.path);
    const { exportPublicKeyBase64 } = await import("@zcode/shared/payswap");
    const tuple = { ...material.tuple, verifyKeyBase64: exportPublicKeyBase64(material.bootState.keyPair.publicKey) };
    const client = exports.createPayswapBridgeClient({ tuple, readDeadlineMs: 2_000, retryBudget: 0 });

    peer.setScript((request) =>
      signedLine(material.bootState, {
        instanceId: tuple.instanceId,
        seq: 1,
        op: "get_account_overview",
        requestDigest: requestLineDigest(request.line),
        response: okBody(1, { kind: "refused", refusal: { code: "not_connected", message: "test" } }),
      }),
    );

    const result = await client.callOp("get_account_overview", {}, "sess-a1");
    expect(result.kind).toBe("answered");
    if (result.kind === "answered") {
      expect(result.body?.ok).toBe(true);
      expect((result.body as { data?: { refusal?: { code?: string } } }).data?.refusal?.code).toBe("not_connected");
    }
    // 请求行：§6.1 闭集键 + 正确字段值；trace/retiredSeqs 未提供时**不出现**（.strict() 对齐）。
    expect(peer.requests).toHaveLength(1);
    const sent = parseRequestLine(peer.requests[0]!.line);
    expect(sent.instanceId).toBe(tuple.instanceId);
    expect(sent.token).toBe(tuple.token);
    expect(sent.seq).toBe(1);
    expect(sent.op).toBe("get_account_overview");
    expect(sent.sessionId).toBe("sess-a1");
    expect(sent.params).toEqual({});
    expect(Object.keys(sent).sort()).toEqual(["instanceId", "op", "params", "seq", "sessionId", "token"]);
    // 已答 seq 关闭；分配器单调。
    expect(client.allocator.status(1)).toBe("answered");
  });

  it("a verified broker error body is answered (not a client failure) — bridge codes ride the body (§6.2/§6.3)", async () => {
    const exports = await loadBridgeExports();
    const peer = await startTestPeer();
    activePeers.push(peer);
    const material = makeChildMaterial(peer.path);
    const { exportPublicKeyBase64 } = await import("@zcode/shared/payswap");
    const tuple = { ...material.tuple, verifyKeyBase64: exportPublicKeyBase64(material.bootState.keyPair.publicKey) };
    const client = exports.createPayswapBridgeClient({ tuple, readDeadlineMs: 2_000, retryBudget: 0 });

    peer.setScript((request) =>
      signedLine(material.bootState, {
        instanceId: tuple.instanceId,
        seq: 1,
        op: "compile_intent",
        requestDigest: requestLineDigest(request.line),
        response: errorBody(1, "sequence_duplicate", false),
      }),
    );

    const result = await client.callOp("compile_intent", { description: "pay invoice INV-1" }, "sess-a1");
    expect(result.kind).toBe("answered");
    if (result.kind === "answered") {
      expect(result.body?.ok).toBe(false);
      expect((result.body as { error?: { code?: string } }).error?.code).toBe("sequence_duplicate");
    }
    expect(client.allocator.status(1)).toBe("answered");
  });

  it("§6.1(5): an oversize logical request is refused child-side with no seq consumed and no connection", async () => {
    const exports = await loadBridgeExports();
    const peer = await startTestPeer();
    activePeers.push(peer);
    const material = makeChildMaterial(peer.path);
    const { exportPublicKeyBase64 } = await import("@zcode/shared/payswap");
    const tuple = { ...material.tuple, verifyKeyBase64: exportPublicKeyBase64(material.bootState.keyPair.publicKey) };
    const client = exports.createPayswapBridgeClient({ tuple, readDeadlineMs: 2_000, retryBudget: 0 });

    const huge = "x".repeat(PAYSWAP_MAX_LINE_BYTES);
    const result = await client.callOp("compile_intent", { description: huge }, "sess-a1");
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.code).toBe("request_too_large");
      expect(result.retryable).toBe(false);
    }
    // 不烧 seq（§6.1(5)：分配之前拒绝）且零连接。
    expect(client.allocator.isAllocated(1)).toBe(false);
    expect(peer.connectionCount).toBe(0);
  });

  it("a missing session hint is a typed child-side failure — no request can be formed (§6.1 sessionId min(1))", async () => {
    const exports = await loadBridgeExports();
    const peer = await startTestPeer();
    activePeers.push(peer);
    const material = makeChildMaterial(peer.path);
    const { exportPublicKeyBase64 } = await import("@zcode/shared/payswap");
    const tuple = { ...material.tuple, verifyKeyBase64: exportPublicKeyBase64(material.bootState.keyPair.publicKey) };
    const client = exports.createPayswapBridgeClient({ tuple, readDeadlineMs: 2_000, retryBudget: 0 });

    for (const hint of [null, undefined, "", "   "]) {
      const result = await client.callOp("get_account_overview", {}, hint);
      expect(result.kind, `hint=${JSON.stringify(hint)}`).toBe("failed");
      if (result.kind === "failed") {
        expect(result.code).toBe("session_hint_missing");
      }
    }
    expect(peer.connectionCount).toBe(0);
    expect(client.allocator.isAllocated(1)).toBe(false);
  });

  it("connect failure with no retry budget: typed connect_failed and the seq is retired for declaration (§9.3(5)/(6))", async () => {
    const exports = await loadBridgeExports();
    // 不启动 listener —— ENOENT。
    const dir = await mkdtemp(join(tmpdir(), "payswap-bridge-nosock-"));
    activeTempDirs.push(dir);
    const material = makeChildMaterial(join(dir, "absent.sock"));
    const { exportPublicKeyBase64 } = await import("@zcode/shared/payswap");
    const tuple = { ...material.tuple, verifyKeyBase64: exportPublicKeyBase64(material.bootState.keyPair.publicKey) };
    const client = exports.createPayswapBridgeClient({ tuple, readDeadlineMs: 2_000, retryBudget: 0 });

    const result = await client.callOp("get_account_overview", {}, "sess-a1");
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.code).toBe("connect_failed");
    }
    // 可证未投递、不再重试 → 退役声明入队（永不重发）。
    expect(client.allocator.pendingRetirements()).toEqual([1]);
  });

  it("uncertain delivery retries the SAME seq byte-for-byte and then accepts the answer (§9.3(5) retain-then-retry)", async () => {
    const exports = await loadBridgeExports();
    const peer = await startTestPeer();
    activePeers.push(peer);
    const material = makeChildMaterial(peer.path);
    const { exportPublicKeyBase64 } = await import("@zcode/shared/payswap");
    const tuple = { ...material.tuple, verifyKeyBase64: exportPublicKeyBase64(material.bootState.keyPair.publicKey) };
    const client = exports.createPayswapBridgeClient({ tuple, readDeadlineMs: 2_000, retryBudget: 1 });

    let round = 0;
    peer.setScript((request) => {
      round += 1;
      if (round === 1) {
        return { destroy: true } as const; // 字节已交付、连接销毁、无响应 → 不确定投递
      }
      return signedLine(material.bootState, {
        instanceId: tuple.instanceId,
        seq: 1,
        op: "get_account_overview",
        requestDigest: requestLineDigest(request.line),
        response: okBody(1, { kind: "refused", refusal: { code: "not_connected", message: "test" } }),
      });
    });

    const result = await client.callOp("get_account_overview", {}, "sess-a1");
    expect(result.kind).toBe("answered");
    // 两次连接、两行请求**字节等价**（同 seq 同逻辑请求 —— §9.3(5)）。
    expect(peer.requests).toHaveLength(2);
    expect(peer.requests[0]!.line).toBe(peer.requests[1]!.line);
    expect(parseRequestLine(peer.requests[1]!.line).seq).toBe(1);
    // 只分配过一个 seq。
    expect(client.allocator.isAllocated(2)).toBe(false);
    expect(client.allocator.status(1)).toBe("answered");
  });

  it("suppression past the retry budget: typed retry_budget_exhausted, seq retired (§6.5(3)/§9.3(5))", async () => {
    const exports = await loadBridgeExports();
    const peer = await startTestPeer();
    activePeers.push(peer);
    const material = makeChildMaterial(peer.path);
    const { exportPublicKeyBase64 } = await import("@zcode/shared/payswap");
    const tuple = { ...material.tuple, verifyKeyBase64: exportPublicKeyBase64(material.bootState.keyPair.publicKey) };
    const client = exports.createPayswapBridgeClient({ tuple, readDeadlineMs: 2_000, retryBudget: 1 });

    peer.setScript(DESTROY_AFTER_READ);
    const result = await client.callOp("get_account_overview", {}, "sess-a1");
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.code).toBe("retry_budget_exhausted");
      expect(result.retryable).toBe(true);
    }
    expect(peer.requests).toHaveLength(2); // 预算 1 → 两次尝试
    expect(client.allocator.pendingRetirements()).toEqual([1]);
  });

  it("the per-attempt read deadline bounds a silent endpoint (§6.5(3) rev 2a)", async () => {
    const exports = await loadBridgeExports();
    const peer = await startTestPeer();
    activePeers.push(peer);
    const material = makeChildMaterial(peer.path);
    const { exportPublicKeyBase64 } = await import("@zcode/shared/payswap");
    const tuple = { ...material.tuple, verifyKeyBase64: exportPublicKeyBase64(material.bootState.keyPair.publicKey) };
    const client = exports.createPayswapBridgeClient({ tuple, readDeadlineMs: 250, retryBudget: 0 });

    peer.setScript(SUPPRESS);
    const startedAt = Date.now();
    const result = await client.callOp("get_account_overview", {}, "sess-a1");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.code).toBe("response_deadline_exceeded");
    }
    expect(client.allocator.pendingRetirements()).toEqual([1]);
  });

  // -------------------------------------------------------------------------
  // §6.5(3)(a)-(h) 验签拒绝行（每行一个机器可读 reason；被拒字段零外露）
  // -------------------------------------------------------------------------

  interface RejectionRow {
    name: string;
    reason: PayswapBrokerResponseRejectionReason;
    /** 用 child 的 boot 钥构造一行"被拒"响应（脚本返回行）。 */
    buildLine(request: CapturedRequest, material: ChildMaterial, tuple: ChildMaterial["tuple"]): string;
  }

  const rejectionRows: RejectionRow[] = [
    {
      name: "(a) fabricated response signed by a substituted endpoint's own key",
      reason: "signature_invalid",
      buildLine(_request, _material, tuple) {
        const attackerKey = generateKeyPairSync("ed25519");
        const envelope = {
          v: 1,
          hostInstanceId: tuple.hostId,
          instanceId: tuple.instanceId,
          seq: 1,
          op: "get_account_overview",
          requestDigest: requestLineDigest(_request.line),
          response: okBody(1, { leak: "FABRICATED-CANARY" }),
        };
        const signature = edSign(null, Buffer.from(canonicalJsonStringify(envelope), "utf8"), attackerKey.privateKey).toString("base64");
        return JSON.stringify({ envelope, signature });
      },
    },
    {
      name: "(a) modified response — a captured valid envelope with the response body tampered",
      reason: "signature_invalid",
      buildLine(request, material, tuple) {
        const line = signedLine(material.bootState, {
          instanceId: tuple.instanceId,
          seq: 1,
          op: "get_account_overview",
          requestDigest: requestLineDigest(request.line),
          response: okBody(1, { kind: "ok" }),
        });
        const parsed = JSON.parse(line) as { envelope: { response: unknown }; signature: string };
        parsed.envelope.response = okBody(1, { leak: "MODIFIED-CANARY" });
        return JSON.stringify(parsed);
      },
    },
    {
      name: "(b) unknown envelope version — no unsigned/unknown-version mode (downgrade)",
      reason: "version_unsupported",
      buildLine(request, material, tuple) {
        const envelope = {
          v: 2,
          hostInstanceId: material.bootState.hostId,
          instanceId: tuple.instanceId,
          seq: 1,
          op: "get_account_overview",
          requestDigest: requestLineDigest(request.line),
          response: okBody(1, { leak: "V2-CANARY" }),
        };
        const signature = edSign(null, Buffer.from(canonicalJsonStringify(envelope), "utf8"), material.bootState.keyPair.privateKey).toString("base64");
        return JSON.stringify({ envelope, signature });
      },
    },
    {
      name: "(c) host binding mismatch — valid signature, foreign host-boot id",
      reason: "host_instance_mismatch",
      buildLine(request, material, tuple) {
        return signedLine(
          material.bootState,
          {
            instanceId: tuple.instanceId,
            seq: 1,
            op: "get_account_overview",
            requestDigest: requestLineDigest(request.line),
            response: okBody(1, { leak: "HOST-CANARY" }),
          },
          randomUUID(),
        );
      },
    },
    {
      name: "(d) null-bound pre-binding refusal can never satisfy the instance binding (sibling-relay oracle shape, §6.4(3))",
      reason: "instance_mismatch",
      buildLine(request, material, _tuple) {
        return signedLine(material.bootState, {
          instanceId: null,
          seq: null,
          op: null,
          requestDigest: "",
          response: errorBody(0, "peer_verification_failed", false),
        });
      },
    },
    {
      name: "(e) sequence binding mismatch — a replayed envelope for a different attempt",
      reason: "sequence_mismatch",
      buildLine(request, material, tuple) {
        return signedLine(material.bootState, {
          instanceId: tuple.instanceId,
          seq: 999,
          op: "get_account_overview",
          requestDigest: requestLineDigest(request.line),
          response: okBody(999, { leak: "SEQ-CANARY" }),
        });
      },
    },
    {
      name: "(f) operation binding mismatch — the envelope answers a different op",
      reason: "operation_mismatch",
      buildLine(request, material, tuple) {
        return signedLine(material.bootState, {
          instanceId: tuple.instanceId,
          seq: 1,
          op: "compile_intent",
          requestDigest: requestLineDigest(request.line),
          response: okBody(1, { leak: "OP-CANARY" }),
        });
      },
    },
    {
      name: "(g) request-digest binding mismatch — the envelope answers different request bytes",
      reason: "request_digest_mismatch",
      buildLine(request, material, tuple) {
        return signedLine(material.bootState, {
          instanceId: tuple.instanceId,
          seq: 1,
          op: "get_account_overview",
          requestDigest: requestLineDigest(`${request.line}tampered`),
          response: okBody(1, { leak: "DIGEST-CANARY" }),
        });
      },
    },
    {
      name: "(h) response body shape violation — error body without the typed error triple",
      reason: "response_body_malformed",
      buildLine(request, material, tuple) {
        return signedLine(material.bootState, {
          instanceId: tuple.instanceId,
          seq: 1,
          op: "get_account_overview",
          requestDigest: requestLineDigest(request.line),
          response: { ok: false, seq: 1, error: { code: 42 } } as unknown as PayswapBrokerResponseBody,
        });
      },
    },
    {
      name: "unsigned response — no unsigned mode in v1 (downgrade)",
      reason: "signature_missing",
      buildLine(_request, _material, _tuple) {
        return JSON.stringify({
          envelope: {
            v: 1,
            hostInstanceId: _tuple.hostId,
            instanceId: _tuple.instanceId,
            seq: 1,
            op: "get_account_overview",
            requestDigest: requestLineDigest(_request.line),
            response: okBody(1, { leak: "UNSIGNED-CANARY" }),
          },
        });
      },
    },
    {
      name: "unparseable response line",
      reason: "response_line_unparseable",
      buildLine() {
        return "this-is-not-json{";
      },
    },
    {
      name: "oversize response line rejected before any signature check (§6.4(4))",
      reason: "response_line_oversize",
      buildLine() {
        return `{"padding":"${"y".repeat(PAYSWAP_MAX_LINE_BYTES)}"}`;
      },
    },
  ];

  for (const row of rejectionRows) {
    it(`§6.5(3) rejection: ${row.name} → ${row.reason}; nothing from the rejected response leaks`, async () => {
      const exports = await loadBridgeExports();
      const peer = await startTestPeer();
      activePeers.push(peer);
      const material = makeChildMaterial(peer.path);
      const { exportPublicKeyBase64 } = await import("@zcode/shared/payswap");
      const tuple = { ...material.tuple, verifyKeyBase64: exportPublicKeyBase64(material.bootState.keyPair.publicKey) };
      const client = exports.createPayswapBridgeClient({ tuple, readDeadlineMs: 2_000, retryBudget: 0 });

      peer.setScript((request) => row.buildLine(request, material, tuple));

      const result = await client.callOp("get_account_overview", {}, "sess-a1");
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.code).toBe("response_rejected");
        expect(result.rejectionReason).toBe(row.reason);
        // 被拒响应的字段一个都不外露（§6.5(3)）：结果对象无 body；message 不含 canary。
        expect("body" in result && result.body !== undefined).toBe(false);
        expect(JSON.stringify(result)).not.toMatch(/CANARY/);
      }
      // 验签拒绝 = 永不重发本 seq（ADR-10）：退役声明入队。
      expect(client.allocator.pendingRetirements()).toEqual([1]);
    });
  }

  it("retirement declarations ride the next request (≤8, strictly increasing, each < carrier seq; §6.1(4)/§9.3(6))", async () => {
    const exports = await loadBridgeExports();
    const peer = await startTestPeer();
    activePeers.push(peer);
    const material = makeChildMaterial(peer.path);
    const { exportPublicKeyBase64 } = await import("@zcode/shared/payswap");
    const tuple = { ...material.tuple, verifyKeyBase64: exportPublicKeyBase64(material.bootState.keyPair.publicKey) };
    const client = exports.createPayswapBridgeClient({ tuple, readDeadlineMs: 2_000, retryBudget: 0 });

    // 第 1 个逻辑请求：fabricated 拒绝 → seq 1 退役。
    peer.setScript(() => {
      const attackerKey = generateKeyPairSync("ed25519");
      const envelope = {
        v: 1,
        hostInstanceId: tuple.hostId,
        instanceId: tuple.instanceId,
        seq: 1,
        op: "get_account_overview",
        requestDigest: "",
        response: okBody(1, {}),
      };
      const signature = edSign(null, Buffer.from(canonicalJsonStringify(envelope), "utf8"), attackerKey.privateKey).toString("base64");
      return JSON.stringify({ envelope, signature });
    });
    const first = await client.callOp("get_account_overview", {}, "sess-a1");
    expect(first.kind).toBe("failed");

    // 第 2 个逻辑请求：合法回答；其请求行必须携带 retiredSeqs: [1]。
    peer.setScript((request) =>
      signedLine(material.bootState, {
        instanceId: tuple.instanceId,
        seq: 2,
        op: "get_execution_status",
        requestDigest: requestLineDigest(request.line),
        response: okBody(2, { kind: "refused", refusal: { code: "not_connected", message: "test" } }),
      }),
    );
    const second = await client.callOp("get_execution_status", {}, "sess-a1");
    expect(second.kind).toBe("answered");
    const carrier = parseRequestLine(peer.requests.at(-1)!.line);
    expect(carrier.retiredSeqs).toEqual([1]);
    expect(carrier.seq).toBe(2);
  });

  it("trace context rides the request when provided (§6.1 trace triple)", async () => {
    const exports = await loadBridgeExports();
    const peer = await startTestPeer();
    activePeers.push(peer);
    const material = makeChildMaterial(peer.path);
    const { exportPublicKeyBase64 } = await import("@zcode/shared/payswap");
    const tuple = { ...material.tuple, verifyKeyBase64: exportPublicKeyBase64(material.bootState.keyPair.publicKey) };
    const client = exports.createPayswapBridgeClient({ tuple, readDeadlineMs: 2_000, retryBudget: 0 });

    peer.setScript((request) =>
      signedLine(material.bootState, {
        instanceId: tuple.instanceId,
        seq: 1,
        op: "check_eligibility",
        requestDigest: requestLineDigest(request.line),
        response: okBody(1, { kind: "refused", refusal: { code: "not_connected", message: "test" } }),
      }),
    );
    const result = await client.callOp("check_eligibility", { intentId: "i-1" }, "sess-a1", {
      trace: { traceId: "trace-1", spanId: "span-1", parentSpanId: "span-0" },
    });
    expect(result.kind).toBe("answered");
    const sent = parseRequestLine(peer.requests[0]!.line);
    expect(sent.trace).toEqual({ traceId: "trace-1", spanId: "span-1", parentSpanId: "span-0" });
  });

  it("a pre-send abort consumes no sequence (§9.3(5) allocation is atomic with write initiation)", async () => {
    const exports = await loadBridgeExports();
    const peer = await startTestPeer();
    activePeers.push(peer);
    const material = makeChildMaterial(peer.path);
    const { exportPublicKeyBase64 } = await import("@zcode/shared/payswap");
    const tuple = { ...material.tuple, verifyKeyBase64: exportPublicKeyBase64(material.bootState.keyPair.publicKey) };
    const client = exports.createPayswapBridgeClient({ tuple, readDeadlineMs: 2_000, retryBudget: 0 });

    const controller = new AbortController();
    controller.abort();
    const result = await client.callOp("get_account_overview", {}, "sess-a1", { signal: controller.signal });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.code).toBe("aborted");
    }
    expect(client.allocator.isAllocated(1)).toBe(false);
    expect(peer.connectionCount).toBe(0);
  });

  it("sequences are never reused across logical requests (monotonic allocation, §9.1)", async () => {
    const exports = await loadBridgeExports();
    const peer = await startTestPeer();
    activePeers.push(peer);
    const material = makeChildMaterial(peer.path);
    const { exportPublicKeyBase64 } = await import("@zcode/shared/payswap");
    const tuple = { ...material.tuple, verifyKeyBase64: exportPublicKeyBase64(material.bootState.keyPair.publicKey) };
    const client = exports.createPayswapBridgeClient({ tuple, readDeadlineMs: 2_000, retryBudget: 0 });

    peer.setScript((request) => {
      const sent = parseRequestLine(request.line);
      return signedLine(material.bootState, {
        instanceId: tuple.instanceId,
        seq: sent.seq as number,
        op: "get_account_overview",
        requestDigest: requestLineDigest(request.line),
        response: okBody(sent.seq as number, {}),
      });
    });
    for (let index = 0; index < 3; index += 1) {
      const result = await client.callOp("get_account_overview", {}, "sess-a1");
      expect(result.kind).toBe("answered");
    }
    expect(peer.requests.map((request) => parseRequestLine(request.line).seq)).toEqual([1, 2, 3]);
    expect(client.allocator.isAllocated(4)).toBe(false);
  });
});
