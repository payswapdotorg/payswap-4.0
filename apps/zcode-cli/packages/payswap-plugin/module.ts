/**
 * payswap-plugin 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 * Step 7 起依赖 shared-payswap：子进程侧 bridge transport/验签/分配器经共享协议模块
 * （ADR-9 D9.7 + ADR-10 D10.1；`@zcode/shared/payswap`）。
 */
export const payswapPluginModule = {
  id: "payswap-plugin",
  requires: ["shared-payswap"],
  provides: ["payswap-plugin"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
