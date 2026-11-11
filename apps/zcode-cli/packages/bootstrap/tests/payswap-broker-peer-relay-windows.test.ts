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
 * PaySwap P1.3 Windows 臂 —— 宿主侧 relay 纪律（契约 w2-01 §3.2/§5.3/§5.4/§5.5；ADR-14）。
 *
 * 证据边界（ADR-14 D14.10，D13.10 的 win32 形态）：本套件用**协议忠实的 fake helper**（与
 * `native/payswap-broker-peer-windows/Program.cs` 同一二进制接口：argv + stdin token 行 +
 * stdin 控制行 + ingress relay + §5.3(4) 管道口丢弃）在 POSIX CI 上钉住宿主半边 —— POSIX
 * 上 relay 的端点铸造退化为 UDS（Node 的 net 层对 pipe/UDS 形状透明），故宿主半边无需
 * Windows 机器即可证明。fake 的事实是**编造的**（由 PB_FAKE_MODE 与推送的 spawn 表驱动）
 * —— 平台行（真实 GetNamedPipeClientProcessId + 映像路径门、DACL SDDL 回读、父死亡清理、
 * 单实例 busy、pipe 名铸造）只在 win32 的
 * `tests/payswap-broker-peer-windows.test.ts` 里经真实 C# helper 证明；mock 不给平台行
 * 转绿（playbook §5(5)）。
 */

// ---------------------------------------------------------------------------
// fake helper —— Program.cs 的协议忠实替身（#!/usr/bin/env node 可执行文件）
// ---------------------------------------------------------------------------

const FAKE_HELPER_SCRIPT = `#!/usr/bin/env node
// ADR-14 D14.5/D14.3 协议忠实 fake：与 Program.cs 同一 argv/纪律（stdin 首行 = 一次性
// token，此后 append-only 控制行 {"v":1,"add":N,"image":...}；父裔检查（POSIX）；
// 探针连接（第 1 条）= 父臂放行；后续连接按推送的 spawn 表门 —— 表空或 image=null →
// §5.3(4) 管道口丢弃（不 relay、无拒绝行）；放行 → ingress 连接 + v1 头行（uid=0
// win32 哨兵）+ 双向泵）。
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
const parentImage = arg("parent-image");
const mode = process.env.PB_FAKE_MODE || "claim-parent";
const sentinel = process.env.PB_FAKE_SENTINEL;
if (sentinel) { try { fs.writeFileSync(sentinel, ""); } catch {} }
function note(obj) {
  if (!sentinel) return;
  try { fs.appendFileSync(sentinel, JSON.stringify(obj) + "\\n"); } catch {}
}
const table = new Map(); // pid -> image|null（控制行推送）
let token = "";
let started = false;
function startServer() {
  if (started) return;
  started = true;
  if (mode === "exit-early") process.exit(1);
  if (mode === "never-ready") return;
  const server = net.createServer((conn) => {
    const idx = connectionIndex + 1;
    connectionIndex = idx;
    let allowed = false;
    let claimPid = 0;
    if (idx === 1) {
      // 探针连接 = host 自身（父臂，D14.3(a)）。
      allowed = true;
      claimPid = mode === "claim-wrong-pid" ? parentPid + 1 : parentPid;
    } else {
      // 真实纪律：门 = 推送的 spawn 表（最后一条推送即声明 pid）；表空 / image=null → 丢弃。
      const pids = [...table.keys()];
      const last = pids.length > 0 ? pids[pids.length - 1] : 0;
      const image = table.get(last);
      allowed = pids.length > 0 && image !== null && image !== undefined;
      claimPid = last;
    }
    if (!allowed) {
      // §5.3(4)：管道口丢弃 —— 绝不 relay、绝不回行。
      conn.destroy();
      return;
    }
    const t = mode === "wrong-token" ? "f".repeat(64) : token;
    const ic = net.connect(ingress, () => {
      const header = mode === "garbage-header"
        ? "this is not json\\n"
        : JSON.stringify({ v: 1, t, pid: claimPid, uid: 0 }) + "\\n";
      ic.write(header);
      conn.pipe(ic);
      ic.pipe(conn);
    });
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
    note({ ready: true, argv: process.argv.slice(2), parentImage, parentPid,
      ppidOk: process.platform === "win32" ? null : process.ppid === parentPid });
  });
}
let connectionIndex = 0;
function handleStdinLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (!token) {
    if (!/^[0-9a-f]{64}$/.test(trimmed)) process.exit(65);
    token = trimmed;
    startServer();
    return;
  }
  // 控制行：{"v":1,"add":N,"image":"<path>"|null} —— 严格闭键集（D14.5）。
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
  const keys = Object.keys(parsed).sort().join(",");
  if (keys !== "add,image,v" || parsed.v !== 1) return;
  if (!Number.isInteger(parsed.add) || parsed.add <= 0) return;
  if (parsed.image !== null && typeof parsed.image !== "string") return;
  table.set(parsed.add, parsed.image);
  note({ pushed: parsed.add, image: parsed.image });
}
let stdinBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let i;
  while ((i = stdinBuffer.indexOf("\\n")) >= 0) {
    const line = stdinBuffer.slice(0, i);
    stdinBuffer = stdinBuffer.slice(i + 1);
    handleStdinLine(line);
  }
});
process.stdin.on("end", () => process.exit(0)); // host 死亡 → stdin EOF → 退出
process.stdin.on("error", () => process.exit(0));
process.on("SIGTERM", () => {
  try { fs.unlinkSync(endpoint); } catch {}
  process.exit(0);
});
process.on("exit", () => {
  try { fs.unlinkSync(endpoint); } catch {}
});
setTimeout(() => process.exit(0), 60000).unref();
`;

