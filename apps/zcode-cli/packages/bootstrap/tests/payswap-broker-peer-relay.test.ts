import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
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
  PAYSWAP_BROKER_HELPER_PATH_ENV_KEY,
  PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY,
  resolveDefaultPeerRelayHelper,
  type PayswapBrokerAuditEvent,
  type PayswapBrokerBootOptions,
  type PayswapBrokerHandle,
  type PayswapPeerRelayHelperConfig,
} from "../src/payswap-broker/index.js";

/**
 * PaySwap P1.3 macOS 臂 —— 宿主侧 relay 纪律（契约 w2-01 §5.1/§5.4/§5.5；ADR-13）。
 *
 * 证据边界（ADR-13 D13.10）：本套件用**协议忠实的 fake helper**（与
 * `native/payswap-broker-peer-macos/helper.c` 同一二进制接口：argv + token 文件 + ingress
 * relay）钉住宿主半边 —— 协议严格性、token 检查、探针身份法则、降级路径、close 语义、
 * 经 relay 的完整 §5.5 链。fake 的事实是**编造的**（由 PB_FAKE_MODE 驱动）—— 平台行
 * （真实 getpeereid/LOCAL_PEERPID、端点落位、父死亡清理、跨 uid EACCES）只在 darwin 的
 * `tests/payswap-broker-peer-macos.test.ts` 里经真实 C helper 证明；mock 不给平台行转绿
 * （playbook §5(5)）。
 */

// ---------------------------------------------------------------------------
// fake helper —— helper.c 的协议忠实替身（#!/usr/bin/env node 可执行文件）
// ---------------------------------------------------------------------------

const FAKE_HELPER_SCRIPT = `#!/usr/bin/env node
// ADR-13 D13.10 协议忠实 fake：与 helper.c 同一 argv/纪律（token 一次性文件、父裔检查、
// §3.4 既有条目移除、0600 socket、每连接一条 ingress relay + 头行 + 双向泵）。
const fs = require("node:fs");
const net = require("node:net");
function arg(name) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1 || i + 1 >= process.argv.length) process.exit(64);
  return process.argv[i + 1];
}
const endpoint = arg("endpoint");
const ingress = arg("ingress");
const parentPid = Number(arg("parent-pid"));
const tokenFile = arg("token-file");
const mode = process.env.PB_FAKE_MODE || "claim-parent";
const sentinel = process.env.PB_FAKE_SENTINEL;
if (sentinel) { try { fs.writeFileSync(sentinel, String(process.pid)); } catch {} }
let token = "";
try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch { process.exit(65); }
try { fs.unlinkSync(tokenFile); } catch {}
if (process.ppid !== parentPid) process.exit(78);
const uid = process.getuid();
let connectionIndex = 0;
if (mode !== "never-ready") {
  try { fs.unlinkSync(endpoint); } catch {}
  const server = net.createServer((conn) => {
    const idx = ++connectionIndex;
    let f = { pid: parentPid, uid };
    if (mode === "claim-wrong-pid") f = { pid: parentPid + 1, uid };
    if (mode === "claim-bad-uid") f = { pid: parentPid, uid: uid + 4242 };
    if (idx > 1 && mode === "flip-foreign-pid") f = { pid: parentPid + 999999, uid };
    if (idx > 1 && mode === "flip-bad-uid") f = { pid: parentPid, uid: uid + 4242 };
    const t = mode === "wrong-token" ? "f".repeat(64) : token;
    const ic = net.connect(ingress, () => {
      const header = mode === "garbage-header"
        ? "this is not json\\n"
        : JSON.stringify({ v: 1, t, pid: f.pid, uid: f.uid }) + "\\n";
      ic.write(header);
      conn.pipe(ic);
      ic.pipe(conn);
    });
    // 泵纪律（与 helper.c 同款）：半关用 end()（FIN 转发，绝不 RST 丢在途字节）；
    // 仅错误侧 destroy。close = 该连接两侧终局 —— die-after-ready 在此裁决。
    const onClosed = () => {
      if (mode === "die-after-ready" && idx === 1) {
        try { fs.unlinkSync(endpoint); } catch {}
        process.exit(0);
      }
    };
    conn.on("end", () => { if (!ic.writableEnded) ic.end(); });
    ic.on("end", () => { if (!conn.writableEnded) conn.end(); });
    conn.on("close", () => { if (!ic.writableEnded) ic.end(); onClosed(); });
    ic.on("close", () => { if (!conn.writableEnded) conn.end(); onClosed(); });
    conn.on("error", () => { conn.destroy(); ic.destroy(); });
    ic.on("error", () => { conn.destroy(); ic.destroy(); });
  });
  server.listen(endpoint, () => {
    try { fs.chmodSync(endpoint, 0o600); } catch {}
  });
}
process.on("SIGTERM", () => {
  try { fs.unlinkSync(endpoint); } catch {}
  process.exit(0);
});
process.on("exit", () => {
  try { fs.unlinkSync(endpoint); } catch {}
});
if (mode === "exit-early") process.exit(1);
setTimeout(() => process.exit(0), 60000).unref();
`;

