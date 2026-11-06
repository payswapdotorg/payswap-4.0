import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { McpServerConfig } from "@zcode/contracts";
import {
  createPayswapInstanceRegistry,
  isValidPayswapBrokerCredentialTuple,
  PAYSWAP_BROKER_INSTANCE_ID_ENV_KEY,
  PAYSWAP_BROKER_TOKEN_ENV_KEY,
  readPayswapBrokerCredentialTupleFromEnv,
  verifyResponseEnvelope,
  type PayswapInstanceRegistry,
} from "@zcode/shared/payswap";
import { afterEach, describe, expect, it } from "vitest";
import type { PayswapBrokerHandle } from "../src/payswap-broker/index.js";
import {
  createPayswapBrokerCoordinator,
  readPayswapLiveStateFromConfig,
  type PayswapBrokerCoordinator,
} from "../src/payswap-broker-spawn-wiring.js";

/**
 * PaySwap P1.4 Step 4 —— 实弹 spawn 链接线的对抗性测试（契约 w2-01 §4.2、§7.3、§10；
 * playbook §4.2 RED-first）。
 *
 * 协调器（coordinator）是 host 侧接线层：lazy boot（首个受信 PaySwap server 出现时）、
 * per-(server, workspace) 稳定铸造（pool key 稳定性 —— 同一 live 实例重复注入同一 tuple，
 * 连接池不会因 tuple 抖动而碎片化）、process observer（pid → 注册/tombstone）、
 * disable 撤销（§10.2(2)）与 boot 失败的 fail-safe 降级（无凭据 → 子进程走 Wave 1
 * fail-closed 无凭据路径，绝不注入半组）。
 *
 * 端到端行使用**真实子进程对端**（P1.3 套件同款纪律）：观察者登记 pid 后，子进程的
 * 合法请求拿到 §7.3 三码法则的签名回答 —— 五键注入 → 注册 → dispatch 的完整闭环。
 */

// ---------------------------------------------------------------------------
// 真实子进程客户端（连接 + 写行）
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `
const net = require("node:net");
const path = process.env.PB_TEST_PATH;
const lineArg = process.env.PB_TEST_LINE || "";
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
const s = net.connect(path, () => {
  send({ t: "connected" });
  s.write(lineArg + "\\n");
});
let acc = "";
s.on("data", (d) => {
  acc += d.toString("utf8");
  let i;
  while ((i = acc.indexOf("\\n")) >= 0) { send({ t: "response", line: acc.slice(0, i) }); acc = acc.slice(i + 1); }
});
s.on("close", () => { send({ t: "close" }); process.exit(0); });
s.on("error", (e) => { send({ t: "error", code: e.code }); process.exit(0); });
setTimeout(() => process.exit(0), 20000);
`;

interface ChildEvent {
  t: "connected" | "response" | "close" | "error";
  line?: string;
  code?: string;
}

function spawnClientChild(options: { path: string; line: string; onPid: (pid: number) => void }): void {
  const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, PB_TEST_PATH: options.path, PB_TEST_LINE: options.line },
  });
  options.onPid(child.pid ?? -1);
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (raw.trim().length === 0) continue;
      try {
        const event = JSON.parse(raw) as ChildEvent;
        if (event.t === "response") resolveResponse(event.line as string);
      } catch {
        /* 非 JSON 输出忽略 */
      }
    }
  });
  child.stderr.on("data", () => {});
  activeChildren.push(child);
}

const activeChildren: ReturnType<typeof spawn>[] = [];
const activeCoordinators: PayswapBrokerCoordinator[] = [];
let pendingResolve: ((line: string) => void) | null = null;

function resolveResponse(line: string): void {
  const resolve = pendingResolve;
  pendingResolve = null;
  resolve?.(line);
}

function nextResponse(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResolve = null;
      reject(new Error("timed out waiting for the child's response"));
    }, 10000);
    pendingResolve = (line: string) => {
      clearTimeout(timer);
      resolve(line);
    };
  });
}

afterEach(async () => {
  for (const child of activeChildren.splice(0)) {
    child.kill("SIGKILL");
  }
  await Promise.allSettled(activeCoordinators.splice(0).map((coordinator) => coordinator.close()));
  pendingResolve = null;
});

