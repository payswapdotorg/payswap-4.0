import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { discoverNodePluginsSync } from "@zcode/adapters/plugins";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, ZCODE_PLUGIN_HOST_COMMAND } from "@zcode/contracts";
import {
  canonicalJsonStringify,
  exportPublicKeyBase64,
  mintBrokerBootState,
  requestLineDigest,
  type PayswapBrokerBootState,
  type PayswapBrokerErrorCode,
  type PayswapBrokerOp,
  type PayswapBrokerResponseBody,
} from "@zcode/shared/payswap";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import net from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveOfficialPluginRoots } from "../src/app/bundled-plugins.js";
import { OFFICIAL_PLUGIN_DEFINITIONS } from "../src/app/official-plugin-definitions.js";
import {
  bootPayswapBroker,
  createPayswapBrokerCoordinator,
  type PayswapBrokerAuditEvent,
  type PayswapBrokerCoordinator,
  type PayswapBrokerHandle,
} from "../src/payswap-broker/index.js";
import { ensurePayswapPluginDist } from "./payswap-plugin-build.js";

/**
 * PaySwap Wave-2 Step 7 —— 完整链对抗性集成套件（契约 w2-01 §12；威胁模型 w2-02 §9；
 * ADR-9 D9.7 + ADR-10）。
 *
 * 链：真实插件构建 → 生产宿主启动（真实 zcode.cjs 入口 + __zcode-plugin-host 派发 +
 * 解析器 env，PR #3 纪律，无测试专用 launcher）→ 五键受信注入 → 子进程 bridge client →
 * UDS → 真实 broker（boot 自探针、§5.5 检查序、签名响应）→ 三码法则/拒绝 → 子进程验签 →
 * 工具信封。每一行都是真实子进程 + 真实监听器/中继 —— 无 mock。
 *
 * 行组（威胁模型 §9）：
 * 1. 链 happy path + T2/T3 live-flip + 六工具 + §8 会话行 + disable 撤销臂；
 * 2. N-rows：N19（冒名配置零凭据）、N20（跨实例 token）、N22（重启后 stale endpoint
 *    不可达）；
 * 3. 响应认证行（§6.5(4)）：伪造/篡改/重放/跨实例/上一 boot/降级（未签名、未知版本）/
 *    超限 + sibling-relay signed-refusal oracle（rev 2a blocker 行）—— 每行断言子进程
 *    整封拒绝、被拒字段零外露、零 dispatch；
 * 4. 重放与恢复行：注册中继上的真 dispatch + 压制 → 同 seq 重试 → sequence_duplicate
 *    （N33/N35 链级；恰一次 dispatch）；
 * 5. 平台臂：degraded_refusing（强制不可用 → null-bound 拒绝；子进程侧 response_rejected）；
 * 6. 边界断言：每个拒绝行断言 live-state reader 调用数不变（N-row 法则：在服务边界断言）；
 * 7. 审计完整性：每个请求恰一个 outcome 事件；token/私钥材料零泄漏扫描（§11）。
 *
 * 私钥扫描：host 侧 bootState 由本套件铸造（coordinator boot 注入缝）—— 私钥 DER 的
 * base64/hex 不得出现在任何工具结果、审计行、子进程 stderr 或捕获的请求行里。
 */

