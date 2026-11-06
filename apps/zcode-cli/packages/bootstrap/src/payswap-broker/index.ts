/**
 * `payswap-broker`（bootstrap 侧）—— PaySwap broker 引导与 UDS 宿主（P1.3 Step 3；
 * 契约 w2-01 §3、§5、§10、§11）。
 *
 * 公共面：`bootPayswapBroker`（自探针 → peer_verified | degraded_refusing → 端点绑定）、
 * 对等凭据 reader 家族（linux ss+procfs / unavailable / 平台默认）、handle（注册表接线 +
 * spawn 表注册 + close）。host 侧专用 —— payswap-plugin（child 侧）不经此模块，child 只经
 * `@zcode/shared/payswap` 的 `verifyResponseEnvelope` 验签（§6.4(5) 单一实现）。
 */

export {
  bootPayswapBroker,
  type PayswapBrokerBootOptions,
  type PayswapBrokerProbeResult,
} from "./boot.js";
export {
  createDefaultPeerCredentialReader,
  createLinuxPeerCredentialReader,
  createUnavailablePeerCredentialReader,
  type PeerCredentialRead,
  type PeerCredentialReader,
} from "./peer-credentials.js";
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
