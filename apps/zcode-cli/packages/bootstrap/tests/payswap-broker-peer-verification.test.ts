import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  createPayswapInstanceRegistry,
  exportPublicKeyBase64,
  mintBrokerBootState,
  verifyResponseEnvelope,
  type PayswapBrokerAttemptContext,
  type PayswapBrokerBootState,
  type PayswapInstanceRegistryEntry,
} from "@zcode/shared/payswap";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootPayswapBroker,
  PAYSWAP_BROKER_DEFAULT_IDLE_TIMEOUT_MS,
  type PayswapBrokerAuditEvent,
  type PayswapBrokerBootOptions,
  type PayswapBrokerHandle,
  type PeerCredentialRead,
  type PeerCredentialReader,
} from "../src/payswap-broker/index.js";

/**
 * PaySwap P1.3 Step 3 —— broker 引导 / UDS 线路协议 / Linux 对等验证 / fail-closed
 * 的对抗性测试（契约 w2-01 §3、§5、§5.5、§10、§11、§12；playbook §4.2 RED-first）。
 *
 * 纪律（§12.1 binding order）：本文件的对抗行先于实现代码落盘（RED）；实现提交（GREEN）
 * 必须逐行转绿。对端身份用**真实派生的子进程**（impostor / 跨实例 / 残留调用各有独立
 * pid），签名信封用共享模块（§6.4(5) 单一实现）作为 oracle —— null-bound 拒绝以
 * `verifyResponseEnvelope` 得到 `instance_mismatch` 证明 (a)签名 (b)版本 (c)host 绑定
 * 全部通过且绑定字段为 null（§6.4(3)）。
 *
 * 平台边界（ADR-4）：Linux 行依赖 ss(SOCK_DIAG) + procfs；非 Linux 平台默认子系统不可用
 * → degraded_refusing（§5.4 fail-closed，Linux 行 skipIf，degraded 行全平台运行）。
 */

