import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  createPayswapInstanceRegistry,
  exportPublicKeyBase64,
  mintBrokerBootState,
  verifyResponseEnvelope,
  type PayswapBrokerAttemptContext,
  type PayswapBrokerBootState,
  type PayswapInstanceRegistry,
  type PayswapInstanceRegistryEntry,
} from "@zcode/shared/payswap";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootPayswapBroker,
  type PayswapBrokerAuditEvent,
  type PayswapBrokerBootOptions,
  type PayswapBrokerHandle,
  type PayswapSessionScopeResolver,
} from "../src/payswap-broker/index.js";

/**
 * PaySwap P1.6 Step 6 —— §9 重放保护（契约 w2-01 §9；§12 Step-6 行；ADR-2/ADR-9）。
 *
 * §9 法则（normative）：
 * - §9.1 请求身份 = (instanceId, seq)：instanceId 绑定 per-instance 凭据（§4.1），seq 是
 *   MCP child 在**发送边界**分配的单调递增 per-instance 整数。
 * - §9.2 dedupe 的 scope 是 **broker 实例**（host 进程金融服务生命周期），不是连接 ——
 *   连接断开/重连不清记录（N33/N34）；新 MCP 实例 = 新 instanceId，先死在实例检查。
 * - §9.3 连续水标算法：W（水标：≤W 全部已受理）+ R（保留集：>W 的已受理序号，
 *   **已完成的也保留**）；受理判定（seq ≤ W 或 seq ∈ R → sequence_duplicate，先于
 *   dispatch 拒绝，与原请求最终结局无关）；水标只在 W+1 受理后连续推进；失序臂
 *   （N39：12 先于 11 完成时 12 留在 R，11 到达前重放 12 拒绝）；并发原子性
 *   （N35：两连接同 (instanceId, seq) 同时在途 → 恰一次 dispatch + 一次 duplicate）；
 *   子进程侧分配纪律（§9.3(5) rev 2：发送边界分配；不确定投递保留 seq 同逻辑请求
 *   重试；可证未投递可同 seq 重试或退役；放弃经 retiredSeqs 退役，弃用 seq 永不复用）；
 *   退役声明（§9.3(6) rev 2a：≤8 严格递增、均小于载体自身 seq；**载体命运独立** ——
 *   过了 §5.5 步 (1)-(4) 的载体即使自己被拒（含 sequence_gap_exceeded）其退役仍处理）。
 * - §9.4 有界缺口 G=64 冻结 v1 协议常量（共享协议模块唯一落点，无任何配置面）：
 *   seq > W+G → sequence_gap_exceeded（先于 dispatch，retryable）；边界行 W+64 受理 /
 *   W+65 拒绝；|R| ≤ G 恒成立（对抗性缺口洪泛下逐步断言）。
 * - §9.5 拒绝先于 dispatch：重放收到 typed 拒绝且**零**再 dispatch。
 * - D8.1：§8 拒绝（session_unresolvable / workspace_mismatch）的请求**不烧序列** ——
 *   pre-dispatch 拒绝 ≠ accepted for dispatch，child 可原样重发同一逻辑请求。
 *
 * RED 形状注记：引擎/分配器符号经动态 import + 形状断言取用 —— 落地前这些行以
 * "shared module must export …" 断言失败呈现（P1.3/P1.5 同款诚实 RED）；行为行
 * （N33/N34/N35/N39/边界/§8-不烧序列/禁用臂）在 RED 态以断言失败呈现（当前头无
 * §9.5 检查，重放会被再次 dispatch；合法 retiredSeqs 键当前被 §6.1 .strict() 以
 * 未知键拒绝）。schema 界桩行（>8 条目 → request_invalid）在 RED 态因"未知键"同
 * 样拒绝 —— 观察上与 GREEN 重合，如实标注（非 RED 证据，是保形桩）。
 */

// ---------------------------------------------------------------------------
// 子进程客户端（真实对端：多轮顺序连接 / 并发对 / 丢弃轮 —— P1.3-P1.5 同款纪律）
// ---------------------------------------------------------------------------

/**
 * 每轮 = 一条新连接（§3.3(1) 一请求一连接）。轮条目：
 * - { line }      —— 连接 → 写行 → 收一条响应 → 等关闭
 * - { drop: true } —— 连接 → 不写 → 50ms 后主动销毁（"原请求从未到达"的确定型制造）
 * 并发模式（PB_TEST_CONCURRENT=1）：两条连接**同时**建立、写同一行（N35）。
 */
const CHILD_SCRIPT = `
const net = require("node:net");
const path = process.env.PB_TEST_PATH;
const rounds = JSON.parse(process.env.PB_TEST_ROUNDS || "[]");
const concurrent = process.env.PB_TEST_CONCURRENT === "1";
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
function oneRound(roundIndex, line, cb) {
  const s = net.connect(path, () => {
    send({ t: "connected", round: roundIndex });
    if (line !== null) s.write(line + "\\n");
    else setTimeout(() => s.destroy(), 50);
  });
  let acc = "";
  let reported = false;
  s.on("data", (d) => {
    acc += d.toString("utf8");
    let i;
    while ((i = acc.indexOf("\\n")) >= 0) {
      const resp = acc.slice(0, i);
      acc = acc.slice(i + 1);
      if (!reported) { reported = true; send({ t: "response", round: roundIndex, line: resp }); }
    }
  });
  s.on("close", () => { send({ t: "closed", round: roundIndex }); cb(); });
  s.on("error", (e) => { send({ t: "error", round: roundIndex, code: e.code }); cb(); });
}
let round = 0;
function next() {
  if (round >= rounds.length) { setTimeout(() => process.exit(0), 50); return; }
  const r = round++;
  const line = rounds[r].drop ? null : rounds[r].line;
  oneRound(r, line, () => setTimeout(next, 10));
}
if (concurrent) {
  let pending = 2;
  const done = () => { if (--pending === 0) setTimeout(() => process.exit(0), 50); };
  oneRound(0, rounds[0].line, done);
  oneRound(1, rounds[0].line, done);
} else {
  setTimeout(next, Number(process.env.PB_TEST_CONNECT_DELAY_MS || 0));
}
setTimeout(() => process.exit(0), 25000);
`;

