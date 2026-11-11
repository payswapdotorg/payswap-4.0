import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
 * PaySwap P1.3 Windows 臂 —— 平台行（契约 w2-01 §3.2/§5.3/§5.4；ADR-14 D14.10）。
 *
 * 只在 win32 运行（skipIf）：真实 C# helper（native/payswap-broker-peer-windows/，
 * CI 的 gates-windows job 先用 dotnet publish 发布并经
 * PAYSWAP_BROKER_HELPER_{PATH,SHA256} 供给）+ 真实 DACL/单实例管道 + 真实
 * GetNamedPipeClientProcessId + 真实映像路径门 + 真实父死亡清理。mock 不给平台行
 * 转绿（playbook §5(5)）；POSIX CI 对本文件的 skip 是设计边界（ADR-14 D14.10），
 * 宿主半边纪律由 tests/payswap-broker-peer-relay-windows.test.ts 在 POSIX 上钉住。
 */

const execFileAsync = promisify(execFile);

// 仓库惯例（import.meta.url）：tests/ → bootstrap → packages → zcode-cli → native/…
const TESTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const HELPER_PROJECT = path.resolve(
  TESTS_DIR,
  "../../../native/payswap-broker-peer-windows",
);
const HELPER_BINARY_FALLBACK = path.join(HELPER_PROJECT, "out", "payswap-broker-peer-helper.exe");

let helperConfig: PayswapPeerRelayHelperConfig | null = null;

beforeAll(() => {
  if (process.platform !== "win32") return;
  const helperPath = process.env.PAYSWAP_BROKER_HELPER_PATH?.trim() || HELPER_BINARY_FALLBACK;
  if (!fs.existsSync(helperPath)) {
    throw new Error(
      `Windows platform suite requires the published peer-verification helper at ${helperPath} ` +
        `(dotnet publish ${HELPER_PROJECT} -c Release -o ${path.join(HELPER_PROJECT, "out")}); the CI job does this before vitest`,
    );
  }
  const helperSha256 = createHash("sha256").update(fs.readFileSync(helperPath)).digest("hex");
  const envSha = process.env.PAYSWAP_BROKER_HELPER_SHA256?.trim().toLowerCase();
  if (envSha !== undefined && envSha !== helperSha256) {
    throw new Error(
      `PAYSWAP_BROKER_HELPER_SHA256 mismatch for ${helperPath} (env ${envSha}, actual ${helperSha256})`,
    );
  }
  helperConfig = { helperPath, helperSha256 };
});

