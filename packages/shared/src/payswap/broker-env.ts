/**
 * PaySwap 五键凭据组（契约 w2-01 §4.2(3)、§4.3、§4.4；ADR-1）。
 *
 * 纪律（§4.2(4)，normative）：五个 `PAYSWAP_BROKER_*` 值只经受信 config-injection 路径
 * （mcp-config.ts 的 reference-identity 门）到达官方 PaySwap MCP 子进程；不得出现在任何
 * settings schema、manifest `mcpServers.*.env` 或 `${user_config.*}` 替换里。
 *
 * 纪律（§4.4(1) rev 2a，all-or-nothing）：五键凭据组同批出现且逐键形状合法才构成有效快照；
 * 任何一个键在而组不完整 → 清空快照、fail-closed（CUA `:171-174` 半组纪律的五键推广）。
 */

// ---------------------------------------------------------------------------
// env keys（§4.2(3) rev 2：三元组扩为五键，后两键承载 §6.5 的响应认证材料）
// ---------------------------------------------------------------------------

export const PAYSWAP_BROKER_SOCKET_ENV_KEY = "PAYSWAP_BROKER_SOCKET";
export const PAYSWAP_BROKER_TOKEN_ENV_KEY = "PAYSWAP_BROKER_TOKEN";
export const PAYSWAP_BROKER_INSTANCE_ID_ENV_KEY = "PAYSWAP_BROKER_INSTANCE_ID";
export const PAYSWAP_BROKER_HOST_ID_ENV_KEY = "PAYSWAP_BROKER_HOST_ID";
export const PAYSWAP_BROKER_VERIFY_KEY_ENV_KEY = "PAYSWAP_BROKER_VERIFY_KEY";

/** 五键全表（§4.3(1)：五个键整体加入 strip list 与 tool-env-passthrough blocklist）。 */
export const PAYSWAP_BROKER_ENV_KEYS = [
  PAYSWAP_BROKER_SOCKET_ENV_KEY,
  PAYSWAP_BROKER_TOKEN_ENV_KEY,
  PAYSWAP_BROKER_INSTANCE_ID_ENV_KEY,
  PAYSWAP_BROKER_HOST_ID_ENV_KEY,
  PAYSWAP_BROKER_VERIFY_KEY_ENV_KEY,
] as const;
export type PayswapBrokerEnvKey = (typeof PAYSWAP_BROKER_ENV_KEYS)[number];

/**
 * 宿主侧 helper 供给键（ADR-13 D13.9，macOS §5.1 臂）：`PAYSWAP_BROKER_HELPER_PATH` /
 * `PAYSWAP_BROKER_HELPER_SHA256` 是 **host-only** 的运维/CI 供给面（peer-verification
 * native helper 二进制位置 + 期望 SHA-256），绝不属于五键凭据组，也绝不经受信注入进入任何
 * 子进程 env —— 与五键同款双表剔除（runtimeEnv strip list + tool-env-passthrough
 * blocklist），交付面恰好一个进程（host 自己）。
 */
export const PAYSWAP_BROKER_HELPER_PATH_ENV_KEY = "PAYSWAP_BROKER_HELPER_PATH";
export const PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY = "PAYSWAP_BROKER_HELPER_SHA256";

/**
 * 官方 PaySwap 插件的注册身份（`payswap@zcode-plugins-official`）。
 * 单一事实源遵循 CUA 先例 `ZCODE_CUA_OFFICIAL_PLUGIN_ID`
 * （packages/shared/src/mcp.ts，硬编码、不派生 —— shared 不依赖 contracts）。
 */
export const PAYSWAP_OFFICIAL_PLUGIN_ID = "payswap@zcode-plugins-official";

// ---------------------------------------------------------------------------
// 凭据组类型（§4.1：token = 256-bit hex，instance id = UUID v4；§6.5(1)：host id =
// per-boot UUID v4，verify key = RFC 8032 Ed25519 公钥 base64）
// ---------------------------------------------------------------------------

export interface PayswapBrokerCredentialTuple {
  /** per-boot endpoint 路径（POSIX socket path / Windows pipe 名，§3.1/§3.2）。 */
  socket: string;
  /** per-instance 256-bit hex token（§4.1(1)）。 */
  token: string;
  /** per-instance UUID v4（§4.1(1)）。 */
  instanceId: string;
  /** host-boot UUID v4 —— 响应签名钥的作用域（§6.5(1)）。 */
  hostId: string;
  /** host-boot Ed25519 公钥，base64（RFC 8032 raw 32 字节）。 */
  verifyKeyBase64: string;
}

// ---------------------------------------------------------------------------
// 逐键形状校验器（capture-before-sanitization 与受信注入共用；§4.4(1) shape 校验）
// ---------------------------------------------------------------------------