interface ChildEvent {
  t: "connected" | "response" | "closed" | "error";
  round?: number;
  line?: string;
  code?: string;
}

interface ChildHandle {
  readonly pid: number;
  readonly events: ChildEvent[];
  waitFor(predicate: (event: ChildEvent) => boolean, timeoutMs?: number): Promise<ChildEvent>;
  kill(): void;
}

const activeChildren: ReturnType<typeof spawn>[] = [];

function spawnRoundsChild(options: {
  path: string;
  rounds: Array<{ line: string } | { drop: true }>;
  connectDelayMs?: number;
  concurrent?: boolean;
}): ChildHandle {
  const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      PB_TEST_PATH: options.path,
      PB_TEST_ROUNDS: JSON.stringify(options.rounds),
      PB_TEST_CONCURRENT: options.concurrent ? "1" : "0",
      PB_TEST_CONNECT_DELAY_MS: String(options.connectDelayMs ?? 0),
    },
  });
  const events: ChildEvent[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (raw.trim().length === 0) continue;
      try {
        events.push(JSON.parse(raw) as ChildEvent);
      } catch {
        /* 非 JSON 输出忽略 */
      }
    }
  });
  child.stderr.on("data", () => {});
  const handle: ChildHandle = {
    pid: child.pid ?? -1,
    events,
    waitFor(predicate, timeoutMs = 15000) {
      const start = Date.now();
      return new Promise<ChildEvent>((resolve, reject) => {
        const tick = () => {
          const found = events.find(predicate);
          if (found) {
            resolve(found);
            return;
          }
          if (Date.now() - start > timeoutMs) {
            reject(new Error(`waitFor timed out after ${timeoutMs}ms; events: ${JSON.stringify(events)}`));
            return;
          }
          setTimeout(tick, 20);
        };
        tick();
      });
    },
    kill() {
      child.kill("SIGKILL");
    },
  };
  activeChildren.push(child);
  return handle;
}

// ---------------------------------------------------------------------------
// broker harness（P1.5 套件同款）+ Step-6 引擎注入
// ---------------------------------------------------------------------------

const activeBrokers: PayswapBrokerHandle[] = [];

function sessionMapResolver(map: Record<string, string>): PayswapSessionScopeResolver {
  return (hint) => (hint in map ? { workspaceKey: map[hint] } : null);
}

function mintEntry(overrides: Partial<PayswapInstanceRegistryEntry> = {}): PayswapInstanceRegistryEntry {
  return {
    instanceId: randomUUID(),
    token: randomBytes(32).toString("hex"),
    childPid: -1,
    pluginRegistrationIdentity: "payswap@zcode-plugins-official",
    workspace: "ws-alpha",
    sessionScope: "ws-alpha",
    spawnedAt: Date.now(),
    ...overrides,
  };
}

function requestLine(
  entry: { instanceId: string; token: string },
  overrides: {
    seq?: number;
    op?: string;
    params?: unknown;
    token?: string;
    sessionId?: string;
    retiredSeqs?: number[];
    extra?: Record<string, unknown>;
  } = {},
): string {
  const request: Record<string, unknown> = {
    instanceId: entry.instanceId,
    seq: overrides.seq ?? 1,
    op: overrides.op ?? "get_account_overview",
    params: overrides.params ?? {},
    token: overrides.token ?? entry.token,
    sessionId: overrides.sessionId ?? "sess-a1",
  };
  if (overrides.retiredSeqs !== undefined) {
    request.retiredSeqs = overrides.retiredSeqs;
  }
  return JSON.stringify({ ...request, ...overrides.extra });
}

function customBootState(endpointPath: string): PayswapBrokerBootState {
  return { hostId: randomUUID(), keyPair: generateKeyPairSync("ed25519"), endpointPath };
}

/** Step-6 引擎的注入面（GREEN：boot 选项 seenRecords；RED：被忽略 → 引擎状态恒零）。 */
interface SeenRecordsLike {
  accept(instanceId: string, seq: number): { kind: "accepted" | "sequence_duplicate" | "sequence_gap_exceeded" };
  resolveRetirements(
    instanceId: string,
    retiredSeqs: readonly number[],
    carrierSeq: number,
  ): Array<{ seq: number; effect: "resolved_missing" | "ignored_already_accepted" | "ignored_nonsensical" }>;
  state(instanceId: string): { watermark: number; retained: readonly number[] };
}

interface SequenceAllocatorLike {
  allocate(): number;
  settle(seq: number, settlement: "answered" | "uncertain_delivery" | "provable_non_delivery"): void;
  retry(seq: number): number;
  retire(seq: number): void;
  pendingRetirements(): number[];
  takeRetirements(carrierSeq: number, maxEntries?: number): number[];
  isAllocated(seq: number): boolean;
}

interface ReplayExports {
  PAYSWAP_REPLAY_GAP_G: number;
  createPayswapSeenRecords: () => SeenRecordsLike;
  createPayswapSequenceAllocator: () => SequenceAllocatorLike;
}

let replayExports: ReplayExports | null = null;

/** RED 证据点：共享协议模块必须导出冻结常量与两侧引擎（§9.4(1)：G 唯一落点）。 */
async function loadReplayExports(): Promise<ReplayExports> {
  if (replayExports === null) {
    const mod = (await import("@zcode/shared/payswap")) as unknown as Record<string, unknown>;
    expect(mod.PAYSWAP_REPLAY_GAP_G, "§9.4(1): the frozen gap G must be exported from the shared protocol module (frozen at 64)").toBe(64);
    expect(mod.createPayswapSeenRecords, "§9.3: the seen-record engine must live in the shared protocol module").toBeTypeOf("function");
    expect(mod.createPayswapSequenceAllocator, "§9.3(5): the child-side allocator must live in the shared protocol module").toBeTypeOf("function");
    replayExports = {
      PAYSWAP_REPLAY_GAP_G: mod.PAYSWAP_REPLAY_GAP_G as number,
      createPayswapSeenRecords: mod.createPayswapSeenRecords as () => SeenRecordsLike,
      createPayswapSequenceAllocator: mod.createPayswapSequenceAllocator as () => SequenceAllocatorLike,
    };
  }
  return replayExports;
}