// ---------------------------------------------------------------------------
// 门控子进程客户端（macOS 套件同款：上报 pid → 测试注册（§5.2）→ release 后才连接）
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `
const net = require("node:net");
const p = process.env.PB_TEST_PATH;
const line = process.env.PB_TEST_LINE || "";
const holdMs = Number(process.env.PB_TEST_HOLD_MS || "0");
const gated = process.env.PB_TEST_GATED === "1"; // 等 stdin 的 "go" 再**连接**（注册竞态根因修复：管道口门在连接时即跑，注册必须先行）
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
  if (holdMs > 0) setTimeout(() => {}, holdMs);
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
setTimeout(() => process.exit(0), 30000);
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
  /** 门控子进程：发送 stdin "go" 后才连接（消除注册竞态）。 */
  release(): void;
  kill(): void;
}

function spawnClientChild(options: { path: string; line?: string; gated?: boolean; holdMs?: number }): ChildHandle {
  const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      PB_TEST_PATH: options.path,
      PB_TEST_LINE: options.line ?? "",
      PB_TEST_HOLD_MS: String(options.holdMs ?? 0),
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
    release() {
      child.stdin.write("go\n");
    },
    kill() {
      child.kill();
    },
  };
  activeChildren.push(child);
  return handle;
}

// ---------------------------------------------------------------------------
// broker 启动 / 断言 oracle
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

async function startRealHelperBroker(diagPath?: string): Promise<{
  handle: PayswapBrokerHandle;
  bootState: PayswapBrokerBootState;
  audit: PayswapBrokerAuditEvent[];
}> {
  if (helperConfig === null) {
    throw new Error("platform suite helper config unavailable (win32-only beforeAll)");
  }
  const bootState = mintBrokerBootState();
  const audit: PayswapBrokerAuditEvent[] = [];
  const handle = await bootPayswapBroker({
    bootState,
    auditSink: (event) => audit.push(event),
    sessionScopeResolver: (hint) => (hint === "sess-test" ? { workspaceKey: "sess-test" } : null),
    peerRelayHelper:
      diagPath === undefined
        ? helperConfig
        : { ...helperConfig, helperArgs: ["--diag", diagPath] },
  });
  activeBrokers.push(handle);
  return { handle, bootState, audit };
}

/** 诊断文件的当前内容（--diag 缺省 = 空串）；行级 CI 定位面（D14.10）。 */
function readDiag(diagPath?: string): string {
  if (diagPath === undefined) return "(no diag)";
  try {
    return fs.readFileSync(diagPath, "utf8");
  } catch {
    return "(diag unavailable)";
  }
}

/** 每行一枚诊断文件（win32 runner 专用路径）。 */
function mintDiagPath(row: string): string {
  return path.join(os.tmpdir(), `payswap-win-diag-${row}-${randomBytes(4).toString("hex")}.log`);
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

afterEach(async () => {
  for (const child of activeChildren.splice(0)) {
    child.kill();
  }
  await Promise.allSettled(activeBrokers.splice(0).map((broker) => broker.close()));
});

// ---------------------------------------------------------------------------
// 平台行（ADR-14 D14.10 —— 只在 win32 经真实 C# helper 证明）
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== "win32")(
  "P1.3 Windows arm — platform rows through the real C# helper (ADR-14; contract §3.2/§5.3)",
  () => {
    it(
      "boots peer-verified with kernel-sourced facts: the real self-probe identifies the host through GetNamedPipeClientProcessId over the named pipe",
      async () => {
        const { handle, audit } = await startRealHelperBroker();
        expect(handle.mode, `boot degraded: ${handle.degradedReason ?? "(no reason)"}`).toBe("peer_verified");
        // 探针身份法则（win32 形态）：pid = host 自身；uid = 0 哨兵（同用户边界由 DACL 承担）。
        expect(handle.probe.verified).toBe(true);
        expect(handle.probe.pid).toBe(process.pid);
        expect(handle.probe.uid).toBe(0);
        // 公共端点 = 铸造的 per-boot 随机管道名（§3.2(3)）。
        expect(handle.endpointPath).toMatch(/^\\\\\.\\pipe\\payswap-broker-[0-9a-f]{24}$/);
        expect(
          audit.some((event) => event.outcome === "boot" && event.code === "peer_verified"),
        ).toBe(true);
      },
      30000,
    );

    it(
      "the full §5.5 chain through the real helper: a registered real child's request returns a request-attributed signed envelope (GetNamedPipeClientProcessId = the child's real pid)",
      async () => {
        const diagPath = mintDiagPath("chain");
        try {
        const { handle, bootState, audit } = await startRealHelperBroker(diagPath);
        expect(handle.mode, `boot degraded: ${handle.degradedReason ?? "(no reason)"}`).toBe("peer_verified");
        // 门控子进程：上报 pid → 注册（真实 pid + 真实映像 spawnfile）→ release 后连接。
        const entry = mintEntry({ childImagePath: process.execPath });
        const reqLine = requestLine(entry);
        const child = spawnClientChild({ path: handle.endpointPath, line: reqLine, gated: true });
        const pidEvent = await child.waitFor((event) => event.t === "pid");
        const realChildPid = pidEvent.pid as number;
        handle.registerInstance({ ...entry, childPid: realChildPid });
        // §5.3(4) 的注册竞态（round-3 CI 教训）：控制行（stdin）与子进程连接是两条路
        // 径，推送未落表时管道口门弃该 pid 是**按设计正确**（生产里由 bridge 的有界
        // 字节等价重试覆盖，ADR-10/D14.8）；平台行顺序化等待推送落表再放行客户端。
        await new Promise((resolve) => setTimeout(resolve, 400));
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
        expect(
          audit.some(
            (event) =>
              event.outcome === "dispatched" &&
              event.instanceId === entry.instanceId &&
              event.peerPid === realChildPid,
          ),
          readDiag(diagPath),
        ).toBe(true);
        } catch (error) {
          throw new Error(`${String(error)}\n--- helper diag ---\n${readDiag(diagPath)}`);
        }
      },
      30000,
    );

    it(
      "an impostor process (real pid, unregistered) is dropped at the pipe: no relay, no refusal line (§5.3(1)/(4))",
      async () => {
        const diagPath = mintDiagPath("impostor");
        try {
        const { handle, bootState } = await startRealHelperBroker(diagPath);
        expect(handle.mode, `boot degraded: ${handle.degradedReason ?? "(no reason)"}`).toBe("peer_verified");
        // 未注册的真实进程连接 —— 管道口门拒绝（GetNamedPipeClientProcessId ∉ 表）。
        const impostor = spawnClientChild({ path: handle.endpointPath, line: requestLine(mintEntry()) });
        const endEvent = await impostor.waitFor((event) => event.t === "close" || event.t === "error");
        // 管道口弃连接的终端形态：干净 close 或管道破（error）—— 实质主张是零响应字节
        //（无 relay、无拒绝行，§5.3(1)/(4)）。
        expect(["close", "error"]).toContain(endEvent.t);
        expect(impostor.events.filter((event) => event.t === "response")).toHaveLength(0);
        // 门不因拒绝而卡死：随后一个已注册子进程仍过门（claim 另一实例 token → host 侧
        // unauthorized 签名拒绝行 —— 也证明 relaying 在 drop 之后照常工作）。
        // §5.5(3)/N20（round-5 教训：此前误把同一实例的 token 发给已映射到它的子进程 ——
        // 比对对象是对端 pid 映射实例的 token，同实例 token 必过门 → not_connected 而非
        // unauthorized；宿主半边同型行（peer-relay-windows 套件）才是本意：注册 A，claim B。
        const entry = mintEntry({ childImagePath: process.execPath });
        const child = spawnClientChild({ path: handle.endpointPath, line: requestLine(mintEntry()), gated: true });
        await child.waitFor((event) => event.t === "pid");
        handle.registerInstance({ ...entry, childPid: child.pid });
        // 同上：等推送落表再放行（§5.3(4) 竞态的顺序化）。
        await new Promise((resolve) => setTimeout(resolve, 400));
        child.release();
        const response = await child.waitFor((event) => event.t === "response");
        expectNullBoundRefusal(response.line as string, "unauthorized", bootState);
        } catch (error) {
          throw new Error(`${String(error)}\n--- helper diag ---\n${readDiag(diagPath)}`);
        }
      },
      30000,
    );

    it(
      "the image-path gate: a registered pid with a wrong expected image is dropped at the pipe (QueryFullProcessImageName mismatch)",
      async () => {
        const diagPath = mintDiagPath("image");
        try {
        const { handle } = await startRealHelperBroker(diagPath);
        expect(handle.mode, `boot degraded: ${handle.degradedReason ?? "(no reason)"}`).toBe("peer_verified");
        // 注册真实 pid，但期望映像指向不存在的路径 —— 映像门拒绝（§5.3(1)）。
        const entry = mintEntry({ childImagePath: "C:\\payswap-arm-test\\definitely-not-the-image.exe" });
        const child = spawnClientChild({ path: handle.endpointPath, line: requestLine(entry), gated: true });
        await child.waitFor((event) => event.t === "pid");
        handle.registerInstance({ ...entry, childPid: child.pid });
        // 等推送落表再放行（同链/占用两行：控制行与连接是两路径，先落表才轮得到
        // 映像门裁决 —— 否则 not-in-table 弃接无鉴别力）。
        await new Promise((resolve) => setTimeout(resolve, 400));
        child.release();
        const endEvent = await child.waitFor((event) => event.t === "close" || event.t === "error");
        expect(["close", "error"]).toContain(endEvent.t);
        expect(child.events.filter((event) => event.t === "response")).toHaveLength(0);
        // 弃因必须是映像门（round-5 教训：终端形态断言对 not-in-table 与
        // image-mismatch 同形 —— 该行曾在控制行解析缺陷下空洞通过。reason 断言同时是
        // 控制行解析修复在真实 helper 上的回归钉：先有 control:add 才可能 image-mismatch）。
        expect(readDiag(diagPath), "expected gate:drop reason=image-mismatch").toContain(
          `gate:drop pid=${child.pid} reason=image-mismatch`,
        );
        } catch (error) {
          throw new Error(`${String(error)}\n--- helper diag ---\n${readDiag(diagPath)}`);
        }
      },
      30000,
    );

    it(
      "the DACL row: the created pipe's SDDL grants the current user read/write, is protected from inheritance, and grants no Everyone/Anonymous/Authenticated-Users/Builtin-Users (§3.2(2))",
      async () => {
        if (helperConfig === null) throw new Error("helper config unavailable");
        // --describe-security：helper 以生产纪律建一枚随机名管道，回读 SDDL 后退出。
        const { stdout } = await execFileAsync(helperConfig.helperPath, ["--describe-security"], {
          timeout: 20000,
        });
        const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
        const sddl = lines.find((line) => line.startsWith("SDDL:"))?.slice("SDDL:".length) ?? "";
        const sid = lines.find((line) => line.startsWith("SID:"))?.slice("SID:".length) ?? "";
        const maxInstances = lines.find((line) => line.startsWith("MAXINSTANCES:"))?.slice("MAXINSTANCES:".length) ?? "";
        expect(sddl.length).toBeGreaterThan(0);
        expect(sid).toMatch(/^S-1-5-/);
        expect(maxInstances).toBe("1");
        // 语义判定（round-2 CI 教训：SDDL 渲染因账户形态而异 —— 内建管理员 -500 显示
        // 为 LA 速记、权利掩码显示为十六进制而非 GRGW 助记）：直接断言规则行。
        const readWriteMask = Number.parseInt(
          lines.find((line) => line.startsWith("READWRITE_MASK:"))?.slice("READWRITE_MASK:".length) ?? "0",
          10,
        );
        expect(readWriteMask).toBeGreaterThan(0);
        const rules = lines
          .filter((line) => line.startsWith("RULE:"))
          .map((line) => line.slice("RULE:".length).split("|"));
        // 授权面恰两条：当前用户 + LocalSystem（先例的固定基底），无其它任何主体。
        expect(rules).toHaveLength(2);
        const userRule = rules.find((rule) => rule[0] === sid);
        expect(userRule).toBeDefined();
        expect(userRule?.[2]).toBe("allow");
        expect(Number.parseInt(userRule?.[1] ?? "0", 10) & readWriteMask).toBe(readWriteMask);
        expect(rules.some((rule) => rule[0] === "S-1-5-18")).toBe(true);
        // 更宽授权 = 违约（Everyone/匿名/Authenticated Users/内建 Users 的任何 grant）。
        for (const rule of rules) {
          expect(["S-1-1-0", "S-1-5-7", "S-1-5-11", "S-1-5-32-545"]).not.toContain(rule[0]);
        }
        // 无继承（D:P 保护位）；宽 SID 不以任何渲染形态出现。
        expect(sddl).toContain("D:P");
        expect(sddl).not.toContain("S-1-1-0");
        expect(sddl).not.toContain("S-1-5-7");
        expect(sddl).not.toContain("S-1-5-11");
        expect(sddl).not.toContain("S-1-5-32-545");
      },
      30000,
    );

    it(
      "parent-death cleanup (§3.1(3)/§10.3 win32 form): when the spawning host dies, the helper exits within the watchdog bound",
      async () => {
        if (helperConfig === null) throw new Error("helper config unavailable");
        // 短命父进程：真实 node 子进程，50ms 后自退。
        const shortLived = spawn(process.execPath, ["-e", "setTimeout(() => {}, 50)"], {
          stdio: "ignore",
        });
        expect(shortLived.pid).toBeTruthy();
        activeChildren.push(shortLived);
        const pipeName = `\\\\.\\pipe\\payswap-arm-parentdeath-${randomBytes(6).toString("hex")}`;
        const ingressName = `\\\\.\\pipe\\payswap-arm-parentdeath-ing-${randomBytes(6).toString("hex")}`;
        const helper = spawn(
          helperConfig.helperPath,
          [
            "--endpoint",
            pipeName,
            "--ingress",
            ingressName,
            "--parent-pid",
            String(shortLived.pid),
            "--parent-image",
            process.execPath,
          ],
          { stdio: ["pipe", "ignore", "pipe"] },
        );
        activeChildren.push(helper);
        // 供 token（stdin 首行纪律）—— helper 拿到 token 即建管道进入服务循环。
        helper.stdin?.write(`${"0".repeat(64)}\n`);
        await new Promise<void>((resolve) => setTimeout(resolve, 400));
        expect(shortLived.exitCode !== null || helper.exitCode !== null).toBe(true);
        // 父已死 → 看门狗（250ms poll 界）内 helper 自退。
        await waitForCondition(
          () => helper.exitCode !== null || helper.signalCode !== null,
          5000,
          "helper exits after parent death",
        );
      },
      30000,
    );

    it(
      "single server instance (§3.2(2)): while one client holds the connection, a second client's connect fails busy (ERROR_PIPE_BUSY)",
      async () => {
        const diagPath = mintDiagPath("busy");
        try {
        const { handle } = await startRealHelperBroker(diagPath);
        expect(handle.mode, `boot degraded: ${handle.degradedReason ?? "(no reason)"}`).toBe("peer_verified");
        // 客户端 A：注册后连接并静默持有（单实例槽被占）。
        const holderEntry = mintEntry({ childImagePath: process.execPath });
        const holder = spawnClientChild({ path: handle.endpointPath, gated: true, holdMs: 20000 });
        await holder.waitFor((event) => event.t === "pid");
        handle.registerInstance({ ...holderEntry, childPid: holder.pid });
        // 等推送落表再放行（§5.3(4) 竞态的顺序化；持有者必须真正过门占住单实例槽）。
        await new Promise((resolve) => setTimeout(resolve, 400));
        holder.release();
        await holder.waitFor((event) => event.t === "connected");
        // 客户端 B：同样已注册，但管道单实例忙 → 连接失败。实质主张 = B 从未获得槽
        //（无 connected 事件）且以错误终局；错误码家族取决于 libuv 对
        // ERROR_PIPE_BUSY 的呈现（EBUSY/EPIPE/EACCES 均见诸版本 —— round-3 CI 观察
        // 到 EPIPE），单实例本身的证明是"从未连上"。
        const secondEntry = mintEntry({ childImagePath: process.execPath });
        const second = spawnClientChild({ path: handle.endpointPath, gated: true, holdMs: 20000 });
        await second.waitFor((event) => event.t === "pid");
        handle.registerInstance({ ...secondEntry, childPid: second.pid });
        second.release();
        const event = await second.waitFor((event2) => event2.t === "error" || event2.t === "close", 15000);
        expect(event.t).toBe("error");
        expect(["EBUSY", "EPIPE", "EACCES"], readDiag(diagPath)).toContain(event.code);
        expect(second.events.filter((event2) => event2.t === "connected")).toHaveLength(0);
        } catch (error) {
          throw new Error(`${String(error)}\n--- helper diag ---\n${readDiag(diagPath)}`);
        }
      },
      30000,
    );

    it(
      "degraded fallback still binds a host-held endpoint: a missing binary degrades and diagnostics stay reachable (§5.4 win32)",
      async () => {
        const missingPath = path.join(os.tmpdir(), `payswap-missing-helper-${randomBytes(4).toString("hex")}.exe`);
        const bootState = mintBrokerBootState();
        const audit: PayswapBrokerAuditEvent[] = [];
        const handle = await bootPayswapBroker({
          bootState,
          auditSink: (event) => audit.push(event),
          sessionScopeResolver: (hint) => (hint === "sess-test" ? { workspaceKey: "sess-test" } : null),
          peerRelayHelper: { helperPath: missingPath, helperSha256: "0".repeat(64) },
        });
        activeBrokers.push(handle);
        expect(handle.mode).toBe("degraded_refusing");
        expect(handle.degradedReason).toContain("win32");
        // §5.4：host 自持端点照常绑定 —— 客户端拿到签名 typed 拒绝行。
        const client = spawnClientChild({ path: handle.endpointPath, line: "{}" });
        const response = await client.waitFor((event) => event.t === "response");
        expectNullBoundRefusal(response.line as string, "peer_verification_failed", bootState);
        expect(
          audit.some((event) => event.outcome === "boot" && event.code === "degraded_refusing"),
        ).toBe(true);
      },
      30000,
    );
  },
);