interface FakeHelperHandle {
  readonly config: PayswapPeerRelayHelperConfig;
  readonly sentinelPath: string;
}

function writeFakeHelper(mode: string): FakeHelperHandle {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payswap-relay-test-"));
  const helperPath = path.join(dir, "payswap-broker-peer-helper");
  // 模式经 env 传递（脚本内容不变 → 同一二进制可多模式复用；hash 固定于内容）。
  const sentinelPath = path.join(dir, "sentinel");
  fs.writeFileSync(helperPath, FAKE_HELPER_SCRIPT, { mode: 0o755 });
  fs.chmodSync(helperPath, 0o755);
  process.env.PB_FAKE_MODE = mode;
  process.env.PB_FAKE_SENTINEL = sentinelPath;
  const helperSha256 = createHash("sha256").update(FAKE_HELPER_SCRIPT).digest("hex");
  return { config: { helperPath, helperSha256 }, sentinelPath };
}

// ---------------------------------------------------------------------------
// 子进程客户端（真实对端 socket：经 helper-held 端点发请求行 / 收响应行）
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `
const net = require("node:net");
const p = process.env.PB_TEST_PATH;
const line = process.env.PB_TEST_LINE || "";
const s = net.connect(p, () => {
  process.stdout.write(JSON.stringify({ t: "connected" }) + "\\n");
  if (line) s.write(line + "\\n");
});
let acc = "";
s.on("data", (d) => {
  acc += d.toString("utf8");
  let i;
  while ((i = acc.indexOf("\\n")) >= 0) { process.stdout.write(JSON.stringify({ t: "response", line: acc.slice(0, i) }) + "\\n"); acc = acc.slice(i + 1); }
});
s.on("close", () => { process.stdout.write(JSON.stringify({ t: "close" }) + "\\n"); process.exit(0); });
s.on("error", (e) => { process.stdout.write(JSON.stringify({ t: "error", code: e.code }) + "\\n"); process.exit(0); });
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

function spawnClientChild(options: { path: string; line?: string }): ChildHandle {
  const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      PB_TEST_PATH: options.path,
      PB_TEST_LINE: options.line ?? "",
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
// broker 启动 / 断言 oracle（与 peer-verification 套件同款纪律）
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

function requestLine(entry: { instanceId: string; token: string }, seq = 1): string {
  return JSON.stringify({
    instanceId: entry.instanceId,
    seq,
    op: "get_account_overview",
    params: {},
    token: entry.token,
    sessionId: "sess-test",
  });
}

function customBootState(endpointPath: string): PayswapBrokerBootState {
  return { hostId: randomUUID(), keyPair: generateKeyPairSync("ed25519"), endpointPath };
}

async function startRelayBroker(
  overrides: Partial<PayswapBrokerBootOptions> & {
    bootState?: PayswapBrokerBootState;
    peerRelayHelper?: PayswapPeerRelayHelperConfig;
  } = {},
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
    sessionScopeResolver: (hint) => (hint === "sess-test" ? { workspaceKey: "sess-test" } : null),
    platform: "darwin",
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

function attemptFor(entry: { instanceId: string }, requestLineSent: string): PayswapBrokerAttemptContext {
  return { instanceId: entry.instanceId, seq: 1, op: "get_account_overview", sentLine: requestLineSent };
}

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

/** 直连 ingress 的裸客户端（宿主侧协议行：伪造 token / 垃圾头行）。 */
function connectRawToIngress(ingressPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(ingressPath, () => resolve(socket));
    socket.once("error", reject);
  });
}

function readOneLineFromSocket(socket: net.Socket, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`ingress line read timed out; buffer: ${JSON.stringify(buffer)}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index >= 0) {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("close", onClose);
        socket.off("error", onClose);
        resolve(buffer.slice(0, index));
      }
    };
    const onClose = () => {
      clearTimeout(timer);
      reject(new Error(`ingress closed before a line; buffer: ${JSON.stringify(buffer)}`));
    };
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onClose);
  });
}

