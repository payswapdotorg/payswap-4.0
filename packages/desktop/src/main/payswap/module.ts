/**
 * desktop-payswap 模块清单（architecture-governance managed 模块；ADR-12 D12.7）。
 * 层：app（Electron main 的 IPC 装配 —— IO 边界全注入；法则/映射/host 住
 * shared-payswap）。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验
 * 两者一致）。
 */
export const desktopPayswapModule = {
  id: "desktop-payswap",
  // shared-payswap：桌面批准 host + 真实 IPC 映射法则 + 通道常量。
  requires: ["shared-payswap"],
  provides: ["desktop-payswap"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
