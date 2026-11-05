import type {
  McpPort,
  McpServerConfig,
  McpServerStatus,
  McpStdioServerConfig,
} from "@zcode/contracts";
import {
  getCapturedZCodeCuaBrokerCredentials,
  isZCodeCuaMcpCommand,
  isZCodeCuaMcpPackageArg,
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
} from "@zcode/shared";
import {
  isValidPayswapBrokerCredentialTuple,
  PAYSWAP_BROKER_HOST_ID_ENV_KEY,
  PAYSWAP_BROKER_INSTANCE_ID_ENV_KEY,
  PAYSWAP_BROKER_SOCKET_ENV_KEY,
  PAYSWAP_BROKER_TOKEN_ENV_KEY,
  PAYSWAP_BROKER_VERIFY_KEY_ENV_KEY,
  PAYSWAP_OFFICIAL_PLUGIN_ID,
  type PayswapBrokerCredentialTuple,
} from "@zcode/shared/payswap";

export { ZCODE_CUA_BROKER_SOCKET_ENV_KEY as ZCODE_CUA_BROKER_SOCKET_ENV } from "@zcode/shared";
// 保留环境变量名供旧诊断脚本读取；迁移后的配置路径不会据此启动独立 CUA MCP。
export const ZCODE_CUA_BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";
// CLI 入口会先清理 broker 凭据；shared node_repl 的可信配置随后从进程内捕获快照恢复它们。
function resolveZCodeCuaBrokerSocket(): string | undefined {
  // captured 优先；运行时残留的 stale socket 不能覆盖可信快照。
  return (
    getCapturedZCodeCuaBrokerCredentials().socket ||
    process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY]?.trim()
  );
}

function resolveZCodeCuaBrokerToken(): string | undefined {
  return undefined;
}

const NODE_REPL_SERVER_NAME = "node_repl";
const REFRESH_MARKER_ENV = "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER";

/**
 * Derive official CUA provenance from the in-memory plugin registry rather than
 * from serializable MCP fields. A user/project override replaces the config
 * object in `configuredServers`, so copied names, commands, and env values do
 * not inherit the bundled plugin's authority.
 */
