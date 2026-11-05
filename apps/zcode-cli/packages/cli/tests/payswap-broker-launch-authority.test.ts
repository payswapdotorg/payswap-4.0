import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared";
import {
  createPayswapInstanceRegistry,
  mintBrokerBootState,
  PAYSWAP_OFFICIAL_PLUGIN_ID,
  type PayswapBrokerCredentialTuple,
  type PayswapInstanceRegistryEntry,
} from "@zcode/shared/payswap";
import {
  assertCapturedPayswapBrokerLaunchIsAuthorized,
  PayswapBrokerLaunchAuthorizationError,
} from "../src/plugin-host-command.js";

/**
 * PaySwap P1.2 Step 2 —— `__zcode-plugin-host` 派发路径上的 PaySwap 凭据启动断言
 * （契约 w2-01 §4.4(2) + rev 2a currency 修正；CUA 断言
 * `assertCapturedBrokerLaunchIsAuthorized` 的平行变体，测试遵循 cli 包 node:test 约定）。
 *
 * 断言语义（比 CUA 断言多一层 —— PaySwap 凭据带 per-boot 语义）：
 *   1) 上下文：捕获的五键凭据组只准服务受信官方 PaySwap plugin host 上下文（plugin id）；
 *   2) 时效（rev 2a，F2）：presence 不够 —— hostId 必须等于当前 boot、instanceId 必须在
 *      当前注册表里 live、socket 必须等于当前 endpoint。上一个 boot 抓下来的完整 stale
 *      五键组重新植入新启动 → 拒绝（否则官方 child 信任旧 boot 的签名钥，跨 boot 绑定
 *      §6.5(1) 被契约自己定义的路径打穿）。
 *
 * 本文件经 `pnpm --filter @zcode/cli run test`（node --import tsx --test）运行；
 * bootstrap 包无法跨包导入 @zcode/cli（无依赖边），故按 cli 包自身测试约定放置。
 */

function makeTuple(boot: ReturnType<typeof mintBrokerBootState>, instanceId: string): PayswapBrokerCredentialTuple {
  return {
    socket: boot.endpointPath,
    token: randomBytes(32).toString("hex"),
    instanceId,
    hostId: boot.hostId,
    // 断言不读 verifyKey 的密码学内容，只需形状合法的 base64 32 字节。
    verifyKeyBase64: Buffer.alloc(32, 7).toString("base64"),
  };
}

function makeEntry(instanceId: string): PayswapInstanceRegistryEntry {
  return {
    instanceId,
    token: randomBytes(32).toString("hex"),
    childPid: 4242,
    pluginRegistrationIdentity: PAYSWAP_OFFICIAL_PLUGIN_ID,
    workspace: "/tmp/workspace-a",
    sessionScope: "session-a",
    spawnedAt: Date.now(),
  };
}

function withPayswapPluginHostEnv(run: () => void): void {
  const previous = process.env[ZCODE_PLUGIN_ID_ENV_KEY];
  process.env[ZCODE_PLUGIN_ID_ENV_KEY] = PAYSWAP_OFFICIAL_PLUGIN_ID;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[ZCODE_PLUGIN_ID_ENV_KEY];
    else process.env[ZCODE_PLUGIN_ID_ENV_KEY] = previous;
  }
}

test("allows the trusted official payswap host context with a current five-key tuple", () => {
  const boot = mintBrokerBootState();
  const registry = createPayswapInstanceRegistry();
  const instanceId = randomUUID();
  registry.register(makeEntry(instanceId));
  const tuple = makeTuple(boot, instanceId);
  withPayswapPluginHostEnv(() => {
    assert.doesNotThrow(() =>
      assertCapturedPayswapBrokerLaunchIsAuthorized(tuple, boot, registry),
    );
  });
});

