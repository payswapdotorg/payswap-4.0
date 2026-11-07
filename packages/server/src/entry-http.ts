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
  createPayswapApprovalHost,
  createPayswapOperatorStore,
  payswapApprovalChannelDescriptor,
  readPayswapFinancialModeRequested,
  resolvePayswapFinancialActivation,
  type PayswapApprovalHost,
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

  // PaySwap P1.7（addendum §1.6.2 item 5 + §1.6.3）：financial 部署装配批准通道 ——
  // approval host 的 fail-closed 默认注册进 services（§1.6.2 item 5c 暴露策略：
  // 只有 operator 绑定的 /ws 连接经 per-connection override 拿到 session-bound 真
  // service；发卡是 in-process host API，无网络端点）。
  let payswapApproval:
    | { store: ReturnType<typeof createPayswapOperatorStore>; approval: PayswapApprovalHost }
    | undefined;
  if (payswapFinancialRequested && payswapActivation.status === "activated") {
    const store = createPayswapOperatorStore({
      stateFilePath: join(getAppConfigDir(), "payswap", "operators.json"),
    });
    const approval = createPayswapApprovalHost({ store });
    services.register(payswapApprovalChannelDescriptor, approval.channelDefault);
    payswapApproval = { store, approval };
  }

  createHttpServer(services, port, {
    serverId,
    workspaceIdentityMapper,
    migrationFailedPathCount,
    virtualProjects: true,
    topicResourcePeers,
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
    ...(payswapApproval ? { payswapFinancial: payswapApproval } : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