// ---------------------------------------------------------------------------
// 受信/冒名 server 配置构造
// ---------------------------------------------------------------------------

function officialPayswapServerConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    type: "stdio",
    command: process.execPath,
    args: ["/opt/zcode/zcode.cjs", "__zcode-plugin-host", "/cache/payswap/dist/server.mjs"],
    env: {
      ZCODE_PLUGIN_ID: "payswap@zcode-plugins-official",
      PAYSWAP_FINANCIAL_WORKSPACE: "true",
      ELECTRON_RUN_AS_NODE: "1",
    },
    isolation: "workspace",
    source: { kind: "builtin" },
    ...overrides,
  } as McpServerConfig;
}

function makeSurfaces() {
  const pluginServers: Record<string, McpServerConfig> = {
    "plugin:payswap:gateway": officialPayswapServerConfig(),
  };
  const configuredServers: Record<string, McpServerConfig> = {
    ...pluginServers,
    "some-other-server": {
      type: "stdio",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: { ZCODE_PLUGIN_ID: "another@zcode-plugins-official" },
    } as McpServerConfig,
  };
  return { pluginServers, configuredServers };
}

function injectWith(
  coordinator: PayswapBrokerCoordinator,
  surfaces = makeSurfaces(),
  workspaceKey = "ws-test",
): Promise<Record<string, McpServerConfig>> {
  return coordinator.injectBrokerCredentials(surfaces.configuredServers, surfaces.pluginServers, { workspaceKey });
}

function tupleOf(config: McpServerConfig | undefined) {
  expect(config).toBeDefined();
  const env = (config as { env?: Record<string, string> }).env ?? {};
  return readPayswapBrokerCredentialTupleFromEnv(env);
}

const liveStateOptedIn = () => ({ pluginEnabled: true, financialWorkspace: true });

