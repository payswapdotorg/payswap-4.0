/**
 * PaySwap P2.2 slice 5 —— desktop PSP 键预热（`warmupPayswapPspHostEnv`）的法则级
 * 证明（accountWarmup.ts 文件头法则；无 Electron —— 键 store 端口注入）。
 *
 * 1. **现读组装**：ensure 成功 → env 恰 `ZCODE_PAYSWAP_PSP_KEY`（键值逐字）；
 *    每次调用现读 store（连续两次、store 状态变化 → 第二次反映新状态）。
 * 2. **fail-safe**：safeStorage 不可用（null）→ 空集 + keyAvailable=false，不抛出；
 *    解包失败（typed throw）→ 空集 + onWarmupError 可见，不抛出（文件原样留给
 *    store 法则）。
 * 3. **空/空白键** → 空集（不注入半组 —— buildPayswapPspHostEnv 单一实现）。
 */

import { warmupPayswapPspHostEnv } from "../src/main/payswap/accountWarmup.js";
import { PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY } from "@zcode/shared/payswap";
import { describe, expect, it } from "vitest";

function keyStoreReturning(key: string | null) {
  return { ensureUnwrappedKey: async () => key };
}

function throwingKeyStore(error: Error) {
  return {
    ensureUnwrappedKey: async () => {
      throw error;
    },
  };
}

describe("payswap desktop PSP key warmup (P2.2 slice 5)", () => {
  it("an ensured key assembles exactly ZCODE_PAYSWAP_PSP_KEY with the key verbatim", async () => {
    const key = "a".repeat(64);
    const result = await warmupPayswapPspHostEnv({ keyStore: keyStoreReturning(key) });
    expect(result.env).toEqual({ [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: key });
    expect(result.keyAvailable).toBe(true);
  });

  it("safeStorage unavailable → empty env, keyAvailable false, no throw (fail-safe: Gate E2 refusals stay at the operation face)", async () => {
    const result = await warmupPayswapPspHostEnv({ keyStore: keyStoreReturning(null) });
    expect(result.env).toEqual({});
    expect(result.keyAvailable).toBe(false);
  });

  it("an unwrap failure → empty env + onWarmupError sees the typed error, no throw (the wrapped file stays untouched — the key-store law)", async () => {
    const seen: unknown[] = [];
    const result = await warmupPayswapPspHostEnv({
      keyStore: throwingKeyStore(new Error("PAYSWAP_PSP_KEY_UNWRAP_FAILED: keychain changed")),
      onWarmupError: (error) => {
        seen.push(error);
      },
    });
    expect(result.env).toEqual({});
    expect(result.keyAvailable).toBe(false);
    expect(seen.length).toBe(1);
  });

  it("each call reads the store fresh — a recovered store is picked up without a process restart", async () => {
    let currentKey: string | null = null;
    const store = {
      ensureUnwrappedKey: async () => currentKey,
    };
    const first = await warmupPayswapPspHostEnv({ keyStore: store });
    expect(first.keyAvailable).toBe(false);
    currentKey = "b".repeat(64);
    const second = await warmupPayswapPspHostEnv({ keyStore: store });
    expect(second.keyAvailable).toBe(true);
    expect(second.env[PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]).toBe("b".repeat(64));
  });

  it("an empty or whitespace-only key → empty env (never a half-delivered set)", async () => {
    for (const key of ["", "   "]) {
      const result = await warmupPayswapPspHostEnv({ keyStore: keyStoreReturning(key) });
      expect(result.env).toEqual({});
      expect(result.keyAvailable).toBe(false);
    }
  });
});
