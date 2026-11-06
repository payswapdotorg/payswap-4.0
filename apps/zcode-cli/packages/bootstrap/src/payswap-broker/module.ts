/**
 * payswap-broker 模块清单（architecture-governance managed 模块）。
 * 层：app（UDS listener、子进程派生读取 ss、procfs IO —— domain 层禁 IO）。
 * 修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const payswapBrokerModule = {
  id: "payswap-broker",
  requires: ["shared-payswap"],
  provides: ["payswap-broker"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
