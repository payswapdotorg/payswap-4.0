/**
 * `desktop-payswap` —— PaySwap 桌面批准通道的 Electron main 装配（managed 模块；
 * ADR-12 D12.7）。公开面见 contract.ts；实现见 approvalIpc.ts /
 * financialModeReader.ts / cardPush.ts / desktopPayswapBootstrap.ts。
 */

export {
  installPayswapDesktopApprovalIpc,
  PAYSWAP_DESKTOP_APPROVAL_IPC_CHANNEL,
} from "./approvalIpc.js";
export type {
  PayswapDesktopApprovalIpcOptions,
  PayswapDesktopApprovalIpcRegistration,
} from "./approvalIpc.js";
export {
  createDesktopPayswapFinancialModeReader,
  type DesktopPayswapFinancialModeEnv,
} from "./financialModeReader.js";
export {
  withPayswapCardPush,
  PAYSWAP_DESKTOP_CARD_CHANNEL,
  type PayswapCardPushPort,
} from "./cardPush.js";
export {
  installDesktopPayswapApproval,
  type InstallDesktopPayswapApprovalOptions,
  type PayswapDesktopApprovalE2EBridge,
} from "./desktopPayswapBootstrap.js";
