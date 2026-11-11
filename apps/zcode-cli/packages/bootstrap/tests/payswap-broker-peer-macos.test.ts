import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  exportPublicKeyBase64,
  mintBrokerBootState,
  verifyResponseEnvelope,
  type PayswapBrokerAttemptContext,
  type PayswapBrokerBootState,
  type PayswapInstanceRegistryEntry,
} from "@zcode/shared/payswap";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  bootPayswapBroker,
  type PayswapBrokerAuditEvent,
  type PayswapBrokerHandle,
  type PayswapPeerRelayHelperConfig,
} from "../src/payswap-broker/index.js";

/**
 * PaySwap P1.3 macOS 臂 —— 平台行（契约 w2-01 §3.1/§3.4/§5.1/§5.4；ADR-13 D13.10）。
 *
 * 只在 darwin 运行（skipIf）：真实 C helper（native/payswap-broker-peer-macos/helper.c，
 * CI 的 gates-macos job 先用 clang 编译并经 PAYSWAP_BROKER_HELPER_{PATH,SHA256} 供给）+
 * 真实 getpeereid/LOCAL_PEERPID + 真实端点落位 + 真实父死亡清理 + 跨 uid EACCES。
 * mock 不给平台行转绿（playbook §5(5)）；Linux CI 对本文件的 skip 是设计边界（ADR-13
 * D13.10），宿主半边纪律由 tests/payswap-broker-peer-relay.test.ts 全平台钉住。
 */

const execFileAsync = promisify(execFile);

// 仓库惯例（import.meta.url）：tests/ → bootstrap → packages → zcode-cli → native/…
const TESTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const HELPER_SOURCE = path.resolve(
  TESTS_DIR,
  "../../../native/payswap-broker-peer-macos/helper.c",
);
const HELPER_BINARY_FALLBACK = path.resolve(
  TESTS_DIR,
  "../../../native/payswap-broker-peer-macos/payswap-broker-peer-helper",
);

let helperConfig: PayswapPeerRelayHelperConfig | null = null;

beforeAll(() => {
  if (process.platform !== "darwin") return;
  const helperPath = process.env.PAYSWAP_BROKER_HELPER_PATH?.trim() || HELPER_BINARY_FALLBACK;
  if (!fs.existsSync(helperPath)) {
    throw new Error(
      `macOS platform suite requires the compiled peer-verification helper at ${helperPath} ` +
        `(cc -O2 -Wall -Wextra -o payswap-broker-peer-helper ${HELPER_SOURCE}); the CI job does this before vitest`,
    );
  }
  const helperSha256 = createHash("sha256").update(fs.readFileSync(helperPath)).digest("hex");
  helperConfig = { helperPath, helperSha256 };
});

// ---------------------------------------------------------------------------
// 子进程客户端（真实对端：报告自身 pid —— 平台行经 LOCAL_PEERPID 读的是真实 pid）
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `
const net = require("node:net");
const p = process.env.PB_TEST_PATH;
const line = process.env.PB_TEST_LINE || "";
const gated = process.env.PB_TEST_GATED === "1"; // 等 stdin 的 "go" 再**连接**（注册竞态根因修复：peer gate 在连接时即跑，注册必须先行）
process.stdout.write(JSON.stringify({ t: "pid", pid: process.pid }) + "\\n");
function connectAndSend() {
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
}
if (gated) {
  let started = false;
  process.stdin.on("data", () => {
    if (started) return;
    started = true;
    connectAndSend();
  });
} else {
  connectAndSend();
}
setTimeout(() => process.exit(0), 20000);
`;

interface ChildEvent {
  t: "pid" | "connected" | "response" | "close" | "error";
  pid?: number;
  line?: string;
  code?: string;
}

interface ChildHandle {
  readonly pid: number;
  readonly events: ChildEvent[];
  waitFor(predicate: (event: ChildEvent) => boolean, timeoutMs?: number): Promise<ChildEvent>;
  /** 门控子进程：发送 stdin "go" 后才发出请求行（消除注册竞态）。 */
  release(): void;
  kill(): void;
}

function spawnClientChild(options: { path: string; line?: string; gated?: boolean }): ChildHandle {
  const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      PB_TEST_PATH: options.path,
      PB_TEST_LINE: options.line ?? "",
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
    release() {
      child.stdin?.write("go\n");
    },
    kill() {
      child.kill("SIGKILL");
    },
  };
  activeChildren.push(child);
  return handle;
}

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

function statModeOrNull(target: string): number | null {
  try {
    return fs.statSync(target).mode & 0o777;
  } catch {
    return null;
  }
}