function statModeOrNull(target: string): number | null {
  try {
    return fs.statSync(target).mode & 0o777;
  } catch {
    return null;
  }
}

function waitForCondition(
  condition: () => boolean,
  timeoutMs = 5000,
  message = "condition",
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitForCondition timed out: ${message}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

const SAVED_ENV_KEYS = [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY, PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY] as const;
const savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
  for (const key of SAVED_ENV_KEYS) {
    const saved = savedEnv[key];
    // 仅字符串才回写：把 undefined 赋给 process.env 会变成字面量 "undefined" 字符串。
    if (typeof saved === "string") {
      process.env[key] = saved;
    } else {
      delete process.env[key];
    }
    delete savedEnv[key];
  }
  delete process.env.PB_FAKE_MODE;
  delete process.env.PB_FAKE_SENTINEL;
  for (const child of activeChildren.splice(0)) {
    child.kill("SIGKILL");
  }
  await Promise.allSettled(activeBrokers.splice(0).map((broker) => broker.close()));
});

// ---------------------------------------------------------------------------
// 探针 / 引导（ADR-13 D13.5）
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")(
  "P1.3 macOS arm — relay boot: spawn discipline + real-path self-probe (ADR-13 D13.4/D13.5)",
  () => {
    it(
      "boots peer-verified through the relay: the probe identifies the host itself through the helper-held public endpoint",
      async () => {
        const fake = writeFakeHelper("claim-parent");
        const { handle, bootState, audit } = await startRelayBroker({ peerRelayHelper: fake.config });
        expect(handle.mode).toBe("peer_verified");
        // 公共端点仍是铸造路径 —— 由 helper 持有（D13.1），五键组不变。
        expect(handle.endpointPath).toBe(bootState.endpointPath);
        // 探针身份：pid/uid 都是 host 自身（ADR-4 法则的 relay 形态）。
        expect(handle.probe.verified).toBe(true);
        expect(handle.probe.pid).toBe(process.pid);
        expect(handle.probe.uid).toBe(process.geteuid?.() ?? -1);
        // §3.1(2) 落位：0700 目录 + 0600 ingress socket；公共端点由 helper 持有。
        const dir = path.dirname(handle.endpointPath);
        expect(statModeOrNull(dir)).toBe(0o700);
        expect(statModeOrNull(path.join(dir, "ingress.sock"))).toBe(0o600);
        // 一次性 token 文件：helper 已读取并删除（D13.4）。
        const tokenFile = path.join(dir, "token");
        await waitForCondition(() => !fs.existsSync(tokenFile), 3000, "token file one-shot unlink");
        expect(audit.some((event) => event.outcome === "boot" && event.code === "peer_verified")).toBe(true);
      },
      20000,
    );

    it(
      "probe identity rule: a helper that relays a foreign pid never verifies — degraded_refusing with the host-held endpoint (diagnostics reachable)",
      async () => {
        const fake = writeFakeHelper("claim-wrong-pid");
        const { handle, bootState, audit } = await startRelayBroker({ peerRelayHelper: fake.config });
        expect(handle.mode).toBe("degraded_refusing");
        expect(handle.degradedReason).toContain("darwin");
        expect(handle.probe.verified).toBe(false);
        expect(
          audit.some((event) => event.outcome === "boot" && event.code === "degraded_refusing"),
        ).toBe(true);
        // §5.4：degraded 也绑定端点（host 自持）—— 客户端拿到签名 typed 拒绝行。
        const client = spawnClientChild({ path: handle.endpointPath, line: "{}" });
        const response = await client.waitFor((event) => event.t === "response");
        expectNullBoundRefusal(response.line as string, "peer_verification_failed", bootState);
      },
      20000,
    );

    it(
      "probe identity rule: a helper that relays a wrong uid never verifies (uid dimension)",
      async () => {
        const fake = writeFakeHelper("claim-bad-uid");
        const { handle } = await startRelayBroker({ peerRelayHelper: fake.config });
        expect(handle.mode).toBe("degraded_refusing");
      },
      20000,
    );

    it(
      "probe token check: a relayed header with the wrong token never verifies (D13.4 constant-time compare arm)",
      async () => {
        const fake = writeFakeHelper("wrong-token");
        const { handle } = await startRelayBroker({ peerRelayHelper: fake.config });
        expect(handle.mode).toBe("degraded_refusing");
      },
      20000,
    );

    it(
      "probe header strictness: a non-JSON header line never verifies",
      async () => {
        const fake = writeFakeHelper("garbage-header");
        const { handle } = await startRelayBroker({ peerRelayHelper: fake.config });
        expect(handle.mode).toBe("degraded_refusing");
      },
      20000,
    );

    it(
      "helper spawn failure (immediate exit) degrades fail-closed with the reason recorded",
      async () => {
        const fake = writeFakeHelper("exit-early");
        const { handle } = await startRelayBroker({ peerRelayHelper: fake.config });
        expect(handle.mode).toBe("degraded_refusing");
      },
      20000,
    );

    it(
      "helper that never binds its endpoint degrades via the bounded probe timeout (no hang)",
      async () => {
        const fake = writeFakeHelper("never-ready");
        const startedAt = Date.now();
        const { handle } = await startRelayBroker({
          peerRelayHelper: { ...fake.config, probeTimeoutMs: 800 },
        });
        expect(handle.mode).toBe("degraded_refusing");
        expect(Date.now() - startedAt).toBeLessThan(10_000);
      },
      20000,
    );

    it(
      "hash verification: a mismatching SHA-256 never spawns the helper (fail-closed before exec)",
      async () => {
        const fake = writeFakeHelper("claim-parent");
        const { handle } = await startRelayBroker({
          peerRelayHelper: { ...fake.config, helperSha256: "0".repeat(64) },
        });
        expect(handle.mode).toBe("degraded_refusing");
        // helper 从未运行：sentinel 不存在（D13.4 —— hash 不符不 spawn）。
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(fs.existsSync(fake.sentinelPath)).toBe(false);
      },
      20000,
    );

    it(
      "§3.4 endpoint replacement: a pre-planted stale entry at the endpoint path is removed by the helper, never silently adopted",
      async () => {
        const endpointDir = fs.mkdtempSync(path.join(os.tmpdir(), "payswap-relay-stale-"));
        const endpointPath = path.join(endpointDir, "broker.sock");
        fs.writeFileSync(endpointPath, "stale");
        const fake = writeFakeHelper("claim-parent");
        const { handle } = await startRelayBroker({
          bootState: customBootState(endpointPath),
          peerRelayHelper: fake.config,
        });
        expect(handle.mode).toBe("peer_verified");
        // 端点已由 helper 重新绑定（真实 socket 而非 pre-plant 残骸）。
        expect(statModeOrNull(endpointPath)).toBe(0o600);
      },
      20000,
    );

    it(
      "env resolution: darwin + PAYSWAP_BROKER_HELPER_{PATH,SHA256} activates the relay; a missing binary degrades",
      async () => {
        const fake = writeFakeHelper("claim-parent");
        savedEnv[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY] = process.env[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY];
        savedEnv[PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY] = process.env[PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY];
        process.env[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY] = fake.config.helperPath;
        process.env[PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY] = fake.config.helperSha256;
        expect(resolveDefaultPeerRelayHelper("darwin", process.env)).not.toBeNull();
        const { handle } = await startRelayBroker({});
        expect(handle.mode).toBe("peer_verified");

        // 缺席二进制：resolveDefault 返回 config（env 声明了），但 spawn 前发现不存在 → degraded。
        process.env[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY] = path.join(
          fs.mkdtempSync(path.join(os.tmpdir(), "payswap-relay-missing-")),
          "no-such-helper",
        );
        const missing = await startRelayBroker({});
        expect(missing.handle.mode).toBe("degraded_refusing");
      },
      20000,
    );

    it(
      "darwin without any provisioned helper stays degraded_refusing (default unchanged; seam regression row)",
      async () => {
        const { handle } = await startRelayBroker({});
        expect(handle.mode).toBe("degraded_refusing");
        expect(handle.degradedReason).toContain("darwin");
      },
      20000,
    );

    it(
      "linux keeps the direct ss+procfs path — the relay seam never forks a second Linux implementation (D13.8)",
      async () => {
        const fake = writeFakeHelper("claim-parent");
        const { handle } = await startRelayBroker({
          platform: "linux",
          peerRelayHelper: fake.config,
        });
        // Linux：显式 relay 配置也不应分叉 —— 直接路径验证（ss+procfs），helper 不 spawn。
        expect(handle.mode).toBe("peer_verified");
        expect(fs.existsSync(fake.sentinelPath)).toBe(false);
      },
      20000,
    );
  },
);

