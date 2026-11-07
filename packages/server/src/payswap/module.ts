/**
 * server-payswap 模块清单（architecture-governance managed 模块；ADR-11）。
 * 层：app（文件持久化、HTTP/WS 接线 —— domain 层禁 IO）。
 * 修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const serverPayswapModule = {
  id: "server-payswap",
  // shared：@zcode/shared/node 的 privateFilePersistence（0600 原子落盘纪律）。
  requires: ["shared-payswap", "shared"],
  provides: ["server-payswap"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
