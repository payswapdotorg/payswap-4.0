/**
 * PaySwap P1.8 D12.7 —— 表面撤销接线的真实原语绑定（N18 的完整 plugin-handle
 * teardown 臂；addendum §2.3 item 1 臂 (b) + §1.6（N18）；ADR-12 D12.7 ——「N18's
 * full plugin-handle teardown arm arrive with the surface work」；playbook P1.8
 * work package「the desktop card wiring」）。
 *
 * 法则（normative）：
 * - **接线缝闭合**（surface-revocation 法则头的 D12.7 缝）：
 *   - `teardownInstance` ↔ 上游实例卸载纪律（controller.dispose() 内部即
 *     runPluginUiHostTeardown：有界 ui/resource-teardown 窗 → 桥/端口关闭 →
 *     disposeSandbox(捕获的 sandboxId/initId)）；
 *   - `clearSurfaceFeed`/`clearWidgetState` ↔ @zcode/ui 的真实逐键清除 API
 *     （clearPluginUiSurfaceFeed / clearPluginUiWidgetState）；
 *   - 守护窗与上游拆除窗**同源**（teardownGuardMs = teardownTimeoutMs + 100 ——
 *     runPluginUiHostTeardown 自己的 setTimer(finish, timeout + 100) 同款）；
 *   - 自有键 = 真实 buildPluginUiSurfaceKey 的字节等价委托（「字节等价由 D12.7
 *     接线时以真实 builder 复验」—— P1.8 T-series 电池登记的欠条）。
 * - **N18 完整臂**（§1.6 N18：「after card/instance teardown | stale capability
 *   handle replayed | handle rejected (upstream pluginUiHostTeardown discipline);
 *   no effect on newer pages」）：撤销经真实 controller 驱动真实拆除 ——
 *   disposeSandbox 收到**捕获的**（sandboxId, initId）；页面永不合作（teardownResource
 *   永不 settle）→ 有界窗到期推进；新凭证/新 sandboxId 的页面不受影响。
 * - **租约提取**：捕获租约 = sandboxId/initId + appIdentity 租约三元组
 *   （runtimeId/generation/appIdentity）；**token 永不入注册表**（秘密不入册）。
 *
 * 两级证明：
 * 1. 接线级（bindPayswapSurfaceRevocationDeps + 真实 store + 真实 builder）——
 *    逐键清除、恰自有键、守护窗同源。
 * 2. 真实 controller 级 —— 真实 createPluginUiHostController（全部 IO 经注入
 *    fake 端口；AppBridge 经 createAppBridge 注入）驱动撤销：捕获凭证释放、
 *    有界窗、新页面不受影响、renderer 保留经真实 API 清除。
 *
 * 范围（诚实声明，工程层 vs 桌面 E2E 层）：真实 webview/guest、真实 DOM/heap
 * 销毁与真实渲染层锚点重占（createReplacementInstance 的生产实现）属于 roadmap
 * 登记的 desktop Browser E2E run + 桌面装配接线；本套件证明接线缝闭合与上游
 * 拆除纪律的真实驱动。
 */

import type { Transport } from "@modelcontextprotocol/client";
import type { McpUiHostCapabilities, McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  createPayswapSurfaceContentRegistry,
  runPayswapSurfaceOptOutRevocation,
  PAYSWAP_OFFICIAL_PLUGIN_ID,
  type PayswapSurfaceLease,
} from "@zcode/shared/payswap";
import { MCP_APPS_TEARDOWN_TIMEOUT_MS } from "@zcode/shared/mcp-apps";
import type {
  PluginSandboxHandle,
  PluginSandboxPlatformPort,
  PluginSandboxPortsEvent,
  PluginSandboxTransportPort,
} from "@zcode/shared/mcp-apps";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildPluginUiSurfaceKey } from "@/plugin-ui/contract.js";
import { createPluginUiHostController } from "@/plugin-ui/app/pluginUiHostController.js";
import type { PluginUiHostBridge } from "@/plugin-ui/app/pluginUiHostBridge.js";
import {
  getPluginUiSurfaceFeed,
  offerPluginUiSurfaceFeed,
  resetPluginUiSurfaceFeedsForTest,
} from "@/plugin-ui/app/pluginUiSurfaceFeedStore.js";
import {
  getPluginUiWidgetState,
  resetPluginUiWidgetStateForTest,
  setPluginUiWidgetState,
} from "@/plugin-ui/app/pluginUiWidgetStateStore.js";
import {
  bindPayswapSurfaceRevocationDeps,
  buildPayswapOwnSurfaceKey,
  leaseFromPluginSandboxHandle,
} from "@/payswap/surfaceRevocationWiring.js";

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