/** 256-bit hex token：恰好 64 个小写十六进制字符（§4.1(1) 的 `randomBytes(32).toString("hex")`）。 */
const PAYSWAP_BROKER_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * UUID v4（版本与变体位都校验）。契约 §4.1(1) 规定 instance id 是 fresh UUID v4；
 * §6.5(1) 规定 host-boot id 是 fresh UUID per boot —— nil UUID（全零）两者都不是。
 */
const PAYSWAP_UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidPayswapBrokerSocket(value: string): boolean {
  // socket 路径只做非空形状校验；路径的不可预测性由 mintBrokerBootState 保证（§3.4）。
  return value.trim().length > 0;
}

export function isValidPayswapBrokerToken(value: string): boolean {
  return PAYSWAP_BROKER_TOKEN_PATTERN.test(value);
}

export function isValidPayswapBrokerInstanceId(value: string): boolean {
  return PAYSWAP_UUID_V4_PATTERN.test(value);
}

export function isValidPayswapBrokerHostId(value: string): boolean {
  return PAYSWAP_UUID_V4_PATTERN.test(value);
}

export function isValidPayswapBrokerVerifyKeyBase64(value: string): boolean {
  // 形状校验：canonical base64 且解码恰为 32 字节（Ed25519 raw 公钥长度，RFC 8032）。
  // 不做密码学点校验 —— 捕获侧只需要形状；真正的密码学校验在 parsePublicKeyBase64。
  const trimmed = value.trim();
  const decoded = Buffer.from(trimmed, "base64");
  return decoded.length === 32 && decoded.toString("base64") === trimmed;
}

/** 五键凭据组的逐键形状门（fail-closed：任何一键不合法 → 整组无效）。 */
export function isValidPayswapBrokerCredentialTuple(
  tuple: object,
): tuple is PayswapBrokerCredentialTuple {
  const candidate = tuple as Partial<PayswapBrokerCredentialTuple>;
  return (
    typeof candidate.socket === "string" &&
    typeof candidate.token === "string" &&
    typeof candidate.instanceId === "string" &&
    typeof candidate.hostId === "string" &&
    typeof candidate.verifyKeyBase64 === "string" &&
    isValidPayswapBrokerSocket(candidate.socket) &&
    isValidPayswapBrokerToken(candidate.token) &&
    isValidPayswapBrokerInstanceId(candidate.instanceId) &&
    isValidPayswapBrokerHostId(candidate.hostId) &&
    isValidPayswapBrokerVerifyKeyBase64(candidate.verifyKeyBase64)
  );
}

/**
 * 从 env 记录读取五键凭据组（纯函数，无进程内状态）：
 * - 五键全部出现且逐键形状合法 → 返回 tuple（值已 trim，CUA 捕获纪律）；
 * - 一个键都没出现 → null（与本轮 capture 无关）；
 * - 部分出现 / 形状不合法 → null（§4.4(1)：半组凭据永不启动，all-or-nothing）。
 */
export function readPayswapBrokerCredentialTupleFromEnv(
  env: Record<string, string | undefined>,
): PayswapBrokerCredentialTuple | null {
  const socket = env[PAYSWAP_BROKER_SOCKET_ENV_KEY]?.trim();
  const token = env[PAYSWAP_BROKER_TOKEN_ENV_KEY]?.trim();
  const instanceId = env[PAYSWAP_BROKER_INSTANCE_ID_ENV_KEY]?.trim();
  const hostId = env[PAYSWAP_BROKER_HOST_ID_ENV_KEY]?.trim();
  const verifyKeyBase64 = env[PAYSWAP_BROKER_VERIFY_KEY_ENV_KEY]?.trim();

  const anyKeyPresent = [socket, token, instanceId, hostId, verifyKeyBase64].some(
    (value) => value !== undefined && value !== "",
  );
  if (!anyKeyPresent) return null;
  if (
    socket === undefined ||
    token === undefined ||
    instanceId === undefined ||
    hostId === undefined ||
    verifyKeyBase64 === undefined
  ) {
    return null;
  }
  const tuple: PayswapBrokerCredentialTuple = {
    socket,
    token,
    instanceId,
    hostId,
    verifyKeyBase64,
  };
  return isValidPayswapBrokerCredentialTuple(tuple) ? tuple : null;
}

/** 五键凭据组是否在 env 中"部分出现"（任一键非空出现）。capture 侧据此判定清空时机。 */
export function hasAnyPayswapBrokerEnvKey(env: Record<string, string | undefined>): boolean {
  return PAYSWAP_BROKER_ENV_KEYS.some((key) => {
    const value = env[key];
    return value !== undefined && value.trim() !== "";
  });
}
