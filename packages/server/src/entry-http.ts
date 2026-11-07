import {
  createServerHostServices,
  createTopicResourcePeers,
  getAppConfigDir,
} from "@zcode/services/node";
import { join } from "node:path";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { createHttpServer, resolveHttpServerId } from "./http.js";
import {
  createPayswapOperatorStore,
  readPayswapFinancialModeRequested,
  resolvePayswapFinancialActivation,
} from "./payswap/index.js";

async function main(): Promise<void> {
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  // PaySwap P1.6（addendum §1.6.3）：部署级 financial opt-in —— 显式请求 +
  // deployment 凭据前置（N27：请求而无凭据 → 激活拒绝，绝不以弱姿态启动）。
  const payswapFinancialRequested = readPayswapFinancialModeRequested(process.env);
  const payswapActivation = resolvePayswapFinancialActivation({
    requested: payswapFinancialRequested,
    deploymentAuthToken: authToken,
  });
  if (payswapActivation.status === "refused") {
    console.error(
      "[zcode-server:http] PaySwap financial mode activation refused:",
      payswapActivation.code,
    );
    process.exitCode = 1;
    return;
  }
  const topicResourcePeers = createTopicResourcePeers();
  const serverId = resolveHttpServerId();
  const { services, workspaceIdentityMapper, migrationFailedPathCount } =
    await createServerHostServices({
      topicResourceRelayChannel: (request) => topicResourcePeers.getChannel(request),
      sourceServerId: serverId,
      zcodeBuiltinProviderConfigFilePath,
      providerProvisioningTargetEnabled: Boolean(authToken),
    });

  createHttpServer(services, port, {
    serverId,
    workspaceIdentityMapper,
    migrationFailedPathCount,
    virtualProjects: true,
    topicResourcePeers,
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
    ...(payswapFinancialRequested && payswapActivation.status === "activated"
      ? {
          payswapFinancial: {
            store: createPayswapOperatorStore({
              stateFilePath: join(getAppConfigDir(), "payswap", "operators.json"),
            }),
          },
        }
      : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
