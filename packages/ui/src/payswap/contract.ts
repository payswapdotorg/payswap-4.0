/**
 * ui-payswap 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 * 每个方法注释写清：前置/后置条件、幂等性、发出哪些事件、是否等待持久化。
 */

import type { PluginSandboxHandle, PluginUiScopeRef } from "@zcode/shared/mcp-apps";
import type {
  PayswapSurfaceAnchorPolicy,
  PayswapSurfaceContentRegistry,
  PayswapSurfaceLease,
  PayswapSurfaceRevocationDeps,
} from "@zcode/shared/payswap";
import type { PluginUiSessionScope } from "../plugin-ui/contract.js";

/** 自有表面键的目标面（与 buildPluginUiSurfaceKey 的输入同构）。 */
export type PayswapOwnSurfaceTarget = PluginUiSessionScope & {
  pluginId: string;
  serverName?: string;
  resourceUri?: string;
};

/**
 * 自有键建造（字节等价委托 buildPluginUiSurfaceKey）。
 * 前置：target 的 pluginId 是官方插件（payswap@zcode-plugins-official）—— 外来键会被
 * 注册表在入册时拒绝（恰自有键纪律，fail-closed 抛错）。
 * 幂等：纯函数。
 */
export type PayswapOwnSurfaceKeyBuilder = (
  target: PayswapOwnSurfaceTarget,
  scope: PluginUiScopeRef,
) => string;

/**
 * 捕获租约提取（PluginSandboxHandle → PayswapSurfaceLease）。
 * 后置：结果**不含** instance.token —— 注册表永不持有秘密（拆除只需
 * sandboxId/initId）。
 */
export type PayswapLeaseExtractor = (handle: PluginSandboxHandle) => PayswapSurfaceLease;

/** 装配侧拆除目标：IO 边界（页面/控制器 owner 供给；法则层不持有）。 */
export interface PayswapUiSurfaceTeardownTarget {
  /**
   * 该 surfaceKey 当前 live 实例的有界拆除 —— 上游 controller.dispose() 纪律
   * （closeInstance → 有界 ui/resource-teardown 窗（MCP_APPS_TEARDOWN_TIMEOUT_MS）→
   * 桥/端口关闭 → disposeSandbox(捕获的 sandboxId/initId)）。幂等：已拆除/无实例
   * = no-op resolve。有界：内部窗到期即推进，不依赖页面合作。
   */
  teardownLiveInstance(surfaceKey: string): Promise<void>;
  /**
   * 锚点重占（dispose_and_replace）：创建无数据能力的新租约实例。
   * 后置：返回租约的 sandboxId 必须与被拆实例不同（disposeSandbox 契约「new pages
   * use new credentials and sandboxIds」—— 执行器对复用旧 sandboxId fail-closed 抛错）。
   */
  createReplacementInstance(surfaceKey: string): Promise<PayswapSurfaceLease>;
}

/** deps 绑定选项：见 surfaceRevocationWiring.ts（teardownTimeoutMs 缺省上游拆除窗）。 */
export interface PayswapSurfaceRevocationWiringOptions {
  target: PayswapUiSurfaceTeardownTarget;
  teardownTimeoutMs?: number;
  setTimer?: (callback: () => void, ms: number) => () => void;
  notifyBestEffortRevocation?: (surfaceKey: string) => void;
}

export interface PayswapSurfaceRevocationWiringContract {
  /** 字节等价的自有键建造（D12.7 复验欠条的闭合点）。 */
  buildPayswapOwnSurfaceKey: PayswapOwnSurfaceKeyBuilder;
  /** 租约提取（token 不入册）。 */
  leaseFromPluginSandboxHandle: PayswapLeaseExtractor;
  /**
   * 实例入册便捷面：真实 builder 键 + 提取租约 + 锚点策略。
   * 前置：handle 是官方插件的 live 沙箱句柄；registry 是 host 侧注册表。
   * 后置：同键新租约 = 替换入册（标记从未收到数据开始）。
   */
  registerPayswapSurfaceInstance(input: {
    registry: PayswapSurfaceContentRegistry;
    target: PayswapOwnSurfaceTarget;
    scope: PluginUiScopeRef;
    handle: PluginSandboxHandle;
    anchor: PayswapSurfaceAnchorPolicy;
  }): void;
  /**
   * 把 §2.3 撤销执行器的 deps 绑定到真实原语（teardown → 装配侧目标；两 store 的
   * 逐键清除 → @zcode/ui 真实 API；守护窗 = teardownTimeoutMs + 100 —— 与
   * runPluginUiHostTeardown 的内窗同源同式）。
   */
  bindPayswapSurfaceRevocationDeps(options: PayswapSurfaceRevocationWiringOptions): PayswapSurfaceRevocationDeps;
}