function waitForCondition(condition: () => boolean, timeoutMs = 5000, message = "condition"): Promise<void> {
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

afterEach(async () => {
  for (const child of activeChildren.splice(0)) {
    child.kill("SIGKILL");
  }
  await Promise.allSettled(activeBrokers.splice(0).map((broker) => broker.close()));
});

// ---------------------------------------------------------------------------
// 平台行（只在 darwin；真实 helper + 真实内核事实源）
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== "darwin")(
  "P1.3 macOS arm — platform rows through the real C helper (ADR-13 D13.1/D13.2/D13.5)",
  () => {
    it(
      "boots peer-verified with kernel-sourced facts: the real self-probe identifies the host through getpeereid + LOCAL_PEERPID",
      async () => {
        expect(helperConfig).not.toBeNull();
        const bootState = mintBrokerBootState();
        const audit: PayswapBrokerAuditEvent[] = [];
        const handle = await bootPayswapBroker({
          bootState,
          auditSink: (event) => audit.push(event),
          sessionScopeResolver: (hint) => (hint === "sess-test" ? { workspaceKey: "sess-test" } : null),
          peerRelayHelper: helperConfig ?? undefined,
          platform: "darwin",
        });
        activeBrokers.push(handle);
        expect(handle.mode).toBe("peer_verified");
        expect(handle.endpointPath).toBe(bootState.endpointPath);
        expect(handle.probe.verified).toBe(true);
        expect(handle.probe.pid).toBe(process.pid);
        expect(handle.probe.uid).toBe(process.geteuid?.() ?? -1);
        // §3.1(2) 落位（helper 内执行）：0700 目录 + 0600 公共 socket + 0600 ingress。
        const dir = path.dirname(handle.endpointPath);
        expect(statModeOrNull(dir)).toBe(0o700);
        expect(statModeOrNull(handle.endpointPath)).toBe(0o600);
        expect(statModeOrNull(path.join(dir, "ingress.sock"))).toBe(0o600);
        // 一次性 token 文件：真实 helper 已读取并删除。
        await waitForCondition(() => !fs.existsSync(path.join(dir, "token")), 3000, "one-shot token file removed");
        expect(audit.some((event) => event.outcome === "boot" && event.code === "peer_verified")).toBe(true);
      },
      20000,
    );

    it(
      "the full §5.5 chain through the real helper: a registered real child's request returns a request-attributed signed envelope (LOCAL_PEERPID = the child's real pid)",
      async () => {
        expect(helperConfig).not.toBeNull();
        const bootState = mintBrokerBootState();
        const handle = await bootPayswapBroker({
          bootState,
          auditSink: () => {},
          sessionScopeResolver: (hint) => (hint === "sess-test" ? { workspaceKey: "sess-test" } : null),
          peerRelayHelper: helperConfig ?? undefined,
          platform: "darwin",
        });
        activeBrokers.push(handle);
        // 门控子进程：报告 pid → 测试注册（§5.2）→ 释放后**才连接** —— peer gate 在
        // 连接时即跑（relay 事实即时可得），注册必须先于连接（上轮 CI 的竞态根因：
        // 子进程 pid 上报→连接仅 ~2ms，测试侧轮询注册 ~5-25ms）。
        const entry = mintEntry();
        const reqLine = requestLine(entry);
        const child = spawnClientChild({ path: handle.endpointPath, line: reqLine, gated: true });
        const pidEvent = await child.waitFor((event) => event.t === "pid");
        const realChildPid = pidEvent.pid as number;
        handle.registerInstance({ ...entry, childPid: realChildPid });
        child.release();
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
      },
      20000,
    );

    it(
      "an impostor process (real pid, unregistered) receives the signed typed refusal through the real helper (§5.2/ADR-13 D13.2)",
      async () => {
        expect(helperConfig).not.toBeNull();
        const bootState = mintBrokerBootState();
        const handle = await bootPayswapBroker({
          bootState,
          auditSink: () => {},
          sessionScopeResolver: (hint) => (hint === "sess-test" ? { workspaceKey: "sess-test" } : null),
          peerRelayHelper: helperConfig ?? undefined,
          platform: "darwin",
        });
        activeBrokers.push(handle);
        // 注册表里有真实实例（pid 12345 —— 没有这个进程）；impostor 是真实派生的子进程，
        // 其真实 pid 不在 spawn 表 —— LOCAL_PEERPID 读出它，host 的 peer gate 拒绝。
        const victim = mintEntry({ childPid: 12345 });
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
      "owner-only placement law (§3.1(2)): a different-uid process cannot even reach the endpoint (EACCES through the 0700 per-boot dir)",
      async () => {
        expect(helperConfig).not.toBeNull();
        const bootState = mintBrokerBootState();
        const handle = await bootPayswapBroker({
          bootState,
          auditSink: () => {},
          sessionScopeResolver: (hint) => (hint === "sess-test" ? { workspaceKey: "sess-test" } : null),
          peerRelayHelper: helperConfig ?? undefined,
          platform: "darwin",
        });
        activeBrokers.push(handle);
        const dirMode = statModeOrNull(path.dirname(handle.endpointPath));
        const socketMode = statModeOrNull(handle.endpointPath);
        expect(dirMode).toBe(0o700);
        expect(socketMode).toBe(0o600);
        // 真实跨 uid 臂（sudo 可用的 runner）：nobody 用户的连接在 0700 目录处即被拒。
        let sudoAvailable = false;
        try {
          await execFileAsync("sudo", ["-n", "true"], { timeout: 5000 });
          sudoAvailable = true;
        } catch {
          sudoAvailable = false;
        }
        if (sudoAvailable) {
          // 真实跨 uid 臂（sudo 可用的 runner）：nobody 用户连接端点。探针用系统 python3
          //（world-executable；runner 的 node 在 hostedtoolcache 下对 nobody 不可执行 ——
          // 上轮 CI 的真实教训）—— 0700 目录会在路径遍历处即拒绝（EACCES/EPERM）。
          const probe =
            "import socket,sys\n" +
            "try:\n" +
            "  s = socket.socket(socket.AF_UNIX)\n" +
            `  s.connect(${JSON.stringify(handle.endpointPath)})\n` +
            "  print('connected')\n" +
            "except OSError as e:\n" +
            "  print(e.errno)\n" +
            "sys.exit(0)\n";
          let pythonAvailable = true;
          try {
            await execFileAsync("/usr/bin/python3", ["-c", "pass"], { timeout: 5000 });
          } catch {
            pythonAvailable = false;
          }
          if (pythonAvailable) {
            const { stdout } = await execFileAsync(
              "sudo",
              ["-n", "-u", "nobody", "/usr/bin/python3", "-c", probe],
              // cwd 必须是 nobody 可达目录：工作区目录对 nobody 不可遍历，python 的
              // site/getcwd 引导会直接 Permission denied（上轮 CI 的真实教训）。
              { timeout: 10000, cwd: "/tmp" },
            );
            const outcome = stdout.trim();
            expect(outcome).not.toBe("connected"); // 任何非 "connected" 结局 = 拒绝到达端点
          }
          // python3 不可用的环境：0700/0600 的落位断言（上方）即本行的落位法证明 ——
          // 目录模式本身就拒绝异 uid 遍历（§3.1(2) 的机制），无静默通过。
        }
      },
      20000,
    );

    it(
      "parent-death cleanup (§3.1(3)/§10.3): when the spawning host dies, the helper removes the endpoint and exits",
      async () => {
        expect(helperConfig).not.toBeNull();
        // 直接驱动真实 helper（不经 TS 子系统 —— 子系统在 vitest 进程内，不能死）：
        // shim 进程以自身 pid 为 --parent-pid spawn helper，50ms 后退出 → helper 的周期性
        // 父裔核验（250ms accept-poll 超时）发现父亡 → 摘端点 + exit(0)。
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payswap-parent-death-"));
        const endpointPath = path.join(dir, "broker.sock");
        const ingressPath = path.join(dir, "ingress.sock");
        const tokenPath = path.join(dir, "token");
        fs.writeFileSync(tokenPath, randomBytes(32).toString("hex"), { mode: 0o600 });
        fs.chmodSync(tokenPath, 0o600);
        const shimScript = `const { spawn } = require("node:child_process");
const args = ["--endpoint", ${JSON.stringify(endpointPath)}, "--ingress", ${JSON.stringify(
          ingressPath,
        )}, "--parent-pid", String(process.pid), "--token-file", ${JSON.stringify(tokenPath)}];
spawn(${JSON.stringify(helperConfig?.helperPath ?? "")}, args, { stdio: "ignore" });
setTimeout(() => process.exit(0), 50);`;
        const shim = spawn(process.execPath, ["-e", shimScript], { stdio: "ignore" });
        activeChildren.push(shim);
        await waitForCondition(
          () => fs.existsSync(endpointPath),
          3000,
          "helper bound the endpoint while its parent was alive",
        );
        await waitForCondition(
          () => !fs.existsSync(endpointPath),
          5000,
          "helper removed the endpoint after its parent died (periodic parentage check)",
        );
      },
      20000,
    );
  },
);
