/**
 * PaySwap P2 —— Gate E2：PSP 凭据的平台级安全存储法则（addendum §5.2；playbook
 * P2「write Gate E2 tests first」的第一半 —— 法则级行）。
 *
 * 法则（normative，addendum §5.2 原文）：
 * - **Source fact**：`ZCODE_CREDENTIAL_SECRET` 缺席时，cipher key 由公开数据确定性
 *   派生（`zcode-credential-fallback:${platform()}:${homedir()}:${username}`）——
 *   这不是秘密。PSP（payment service provider）凭据绝不允许落在这个派生键下。
 * - **决策表（per-platform）**：
 *   | Host | PSP 凭据存储要求 |
 *   |---|---|
 *   | Electron desktop | safeStorage 包裹的 cipher（OS 钥匙串包裹加密键） |
 *   | Server / remote | `ZCODE_CREDENTIAL_SECRET`（真实 secret manager）—— 必需，非可选 |
 *   | 两者皆无 | **fail-closed**：拒绝存储 PSP 凭据（typed error；连接 UI 呈现） |
 * - **键命名空间**：`payswap:psp:*` 是 PSP 凭据键的权威命名空间（「the deterministic
 *   fallback is never used for `payswap:psp:*` keys」）。前缀精确 `payswap:psp:`；
 *   `payswap:psp`（无尾冒号）与 `payswap:pspx:*` 都不在命名空间内。
 * - **优先级**：desktop 上 safeStorage 键与 secret 同时在位时取 safeStorage
 *   （per-host 表的 desktop 行是 OS 钥匙串；secret 是 server 行的要求）。
 *
 * 两级证明的另一级（services 真实凭据库 + desktop safeStorage 键仓）住：
 * - `packages/services/test/payswap-credential-security.test.ts`
 * - `packages/desktop/test/payswap-psp-key-store.test.ts`
 *
 * 本套件是法则级：纯 shared 模块，无 IO —— 决策表全行 + 命名空间矩阵 + typed
 * refusal 形状 + 主机 env 键契约（desktop 写侧 ↔ services 读侧的单一事实源）。
 */

import {
  createPayswapPspSecureStorageUnavailableError,
  isPayswapPspCredentialKey,
  isPayswapPspSecureStorageUnavailableError,
  PAYSWAP_PSP_CREDENTIAL_KEY_PREFIX,
  PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY,
  PAYSWAP_PSP_KEY_UNWRAP_FAILED_CODE,
  PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE_CODE,
  resolvePayswapPspCredentialStoragePolicy,
} from "@zcode/shared/payswap";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// 命名空间矩阵：`payswap:psp:*` 的精确边界
// ---------------------------------------------------------------------------