// ---------------------------------------------------------------------------
// 子进程客户端（真实对端：连接 / 写行 / 流式写 / 保持连接 —— 由 env 驱动）
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `
const net = require("node:net");
const path = process.env.PB_TEST_PATH;
const mode = process.env.PB_TEST_MODE;
const lineArg = process.env.PB_TEST_LINE || "";
const instanceId = process.env.PB_TEST_INSTANCE_ID || "";
const token = process.env.PB_TEST_TOKEN || "";
const gated = process.env.PB_TEST_GATED === "1"; // 等 stdin "go" 再**连接**：relay 事实即时可得时，注册必须先于连接（ADR-13）
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
function buildExactLengthLine(total) {
  const base = { instanceId, seq: 1, op: "get_account_overview", params: { pad: "" }, token, sessionId: "sess-test" };
  const c = JSON.stringify(base).length;
  if (c > total) throw new Error("base longer than target");
  base.params.pad = "A".repeat(total - c);
  const s = JSON.stringify(base);
  if (s.length !== total) throw new Error("length mismatch " + s.length + " != " + total);
  return s;
}
function start() {
  const s = net.connect(path, () => {
    send({ t: "connected" });
    if (mode === "line") s.write(lineArg + "\\n");
    else if (mode === "two-lines") { s.write(lineArg + "\\n"); setTimeout(() => s.write(lineArg + "\\n"), 60); }
    else if (mode === "hold-then-send") { setTimeout(() => s.write(lineArg + "\\n"), 150); }
    else if (mode === "partial") {
      // 半行写入后挂起 —— 终止行（SIGKILL mid-line）的确定性载体。
      s.write(lineArg.slice(0, Math.max(1, Math.floor(lineArg.length / 2))));
    }
    else if (mode === "oversize-ok") { s.write(buildExactLengthLine(1024 * 1024) + "\\n"); }
    else if (mode === "oversize-bad") { s.write(buildExactLengthLine(1024 * 1024 + 1) + "\\n"); }
    else if (mode === "garbage") { s.write("{this is not json\\n"); }
    else if (mode === "stream") {
      const buf = Buffer.alloc(64 * 1024, 0x61);
      let n = 0;
      const iv = setInterval(() => { s.write(buf); if (++n > 80) clearInterval(iv); }, 10);
    }
    // mode === "idle": 连接后什么都不写
  });
  let acc = "";
  s.on("data", (d) => {
    acc += d.toString("utf8");
    let i;
    while ((i = acc.indexOf("\\n")) >= 0) { send({ t: "response", line: acc.slice(0, i) }); acc = acc.slice(i + 1); }
  });
  s.on("close", () => { send({ t: "close" }); process.exit(0); });
  s.on("error", (e) => { send({ t: "error", code: e.code }); process.exit(0); });
}
if (gated) {
  let started = false;
  process.stdin.on("data", () => {
    if (started) return;
    started = true;
    start();
  });
} else {
  start();
}
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
  /** 门控子进程：发送 stdin "go" 后才**连接**（注册必须先于连接 —— ADR-13）。 */
  release(): void;
  kill(): void;
}

function spawnClientChild(options: {
  path: string;
  mode: string;
  line?: string;
  instanceId?: string;
  token?: string;
  gated?: boolean;
}): ChildHandle {
  const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
    stdio: [options.gated ? "pipe" : "ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      PB_TEST_PATH: options.path,
      PB_TEST_MODE: options.mode,
      PB_TEST_LINE: options.line ?? "",
      PB_TEST_INSTANCE_ID: options.instanceId ?? "",
      PB_TEST_TOKEN: options.token ?? "",
      ...(options.gated ? { PB_TEST_GATED: "1" } : {}),
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
    release() {
      child.stdin?.write("go\n");
    },
  };
  activeChildren.push(child);
  return handle;
}

// ---------------------------------------------------------------------------
// broker 启动 / 实例注册 helper
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
  seq = 1,
  op: "get_account_overview" = "get_account_overview",
): string {
  return JSON.stringify({
    instanceId: entry.instanceId,
    seq,
    op,
    params: {},
    token: entry.token,
    sessionId: "sess-test",
  });
}

/** 与子进程 buildExactLengthLine 同一算法 —— 父侧可精确重构子进程发出的请求行（digest oracle）。 */
function exactLengthRequestLine(entry: { instanceId: string; token: string }, total: number): string {
  const base = {
    instanceId: entry.instanceId,
    seq: 1,
    op: "get_account_overview",
    params: { pad: "" },
    token: entry.token,
    sessionId: "sess-test",
  };
  const c = JSON.stringify(base).length;
  if (c > total) throw new Error("base longer than target");
  base.params.pad = "A".repeat(total - c);
  const s = JSON.stringify(base);
  if (s.length !== total) throw new Error(`length mismatch ${s.length} != ${total}`);
  return s;
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
    // P1.5 Step 5（§8）：本套件唯一的 live 请求行（happy path）需要可解析会话才能到达
    // Step-3 临时 dispatch 的 not_connected —— "sess-test" = 注册条目的 sessionScope。
    // 其余行全部在 peer gate / schema / token 前置层拒绝（§8 不可达），不受影响。
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

/** request-attributed oracle：attempt 的 sentLine 必须是子进程实际发出的请求行（§6.5(3g)）。 */
function attemptFor(entry: { instanceId: string }, requestLineSent: string): PayswapBrokerAttemptContext {
  return { instanceId: entry.instanceId, seq: 1, op: "get_account_overview", sentLine: requestLineSent };
}

/**
 * null-bound 拒绝 oracle（§6.4(3)）：签名有效 + 绑定字段 null —— `instance_mismatch`
 * 恰好证明 (a) 签名 (b) 版本 (c) host 绑定已通过而实例绑定必失败。
 */
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

afterEach(async () => {
  for (const child of activeChildren.splice(0)) {
    child.kill("SIGKILL");
  }
  await Promise.allSettled(activeBrokers.splice(0).map((broker) => broker.close()));
});

// ---------------------------------------------------------------------------
// Linux 对等验证（ADR-4：ss SOCK_DIAG + procfs；非 Linux skipIf）
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== "linux")("P1.3 Step 3 — Linux peer verification", () => {
  it(
    "boots peer-verified: the self-probe establishes identity through a real loopback pair before the listener binds (ADR-4)",
    async () => {
      // pre-boot 快照：本断言只裁决"本 boot 的自探针不留残骸"。vitest 并行 worker 的
      // 其它套件（dispatch/session-scope/replay/spawn-wiring…）同用 /tmp 做自己的
      // 自探针 —— 旧的 mtime 滤网会把**在飞探针**（创建于本测试 probeStart 之后、
      // 尚未走完自己 finally 清理的其它 worker 目录）误判为残骸（PR #11 的 gates
      // 偶发红即此竞态，非 boot 清理缺陷 —— boot.ts 的 finally 尽力而为清理对每个
      // 自身探针都成立）。改为集合语义：采样窗口内轮询，直到当前目录集回到
      // pre-boot 快照（自身与并行 worker 的探针都是短命自清的）。
      const probeDirsBefore = new Set(
        fs
          .readdirSync(os.tmpdir())
          .filter((name) => name.startsWith("payswap-broker-probe-")),
      );
      const { handle } = await startBroker();
      expect(handle.mode).toBe("peer_verified");
      expect(handle.probe.verified).toBe(true);
      // 自探针对端就是 host 自身：pid/uid 都必须是本进程的。
      expect(handle.probe.pid).toBe(process.pid);
      expect(handle.probe.uid).toBe(process.geteuid());
      // 自探针的临时目录必须清理干净（不留 probe 残骸）—— pre-boot 快照之外的同前缀
      // 目录（含本 boot 自己的）最终全部消失；并行 worker 的在飞探针在窗口内自清。
      const deadline = Date.now() + 3_000;
      let settled = false;
      while (Date.now() < deadline) {
        const current = fs
          .readdirSync(os.tmpdir())
          .filter((name) => name.startsWith("payswap-broker-probe-"));
        if (current.every((name) => probeDirsBefore.has(name))) {
          settled = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const stragglers = fs
        .readdirSync(os.tmpdir())
        .filter((name) => name.startsWith("payswap-broker-probe-") && !probeDirsBefore.has(name));
      expect(
        settled,
        `probe temp dirs beyond the pre-boot snapshot must settle to empty within the window; stragglers: ${stragglers.join(", ")}`,
      ).toBe(true);
    },
    20000,
  );

  it(
    "a registered child's fully-valid request gets a request-attributed signed envelope (happy path; Step-3 interim dispatch = not_connected)",
    async () => {
      const { handle, bootState, audit } = await startBroker();
      const entry = mintEntry();
      const reqLine = requestLine(entry);
      const child = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: reqLine,
        instanceId: entry.instanceId,
        token: entry.token,
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response");
      const line = response.line as string;
      const verdict = verifyResponseEnvelope(line, attemptFor(entry, reqLine), oracleMaterial(bootState));
      expect(verdict.ok).toBe(true);
      if (verdict.ok) {
        expect(verdict.body.ok).toBe(true);
        const data = verdict.body.data as { kind: string; refusal?: { code: string } };
        expect(data.kind).toBe("refused");
        expect(data.refusal?.code).toBe("not_connected");
      }
      // §11 ingress：dispatched 事件记录 verified pid。
      expect(
        audit.some(
          (event) =>
            event.outcome === "dispatched" &&
            event.instanceId === entry.instanceId &&
            event.peerPid === child.pid,
        ),
      ).toBe(true);
    },
    20000,
  );

  it(
    "an unregistered impostor process is dropped before any payload byte is parsed (§5.1/§5.5)",
    async () => {
      const { handle, bootState } = await startBroker();
      const victim = mintEntry(); // 注册表里有真实实例，impostor 冒充它
      handle.registerInstance({ ...victim, childPid: 12345 });
      const impostor = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: requestLine(victim),
        instanceId: victim.instanceId,
        token: victim.token,
      });
      const response = await impostor.waitFor((event) => event.t === "response");
      expectNullBoundRefusal(response.line as string, "peer_verification_failed", bootState);
    },
    20000,
  );

  it(
    "check order: an unverified peer's oversize payload yields peer_verification_failed, never request_invalid (§5.5)",
    async () => {
      const { handle, bootState } = await startBroker();
      const victim = mintEntry();
      handle.registerInstance({ ...victim, childPid: 12345 });
      const impostor = spawnClientChild({
        path: handle.endpointPath,
        mode: "oversize-bad",
        instanceId: victim.instanceId,
        token: victim.token,
      });
      const response = await impostor.waitFor((event) => event.t === "response", 20000);
      expectNullBoundRefusal(response.line as string, "peer_verification_failed", bootState);
    },
    20000,
  );

  it(
    "a peer whose uid does not equal the host uid is refused peer_verification_failed (§5.1(2), forced-reader arm)",
    async () => {
      let childPid = -1;
      const reader: PeerCredentialReader = {
        kind: "linux",
        detail: "forced uid mismatch",
        readAcceptedSocketPeer: async (): Promise<PeerCredentialRead | null> => ({
          pid: childPid,
          uid: process.geteuid() + 1,
        }),
      };
      const { handle, bootState } = await startBroker({ reader });
      const entry = mintEntry();
      const reqLine = requestLine(entry);
      const child = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: reqLine,
        instanceId: entry.instanceId,
        token: entry.token,
      });
      childPid = child.pid;
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response");
      expectNullBoundRefusal(response.line as string, "peer_verification_failed", bootState);
    },
    20000,
  );

  it(
    "cross-instance token use refused: a child presenting another instance's token gets unauthorized (N20)",
    async () => {
      const { handle, bootState } = await startBroker();
      const entryA = mintEntry();
      const entryB = mintEntry();
      // 子进程的真实 pid 注册为 A；请求行却携带 B 的 instanceId + token。
      const child = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: requestLine(entryB),
        instanceId: entryB.instanceId,
        token: entryB.token,
      });
      handle.registerInstance({ ...entryA, childPid: child.pid });
      handle.registerInstance({ ...entryB, childPid: 54321 });
      const response = await child.waitFor((event) => event.t === "response");
      expectNullBoundRefusal(response.line as string, "unauthorized", bootState);
    },
    20000,
  );

  it(
    "cross-instance id claim refused: child A's own token but claiming B's instanceId gets instance_unknown (§5.2(3))",
    async () => {
      const { handle, bootState } = await startBroker();
      const entryA = mintEntry();
      const entryB = mintEntry();
      const child = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: JSON.stringify({
          instanceId: entryB.instanceId,
          seq: 1,
          op: "get_account_overview",
          params: {},
          token: entryA.token,
          sessionId: "sess-test",
        }),
        instanceId: entryA.instanceId,
        token: entryA.token,
      });
      handle.registerInstance({ ...entryA, childPid: child.pid });
      handle.registerInstance({ ...entryB, childPid: 54321 });
      const response = await child.waitFor((event) => event.t === "response");
      expectNullBoundRefusal(response.line as string, "instance_unknown", bootState);
    },
    20000,
  );

  it(
    "unknown instance id refused: instance_unknown (§6.3)",
    async () => {
      const { handle, bootState } = await startBroker();
      const entry = mintEntry();
      const child = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: JSON.stringify({
          instanceId: randomUUID(),
          seq: 1,
          op: "get_account_overview",
          params: {},
          token: entry.token,
          sessionId: "sess-test",
        }),
        instanceId: entry.instanceId,
        token: entry.token,
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response");
      expectNullBoundRefusal(response.line as string, "instance_unknown", bootState);
    },
    20000,
  );

  it(
    "exit-tombstoned instance: the live child's residual call answers instance_unknown (§10.2(1))",
    async () => {
      const registry = createPayswapInstanceRegistry();
      const { handle, bootState } = await startBroker({ registry });
      const entry = mintEntry();
      const reqLine = requestLine(entry);
      const child = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: reqLine,
        instanceId: entry.instanceId,
        token: entry.token,
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      registry.tombstone(entry.instanceId, "exit");
      const response = await child.waitFor((event) => event.t === "response");
      expectNullBoundRefusal(response.line as string, "instance_unknown", bootState);
    },
    20000,
  );

  it(
    "disable-tombstoned instance: the live child's residual call answers financial_mode_disabled (Step 4 D5.6 upgrade of the former Step-3 instance_unknown bridge; §10.2(2)/§7.3 row 1)",
    async () => {
      const registry = createPayswapInstanceRegistry();
      const { handle, bootState } = await startBroker({ registry });
      const entry = mintEntry();
      const reqLine = requestLine(entry);
      const child = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: reqLine,
        instanceId: entry.instanceId,
        token: entry.token,
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      registry.tombstone(entry.instanceId, "disabled");
      const response = await child.waitFor((event) => event.t === "response");
      // Step 4（ADR-5 D5.6）：disable tombstone 流通到 dispatch —— request-attributed 的
      // financial_mode_disabled 业务拒绝（不再是 Step-3 桥的 null-bound instance_unknown）。
      const verdict = verifyResponseEnvelope(
        response.line as string,
        attemptFor(entry, reqLine),
        oracleMaterial(bootState),
      );
      expect(verdict.ok).toBe(true);
      if (verdict.ok) {
        expect(verdict.body.ok).toBe(true);
        const data = verdict.body.data as { kind: string; refusal?: { code: string } };
        expect(data.kind).toBe("refused");
        expect(data.refusal?.code).toBe("financial_mode_disabled");
      }
    },
    20000,
  );

  it(
    "wrong token (own instance) refused: unauthorized (§4.5)",
    async () => {
      const { handle, bootState } = await startBroker();
      const entry = mintEntry();
      const wrongToken = randomBytes(32).toString("hex");
      const child = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: JSON.stringify({
          instanceId: entry.instanceId,
          seq: 1,
          op: "get_account_overview",
          params: {},
          token: wrongToken,
          sessionId: "sess-test",
        }),
        instanceId: entry.instanceId,
        token: wrongToken,
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response");
      expectNullBoundRefusal(response.line as string, "unauthorized", bootState);
    },
    20000,
  );
});

// ---------------------------------------------------------------------------
// 线路协议 / 端点纪律（Linux 下以 peer-verified 模式执行）
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== "linux")("P1.3 Step 3 — UDS line protocol and endpoint discipline", () => {
  it(
    "exact 1 MiB request line parses (boundary ok) and proceeds to the Step-3 interim dispatch (§3.3(2))",
    async () => {
      const { handle, bootState } = await startBroker();
      const entry = mintEntry();
      const child = spawnClientChild({
        path: handle.endpointPath,
        mode: "oversize-ok",
        instanceId: entry.instanceId,
        token: entry.token,
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response", 20000);
      const line = response.line as string;
      // 恰 1 MiB 的行不是 request_invalid：走到绑定与临时 dispatch（not_connected）。
      const reqLine = exactLengthRequestLine(entry, 1024 * 1024);
      const verdict = verifyResponseEnvelope(line, attemptFor(entry, reqLine), oracleMaterial(bootState));
      expect(verdict.ok).toBe(true);
    },
    30000,
  );

  it(
    "1 MiB + 1 request line refused request_invalid (§3.3(2), exact boundary)",
    async () => {
      const { handle, bootState } = await startBroker();
      const entry = mintEntry();
      const child = spawnClientChild({
        path: handle.endpointPath,
        mode: "oversize-bad",
        instanceId: entry.instanceId,
        token: entry.token,
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response", 20000);
      expectNullBoundRefusal(response.line as string, "request_invalid", bootState);
    },
    30000,
  );

  it(
    "unparseable request line refused request_invalid (§3.3(2))",
    async () => {
      const { handle, bootState } = await startBroker();
      const entry = mintEntry();
      const child = spawnClientChild({ path: handle.endpointPath, mode: "garbage" });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response");
      expectNullBoundRefusal(response.line as string, "request_invalid", bootState);
    },
    20000,
  );

  it(
    "one request per connection: the second line is never answered; the answer binds the first line's seq (§3.3(1))",
    async () => {
      const { handle } = await startBroker();
      const entry = mintEntry();
      const firstLine = requestLine(entry, 1);
      const child = spawnClientChild({
        path: handle.endpointPath,
        mode: "two-lines",
        line: firstLine,
        instanceId: entry.instanceId,
        token: entry.token,
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response");
      await child.waitFor((event) => event.t === "close", 5000);
      const responses = child.events.filter((event) => event.t === "response");
      expect(responses.length).toBe(1);
      const parsed = JSON.parse(response.line as string) as { envelope: { seq: number } };
      expect(parsed.envelope.seq).toBe(1);
    },
    20000,
  );

  it(
    "a pre-planted plain file at the endpoint path is removed, never silently adopted (N22 §3.4(1))",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "payswap-stale-test-"));
      const endpointDir = path.join(root, "payswap-broker-stalefile");
      const endpointPath = path.join(endpointDir, "broker.sock");
      fs.mkdirSync(endpointDir, { recursive: true });
      fs.writeFileSync(endpointPath, "pre-planted stale entry", "utf8");
      const { handle, bootState } = await startBroker({ bootState: customBootState(endpointPath) });
      expect(handle.mode).toBe("peer_verified");
      const entry = mintEntry();
      const reqLine = requestLine(entry);
      const child = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: reqLine,
        instanceId: entry.instanceId,
        token: entry.token,
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response");
      const verdict = verifyResponseEnvelope(
        response.line as string,
        attemptFor(entry, reqLine),
        oracleMaterial(bootState),
      );
      expect(verdict.ok).toBe(true); // 回答来自我们的 broker（我们的 boot 钥签名）
      fs.rmSync(root, { recursive: true, force: true });
    },
    20000,
  );

  it(
    "a pre-planted LIVE foreign listener at the endpoint path is replaced; responses come from our broker, never the foreign one (N22 §3.4(1))",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "payswap-stale-test-"));
      const endpointDir = path.join(root, "payswap-broker-stalelive");
      const endpointPath = path.join(endpointDir, "broker.sock");
      fs.mkdirSync(endpointDir, { recursive: true });
      // 同 uid 攻击者预先占位：一个真实存活的外来 listener。
      const foreign = net.createServer((conn) => {
        conn.end('{"foreign":true}\n');
      });
      await new Promise<void>((resolve) => foreign.listen(endpointPath, resolve));
      const { handle, bootState } = await startBroker({ bootState: customBootState(endpointPath) });
      expect(handle.mode).toBe("peer_verified");
      const entry = mintEntry();
      const reqLine = requestLine(entry);
      const child = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: reqLine,
        instanceId: entry.instanceId,
        token: entry.token,
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response");
      const verdict = verifyResponseEnvelope(
        response.line as string,
        attemptFor(entry, reqLine),
        oracleMaterial(bootState),
      );
      expect(verdict.ok).toBe(true); // 我们 boot 钥签名的回答 —— 不是外来 listener 的字节
      foreign.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
    20000,
  );

  it(
    "endpoint placement: per-boot 0700 directory with payswap-broker- prefix under tmpdir; 0600 socket (§3.1(2))",
    async () => {
      const { handle } = await startBroker();
      const dir = path.dirname(handle.endpointPath);
      expect(path.basename(dir).startsWith("payswap-broker-")).toBe(true);
      expect(path.dirname(dir)).toBe(os.tmpdir());
      const dirStat = fs.statSync(dir);
      expect(dirStat.mode & 0o777).toBe(0o700);
      const socketStat = fs.statSync(handle.endpointPath);
      expect(socketStat.mode & 0o777).toBe(0o600);
    },
    20000,
  );

  it(
    "idle connections close after the bounded timeout with no state; the default timeout is ≥ 30 s (§3.3(4))",
    async () => {
      expect(PAYSWAP_BROKER_DEFAULT_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
      const { handle } = await startBroker({ idleTimeoutMs: 200 });
      const entry = mintEntry();
      const child = spawnClientChild({ path: handle.endpointPath, mode: "idle" });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const start = Date.now();
      await child.waitFor((event) => event.t === "close", 5000);
      expect(Date.now() - start).toBeLessThan(3000);
      // 没有响应行 —— 空闲关闭不携带状态。
      expect(child.events.filter((event) => event.t === "response").length).toBe(0);
    },
    20000,
  );

  it(
    "child termination during a connection (partial write): SIGKILL mid-line → no outcome event, no dispatch; the broker serves the next fresh child normally (handoff §5 termination row)",
    async () => {
      const { handle, bootState, audit } = await startBroker();
      const entry = mintEntry();
      const reqLine = requestLine(entry);
      const child = spawnClientChild({
        path: handle.endpointPath,
        mode: "partial",
        line: reqLine,
        instanceId: entry.instanceId,
        token: entry.token,
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      // 连接建立且半行已写入（连接回调同步于 connect；留 300ms 让写入落地）。
      await child.waitFor((event) => event.t === "connected", 5000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      child.kill(); // SIGKILL：对端在半行处消失 —— broker 侧 socket close/error
      // 服务端事件循环消化掉 close（无直接可观测面 —— 稳定窗口后以行为断言）。
      await new Promise((resolve) => setTimeout(resolve, 500));

      // 半行从未成为完整请求：零 outcome 事件（无 dispatch、无 refused）。
      const outcomes = audit.filter((event) => event.outcome === "dispatched" || event.outcome === "refused");
      expect(outcomes).toHaveLength(0);

      // broker 仍然健康：新子进程（新 pid + 新注册）的合法请求走完整 §5.5 序列，
      // 拿到请求归属的签名信封（Step-3 interim dispatch = not_connected）。
      const fresh = mintEntry();
      const freshLine = requestLine(fresh);
      const nextChild = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: freshLine,
        instanceId: fresh.instanceId,
        token: fresh.token,
      });
      handle.registerInstance({ ...fresh, childPid: nextChild.pid });
      const response = await nextChild.waitFor((event) => event.t === "response");
      const verdict = verifyResponseEnvelope(
        response.line as string,
        attemptFor(fresh, freshLine),
        oracleMaterial(bootState),
      );
      expect(verdict.ok).toBe(true);
      expect(audit.filter((event) => event.outcome === "dispatched" || event.outcome === "refused")).toHaveLength(1);
      // close() 依然干净（终止未留下需要兜底的悬挂状态）。
      await handle.close();
    },
    20000,
  );

  it(
    "child termination during a connection (completed request, lingering connection): the killed peer's socket drops server-side without corrupting state — exactly one outcome, no duplicate on the next request",
    async () => {
      const { handle, bootState, audit } = await startBroker();
      const entry = mintEntry();
      const reqLine = requestLine(entry);
      const child = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: reqLine,
        instanceId: entry.instanceId,
        token: entry.token,
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      // 完整请求已回答（子进程收到信封后仍滞留到 20s 超时 —— 连接保持打开）。
      const response = await child.waitFor((event) => event.t === "response");
      const verdict = verifyResponseEnvelope(
        response.line as string,
        attemptFor(entry, reqLine),
        oracleMaterial(bootState),
      );
      expect(verdict.ok).toBe(true);
      // 连接仍打开时 SIGKILL 对端 —— 服务侧 socket error/close 路径。
      child.kill();
      await new Promise((resolve) => setTimeout(resolve, 500));

      // 恰一个 outcome 事件；杀死对端不产生第二个事件（无重放、无重试、无重复 dispatch）。
      expect(audit.filter((event) => event.outcome === "dispatched" || event.outcome === "refused")).toHaveLength(1);

      // 下一个合法子进程照常服务；close() 干净。
      const fresh = mintEntry();
      const freshLine = requestLine(fresh);
      const nextChild = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: freshLine,
        instanceId: fresh.instanceId,
        token: fresh.token,
      });
      handle.registerInstance({ ...fresh, childPid: nextChild.pid });
      const next = await nextChild.waitFor((event) => event.t === "response");
      expect(verifyResponseEnvelope(next.line as string, attemptFor(fresh, freshLine), oracleMaterial(bootState)).ok).toBe(true);
      expect(audit.filter((event) => event.outcome === "dispatched" || event.outcome === "refused")).toHaveLength(2);
      await handle.close();
    },
    20000,
  );

  it(
    "failPeer drain discipline (D5.4): an unverified peer that keeps writing still receives the complete error line (no RST race)",
    async () => {
      const { handle, bootState } = await startBroker();
      const victim = mintEntry();
      handle.registerInstance({ ...victim, childPid: 12345 });
      const impostor = spawnClientChild({ path: handle.endpointPath, mode: "stream" });
      const response = await impostor.waitFor((event) => event.t === "response", 15000);
      expectNullBoundRefusal(response.line as string, "peer_verification_failed", bootState);
    },
    30000,
  );

  it(
    "close(): endpoint socket and per-boot directory removed; idempotent; the 250 ms fallback releases a stuck live connection (ADR-6)",
    async () => {
      const { handle } = await startBroker();
      const entry = mintEntry();
      const child = spawnClientChild({ path: handle.endpointPath, mode: "idle" });
      handle.registerInstance({ ...entry, childPid: child.pid });
      await child.waitFor((event) => event.t === "connected");
      await waitUntil(() => handle.liveConnectionCount >= 1);
      const start = Date.now();
      await handle.close();
      expect(Date.now() - start).toBeLessThan(3000); // 兜底释放，不是挂等
      expect(fs.existsSync(handle.endpointPath)).toBe(false);
      expect(fs.existsSync(path.dirname(handle.endpointPath))).toBe(false);
      await expect(handle.close()).resolves.toBeUndefined(); // 幂等
      await child.waitFor((event) => event.t === "close", 5000);
    },
    20000,
  );

  it(
    "shutting-down arm: a request processed after close() began answers broker_unavailable (retryable, §6.3)",
    async () => {
      const { handle, bootState } = await startBroker({ closeGraceMs: 900 });
      const entry = mintEntry();
      const reqLine = requestLine(entry);
      const child = spawnClientChild({
        path: handle.endpointPath,
        mode: "hold-then-send",
        line: reqLine,
        instanceId: entry.instanceId,
        token: entry.token,
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      await child.waitFor((event) => event.t === "connected");
      await waitUntil(() => handle.liveConnectionCount >= 1);
      void handle.close(); // 关闭开始；宽限内到达的请求 → broker_unavailable
      const response = await child.waitFor((event) => event.t === "response", 8000);
      expectNullBoundRefusal(response.line as string, "broker_unavailable", bootState);
      const parsed = JSON.parse(response.line as string) as {
        envelope: { response: { error?: { retryable: boolean } } };
      };
      expect(parsed.envelope.response.error?.retryable).toBe(true);
      await child.waitFor((event) => event.t === "close", 5000);
    },
    20000,
  );
});

// ---------------------------------------------------------------------------
// fail-closed（全平台）
// ---------------------------------------------------------------------------

describe("P1.3 Step 3 — fail-closed discipline (all platforms)", () => {
  it(
    "forced-unavailable peer-verification subsystem at boot: degraded_refusing — the socket binds and every request, even fully valid, is refused peer_verification_failed (§5.4, §12)",
    async () => {
      const { handle, bootState, audit } = await startBroker({
        reader: {
          kind: "unavailable",
          detail: "forced for test",
          readAcceptedSocketPeer: async () => null,
        },
      });
      expect(handle.mode).toBe("degraded_refusing");
      // §5.4：socket 照常绑定（诊断可达）。win32 管道端点无文件系统条目（§3.2，
      // ADR-14 D14.1）—— pipe 命名空间不可 stat，绑定的可达性证明由下方客户端
      // 连接 + 签名拒绝行承担（degraded 自持管道照常应答）。
      if (!handle.endpointPath.startsWith("' + bs*4 + '.' + bs*2 + 'pipe' + bs*2 + '")) {
        expect(fs.existsSync(handle.endpointPath)).toBe(true);
      }
      const entry = mintEntry();
      const reqLine = requestLine(entry);
      const child = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: reqLine,
        instanceId: entry.instanceId,
        token: entry.token,
      });
      handle.registerInstance({ ...entry, childPid: child.pid });
      const response = await child.waitFor((event) => event.t === "response");
      expectNullBoundRefusal(response.line as string, "peer_verification_failed", bootState);
      // §11(3)：degraded 状态在入口记录原因（操作员可见诊断）。
      expect(audit.some((event) => event.outcome === "boot" && event.code === "degraded_refusing")).toBe(true);
    },
    20000,
  );

  it(
    "platform default: a platform without a peer-credential reader boots degraded_refusing (fail-closed on unsupported platforms, §5.4)",
    async () => {
      // ADR-13 D13.9 的前提修正：gates-macos CI 会经 PAYSWAP_BROKER_HELPER_{PATH,SHA256}
      // 供给真实 helper —— 本行的语义是"**未供给**任何 helper 的 darwin 默认态"，因此在
      // 本行内显式清除两键（save/delete/restore），供给态的行在 peer-relay/macOS 套件。
      const helperPathKey = "PAYSWAP_BROKER_HELPER_PATH";
      const helperShaKey = "PAYSWAP_BROKER_HELPER_SHA256";
      const savedPath = process.env[helperPathKey];
      const savedSha = process.env[helperShaKey];
      delete process.env[helperPathKey];
      delete process.env[helperShaKey];
      try {
        const { handle } = await startBroker({ platform: "darwin" });
        expect(handle.mode).toBe("degraded_refusing");
        expect(handle.degradedReason).toContain("darwin");
        const { handle: winHandle } = await startBroker({ platform: "win32" });
        expect(winHandle.mode).toBe("degraded_refusing");
        expect(winHandle.degradedReason).toContain("win32");
      } finally {
        if (typeof savedPath === "string") process.env[helperPathKey] = savedPath;
        else delete process.env[helperPathKey];
        if (typeof savedSha === "string") process.env[helperShaKey] = savedSha;
        else delete process.env[helperShaKey];
      }
    },
    20000,
  );

  it(
    "audit ingress: refusals log their typed code (never a stack trace) and no credential material ever appears (§11)",
    async () => {
      const { handle, bootState, audit } = await startBroker();
      const entry = mintEntry();
      // (a) dispatched（门控：注册先行 —— relay 事实即时可得，直接路径的 ss+procfs
      // 延迟不再存在，连接必须等注册完成；直接路径上门控同样正确，只是等待更长）
      const reqLine = requestLine(entry);
      const good = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: reqLine,
        instanceId: entry.instanceId,
        token: entry.token,
        gated: true,
      });
      handle.registerInstance({ ...entry, childPid: good.pid });
      good.release();
      await good.waitFor((event) => event.t === "response");
      // (b) peer 拒绝（未注册进程冒充）
      const impostor = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: requestLine(entry),
        instanceId: entry.instanceId,
        token: entry.token,
      });
      await impostor.waitFor((event) => event.t === "response");
      // (c) token 拒绝（自己的实例 + 错 token）
      const entryBad = mintEntry();
      const wrongToken = randomBytes(32).toString("hex");
      const bad = spawnClientChild({
        path: handle.endpointPath,
        mode: "line",
        line: JSON.stringify({
          instanceId: entryBad.instanceId,
          seq: 1,
          op: "get_account_overview",
          params: {},
          token: wrongToken,
          sessionId: "sess-test",
        }),
        instanceId: entryBad.instanceId,
        token: wrongToken,
        gated: true,
      });
      handle.registerInstance({ ...entryBad, childPid: bad.pid });
      bad.release();
      await bad.waitFor((event) => event.t === "response");
      // typed code 全部落审计；无 stack trace。
      const refused = audit.filter((event) => event.outcome === "refused");
      expect(refused.some((event) => event.code === "peer_verification_failed")).toBe(true);
      // §5.5(3) 的 unauthorized 深度只在 peer_verified 模式可达（Linux ss+procfs /
      // 已供给 helper 的平台）。win32 默认无 helper = degraded（§5.4：peer gate 先于
      // token 步，一切拒绝都是 peer_verification_failed）—— 该深度在 win32 由平台
      // 套件经真实 helper 的链行证明（ADR-14 D14.10）。
      expect(refused.some((event) => event.code === "unauthorized")).toBe(handle.mode === "peer_verified");
      // 凭据材料零泄漏：token / verify key / endpoint path 都不得出现在审计里。
      const auditJson = JSON.stringify(audit);
      expect(auditJson).not.toContain(entry.token);
      expect(auditJson).not.toContain(entryBad.token);
      expect(auditJson).not.toContain(wrongToken);
      expect(auditJson).not.toContain(exportPublicKeyBase64(bootState.keyPair.publicKey));
      expect(auditJson).not.toContain(handle.endpointPath);
    },
    20000,
  );
});

function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitUntil timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}