async function startBroker(
  overrides: Partial<PayswapBrokerBootOptions> & {
    bootState?: PayswapBrokerBootState;
    registry?: PayswapInstanceRegistry;
    seenRecords?: SeenRecordsLike;
  } = {},
): Promise<{
  handle: PayswapBrokerHandle;
  bootState: PayswapBrokerBootState;
  audit: PayswapBrokerAuditEvent[];
  registry: PayswapInstanceRegistry;
}> {
  const bootState = overrides.bootState ?? mintBrokerBootState();
  const registry = overrides.registry ?? createPayswapInstanceRegistry();
  const audit: PayswapBrokerAuditEvent[] = [];
  const { seenRecords, registry: _ignoredRegistry, ...bootOverrides } = overrides;
  const handle = await bootPayswapBroker({
    bootState,
    registry,
    auditSink: (event) => audit.push(event),
    sessionScopeResolver: sessionMapResolver({ "sess-a1": "ws-alpha", "sess-a2": "ws-alpha" }),
    ...bootOverrides,
    ...(seenRecords !== undefined ? ({ seenRecords } as { seenRecords?: SeenRecordsLike }) : {}),
  } as PayswapBrokerBootOptions);
  activeBrokers.push(handle);
  return { handle, bootState, audit, registry };
}

function oracleMaterial(bootState: PayswapBrokerBootState) {
  return {
    hostId: bootState.hostId,
    verifyKeyBase64: exportPublicKeyBase64(bootState.keyPair.publicKey),
  };
}

function attemptFor(
  entry: { instanceId: string },
  requestLineSent: string,
  op = "get_account_overview",
  seq = 1,
): PayswapBrokerAttemptContext {
  return { instanceId: entry.instanceId, seq, op, sentLine: requestLineSent };
}

/** request-attributed 桥接错误 oracle：验签通过 + ok:false + typed code + 指定 retryable。 */
function expectBridgeError(
  line: string,
  expectedCode: string,
  expectedRetryable: boolean,
  entry: { instanceId: string },
  sentLine: string,
  bootState: PayswapBrokerBootState,
  seq = 1,
): void {
  const verdict = verifyResponseEnvelope(line, attemptFor(entry, sentLine, "get_account_overview", seq), oracleMaterial(bootState));
  expect(verdict.ok, `§9 refusal must be a verifiable request-attributed envelope, got ${JSON.stringify(verdict)}`).toBe(true);
  if (!verdict.ok) return;
  expect(verdict.body.ok).toBe(false);
  const error = verdict.body.error as { code: string; retryable: boolean };
  expect(error.code).toBe(expectedCode);
  expect(error.retryable).toBe(expectedRetryable);
}

/** request-attributed 业务拒绝 oracle（§7.3 三码，经 §8 解析后到达 dispatch）。 */
function expectBusinessRefusal(
  line: string,
  expectedCode: string,
  entry: { instanceId: string },
  sentLine: string,
  bootState: PayswapBrokerBootState,
  seq = 1,
): void {
  const verdict = verifyResponseEnvelope(line, attemptFor(entry, sentLine, "get_account_overview", seq), oracleMaterial(bootState));
  expect(verdict.ok).toBe(true);
  if (!verdict.ok) return;
  expect(verdict.body.ok).toBe(true);
  const data = verdict.body.data as { kind: string; refusal?: { code: string; message: string } };
  expect(data.kind).toBe("refused");
  expect(data.refusal?.code).toBe(expectedCode);
}

/** 审计里的 (instanceId, seq) dispatch 计数 —— §9.5 零再 dispatch 断言的基础。 */
function dispatchedCount(audit: PayswapBrokerAuditEvent[], instanceId: string, seq: number): number {
  return audit.filter((event) => event.outcome === "dispatched" && event.instanceId === instanceId && event.seq === seq).length;
}

afterEach(async () => {
  for (const child of activeChildren.splice(0)) {
    child.kill("SIGKILL");
  }
  await Promise.allSettled(activeBrokers.splice(0).map((broker) => broker.close()));
});

