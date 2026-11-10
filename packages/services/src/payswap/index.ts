/**
 * `services-payswap` —— PaySwap 账户服务的 services 侧公共入口（P2.2，
 * deliverable 06 §2.2；deliverable 05 §5 认证面的 host-service 半）。
 *
 * 公共面（architecture-governance managed 模块的 publicEntrypoint 桶）：
 * - 账户服务工厂 `createPayswapAccountService`（connect/revoke/listConnections 的
 *   单一写者；秘密只落 ICredentialService 的 payswap:psp:* 键）。
 * - 连接记录 store 工厂 `createPayswapConnectionRecordStore`（非秘密元数据 JSON
 *   store：0600 原子写 + 跨进程文件锁 + corrupt-refuse-overwrite）。
 *
 * 法则（schema/模板/投影/authSpec/typed refusal）住 `@zcode/shared/payswap` 的
 * account-connection.ts —— 本模块与 law 级测试共用同一份实现，永不漂移。
 * host 侧装配（additive RPC channel、平台壳连接 UI、desktop 入口接线）随 P2.2
 * 后续切片（D12.7 纪律：法则与模块先行，入口接线随活的窗口证明）。
 */

export {
  createPayswapAccountService,
  type PayswapAccountCredentialPort,
  type PayswapAccountService,
  type PayswapAccountServiceDependencies,
} from "./accounts/accountService.js";
export {
  createPayswapConnectionRecordStore,
  createPayswapConnectionsStoreCorruptError,
  isPayswapConnectionsStoreCorruptError,
  PAYSWAP_CONNECTIONS_STORE_CORRUPT_CODE,
  PAYSWAP_CONNECTIONS_STORE_FILE_NAME,
  type PayswapConnectionRecordStore,
  type PayswapConnectionRecordStoreDependencies,
} from "./accounts/connectionRecordStore.js";