const PAYSWAP_PLUGIN_ID = `payswap@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;
const GATEWAY_SERVER_KEY = "plugin:payswap:gateway";
const SIX_TOOLS = [
  "payswap_check_eligibility",
  "payswap_compile_intent",
  "payswap_discover_routes",
  "payswap_get_account_overview",
  "payswap_get_execution_status",
  "payswap_request_authorization",
];
const CHAIN_WORKSPACE_KEY = "ws-chain";
const CHAIN_SESSION_ID = "sess-chain";
const REQUEST_CONTEXT_META = {
  "com.zcode/request-context": { session_id: CHAIN_SESSION_ID, trace_id: "trace-chain-1" },
};

let storageRoot: string;
let workspace: string;
let cliEntry: string;
let payswapCacheRoot: string;

// ---------------------------------------------------------------------------
// 生产启动链装配（PR #3 host-launch 纪律）
// ---------------------------------------------------------------------------

beforeAll(async () => {
  ensurePayswapPluginDist();
  const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "cli");
  cliEntry = join(cliRoot, "dist", "zcode.cjs");
  if (!existsSync(cliEntry)) {
    execFileSync(process.execPath, [join(cliRoot, "scripts", "build.mjs")], {
      cwd: cliRoot,
      stdio: "pipe",
    });
  }
  expect(existsSync(cliEntry)).toBe(true);

  storageRoot = await mkdtemp(join(tmpdir(), "payswap-chain-storage-"));
  workspace = await mkdtemp(join(tmpdir(), "payswap-chain-workspace-"));

  const originalArgv = process.argv;
  const originalExecArgv = process.execArgv;
  process.argv = [process.execPath, cliEntry];
  process.execArgv = [];
  try {
    resolveOfficialPluginRoots({ storageRoot });
  } finally {
    process.argv = originalArgv;
    process.execArgv = originalExecArgv;
  }

  const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((entry) => entry.name === "payswap");
  expect(definition).toBeDefined();
  payswapCacheRoot = join(
    storageRoot,
    "cache",
    ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
    "payswap",
    definition!.version,
  );
  expect(existsSync(join(payswapCacheRoot, "dist", "server.mjs"))).toBe(true);
}, 180_000);

afterAll(async () => {
  await rm(storageRoot, { force: true, recursive: true });
  await rm(workspace, { force: true, recursive: true });
});

interface LiveStateHolder {
  state: { pluginEnabled: boolean; financialWorkspace: boolean };
  reads: number;
}

interface ChainHarness {
  coordinator: PayswapBrokerCoordinator;
  bootState: PayswapBrokerBootState;
  live: LiveStateHolder;
  audit: PayswapBrokerAuditEvent[];
  /** 预热：注入一次以触发 lazy boot（中继行需要先拿到真实 endpoint）。 */
  warmUp(): Promise<void>;
  close(): Promise<void>;
}

const activeHarnesses: ChainHarness[] = [];

afterEach(async () => {
  for (const harness of activeHarnesses.splice(0)) {
    await harness.close().catch(() => {});
  }
  for (const child of activeChildren.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const peer of activePeers.splice(0)) {
    await peer.close().catch(() => {});
  }
  for (const dir of activeTempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true }).catch(() => {});
  }
});

const activeChildren: Array<ReturnType<typeof spawn>> = [];
const activePeers: Array<{ close(): Promise<void> }> = [];
const activeTempDirs: string[] = [];

function sessionTableResolver(table: Record<string, string>) {
  return (hint: string) =>
    hint in table ? { workspaceKey: table[hint] } : null;
}

/** 装配一个链级协调器：预铸 bootState（五键组与签名同源；私钥扫描可达）+ 可变 live 状态 + 会话表 + 审计。 */
async function makeHarness(options: { reader?: "fail" } = {}): Promise<ChainHarness> {
  const bootState = mintBrokerBootState();
  const live: LiveStateHolder = {
    state: { pluginEnabled: true, financialWorkspace: true },
    reads: 0,
  };
  const audit: PayswapBrokerAuditEvent[] = [];
  const coordinator = createPayswapBrokerCoordinator({
    bootState,
    auditSink: (event) => audit.push(event),
    sessionScopeResolver: sessionTableResolver({
      [CHAIN_SESSION_ID]: CHAIN_WORKSPACE_KEY,
      "sess-other-workspace": "ws-unrelated",
    }),
    ...(options.reader === "fail"
      ? {
          // §5.4 臂：强制不可用的对等凭据 reader —— 自探针失败 → degraded_refusing。
          boot: async (bootOptions) =>
            bootPayswapBroker({
              ...bootOptions,
              reader: {
                kind: "test-unavailable",
                detail: "forced unavailable (chain suite §5.4 arm)",
                readAcceptedSocketPeer: () => Promise.resolve(null),
              },
            }),
        }
      : {}),
    liveStateReader:
      options.reader === "fail"
        ? undefined
        : () => {
            live.reads += 1;
            return live.state;
          },
  });
  const warmUp = async () => {
    const discovered = discoverPayswap(true);
    const servers = discovered.mcpServers as Record<string, McpServerConfigLike>;
    await coordinator.injectBrokerCredentials(
      servers as never,
      pluginServerSubset(servers) as never,
      { workspaceKey: CHAIN_WORKSPACE_KEY },
    );
  };
  const harness: ChainHarness = {
    coordinator,
    bootState,
    live,
    audit,
    warmUp,
    close: async () => {
      await coordinator.close();
    },
  };
  activeHarnesses.push(harness);
  return harness;
}

function discoverPayswap(financialWorkspace: boolean) {
  return discoverNodePluginsSync({
    config: {
      dirs: [],
      enabled: true,
      enabledPlugins: { [PAYSWAP_PLUGIN_ID]: true },
      extraKnownMarketplaces: {},
      options: { [PAYSWAP_PLUGIN_ID]: { financialWorkspace } },
      suppressedBuiltins: [],
    },
    env: {},
    storageRoot,
    workingDirectory: workspace,
  });
}

/**
 * 受信名门需要引用同一：pluginServers 参数取 discovered.mcpServers 里插件自有 server 的
 * 同一对象引用（生产里 configuredMcpServers 含 pluginOutcome.mcpServers 的同名引用，
 * create-app.ts 同款形状 —— 引用相等即受信，拷贝即冒名，N19）。
 */
function pluginServerSubset(servers: Record<string, McpServerConfigLike>): Record<string, McpServerConfigLike> {
  const gateway = servers[GATEWAY_SERVER_KEY];
  return gateway !== undefined ? { [GATEWAY_SERVER_KEY]: gateway } : {};
}

interface McpServerConfigLike {
  type?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  [key: string]: unknown;
}

interface ChainChild {
  client: Client;
  transport: StdioClientTransport;
  /** 子进程被 spawn 时拿到的完整 env（含注入五键 —— 扫描面：私钥材料不得出现）。 */
  envRecord: Record<string, string | undefined>;
  tuple: {
    socket: string;
    token: string;
    instanceId: string;
    hostId: string;
    verifyKeyBase64: string;
  };
  stderrText(): string;
  close(): Promise<void>;
}

/**
 * 经完整生产命令启动官方 PaySwap 子进程（真实 CLI 入口 + __zcode-plugin-host 派发），
 * 连接成功后按 adapters 层纪律注册实例（pid 来自 transport，tuple 来自注入的 config）。
 * envPatch 覆盖注入 env 的指定键（替身 socket / 偷换 token 等对抗行）。
 */
async function spawnChainChild(
  harness: ChainHarness,
  options: {
    financialWorkspace?: boolean;
    envPatch?: Record<string, string | undefined>;
    /** 注入 scope（缺省 CHAIN_WORKSPACE_KEY；窃取行用独立 scope 拿独立实例注册）。 */
    workspaceKey?: string;
    /** 跳过实例注册（对抗行：子进程不在 spawn 表 —— 永不被注册）。 */
    skipRegistration?: boolean;
    /** 用注入前的原始配置（无五键）启动 —— N19 冒名形状。 */
    withoutCredentials?: boolean;
  } = {},
): Promise<ChainChild> {
  const financialWorkspace = options.financialWorkspace ?? true;
  const discovered = discoverPayswap(financialWorkspace);
  let servers = discovered.mcpServers as Record<string, McpServerConfigLike>;
  if (!options.withoutCredentials) {
    servers = (await harness.coordinator.injectBrokerCredentials(
      servers as never,
      pluginServerSubset(servers) as never,
      {
        workspaceKey: options.workspaceKey ?? CHAIN_WORKSPACE_KEY,
      },
    )) as Record<string, McpServerConfigLike>;
  }
  const mcp = servers[GATEWAY_SERVER_KEY]!;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    ...mcp.env,
    ...(options.envPatch ?? {}),
  };
  const stderrChunks: string[] = [];
  const transport = new StdioClientTransport({
    args: mcp.args!,
    command: mcp.command,
    cwd: mcp.cwd,
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
  });
  const client = new Client({ name: "payswap-chain", version: "0.0.0" });
  await client.connect(transport);
  if (!options.skipRegistration) {
    const pid = transport.pid;
    expect(pid, "transport must expose the spawned child pid").not.toBeNull();
    harness.coordinator.processObserver.onStarted(GATEWAY_SERVER_KEY, mcp, pid!);
  }
  const envRecord = env as Record<string, string | undefined>;
  return {
    client,
    transport,
    envRecord,
    tuple: {
      socket: envRecord.PAYSWAP_BROKER_SOCKET ?? "",
      token: envRecord.PAYSWAP_BROKER_TOKEN ?? "",
      instanceId: envRecord.PAYSWAP_BROKER_INSTANCE_ID ?? "",
      hostId: envRecord.PAYSWAP_BROKER_HOST_ID ?? "",
      verifyKeyBase64: envRecord.PAYSWAP_BROKER_VERIFY_KEY ?? "",
    },
    stderrText: () => stderrChunks.join(""),
    close: async () => {
      await client.close();
    },
  };
}

function toolResultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((entry) => entry.type === "text")?.text ?? "";
}

async function callTool(child: ChainChild, name: string, args: Record<string, unknown> = {}, meta = REQUEST_CONTEXT_META) {
  return child.client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
}

// ---------------------------------------------------------------------------
// 协议对端 / 中继（真实 UDS listener）
// ---------------------------------------------------------------------------

interface ChainPeer {
  path: string;
  requests: string[];
  setRespond(respond: (line: string, connectionIndex: number) => string): void;
  close(): Promise<void>;
}

async function startChainPeer(): Promise<ChainPeer> {
  const dir = await mkdtemp(join(tmpdir(), "payswap-chain-peer-"));
  activeTempDirs.push(dir);
  const path = join(dir, "peer.sock");
  const requests: string[] = [];
  let connectionCount = 0;
  let respond: (line: string, connectionIndex: number) => string = () => "{}";
  const server = net.createServer((socket) => {
    const connectionIndex = connectionCount++;
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      buffer = "";
      requests.push(line);
      socket.end(`${respond(line, connectionIndex)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const peer: ChainPeer = {
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
  activePeers.push(peer);
  return peer;
}

/** 注册中继：子进程 → relay → 真实 broker。逐轮剧本：转发响应或压制。 */
function spawnRelay(
  harness: ChainHarness,
  relayPath: string,
): { child: ReturnType<typeof spawn>; events: Array<{ t: string; round?: number; code?: string; line?: string }> } {
  const realSocket = harness.coordinator.handle?.endpointPath ?? "";
  expect(realSocket, "relay rows need a booted coordinator").not.toBe("");
  const RELAY_SCRIPT = `
const net = require("node:net");
const relayPath = process.env.PB_RELAY_PATH;
const realPath = process.env.PB_RELAY_REAL;
const mode = process.env.PB_RELAY_MODE || "forward";
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
let round = 0;
const server = net.createServer((childSocket) => {
  const myRound = round++;
  send({ t: "connected", round: myRound });
  let acc = "";
  let upstream = null;
  childSocket.on("data", (d) => {
    acc += d.toString("utf8");
    const i = acc.indexOf("\\n");
    if (i < 0) return;
    const line = acc.slice(0, i);
    acc = "";
    send({ t: "request", round: myRound, line });
    upstream = net.connect(realPath, () => {
      upstream.write(line + "\\n");
    });
    let uacc = "";
    upstream.on("data", (ud) => {
      uacc += ud.toString("utf8");
      const j = uacc.indexOf("\\n");
      if (j < 0) return;
      const resp = uacc.slice(0, j);
      uacc = "";
      send({ t: "broker-response", round: myRound, line: resp });
      if (mode === "forward" || (mode === "suppress-first" && myRound > 0)) {
        childSocket.end(resp + "\\n");
      } else {
        childSocket.destroy();
      }
    });
    upstream.on("error", (e) => { send({ t: "upstream-error", round: myRound, code: e.code }); childSocket.destroy(); });
  });
  childSocket.on("error", () => {});
});
server.listen(relayPath, () => send({ t: "listening" }));
`;
  const events: Array<{ t: string; round?: number; code?: string; line?: string }> = [];
  const child = spawn(process.execPath, ["-e", RELAY_SCRIPT], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      PB_RELAY_PATH: relayPath,
      PB_RELAY_REAL: realSocket,
      PB_RELAY_MODE: "suppress-first",
    },
  });
  activeChildren.push(child);
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (raw.trim().length === 0) continue;
      try {
        events.push(JSON.parse(raw) as { t: string });
      } catch {
        /* ignore */
      }
    }
  });
  child.stderr.on("data", () => {});
  return { child, events };
}

