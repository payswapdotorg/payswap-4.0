/**
 * `desktop-payswap` —— PaySwap 桌面 main 进程 payswap 装配（managed 模块；
 * ADR-12 D12.7 批准通道 + ADR-15 D15.4 broker-peer helper 供给）。公开面见
 * contract.ts；实现见 approvalIpc.ts / brokerPeerHelperSupply.ts。
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
  PAYSWAP_BROKER_PEER_HELPER_RESOURCE_DIR,
  resolvePayswapBrokerPeerHelperSupply,
} from "./brokerPeerHelperSupply.js";
export type { ResolvePayswapBrokerPeerHelperSupplyOptions } from "./brokerPeerHelperSupply.js";