// ---------------------------------------------------------------------------
// §9 法则 —— broker 集成（真实 UDS + 真实子进程对端；Linux 行，P1.3 纪律）
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== "linux")("P1.6 Step 6 — §9 replay protection (broker, Linux)", () => {
  it(
    "§9.2/§9.5 N33: a replayed (instanceId, seq) on a NEW connection is refused sequence_duplicate before dispatch — zero second dispatch",
    async () => {
      const { handle, bootState, audit } = await startBroker();
      const entry = mintEntry();
      const line = requestLine(entry, { seq: 1 });
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: [{ line }, { line }],
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const first = await child.waitFor((event) => event.t === "response" && event.round === 0);
      const second = await child.waitFor((event) => event.t === "response" && event.round === 1);
      // 首次：正常 dispatch（无 reader → S2 not_connected，三码业务拒绝）。
      expectBusinessRefusal(first.line as string, "not_connected", entry, line, bootState, 1);
      // 重放（新连接、同一逻辑请求）：typed 拒绝、不可重试、零再 dispatch。
      expectBridgeError(second.line as string, "sequence_duplicate", false, entry, line, bootState, 1);
      expect(dispatchedCount(audit, entry.instanceId, 1)).toBe(1);
    },
    20000,
  );

  it(
    "§9.2 N34: the dedupe record survives reconnect — a legit seq=2 on the reconnected session dispatches, then the seq=1 replay is still refused",
    async () => {
      const { handle, bootState, audit } = await startBroker();
      const entry = mintEntry();
      const line1 = requestLine(entry, { seq: 1 });
      const line2 = requestLine(entry, { seq: 2 });
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: [{ line: line1 }, { line: line2 }, { line: line1 }],
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const first = await child.waitFor((event) => event.t === "response" && event.round === 0);
      const second = await child.waitFor((event) => event.t === "response" && event.round === 1);
      const replay = await child.waitFor((event) => event.t === "response" && event.round === 2);
      expectBusinessRefusal(first.line as string, "not_connected", entry, line1, bootState, 1);
      expectBusinessRefusal(second.line as string, "not_connected", entry, line2, bootState, 2);
      expectBridgeError(replay.line as string, "sequence_duplicate", false, entry, line1, bootState, 1);
      expect(dispatchedCount(audit, entry.instanceId, 1)).toBe(1);
      expect(dispatchedCount(audit, entry.instanceId, 2)).toBe(1);
    },
    20000,
  );

  it(
    "§9.3(4) N35: two simultaneous connections presenting the same (instanceId, seq) produce exactly one dispatch and one sequence_duplicate",
    async () => {
      const { handle, bootState, audit } = await startBroker();
      const entry = mintEntry();
      const line = requestLine(entry, { seq: 1 });
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: [{ line }],
        concurrent: true,
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const responseA = await child.waitFor((event) => event.t === "response" && event.round === 0);
      const responseB = await child.waitFor((event) => event.t === "response" && event.round === 1);
      // 恰一次 dispatch + 恰一次 duplicate —— 顺序不定，按结局分拣。
      const outcomes = [responseA, responseB].map((event) => {
        const verdict = verifyResponseEnvelope(event.line as string, attemptFor(entry, line), oracleMaterial(bootState));
        expect(verdict.ok).toBe(true);
        if (!verdict.ok) throw new Error("unverifiable");
        return verdict.body.ok ? "dispatched" : (verdict.body.error as { code: string }).code;
      });
      outcomes.sort();
      expect(outcomes).toEqual(["dispatched", "sequence_duplicate"]);
      expect(dispatchedCount(audit, entry.instanceId, 1)).toBe(1);
    },
    20000,
  );

  it(
    "§9.3(3) N39: out-of-order retained-set arm — seq 12 completes before 11; a replay of 12 BEFORE 11 arrives is refused; 11 then advances the watermark through both",
    async () => {
      const { handle, bootState, audit } = await startBroker();
      const entry = mintEntry();
      const lines = [
        ...Array.from({ length: 10 }, (_, i) => requestLine(entry, { seq: i + 1 })),
        requestLine(entry, { seq: 12 }), // 11 被跳过（outstanding）
        requestLine(entry, { seq: 12 }), // 完成后的 12 重放 —— R 臂（W=10，12 ∈ R）
        requestLine(entry, { seq: 11 }), // 11 到达 —— 受理 + 水标连过 11、12
        requestLine(entry, { seq: 11 }), // 11 重放 —— ≤ W，duplicate
      ];
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: lines.map((line) => ({ line })),
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const responses: string[] = [];
      for (let round = 0; round < lines.length; round += 1) {
        const event = await child.waitFor((e) => e.t === "response" && e.round === round);
        responses.push(event.line as string);
      }
      for (let i = 0; i < 10; i += 1) {
        expectBusinessRefusal(responses[i], "not_connected", entry, lines[i], bootState, i + 1);
      }
      expectBusinessRefusal(responses[10], "not_connected", entry, lines[10], bootState, 12);
      // R 臂：12 已完成但未被水标覆盖 —— 11 到达前的重放必须拒绝。
      expectBridgeError(responses[11], "sequence_duplicate", false, entry, lines[11], bootState, 12);
      // 11 到达 → 受理；水标连过 11、12。
      expectBusinessRefusal(responses[12], "not_connected", entry, lines[12], bootState, 11);
      // 11 此后 ≤ W —— 重放拒绝。
      expectBridgeError(responses[13], "sequence_duplicate", false, entry, lines[13], bootState, 11);
      expect(dispatchedCount(audit, entry.instanceId, 11)).toBe(1);
      expect(dispatchedCount(audit, entry.instanceId, 12)).toBe(1);
    },
    25000,
  );

  it(
    "§9.4 boundary rows: with W pinned at 3, seq = W+64 is accepted; seq = W+65 is refused sequence_gap_exceeded (retryable)",
    async () => {
      const { handle, bootState, audit } = await startBroker();
      const entry = mintEntry();
      const lines = [
        requestLine(entry, { seq: 1 }),
        requestLine(entry, { seq: 2 }),
        requestLine(entry, { seq: 3 }),
        requestLine(entry, { seq: 67 }), // W+64 —— 受理
        requestLine(entry, { seq: 68 }), // W+65 —— 拒绝
      ];
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: lines.map((line) => ({ line })),
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const responses: string[] = [];
      for (let round = 0; round < lines.length; round += 1) {
        const event = await child.waitFor((e) => e.t === "response" && e.round === round);
        responses.push(event.line as string);
      }
      for (let i = 0; i < 3; i += 1) {
        expectBusinessRefusal(responses[i], "not_connected", entry, lines[i], bootState, i + 1);
      }
      expectBusinessRefusal(responses[3], "not_connected", entry, lines[3], bootState, 67);
      // §6.3：sequence_gap_exceeded retryable = yes（补缺后可重试）。
      expectBridgeError(responses[4], "sequence_gap_exceeded", true, entry, lines[4], bootState, 68);
      expect(dispatchedCount(audit, entry.instanceId, 67)).toBe(1);
      expect(dispatchedCount(audit, entry.instanceId, 68)).toBe(0);
    },
    20000,
  );

  it(
    "§9.4(3) memory bound: |R| ≤ G at all times under an adversarial in-window gap flood, asserted after every step; a beyond-window attempt is refused and changes nothing",
    async () => {
      const replay = await loadReplayExports();
      const engine = replay.createPayswapSeenRecords();
      const { handle, bootState } = await startBroker({ seenRecords: engine });
      const entry = mintEntry();
      // 洪泛序（全部 ≤ W+G=64 才可能受理）：高-低交错逼近窗口边界的最大张力；
      // 末轮打 W+G+1=129（越界）—— 同一实例、同一子进程对端。
      const flood: number[] = [];
      for (let high = 64, low = 1; low <= 32; high -= 1, low += 1) {
        flood.push(high, low);
      }
      flood.push(129); // 越界臂
      const lines = flood.map((seq) => requestLine(entry, { seq }));
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: lines.map((line) => ({ line })),
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      for (let round = 0; round < lines.length - 1; round += 1) {
        await child.waitFor((e) => e.t === "response" && e.round === round);
        // 每一步之后断言内存界（§9.4(3)：retained-set size asserted after every step）。
        const state = engine.state(entry.instanceId);
        expect(
          state.retained.length,
          `|R| must stay ≤ G=64 after step ${round} (seq ${flood[round]}); state=${JSON.stringify(state)}`,
        ).toBeLessThanOrEqual(64);
      }
      // 交错序列覆盖 1..64 全集 → 水标连过到 64、R 清空。
      const stateBefore = engine.state(entry.instanceId);
      expect(stateBefore.watermark).toBe(64);
      expect(stateBefore.retained.length).toBe(0);
      const beyondEvent = await child.waitFor((e) => e.t === "response" && e.round === lines.length - 1);
      expectBridgeError(beyondEvent.line as string, "sequence_gap_exceeded", true, entry, lines[lines.length - 1], bootState, 129);
      // 越界拒绝不产生任何状态变化。
      const stateAfter = engine.state(entry.instanceId);
      expect(stateAfter.watermark).toBe(64);
      expect(stateAfter.retained.length).toBe(0);
    },
    25000,
  );

  it(
    "§9.3(6) lying retirement (accepted seq): retiring a seq ≤ W is ignored — the replay of that seq is still sequence_duplicate and the watermark is unmoved",
    async () => {
      const replay = await loadReplayExports();
      const engine = replay.createPayswapSeenRecords();
      const { handle, bootState, audit } = await startBroker({ seenRecords: engine });
      const entry = mintEntry();
      const line1 = requestLine(entry, { seq: 1 });
      const line2 = requestLine(entry, { seq: 2, retiredSeqs: [1] }); // 谎报：1 已受理（≤ W）
      const line3 = requestLine(entry, { seq: 1 }); // 1 重放仍 duplicate（退役无效果）
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: [{ line: line1 }, { line: line2 }, { line: line3 }],
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const r1 = await child.waitFor((e) => e.t === "response" && e.round === 0);
      const r2 = await child.waitFor((e) => e.t === "response" && e.round === 1);
      const r3 = await child.waitFor((e) => e.t === "response" && e.round === 2);
      expectBusinessRefusal(r1.line as string, "not_connected", entry, line1, bootState, 1);
      expectBusinessRefusal(r2.line as string, "not_connected", entry, line2, bootState, 2);
      expectBridgeError(r3.line as string, "sequence_duplicate", false, entry, line3, bootState, 1);
      // 引擎态：水标因 seq 2 的受理与 1 的既有覆盖推进到 2（谎报 1 无效果、无扰动）。
      const state = engine.state(entry.instanceId);
      expect(state.watermark).toBe(2);
      expect(state.retained).toEqual([]);
      // §9.3(6)：退役条目带效果入审计 —— 已受理的谎报记 ignored_already_accepted。
      const retiredEvents = audit.filter((event) => event.outcome === "retired" && event.seq === 1);
      expect(retiredEvents.length).toBe(1);
      expect(retiredEvents[0].code).toBe("ignored_already_accepted");
      expect(dispatchedCount(audit, entry.instanceId, 1)).toBe(1);
    },
    20000,
  );

  it(
    "§9.3(6) lying retirement (in-R seq): retiring an out-of-order completed seq ∈ R is ignored; the later watermark advance through it is undisturbed",
    async () => {
      const replay = await loadReplayExports();
      const engine = replay.createPayswapSeenRecords();
      const { handle, bootState, audit } = await startBroker({ seenRecords: engine });
      const entry = mintEntry();
      const lines = [
        requestLine(entry, { seq: 1 }),
        requestLine(entry, { seq: 3 }), // 2 outstanding
        requestLine(entry, { seq: 4, retiredSeqs: [3] }), // 谎报：3 ∈ R（完成未覆盖）
        requestLine(entry, { seq: 2 }), // 2 到达 → 水标连过 2、3（谎报未拆 3 出 R）
        requestLine(entry, { seq: 3 }), // 3 重放 → duplicate（≤ W）
      ];
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: lines.map((line) => ({ line })),
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const responses: string[] = [];
      for (let round = 0; round < lines.length; round += 1) {
        const event = await child.waitFor((e) => e.t === "response" && e.round === round);
        responses.push(event.line as string);
      }
      expectBusinessRefusal(responses[0], "not_connected", entry, lines[0], bootState, 1);
      expectBusinessRefusal(responses[1], "not_connected", entry, lines[1], bootState, 3);
      expectBusinessRefusal(responses[2], "not_connected", entry, lines[2], bootState, 4);
      expectBusinessRefusal(responses[3], "not_connected", entry, lines[3], bootState, 2);
      expectBridgeError(responses[4], "sequence_duplicate", false, entry, lines[4], bootState, 3);
      const state = engine.state(entry.instanceId);
      expect(state.watermark).toBe(4);
      expect(state.retained).toEqual([]);
      const retiredEvents = audit.filter((event) => event.outcome === "retired" && event.seq === 3);
      expect(retiredEvents.length).toBe(1);
      expect(retiredEvents[0].code).toBe("ignored_already_accepted");
      expect(dispatchedCount(audit, entry.instanceId, 3)).toBe(1);
    },
    25000,
  );

  it(
    "§9.3(6) retire-then-send: a truthfully retired in-window seq becomes resolved-missing (watermark advances); sending it afterwards is sequence_duplicate with zero dispatch",
    async () => {
      const replay = await loadReplayExports();
      const engine = replay.createPayswapSeenRecords();
      const { handle, bootState, audit } = await startBroker({ seenRecords: engine });
      const entry = mintEntry();
      const lines = [
        requestLine(entry, { seq: 1 }),
        // 载体 seq 3，退役 outstanding 的 2（真报：W=1 < 2 < 3，从未受理）。
        requestLine(entry, { seq: 3, retiredSeqs: [2] }),
        // 违诺发送已退役的 2 —— fail-closed：sequence_duplicate（≤ W）、零 dispatch。
        requestLine(entry, { seq: 2 }),
      ];
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: lines.map((line) => ({ line })),
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const responses: string[] = [];
      for (let round = 0; round < lines.length; round += 1) {
        const event = await child.waitFor((e) => e.t === "response" && e.round === round);
        responses.push(event.line as string);
      }
      expectBusinessRefusal(responses[0], "not_connected", entry, lines[0], bootState, 1);
      expectBusinessRefusal(responses[1], "not_connected", entry, lines[1], bootState, 3);
      expectBridgeError(responses[2], "sequence_duplicate", false, entry, lines[2], bootState, 2);
      const state = engine.state(entry.instanceId);
      expect(state.watermark).toBe(3);
      expect(state.retained).toEqual([]);
      const retiredEvents = audit.filter((event) => event.outcome === "retired" && event.seq === 2);
      expect(retiredEvents.length).toBe(1);
      expect(retiredEvents[0].code).toBe("resolved_missing");
      expect(dispatchedCount(audit, entry.instanceId, 2)).toBe(0);
    },
    20000,
  );

  it(
    "§9.3(6)/§6.1(4) nonsensical declarations are tolerated (protocol note, never request_invalid): entries ≥ carrier seq, duplicates in-array, non-increasing — the carrier still dispatches",
    async () => {
      const { handle, bootState, audit } = await startBroker();
      const entry = mintEntry();
      // [4(≥载体 seq 4), 2, 2(重复), 1(非递增)] —— 全部 nonsensical，载体正常受理。
      const line = requestLine(entry, { seq: 4, retiredSeqs: [4, 2, 2, 1] });
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: [{ line }],
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((e) => e.t === "response" && e.round === 0);
      expectBusinessRefusal(response.line as string, "not_connected", entry, line, bootState, 4);
      // 语义性错报是协议注记（audit），绝不 request_invalid（§6.1(4)：仅形状违例才是）。
      const retiredEvents = audit.filter((event) => event.outcome === "retired");
      const effects = retiredEvents.map((event) => `${event.seq}:${event.code}`);
      expect(effects).toContain("4:ignored_nonsensical");
      expect(effects).toContain("2:ignored_nonsensical");
      expect(effects).toContain("1:ignored_nonsensical");
      expect(audit.some((event) => event.outcome === "refused" && event.code === "request_invalid")).toBe(false);
    },
    20000,
  );

  it(
    "§6.1(4) schema bound (pin): retiredSeqs with 9 entries is request_invalid; non-positive/non-integer entries are request_invalid (shape violations, not semantic tolerance)",
    async () => {
      const { handle, bootState } = await startBroker();
      const entry = mintEntry();
      const nine = requestLine(entry, { seq: 2, retiredSeqs: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: [{ line: nine }],
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((e) => e.t === "response" && e.round === 0);
      // 形状违例 → request_invalid（pre-binding null-bound —— 验签器视角 instance_mismatch）。
      const verdict = verifyResponseEnvelope(response.line as string, attemptFor(entry, nine), oracleMaterial(bootState));
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toBe("instance_mismatch");
    },
    20000,
  );

  it(
    "§9.3(6) rev 2a — carrier-fate independence (gap arm): a gap-refused carrier's retirements are still processed",
    async () => {
      const replay = await loadReplayExports();
      const engine = replay.createPayswapSeenRecords();
      const { handle, bootState } = await startBroker({ seenRecords: engine });
      const entry = mintEntry();
      // W=0；载体 seq 70（> 64 → gap 拒）携带退役 [1..5]（真报）。
      const carrier = requestLine(entry, { seq: 70, retiredSeqs: [1, 2, 3, 4, 5] });
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: [{ line: carrier }],
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((e) => e.t === "response" && e.round === 0);
      expectBridgeError(response.line as string, "sequence_gap_exceeded", true, entry, carrier, bootState, 70);
      // 载体被拒，其退役仍处理（rev 2a）：W 推进到 5 —— 下一载体 seq 69 现在在窗内。
      const state = engine.state(entry.instanceId);
      expect(state.watermark).toBe(5);
      expect(state.retained).toEqual([]);
    },
    20000,
  );

  it(
    "§9.3(6) rev 2a — carrier-fate independence (§8 arm): a session_unresolvable carrier's retirements are still processed",
    async () => {
      const replay = await loadReplayExports();
      const engine = replay.createPayswapSeenRecords();
      const { handle, bootState } = await startBroker({ seenRecords: engine });
      const entry = mintEntry();
      // 载体（未知 hint → session_unresolvable）携带退役 [1..4]。
      const carrier = requestLine(entry, { seq: 6, sessionId: "sess-no-such", retiredSeqs: [1, 2, 3, 4] });
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: [{ line: carrier }],
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((e) => e.t === "response" && e.round === 0);
      expectBridgeError(response.line as string, "session_unresolvable", false, entry, carrier, bootState, 6);
      // §8 拒绝的载体过了步 (1)-(4) → 退役仍处理：W=4（5 未声明、留缺口 —— 如实）。
      const state = engine.state(entry.instanceId);
      expect(state.watermark).toBe(4);
      expect(state.retained).toEqual([]);
    },
    20000,
  );

  it(
    "§9.3(6) rev 2a — carrier-fate independence (duplicate arm): an out-of-order replayed carrier's retirements are still processed",
    async () => {
      const replay = await loadReplayExports();
      const engine = replay.createPayswapSeenRecords();
      const { handle, bootState } = await startBroker({ seenRecords: engine });
      const entry = mintEntry();
      const first = requestLine(entry, { seq: 1 });
      const third = requestLine(entry, { seq: 3 }); // 2 outstanding
      // 重放载体：seq 3 ∈ R（out-of-order duplicate）携带退役 [2]（真报 outstanding）。
      const replayCarrier = requestLine(entry, { seq: 3, retiredSeqs: [2] });
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: [{ line: first }, { line: third }, { line: replayCarrier }],
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const r1 = await child.waitFor((e) => e.t === "response" && e.round === 0);
      const r2 = await child.waitFor((e) => e.t === "response" && e.round === 1);
      const r3 = await child.waitFor((e) => e.t === "response" && e.round === 2);
      expectBusinessRefusal(r1.line as string, "not_connected", entry, first, bootState, 1);
      expectBusinessRefusal(r2.line as string, "not_connected", entry, third, bootState, 3);
      expectBridgeError(r3.line as string, "sequence_duplicate", false, entry, replayCarrier, bootState, 3);
      // duplicate 载体的退役仍处理：2 → resolved-missing，水标连过 2（M）与 3（R）。
      const state = engine.state(entry.instanceId);
      expect(state.watermark).toBe(3);
      expect(state.retained).toEqual([]);
    },
    20000,
  );

  it(
    "§9.3(6) wedge recovery: after > G abandoned sequences, retirement-carrying carriers that individually fail the gap test recover the watermark until a carrier is accepted",
    async () => {
      const replay = await loadReplayExports();
      const engine = replay.createPayswapSeenRecords();
      const { handle, bootState } = await startBroker({ seenRecords: engine });
      const entry = mintEntry();
      // 放弃 1..80（从未发送）；载体 seq 81，每轮携带 ≤8 条退役。
      // 81 > 64 → 拒；W=8。重试（同逻辑请求）：81 > 72 → 拒；W=16。81 > 80 → 拒；W=24。
      // 第四次：81 ≤ 88 → 受理。三次"个体失败"的载体纯靠退役推进水标恢复。
      const carriers = [
        requestLine(entry, { seq: 81, retiredSeqs: [1, 2, 3, 4, 5, 6, 7, 8] }),
        requestLine(entry, { seq: 81, retiredSeqs: [9, 10, 11, 12, 13, 14, 15, 16] }),
        requestLine(entry, { seq: 81, retiredSeqs: [17, 18, 19, 20, 21, 22, 23, 24] }),
        requestLine(entry, { seq: 81, retiredSeqs: [25, 26, 27, 28, 29, 30, 31, 32] }),
      ];
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: carriers.map((line) => ({ line })),
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const r1 = await child.waitFor((e) => e.t === "response" && e.round === 0);
      const r2 = await child.waitFor((e) => e.t === "response" && e.round === 1);
      const r3 = await child.waitFor((e) => e.t === "response" && e.round === 2);
      const r4 = await child.waitFor((e) => e.t === "response" && e.round === 3);
      expectBridgeError(r1.line as string, "sequence_gap_exceeded", true, entry, carriers[0], bootState, 81);
      expectBridgeError(r2.line as string, "sequence_gap_exceeded", true, entry, carriers[1], bootState, 81);
      expectBridgeError(r3.line as string, "sequence_gap_exceeded", true, entry, carriers[2], bootState, 81);
      expectBusinessRefusal(r4.line as string, "not_connected", entry, carriers[3], bootState, 81);
      // 水标：24（受理 81 后连过 25..32 之外的…… —— 25..32 resolved + 81 accepted：
      // 连续覆盖 1..32 ∪ {81} → W=32；81 ∈ R（33 未到）。
      const state = engine.state(entry.instanceId);
      expect(state.watermark).toBe(32);
      expect(state.retained).toEqual([81]);
    },
    25000,
  );

  it(
    "D8.1 — an §8-refused request does not burn its sequence: the same logical request re-sent after the session resolves dispatches (not sequence_duplicate)",
    async () => {
      const { handle, bootState, audit } = await startBroker();
      const entry = mintEntry();
      const refused = requestLine(entry, { seq: 1, sessionId: "sess-no-such" });
      const retried = requestLine(entry, { seq: 1 });
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: [{ line: refused }, { line: retried }],
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const r1 = await child.waitFor((e) => e.t === "response" && e.round === 0);
      const r2 = await child.waitFor((e) => e.t === "response" && e.round === 1);
      expectBridgeError(r1.line as string, "session_unresolvable", false, entry, refused, bootState, 1);
      // pre-dispatch 拒绝不烧序列：同 seq 重发 → 正常 dispatch（非 duplicate）。
      expectBusinessRefusal(r2.line as string, "not_connected", entry, retried, bootState, 1);
      expect(dispatchedCount(audit, entry.instanceId, 1)).toBe(1);
    },
    20000,
  );

  it(
    "§9.2 disabled-instance arm: residual NEW requests still answer financial_mode_disabled, and the arm consumes sequences — a replay is sequence_duplicate",
    async () => {
      const registry = createPayswapInstanceRegistry();
      const { handle, bootState, audit } = await startBroker({ registry });
      const entry = mintEntry();
      const line1 = requestLine(entry, { seq: 1 });
      const line2 = requestLine(entry, { seq: 1 }); // 重放
      const line3 = requestLine(entry, { seq: 2 }); // 残留新调用
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: [{ line: line1 }, { line: line2 }, { line: line3 }],
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      // disable 撤销（§10.2(2)）在首个请求之前 —— D5.6：注册表撤销是权威。
      registry.tombstone(entry.instanceId, "disabled");
      const r1 = await child.waitFor((e) => e.t === "response" && e.round === 0);
      const r2 = await child.waitFor((e) => e.t === "response" && e.round === 1);
      const r3 = await child.waitFor((e) => e.t === "response" && e.round === 2);
      expectBusinessRefusal(r1.line as string, "financial_mode_disabled", entry, line1, bootState, 1);
      // 禁用臂的请求照常过 §9.5 受理边界 —— 重放是重放。
      expectBridgeError(r2.line as string, "sequence_duplicate", false, entry, line2, bootState, 1);
      // 残留新调用仍答三码 row 1。
      expectBusinessRefusal(r3.line as string, "financial_mode_disabled", entry, line3, bootState, 2);
      expect(dispatchedCount(audit, entry.instanceId, 1)).toBe(1);
      expect(dispatchedCount(audit, entry.instanceId, 2)).toBe(1);
    },
    20000,
  );
});

// ---------------------------------------------------------------------------
// §9.3(5) 子进程侧序列分配纪律（纯逻辑 —— 共享模块单元行）
// ---------------------------------------------------------------------------

describe("P1.6 Step 6 — §9.3(5) child-side sequence allocation discipline (allocator, pure)", () => {
  it(
    "§9.3(5) send-boundary allocation: allocate() is the only seq source, monotonic from 1; a cancelled-before-send request consumes nothing (there is no reservation path)",
    async () => {
      const replay = await loadReplayExports();
      const allocator = replay.createPayswapSequenceAllocator();
      // 两个发送边界分配：1、2。
      expect(allocator.allocate()).toBe(1);
      expect(allocator.allocate()).toBe(2);
      // 取消发生在发送之前 → 无 seq 可消耗（未调用 allocate —— 分配只发生在发送边界）；
      // 下一次发送边界分配仍是连续的 3。
      expect(allocator.allocate()).toBe(3);
      expect(allocator.isAllocated(1)).toBe(true);
      expect(allocator.isAllocated(3)).toBe(true);
      expect(allocator.isAllocated(4)).toBe(false);
    },
    10000,
  );

  it(
    "§9.3(5) uncertain delivery retains the seq: settle(uncertain) → retry() hands back the SAME seq and consumes no new allocation",
    async () => {
      const replay = await loadReplayExports();
      const allocator = replay.createPayswapSequenceAllocator();
      expect(allocator.allocate()).toBe(1); // 发送边界；写中途连接断（不确定投递）
      allocator.settle(1, "uncertain_delivery");
      expect(allocator.retry(1)).toBe(1); // 同逻辑请求重试 —— 同 seq
      expect(allocator.allocate()).toBe(2); // 新逻辑请求才消耗新 seq
    },
    10000,
  );

  it(
    "§9.3(5) provable non-delivery: retry with the same seq (always safe) or retire — both close without a permanent gap",
    async () => {
      const replay = await loadReplayExports();
      const allocator = replay.createPayswapSequenceAllocator();
      expect(allocator.allocate()).toBe(1);
      allocator.settle(1, "provable_non_delivery"); // 首写 0 字节（EPIPE）
      expect(allocator.retry(1)).toBe(1); // 同 seq 重试臂
      const other = replay.createPayswapSequenceAllocator();
      expect(other.allocate()).toBe(1);
      other.settle(1, "provable_non_delivery");
      other.retire(1); // 退役臂 —— 无永久缺口（下一载体声明）
      expect(other.pendingRetirements()).toEqual([1]);
      expect(other.allocate()).toBe(2); // 退役的 1 永不复用
    },
    10000,
  );

  it(
    "§9.3(5)/(6) abandonment: retire() queues the declaration; takeRetirements(carrierSeq) returns ≤8 strictly-increasing entries each < carrierSeq and removes them from pending",
    async () => {
      const replay = await loadReplayExports();
      const allocator = replay.createPayswapSequenceAllocator();
      for (let i = 1; i <= 12; i += 1) {
        expect(allocator.allocate()).toBe(i);
        if (i <= 12) allocator.settle(i, i % 2 === 0 ? "uncertain_delivery" : "provable_non_delivery");
      }
      // 12 个全部放弃 → 退役声明入队。
      for (let i = 1; i <= 12; i += 1) {
        allocator.retire(i);
      }
      expect(allocator.pendingRetirements()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      // 载体 seq 13：首批 ≤8、严格递增、均 < 13。
      const batch1 = allocator.takeRetirements(13);
      expect(batch1).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      // 剩余 4 条由后续载体携带 —— 12 个 hole 由两次载体关闭，无永久缺口。
      const batch2 = allocator.takeRetirements(14);
      expect(batch2).toEqual([9, 10, 11, 12]);
      expect(allocator.pendingRetirements()).toEqual([]);
      // 批上限参数（缺省 8）与载体 seq 上界共同约束。
      allocator.retire(5); // 载体丢失后的再声明 —— broker 容忍（§9.3(6) ignore 规则）
      expect(allocator.takeRetirements(20)).toEqual([5]);
    },
    10000,
  );

  it(
    "§9.3(5) never-reuse: answered / retired seqs are never re-allocated; retry of an answered seq is a programming error (typed throw, not a silent new seq)",
    async () => {
      const replay = await loadReplayExports();
      const allocator = replay.createPayswapSequenceAllocator();
      expect(allocator.allocate()).toBe(1);
      allocator.settle(1, "answered"); // 已获验证响应 —— 关闭
      expect(allocator.allocate()).toBe(2);
      expect(() => allocator.retry(1)).toThrow(); // 已答 seq 不可重试（新逻辑请求 = 新 seq）
      allocator.retire(2); // 2 弃用
      expect(allocator.allocate()).toBe(3); // 永不复用 1/2
      expect(allocator.pendingRetirements()).toEqual([2]);
    },
    10000,
  );
});

// ---------------------------------------------------------------------------
// §9.3(5) 两种投递情形 —— broker 集成（真实 UDS + 真实子进程对端）
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== "linux")("P1.6 Step 6 — §9.3(5) both delivery situations (broker integration, Linux)", () => {
  it(
    "uncertain delivery where the original ARRIVED: the same-seq retry is refused sequence_duplicate (typed failure surfaced); re-issuing the operation as a NEW logical request dispatches",
    async () => {
      const { handle, bootState, audit } = await startBroker();
      const entry = mintEntry();
      const original = requestLine(entry, { seq: 5 });
      const retry = requestLine(entry, { seq: 5 }); // 同逻辑请求（同 seq）
      const reissue = requestLine(entry, { seq: 6 }); // 新逻辑请求（新 seq）
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        rounds: [{ line: original }, { line: retry }, { line: reissue }],
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const r1 = await child.waitFor((e) => e.t === "response" && e.round === 0);
      const r2 = await child.waitFor((e) => e.t === "response" && e.round === 1);
      const r3 = await child.waitFor((e) => e.t === "response" && e.round === 2);
      expectBusinessRefusal(r1.line as string, "not_connected", entry, original, bootState, 5);
      // 原请求已到达（实际拿到了响应，子进程侧"没看到"）→ 同 seq 重试 = 重放。
      expectBridgeError(r2.line as string, "sequence_duplicate", false, entry, retry, bootState, 5);
      // 重发操作是调用方的显式决定 —— 新逻辑请求、新 seq → dispatch。
      expectBusinessRefusal(r3.line as string, "not_connected", entry, reissue, bootState, 6);
      expect(dispatchedCount(audit, entry.instanceId, 5)).toBe(1);
      expect(dispatchedCount(audit, entry.instanceId, 6)).toBe(1);
    },
    20000,
  );

  it(
    "uncertain delivery where the original NEVER ARRIVED (dropped pre-write connection): the same-seq retry is accepted and dispatched exactly once",
    async () => {
      const { handle, bootState, audit } = await startBroker();
      const entry = mintEntry();
      const line = requestLine(entry, { seq: 7 });
      const child = spawnRoundsChild({
        path: handle.endpointPath,
        connectDelayMs: 300,
        // 轮 0：连接后不写、50ms 销毁（原请求从未到达 —— 分配边界之后、字节移交之前）。
        // 轮 1：同 seq 重试 —— 首次受理、恰一次 dispatch。
        rounds: [{ drop: true }, { line }],
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      await child.waitFor((e) => e.t === "closed" && e.round === 0);
      const response = await child.waitFor((e) => e.t === "response" && e.round === 1);
      expectBusinessRefusal(response.line as string, "not_connected", entry, line, bootState, 7);
      expect(dispatchedCount(audit, entry.instanceId, 7)).toBe(1);
    },
    20000,
  );
});