// ---------------------------------------------------------------------------
// 签名行构造（host 侧钥匙在本套件手里 —— 注入 boot 缝）
// ---------------------------------------------------------------------------

function chainSignedLine(
  bootState: PayswapBrokerBootState,
  binding: {
    instanceId: string | null;
    seq: number | null;
    op: PayswapBrokerOp | null;
    requestDigest: string;
    response: PayswapBrokerResponseBody;
  },
  shapeOverrides?: { v?: number; hostInstanceId?: string },
): string {
  const envelope = {
    v: shapeOverrides?.v ?? 1,
    hostInstanceId: shapeOverrides?.hostInstanceId ?? bootState.hostId,
    instanceId: binding.instanceId,
    seq: binding.seq,
    op: binding.op,
    requestDigest: binding.requestDigest,
    response: binding.response,
  };
  const signature = edSign(null, Buffer.from(canonicalJsonStringify(envelope), "utf8"), bootState.keyPair.privateKey).toString("base64");
  return JSON.stringify({ envelope, signature });
}

function okBody(seq: number, data: unknown): PayswapBrokerResponseBody {
  return { ok: true, seq, data };
}

function errorBody(seq: number, code: PayswapBrokerErrorCode, retryable: boolean): PayswapBrokerResponseBody {
  return { ok: false, seq, error: { code, message: `chain refusal: ${code}`, retryable } };
}

function privateKeyMaterial(bootState: PayswapBrokerBootState): string[] {
  const der = bootState.keyPair.privateKey.export({ format: "der", type: "pkcs8" });
  return [der.toString("base64"), der.toString("hex")];
}

