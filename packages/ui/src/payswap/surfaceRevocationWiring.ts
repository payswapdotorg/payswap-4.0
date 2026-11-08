/**
 * PaySwap 表面撤销接线的真实原语绑定（addendum §2.3 item 1 臂 (b) + §1.6 N18 的完整
 * plugin-handle teardown 臂；ADR-12 D12.7；playbook P1.8 work package「the desktop
 * card wiring」）。
 *
 * 职责（法则实现住 shared-payswap —— 单一实现纪律；本模块是 @zcode/ui 侧的接线与
 * 真实原语绑定 owner）：
 * - **teardownInstance ↔ 上游实例卸载纪律**：目标实例的有界拆除走
 *   controller.dispose()（其内部即 runPluginUiHostTeardown：有界
 *   ui/resource-teardown 清理窗 → 桥/端口关闭 → disposeSandbox(捕获的
 *   sandboxId/initId)；桥/transport/句柄只有 controller 自己持有 —— 接线经
 *   teardownLiveInstance 委托，不在注册表复制第二份拆除实现）。
 * - **clearSurfaceFeed/clearWidgetState ↔ @zcode/ui 的真实逐键清除 API**
 *   （clearPluginUiSurfaceFeed / clearPluginUiWidgetState —— 两 store 与
 *   buildPluginUiSurfaceKey 同一套隔离键）。
 * - **守护窗与上游拆除窗同源**：teardownGuardMs = teardownTimeoutMs + 100
 *   （runPluginUiHostTeardown 自己的 setTimer(finish, timeout + 100) 同款 ——
 *   有界性法则永远点名自己的窗）。
 * - **自有键 = 真实 builder 的字节等价委托**：buildPayswapOwnSurfaceKey 委托
 *   buildPluginUiSurfaceKey（P1.8 T-series 电池登记的「字节等价由 D12.7 接线时以
 *   真实 builder 复验」欠条 —— shared 法则按结构同构解析，本模块保证两者产出同一
 *   字节串）。
 * - **租约提取**：PluginSandboxHandle → 捕获租约（sandboxId/initId + appIdentity
 *   租约三元组 runtimeId/generation/appIdentity）；**token 永不入册**（秘密不入
 *   注册表 —— 拆除只需 sandboxId/initId）。
 */

import type { PluginSandboxHandle, PluginUiScopeRef } from "@zcode/shared/mcp-apps";
import { MCP_APPS_TEARDOWN_TIMEOUT_MS } from "@zcode/shared/mcp-apps";
import type {
  PayswapSurfaceAnchorPolicy,
  PayswapSurfaceContentRegistry,
  PayswapSurfaceLease,
  PayswapSurfaceRevocationDeps,
} from "@zcode/shared/payswap";
import { clearPluginUiSurfaceFeed, clearPluginUiWidgetState } from "../plugin-ui/hostPrimitives.js";
import { buildPluginUiSurfaceKey, type PluginUiSessionScope } from "../plugin-ui/contract.js";

/** 自有表面键的目标面（与 buildPluginUiSurfaceKey 的输入同构）。 */
export type PayswapOwnSurfaceTarget = PluginUiSessionScope & {
  pluginId: string;
  serverName?: string;
  resourceUri?: string;
};

/**
 * 自有键建造（字节等价委托）：结果与 buildPluginUiSurfaceKey 完全一致 —— shared
 * 法则的结构同构解析（[sessionKey, pluginId, serverName, resourceUri, scopeId]）
 * 以此复验字节等价；外来插件的键会被注册表拒绝（恰自有键纪律）。
 */
export function buildPayswapOwnSurfaceKey(
  target: PayswapOwnSurfaceTarget,
  scope: PluginUiScopeRef,
): string {
  return buildPluginUiSurfaceKey(target, scope);
}

/**
 * 捕获租约提取：PluginSandboxHandle → PayswapSurfaceLease。token 不入册
 * （注册表永不持有秘密 —— 拆除只需 sandboxId/initId）。
 */
