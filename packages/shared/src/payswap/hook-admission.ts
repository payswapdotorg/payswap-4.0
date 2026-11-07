/**
 * PaySwap 金融模式 hook 准入法则（addendum §5.1 Gate E1 —— 逐插件 hook 准入；
 * playbook P1.8「hook admission」工作包）。
 *
 * 法则（normative，addendum §5.1 原文决策表）：
 * - **金融模式关（默认）**：与上游完全一致 —— 所有插件 hook 照跑，零 ZCode 回归
 *   （§5.1：「Financial mode off (default): behavior identical to upstream — all
 *   plugin hooks run. Zero ZCode regression.」）。S0a/S0b/S1 全部落在此臂 —— 门只在
 *   S2（激活的 financial workspace）合上。
 * - **金融模式开**（S2）：仅 builtin/official 插件（source === "official"）与显式
 *   用户信任白名单 `plugins.financialHookTrust` 上的插件可跑 hook；其它三方插件
 *   （inline/cache）的 hook 不注册执行 —— fail-closed，无兜底放行。
 * - **升级路径**：adapters 源注释命名的判断收回点（plugins/index.ts
 *   canRunPluginHooks：「需要逐插件 trust（如 user config 白名单）时，把判断收回
 *   这里」）—— 本模块是该判断的单一实现，adapters 只接线；法则级测试与本套件
 *   （bootstrap/tests/payswap-hook-admission.test.ts）共用同一份代码。
 * - **白名单语义**：`<name>@<marketplace>` 权威 id 精确匹配（includes 全等），
 *   无通配、无前缀、无跨市场匹配 —— 同 bare name 不同市场 = 不同插件。
 * - **金融模式投影（单一实现）**：S2 判定 = 官方插件启用 && userConfig
 *   `financialWorkspace === true`（严格 boolean）。`readPayswapFinancialModeFromConfig`
 *   是 pair 投影（pluginEnabled / financialWorkspace 分列 —— 三码法则 §7.3 需要
 *   区分 S1/S2），spawn-wiring 的 broker live reader（readPayswapLiveStateFromConfig）
 *   自 P1.8 起委托本实现 —— hook 门与 broker 的「金融模式」永不漂移。
 * - **范围（hook-only）**：只判 hook 准入，不判插件生命周期 —— 被拒插件的
 *   skills/commands/MCP servers 照常解析（T4/T5 的上游启用/禁用语义不受影响）。
 *   货币路径的新鲜度由 broker 的 per-request live 读独立保证（契约 w2-01 §7.3），
 *   本门是 hook 面（第三方代码坐在金融工具调用流上）的纵深防御。
 * - **判定时机**：插件解析期（发现边界 —— canRunPluginHooks 的调用点），随上游
 *   的 per-session 解析快照语义（与 T4 冻结工具面同款纪律）：会话开始时的快照
 *   决定该会话的 hook 集；config 变更后的新解析按新状态判定。
 */

import { PAYSWAP_OFFICIAL_PLUGIN_ID } from "./broker-env.js";

/**
 * 插件来源（adapters `PluginSource` 的结构等价联合）。本模块不依赖
 * `@zcode/contracts`（依赖方向：zcode-cli 侧包取用本模块，反向不成立）；
 * 只有 `"official"` 是受信来源 —— 任何其它（含未来新增的）来源值都只走白名单。
 */
export type PayswapHookPluginSource = "official" | "inline" | "cache";

/** Gate E1 准入判定的输入（adapters canRunPluginHooks 组装）。 */
export interface PayswapPluginHookAdmissionInput {
  /** 插件权威 id（`<name>@<marketplace>`）。 */
  pluginId: string;
  /** 插件来源（loaded.source）。 */
  source: PayswapHookPluginSource;
  /** 金融模式 live 状态（isPayswapFinancialModeActive 的输出 —— S2 投影）。 */
  financialModeActive: boolean;
  /** 用户显式信任白名单（config.plugins.financialHookTrust；缺省 = 空集）。 */
  trustedPluginIds: readonly string[];
}

/**
 * Gate E1 准入判定（§5.1 决策表）：
 * 金融模式关 → 恒 true（上游行为不变）；开 → official 或白名单精确 id，否则 false。
 */
export function isPayswapPluginHookAdmitted(input: PayswapPluginHookAdmissionInput): boolean {
  if (!input.financialModeActive) {
    return true; // §5.1 臂 1：金融模式关 = 与上游一致（零回归）。
  }
  if (input.source === "official") {
    return true; // §5.1 臂 2a：builtin/official 插件。
  }
  return input.trustedPluginIds.includes(input.pluginId); // §5.1 臂 2b：显式白名单（精确 id）。
}

/** 合并 config 的 plugins 段形状（enabled map + options —— 与 PluginConfig 结构兼容）。 */
export interface PayswapFinancialModeConfigShape {
  enabledPlugins?: Record<string, boolean>;
  options?: Record<string, Record<string, unknown>>;
}

/**
 * 金融模式 pair 投影（单一实现）：官方插件启用位 + financialWorkspace opt-in 位
 * 分列（broker 三码法则需要区分 S1/S2；hook 门只消费其 AND）。其它插件的配置
 * 永不串扰（只读 PAYSWAP_OFFICIAL_PLUGIN_ID 两键）。
 */
export function readPayswapFinancialModeFromConfig(plugins: PayswapFinancialModeConfigShape): {
  pluginEnabled: boolean;
  financialWorkspace: boolean;
} {
  return {
    pluginEnabled: plugins.enabledPlugins?.[PAYSWAP_OFFICIAL_PLUGIN_ID] ?? false,
    financialWorkspace: plugins.options?.[PAYSWAP_OFFICIAL_PLUGIN_ID]?.financialWorkspace === true,
  };
}

/**
 * 金融模式是否激活（S2）：启用 && opt-in（严格 boolean true）。hook 准入门的
 * 激活信号；与 broker live reader 同一投影（见 readPayswapFinancialModeFromConfig）。
 */
export function isPayswapFinancialModeActive(plugins: PayswapFinancialModeConfigShape): boolean {
  const state = readPayswapFinancialModeFromConfig(plugins);
  return state.pluginEnabled && state.financialWorkspace;
}