/** 官方插件的面板锚点（金融工作区面板形状）。 */
const OWN_TARGET = {
  workspacePath: "/home/dev/workspace",
  sessionId: "session-1",
  pluginId: PAYSWAP_OFFICIAL_PLUGIN_ID,
  serverName: "gateway",
  resourceUri: "payswap://workspace-panel",
} as const;
const OWN_SCOPE = { kind: "surface", surfaceId: "workspace-panel" } as const;

/** 外来插件的同形状对照（真实 builder 产出 —— 恰自有键纪律必须拒绝）。 */
const FOREIGN_TARGET = {
  ...OWN_TARGET,
  pluginId: "other-plugin@some-marketplace",
};

const HEX64 = "a".repeat(64);

function fakeHandle(input: { sandboxId: string; initId?: number; generation?: number }): PluginSandboxHandle {
  return {
    instance: {
      runtimeId: `rt-${input.sandboxId}`,
      generation: input.generation ?? 1,
      appIdentity: HEX64,
      token: `secret-token-${input.sandboxId}`,
    },
    sandboxId: input.sandboxId,
    initId: input.initId ?? 1,
    shellUrl: `zcode-sandbox://plugin-x/${input.sandboxId}`,
    partition: "persist:plugin-x",
  };
}

/**
 * 真实 controller 夹具：全部 IO 经注入 fake 端口；AppBridge 经 createAppBridge
 * 注入（teardownResource 行为可控 —— settle / hang）。
 */
