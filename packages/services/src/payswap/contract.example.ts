/**
 * services-payswap 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * 一次最小完整装配 + connect/revoke 往返（P2.2 语义；真实凭据库 + 真实记录
 * store —— 与 packages/services/test/payswap-account-service.test.ts 同款纪律）。
 */
import { createCredentialService } from "../credential/credentialService.js";
import type { ServicesPayswapContract } from "./contract.js";
import { createPayswapAccountService } from "./accounts/accountService.js";
import { createPayswapConnectionRecordStore } from "./accounts/connectionRecordStore.js";

/** host 侧装配：真实凭据服务（PSP 键级政策在彼处）+ 记录 store（默认路径）。 */
export function exampleAssemblePayswapAccountService(): ReturnType<
  typeof createPayswapAccountService
> {
  const credentialService = createCredentialService({
    // desktop 行：desktop main 经 hostProcessLocalEnv 交付的 safeStorage 解包随机键；
    // server 行换成 ZCODE_CREDENTIAL_SECRET。两者皆无 = fail-closed（typed 拒绝）。
    env: process.env,
  });
  const connectionStore = createPayswapConnectionRecordStore();
  return createPayswapAccountService({
    credentialPort: credentialService,
    connectionStore,
  });
}

/** 一次 connect → revoke 往返（秘密永不进入返回值 —— 投影面五字段）。 */
export async function exampleConnectAndRevoke(
  service: ReturnType<typeof createPayswapAccountService>,
  operatorSecret: string,
): Promise<ServicesPayswapContract | null> {
  const connected = await service.connect({
    providerId: "stripe",
    operatorSecret,
    displayName: "Stripe (test)",
  });
  if (connected.kind !== "connected") return null; // typed refusal（code 分流，勿匹配 message）
  const revoked = await service.revoke({ connectionId: connected.connection.connectionId });
  return revoked.kind === "revoked" ? null : null;
}