test("refuses a complete stale tuple from a previous host boot (host id mismatch)", () => {
  const currentBoot = mintBrokerBootState();
  const previousBoot = mintBrokerBootState();
  const registry = createPayswapInstanceRegistry();
  const instanceId = randomUUID();
  registry.register(makeEntry(instanceId));
  // 完整五键，但 hostId 是上一个 boot 的 —— 时效校验必须拒绝（§4.4(2) rev 2a）。
  const staleTuple = { ...makeTuple(currentBoot, instanceId), hostId: previousBoot.hostId };
  withPayswapPluginHostEnv(() => {
    assert.throws(
      () => assertCapturedPayswapBrokerLaunchIsAuthorized(staleTuple, currentBoot, registry),
      PayswapBrokerLaunchAuthorizationError,
    );
  });
});

test("refuses a complete tuple whose instance is tombstoned in the current registry", () => {
  const boot = mintBrokerBootState();
  const registry = createPayswapInstanceRegistry();
  const instanceId = randomUUID();
  registry.register(makeEntry(instanceId));
  registry.tombstone(instanceId, "exit");
  const tuple = makeTuple(boot, instanceId);
  withPayswapPluginHostEnv(() => {
    assert.throws(
      () => assertCapturedPayswapBrokerLaunchIsAuthorized(tuple, boot, registry),
      (error: unknown) => {
        assert.ok(error instanceof PayswapBrokerLaunchAuthorizationError);
        assert.match(error.message, /instance/);
        return true;
      },
    );
  });
});

test("refuses a current-boot tuple with a mismatched socket (endpoint)", () => {
  const boot = mintBrokerBootState();
  const registry = createPayswapInstanceRegistry();
  const instanceId = randomUUID();
  registry.register(makeEntry(instanceId));
  const tuple = { ...makeTuple(boot, instanceId), socket: "/tmp/pre-planted-attacker.sock" };
  withPayswapPluginHostEnv(() => {
    assert.throws(
      () => assertCapturedPayswapBrokerLaunchIsAuthorized(tuple, boot, registry),
      (error: unknown) => {
        assert.ok(error instanceof PayswapBrokerLaunchAuthorizationError);
        assert.match(error.message, /socket|endpoint/);
        return true;
      },
    );
  });
});

test("refuses an impostor plugin context even with a current tuple", () => {
  const boot = mintBrokerBootState();
  const registry = createPayswapInstanceRegistry();
  const instanceId = randomUUID();
  registry.register(makeEntry(instanceId));
  const tuple = makeTuple(boot, instanceId);
  const previous = process.env[ZCODE_PLUGIN_ID_ENV_KEY];
  process.env[ZCODE_PLUGIN_ID_ENV_KEY] = "attacker-plugin@evil-marketplace";
  try {
    assert.throws(
      () => assertCapturedPayswapBrokerLaunchIsAuthorized(tuple, boot, registry),
      PayswapBrokerLaunchAuthorizationError,
    );
  } finally {
    if (previous === undefined) delete process.env[ZCODE_PLUGIN_ID_ENV_KEY];
    else process.env[ZCODE_PLUGIN_ID_ENV_KEY] = previous;
  }
});

test("no captured payswap credentials → nothing to assert (CUA precedent early return)", () => {
  const boot = mintBrokerBootState();
  const registry = createPayswapInstanceRegistry();
  const previous = process.env[ZCODE_PLUGIN_ID_ENV_KEY];
  process.env[ZCODE_PLUGIN_ID_ENV_KEY] = "attacker-plugin@evil-marketplace";
  try {
    // 没有 PaySwap 捕获凭据 → 断言不适用，不得阻塞非 PaySwap 宿主启动。
    assert.doesNotThrow(() =>
      assertCapturedPayswapBrokerLaunchIsAuthorized(null, boot, registry),
    );
  } finally {
    if (previous === undefined) delete process.env[ZCODE_PLUGIN_ID_ENV_KEY];
    else process.env[ZCODE_PLUGIN_ID_ENV_KEY] = previous;
  }
});