// ---------------------------------------------------------------------------
// 经 relay 的 §5.5 链与宿主侧协议行（D13.2/D13.3/D13.6）
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")(
  "P1.3 macOS arm — the §5.5 chain through the relay + host-side protocol rows (ADR-13 D13.2/D13.3)",
  () => {
    it(
      "a registered instance's fully-valid request gets a request-attributed signed envelope through the relay (full chain)",
      async () => {
        const fake = writeFakeHelper("claim-parent");
        const { handle, bootState, audit } = await startRelayBroker({ peerRelayHelper: fake.config });
        // fake 对每个连接都声明 parent pid（host 自身）→ 注册 childPid = host pid 即可过 peer gate
        // （宿主半行裁决的是 relay 事实的处理，不是事实的读取 —— 那是平台行）。
        const entry = mintEntry({ childPid: process.pid });
        const reqLine = requestLine(entry);
        const child = spawnClientChild({ path: handle.endpointPath, line: reqLine });
        handle.registerInstance(entry);
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
        expect(
          audit.some(
            (event) =>
              event.outcome === "dispatched" &&
              event.instanceId === entry.instanceId &&
              event.peerPid === process.pid,
          ),
        ).toBe(true);
      },
      20000,
    );

    it(
      "a relayed connection claiming an unregistered pid receives the signed typed refusal through the relay (§5.2(3) — claims are checked, never adopted)",
      async () => {
        const fake = writeFakeHelper("flip-foreign-pid");
        const { handle, bootState } = await startRelayBroker({ peerRelayHelper: fake.config });
        const victim = mintEntry({ childPid: process.pid });
        handle.registerInstance(victim);
        const impostor = spawnClientChild({
          path: handle.endpointPath,
          line: requestLine(victim),
        });
        const response = await impostor.waitFor((event) => event.t === "response");
        expectNullBoundRefusal(response.line as string, "peer_verification_failed", bootState);
      },
      20000,
    );

    it(
      "a relayed connection claiming a wrong uid receives the signed typed refusal (§5.1(2) through the relay)",
      async () => {
        const fake = writeFakeHelper("flip-bad-uid");
        const { handle, bootState } = await startRelayBroker({ peerRelayHelper: fake.config });
        const victim = mintEntry({ childPid: process.pid });
        handle.registerInstance(victim);
        const client = spawnClientChild({
          path: handle.endpointPath,
          line: requestLine(victim),
        });
        const response = await client.waitFor((event) => event.t === "response");
        expectNullBoundRefusal(response.line as string, "peer_verification_failed", bootState);
      },
      20000,
    );

    it(
      "a direct ingress connection with a wrong token is refused at the peer gate (D13.6 — the token is the trust boundary)",
      async () => {
        const fake = writeFakeHelper("claim-parent");
        const { handle, bootState } = await startRelayBroker({ peerRelayHelper: fake.config });
        const ingressPath = path.join(path.dirname(handle.endpointPath), "ingress.sock");
        const socket = await connectRawToIngress(ingressPath);
        socket.write(
          `${JSON.stringify({ v: 1, t: "f".repeat(64), pid: process.pid, uid: process.getuid() })}\n${requestLine(mintEntry())}\n`,
        );
        const line = await readOneLineFromSocket(socket);
        expectNullBoundRefusal(line, "peer_verification_failed", bootState);
        socket.destroy();
      },
      20000,
    );

    it(
      "a direct ingress connection with a malformed header line is refused at the peer gate (protocol strictness)",
      async () => {
        const fake = writeFakeHelper("claim-parent");
        const { handle, bootState } = await startRelayBroker({ peerRelayHelper: fake.config });
        const ingressPath = path.join(path.dirname(handle.endpointPath), "ingress.sock");
        const socket = await connectRawToIngress(ingressPath);
        socket.write("not json at all\n{}\n");
        const line = await readOneLineFromSocket(socket);
        expectNullBoundRefusal(line, "peer_verification_failed", bootState);
        socket.destroy();
      },
      20000,
    );

    it(
      "helper death after a verified boot fails closed: the endpoint disappears, clients cannot connect, close() stays clean",
      async () => {
        const fake = writeFakeHelper("die-after-ready");
        const { handle } = await startRelayBroker({ peerRelayHelper: fake.config });
        expect(handle.mode).toBe("peer_verified");
        // helper 在探针连接结束后自杀并摘除端点 —— 端点不可达（fail-closed by construction）。
        await waitForCondition(
          () => !fs.existsSync(handle.endpointPath),
          5000,
          "helper-held endpoint removed after helper death",
        );
        const client = spawnClientChild({ path: handle.endpointPath });
        const event = await client.waitFor((event2) => event2.t === "error" || event2.t === "close");
        expect(["ECONNREFUSED", "ENOENT"]).toContain(event.code ?? "");
        await expect(handle.close()).resolves.toBeUndefined();
      },
      20000,
    );

    it(
      "close() in relay mode: idempotent, removes the ingress socket, the endpoint and the per-boot directory (ADR-6 + D13.1)",
      async () => {
        const fake = writeFakeHelper("claim-parent");
        const { handle } = await startRelayBroker({ peerRelayHelper: fake.config });
        const dir = path.dirname(handle.endpointPath);
        const ingressPath = path.join(dir, "ingress.sock");
        expect(fs.existsSync(ingressPath)).toBe(true);
        await handle.close();
        await expect(handle.close()).resolves.toBeUndefined();
        expect(fs.existsSync(ingressPath)).toBe(false);
        expect(fs.existsSync(handle.endpointPath)).toBe(false);
        expect(fs.existsSync(dir)).toBe(false);
      },
      20000,
    );
  },
);
