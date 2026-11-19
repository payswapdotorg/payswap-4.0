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
  installDesktopPayswapConnections,
  type InstallDesktopPayswapConnectionsOptions,
  type PayswapDesktopConnectionsInstallation,
} from "./desktopPayswapBootstrap.js";
export {
  PAYSWAP_BROKER_PEER_HELPER_RESOURCE_DIR,
  resolvePayswapBrokerPeerHelperSupply,
} from "./brokerPeerHelperSupply.js";
export type { ResolvePayswapBrokerPeerHelperSupplyOptions } from "./brokerPeerHelperSupply.js";
export {
  createPayswapPspKeyStore,
  PAYSWAP_PSP_KEY_STORE_FILE_NAME,
  type PayswapPspKeyStore,
  type PayswapPspKeyStoreDependencies,
  type PayswapPspSafeStoragePort,
} from "./pspCredentialKeyStore.js";
export {
  PAYSWAP_PSP_SECURE_LINUX_STORAGE_BACKENDS,
  isSecurePayswapPspStorageBackendSelection,
} from "./pspSafeStorageBackendPolicy.js";
export {
  buildPayswapPspHostEnv,
  PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY,
} from "@zcode/shared/payswap";
export {
  warmupPayswapPspRuntimeEnv,
  type PayswapPspWarmupOptions,
  type PayswapPspWarmupResult,
} from "./accountWarmup.js";
export {
  installPayswapDesktopConnectionIpc,
  PAYSWAP_DESKTOP_CONNECTION_IPC_CHANNEL,
  type PayswapDesktopConnectionIpcOptions,
  type PayswapDesktopConnectionIpcRegistration,
} from "./accountConnectionIpc.js";
export {
  createPayswapDesktopAccountRuntime,
  type PayswapDesktopAccountRuntime,
  type PayswapDesktopAccountRuntimeOptions,
} from "./accountRuntimeWiring.js";
// P2.2 slice 9（ADR-P2-2 Addendum B）：reader 桥端口铸造（spawn 转移的 main 侧半）。
export {
  adaptMessagePortMainToPayswapReaderBridgePort,
  createPayswapReaderBridgePortMinter,
  type PayswapReaderBridgeChannelPair,
  type PayswapReaderBridgeMessagePortFace,
  type PayswapReaderBridgeServePortFace,
} from "./accountReaderBridgeEntry.js";
// 回归保护：铸造器必须经本构造进入 SpawnHostProcessOptions（第 5 参）—— 2026-11-18
// 参数位错置缺陷的防复发面（electron-free，可被 main 单测直接覆盖）。
export { buildPayswapReaderBridgeSpawnOptions } from "./readerBridgeSpawnOptions.js";
