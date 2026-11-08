/**
 * PaySwap 表面内容注册表与 opt-out 撤销法则（addendum §2.3 item 1 臂 (b) + item 3；
 * playbook P1.8「Surface lifecycle」—— T7 的 host 侧撤销权威）。
 *
 * 法则（normative，addendum §2.3 原文）：
 * - **注册表**：「every Class-A surface *instance* it renders is tracked by its
 *   captured sandbox lease (`sandboxId`/`initId` + the plugin `appIdentity` lease
 *   triple) together with a has-ever-received-protected-data mark」—— 撤销权威在
 *   host、永不在插件/surface，「no guarantee depends on the surface's cooperation」。
 *   无可见性维度：背景/隐藏实例与前台实例同待遇（「a background page is a live
 *   page … it is in the registry like any other」）。同键换租约 = 替换入册（新租约
 *   从未标记开始 —— 旧租约的标记不转移）。
 * - **注册面 fail-closed（恰自有键）**：只有结构上属于官方插件
 *   （buildPluginUiSurfaceKey 同构键的 pluginId 位 === PAYSWAP_OFFICIAL_PLUGIN_ID）
 *   的键可入册 —— 外来插件的键/畸形键抛错、注册表不持有外来实例（「clears
 *   exactly its own surface keys (its pluginId/server), touching no other plugin's
 *   entries」；§2.3 item 5 的能力受限纪律：拆除只针对 host 自己创建并追踪的实例）。
 *   键形与 @zcode/ui 的 buildPluginUiSurfaceKey 同构（[sessionKey, pluginId,
 *   serverName, resourceUri, scopeId] 的 JSON 数组；该 builder 在 ui 包，本模块按
 *   依赖方向不可达 —— 结构等价解析，字节等价由 D12.7 接线复验）。
 * - **撤销计划**（planOptOutRevocation）：标记实例 → dispose（有界拆除）；标记 +
 *   锚点占位（金融工作区面板，anchor === "replace"）→ dispose_and_replace（dispose
 *   后以无数据能力的新租约实例重占，渲染 S1 禁用态）；未标记实例 → best_effort_event
 *   （不强制拆除 —— §2.3 item 5：「no security property depends on it」）；已关闭
 *   （retired）实例无拆除动作，但其键仍在清除集（feed 快照跨关闭存留 —— 「reopening
 *   a PaySwap surface starts from empty」）。清除集 = 全部自有键（注册序，含已关闭）。
 * - **执行器**（runPayswapSurfaceOptOutRevocation）：串行（首注册序）、每实例有界
 *   守护窗（`teardownGuardMs` 必填 —— 有界性法则永远点名自己的窗；D12.7 接线以上游
 *   拆除纪律的窗口值供给（MCP_APPS_TEARDOWN_TIMEOUT_MS 同源）—— 页面永不合作
 *   （teardown promise 永不 settle）→ 窗到期推进；teardown 拒绝 → 照常推进（host 侧
 *   错误不中止撤销）。替换租约的 **sandboxId 必须新**（disposeSandbox 契约「new pages
 *   use new credentials and sandboxIds」—— 复用旧 sandboxId = fail-closed 抛错；initId
 *   不是新鲜性信号：上游注册表对每次新登记铸造常量 initId=1，合法新实例的 initId
 *   与旧实例相同）。替换实例重新入册（后续 opt-out 周期对它同样有效）。retention 清除
 *   恰按计划键集、两 store（feed 快照 + widget 状态）都清。
 * - **接线缝（D12.7 桌面卡接线，本模块不依赖 Electron）**：teardownInstance ↔
 *   runPluginUiHostTeardown（有界 ui/resource-teardown 窗 + disposeSandbox）；
 *   clearSurfaceFeed/clearWidgetState ↔ clearPluginUiSurfaceFeed/
 *   clearPluginUiWidgetState（@zcode/ui 的逐键清除 API）。
 */

import { PAYSWAP_OFFICIAL_PLUGIN_ID } from "./broker-env.js";

// ---------------------------------------------------------------------------
// 租约与注册
// ---------------------------------------------------------------------------

