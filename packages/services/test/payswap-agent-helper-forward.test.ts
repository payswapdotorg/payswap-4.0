/**
 * D13.9 host→agent helper 供给转发 —— services 侧回归证明。
 *
 * 2026-11-18 native-Windows live 缺陷：host 自身 init 清洗
 * （initializeRuntimeProcessEnv → sanitizeZCodeRuntimeEnvInPlace）对本进程
 * process.env 的 PAYSWAP_BROKER_HELPER_{PATH,SHA256} **先捕获后剔除**，而 agent spawn
 * 转发读的是 process.env —— 已被剔除 —— 两键从未到达 agent CLI 的 capture；CLI 入口
 * main.ts 的回注（readCapturedPayswapBrokerHelperSupply）因此无料可用，coordinator
 * lazy boot 的 relay 解析（resolveDefaultPeerRelayHelper 读 process.env）永远空供给 →
 * win32 永远 degraded_refusing（插件桥 instance_mismatch 的根因）。
 *
 * 转发必须优先读 capture-before-strip 快照；process.env 只作未跑 host init 清洗的
 * 进程面（remote 形态等）的回退。
 */
import {
  PAYSWAP_BROKER_HELPER_PATH_ENV_KEY,
  PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY,
} from "@zcode/shared/payswap";
import {
  readCapturedPayswapBrokerHelperSupply,
  resetCapturedPayswapBrokerHelperSupplyForTest,
  sanitizeZCodeRuntimeEnvInPlace,
} from "@zcode/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { resolvePayswapBrokerHelperForwardEnv } from "../src/zcode-agent/zcodeAgentProcessManager.js";

const HELPER_PATH = "C:\\staged\\payswap-broker-peer-helper.exe";
const HELPER_SHA256 = "a".repeat(64);

describe("resolvePayswapBrokerHelperForwardEnv", () => {
  beforeEach(() => {
    resetCapturedPayswapBrokerHelperSupplyForTest();
  });

  it("host init 清洗已剔除 process.env 时转发读捕获快照（live 缺陷回归）", () => {
    const hostEnv: NodeJS.ProcessEnv = {
      [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: HELPER_PATH,
      [PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]: HELPER_SHA256,
    };
    // host init 纪律：capture-before-strip，原地剔除
    sanitizeZCodeRuntimeEnvInPlace(hostEnv);
    expect(hostEnv[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]).toBeUndefined();
    expect(readCapturedPayswapBrokerHelperSupply()).not.toBeNull();

    // spawn 转发读快照 —— 即使 process.env 已干净
    const forwarded = resolvePayswapBrokerHelperForwardEnv(hostEnv);
    expect(forwarded).toEqual({
      [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: HELPER_PATH,
      [PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]: HELPER_SHA256,
    });
  });

  it("无快照时回退 process.env（未跑 host init 清洗的进程面）", () => {
    const env: NodeJS.ProcessEnv = {
      [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: HELPER_PATH,
      [PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]: HELPER_SHA256,
    };
    expect(resolvePayswapBrokerHelperForwardEnv(env)).toEqual({
      [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: HELPER_PATH,
      [PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]: HELPER_SHA256,
    });
  });

  it("半组供给与全缺供给 → 空透传（行为不变）", () => {
    expect(
      resolvePayswapBrokerHelperForwardEnv({
        [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: HELPER_PATH,
      }),
    ).toEqual({});
    expect(resolvePayswapBrokerHelperForwardEnv({})).toEqual({});
  });

  it("sha256 形状非法 → 快照 fail-closed 清空，剔除后的 process.env → 空转发", () => {
    const hostEnv: NodeJS.ProcessEnv = {
      [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: HELPER_PATH,
      [PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]: "not-a-sha256",
    };
    sanitizeZCodeRuntimeEnvInPlace(hostEnv);
    expect(readCapturedPayswapBrokerHelperSupply()).toBeNull();
    expect(resolvePayswapBrokerHelperForwardEnv(hostEnv)).toEqual({});
  });
});
