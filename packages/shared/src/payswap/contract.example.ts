/**
 * shared-payswap 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * 两侧各一个最小示例（P1.2 语义；真实接线随 Step 3+ 的 broker boot 落地）：
 * host 侧 boot → mint → sign；child 侧对收到的行验签并取回 body。
 */
import {
  createPayswapInstanceRegistry,
  mintBrokerBootState,
  requestLineDigest,
  signResponseEnvelope,
  verifyResponseEnvelope,
  type PayswapBrokerOp,
} from "./index.js";

/** host 侧：broker boot 铸密钥与身份，对一个已过 §5.5 步骤 1–4 的请求签名响应。 */
export function exampleHostSign(requestLine: string): string {
  const boot = mintBrokerBootState(); // 私钥只留在 host 内存（§6.5(1））
  const op: PayswapBrokerOp = "compile_intent";
  const signed = signResponseEnvelope(
    {
      // request-attributed（§6.4(3)）：请求已过 peer/token/registry 绑定才填具体值
      instanceId: "11111111-1111-4111-8111-111111111111",
      seq: 1,
      op,
      requestDigest: requestLineDigest(requestLine),
      response: { ok: true, seq: 1, data: { kind: "refused", refusal: { code: "not_opted_in", message: "S1" } } },
    },
    boot.keyPair.privateKey,
    boot.hostId,
  );
  return JSON.stringify(signed); // 一行 wire 形状（§6.4）
}

/** child 侧：对自己写出的精确请求行验签（§6.5(3)(a)–(h) 全序，失败整封拒绝）。 */
export function exampleChildVerify(receivedLine: string, sentLine: string) {
  const result = verifyResponseEnvelope(
    receivedLine,
    {
      instanceId: "11111111-1111-4111-8111-111111111111",
      seq: 1,
      op: "compile_intent",
      sentLine, // digest 覆盖它（不含结尾换行，§6.4(2)）
    },
    {
      hostId: "22222222-2222-4222-8222-222222222222", // 受信注入的 PAYSWAP_BROKER_HOST_ID
      verifyKeyBase64: "…", // 受信注入的 PAYSWAP_BROKER_VERIFY_KEY
    },
  );
  if (!result.ok) {
    // 机器可读的拒绝原因；被拒响应的字段一个都不外露（§6.5(3)）
    return result.reason;
  }
  return result.body; // 仅在 (a)–(h) 全部通过后可见
}

/** host 侧：spawn 时注册实例；disable 时按插件身份撤销全部 live 绑定（§10.2）。 */
export function exampleRegistryLifecycle() {
  const registry = createPayswapInstanceRegistry();
  registry.register({
    instanceId: "11111111-1111-4111-8111-111111111111",
    token: "0".repeat(64),
    childPid: 4242,
    pluginRegistrationIdentity: "payswap@zcode-plugins-official",
    workspace: "/repo",
    sessionScope: "session-1",
    spawnedAt: Date.now(),
  });
  registry.revokePluginInstances("payswap@zcode-plugins-official"); // → ["11111111-…"]
  return registry.lookup("11111111-1111-4111-8111-111111111111"); // { status: "tombstoned", reason: "disabled" }
}