// ---------------------------------------------------------------------------
// 套件
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== "linux")("P1.4 Step 4 — broker spawn wiring (coordinator)", () => {
  it(
    "no trusted payswap server → nothing injected and the broker never boots (plugin disabled default)",
    async () => {
      const coordinator = createPayswapBrokerCoordinator({ liveStateReader: liveStateOptedIn });
      activeCoordinators.push(coordinator);
      const configuredServers: Record<string, McpServerConfig> = {
        "unrelated": {
          type: "stdio",
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
        } as McpServerConfig,
      };
      const result = await coordinator.injectBrokerCredentials(configuredServers, {}, { workspaceKey: "ws-test" });
      expect(result).toBe(configuredServers); // 同对象原样返回 —— 未 boot、未注入
      expect(coordinator.handle).toBeNull();
      await coordinator.close();
    },
    20000,
  );

  it(
    "a trusted payswap server → the broker boots once and the five-key tuple lands only on the trusted config (§4.2)",
    async () => {
      const coordinator = createPayswapBrokerCoordinator({ liveStateReader: liveStateOptedIn });
      activeCoordinators.push(coordinator);
      const surfaces = makeSurfaces();
      const injected = await injectWith(coordinator, surfaces);
      expect(coordinator.handle).not.toBeNull();
      expect(coordinator.handle?.mode).toBe("peer_verified");
      // 端点真实存在（socket 已绑定）。
      expect(fs.existsSync(coordinator.handle?.endpointPath ?? "")).toBe(true);
      // 受信配置拿到形状合法的五键组。
      const tuple = tupleOf(injected["plugin:payswap:gateway"]);
      expect(tuple).not.toBeNull();
      expect(isValidPayswapBrokerCredentialTuple(tuple as object)).toBe(true);
      expect((tuple as { socket: string }).socket).toBe(coordinator.handle?.endpointPath);
      // 兄弟 server 一个键都拿不到（§4.3(2)：只进受信 config 对象）。
      expect(tupleOf(injected["some-other-server"])).toBeNull();
      expect((injected["some-other-server"] as { env?: Record<string, string> }).env?.[PAYSWAP_BROKER_TOKEN_ENV_KEY]).toBeUndefined();
    },
    20000,
  );

  it(
    "N19 wiring: an impostor copy of the payswap config (same names/commands/env, different object) gets no credential",
    async () => {
      const coordinator = createPayswapBrokerCoordinator({ liveStateReader: liveStateOptedIn });
      activeCoordinators.push(coordinator);
      const surfaces = makeSurfaces();
      // 用户 override：同名的**不同对象**（拷贝了官方名字/命令/env）—— reference-identity 门拒绝。
      const impostorConfig = officialPayswapServerConfig({ command: "/usr/local/bin/node" });
      const configuredWithImpostor: Record<string, McpServerConfig> = {
        ...surfaces.configuredServers,
        "plugin:payswap:gateway": impostorConfig,
      };
      const injected = await coordinator.injectBrokerCredentials(
        configuredWithImpostor,
        surfaces.pluginServers,
        { workspaceKey: "ws-test" },
      );
      expect(tupleOf(injected["plugin:payswap:gateway"])).toBeNull();
      // broker 可能已 boot（受信名解析为空前不会 boot —— 这里解析结果为空，直接不 boot）。
      await coordinator.close();
    },
    20000,
  );

  it(
    "the mint is stable per (server, workspace) while the instance is live — pool keys do not fragment",
    async () => {
      const coordinator = createPayswapBrokerCoordinator({ liveStateReader: liveStateOptedIn });
      activeCoordinators.push(coordinator);
      const first = await injectWith(coordinator);
      const second = await injectWith(coordinator);
      const firstTuple = tupleOf(first["plugin:payswap:gateway"]);
      const secondTuple = tupleOf(second["plugin:payswap:gateway"]);
      expect(secondTuple).toEqual(firstTuple);
      // 不同 workspace → 不同实例（per-workspace isolation）。
      const other = await injectWith(coordinator, makeSurfaces(), "ws-other");
      expect(tupleOf(other["plugin:payswap:gateway"])).not.toEqual(firstTuple);
    },
    20000,
  );

  it(
    "processObserver.onStarted registers the minted instance; the child's request then answers the three-code law end-to-end (§4.1/§10.1/§7.3)",
    async () => {
      const coordinator = createPayswapBrokerCoordinator({ liveStateReader: liveStateOptedIn });
      activeCoordinators.push(coordinator);
      const injected = await injectWith(coordinator);
      const config = injected["plugin:payswap:gateway"];
      const tuple = tupleOf(config) as { instanceId: string; token: string };
      const handle = coordinator.handle as PayswapBrokerHandle;
      const line = JSON.stringify({
        instanceId: tuple.instanceId,
        seq: 1,
        op: "get_account_overview",
        params: {},
        token: tuple.token,
        sessionId: "sess-test",
      });
      let childPid = -1;
      const responsePromise = nextResponse();
      spawnClientChild({ path: handle.endpointPath, line, onPid: (pid) => (childPid = pid) });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // host 观察到 spawn：注册（pid 来自观察，tuple 来自 config）。
      coordinator.processObserver.onStarted("plugin:payswap:gateway", config, childPid);
      const responseLine = await responsePromise;
      const verdict = verifyResponseEnvelope(
        responseLine,
        { instanceId: tuple.instanceId, seq: 1, op: "get_account_overview", sentLine: line },
        {
          hostId: (tuple as { hostId: string }).hostId,
          verifyKeyBase64: (tuple as { verifyKeyBase64: string }).verifyKeyBase64,
        },
      );
      expect(verdict.ok).toBe(true);
      if (verdict.ok) {
        const data = verdict.body.data as { refusal?: { code: string } };
        expect(data.refusal?.code).toBe("not_connected");
      }
    },
    20000,
  );

  it(
    "processObserver.onStarted with a foreign tuple (not minted here) registers nothing — the child fails peer verification",
    async () => {
      const coordinator = createPayswapBrokerCoordinator({ liveStateReader: liveStateOptedIn });
      activeCoordinators.push(coordinator);
      const injected = await injectWith(coordinator);
      const handle = coordinator.handle as PayswapBrokerHandle;
      const foreignToken = randomBytes(32).toString("hex");
      const foreignInstance = randomUUID();
      const foreignConfig: McpServerConfig = {
        ...injected["plugin:payswap:gateway"],
        env: {
          ...(injected["plugin:payswap:gateway"] as { env: Record<string, string> }).env,
          [PAYSWAP_BROKER_TOKEN_ENV_KEY]: foreignToken,
          [PAYSWAP_BROKER_INSTANCE_ID_ENV_KEY]: foreignInstance,
        },
      };
      const line = JSON.stringify({
        instanceId: foreignInstance,
        seq: 1,
        op: "get_account_overview",
        params: {},
        token: foreignToken,
        sessionId: "sess-test",
      });
      let childPid = -1;
      const responsePromise = nextResponse();
      spawnClientChild({ path: handle.endpointPath, line, onPid: (pid) => (childPid = pid) });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // 观察者登记：foreign tuple 不是本协调器铸造的 —— 不注册（fail-closed）。
      coordinator.processObserver.onStarted("plugin:payswap:gateway", foreignConfig, childPid);
      const responseLine = await responsePromise;
      const parsed = JSON.parse(responseLine) as { envelope: { response: { error?: { code: string } } } };
      expect(parsed.envelope.response.error?.code).toBe("peer_verification_failed");
    },
    20000,
  );

  it(
    "processObserver.onClosed tombstones (exit), clears the mint; the next inject mints a fresh instance (§10.2(1))",
    async () => {
      const registry: PayswapInstanceRegistry = createPayswapInstanceRegistry();
      const coordinator = createPayswapBrokerCoordinator({ registry, liveStateReader: liveStateOptedIn });
      activeCoordinators.push(coordinator);
      const first = await injectWith(coordinator);
      const config = first["plugin:payswap:gateway"];
      const firstTuple = tupleOf(config) as { instanceId: string };
      coordinator.processObserver.onStarted("plugin:payswap:gateway", config, 4242);
      expect(registry.lookup(firstTuple.instanceId)).toEqual({
        status: "live",
        entry: expect.objectContaining({ instanceId: firstTuple.instanceId, childPid: 4242 }),
      });
      coordinator.processObserver.onClosed("plugin:payswap:gateway", config, 4242);
      expect(registry.lookup(firstTuple.instanceId)).toEqual({ status: "tombstoned", reason: "exit" });
      // 重新注入 → 全新 instanceId（旧 id 已终局，append-only）。
      const second = await injectWith(coordinator);
      const secondTuple = tupleOf(second["plugin:payswap:gateway"]) as { instanceId: string };
      expect(secondTuple.instanceId).not.toBe(firstTuple.instanceId);
    },
    20000,
  );

  it(
    "revokeForDisable tombstones every live instance (reason \"disabled\"); a residual call answers financial_mode_disabled (§10.2(2)/§7.3 row 1)",
    async () => {
      const registry: PayswapInstanceRegistry = createPayswapInstanceRegistry();
      // reader 说 enabled+opted —— 注册表撤销是权威（belt 无需 reader 佐证）。
      const coordinator = createPayswapBrokerCoordinator({ registry, liveStateReader: liveStateOptedIn });
      activeCoordinators.push(coordinator);
      const injectedA = await injectWith(coordinator, makeSurfaces(), "ws-a");
      const injectedB = await injectWith(coordinator, makeSurfaces(), "ws-b");
      const configA = injectedA["plugin:payswap:gateway"];
      const tupleA = tupleOf(configA) as { instanceId: string; token: string; hostId: string; verifyKeyBase64: string };
      const tupleB = tupleOf(injectedB["plugin:payswap:gateway"]) as { instanceId: string };
      coordinator.processObserver.onStarted("plugin:payswap:gateway", configA, 5252);
      coordinator.processObserver.onStarted("plugin:payswap:gateway", injectedB["plugin:payswap:gateway"], 5353);
      expect(registry.listLive().length).toBe(2);
      // 用户禁用插件 → §10.2(2) 撤销全部 live 实例。
      const revoked = coordinator.revokeForDisable();
      expect(new Set(revoked)).toEqual(new Set([tupleA.instanceId, tupleB.instanceId]));
      expect(registry.listLive().length).toBe(0);
      // 残留调用（子进程还活着）：request-attributed financial_mode_disabled。
      const handle = coordinator.handle as PayswapBrokerHandle;
      const line = JSON.stringify({
        instanceId: tupleA.instanceId,
        seq: 1,
        op: "get_account_overview",
        params: {},
        token: tupleA.token,
        sessionId: "sess-test",
      });
      const responsePromise = nextResponse();
      spawnClientChild({ path: handle.endpointPath, line, onPid: () => {} });
      const responseLine = await responsePromise;
      const verdict = verifyResponseEnvelope(
        responseLine,
        { instanceId: tupleA.instanceId, seq: 1, op: "get_account_overview", sentLine: line },
        { hostId: tupleA.hostId, verifyKeyBase64: tupleA.verifyKeyBase64 },
      );
      expect(verdict.ok).toBe(true);
      if (verdict.ok) {
        const data = verdict.body.data as { refusal?: { code: string } };
        expect(data.refusal?.code).toBe("financial_mode_disabled");
      }
    },
    20000,
  );

  it(
    "boot failure degrades fail-safe: no injection, the un-injected servers return unchanged (the child keeps the Wave 1 no-credential refusals)",
    async () => {
      const coordinator = createPayswapBrokerCoordinator({
        liveStateReader: liveStateOptedIn,
        boot: async () => {
          throw new Error("endpoint occupied");
        },
        onWiringError: (error) => {
          expect((error as Error).message).toBe("endpoint occupied");
        },
      });
      activeCoordinators.push(coordinator);
      const surfaces = makeSurfaces();
      const injected = await coordinator.injectBrokerCredentials(surfaces.configuredServers, surfaces.pluginServers, { workspaceKey: "ws-test" });
      // fail-safe：不注入（子进程无凭据 → Wave 1 fail-closed 路径），绝不抛半组。
      expect(injected).toBe(surfaces.configuredServers);
      expect(coordinator.handle).toBeNull();
    },
    20000,
  );

  it(
    "close() is idempotent and removes the endpoint",
    async () => {
      const coordinator = createPayswapBrokerCoordinator({ liveStateReader: liveStateOptedIn });
      await injectWith(coordinator);
      const endpoint = coordinator.handle?.endpointPath ?? "";
      expect(fs.existsSync(endpoint)).toBe(true);
      await coordinator.close();
      await coordinator.close();
      expect(fs.existsSync(endpoint)).toBe(false);
      expect(coordinator.handle?.closed).toBe(true);
    },
    20000,
  );
});