export function leaseFromPluginSandboxHandle(handle: PluginSandboxHandle): PayswapSurfaceLease {
  return {
    sandboxId: handle.sandboxId,
    initId: handle.initId,
    runtimeId: handle.instance.runtimeId,
    generation: handle.instance.generation,
    appIdentity: handle.instance.appIdentity,
  };
}

/**
 * 实例入册便捷面：真实 builder 的自有键 + 提取租约 + 锚点策略（金融工作区面板 =
 * "replace" —— dispose 后以无数据能力的新租约重占）。
 */
export function registerPayswapSurfaceInstance(input: {
  registry: PayswapSurfaceContentRegistry;
  target: PayswapOwnSurfaceTarget;
  scope: PluginUiScopeRef;
  handle: PluginSandboxHandle;
  anchor: PayswapSurfaceAnchorPolicy;
}): void {
  input.registry.registerInstance({
    surfaceKey: buildPayswapOwnSurfaceKey(input.target, input.scope),
    lease: leaseFromPluginSandboxHandle(input.handle),
    anchor: input.anchor,
  });
}

/** 装配侧的拆除目标（页面/控制器 owner 供给；IO 不进法则层）。 */
export interface PayswapUiSurfaceTeardownTarget {
  /**
   * 该 surfaceKey 当前 live 实例的有界拆除 —— 上游 controller.dispose() 纪律
   * （closeInstance → 有界 ui/resource-teardown 窗 → 桥/端口关闭 →
   * disposeSandbox(捕获凭证)）。已拆除/无实例 = 幂等 no-op。
   */
  teardownLiveInstance(surfaceKey: string): Promise<void>;
  /** 锚点重占（dispose_and_replace）：创建无数据能力的新租约实例（新 sandboxId）。 */
  createReplacementInstance(surfaceKey: string): Promise<PayswapSurfaceLease>;
}

export interface PayswapSurfaceRevocationWiringOptions {
  target: PayswapUiSurfaceTeardownTarget;
  /**
   * 上游拆除窗毫秒（缺省 MCP_APPS_TEARDOWN_TIMEOUT_MS）；守护窗 = 本值 + 100
   * （与 runPluginUiHostTeardown 自己的守卫同源同式）。
   */
  teardownTimeoutMs?: number;
  /** 有界窗计时器（缺省 setTimeout）；测试可注入。 */
  setTimer?: (callback: () => void, ms: number) => () => void;
  /** 未标记实例的 best-effort 撤销事件（§2.3 item 5：无安全属性依赖）。 */
  notifyBestEffortRevocation?: (surfaceKey: string) => void;
}

/**
 * 把 §2.3 撤销执行器的 deps 绑定到真实原语：teardownInstance → 装配侧拆除目标
 * （上游 controller.dispose() 纪律）；clearSurfaceFeed/clearWidgetState → @zcode/ui
 * 的真实逐键清除；守护窗与上游拆除窗同源（timeout + 100）。
 */
export function bindPayswapSurfaceRevocationDeps(
  options: PayswapSurfaceRevocationWiringOptions,
): PayswapSurfaceRevocationDeps {
  const teardownTimeoutMs = options.teardownTimeoutMs ?? MCP_APPS_TEARDOWN_TIMEOUT_MS;
  const defaultSetTimer = (callback: () => void, ms: number) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  };
  return {
    async teardownInstance({ surfaceKey }) {
      await options.target.teardownLiveInstance(surfaceKey);
    },
    async createReplacementInstance({ surfaceKey }) {
      return options.target.createReplacementInstance(surfaceKey);
    },
    clearSurfaceFeed(surfaceKey) {
      clearPluginUiSurfaceFeed(surfaceKey);
    },
    clearWidgetState(surfaceKey) {
      clearPluginUiWidgetState(surfaceKey);
    },
    setTimer: options.setTimer ?? defaultSetTimer,
    teardownGuardMs: teardownTimeoutMs + 100,
    ...(options.notifyBestEffortRevocation
      ? { notifyBestEffortRevocation: options.notifyBestEffortRevocation }
      : {}),
  };
}
