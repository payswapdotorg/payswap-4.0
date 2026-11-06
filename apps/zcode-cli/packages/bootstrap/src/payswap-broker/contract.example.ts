/**
 * payswap-broker 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * host 侧单侧模块（child 侧经 `@zcode/shared/payswap` 的 verifyResponseEnvelope，不经此）：
 * boot（自探针 → 模式）→ spawn 表注册 → close。集成接线（Step 4+）时 host 在 PaySwap
 * 插件 spawn 处调用 registerInstance，其余调用方只在测试/诊断里直接触达本模块。
 */
import { mintBrokerBootState, type PayswapInstanceRegistryEntry } from "@zcode/shared/payswap";
import { bootPayswapBroker } from "./index.js";

export async function examplePayswapBrokerLifecycle(): Promise<void> {
  // (1) boot：per-boot 身份（P1.2 mintBrokerBootState）→ 自探针（ADR-4：真实 loopback
  //     对上验证对等凭据读取路径）→ peer_verified | degraded_refusing（§5.4 fail-closed）。
  const broker = await bootPayswapBroker({
    bootState: mintBrokerBootState(),
    auditSink: (event) => {
      // §11 ingress：typed code，永不含凭据材料。
      if (event.outcome === "refused") {
        console.info(`payswap broker refused: ${event.code ?? "unknown"}`);
      }
    },
  });

  // (2) spawn 表注册（§5.2/§10.1）：host 自己 spawn 的 PaySwap MCP 子进程才算数 ——
  //     pid → 实例路由；注册表（P1.2）是 liveness/墓碑权威。
  const entry: PayswapInstanceRegistryEntry = {
    instanceId: "00000000-0000-4000-8000-000000000000",
    token: "0".repeat(64),
    childPid: 12345,
    pluginRegistrationIdentity: "payswap@zcode-plugins-official",
    workspace: "/workspace",
    sessionScope: "session",
    spawnedAt: Date.now(),
  };
  broker.registerInstance(entry);

  // (3) 模式与端点（受信注入的 PAYSWAP_BROKER_SOCKET 即 broker.endpointPath）：
  if (broker.mode === "degraded_refusing") {
    console.warn(`payswap broker degraded: ${broker.degradedReason ?? "unknown"}`);
  }

  // (4) close（ADR-6）：先摘路径、宽限强断、finally 无条件清理；幂等。
  await broker.close();
  await broker.close(); // 第二次是 no-op
}