export function resolveTrustedOfficialCuaServerNames(
  configuredServers: Record<string, McpServerConfig>,
  pluginServers: Record<string, McpServerConfig>,
): Set<string> {
  return new Set(
    Object.entries(pluginServers)
      .filter(
        ([name, config]) =>
          configuredServers[name] === config &&
          config.type === "stdio" &&
          config.env?.[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() ===
            ZCODE_CUA_OFFICIAL_PLUGIN_ID,
      )
      .map(([name]) => name),
  );
}

/**
 * 官方 PaySwap 插件的受信 server 名（契约 w2-01 §4.2(2)，CUA 同款 reference-identity 门）。
 * 权威来自内存中的官方插件注册表而非可序列化的 MCP 字段：`configuredServers[name] ===
 * config` —— 用户/项目 override 会替换 `configuredServers` 里的配置对象，拷贝了 PaySwap
 * 的名字、命令与 env 值的配置不继承凭据（N19 反拷贝门）。凭据只进**这个**官方注册的
 * config 对象，且在 spawn 时（§4.2(1)）；注入在 strip 之后落地（§4.3(2)）。
 */
export function resolveTrustedOfficialPayswapServerNames(
  configuredServers: Record<string, McpServerConfig>,
  pluginServers: Record<string, McpServerConfig>,
): Set<string> {
  return new Set(
    Object.entries(pluginServers)
      .filter(
        ([name, config]) =>
          configuredServers[name] === config &&
          config.type === "stdio" &&
          config.env?.[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() ===
            PAYSWAP_OFFICIAL_PLUGIN_ID,
      )
      .map(([name]) => name),
  );
}

export async function listMcpServerStatuses(
  mcpPort: McpPort | undefined,
  servers: Record<string, McpServerConfig>,
  untrustedServerNames: ReadonlySet<string> = new Set(),
): Promise<Record<string, McpServerStatus>> {
  const liveStatuses = mcpPort ? await mcpPort.status() : {};
  const updatedAt = new Date().toISOString();
  const statuses: Record<string, McpServerStatus> = {};

  for (const [name, config] of Object.entries(servers)) {
    // 迁移后旧的 zcode-cua MCP 只是历史配置，不再进入状态投影；CUA
    // 由 shared node_repl 承载，避免设置页继续把已删除的 server 显示为可用。
    if (isRetiredCuaMcpServer(name, config)) continue;
    const configuredStatus = getConfiguredServerStatus(name, config, untrustedServerNames);
    statuses[name] = liveStatuses[name] ?? {
      status: configuredStatus,
      transport: config.type,
      toolCount: 0,
      updatedAt,
    };
  }

  for (const [name, status] of Object.entries(liveStatuses)) {
    if (!(name in statuses) && !isRetiredCuaMcpServer(name, servers[name])) statuses[name] = status;
  }

  return statuses;
}

export function omitMcpServers(
  servers: Record<string, McpServerConfig>,
  omittedNames: ReadonlySet<string>,
  trustedOfficialCuaServerNames: ReadonlySet<string> = new Set(),
): Record<string, McpServerConfig> {
  const kept = Object.fromEntries(
    Object.entries(servers).filter(
      ([name, config]) => !omittedNames.has(name) && !isRetiredCuaMcpServer(name, config),
    ),
  );

  return injectZCodeCuaBrokerMcpServers(
    kept,
    resolveZCodeCuaBrokerSocket(),
    resolveZCodeCuaBrokerToken(),
    trustedOfficialCuaServerNames,
  );
}

export function injectZCodeCuaBrokerMcpServers(
  servers: Record<string, McpServerConfig>,
  socketPath: string | undefined,
  token: string | undefined = undefined,
  trustedOfficialCuaServerNames: ReadonlySet<string> = new Set(),
): Record<string, McpServerConfig> {
  const normalizedSocketPath = socketPath?.trim();
  const normalizedToken = token?.trim();

  let changed = false;
  const next: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (isRetiredCuaMcpServer(name, config)) {
      changed = true;
      continue;
    }
    if (
      name !== NODE_REPL_SERVER_NAME ||
      !normalizedSocketPath ||
      !trustedOfficialCuaServerNames.has(name)
    ) {
      next[name] = config;
      continue;
    }
    const injected = injectCuaCredentialsIntoNodeRepl(
      config,
      normalizedSocketPath,
      normalizedToken,
    );
    next[name] = injected;
    changed ||= injected !== config;
  }

  return changed ? next : servers;
}

function injectCuaCredentialsIntoNodeRepl(
  config: McpServerConfig,
  socketPath: string,
  token: string | undefined,
): McpServerConfig {
  if (config.type !== "stdio") return config;
  const captured = getCapturedZCodeCuaBrokerCredentials();
  const pluginAuthority = captured.pluginAuthority;
  // CLI runtime env 会在 bootstrap 前被清理。marker 必须和 socket/token 一样取自私有凭据快照，
  // 否则 SDK 迁移后 broker 虽然存活，权限刷新仍会静默停止。
  const refreshMarker = captured.refreshMarker || process.env[REFRESH_MARKER_ENV]?.trim();
  return {
    ...config,
    env: {
      ...config.env,
      [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: socketPath,
      ...(refreshMarker ? { [REFRESH_MARKER_ENV]: refreshMarker } : {}),
      ...(pluginAuthority ? { [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: pluginAuthority } : {}),
      [ZCODE_CUA_NODE_REPL_HOST_ENV_KEY]: "1",
      [ZCODE_PLUGIN_ID_ENV_KEY]: ZCODE_CUA_OFFICIAL_PLUGIN_ID,
    },
  };
}

/**
 * 向官方 PaySwap MCP server 配置注入五键凭据组（契约 w2-01 §4.2，CUA 同款纪律）。
 *
 * - 只注入 `trustedOfficialPayswapServerNames`（reference-identity 门给出）里的 stdio
 *   配置对象；非 stdio / 未受信 / 兄弟配置原样保留（同对象引用返回，N19）。
 * - 无凭据（null/undefined）或形状非法（fail-closed 防御门）→ 原样返回，什么都不注入
 *   —— 凭据只在 spawn 时存在（§4.2(1)）。
 * - 注入只落在 config.env 上；真正的子进程 env 由 sanitize 基座（已剔除五键，§4.3(1)）
 *   之后 spread config.env 构成 —— 受注入的官方子进程拿到全组，其它子进程一个键都
 *   拿不到（§4.3(2) 顺序）。
 */
export function injectPayswapBrokerMcpServers(
  servers: Record<string, McpServerConfig>,
  credentials: PayswapBrokerCredentialTuple | null | undefined,
  trustedOfficialPayswapServerNames: ReadonlySet<string> = new Set(),
): Record<string, McpServerConfig> {
  if (!credentials || !isValidPayswapBrokerCredentialTuple(credentials)) {
    return servers;
  }

  let changed = false;
  const next: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (!trustedOfficialPayswapServerNames.has(name) || config.type !== "stdio") {
      next[name] = config;
      continue;
    }
    next[name] = {
      ...config,
      env: {
        ...config.env,
        [PAYSWAP_BROKER_SOCKET_ENV_KEY]: credentials.socket,
        [PAYSWAP_BROKER_TOKEN_ENV_KEY]: credentials.token,
        [PAYSWAP_BROKER_INSTANCE_ID_ENV_KEY]: credentials.instanceId,
        [PAYSWAP_BROKER_HOST_ID_ENV_KEY]: credentials.hostId,
        [PAYSWAP_BROKER_VERIFY_KEY_ENV_KEY]: credentials.verifyKeyBase64,
      },
    };
    changed = true;
  }

  return changed ? next : servers;
}

function isZCodeCuaStdioServer(
  name: string,
  config: McpServerConfig,
): config is McpStdioServerConfig {
  if (config.type !== "stdio") return false;
  if (name === "computer-use") return true;
  // 内置 official zcode-cua plugin 的 MCP server 走 __zcode-plugin-host，command 是 Helper
  // (非 zcode-cua)、args 是 [zcode.cjs, __zcode-plugin-host, server.js]（非 zcode-cua package arg），
  // 上面的 name/command/args 三条都匹配不到。_plugin id 由 adapters resolver 权威写入 env
  // （manifest/user env 不可覆盖），用它识别 official plugin server。
  if (
    config.env?.[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() === ZCODE_CUA_OFFICIAL_PLUGIN_ID
  ) {
    return true;
  }
  // 判定与 desktop/services 共用 @zcode/shared 的单一事实源，避免两条注入入口漂移。
  if (isZCodeCuaMcpCommand(config.command)) return true;
  return (config.args ?? []).some(isZCodeCuaMcpPackageArg);
}

function isRetiredCuaMcpServer(name: string, config: McpServerConfig | undefined): boolean {
  // node_repl is the single supported CUA host and may share the CUA plugin's
  // authority marker; all other CUA-shaped MCP entries are retired.
  return (
    name !== NODE_REPL_SERVER_NAME && config !== undefined && isZCodeCuaStdioServer(name, config)
  );
}

function getConfiguredServerStatus(
  name: string,
  config: McpServerConfig,
  untrustedServerNames: ReadonlySet<string>,
): McpServerStatus["status"] {
  if (config.enabled === false) return "disabled";
  return untrustedServerNames.has(name) ? "untrusted" : "disconnected";
}
