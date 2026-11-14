/**
 * `desktop-payswap` —— PaySwap 桌面 main 进程 payswap 装配（managed 模块；
 * ADR-12 D12.7 批准通道 + ADR-15 D15.4 broker-peer helper 供给）。公开面见
 * contract.ts；实现见 approvalIpc.ts / financialModeReader.ts / cardPush.ts /
 * desktopPayswapBootstrap.ts / brokerPeerHelperSupply.ts。
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
export {
  PAYSWAP_BROKER_PEER_HELPER_RESOURCE_DIR,
  resolvePayswapBrokerPeerHelperSupply,
} from "./brokerPeerHelperSupply.js";
export type { ResolvePayswapBrokerPeerHelperSupplyOptions } from "./brokerPeerHelperSupply.js";