/**
 * 捕获的沙箱租约：upstream `PluginSandboxHandle` 的 sandboxId/initId + `McpAppInstance`
 * 的 appIdentity 租约三元组（runtimeId/generation/appIdentity）—— 注册表不持有 token
 * （秘密不入注册表；拆除只需 sandboxId/initId）。
 */
export interface PayswapSurfaceLease {
  sandboxId: string;
  initId: number;
  runtimeId: string;
  generation: number;
  appIdentity: string;
}

/** 锚点策略：release = 释放锚位；replace = 释放后以无数据新租约实例重占（金融工作区面板）。 */
export type PayswapSurfaceAnchorPolicy = "release" | "replace";

export interface PayswapSurfaceInstanceRegistration {
  /** renderer 侧隔离键（buildPluginUiSurfaceKey 的结果 —— 本模块按不透明字符串持有）。 */
  surfaceKey: string;
  lease: PayswapSurfaceLease;
  anchor: PayswapSurfaceAnchorPolicy;
}

// ---------------------------------------------------------------------------
// 撤销计划（纯投影）
// ---------------------------------------------------------------------------

export type PayswapSurfaceRevocationActionKind =
  | "dispose"
  | "dispose_and_replace"
  | "best_effort_event";

export interface PayswapSurfaceRevocationAction {
  kind: PayswapSurfaceRevocationActionKind;
  surfaceKey: string;
  lease: PayswapSurfaceLease;
}

export interface PayswapSurfaceRevocationPlan {
  /** live 实例的动作集（首注册序）：标记 → dispose / dispose_and_replace；未标记 → best_effort_event。 */
  actions: readonly PayswapSurfaceRevocationAction[];
  /** renderer 保留清除集（全部自有键 —— 含已关闭实例的键；重开从空开始）。 */
  retentionKeysToClear: readonly string[];
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

interface TrackedInstance {
  surfaceKey: string;
  lease: PayswapSurfaceLease;
  anchor: PayswapSurfaceAnchorPolicy;
  receivedProtectedData: boolean;
}

/**
 * buildPluginUiSurfaceKey 同构键的结构解析（恰自有键纪律的注册面执法）：
 * `[sessionKey, pluginId, serverName, resourceUri, scopeId]` 的 JSON 数组，其中
 * sessionKey 本身是 `[workspace, sessionId]` 的 JSON 数组；pluginId 必须是官方插件。
 * 非法形状 / 外来插件 → null（调用方抛错）。
 */
function parseOwnSurfaceKey(surfaceKey: string): { pluginId: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(surfaceKey);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 5) return null;
  const [sessionKey, pluginId, serverName, resourceUri, scopeId] = parsed as unknown[];
  if (
    typeof sessionKey !== "string" ||
    typeof pluginId !== "string" ||
    typeof serverName !== "string" ||
    typeof resourceUri !== "string" ||
    typeof scopeId !== "string"
  ) {
    return null;
  }
  let sessionParts: unknown;
  try {
    sessionParts = JSON.parse(sessionKey);
  } catch {
    return null;
  }
  if (
    !Array.isArray(sessionParts) ||
    sessionParts.length !== 2 ||
    typeof sessionParts[0] !== "string" ||
    typeof sessionParts[1] !== "string"
  ) {
    return null;
  }
  if (pluginId !== PAYSWAP_OFFICIAL_PLUGIN_ID) return null;
  return { pluginId };
}

export interface PayswapSurfaceContentRegistry {
  /** 实例入册（同键新租约 = 替换入册；新租约的标记从未收到数据开始）。 */
  registerInstance(input: PayswapSurfaceInstanceRegistration): void;
  /** 实例正常关闭（upstream 生命周期）：租约离场、键保留在清除集。 */
  retireInstance(surfaceKey: string): void;
  /** 受保护账户数据已投递到该键的当前 live 实例（has-ever-received 标记）。 */
  markProtectedDataDelivered(surfaceKey: string): void;
  /** opt-out 撤销计划（§2.3 item 1 臂 (b) 的纯投影）。 */
  planOptOutRevocation(): PayswapSurfaceRevocationPlan;
}

