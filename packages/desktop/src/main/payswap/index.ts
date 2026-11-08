/**
 * `desktop-payswap` —— PaySwap 桌面批准通道的 Electron main 装配（managed 模块；
 * ADR-12 D12.7）。公开面见 contract.ts；实现见 approvalIpc.ts。
 */

export {
  installPayswapDesktopApprovalIpc,
  PAYSWAP_DESKTOP_APPROVAL_IPC_CHANNEL,
} from "./approvalIpc.js";
export type {
  PayswapDesktopApprovalIpcOptions,
  PayswapDesktopApprovalIpcRegistration,
} from "./approvalIpc.js";
