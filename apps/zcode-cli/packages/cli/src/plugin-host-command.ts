import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ZCODE_PLUGIN_HOST_COMMAND } from "@zcode/contracts/plugins";
import {
  getCapturedZCodeCuaBrokerCredentials,
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
} from "@zcode/shared/runtime-env";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID, ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared/mcp";
import type {
  PayswapBrokerBootState,
  PayswapBrokerCredentialTuple,
  PayswapInstanceRegistry,
} from "@zcode/shared/payswap";
import { PAYSWAP_OFFICIAL_PLUGIN_ID } from "@zcode/shared/payswap";
import type { RunContext } from "@zcode/shared-types";

const HOST_USAGE = `${ZCODE_PLUGIN_HOST_COMMAND} <server-path> [-- <server-arg>...]`;

type HostedPluginModule = {
  main?: unknown;
};

export function isPluginHostInvocation(argv: readonly string[]): boolean {
  return argv[0] === ZCODE_PLUGIN_HOST_COMMAND;
}

// __zcode-plugin-host 在 agent 子进程里运行 official plugin 的 MCP server（server.js）。
// CLI 入口 main.ts 的 applyCliRuntimeEnvSanitization 会先把 broker token 从 process.env 剔除进
// 进程内 capture；因此这里是恢复 bearer token 的最后一道宿主边界。capture 本身只证明某个
// Agent 进程曾收到过 Helper 凭据，不能证明当前传入的 server 就是官方 zcode-cua：
// 只凭存在 capture 就把 token 恢复给任意 server path，第三方/被替换的插件可借此取得 CUA
// broker 的 TCC 能力。必须同时验证 resolver 权威写入的 plugin id、完整的捕获凭据组，
// 以及 canonical broker socket；任一字段不匹配都在 import 之前拒绝，避免加载不受信模块后再暴露 token。
export async function runPluginHostCommand(ctx: RunContext, argv: string[]): Promise<number> {
  if (argv.length < 1) {
    ctx.stderr.write(`Usage: ${HOST_USAGE}\n`);
    return 1;
  }

  const [rawServerPath, ...serverArgs] = argv;

  try {
    if (rawServerPath === undefined) {
      throw new Error("Plugin server path is required.");
    }

    const serverPath = resolve(rawServerPath);
    if (!existsSync(serverPath)) {
      throw new Error("Plugin server file does not exist.");
    }
    const capturedBrokerCredentials = getCapturedZCodeCuaBrokerCredentials();
    assertCapturedBrokerLaunchIsAuthorized(capturedBrokerCredentials);
    const module = (await import(pathToFileURL(serverPath).href)) as HostedPluginModule;
    if (typeof module.main !== "function") {
      throw new Error("Plugin server does not export main().");
    }

    const originalArgv = process.argv;
    const originalBrokerSocket = process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY];
    // shared node_repl 把同一凭据组恢复到环境，由 broker bridge 读取；旧的独立 CUA
    // MCP 不再拥有执行入口。
    process.argv = [process.execPath, serverPath, ...serverArgs];
    if (capturedBrokerCredentials.socket && process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY] === "1") {
      process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY] = capturedBrokerCredentials.socket;
    }
    try {
      await module.main();
    } finally {
      process.argv = originalArgv;
      if (originalBrokerSocket === undefined) {
        delete process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY];
      } else {
        process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY] = originalBrokerSocket;
      }
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Plugin host failed: ${message}\n`);
    return 1;
  }
}

type CapturedBrokerCredentials = ReturnType<typeof getCapturedZCodeCuaBrokerCredentials>;

function assertCapturedBrokerLaunchIsAuthorized(credentials: CapturedBrokerCredentials): void {
  const hasCapturedCredentials = Boolean(credentials.socket || credentials.pluginAuthority);
  if (!hasCapturedCredentials) return;

  const pluginId = process.env[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase();
  // 凭据组里已经没有 token 了：broker 全平台改为身份模式（Helper 按对端代码签名裁决连接），
  // shared/runtimeEnv.ts 的 CapturedCuaBrokerCredentials 只有 socket + pluginAuthority
  // (+ refreshMarker)。这里不能再读 `credentials.token`；token 已从凭据组移除，
  // 残留读取方只能靠 CLI 自己的 typecheck 发现（根 `pnpm typecheck` 不含 apps/zcode-cli）。
  // socket + pluginAuthority 必须成对（authority 是 bootstrap 写入 node_repl 配置的 provenance
  // 随机数，core 据此认官方 server）；捕获侧本就只在成对时落快照，半组会清空并 fail-closed。
  // 校验也不能要求 token 齐全——身份模式凭据没有 token，强校验会让 node_repl 宿主启动即
  // 退出（"connection closed during the server/discover probe"），工具面为空。
  if (
    credentials.socket === undefined ||
    credentials.pluginAuthority === undefined ||
    pluginId !== ZCODE_CUA_OFFICIAL_PLUGIN_ID ||
    process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY] !== "1"
  ) {
    throw new Error(
      "Captured ZCode CUA broker credentials may only launch the trusted shared node_repl host",
    );
  }
}

/** PaySwap 五键凭据组启动断言的专用错误（可被宿主/测试按类捕获）。 */
export class PayswapBrokerLaunchAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayswapBrokerLaunchAuthorizationError";
  }
}

/**
 * PaySwap 捕获凭据的启动断言（契约 w2-01 §4.4(2) + rev 2a 时效修正；CUA 断言
 * `assertCapturedBrokerLaunchIsAuthorized` 的平行变体，多一层 per-boot 时效校验）：
 *
 * 1) 上下文：捕获的五键凭据组只准服务受信官方 PaySwap plugin host 上下文 ——
 *    `ZCODE_PLUGIN_ID` 必须是 resolver 权威写入的 `PAYSWAP_OFFICIAL_PLUGIN_ID`；
 *    冒名插件（impostor）拿到完整凭据也拒绝。
 * 2) 时效（rev 2a，F2）：存在 ≠ 有效 —— hostId 必须等于**当前** boot、instanceId 必须在
 *    **当前**注册表里 live、socket 必须等于**当前** endpoint。上一个 boot 抓下的完整 stale
 *    五键组重新植入新启动 → 拒绝（否则官方 child 信任旧 boot 的签名钥，§6.5(1) 的跨 boot
 *    绑定被契约自己定义的路径打穿）。
 *
 * 无捕获凭据 → 断言不适用，直接返回（CUA 先例的 early return —— 不得阻塞非 PaySwap 宿主）。
 * 本步只提供断言本体；生产 `__zcode-plugin-host` 派发链的接线随 Step 3+ 的 broker boot/
 * 注册表 spawn 侧铸造落地。
 */
export function assertCapturedPayswapBrokerLaunchIsAuthorized(
  captured: Readonly<PayswapBrokerCredentialTuple> | null | undefined,
  currentBootState: Readonly<PayswapBrokerBootState>,
  registry: PayswapInstanceRegistry,
): void {
  if (!captured) return;

  const pluginId = process.env[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase();
  if (pluginId !== PAYSWAP_OFFICIAL_PLUGIN_ID) {
    throw new PayswapBrokerLaunchAuthorizationError(
      "Captured PaySwap broker credentials may only launch the trusted official PaySwap plugin host",
    );
  }
  if (captured.hostId !== currentBootState.hostId) {
    // 时效（F2）：stale 完整组 —— host id 不属于当前 boot。
    throw new PayswapBrokerLaunchAuthorizationError(
      `Captured PaySwap broker credentials are stale: host id does not match the current broker boot (contract §4.4(2) rev 2a)`,
    );
  }
  const lookup = registry.lookup(captured.instanceId);
  if (lookup?.status !== "live") {
    // 时效（F2）：实例不在当前注册表里 live（未知 / 已 tombstone / 已被禁用撤销）。
    throw new PayswapBrokerLaunchAuthorizationError(
      `Captured PaySwap broker credentials reference an instance that is not live in the current registry (contract §4.4(2) rev 2a)`,
    );
  }
  if (captured.socket !== currentBootState.endpointPath) {
    // 时效（F2）：socket 不指向当前 endpoint（pre-plant / 旧 boot 残留）。
    throw new PayswapBrokerLaunchAuthorizationError(
      `Captured PaySwap broker credentials do not match the current broker endpoint socket (contract §4.4(2) rev 2a)`,
    );
  }
}
