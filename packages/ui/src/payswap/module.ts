/**
 * ui-payswap 模块清单（architecture-governance managed 模块；ADR-12 D12.7）。
 * 层：app（renderer 内存 store 的逐键清除与 controller 拆除目标桥接 —— IO 边界在
 * 装配方；法则层不持 IO）。修改 requires 时同步更新 architecture-policy.yaml（检查器
 * 会校验两者一致）。
 */
export const uiPayswapModule = {
  id: "ui-payswap",
  // shared-payswap：§2.3 撤销法则（注册表/计划/执行器 + deps 端口类型）；
  // mcp-apps-protocol：MCP_APPS_TEARDOWN_TIMEOUT_MS 窗口同源 + PluginSandboxHandle 类型；
  // plugin-ui：两 store 的真实逐键清除 API 与 buildPluginUiSurfaceKey 键建造。
  // + ui：D12.7 卡组件的 button/hooks/i18n 内部面。
  requires: ["mcp-apps-protocol", "plugin-ui", "shared-payswap", "ui"],
  provides: ["ui-payswap"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