describe("P1.4 Step 4 — live state from config (pure, all platforms)", () => {
  it("reads pluginEnabled and financialWorkspace from the merged config shape (§7.3 live read)", () => {
    // 默认：未启用（payswap 的 defaultEnabled=false）+ 未 opt-in。
    expect(readPayswapLiveStateFromConfig({ plugins: {} })).toEqual({
      pluginEnabled: false,
      financialWorkspace: false,
    });
    expect(
      readPayswapLiveStateFromConfig({
        plugins: {
          enabledPlugins: { "payswap@zcode-plugins-official": true },
          options: { "payswap@zcode-plugins-official": { financialWorkspace: true } },
        },
      }),
    ).toEqual({ pluginEnabled: true, financialWorkspace: true });
    expect(
      readPayswapLiveStateFromConfig({
        plugins: {
          enabledPlugins: { "payswap@zcode-plugins-official": true },
          options: { "payswap@zcode-plugins-official": { financialWorkspace: false } },
        },
      }),
    ).toEqual({ pluginEnabled: true, financialWorkspace: false });
    // 显式禁用（残留调用路径）：enabled=false 覆盖 opt-in。
    expect(
      readPayswapLiveStateFromConfig({
        plugins: {
          enabledPlugins: { "payswap@zcode-plugins-official": false },
          options: { "payswap@zcode-plugins-official": { financialWorkspace: true } },
        },
      }),
    ).toEqual({ pluginEnabled: false, financialWorkspace: true });
    // 其它插件的配置不串扰。
    expect(
      readPayswapLiveStateFromConfig({
        plugins: {
          enabledPlugins: { "zcode-cua@zcode-plugins-official": true },
          options: { "zcode-cua@zcode-plugins-official": { financialWorkspace: true } },
        },
      }),
    ).toEqual({ pluginEnabled: false, financialWorkspace: false });
  });
});