describe("payswap credential security (Gate E2) — PSP key namespace law", () => {
  it("命名空间内的键被识别（前缀 payswap:psp: 精确匹配）", () => {
    expect(PAYSWAP_PSP_CREDENTIAL_KEY_PREFIX).toBe("payswap:psp:");
    expect(isPayswapPspCredentialKey("payswap:psp:stripe")).toBe(true);
    // 嵌套子命名空间（provider 之后的自由段）同样在命名空间内。
    expect(isPayswapPspCredentialKey("payswap:psp:stripe:test")).toBe(true);
    expect(isPayswapPspCredentialKey("payswap:psp:paypal:live:account-1")).toBe(true);
    // 退化空段：前缀已命中即视为 PSP 键（fail-closed —— 宁可拒绝存储，不可漏门）。
    expect(isPayswapPspCredentialKey("payswap:psp:")).toBe(true);
  });

  it("命名空间外的键不被识别（psp 无尾冒号 / 相似前缀 / 其它 payswap 与上游键）", () => {
    // `payswap:psp`（无尾冒号）不是 `payswap:psp:*`——命名空间键至少带一个冒号段。
    expect(isPayswapPspCredentialKey("payswap:psp")).toBe(false);
    // 前缀相似但不同的键不在命名空间内。
    expect(isPayswapPspCredentialKey("payswap:pspx:stripe")).toBe(false);
    expect(isPayswapPspCredentialKey("payswap:psp2:stripe")).toBe(false);
    expect(isPayswapPspCredentialKey("xpayswap:psp:stripe")).toBe(false);
    // 其它 payswap 键与上游凭据键一律不受 PSP 政策影响（preservation 的键面边界）。
    expect(isPayswapPspCredentialKey("payswap:broker:anything")).toBe(false);
    expect(isPayswapPspCredentialKey("oauth:active_provider")).toBe(false);
    expect(isPayswapPspCredentialKey("bigmodel:user_info")).toBe(false);
    expect(isPayswapPspCredentialKey("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 决策表（§5.2 per-platform 表的全行覆盖）
// ---------------------------------------------------------------------------

describe("payswap credential security (Gate E2) — storage policy decision table", () => {
  it("safeStorage 键在位 → safe_storage（desktop 行；OS 钥匙串优先于 secret）", () => {
    expect(
      resolvePayswapPspCredentialStoragePolicy({
        safeStorageKeyConfigured: true,
        credentialSecretConfigured: true,
      }),
    ).toBe("safe_storage");
    expect(
      resolvePayswapPspCredentialStoragePolicy({
        safeStorageKeyConfigured: true,
        credentialSecretConfigured: false,
      }),
    ).toBe("safe_storage");
  });

  it("仅 secret 在位 → secret（server 行：ZCODE_CREDENTIAL_SECRET 必需）", () => {
    expect(
      resolvePayswapPspCredentialStoragePolicy({
        safeStorageKeyConfigured: false,
        credentialSecretConfigured: true,
      }),
    ).toBe("secret");
  });

  it("两者皆无 → fail_closed（neither 行：拒绝存储 PSP 凭据）", () => {
    expect(
      resolvePayswapPspCredentialStoragePolicy({
        safeStorageKeyConfigured: false,
        credentialSecretConfigured: false,
      }),
    ).toBe("fail_closed");
  });
});

// ---------------------------------------------------------------------------
// typed refusal 形状（fail-closed 的对外契约：连接 UI / 账户服务消费）
// ---------------------------------------------------------------------------

describe("payswap credential security (Gate E2) — typed refusal shape", () => {
  it("secure-storage-unavailable：稳定 code + 非空 message + 类型守卫", () => {
    const error = createPayswapPspSecureStorageUnavailableError();
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE_CODE);
    expect(PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE_CODE).toBe(
      "PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE",
    );
    expect(error.message.length).toBeGreaterThan(0);
    expect(isPayswapPspSecureStorageUnavailableError(error)).toBe(true);
  });

  it("类型守卫对非本类错误恒为假（普通 Error / decrypt 错误 / null / 非对象）", () => {
    expect(isPayswapPspSecureStorageUnavailableError(new Error("plain"))).toBe(false);
    expect(
      isPayswapPspSecureStorageUnavailableError(
        Object.assign(new Error("decrypt failed"), { code: "ZCODE_CREDENTIAL_DECRYPT_FAILED" }),
      ),
    ).toBe(false);
    expect(isPayswapPspSecureStorageUnavailableError(null)).toBe(false);
    expect(isPayswapPspSecureStorageUnavailableError("string")).toBe(false);
    expect(isPayswapPspSecureStorageUnavailableError(undefined)).toBe(false);
  });

  it("键仓解包失败码是独立常量（safeStorage 不可解 ≠ 存储不可用；P2.2 连接 UI 区分呈现）", () => {
    // 两类失败都是 typed；code 不重叠（UI 与账户服务按 code 分流，永不字符串匹配 message）。
    expect(PAYSWAP_PSP_KEY_UNWRAP_FAILED_CODE).toBe("PAYSWAP_PSP_KEY_UNWRAP_FAILED");
    expect(PAYSWAP_PSP_KEY_UNWRAP_FAILED_CODE).not.toBe(
      PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE_CODE,
    );
  });
});

// ---------------------------------------------------------------------------
// 主机 env 键契约：desktop 写侧（main 的 safeStorage 键仓）↔ services 读侧
// ---------------------------------------------------------------------------

describe("payswap credential security (Gate E2) — host env key contract", () => {
  it("safeStorage 键经 ZCODE_PAYSWAP_PSP_KEY 交付 host 进程（单一事实源常量）", () => {
    // desktop main 解包 safeStorage 包裹键后经 hostProcessLocalEnv 交付；services
    // 侧按同名键读取构建 PSP cipher。两侧引用同一常量，永不漂移。
    expect(PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY).toBe("ZCODE_PAYSWAP_PSP_KEY");
  });
});