function createRealControllerFixture(input: {
  sandboxId: string;
  teardownBehavior?: "settle" | "hang";
  teardownTimeoutMs?: number;
}) {
  const prepared = fakeHandle({ sandboxId: input.sandboxId });
  const disposeSandboxCalls: Array<{ sandboxId: string; initId?: number }> = [];
  const closeInstanceCalls: unknown[] = [];
  const portHandlers: Array<(event: PluginSandboxPortsEvent) => void> = [];

  const platform = {
    getOwnerWebContentsId: async () => 1,
    disposeSandbox: async (sandboxId: string, initId?: number) => {
      disposeSandboxCalls.push({ sandboxId, initId });
    },
    consumeUserGesture: async () => false,
    onPorts: (handler: (event: PluginSandboxPortsEvent) => void) => {
      portHandlers.push(handler);
      return () => {};
    },
  } as unknown as PluginSandboxPlatformPort;

  const bridgeService = {
    prepareSandbox: async () => prepared,
    validateInstance: async () => {},
    closeInstance: async (params: unknown) => {
      closeInstanceCalls.push(params);
    },
    recycleInstance: async () => false,
    callTool: async () => {
      throw new Error("not used in this fixture");
    },
    cancelToolCall: async () => ({ cancelled: false }),
    readResource: async () => {
      throw new Error("not used in this fixture");
    },
    listResources: async () => ({ resources: [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
    subscribeResource: async () => {},
    unsubscribeResource: async () => {},
  };

  const teardownCalls: Array<{ params: unknown; options?: { timeout?: number } }> = [];
  const appBridge = {
    oninitialized: undefined as (() => void) | undefined,
    oncreatesamplingmessage: undefined,
    oncalltool: undefined,
    onreadresource: undefined,
    onlistresources: undefined,
    onlistresourcetemplates: undefined,
    onopenlink: undefined,
    onrequestdisplaymode: undefined,
    onupdatemodelcontext: undefined,
    ondownloadfile: undefined,
    onrequestteardown: undefined,
    onsizechange: undefined,
    onloggingmessage: undefined,
    async connect() {
      // 真实 AppBridge：connect 后握手完成回调 oninitialized（控制器已先登记）。
      appBridge.oninitialized?.();
    },
    async close() {},
    setHostContext() {},
    async sendToolInput() {},
    async sendToolResult() {},
    async sendToolCancelled() {},
    teardownResource(params: unknown, options?: { timeout?: number }) {
      teardownCalls.push({ params, options });
      return input.teardownBehavior === "hang"
        ? new Promise<unknown>(() => {})
        : Promise.resolve({});
    },
    getAppCapabilities() {
      return undefined;
    },
    async notification() {},
    async listTools() {
      return { tools: [] };
    },
    async callTool() {
      return { content: [] };
    },
    setNotificationHandler() {},
    setRequestHandler() {},
  };

  let phaseHandle: PluginSandboxHandle | null = null;
  const controller = createPluginUiHostController({
    bridge: bridgeService as never,
    platform,
    createTransport: (_port: PluginSandboxTransportPort) =>
      ({ close: async () => {} }) as unknown as Transport,
    createAppBridge: () => appBridge as unknown as PluginUiHostBridge,
    scope: {
      workspacePath: OWN_TARGET.workspacePath,
      sessionId: OWN_TARGET.sessionId,
      scope: OWN_SCOPE,
    },
    presentation: {
      serverName: OWN_TARGET.serverName,
      pluginId: OWN_TARGET.pluginId,
      resourceUri: OWN_TARGET.resourceUri,
    },
    initialHostContext: {} as McpUiHostContext,
    getToolFeed: () => ({}),
    getWidgetState: () => undefined,
    getHostCapabilities: () => ({}) as McpUiHostCapabilities,
    hostVersion: "test",
    handshakeTimeoutMs: 5_000,
    ...(input.teardownTimeoutMs !== undefined ? { teardownTimeoutMs: input.teardownTimeoutMs } : {}),
    onPhase: (_phase, detail) => {
      if (detail?.handle) phaseHandle = detail.handle;
    },
    onHeight: () => {},
    onDisplayModeRequest: (mode) => mode,
    onOpenExternal: () => {},
    log: () => {},
  });

  return {
    controller,
    teardownCalls,
    disposeSandboxCalls,
    closeInstanceCalls,
    prepared,
    firePort: () => {
      for (const handler of portHandlers) {
        handler({ sandboxId: input.sandboxId, initId: 1, port: {} as PluginSandboxTransportPort });
      }
    },
    getPhaseHandle: () => phaseHandle,
  };
}

/** 驱动夹具到 running（握手完成、teardown 窗生效）。 */
async function driveToRunning(fixture: ReturnType<typeof createRealControllerFixture>) {
  fixture.controller.start();
  await vi.waitFor(() => expect(fixture.getPhaseHandle()).not.toBeNull());
  fixture.firePort();
  await vi.waitFor(() => expect(fixture.controller.phase).toBe("running"));
  return fixture.getPhaseHandle()!;
}

afterEach(() => {
  resetPluginUiSurfaceFeedsForTest();
  resetPluginUiWidgetStateForTest();
});

// 防御：任何用例忘清 store 也不跨文件泄漏。
afterAll(() => {
  resetPluginUiSurfaceFeedsForTest();
  resetPluginUiWidgetStateForTest();
});

// ---------------------------------------------------------------------------
// 1. 自有键的真实 builder 复验（字节等价欠条）
// ---------------------------------------------------------------------------

describe("P1.8 D12.7 — the own-surface-key byte-equality re-verification", () => {
  it("delegates byte-equal to the real buildPluginUiSurfaceKey", () => {
    expect(buildPayswapOwnSurfaceKey(OWN_TARGET, OWN_SCOPE)).toBe(
      buildPluginUiSurfaceKey(OWN_TARGET, OWN_SCOPE),
    );
  });

  it("the real builder's key enters the payswap registry (structure isomorphism accepted)", () => {
    const registry = createPayswapSurfaceContentRegistry();
    const key = buildPluginUiSurfaceKey(OWN_TARGET, OWN_SCOPE);
    expect(() =>
      registry.registerInstance({
        surfaceKey: key,
        lease: fakeLease("sbx-key"),
        anchor: "release",
      }),
    ).not.toThrow();
  });

  it("rejects foreign-plugin keys built by the real builder (own-key discipline)", () => {
    const registry = createPayswapSurfaceContentRegistry();
    const foreignKey = buildPluginUiSurfaceKey(FOREIGN_TARGET, OWN_SCOPE);
    expect(() =>
      registry.registerInstance({
        surfaceKey: foreignKey,
        lease: {
          sandboxId: "sbx-foreign",
          initId: 1,
          runtimeId: "rt-foreign",
          generation: 1,
          appIdentity: HEX64,
        },
        anchor: "release",
      }),
    ).toThrow(/non-own surface key/);
  });
});

// ---------------------------------------------------------------------------
// 2. 租约提取（token 不入册）
// ---------------------------------------------------------------------------

describe("P1.8 D12.7 — lease extraction from a real PluginSandboxHandle", () => {
  it("extracts the captured lease (sandboxId/initId + the appIdentity triple)", () => {
    const handle = fakeHandle({ sandboxId: "sbx-a", initId: 3, generation: 7 });
    expect(leaseFromPluginSandboxHandle(handle)).toEqual({
      sandboxId: "sbx-a",
      initId: 3,
      runtimeId: "rt-sbx-a",
      generation: 7,
      appIdentity: HEX64,
    });
  });

  it("never carries the instance token into the registry lease", () => {
    const handle = fakeHandle({ sandboxId: "sbx-a" });
    const lease = leaseFromPluginSandboxHandle(handle) as unknown as Record<string, unknown>;
    expect(lease["token"]).toBeUndefined();
    expect(JSON.stringify(lease)).not.toContain("secret-token-sbx-a");
  });
});

// ---------------------------------------------------------------------------
// 3. deps 绑定（真实 store + 同源守护窗）
// ---------------------------------------------------------------------------

describe("P1.8 D12.7 — the revocation deps bound to the real primitives", () => {
  it("names its guard window from the upstream teardown timeout source (timeout + 100)", () => {
    const deps = bindPayswapSurfaceRevocationDeps({
      target: { teardownLiveInstance: async () => {}, createReplacementInstance: async () => fakeLease("sbx-new") },
    });
    expect(deps.teardownGuardMs).toBe(MCP_APPS_TEARDOWN_TIMEOUT_MS + 100);
    const custom = bindPayswapSurfaceRevocationDeps({
      target: { teardownLiveInstance: async () => {}, createReplacementInstance: async () => fakeLease("sbx-new") },
      teardownTimeoutMs: 25,
    });
    expect(custom.teardownGuardMs).toBe(125);
  });

  it("clears renderer retention through the real per-key store APIs (both stores, exactly the planned keys)", async () => {
    resetPluginUiSurfaceFeedsForTest();
    resetPluginUiWidgetStateForTest();
    const registry = createPayswapSurfaceContentRegistry();
    const ownKey = buildPayswapOwnSurfaceKey(OWN_TARGET, OWN_SCOPE);
    const markedKey = buildPayswapOwnSurfaceKey(
      { ...OWN_TARGET, resourceUri: "payswap://evidence" },
      { kind: "surface", surfaceId: "evidence-panel" },
    );
    const retiredKey = buildPayswapOwnSurfaceKey(
      { ...OWN_TARGET, resourceUri: "payswap://route-plan" },
      { kind: "surface", surfaceId: "route-plan-panel" },
    );
    const foreignKey = buildPluginUiSurfaceKey(FOREIGN_TARGET, OWN_SCOPE);

    registry.registerInstance({
      surfaceKey: ownKey,
      lease: fakeLease("sbx-own"),
      anchor: "release",
    });
    registry.markProtectedDataDelivered(ownKey);
    registry.registerInstance({
      surfaceKey: markedKey,
      lease: fakeLease("sbx-marked"),
      anchor: "release",
    });
    registry.markProtectedDataDelivered(markedKey);
    registry.registerInstance({
      surfaceKey: retiredKey,
      lease: fakeLease("sbx-retired"),
      anchor: "release",
    });
    registry.retireInstance(retiredKey);

    // renderer 保留：自有键 + 外来键都有存量。
    setPluginUiWidgetState(ownKey, { collapsed: true });
    setPluginUiWidgetState(retiredKey, { scroll: 12 });
    setPluginUiWidgetState(foreignKey, { foreign: true });
    offerPluginUiSurfaceFeed(ownKey, {
      latest: {
        rowId: 1,
        toolCallId: "call-1",
        status: "success",
        presentation: {
          serverName: OWN_TARGET.serverName,
          pluginId: OWN_TARGET.pluginId,
          resourceUri: OWN_TARGET.resourceUri,
        },
        input: undefined,
      },
      result: null,
    });

    const tornDown: string[] = [];
    const report = await runPayswapSurfaceOptOutRevocation(
      registry,
      bindPayswapSurfaceRevocationDeps({
        target: {
          teardownLiveInstance: async (surfaceKey) => {
            tornDown.push(surfaceKey);
          },
          createReplacementInstance: async () => fakeLease("sbx-new"),
        },
      }),
    );

    // 两个标记 live 实例拆除；已关闭实例无拆除动作但键在清除集。
    expect(tornDown.sort()).toEqual([markedKey, ownKey].sort());
    expect(report.disposed.sort()).toEqual([markedKey, ownKey].sort());
    expect(report.retentionCleared).toEqual([ownKey, markedKey, retiredKey]);

    // 真实 store：自有键清空、外来键不动。
    expect(getPluginUiWidgetState(ownKey)).toBeUndefined();
    expect(getPluginUiWidgetState(retiredKey)).toBeUndefined();
    expect(getPluginUiWidgetState(foreignKey)).toEqual({ foreign: true });
    expect(getPluginUiSurfaceFeed(ownKey)).toEqual({ latest: null, result: null });
  });

  it("routes the unmarked instance to the best-effort event (no teardown)", async () => {
    const registry = createPayswapSurfaceContentRegistry();
    const ownKey = buildPayswapOwnSurfaceKey(OWN_TARGET, OWN_SCOPE);
    registry.registerInstance({ surfaceKey: ownKey, lease: fakeLease("sbx-own"), anchor: "release" });
    const notified: string[] = [];
    const tornDown: string[] = [];
    const report = await runPayswapSurfaceOptOutRevocation(
      registry,
      bindPayswapSurfaceRevocationDeps({
        target: {
          teardownLiveInstance: async (surfaceKey) => {
            tornDown.push(surfaceKey);
          },
          createReplacementInstance: async () => fakeLease("sbx-new"),
        },
        notifyBestEffortRevocation: (surfaceKey) => notified.push(surfaceKey),
      }),
    );
    expect(tornDown).toEqual([]);
    expect(notified).toEqual([ownKey]);
    expect(report.bestEffortNotified).toEqual([ownKey]);
    expect(report.disposed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. N18 完整臂 —— 真实 controller 驱动真实拆除纪律
// ---------------------------------------------------------------------------

describe("P1.8 D12.7 — N18's full plugin-handle teardown arm through a real controller", () => {
  it("drives the real bounded teardown discipline (captured-credential disposeSandbox, closeInstance, newer pages untouched)", async () => {
    const fixture = createRealControllerFixture({ sandboxId: "sbx-a" });
    const handle = await driveToRunning(fixture);

    const registry = createPayswapSurfaceContentRegistry();
    const ownKey = buildPayswapOwnSurfaceKey(OWN_TARGET, OWN_SCOPE);
    registry.registerInstance({
      surfaceKey: ownKey,
      lease: leaseFromPluginSandboxHandle(handle),
      anchor: "release",
    });
    registry.markProtectedDataDelivered(ownKey);
    setPluginUiWidgetState(ownKey, { collapsed: true });

    // 新凭证页面（新 sandboxId）—— 不受旧租约拆除影响（N18）。
    const newer = createRealControllerFixture({ sandboxId: "sbx-b" });
    const newerHandle = await driveToRunning(newer);

    const report = await runPayswapSurfaceOptOutRevocation(
      registry,
      bindPayswapSurfaceRevocationDeps({
        target: {
          teardownLiveInstance: () => fixture.controller.dispose(),
          createReplacementInstance: async () => leaseFromPluginSandboxHandle(newerHandle),
        },
      }),
    );

    expect(report.disposed).toEqual([ownKey]);
    // 真实拆除纪律：closeInstance（桥释放）+ disposeSandbox（捕获的 sandboxId/initId）。
    expect(fixture.closeInstanceCalls).toHaveLength(1);
    expect(fixture.disposeSandboxCalls).toEqual([{ sandboxId: "sbx-a", initId: 1 }]);
    // 新页面不受影响：未被拆除、仍在 running。
    expect(newer.disposeSandboxCalls).toEqual([]);
    expect(newer.controller.phase).toBe("running");
    // renderer 保留经真实 API 清除。
    expect(getPluginUiWidgetState(ownKey)).toBeUndefined();
    expect(fixture.controller.phase).toBe("disposed");
  });

  it("proceeds when the page never cooperates (the real bounded window expiry)", async () => {
    const fixture = createRealControllerFixture({
      sandboxId: "sbx-hang",
      teardownBehavior: "hang",
      teardownTimeoutMs: 20,
    });
    const handle = await driveToRunning(fixture);

    const registry = createPayswapSurfaceContentRegistry();
    const ownKey = buildPayswapOwnSurfaceKey(OWN_TARGET, OWN_SCOPE);
    registry.registerInstance({
      surfaceKey: ownKey,
      lease: leaseFromPluginSandboxHandle(handle),
      anchor: "release",
    });
    registry.markProtectedDataDelivered(ownKey);

    // 页面永不合作：真实 runPluginUiHostTeardown 的有界窗（timeout + 100）推进。
    const report = await runPayswapSurfaceOptOutRevocation(
      registry,
      bindPayswapSurfaceRevocationDeps({
        target: {
          teardownLiveInstance: () => fixture.controller.dispose(),
          createReplacementInstance: async () => fakeLease("sbx-new"),
        },
        teardownTimeoutMs: 20,
      }),
    );

    expect(report.disposed).toEqual([ownKey]);
    // 真实 ui/resource-teardown 清理窗确实开过（带超时参数），只是页面没有回包。
    expect(fixture.teardownCalls).toHaveLength(1);
    expect(fixture.teardownCalls[0]?.options?.timeout).toBe(20);
    // 到期推进：捕获凭证照样释放。
    expect(fixture.disposeSandboxCalls).toEqual([{ sandboxId: "sbx-hang", initId: 1 }]);
  });

  it("re-registers the replacement instance for the next cycle (fresh sandboxId)", async () => {
    const registry = createPayswapSurfaceContentRegistry();
    const ownKey = buildPayswapOwnSurfaceKey(OWN_TARGET, OWN_SCOPE);
    registry.registerInstance({ surfaceKey: ownKey, lease: fakeLease("sbx-old"), anchor: "replace" });
    registry.markProtectedDataDelivered(ownKey);

    const replacementLease = fakeLease("sbx-fresh");
    const report = await runPayswapSurfaceOptOutRevocation(
      registry,
      bindPayswapSurfaceRevocationDeps({
        target: {
          teardownLiveInstance: async () => {},
          createReplacementInstance: async () => replacementLease,
        },
      }),
    );

    expect(report.replaced).toEqual([ownKey]);
    // 替换实例重新入册：下一轮 opt-out 对它同样有效。
    const nextPlan = registry.planOptOutRevocation();
    expect(nextPlan.actions.map((action) => action.lease.sandboxId)).toEqual(["sbx-fresh"]);
    expect(nextPlan.actions[0]?.kind).toBe("best_effort_event");
  });
});

/** 最小租约 fixture。 */
function fakeLease(sandboxId: string): PayswapSurfaceLease {
  return {
    sandboxId,
    initId: 1,
    runtimeId: `rt-${sandboxId}`,
    generation: 1,
    appIdentity: HEX64,
  };
}
