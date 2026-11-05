/**
 * payswap-plugin 标准用法示例：官方定义（bootstrap 的 OfficialPluginDefinition）与
 * 构建产物对齐时插件契约长什么样。
 */
import {
  PAYSWAP_PLUGIN_OUTPUTS,
  PAYSWAP_SURFACE_IDS,
  PAYSWAP_TOOL_NAMES,
  type PayswapPluginContract,
} from "./contract.ts";

export function exampleOfficialPayswapPlugin(): PayswapPluginContract {
  return {
    outputs: PAYSWAP_PLUGIN_OUTPUTS,
    tools: PAYSWAP_TOOL_NAMES,
    surfaces: PAYSWAP_SURFACE_IDS,
    optInOption: "financialWorkspace",
  };
}