/** 文件系统扫描的尺寸上限：超出上限的文件跳过（插件 dist / socket 都远小于此）。 */
const SWEEP_MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * 递归扫描根目录树，返回包含任一 needle（文本子串）的文件路径列表（空 = 零命中）。
 * 同步 IO —— 树小（插件缓存 + workspace + 端点目录），一次扫描毫秒级。
 */
function sweepFilesFor(roots: string[], needles: string[]): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 根不存在（未 boot 的 harness）或不可读 —— 无可扫描面。
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const stat = statSync(full);
          if (stat.size > SWEEP_MAX_FILE_BYTES) continue;
          const content = readFileSync(full);
          const text = content.toString("utf8");
          for (const needle of needles) {
            if (content.includes(needle) || text.includes(needle)) {
              hits.push(full);
              break;
            }
          }
        }
      } catch {
        continue; // 竞态消失的文件 / 不可读 —— 跳过。
      }
    }
  };
  for (const root of roots) {
    if (!existsSync(root)) continue;
    walk(root);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 套件
// ---------------------------------------------------------------------------

describe("payswap complete chain (contract §12; threat model §9; production host launch path)", () => {
  it("§9.1 chain happy path: real plugin build → production launch → five keys injected → broker → verified response → three-code law (S1→S2 live flip)", { timeout: 120_000 }, async () => {
    const harness = await makeHarness();
    const child = await spawnChainChild(harness, { financialWorkspace: false });

    // 五键组确实注入了生产命令的 env。
    expect(child.tuple.socket).toBe(harness.coordinator.handle?.endpointPath);
    expect(child.tuple.token).toMatch(/^[0-9a-f]{64}$/);
    expect(child.tuple.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(child.tuple.hostId).toBe(harness.bootState.hostId);
    expect(child.tuple.verifyKeyBase64).toBe(exportPublicKeyBase64(harness.bootState.keyPair.publicKey));

    // 六工具照常枚举（宿主派发不改变工具面）。
    const tools = await child.client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(SIX_TOOLS);

    // S1（live：enabled、未 opt-in）：not_opted_in —— 注意子进程 env 快照是 false，
    // broker live 状态先答 S1；翻转到 opted-in 后同子进程下一次调用答 S2（T2/T3 live-flip）。
    harness.live.state = { pluginEnabled: true, financialWorkspace: false };
    const s1 = await callTool(child, "payswap_get_account_overview", {});
    expect(JSON.parse(toolResultText(s1))).toEqual({
      kind: "refused",
      refusal: { code: "not_opted_in", message: expect.any(String) },
    });

    harness.live.state = { pluginEnabled: true, financialWorkspace: true };
    const s2 = await callTool(child, "payswap_get_account_overview", {});
    expect(JSON.parse(toolResultText(s2))).toEqual({
      kind: "refused",
      refusal: { code: "not_connected", message: expect.any(String) },
    });

    // live 读确实发生了（服务边界断言：S1/S2 各 dispatch 一次）。
    expect(harness.live.reads).toBe(2);
    // 审计：两次 dispatched，无拒绝。
    expect(harness.audit.filter((event) => event.outcome === "dispatched")).toHaveLength(2);
    await child.close();
  });

  it("§9.1 env-snapshot staleness: the child's snapshot says opted-out, the broker's live read answers S2 — live is authoritative", { timeout: 120_000 }, async () => {
    const harness = await makeHarness();
    // 子进程 env 快照 = false（discoverPayswap(false)）；live 状态 = opted-in。
    const child = await spawnChainChild(harness, { financialWorkspace: false });
    const result = await callTool(child, "payswap_get_account_overview", {});
    expect(JSON.parse(toolResultText(result)).refusal?.code).toBe("not_connected");
    await child.close();
  });

  it("§9.1/§7.4 dormant grant hook: an authorizationId submission answers the three-code law and never reaches grant logic", { timeout: 120_000 }, async () => {
    const harness = await makeHarness();
    const child = await spawnChainChild(harness);
    const result = await callTool(child, "payswap_request_authorization", {
      intentId: "i-1",
      authorizationId: "grant-attempt",
    });
    expect(JSON.parse(toolResultText(result))).toEqual({
      kind: "refused",
      refusal: { code: "not_connected", message: expect.any(String) },
    });
    await child.close();
  });

  it("§8 chain rows: a resolvable hint dispatches; an unresolvable hint and a foreign-workspace hint answer session_unresolvable (surfaced typed)", { timeout: 120_000 }, async () => {
    const harness = await makeHarness();
    const child = await spawnChainChild(harness);

    const good = await callTool(child, "payswap_compile_intent", { description: "pay invoice INV-1" });
    expect(JSON.parse(toolResultText(good)).refusal?.code).toBe("not_connected");

    // hint 解析失败（不在会话表）→ request-attributed session_unresolvable（verified 桥接错误）。
    const unknown = await callTool(child, "payswap_compile_intent", { description: "x" }, {
      "com.zcode/request-context": { session_id: "sess-no-such" },
    });
    expect(JSON.parse(toolResultText(unknown))).toEqual({
      kind: "bridge_failure",
      failure: { code: "session_unresolvable", message: expect.any(String), retryable: false },
    });

    // hint 解析到别的工作区（§8.2 hint 只能收窄）→ session_unresolvable。
    const foreign = await callTool(child, "payswap_compile_intent", { description: "x" }, {
      "com.zcode/request-context": { session_id: "sess-other-workspace" },
    });
    expect(JSON.parse(toolResultText(foreign)).failure?.code).toBe("session_unresolvable");

    // D8.1：§8 拒绝不烧序列 —— 但无 retiredSeqs 时三次调用仍单调 1/2/3（dispatched 恰一次）。
    expect(harness.audit.filter((event) => event.outcome === "dispatched")).toHaveLength(1);
    await child.close();
  });

  it("§10.2(2)/D5.6 disable arm: revokeForDisable → the residual call answers financial_mode_disabled without consulting the live reader", { timeout: 120_000 }, async () => {
    const harness = await makeHarness();
    const child = await spawnChainChild(harness);
    const before = await callTool(child, "payswap_get_account_overview", {});
    expect(JSON.parse(toolResultText(before)).refusal?.code).toBe("not_connected");
    const readsBefore = harness.live.reads;

    harness.coordinator.revokeForDisable();
    const residual = await callTool(child, "payswap_get_account_overview", {});
    expect(JSON.parse(toolResultText(residual))).toEqual({
      kind: "refused",
      refusal: { code: "financial_mode_disabled", message: expect.any(String) },
    });
    // D5.6：注册表撤销是权威 —— reader 未被咨询。
    expect(harness.live.reads).toBe(readsBefore);
    await child.close();
  });

  // -------------------------------------------------------------------------
  // N-rows（威胁模型 §9.2）
  // -------------------------------------------------------------------------

  it("N19 chain: an impostor config (copied shape, not the injected reference) receives no credential — its child answers Wave-1 refusals with zero broker contact", { timeout: 120_000 }, async () => {
    const harness = await makeHarness();
    // 快照 env 选 false（S1）—— Wave-1 臂的可见答案；无五键 → 不 arm bridge。
    const child = await spawnChainChild(harness, { financialWorkspace: false, withoutCredentials: true });
    const result = await callTool(child, "payswap_get_account_overview", {});
    expect(JSON.parse(toolResultText(result))).toEqual({
      kind: "refused",
      refusal: { code: "not_opted_in", message: expect.any(String) },
    });
    expect(harness.coordinator.handle).toBeNull();
    expect(harness.audit).toHaveLength(0);
    await child.close();
  });

  it("N20 chain: a stolen cross-instance token reaches the real broker and is refused unauthorized (typed in audit; null-bound at the child surface)", { timeout: 120_000 }, async () => {
    const harness = await makeHarness();
    const child = await spawnChainChild(harness);
    // 前置：一次合法调用（建立受害者实例与水标）。
    const good = await callTool(child, "payswap_get_account_overview", {});
    expect(JSON.parse(toolResultText(good)).refusal?.code).toBe("not_connected");
    const readsBefore = harness.live.reads;

    // 窃取行：第二个子进程（独立实例 —— 独立注册，spawn 表有它的 pid），env 被换成
    // 受害者的完整五键组 —— 跨实例 token 使用（N20：token 属于另一个实例）。
    const thiefChild = await spawnChainChild(harness, {
      workspaceKey: "ws-chain-thief",
      envPatch: {
        PAYSWAP_BROKER_SOCKET: child.tuple.socket,
        PAYSWAP_BROKER_TOKEN: child.tuple.token,
        PAYSWAP_BROKER_INSTANCE_ID: child.tuple.instanceId,
        PAYSWAP_BROKER_HOST_ID: child.tuple.hostId,
        PAYSWAP_BROKER_VERIFY_KEY: child.tuple.verifyKeyBase64,
      },
    });
    const result = await callTool(thiefChild, "payswap_get_account_overview", {});
    const envelope = JSON.parse(toolResultText(result));
    // pre-binding 拒绝（§5.5 步 (3)：token 属于受害者实例，不是窃贼 pid 映射实例的）→
    // null-bound → 子进程表面 response_rejected（§6.4(3)）。
    expect(envelope).toEqual({
      kind: "bridge_failure",
      failure: { code: "response_rejected", message: expect.any(String), retryable: false },
    });
    // 审计里是 typed unauthorized；零 dispatch（服务边界断言）。
    const refusals = harness.audit.filter((event) => event.outcome === "refused");
    expect(refusals.some((event) => event.code === "unauthorized")).toBe(true);
    expect(harness.live.reads).toBe(readsBefore);
    await thiefChild.close();
    await child.close();
  });

  it("N22 chain: after close() the stale endpoint is unreachable — the child's call fails typed with zero new audit; a restarted broker owns a new endpoint and the old tuple stays dead", { timeout: 120_000 }, async () => {
    const harness = await makeHarness();
    const child = await spawnChainChild(harness);
    const good = await callTool(child, "payswap_get_account_overview", {});
    expect(JSON.parse(toolResultText(good)).refusal?.code).toBe("not_connected");

    await harness.coordinator.close();
    expect(existsSync(child.tuple.socket)).toBe(false); // unlink-first（ADR-6）

    // 端点已摘除（ENOENT）→ 可证未投递、预算耗尽 → connect_failed（N22：stale endpoint 不可达）。
    const stale = await callTool(child, "payswap_get_account_overview", {});
    expect(JSON.parse(toolResultText(stale)).failure?.code).toBe("connect_failed");

    // 重启：新 boot、新 endpoint —— 旧 tuple 的 socket 路径已不存在，连接仍失败。
    const nextHarness = await makeHarness();
    expect(nextHarness.bootState.endpointPath).not.toBe(child.tuple.socket);
    const result = await callTool(child, "payswap_get_account_overview", {});
    expect(JSON.parse(toolResultText(result)).failure?.code).toBe("connect_failed");
    await child.close();
  });

  // -------------------------------------------------------------------------
  // 响应认证行（威胁模型 §9.3；§6.5(4) 每行）
  // -------------------------------------------------------------------------

  it("§6.5(4) fabricated response: a substituted socket's own-key envelope is rejected in full; nothing leaks; zero dispatch", { timeout: 120_000 }, async () => {
    const harness = await makeHarness();
    const peer = await startChainPeer();
    const child = await spawnChainChild(harness, { envPatch: { PAYSWAP_BROKER_SOCKET: peer.path } });
    const readsBefore = harness.live.reads;

    peer.setRespond((line) => {
      const attacker = generateKeyPairSync("ed25519");
      const request = JSON.parse(line) as { seq: number };
      const envelope = {
        v: 1,
        hostInstanceId: child.tuple.hostId,
        instanceId: child.tuple.instanceId,
        seq: request.seq,
        op: "get_account_overview",
        requestDigest: requestLineDigest(line),
        response: { ok: true, seq: request.seq, data: { leak: "CHAIN-FABRICATED-CANARY" } },
      };
      const signature = edSign(null, Buffer.from(canonicalJsonStringify(envelope), "utf8"), attacker.privateKey).toString("base64");
      return JSON.stringify({ envelope, signature });
    });

    const result = await callTool(child, "payswap_get_account_overview", {});
    const text = toolResultText(result);
    expect(text).not.toMatch(/CHAIN-FABRICATED-CANARY/);
    expect(JSON.parse(text)).toEqual({
      kind: "bridge_failure",
      failure: { code: "response_rejected", message: expect.any(String), retryable: false },
    });
    expect(harness.live.reads).toBe(readsBefore);
    await child.close();
  });

  it("§6.5(4) modified response: a real captured envelope with any field tampered is rejected (signature covers the whole envelope)", { timeout: 120_000 }, async () => {
    const harness = await makeHarness();
    const peer = await startChainPeer();
    const child = await spawnChainChild(harness, { envPatch: { PAYSWAP_BROKER_SOCKET: peer.path } });

    peer.setRespond((line) => {
      const request = JSON.parse(line) as { seq: number };
      const valid = JSON.parse(
        chainSignedLine(harness.bootState, {
          instanceId: child.tuple.instanceId,
          seq: request.seq,
          op: "get_account_overview",
          requestDigest: requestLineDigest(line),
          response: okBody(request.seq, { kind: "ok", data: "CHAIN-MODIFIED-CANARY" }),
        }),
      ) as { envelope: Record<string, unknown>; signature: string };
      valid.envelope.response = okBody(request.seq, { leak: "CHAIN-MODIFIED-CANARY" });
      return JSON.stringify(valid);
    });

    const result = await callTool(child, "payswap_get_account_overview", {});
    const text = toolResultText(result);
    expect(text).not.toMatch(/CHAIN-MODIFIED-CANARY/);
    expect(JSON.parse(text).failure?.code).toBe("response_rejected");
    await child.close();
  });

  it("§6.5(4) replayed response against a different in-flight request is rejected (seq/op/digest bind the exact attempt)", { timeout: 120_000 }, async () => {
    const harness = await makeHarness();
    const peer = await startChainPeer();
    const child = await spawnChainChild(harness, { envPatch: { PAYSWAP_BROKER_SOCKET: peer.path } });

    peer.setRespond((line) => {
      const request = JSON.parse(line) as { seq: number; op: PayswapBrokerOp };
      // 签名完备但绑定到另一个 attempt（seq 999 / 别的 op）。
      return chainSignedLine(harness.bootState, {
        instanceId: child.tuple.instanceId,
        seq: 999,
        op: request.op === "get_account_overview" ? "compile_intent" : "get_account_overview",
        requestDigest: requestLineDigest(line),
        response: okBody(999, { leak: "CHAIN-REPLAY-CANARY" }),
      });
    });

    const result = await callTool(child, "payswap_get_account_overview", {});
    const text = toolResultText(result);
    expect(text).not.toMatch(/CHAIN-REPLAY-CANARY/);
    expect(JSON.parse(text).failure?.code).toBe("response_rejected");
    await child.close();
  });

  it("§6.5(4) cross-instance response: instance A's envelope applied to instance B is rejected", { timeout: 120_000 }, async () => {
    const harness = await makeHarness();
    const peer = await startChainPeer();
    const child = await spawnChainChild(harness, { envPatch: { PAYSWAP_BROKER_SOCKET: peer.path } });
    const otherInstance = "11111111-2222-4333-8444-555555555555";

    peer.setRespond((line) => {
      const request = JSON.parse(line) as { seq: number };
      return chainSignedLine(harness.bootState, {
        instanceId: otherInstance,
        seq: request.seq,
        op: "get_account_overview",
        requestDigest: requestLineDigest(line),
        response: okBody(request.seq, { leak: "CHAIN-CROSS-INSTANCE-CANARY" }),
      });
    });

    const result = await callTool(child, "payswap_get_account_overview", {});
    const text = toolResultText(result);
    expect(text).not.toMatch(/CHAIN-CROSS-INSTANCE-CANARY/);
    expect(JSON.parse(text).failure?.code).toBe("response_rejected");
    await child.close();
  });

  it("§6.5(4) previous host boot: an envelope signed by the previous boot's key is rejected after restart", { timeout: 120_000 }, async () => {
    const previousHarness = await makeHarness();
    const previousPeer = await startChainPeer();
    const previousChild = await spawnChainChild(previousHarness, {
      envPatch: { PAYSWAP_BROKER_SOCKET: previousPeer.path },
    });
    let capturedPreviousLine = "";
    previousPeer.setRespond((line) => {
      const request = JSON.parse(line) as { seq: number };
      capturedPreviousLine = chainSignedLine(previousHarness.bootState, {
        instanceId: previousChild.tuple.instanceId,
        seq: request.seq,
        op: "get_account_overview",
        requestDigest: requestLineDigest(line),
        response: okBody(request.seq, { refusal: { code: "not_connected" } }),
      });
      return capturedPreviousLine;
    });
    const good = await callTool(previousChild, "payswap_get_account_overview", {});
    expect(JSON.parse(toolResultText(good)).refusal?.code).toBe("not_connected");
    await previousChild.close();
    await previousHarness.close();

    // 新 boot 的子进程被呈现上一 boot 的真实信封 —— 旧钥签名必须死在 (a)/(c)。
    const harness = await makeHarness();
    const peer = await startChainPeer();
    const child = await spawnChainChild(harness, { envPatch: { PAYSWAP_BROKER_SOCKET: peer.path } });
    peer.setRespond(() => capturedPreviousLine);
    const result = await callTool(child, "payswap_get_account_overview", {});
    expect(JSON.parse(toolResultText(result)).failure?.code).toBe("response_rejected");
    await child.close();
  });

  it("§6.5(4) downgrade rows: unsigned JSON and unknown-version envelopes are rejected fail-closed (no unsigned mode)", { timeout: 120_000 }, async () => {
    const harness = await makeHarness();
    const peer = await startChainPeer();
    const child = await spawnChainChild(harness, { envPatch: { PAYSWAP_BROKER_SOCKET: peer.path } });

    // 未签名。
    peer.setRespond((line) => {
      const request = JSON.parse(line) as { seq: number };
      return JSON.stringify({
        envelope: {
          v: 1,
          hostInstanceId: child.tuple.hostId,
          instanceId: child.tuple.instanceId,
          seq: request.seq,
          op: "get_account_overview",
          requestDigest: requestLineDigest(line),
          response: okBody(request.seq, { leak: "CHAIN-UNSIGNED-CANARY" }),
        },
      });
    });
    const unsigned = await callTool(child, "payswap_get_account_overview", {});
    expect(toolResultText(unsigned)).not.toMatch(/CHAIN-UNSIGNED-CANARY/);
    expect(JSON.parse(toolResultText(unsigned)).failure?.code).toBe("response_rejected");

    // 未知版本（v:2，钥真实 —— 版本检查 (b) 行）。
    peer.setRespond((line) => {
      const request = JSON.parse(line) as { seq: number };
      return chainSignedLine(
        harness.bootState,
        {
          instanceId: child.tuple.instanceId,
          seq: request.seq,
          op: "get_account_overview",
          requestDigest: requestLineDigest(line),
          response: okBody(request.seq, { leak: "CHAIN-V2-CANARY" }),
        },
        { v: 2 },
      );
    });
    const v2 = await callTool(child, "payswap_get_account_overview", {});
    expect(toolResultText(v2)).not.toMatch(/CHAIN-V2-CANARY/);
    expect(JSON.parse(toolResultText(v2)).failure?.code).toBe("response_rejected");
    await child.close();
  });

  it("§6.4(3) rev-2a blocker row: a registered sibling relays the victim's verbatim bytes to the real broker and presents the genuinely signed null-bound refusal — the victim rejects it in full", { timeout: 120_000 }, async () => {
    const harness = await makeHarness();
    await harness.warmUp(); // lazy boot 先行 —— 中继需要真实 endpoint 路径。
    const relayDir = await mkdtemp(join(tmpdir(), "payswap-chain-relay-"));
    activeTempDirs.push(relayDir);
    const relayPath = join(relayDir, "relay.sock");
    const readsBefore = harness.live.reads;

    // 中继进程（未注册 pid —— 冒名同胞）：子进程 → 中继 → 真实 broker（逐字转发）→
    // 真实 broker 对中继连接做对等验证（未知 pid）→ 真签名的 null-bound
    // peer_verification_failed → 中继原样递给子进程。
    const RELAY_SCRIPT = `
const net = require("node:net");
const relayPath = process.env.PB_RELAY_PATH;
const realPath = process.env.PB_RELAY_REAL;
const server = net.createServer((childSocket) => {
  let acc = "";
  childSocket.on("data", (d) => {
    acc += d.toString("utf8");
    const i = acc.indexOf("\\n");
    if (i < 0) return;
    const line = acc.slice(0, i);
    acc = "";
    const upstream = net.connect(realPath, () => {
      upstream.write(line + "\\n");
    });
    let uacc = "";
    upstream.on("data", (ud) => {
      uacc += ud.toString("utf8");
      const j = uacc.indexOf("\\n");
      if (j < 0) return;
      const resp = uacc.slice(0, j);
      uacc = "";
      childSocket.end(resp + "\\n");
    });
    upstream.on("error", () => childSocket.destroy());
  });
  childSocket.on("error", () => {});
});
server.listen(relayPath, () => process.stdout.write("listening\\n"));
`;
    const relay = spawn(process.execPath, ["-e", RELAY_SCRIPT], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "", PB_RELAY_PATH: relayPath, PB_RELAY_REAL: harness.coordinator.handle?.endpointPath ?? "" },
    });
    activeChildren.push(relay);
    await new Promise<void>((resolve) => {
      relay.stdout.once("data", () => resolve());
      setTimeout(resolve, 2_000);
    });

    const child = await spawnChainChild(harness, { envPatch: { PAYSWAP_BROKER_SOCKET: relayPath } });
    const result = await callTool(child, "payswap_get_account_overview", {});
    const text = toolResultText(result);
    // 子进程整封拒绝：null-bound 永不满足 (d)（§6.4(3)）；被拒字段零外露。
    expect(JSON.parse(text)).toEqual({
      kind: "bridge_failure",
      failure: { code: "response_rejected", message: expect.any(String), retryable: false },
    });
    expect(text).not.toMatch(/peer_verification_failed/);
    // 审计：真实 broker 确实签发过该拒绝（typed code 可见 —— 诊断在 host 侧）。
    expect(harness.audit.some((event) => event.outcome === "refused" && event.code === "peer_verification_failed")).toBe(true);
    // 零 dispatch（N-row 法则）。
    expect(harness.live.reads).toBe(readsBefore);
    await child.close();
  });

  it("§6.4(4) oversize response line: rejected before any signature check", { timeout: 120_000 }, async () => {
    const harness = await makeHarness();
    const peer = await startChainPeer();
    const child = await spawnChainChild(harness, { envPatch: { PAYSWAP_BROKER_SOCKET: peer.path } });
    peer.setRespond(() => `{"padding":"${"z".repeat(1024 * 1024)}"}`);
    const result = await callTool(child, "payswap_get_account_overview", {});
    expect(JSON.parse(toolResultText(result)).failure?.code).toBe("response_rejected");
    await child.close();
  });

  // -------------------------------------------------------------------------
  // 重放与恢复行（威胁模型 §9.4 —— 注册中继上的真 dispatch）
  // -------------------------------------------------------------------------

  it("N33/N35 chain: suppression then same-seq retry against the REAL broker — exactly one dispatch, the retry answers a verified sequence_duplicate", { timeout: 120_000 }, async () => {
    const harness = await makeHarness();
    // 先拿到注入 config（lazy boot）并以其铸造中继注册 —— 中继即本行的"子进程"（spawn-wiring
    // 同款纪律：onStarted 的 tuple 来自注入 config，pid 来自中继进程）。
    const discovered = discoverPayswap(true);
    const servers = discovered.mcpServers as Record<string, McpServerConfigLike>;
    const injected = (await harness.coordinator.injectBrokerCredentials(
      servers as never,
      pluginServerSubset(servers) as never,
      { workspaceKey: CHAIN_WORKSPACE_KEY },
    )) as Record<string, McpServerConfigLike>;

    const relayDir = await mkdtemp(join(tmpdir(), "payswap-chain-relay2-"));
    activeTempDirs.push(relayDir);
    const relayPath = join(relayDir, "relay2.sock");
    const relay = spawnRelay(harness, relayPath);
    harness.coordinator.processObserver.onStarted(
      GATEWAY_SERVER_KEY,
      injected[GATEWAY_SERVER_KEY]!,
      relay.child.pid ?? -1,
    );

    // 真实子进程：socket 指向中继；自身 pid 不注册（中继已以其实例身份注册）。
    const child = await spawnChainChild(harness, {
      envPatch: { PAYSWAP_BROKER_SOCKET: relayPath },
      skipRegistration: true,
    });

    const result = await callTool(child, "payswap_get_account_overview", {});
    const envelope = JSON.parse(toolResultText(result));
    // 压制第一响应 → 同 seq 重试 → 真 broker 答 sequence_duplicate（verified 桥接错误面）。
    expect(envelope).toEqual({
      kind: "bridge_failure",
      failure: { code: "sequence_duplicate", message: expect.any(String), retryable: false },
    });

    // 中继看到了两轮转发（同一 seq 的两次请求）且第一轮拿到过真 broker 的成功响应。
    const requests = relay.events.filter((event) => event.t === "request");
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[0]!.line!).seq).toBe(JSON.parse(requests[1]!.line!).seq);
    expect(relay.events.some((event) => event.t === "broker-response")).toBe(true);

    // 真实 broker：恰一次 dispatch + 一次 sequence_duplicate 拒绝（N35：零再 dispatch）。
    expect(harness.audit.filter((event) => event.outcome === "dispatched")).toHaveLength(1);
    expect(harness.audit.filter((event) => event.outcome === "refused" && event.code === "sequence_duplicate")).toHaveLength(1);
    await child.close();
  });

  // -------------------------------------------------------------------------
  // 平台臂（威胁模型 §9.5 —— Linux 真实臂；Windows 臂显式 unverified）
  // -------------------------------------------------------------------------

  it("§5.4 chain degraded arm: a forced-unavailable peer-credential subsystem boots degraded_refusing — the child's call is rejected (null-bound at the surface; typed in audit)", { timeout: 120_000 }, async () => {
    const harness = await makeHarness({ reader: "fail" });
    await harness.warmUp(); // lazy boot 先行 —— degraded 状态在 boot 后可见。
    expect(harness.coordinator.handle?.mode).toBe("degraded_refusing");
    const child = await spawnChainChild(harness);
    const result = await callTool(child, "payswap_get_account_overview", {});
    expect(JSON.parse(toolResultText(result))).toEqual({
      kind: "bridge_failure",
      failure: { code: "response_rejected", message: expect.any(String), retryable: false },
    });
    // degraded 的 socket 照常绑定（诊断可达），请求在 peer gate 即拒 —— typed code 在审计。
    expect(harness.audit.some((event) => event.outcome === "refused" && event.code === "peer_verification_failed")).toBe(true);
    expect(harness.audit.some((event) => event.outcome === "boot" && event.code === "degraded_refusing")).toBe(true);
    await child.close();
  });

  // -------------------------------------------------------------------------
  // 审计完整性与零凭据泄漏（威胁模型 §9.7；§11）
  // -------------------------------------------------------------------------

  it("§11 audit completeness and the zero-credential scan over the adversarial run", { timeout: 180_000 }, async () => {
    const harness = await makeHarness();
    const child = await spawnChainChild(harness);

    // 一段对抗性序列：合法 → 翻转 → 撤销（residual）—— 工具结果全部捕获为扫描面。
    const results: Array<Record<string, unknown>> = [];
    results.push((await callTool(child, "payswap_get_account_overview", {})) as Record<string, unknown>);
    harness.live.state = { pluginEnabled: true, financialWorkspace: false };
    results.push((await callTool(child, "payswap_get_account_overview", {})) as Record<string, unknown>);
    harness.coordinator.revokeForDisable();
    results.push((await callTool(child, "payswap_get_account_overview", {})) as Record<string, unknown>);

    // 每个请求恰一个 outcome 事件（dispatched / refused）—— 本行三次调用。
    const outcomes = harness.audit.filter((event) => event.outcome === "dispatched" || event.outcome === "refused");
    expect(outcomes).toHaveLength(3);
    for (const event of outcomes) {
      expect(event.instanceId).toBe(child.tuple.instanceId);
      expect(event.op).toBe("get_account_overview");
      expect(typeof event.seq).toBe("number");
    }

    // 零凭据材料扫描（handoff §4 / 契约 §12 gate 行 / 威胁模型 §9(3) 的完整面）：
    // 私钥 DER（base64+hex）不得出现在审计、工具结果、子进程 stderr、子进程 env 或
    // 运行产生的任何文件里；token 只准出现在它的受许位置（子进程 env + 请求 wire）——
    // 工具结果与文件系统同样零容忍。
    const privateMaterial = privateKeyMaterial(harness.bootState);
    const toolResultSurfaces = results
      .map((result) => JSON.stringify(result))
      .concat(results.map((result) => toolResultText(result as Parameters<typeof toolResultText>[0])));
    const auditText = JSON.stringify(harness.audit);
    const envValues = Object.values(child.envRecord).filter((value): value is string => typeof value === "string");

    expect(auditText).not.toContain(child.tuple.token);
    for (const material of privateMaterial) {
      expect(auditText).not.toContain(material);
      expect(child.stderrText()).not.toContain(material);
      for (const surface of toolResultSurfaces) {
        expect(surface).not.toContain(material);
      }
      for (const value of envValues) {
        expect(value).not.toContain(material);
      }
    }
    // token 不得经工具面外露（凭据只服务于 bridge 传输，不进任何工具结果）。
    for (const surface of toolResultSurfaces) {
      expect(surface).not.toContain(child.tuple.token);
    }
    // 端点路径不入审计（§11(2) 纪律的保守面：server.ts 注释钉住的三条之一）。
    expect(auditText).not.toContain(child.tuple.socket);

    // 文件系统足印扫描：运行写入/落盘的全部树 —— 官方插件缓存（storageRoot）、workspace、
    // 以及本 boot 的端点目录（per-boot 0700 目录 + socket 文件本体）。私钥永不落盘；
    // token 也不得落盘（token 只存在于受信注入 env 与 broker 内存）。
    const fsRoots = [
      storageRoot,
      workspace,
      dirname(harness.bootState.endpointPath),
    ];
    const swept = await sweepFilesFor(fsRoots, [...privateMaterial, child.tuple.token]);
    expect(
      swept,
      `private material / token must never be written to the run's filesystem footprint (roots: ${fsRoots.join(", ")})`,
    ).toEqual([]);

    await child.close();
  });
});
