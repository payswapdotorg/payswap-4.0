import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  createPayswapInstanceRegistry,
  exportPublicKeyBase64,
  mintBrokerBootState,
  PAYSWAP_BROKER_OPS,
  verifyResponseEnvelope,
  type PayswapBrokerAttemptContext,
  type PayswapBrokerBootState,
  type PayswapInstanceRegistry,
  type PayswapInstanceRegistryEntry,
} from "@zcode/shared/payswap";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootPayswapBroker,
  createPayswapBrokerDispatch,
  type PayswapBrokerAuditEvent,
  type PayswapBrokerBootOptions,
  type PayswapBrokerHandle,
  type PayswapBrokerLiveState,
} from "../src/payswap-broker/index.js";

/**
 * PaySwap P1.4 Step 4 —— 闭集六操作 dispatch 表 + §6.1 完整 `.strict()` 请求 schema +
 * §7.3 三码法则（live 状态读取）的对抗性测试（契约 w2-01 §6、§7、§12；playbook §4.2
 * RED-first）。
 *
 * 纪律（§12.1 binding order）：本文件的对抗行先于实现代码落盘（RED）；实现提交（GREEN）
 * 必须逐行转绿。对端身份用**真实派生的子进程**；签名信封用共享模块作 oracle
 * （§6.4(5) 单一实现）。
 *
 * 拒绝信封的两种绑定形状（§6.4(3)）：
 * - **pre-binding**（§5.5 步 (2) 的请求级 schema 违例：未知键 / token 形状 / op 越枚举…）
 *   → null-bound：绑定字段全 null，`verifyResponseEnvelope` 判 `instance_mismatch`；
 * - **post-binding**（绑定完成后：per-op params 违例、reader 故障 internal_error）
 *   → request-attributed：绑定字段齐全，验签通过，`ok:false` error body 或三码业务拒绝。
 *
 * 三码法则（§7.3，单一事实源 = 插件契约的三个 code；broker 只回答其一）：
 *   disabled/uninstalled 残留调用 → `financial_mode_disabled`（§10.2(2) tombstone 与
 *   live reader 双臂）；enabled + 未 opt-in → `not_opted_in`（S1）；enabled + opted-in +
 *   无账户 → `not_connected`（S2，本 wave 无账户模型 —— §13）。
 */

// ---------------------------------------------------------------------------
// 子进程客户端（真实对端：连接 + 写行 —— 由 env 驱动；P1.3 套件同款纪律）
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `
const net = require("node:net");
const path = process.env.PB_TEST_PATH;
const lineArg = process.env.PB_TEST_LINE || "";
const mode = process.env.PB_TEST_MODE || "line";
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
const s = net.connect(path, () => {
  send({ t: "connected" });
  if (mode === "line") s.write(lineArg + "\\n");
  else if (mode === "two-connections") {
    // 同一子进程的两次顺序连接（§3.3 一请求一连接；同一实例跨连接 —— T3 live-flip）。
    s.write(lineArg + "\\n");
  }
  // mode === "idle": 连接后什么都不写
});
let acc = "";
let secondDone = false;
s.on("data", (d) => {
  acc += d.toString("utf8");
  let i;
  while ((i = acc.indexOf("\\n")) >= 0) {
    send({ t: "response", line: acc.slice(0, i) });
    acc = acc.slice(i + 1);
    if (mode === "two-connections" && !secondDone) {
      secondDone = true;
      const line2 = process.env.PB_TEST_LINE_2 || "";
      // 首响应后延迟再开第二连接：父侧的 live-flip（T3）需要先落地。
      setTimeout(() => {
        const s2 = net.connect(path, () => { s2.write(line2 + "\\n"); });
        let acc2 = "";
        s2.on("data", (d2) => {
          acc2 += d2.toString("utf8");
          let j;
          while ((j = acc2.indexOf("\\n")) >= 0) { send({ t: "response", line: acc2.slice(0, j) }); acc2 = acc2.slice(j + 1); }
        });
        s2.on("close", () => { send({ t: "close" }); process.exit(0); });
        s2.on("error", (e) => { send({ t: "error", code: e.code }); process.exit(0); });
      }, 400);
    }
  }
});
s.on("close", () => {
  // two-connections：首连接关闭（§3.3 服务端收尾）不能退出 —— 第二连接尚未应答。
  if (mode !== "two-connections") { send({ t: "close" }); process.exit(0); }
});
s.on("error", (e) => { send({ t: "error", code: e.code }); process.exit(0); });
setTimeout(() => process.exit(0), 20000);
`;