export function createPayswapSurfaceContentRegistry(): PayswapSurfaceContentRegistry {
  /** surfaceKey → 当前 live 实例（Map 迭代序 = 首注册序；替换入册不改变键位置）。 */
  const instances = new Map<string, TrackedInstance>();
  /** 自有键全集（首注册序；含已关闭实例 —— feed 快照跨关闭存留）。 */
  const retentionKeys: string[] = [];
  const retentionKeySet = new Set<string>();

  return {
    registerInstance(input) {
      if (parseOwnSurfaceKey(input.surfaceKey) === null) {
        throw new Error(
          `payswap surface registry: refusing a non-own surface key (${input.surfaceKey}) — only the official plugin's keys are tracked`,
        );
      }
      if (!retentionKeySet.has(input.surfaceKey)) {
        retentionKeySet.add(input.surfaceKey);
        retentionKeys.push(input.surfaceKey);
      }
      instances.set(input.surfaceKey, {
        surfaceKey: input.surfaceKey,
        lease: input.lease,
        anchor: input.anchor,
        receivedProtectedData: false,
      });
    },

    retireInstance(surfaceKey) {
      if (!retentionKeySet.has(surfaceKey)) {
        throw new Error(
          `payswap surface registry: retiring an unregistered surface key (${surfaceKey})`,
        );
      }
      instances.delete(surfaceKey);
    },

    markProtectedDataDelivered(surfaceKey) {
      if (!retentionKeySet.has(surfaceKey)) {
        throw new Error(
          `payswap surface registry: marking an unregistered surface key (${surfaceKey})`,
        );
      }
      const instance = instances.get(surfaceKey);
      if (instance) instance.receivedProtectedData = true;
      // 无 live 实例（已关闭）：no-op —— 数据已不可达，键清除已覆盖。
    },

    planOptOutRevocation() {
      const actions: PayswapSurfaceRevocationAction[] = [];
      for (const instance of instances.values()) {
        if (!instance.receivedProtectedData) {
          actions.push({
            kind: "best_effort_event",
            surfaceKey: instance.surfaceKey,
            lease: instance.lease,
          });
        } else if (instance.anchor === "replace") {
          actions.push({
            kind: "dispose_and_replace",
            surfaceKey: instance.surfaceKey,
            lease: instance.lease,
          });
        } else {
          actions.push({ kind: "dispose", surfaceKey: instance.surfaceKey, lease: instance.lease });
        }
      }
      return { actions, retentionKeysToClear: [...retentionKeys] };
    },
  };
}

// ---------------------------------------------------------------------------
// 撤销执行器（串行、每实例有界守护窗、新鲜替换、恰自有键清除）
// ---------------------------------------------------------------------------

export interface PayswapSurfaceRevocationDeps {
  /** 单实例有界拆除（D12.7 接线 runPluginUiHostTeardown：有界窗 → 关桥/端口 → disposeSandbox）。 */
  teardownInstance(input: { surfaceKey: string; lease: PayswapSurfaceLease }): Promise<void>;
  /** 锚点重占：dispose 后创建无数据能力的新租约实例（新 sandboxId；S1 禁用态渲染）。 */
  createReplacementInstance(input: {
    surfaceKey: string;
    previousLease: PayswapSurfaceLease;
  }): Promise<PayswapSurfaceLease>;
  /** renderer feed 快照逐键清除（D12.7 接线 clearPluginUiSurfaceFeed）。 */
  clearSurfaceFeed(surfaceKey: string): void;
  /** renderer widget 状态逐键清除（D12.7 接线 clearPluginUiWidgetState）。 */
  clearWidgetState(surfaceKey: string): void;
  /** 有界窗计时器（上游 runPluginUiHostTeardown 的同款注入式 setTimer 纪律）。 */
  setTimer(callback: () => void, ms: number): () => void;
  /**
   * 每实例守护窗上限（毫秒）—— **必填**：有界性法则永远点名自己的窗，无隐藏缺省；
   * D12.7 接线以上游拆除纪律的窗口值供给（MCP_APPS_TEARDOWN_TIMEOUT_MS 同源）。
   */
  teardownGuardMs: number;
  /** 未标记实例的 best-effort 撤销事件（§2.3 item 5：无安全属性依赖）。 */
  notifyBestEffortRevocation?(surfaceKey: string): void;
}

