/**
 * server-payswap 模块清单（architecture-governance managed 模块；ADR-11）。
 * 层：app（文件持久化、HTTP/WS 接线 —— domain 层禁 IO）。
 * 修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const serverPayswapModule = {
  id: "server-payswap",
  // shared：@zcode/shared/node 的 privateFilePersistence（0600 原子落盘纪律）；
  // services：ServiceDescriptor（P1.7 批准通道的注册面 —— §1.6.2 item 5c 暴露策略）。
  requires: ["shared-payswap", "shared", "services"],
  provides: ["server-payswap"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
