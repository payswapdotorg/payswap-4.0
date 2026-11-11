/**
 * `payswap-broker`（bootstrap 侧）—— PaySwap broker 引导与 UDS 宿主（P1.3 Step 3 +
 * P1.4 Step 4 + P1.5 Step 5；契约 w2-01 §3、§5、§7、§8、§10、§11）。
 *
 * 公共面：`bootPayswapBroker`（自探针 → peer_verified | degraded_refusing → 端点绑定）、
 * 对等凭据 reader 家族（linux ss+procfs / unavailable / 平台默认）、handle（注册表接线 +
 * spawn 表注册 + close）、闭集 dispatch（§7 六操作 + §7.3 三码法则）、§8 会话解析与
 * 工作区隔离的端口与法则（session-scope.ts：resolver 类型 + 判定 + app 面单会话工厂）、
 * 宿主接线协调器（spawn-wiring.ts：lazy boot / 受信五键注入 / 进程观察 / disable 撤销 /
 * bindSessionScopeResolver 延迟绑定）。
 * host 侧专用 —— payswap-plugin（child 侧）不经此模块，child 只经
 * `@zcode/shared/payswap` 的 `verifyResponseEnvelope` 验签（§6.4(5) 单一实现）。
 */

export {
  bootPayswapBroker,
  type PayswapBrokerBootOptions,
  type PayswapBrokerProbeResult,
} from "./boot.js";
export {
  createPayswapBrokerDispatch,
  type PayswapBrokerDispatch,
  type PayswapBrokerDispatchOptions,
  type PayswapBrokerLiveState,
  type PayswapDispatchRequest,
  type PayswapDispatchResult,
  type PayswapInstanceBinding,
  type PayswapLiveStateReader,
} from "./dispatch.js";
export {
  createPayswapBrokerCoordinator,
  createSingleSessionScopeResolver,
  readPayswapLiveStateFromConfig,
  type PayswapBrokerCoordinator,
  type PayswapBrokerCoordinatorOptions,
  type PayswapBrokerProcessObserver,
} from "./spawn-wiring.js";
export {
  isSessionWithinBindingScope,
  type PayswapEntityWorkspaceResolver,
  type PayswapResolvedSessionScope,
  type PayswapSessionScopeResolver,
} from "./session-scope.js";
export {
  createDefaultPeerCredentialReader,
  createLinuxPeerCredentialReader,
  createUnavailablePeerCredentialReader,
  type PeerCredentialRead,
  type PeerCredentialReader,
} from "./peer-credentials.js";
export {
  resolveDefaultPeerRelayHelper,
  startPayswapPeerRelay,
  type PayswapBrokerRelayTransport,
  type PayswapPeerRelayHelperConfig,
  type PayswapPeerRelayStartResult,
} from "./peer-relay.js";
// ADR-14：win32 §5.3 臂的 starter（C# helper + 命名管道缝；token/控制行走 stdin、
// spawn 表推送、uid 由 DACL 承担）—— 与 darwin 臂同一传输面（PayswapBrokerRelayTransport）。
export { startPayswapWindowsPeerRelay } from "./peer-relay-windows.js";
// ADR-13 D13.9：helper 供给键（host-only）随 relay 面透传再导出 —— 测试与运维共用单一事实源。
export {
  PAYSWAP_BROKER_HELPER_PATH_ENV_KEY,
  PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY,
} from "@zcode/shared/payswap";
export {
  PAYSWAP_RELAY_HEADER_MAX_BYTES,
  PAYSWAP_RELAY_PROTOCOL_VERSION,
  parseRelayHeaderLine,
  serializeRelayHeaderLine,
} from "./peer-relay-protocol.js";
export {
  createPayswapBrokerServer,
  PAYSWAP_BROKER_DEFAULT_CLOSE_GRACE_MS,
  PAYSWAP_BROKER_DEFAULT_IDLE_TIMEOUT_MS,
  type PayswapBrokerAuditEvent,
  type PayswapBrokerHandle,
  type PayswapBrokerMode,
  type PayswapBrokerServer,
  type PayswapBrokerServerOptions,
} from "./server.js";
