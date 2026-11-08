/** Shared sandbox transport/presentation and existing session admission binding. */
export { createPluginUiMessagePortTransport } from "./adapters/messagePortTransport.js";
export { createPluginUiPagePlane } from "./adapters/pluginUiPagePlane.js";
export { readPluginUiStyleVariables } from "./adapters/readPluginUiStyleVariables.js";
export {
  sandboxPages,
  onSandboxPageRemoved,
  type SandboxPageOwner,
} from "./adapters/sandboxPageOwners.js";
export {
  getPluginUiSessionActions,
  registerPluginUiSessionActions,
} from "./adapters/pluginUiSessionActions.js";
// PaySwap D12.7 表面撤销接线的跨模块原语（§2.3 逐键清除 —— 两 store 与
// buildPluginUiSurfaceKey 同一套隔离键；消费方 ui-payswap）。
export { clearPluginUiSurfaceFeed } from "./app/pluginUiSurfaceFeedStore.js";
export { clearPluginUiWidgetState } from "./app/pluginUiWidgetStateStore.js";