interface ChildEvent {
  t: "connected" | "response" | "close" | "error";
  line?: string;
  code?: string;
}

interface ChildHandle {
  readonly pid: number;
  readonly events: ChildEvent[];
  waitFor(predicate: (event: ChildEvent) => boolean, timeoutMs?: number): Promise<ChildEvent>;
  kill(): void;
}

function spawnClientChild(options: { path: string; line: string; line2?: string; mode?: string }): ChildHandle {
  const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      PB_TEST_PATH: options.path,
      PB_TEST_LINE: options.line,
      PB_TEST_LINE_2: options.line2 ?? "",
      PB_TEST_MODE: options.mode ?? "line",
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
        /* 子进程非 JSON 输出忽略 */
      }
    }
  });
  child.stderr.on("data", () => {
    /* 测试子进程的 stderr 不影响判定 */
  });
  const handle: ChildHandle = {
    pid: child.pid ?? -1,
    events,
    waitFor(predicate, timeoutMs = 10000) {
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
// broker / 实例 / oracle helper（P1.3 套件同款）
// ---------------------------------------------------------------------------

const activeBrokers: PayswapBrokerHandle[] = [];
const activeChildren: ReturnType<typeof spawn>[] = [];

function mintEntry(overrides: Partial<PayswapInstanceRegistryEntry> = {}): PayswapInstanceRegistryEntry {
  return {
    instanceId: randomUUID(),
    token: randomBytes(32).toString("hex"),
    childPid: -1,
    pluginRegistrationIdentity: "payswap@zcode-plugins-official",
    workspace: "ws-test",
    sessionScope: "sess-test",
    spawnedAt: Date.now(),
    ...overrides,
  };
}

function requestLine(
  entry: { instanceId: string; token: string },
  overrides: { seq?: number; op?: string; params?: unknown; extra?: Record<string, unknown>; token?: string; sessionId?: string } = {},
): string {
  const request: Record<string, unknown> = {
    instanceId: entry.instanceId,
    seq: overrides.seq ?? 1,
    op: overrides.op ?? "get_account_overview",
    params: overrides.params ?? {},
    token: overrides.token ?? entry.token,
    sessionId: overrides.sessionId ?? "sess-test",
    ...overrides.extra,
  };
  return JSON.stringify(request);
}

function customBootState(endpointPath: string): PayswapBrokerBootState {
  return { hostId: randomUUID(), keyPair: generateKeyPairSync("ed25519"), endpointPath };
}

async function startBroker(
  overrides: Partial<PayswapBrokerBootOptions> & { bootState?: PayswapBrokerBootState } = {},
): Promise<{
  handle: PayswapBrokerHandle;
  bootState: PayswapBrokerBootState;
  audit: PayswapBrokerAuditEvent[];
}> {
  const bootState = overrides.bootState ?? mintBrokerBootState();
  const audit: PayswapBrokerAuditEvent[] = [];
  const handle = await bootPayswapBroker({
    bootState,
    auditSink: (event) => audit.push(event),
    // P1.5 Step 5（§8）起 live 实例请求须经会话解析才能到达三码法则 —— 本套件的行
    // 一直都以 "sess-test" 为合法 hint（= 注册条目的 sessionScope），缺省 resolver 把
    // 它解析进 scope；显式 undefined 可退回 fail-closed 臂（session-scope 套件覆盖）。
    sessionScopeResolver: (hint) => (hint === "sess-test" ? { workspaceKey: "sess-test" } : null),
    ...overrides,
  });
  activeBrokers.push(handle);
  return { handle, bootState, audit };
}

function oracleMaterial(bootState: PayswapBrokerBootState) {
  return {
    hostId: bootState.hostId,
    verifyKeyBase64: exportPublicKeyBase64(bootState.keyPair.publicKey),
  };
}

function attemptFor(entry: { instanceId: string }, requestLineSent: string, op = "get_account_overview", seq = 1): PayswapBrokerAttemptContext {
  return { instanceId: entry.instanceId, seq, op, sentLine: requestLineSent };
}

/** null-bound 拒绝 oracle（§6.4(3)）：签名有效 + 绑定字段 null —— instance_mismatch。 */
function expectNullBoundRefusal(
  line: string,
  expectedCode: string,
  bootState: PayswapBrokerBootState,
): void {
  const parsed = JSON.parse(line) as { envelope: Record<string, unknown> };
  expect(parsed.envelope.instanceId).toBeNull();
  expect(parsed.envelope.seq).toBeNull();
  expect(parsed.envelope.op).toBeNull();
  const response = parsed.envelope.response as { ok: boolean; error?: { code: string } };
  expect(response.ok).toBe(false);
  expect(response.error?.code).toBe(expectedCode);
  const verdict = verifyResponseEnvelope(
    line,
    { instanceId: "00000000-0000-4000-8000-000000000000", seq: 1, op: "get_account_overview", sentLine: line },
    oracleMaterial(bootState),
  );
  expect(verdict).toEqual({ ok: false, reason: "instance_mismatch" });
}

/** request-attributed 业务拒绝 oracle（§7.3 三码）：验签通过，data 里是 typed refusal。 */
function expectBusinessRefusal(line: string, expectedCode: string, entry: { instanceId: string }, sentLine: string, bootState: PayswapBrokerBootState, seq = 1): void {
  const verdict = verifyResponseEnvelope(line, attemptFor(entry, sentLine, "get_account_overview", seq), oracleMaterial(bootState));
  expect(verdict.ok).toBe(true);
  if (!verdict.ok) return;
  expect(verdict.body.ok).toBe(true);
  const data = verdict.body.data as { kind: string; refusal?: { code: string; message: string } };
  expect(data.kind).toBe("refused");
  expect(data.refusal?.code).toBe(expectedCode);
  expect(typeof data.refusal?.message).toBe("string");
}

/** request-attributed 桥接错误 oracle（post-binding 违例）：验签通过，ok:false + typed code。 */
function expectRequestAttributedError(line: string, expectedCode: string, entry: { instanceId: string }, sentLine: string, bootState: PayswapBrokerBootState): void {
  const verdict = verifyResponseEnvelope(line, attemptFor(entry, sentLine), oracleMaterial(bootState));
  expect(verdict.ok).toBe(true);
  if (!verdict.ok) return;
  expect(verdict.body.ok).toBe(false);
  const error = verdict.body.error as { code: string; retryable: boolean };
  expect(error.code).toBe(expectedCode);
}

afterEach(async () => {
  for (const child of activeChildren.splice(0)) {
    child.kill("SIGKILL");
  }
  await Promise.allSettled(activeBrokers.splice(0).map((broker) => broker.close()));
});

// ---------------------------------------------------------------------------
// 纯 dispatch 表（无 broker —— 全平台运行；N21 闭集 + 皮带扣）
// ---------------------------------------------------------------------------

describe("P1.4 Step 4 — closed dispatch table (pure, all platforms)", () => {
  it("resolves each of the six operations (enum → handler map in code; no seventh operation)", async () => {
    const dispatch = createPayswapBrokerDispatch();
    const validParams: Record<string, unknown> = {
      compile_intent: { description: "pay the electricity bill" },
      check_eligibility: { intentId: "intent-1" },
      discover_routes: { intentId: "intent-1" },
      request_authorization: { intentId: "intent-1" },
      get_execution_status: { intentId: "intent-1" },
      get_account_overview: {},
    };
    for (const op of PAYSWAP_BROKER_OPS) {
      const result = await dispatch.resolveRequest({
        instanceId: randomUUID(),
        seq: 1,
        op,
        params: validParams[op] ?? {},
      });
      // 无 reader → S2 默认：not_connected 是唯一真话（§13 本 wave 无账户模型）。
      expect(result.kind, `op ${op} must dispatch`).toBe("dispatched");
      if (result.kind === "dispatched") {
        expect(result.body.ok).toBe(true);
        const data = result.body.data as { kind: string; refusal?: { code: string } };
        expect(data.refusal?.code).toBe("not_connected");
      }
    }
  });

  it("N21 belt: an op outside the closed table answers operation_not_found, never a crash (§7.2)", async () => {
    const dispatch = createPayswapBrokerDispatch();
    for (const op of ["ServiceChannels.call", "raw_service", "eval", "payswap_compile_intent", ""]) {
      const result = await dispatch.resolveRequest({
        instanceId: randomUUID(),
        seq: 1,
        // 类型系统里不可达（schema 枚举先行）；皮带扣在 dispatch 层直接可测。
        op: op as never,
        params: {},
      });
      expect(result, `op "${op}" must be refused`).toEqual({
        kind: "refused",
        code: "operation_not_found",
        retryable: false,
      });
    }
  });

  it("per-op params are strict: unknown key / missing required / wrong type → request_invalid (§6.1(3))", async () => {
    const dispatch = createPayswapBrokerDispatch();
    const invalid: Array<[string, unknown]> = [
      ["compile_intent", { description: "" }],
      ["compile_intent", {}],
      ["compile_intent", { description: "pay", extraKey: "no" }],
      ["check_eligibility", {}],
      ["check_eligibility", { intentId: "" }],
      ["check_eligibility", { intentId: 7 }],
      ["discover_routes", {}],
      ["request_authorization", {}],
      // §7.4 dormant grant hook：Wave 2 的 params schema 1:1 于 Wave 1 工具面，
      // authorizationId 不是已知键 —— schema 层拒绝，绝不到达任何 grant 逻辑。
      ["request_authorization", { intentId: "intent-1", authorizationId: "grant-1" }],
      ["get_execution_status", { executionId: 3 }],
      ["get_account_overview", { connectionId: "" }],
      ["get_account_overview", { connectionId: "c-1", extra: 1 }],
    ];
    for (const [op, params] of invalid) {
      const result = await dispatch.resolveRequest({
        instanceId: randomUUID(),
        seq: 1,
        op: op as never,
        params,
      });
      expect(result, `op ${op} params ${JSON.stringify(params)} must be request_invalid`).toEqual({
        kind: "refused",
        code: "request_invalid",
        retryable: false,
      });
    }
  });

  it("the three-code law: live reader drives the business refusal code (§7.3)", async () => {
    const states: PayswapBrokerLiveState[] = [
      { pluginEnabled: true, financialWorkspace: true },
      { pluginEnabled: true, financialWorkspace: false },
      { pluginEnabled: false, financialWorkspace: true },
      { pluginEnabled: false, financialWorkspace: false },
    ];
    const expected = ["not_connected", "not_opted_in", "financial_mode_disabled", "financial_mode_disabled"];
    for (let i = 0; i < states.length; i += 1) {
      let observed = 0;
      const dispatch = createPayswapBrokerDispatch({
        liveStateReader: () => {
          observed += 1;
          return states[i];
        },
      });
      const result = await dispatch.resolveRequest({
        instanceId: randomUUID(),
        seq: 1,
        op: "check_eligibility",
        params: { intentId: "intent-1" },
      });
      expect(result.kind).toBe("dispatched");
      if (result.kind === "dispatched") {
        const data = result.body.data as { refusal?: { code: string } };
        expect(data.refusal?.code, `state ${JSON.stringify(states[i])}`).toBe(expected[i]);
      }
      // live 读取发生在每次 dispatch（非 boot 快照 —— T2/T3 live-flip 的基础）。
      expect(observed).toBe(1);
    }
  });

  it("a disabled-tombstoned instance's binding answers financial_mode_disabled without consulting the reader (§10.2(2)/§7.3 row 1, ADR-5 D5.6)", async () => {
    let observed = 0;
    const dispatch = createPayswapBrokerDispatch({
      liveStateReader: () => {
        observed += 1;
        return { pluginEnabled: true, financialWorkspace: true };
      },
    });
    const result = await dispatch.resolveRequest(
      {
        instanceId: randomUUID(),
        seq: 1,
        op: "get_account_overview",
        params: {},
      },
      { instanceBinding: "disabled_revocation" },
    );
    expect(result.kind).toBe("dispatched");
    if (result.kind === "dispatched") {
      const data = result.body.data as { refusal?: { code: string } };
      expect(data.refusal?.code).toBe("financial_mode_disabled");
    }
    // 注册表 tombstone 是权威：disable 撤销不需要 reader 佐证。
    expect(observed).toBe(0);
  });

  it("a throwing live-state reader is an internal_error bridge failure (no detail leaked; §6.3)", async () => {
    const dispatch = createPayswapBrokerDispatch({
      liveStateReader: () => {
        throw new Error("config read exploded");
      },
    });
    const result = await dispatch.resolveRequest({
      instanceId: randomUUID(),
      seq: 1,
      op: "get_account_overview",
      params: {},
    });
    expect(result).toEqual({ kind: "refused", code: "internal_error", retryable: false });
  });
});

// ---------------------------------------------------------------------------
// broker 集成（真实 UDS + 真实子进程对端 —— Linux 行；非 Linux skipIf，P1.3 纪律）
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== "linux")("P1.4 Step 4 — broker dispatch integration (Linux)", () => {
  it(
    "the three-code law over the wire: each live state answers its business refusal in a request-attributed signed envelope (§7.3)",
    async () => {
      const cases: Array<{ state: PayswapBrokerLiveState; code: string }> = [
        { state: { pluginEnabled: true, financialWorkspace: true }, code: "not_connected" },
        { state: { pluginEnabled: true, financialWorkspace: false }, code: "not_opted_in" },
        { state: { pluginEnabled: false, financialWorkspace: true }, code: "financial_mode_disabled" },
      ];
      for (const { state, code } of cases) {
        const { handle, bootState } = await startBroker({
          liveStateReader: () => state,
        });
        const entry = mintEntry();
        const line = requestLine(entry, { params: {} });
        const child = spawnClientChild({ path: handle.endpointPath, line });
        handle.registerInstance({ ...entry, childPid: child.pid });
        const response = await child.waitFor((event) => event.t === "response");
        expectBusinessRefusal(response.line as string, code, entry, line, bootState);
        await handle.close();
        activeBrokers.pop();
      }
    },
    20000,
  );

  it(
    "T3 live-flip: opt-out flips the broker's answer on the next call without tombstoning the instance (§10.2(3))",
    async () => {
      const state: PayswapBrokerLiveState = { pluginEnabled: true, financialWorkspace: true };
      const registry: PayswapInstanceRegistry = createPayswapInstanceRegistry();
      const { handle, bootState } = await startBroker({ registry, liveStateReader: () => ({ ...state }) });
      const entry = mintEntry();
      const line1 = requestLine(entry, { seq: 1, params: {} });
      const line2 = requestLine(entry, { seq: 2, params: {} });
      const child = spawnClientChild({ path: handle.endpointPath, line: line1, line2, mode: "two-connections" });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const first = await child.waitFor((event) => event.t === "response");
      expectBusinessRefusal(first.line as string, "not_connected", entry, line1, bootState);
      // flip：opt-out（S2→S1）不改注册表 —— 同一实例的下一次连接（新 seq）变 not_opted_in。
      state.financialWorkspace = false;
      const second = await child.waitFor((event) => event.t === "response" && event.line !== first.line);
      expectBusinessRefusal(second.line as string, "not_opted_in", entry, line2, bootState, 2);
      expect(registry.lookup(entry.instanceId)).toEqual({ status: "live", entry: expect.objectContaining({ instanceId: entry.instanceId }) });
    },
    20000,
  );

  it(
    "tombstone reason split: exit/superseded stay instance_unknown; disabled flows through to financial_mode_disabled (§10.2)",
    async () => {
      for (const reason of ["exit", "superseded"] as const) {
        const registry = createPayswapInstanceRegistry();
        const { handle, bootState } = await startBroker({ registry });
        const entry = mintEntry();
        const line = requestLine(entry, { params: {} });
        const child = spawnClientChild({ path: handle.endpointPath, line });
        // 先经 handle 注册（spawn 表 + 注册表同批），再从注册表 tombstone（liveness 权威）。
        handle.registerInstance({ ...entry, childPid: child.pid });
        registry.tombstone(entry.instanceId, reason);
        const response = await child.waitFor((event) => event.t === "response");
        expectNullBoundRefusal(response.line as string, "instance_unknown", bootState);
        await handle.close();
        activeBrokers.pop();
      }
      // disabled 臂：注册表 tombstone(reason "disabled") → dispatch 升级（D5.6）。
      const registry = createPayswapInstanceRegistry();
      const { handle, bootState } = await startBroker({
        registry,
        liveStateReader: () => ({ pluginEnabled: true, financialWorkspace: true }),
      });
      const entry = mintEntry();
      const line = requestLine(entry, { params: {} });
      const child = spawnClientChild({ path: handle.endpointPath, line });
      handle.registerInstance({ ...entry, childPid: child.pid });
      registry.tombstone(entry.instanceId, "disabled");
      const response = await child.waitFor((event) => event.t === "response");
      expectBusinessRefusal(response.line as string, "financial_mode_disabled", entry, line, bootState);
    },
    20000,
  );

  it(
    "request-envelope schema violations are null-bound request_invalid (pre-binding; §6.1 `.strict()`)",
    async () => {
      const violationEntryPlaceholder = mintEntry();
      const { handle, bootState } = await startBroker();
      const violations: Array<{ label: string; line: string }> = [
        { label: "unknown top-level key", line: requestLine(violationEntryPlaceholder, { extra: { authorizationId: "g-1" } }) },
        { label: "token wrong length", line: requestLine(violationEntryPlaceholder, { token: "a".repeat(63) }) },
        { label: "instanceId not a uuid", line: requestLine(violationEntryPlaceholder, { extra: { instanceId: "not-a-uuid" } }) },
        { label: "seq zero", line: requestLine(violationEntryPlaceholder, { seq: 0 }) },
        { label: "seq negative", line: requestLine(violationEntryPlaceholder, { seq: -1 }) },
        { label: "seq float", line: requestLine(violationEntryPlaceholder, { seq: 1.5 }) },
        { label: "op outside the closed table", line: requestLine(violationEntryPlaceholder, { op: "ServiceChannels.call" }) },
        { label: "op with plugin namespace prefix", line: requestLine(violationEntryPlaceholder, { op: "payswap_compile_intent" }) },
        { label: "sessionId empty", line: requestLine(violationEntryPlaceholder, { sessionId: "" }) },
        { label: "params not an object", line: requestLine(violationEntryPlaceholder, { params: "nope" }) },
        { label: "trace unknown key", line: requestLine(violationEntryPlaceholder, { extra: { trace: { traceId: "t-1", bogus: 1 } } }) },
      ];
      for (const { label, line } of violations) {
        // 每个子进程一个实例（§4.1：spawn 即 mint）；fresh entry → pid 进 spawn 表。
        const violationEntry = mintEntry();
        const violationLine = line
          .replace(violationEntryPlaceholder.instanceId, violationEntry.instanceId)
          .replace(violationEntryPlaceholder.token, violationEntry.token);
        const child = spawnClientChild({ path: handle.endpointPath, line: violationLine });
        handle.registerInstance({ ...violationEntry, childPid: child.pid });
        const response = await child.waitFor((event) => event.t === "response");
        expectNullBoundRefusal(response.line as string, "request_invalid", bootState);
        void label;
      }
    },
    20000,
  );

  it(
    "per-op params violations after binding are request-attributed request_invalid (§6.1(3); post-binding shape)",
    async () => {
      const { handle, bootState } = await startBroker({
        liveStateReader: () => ({ pluginEnabled: true, financialWorkspace: true }),
      });
      const entry = mintEntry();
      // 信封 schema 通过（params 是 record），绑定完成后 per-op 校验拒绝 —— 绑定字段齐全。
      const line = requestLine(entry, { op: "get_account_overview", params: { connectionId: "c-1", extra: 1 } });
      const child = spawnClientChild({ path: handle.endpointPath, line });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response");
      expectRequestAttributedError(response.line as string, "request_invalid", entry, line, bootState);
    },
    20000,
  );

  it(
    "a valid trace triple is accepted (§6.1 optional trace; shipped triple shape)",
    async () => {
      const { handle, bootState } = await startBroker({
        liveStateReader: () => ({ pluginEnabled: true, financialWorkspace: true }),
      });
      const entry = mintEntry();
      const line = requestLine(entry, {
        params: {},
        extra: { trace: { traceId: "t-1", spanId: "s-1", parentSpanId: "p-1" } },
      });
      const child = spawnClientChild({ path: handle.endpointPath, line });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response");
      expectBusinessRefusal(response.line as string, "not_connected", entry, line, bootState);
    },
    20000,
  );

  it(
    "all six operations dispatch over the wire with their Wave 1 params shapes (§7.1 1:1)",
    async () => {
      const { handle, bootState } = await startBroker({
        liveStateReader: () => ({ pluginEnabled: true, financialWorkspace: true }),
      });
      const ops: Array<[string, unknown]> = [
        ["compile_intent", { description: "pay the electricity bill", amount: "120.50", currency: "GHS", recipient: "ECG", reference: "jan" }],
        ["check_eligibility", { intentId: "intent-9" }],
        ["discover_routes", { intentId: "intent-9" }],
        ["request_authorization", { intentId: "intent-9" }],
        ["get_execution_status", { executionId: "exec-1", intentId: "intent-9" }],
        ["get_account_overview", { connectionId: "conn-1" }],
      ];
      for (const [op, params] of ops) {
        // 每个子进程一个实例；各操作独立行（seq=1 —— 实例内首个请求）。
        const entry = mintEntry();
        const line = requestLine(entry, { seq: 1, op, params });
        const child = spawnClientChild({ path: handle.endpointPath, line });
        handle.registerInstance({ ...entry, childPid: child.pid });
        const response = await child.waitFor((event) => event.t === "response");
        const verdict = verifyResponseEnvelope(
          response.line as string,
          attemptFor(entry, line, op as never, 1),
          oracleMaterial(bootState),
        );
        expect(verdict.ok, `op ${op} must verify`).toBe(true);
        if (verdict.ok) {
          expect(verdict.body.ok).toBe(true);
          const data = verdict.body.data as { refusal?: { code: string } };
          expect(data.refusal?.code).toBe("not_connected");
        }
      }
    },
    20000,
  );

  it(
    "audit ingress records dispatched business refusals with op and verified pid (§11)",
    async () => {
      const audit: PayswapBrokerAuditEvent[] = [];
      const bootState = mintBrokerBootState();
      const handle = await bootPayswapBroker({
        bootState,
        auditSink: (event) => audit.push(event),
        liveStateReader: () => ({ pluginEnabled: false, financialWorkspace: false }),
        // P1.5 Step 5（§8）：本行直呼 boot（不经 startBroker 缺省）—— live 实例的
        // dispatched 审计行需要可解析会话（"sess-test" = 注册条目的 sessionScope）。
        sessionScopeResolver: (hint) => (hint === "sess-test" ? { workspaceKey: "sess-test" } : null),
      });
      activeBrokers.push(handle);
      const entry = mintEntry();
      const line = requestLine(entry, { op: "check_eligibility", params: { intentId: "i-1" } });
      const child = spawnClientChild({ path: handle.endpointPath, line });
      handle.registerInstance({ ...entry, childPid: child.pid });
      await child.waitFor((event) => event.t === "response");
      expect(
        audit.some(
          (event) =>
            event.outcome === "dispatched" &&
            event.instanceId === entry.instanceId &&
            event.op === "check_eligibility" &&
            event.peerPid === child.pid,
        ),
      ).toBe(true);
    },
    20000,
  );
});
