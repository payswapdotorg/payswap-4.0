/**
 * ui-payswap 模块清单（architecture-governance managed 模块；ADR-12 D12.7 + ADR-P2-2）。
 * 层：app（renderer 内存 store 的逐键清除与 controller 拆除目标桥接 —— IO 边界在
 * 装配方；法则层不持 IO）+ P2.2 连接 UI（设置页 payswap 分区的呈现面 —— 呈现法则
 * 住本模块 connectionUiPresentation.ts，通道法则住 shared-payswap/desktop main）。
 * 修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const uiPayswapModule = {
  id: "ui-payswap",
  // shared-payswap：§2.3 撤销法则（注册表/计划/执行器 + deps 端口类型）+
  // P2.2 连接 RPC 的响应/请求类型（type-only —— 渲染层不引桶内 node 模块）；
  // mcp-apps-protocol：MCP_APPS_TEARDOWN_TIMEOUT_MS 窗口同源 + PluginSandboxHandle 类型；
  // plugin-ui：两 store 的真实逐键清除 API 与 buildPluginUiSurfaceKey 键建造。
  // + ui：D12.7 卡组件与 P2.2 连接分区的 button/hooks/i18n/settings 内部面。
  requires: ["mcp-apps-protocol", "plugin-ui", "shared-payswap", "ui"],
  provides: ["ui-payswap"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
