/**
 * shared-payswap 模块清单（architecture-governance managed 模块）。
 * 层：app（node:crypto 系统原语；domain 层禁 IO —— 见 architecture-policy.yaml 注）。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const sharedPayswapModule = {
  id: "shared-payswap",
  requires: [],
  provides: ["shared-payswap"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