export interface PayswapSurfaceRevocationReport {
  /** 已拆除（有界窗内或到期推进）的 surfaceKey 集（执行序）。 */
  disposed: readonly string[];
  /** 已以新租约重占锚位的 surfaceKey 集。 */
  replaced: readonly string[];
  /** 已发 best-effort 撤销事件的 surfaceKey 集。 */
  bestEffortNotified: readonly string[];
  /** renderer 保留已清除的键集（计划键序，两 store 都清）。 */
  retentionCleared: readonly string[];
}

/**
 * opt-out 撤销执行（§2.3 item 1 臂 (b) + item 3 的执行纪律）：按计划串行推进 ——
 * 每个标记实例的有界拆除（守护窗到期即推进，不依赖页面合作；teardown 拒绝不中止），
 * dispose_and_replace 在拆除完成后创建并验证新鲜租约（复用旧 sandboxId = fail-closed
 * 抛错）、重新入册；最后按计划键集清除两 store 的 renderer 保留（恰自有键）。
 */
export function runPayswapSurfaceOptOutRevocation(
  registry: PayswapSurfaceContentRegistry,
  deps: PayswapSurfaceRevocationDeps,
): Promise<PayswapSurfaceRevocationReport> {
  const plan = registry.planOptOutRevocation();
  const guardMs = deps.teardownGuardMs;
  const disposed: string[] = [];
  const replaced: string[] = [];
  const bestEffortNotified: string[] = [];

  /** 单实例有界拆除：teardown settle（任意结局）或守护窗到期，先到者推进。 */
  function runBoundedTeardown(input: { surfaceKey: string; lease: PayswapSurfaceLease }): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const cancelTimer = deps.setTimer(finish, guardMs);
      deps.teardownInstance(input).then(
        () => {
          cancelTimer();
          finish();
        },
        () => {
          // host 侧异常不中止撤销（upstream 的 .catch(() => undefined) 同款姿态）。
          cancelTimer();
          finish();
        },
      );
    });
  }

  async function run(): Promise<PayswapSurfaceRevocationReport> {
    for (const action of plan.actions) {
      if (action.kind === "best_effort_event") {
        deps.notifyBestEffortRevocation?.(action.surfaceKey);
        bestEffortNotified.push(action.surfaceKey);
        continue;
      }
      await runBoundedTeardown({ surfaceKey: action.surfaceKey, lease: action.lease });
      disposed.push(action.surfaceKey);
      if (action.kind === "dispose_and_replace") {
        const replacement = await deps.createReplacementInstance({
          surfaceKey: action.surfaceKey,
          previousLease: action.lease,
        });
        // 新鲜性 fail-closed：sandboxId 必须新（disposeSandbox 契约；initId 恒为 1
        // 不是新鲜性信号 —— 见模块头）。复用旧 sandboxId = 新页面可能被旧处置误杀/
        // 旧数据上下文存活，拒绝。
        if (replacement.sandboxId === action.lease.sandboxId) {
          throw new Error(
            `payswap surface revocation: the replacement lease for ${action.surfaceKey} reuses the disposed sandboxId — fresh pages must use a new sandboxId`,
          );
        }
        registry.registerInstance({
          surfaceKey: action.surfaceKey,
          lease: replacement,
          anchor: "replace",
        });
        replaced.push(action.surfaceKey);
      }
    }
    // renderer 保留清除：恰按计划键集、两 store 都清（重开从空开始）。
    for (const surfaceKey of plan.retentionKeysToClear) {
      deps.clearSurfaceFeed(surfaceKey);
      deps.clearWidgetState(surfaceKey);
    }
    return {
      disposed,
      replaced,
      bestEffortNotified,
      retentionCleared: [...plan.retentionKeysToClear],
    };
  }

  return run();
}