interface FakeHelperHandle {
  readonly config: PayswapPeerRelayHelperConfig;
  readonly sentinelPath: string;
}

function writeFakeHelper(mode: string): FakeHelperHandle {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payswap-relay-win-test-"));
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

/** sentinel 的 JSON 行流（fake 的 argv/推送记录）。 */
function readSentinel(sentinelPath: string): Array<Record<string, unknown>> {
  try {
    return fs
      .readFileSync(sentinelPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 子进程客户端（真实对端：经 helper-held 端点发请求行 / 收响应行）
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
        const tick = (): void => {
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
// broker 启动 / 断言 oracle（与 macOS relay 套件同款纪律；端点按 POSIX 测试缝铸 UDS）
// ---------------------------------------------------------------------------

const activeBrokers: PayswapBrokerHandle[] = [];
const activeChildren: ReturnType<typeof spawn>[] = [];
const tempDirs: string[] = [];

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

/** POSIX 测试缝端点：mkdtemp 目录 + broker.sock（win32 生产形态 = pipe 名，平台行专属）。 */
function mintTestEndpoint(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payswap-win-arm-test-"));
  tempDirs.push(dir);
  return path.join(dir, "broker.sock");
}

function customBootState(endpointPath: string): PayswapBrokerBootState {
  return { hostId: randomUUID(), keyPair: generateKeyPairSync("ed25519"), endpointPath };
}

async function startWindowsRelayBroker(
  overrides: Partial<PayswapBrokerBootOptions> & {
    bootState?: PayswapBrokerBootState;
    peerRelayHelper?: PayswapPeerRelayHelperConfig;
  } = {},
): Promise<{
  handle: PayswapBrokerHandle;
  bootState: PayswapBrokerBootState;
  audit: PayswapBrokerAuditEvent[];
}> {
  const bootState = overrides.bootState ?? customBootState(mintTestEndpoint());
  const audit: PayswapBrokerAuditEvent[] = [];
  const handle = await bootPayswapBroker({
    bootState,
    auditSink: (event) => audit.push(event),
    sessionScopeResolver: (hint) => (hint === "sess-test" ? { workspaceKey: "sess-test" } : null),
    platform: "win32",
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
  // 只恢复本套件显式保存过的键 —— 绝不删除外部（CI）供给的键（D13.9/D14.10）。
  for (const key of SAVED_ENV_KEYS) {
    if (!(key in savedEnv)) continue;
    const saved = savedEnv[key];
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
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  }
});

// ---------------------------------------------------------------------------
// 纯函数行：env 解析（D14 门）与 pipe 名铸造（§3.2(3)）
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")(
  "P1.3 Windows arm — env resolution + pipe-name mint (ADR-14 D14.2; contract §3.2(3))",
  () => {
    it("resolveDefaultPeerRelayHelper resolves win32 when both helper env keys are present (the shared provisioning surface)", () => {
      const helperPath = "/opt/payswap/payswap-broker-peer-helper.exe";
      const helperSha256 = "a".repeat(64);
      const resolved = resolveDefaultPeerRelayHelper("win32", {
        [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: helperPath,
        [PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]: helperSha256,
      });
      expect(resolved).not.toBeNull();
      expect(resolved?.helperPath).toBe(helperPath);
      expect(resolved?.helperSha256).toBe(helperSha256);
      // 半组（缺 SHA-256）不构成供给声明。
      expect(
        resolveDefaultPeerRelayHelper("win32", { [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: helperPath }),
      ).toBeNull();
    });

    it("mintBrokerBootState('win32') mints a per-boot random pipe name (createSocketPath discipline); the default platform keeps today's path", () => {
      const minted = mintBrokerBootState("win32");
      expect(minted.endpointPath).toMatch(/^\\\\\.\\pipe\\payswap-broker-[0-9a-f]{24}$/);
      const second = mintBrokerBootState("win32");
      expect(second.endpointPath).not.toBe(minted.endpointPath);
      // 缺省平台（POSIX 上）保持既有 UDS 路径形状 —— 不因本臂改动。
      const posix = mintBrokerBootState();
      expect(posix.endpointPath).toMatch(/payswap-broker-[0-9a-f]{24}[/\\]broker\.sock$/);
    });
  },
);

// ---------------------------------------------------------------------------
// 探针 / 引导（ADR-14 D14.7 —— D13.5 的 win32 形态）
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")(
  "P1.3 Windows arm — relay boot: stdin-token spawn discipline + real-path self-probe (ADR-14 D14.5/D14.7)",
  () => {
    it(
      "boots peer-verified through the Windows relay: the probe identifies the host itself (pid rule; uid is the win32 sentinel)",
      async () => {
        const fake = writeFakeHelper("claim-parent");
        const { handle, bootState, audit } = await startWindowsRelayBroker({ peerRelayHelper: fake.config });
        expect(handle.mode).toBe("peer_verified");
        // 公共端点仍是铸造路径/名 —— 由 helper 持有（D14.1），host 不 bind。
        expect(handle.endpointPath).toBe(bootState.endpointPath);
        // 探针身份法则（win32 形态）：pid = host 自身；uid = 0 哨兵（同用户边界由 DACL 承担）。
        expect(handle.probe.verified).toBe(true);
        expect(handle.probe.pid).toBe(process.pid);
        expect(handle.probe.uid).toBe(0);
        expect(
          audit.some((event) => event.outcome === "boot" && event.code === "peer_verified"),
        ).toBe(true);
        // fake 就绪记录：argv 纪律（--parent-pid + --parent-image；token 绝不在 argv ——
        // stdin 首行才承载，fake 未收到合法 token 就不会绑定端点）。
        await waitForCondition(
          () => readSentinel(fake.sentinelPath).some((entry) => entry.ready === true),
          5000,
          "fake helper ready sentinel",
        );
        const ready = readSentinel(fake.sentinelPath).find((entry) => entry.ready === true);
        const argv = (ready?.argv as string[] | undefined) ?? [];
        expect(argv).toContain("--parent-pid");
        expect(argv).toContain(String(process.pid));
        expect(argv).toContain("--parent-image");
        expect(ready?.parentImage).toBe(process.execPath);
        expect(ready?.ppidOk).toBe(true);
        // token 不在 argv（D14.5：argv 对同用户进程经 WMI 可见 —— 秘密走 stdin）。
        const argvJoined = argv.join(" ");
        expect(argvJoined).not.toMatch(/[0-9a-f]{64}/);
      },
      20000,
    );

    it(
      "probe identity rule: a helper that relays a foreign pid never verifies — degraded_refusing with the host-held endpoint (diagnostics reachable, §5.4)",
      async () => {
        const fake = writeFakeHelper("claim-wrong-pid");
        const { handle, bootState, audit } = await startWindowsRelayBroker({ peerRelayHelper: fake.config });
        expect(handle.mode).toBe("degraded_refusing");
        expect(handle.degradedReason).toContain("win32");
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
      "probe token check: a relayed header with the wrong token never verifies (constant-time compare arm)",
      async () => {
        const fake = writeFakeHelper("wrong-token");
        const { handle } = await startWindowsRelayBroker({ peerRelayHelper: fake.config });
        expect(handle.mode).toBe("degraded_refusing");
      },
      20000,
    );

    it(
      "probe header strictness: a non-JSON header line never verifies",
      async () => {
        const fake = writeFakeHelper("garbage-header");
        const { handle } = await startWindowsRelayBroker({ peerRelayHelper: fake.config });
        expect(handle.mode).toBe("degraded_refusing");
      },
      20000,
    );

    it(
      "a helper that exits before binding its endpoint degrades via the bounded probe timeout (no hang)",
      async () => {
        const fake = writeFakeHelper("exit-early");
        const started = Date.now();
        const { handle } = await startWindowsRelayBroker({
          peerRelayHelper: { ...fake.config, probeTimeoutMs: 1500 },
        });
        expect(handle.mode).toBe("degraded_refusing");
        expect(Date.now() - started).toBeLessThan(15000);
      },
      20000,
    );

    it(
      "a helper that never binds its endpoint degrades via the bounded probe timeout (no hang)",
      async () => {
        const fake = writeFakeHelper("never-ready");
        const { handle } = await startWindowsRelayBroker({
          peerRelayHelper: { ...fake.config, probeTimeoutMs: 1500 },
        });
        expect(handle.mode).toBe("degraded_refusing");
      },
      20000,
    );

    it(
      "hash verification: a mismatching SHA-256 never spawns the helper (fail-closed before exec)",
      async () => {
        const fake = writeFakeHelper("claim-parent");
        const { handle } = await startWindowsRelayBroker({
          peerRelayHelper: { ...fake.config, helperSha256: "0".repeat(64) },
        });
        expect(handle.mode).toBe("degraded_refusing");
        // helper 从未运行：sentinel 无 ready 记录（D14.5 —— hash 不符不 spawn）。
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(readSentinel(fake.sentinelPath).some((entry) => entry.ready === true)).toBe(false);
      },
      20000,
    );

    it(
      "env resolution: win32 + PAYSWAP_BROKER_HELPER_{PATH,SHA256} activates the relay; a missing binary degrades",
      async () => {
        const fake = writeFakeHelper("claim-parent");
        savedEnv[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY] = process.env[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY];
        savedEnv[PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY] = process.env[PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY];
        process.env[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY] = fake.config.helperPath;
        process.env[PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY] = fake.config.helperSha256;
        const { handle } = await startWindowsRelayBroker({ bootState: customBootState(mintTestEndpoint()) });
        expect(handle.mode).toBe("peer_verified");
        // 声明了但二进制缺席 → degraded（单一验证点在 spawn 前置）。
        process.env[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY] = path.join(
          path.dirname(fake.config.helperPath),
          "definitely-missing-helper",
        );
        const missing = await startWindowsRelayBroker({ bootState: customBootState(mintTestEndpoint()) });
        expect(missing.handle.mode).toBe("degraded_refusing");
        expect(missing.handle.degradedReason).toContain("win32");
      },
      20000,
    );

    it(
      "linux keeps the direct ss+procfs path — the Windows starter never forks a Linux relay (D13.8 discipline, win32 twin)",
      async () => {
        const fake = writeFakeHelper("claim-parent");
        const { handle } = await startWindowsRelayBroker({
          platform: "linux",
          peerRelayHelper: fake.config,
        });
        // Linux：显式 relay 配置也不分叉 —— 直接路径验证（ss+procfs），helper 不 spawn。
        expect(handle.mode).toBe("peer_verified");
        expect(readSentinel(fake.sentinelPath).some((entry) => entry.ready === true)).toBe(false);
      },
      20000,
    );
  },
);

// ---------------------------------------------------------------------------
// 管道口门 + spawn 表推送 + 经 relay 的 §5.5 链（ADR-14 D14.3/D14.8）
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")(
  "P1.3 Windows arm — the pipe gate, the spawn-table push, and the §5.5 chain (ADR-14 D14.3/D14.8)",
  () => {
    it(
      "an unregistered client is dropped at the pipe: no relay, no refusal line (§5.3(4) — the Windows divergence from relay-and-refuse)",
      async () => {
        const fake = writeFakeHelper("claim-parent");
        const { handle } = await startWindowsRelayBroker({ peerRelayHelper: fake.config });
        expect(handle.mode).toBe("peer_verified");
        // 无注册 → 表空 → fake 在管道口丢弃：客户端只看到 close，绝无响应行。
        const impostor = spawnClientChild({ path: handle.endpointPath, line: requestLine(mintEntry()) });
        const endEvent = await impostor.waitFor((event) => event.t === "close" || event.t === "error");
        // 弃连接的终端形态：干净 close 或 RST（error）取决于写/拆交错 —— 实质主张是
        // 零响应字节（无 relay、无拒绝行，§5.3(4)），两种终结都满足它。
        expect(["close", "error"]).toContain(endEvent.t);
        expect(impostor.events.filter((event) => event.t === "response")).toHaveLength(0);
      },
      20000,
    );

    it(
      "a client whose pushed entry has no image path is dropped at the pipe (unverifiable image = unverifiable client, §5.3(1)/(4))",
      async () => {
        const fake = writeFakeHelper("claim-parent");
        const { handle } = await startWindowsRelayBroker({ peerRelayHelper: fake.config });
        expect(handle.mode).toBe("peer_verified");
        const entry = mintEntry({ childPid: 4242 });
        handle.registerInstance(entry);
        // 等推送落进 fake（sentinel 记录 image:null 的控制行）。
        await waitForCondition(
          () => readSentinel(fake.sentinelPath).some((e) => e.pushed === 4242 && e.image === null),
          5000,
          "image-null push sentinel",
        );
        const client = spawnClientChild({ path: handle.endpointPath, line: requestLine(entry) });
        const endEvent = await client.waitFor((event) => event.t === "close" || event.t === "error");
        expect(["close", "error"]).toContain(endEvent.t);
        expect(client.events.filter((event) => event.t === "response")).toHaveLength(0);
      },
      20000,
    );

    it(
      "the spawn-table push end to end: a registered instance's request gets a request-attributed signed envelope through the relay (full chain, uid sentinel accepted)",
      async () => {
        const fake = writeFakeHelper("claim-parent");
        const { handle, bootState, audit } = await startWindowsRelayBroker({ peerRelayHelper: fake.config });
        expect(handle.mode).toBe("peer_verified");
        const entry = mintEntry({ childPid: 9001, childImagePath: process.execPath });
        const reqLine = requestLine(entry);
        handle.registerInstance(entry);
        // 推送落定后才放客户端（生产里由 bridge 的有界重试覆盖注册竞态 —— ADR-10）。
        await waitForCondition(
          () => readSentinel(fake.sentinelPath).some((e) => e.pushed === 9001 && e.image === process.execPath),
          5000,
          "spawn-table push sentinel",
        );
        const child = spawnClientChild({ path: handle.endpointPath, line: reqLine });
        const response = await child.waitFor((event) => event.t === "response");
        const line = response.line as string;
        // 头行 uid = 0（win32 哨兵）≠ POSIX host uid —— 链仍通过：uid 维度由传输声明承担
        //（D14.7 的 peerUidBasis="transport"；POSIX 臂的 uid 检查由 macOS 套件钉住）。
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
              event.peerPid === 9001,
          ),
        ).toBe(true);
      },
      20000,
    );

    it(
      "a relayed connection whose request claims another instance's id is refused at the token gate — claims are checked, never adopted (§5.2(3)/§4.5 host-side belt)",
      async () => {
        const fake = writeFakeHelper("claim-parent");
        const { handle, bootState } = await startWindowsRelayBroker({ peerRelayHelper: fake.config });
        expect(handle.mode).toBe("peer_verified");
        // 已注册实例（pid 9002）：fake 对后续连接声明推送 pid —— 头行事实映射到它。
        const registered = mintEntry({ childPid: 9002, childImagePath: process.execPath });
        handle.registerInstance(registered);
        await waitForCondition(
          () => readSentinel(fake.sentinelPath).some((e) => e.pushed === 9002),
          5000,
          "spawn-table push sentinel",
        );
        // 请求却 claim 另一实例的 instanceId + token —— §5.5(3)：比对对象 = 对端 pid 映射
        // 实例的 token，跨实例 token 在此死亡（N20）。
        const impostor = spawnClientChild({
          path: handle.endpointPath,
          line: requestLine(mintEntry()),
        });
        const response = await impostor.waitFor((event) => event.t === "response");
        expectNullBoundRefusal(response.line as string, "unauthorized", bootState);
      },
      20000,
    );

    it(
      "helper death after a verified boot fails closed: the endpoint disappears, clients cannot connect, close() stays clean",
      async () => {
        const fake = writeFakeHelper("die-after-ready");
        const { handle } = await startWindowsRelayBroker({ peerRelayHelper: fake.config });
        expect(handle.mode).toBe("peer_verified");
        // fake 在探针连接结束后自杀并摘除端点 —— 端点不可达（fail-closed by construction）。
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
      "close() in relay mode: idempotent, tears the helper down, removes the ingress and the endpoint (ADR-6 + D14.1)",
      async () => {
        const fake = writeFakeHelper("claim-parent");
        const { handle } = await startWindowsRelayBroker({ peerRelayHelper: fake.config });
        // POSIX 测试缝：ingress 是 relay 自铸 mkdtemp 目录内的 UDS（win32 生产 = pipe 名，
        // 无文件系统条目 —— 平台行）；fake 的 sentinel argv 记录了 --ingress 的值。
        await waitForCondition(
          () => readSentinel(fake.sentinelPath).some((entry) => entry.ready === true),
          5000,
          "fake helper ready sentinel",
        );
        const ready = readSentinel(fake.sentinelPath).find((entry) => entry.ready === true);
        const argv = (ready?.argv as string[] | undefined) ?? [];
        const ingressIndex = argv.indexOf("--ingress");
        expect(ingressIndex).toBeGreaterThanOrEqual(0);
        const ingressPath = argv[ingressIndex + 1];
        expect(typeof ingressPath).toBe("string");
        await expect(handle.close()).resolves.toBeUndefined();
        await expect(handle.close()).resolves.toBeUndefined();
        // 端点（helper 持有，随停机摘除）、测试端点目录与 ingress（relay 自持）都清理。
        expect(fs.existsSync(handle.endpointPath)).toBe(false);
        expect(fs.existsSync(path.dirname(handle.endpointPath))).toBe(false);
        expect(fs.existsSync(ingressPath as string)).toBe(false);
      },
      20000,
    );
  },
);

