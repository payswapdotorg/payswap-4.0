/**
 * PaySwap P2 —— Gate E2：PSP 凭据存储升级的 services 侧证明（addendum §5.2；
 * playbook P2「write Gate E2 tests first」的第二半 —— 真实凭据库行）。
 *
 * 被测对象：`createCredentialService`（真实 JSON store + 真实 AES-256-GCM cipher +
 * 真实文件锁 + 真实原子写）在 `payswap:psp:*` 键上的分级政策：
 *
 * 1. **fail-closed**（§5.2 neither 行）：无 safeStorage 键且无
 *    `ZCODE_CREDENTIAL_SECRET` 时，PSP 键的 save/load/recoverUnreadable 一律
 *    typed 拒绝（`PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE`）；store 文件不产生
 *    任何 PSP 记录（不是「写入后再清理」，是根本不写）。
 * 2. **secret 路径**（server 行）：`ZCODE_CREDENTIAL_SECRET` 在位时 PSP 键可存——
 *    与非 PSP 键同一（secret 派生的）cipher。
 * 3. **safeStorage 键路径**（desktop 行）：`ZCODE_PAYSWAP_PSP_KEY` 在位（desktop
 *    main 解包 safeStorage 包裹键后经 host env 交付）时 PSP 键走独立 cipher；
 *    非 PSP 键**仍走原 fallback cipher**（preservation 的对比行）。
 * 4. **at-rest 检查**（§5.2 acceptance 原文「at rest, no PSP secret is decryptable
 *    under the fallback-derived key (verified by direct inspection of the store)」）：
 *    直接读 store 文件，把 PSP 记录密文喂给 fallback 派生键的 cipher → 必须
 *    decrypt 失败（密钥不匹配），而非返回明文。
 * 5. **preservation**：非 PSP 键的行为在有/无 PSP 政策输入时逐字节不变（fallback
 *    cipher 照旧；delete 对任意键可用）。
 *
 * 法则级行住 bootstrap 套件（tests/payswap-credential-security.test.ts）；
 * desktop safeStorage 键仓行住 packages/desktop/test/payswap-psp-key-store.test.ts。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialKeySchema } from "@zcode/shared";
import {
  isPayswapPspSecureStorageUnavailableError,
  PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY,
} from "@zcode/shared/payswap";
import {
  createCredentialCipherProvider,
  createCredentialService,
  setDataBaseDir,
} from "@zcode/services/node";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const PSP_KEY = "payswap:psp:stripe";
const PLAINTEXT_SECRET = "sk_test_redacted_placeholder";

interface ServiceEnvFixture {
  /** fallback-only：无 ZCODE_CREDENTIAL_SECRET、无 ZCODE_PAYSWAP_PSP_KEY。 */
  fallbackOnly: Record<string, string>;
  /** server 行：ZCODE_CREDENTIAL_SECRET 在位。 */
  withSecret: Record<string, string>;
  /** desktop 行：ZCODE_PAYSWAP_PSP_KEY 在位（safeStorage 解包键的交付形态）。 */
  withSafeStorageKey: Record<string, string>;
}

function buildEnvFixture(): ServiceEnvFixture {
  return {
    fallbackOnly: {},
    withSecret: { ZCODE_CREDENTIAL_SECRET: "server-secret-manager-material-000" },
    withSafeStorageKey: {
      [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "a".repeat(64),
    },
  };
}

/** fallback 派生键的 cipher（env 无任何 secret 输入 → 确定性 fallback 派生）。 */
function fallbackDerivedCipher() {
  return createCredentialCipherProvider({ env: {} });
}

/** 直接读取 store 文件（at-rest 检查：不做任何 service 层解密）。 */
async function readRawStore(dataBaseDir: string): Promise<Record<string, string>> {
  const raw = await readFile(join(dataBaseDir, ".zcode", "v2", "credentials.json"), "utf-8");
  return JSON.parse(raw) as Record<string, string>;
}

const createdDirs: string[] = [];

async function freshStoreDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "payswap-e2e-credential-"));
  createdDirs.push(dir);
  setDataBaseDir(dir);
  return dir;
}

afterAll(async () => {
  setDataBaseDir(null);
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("payswap credential security (Gate E2) — credential service PSP policy", () => {
  beforeEach(async () => {
    await freshStoreDir();
  });

  it("PSP 命名空间键通过 credentialKeySchema（上游键校验不拒绝 PSP 键）", () => {
    expect(credentialKeySchema.safeParse(PSP_KEY).success).toBe(true);
  });

  it("fail-closed：无 safeStorage 键且无 secret 时 PSP save 拒绝且 store 无记录", async () => {
    const { fallbackOnly } = buildEnvFixture();
    const service = createCredentialService({ env: fallbackOnly });

    await expect(service.save(PSP_KEY, PLAINTEXT_SECRET)).rejects.toSatisfy(
      isPayswapPspSecureStorageUnavailableError,
    );

    // store 根本没有该键 —— 拒绝先于任何触盘：此刻整个 credentials.json 还不存在
    // （fail-closed 的最强形态：不是写后清理，是根本没有写）。
    const dir = createdDirs.at(-1)!;
    const storePath = join(dir, ".zcode", "v2", "credentials.json");
    await expect(readFile(storePath, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
    // 非 PSP 键在同策略下照常可写（preservation：政策只作用于 PSP 命名空间）。
    await service.save("oauth:active_provider", "provider-x");
    expect(await service.load("oauth:active_provider")).toBe("provider-x");
    const raw = await readRawStore(dir);
    expect(raw[PSP_KEY]).toBeUndefined();
  });

  it("fail-closed：PSP load 与 recoverUnreadable 同样 typed 拒绝（读取面不放行）", async () => {
    const service = createCredentialService({ env: buildEnvFixture().fallbackOnly });

    await expect(service.load(PSP_KEY)).rejects.toSatisfy(
      isPayswapPspSecureStorageUnavailableError,
    );
    await expect(service.recoverUnreadable(PSP_KEY, () => {})).rejects.toSatisfy(
      isPayswapPspSecureStorageUnavailableError,
    );
  });

  it("fail-closed：PSP delete 仍可用（清理不暴露秘密；卸载/重置路径不被阻断）", async () => {
    // 先在 desktop 政策下写入一条 PSP 记录（同一 store）。
    const serviceDesktop = createCredentialService({ env: buildEnvFixture().withSafeStorageKey });
    await serviceDesktop.save(PSP_KEY, PLAINTEXT_SECRET);

    // fallback-only 的 service 可以删除它（无 cipher 参与）。
    const serviceFallback = createCredentialService({ env: buildEnvFixture().fallbackOnly });
    await expect(serviceFallback.delete(PSP_KEY)).resolves.toBeUndefined();

    const dir = createdDirs.at(-1)!;
    const raw = await readRawStore(dir);
    expect(raw[PSP_KEY]).toBeUndefined();
  });

  it("secret 路径（server 行）：PSP 键可存可读；at-rest 密文 fallback 不可解", async () => {
    const { withSecret } = buildEnvFixture();
    const service = createCredentialService({ env: withSecret });

    await service.save(PSP_KEY, PLAINTEXT_SECRET);
    expect(await service.load(PSP_KEY)).toBe(PLAINTEXT_SECRET);

    // at-rest 直接检查（§5.2 acceptance）：fallback 派生键的 cipher 解不开 PSP 密文。
    const dir = createdDirs.at(-1)!;
    const raw = await readRawStore(dir);
    const ciphertext = raw[PSP_KEY];
    expect(ciphertext).toBeDefined();
    expect(ciphertext).not.toContain(PLAINTEXT_SECRET);
    expect(() => fallbackDerivedCipher().decrypt(ciphertext)).toThrow();
  });

  it("safeStorage 键路径（desktop 行）：PSP 走独立 cipher；at-rest 密文 fallback 与 secret 都不可解", async () => {
    const { withSafeStorageKey, withSecret } = buildEnvFixture();
    const service = createCredentialService({ env: withSafeStorageKey });

    await service.save(PSP_KEY, PLAINTEXT_SECRET);
    expect(await service.load(PSP_KEY)).toBe(PLAINTEXT_SECRET);

    const dir = createdDirs.at(-1)!;
    const raw = await readRawStore(dir);
    const ciphertext = raw[PSP_KEY];

    // fallback 派生键：解不开。
    expect(() => fallbackDerivedCipher().decrypt(ciphertext)).toThrow();
    // 另一秘密（server secret）派生键：同样解不开（PSP 密文只随 safeStorage 键）。
    const secretCipher = createCredentialCipherProvider({ env: withSecret });
    expect(() => secretCipher.decrypt(ciphertext)).toThrow();
  });

  it("desktop 行的 preservation 对比：同 store 内非 PSP 键仍走 fallback cipher", async () => {
    const { withSafeStorageKey } = buildEnvFixture();
    const service = createCredentialService({ env: withSafeStorageKey });

    await service.save(PSP_KEY, PLAINTEXT_SECRET);
    await service.save("oauth:active_provider", "provider-x");

    const dir = createdDirs.at(-1)!;
    const raw = await readRawStore(dir);

    // PSP 密文：fallback 解不开（上一行的独立证明）。
    expect(() => fallbackDerivedCipher().decrypt(raw[PSP_KEY])).toThrow();
    // 非 PSP 密文：fallback 解得开（上游行为逐字节不变 —— 这是 preservation 的
    // 判别行：同一 store、同一 service 实例，政策只改 PSP 命名空间）。
    expect(fallbackDerivedCipher().decrypt(raw["oauth:active_provider"])).toBe("provider-x");
    // 服务层读非 PSP 键也照旧（非 PSP 不经 PSP cipher）。
    expect(await service.load("oauth:active_provider")).toBe("provider-x");
  });

  it("注入式 pspCipherProvider 优先于 env 推导（显式注入是最高优先级通道）", async () => {
    const injectedMaterial = "injected-key-material-";
    const injectedPspCipher = createCredentialCipherProvider({
      env: { ZCODE_CREDENTIAL_SECRET: injectedMaterial },
    });
    const service = createCredentialService({
      env: buildEnvFixture().withSecret,
      pspCipherProvider: injectedPspCipher,
    });

    await service.save(PSP_KEY, PLAINTEXT_SECRET);
    expect(await service.load(PSP_KEY)).toBe(PLAINTEXT_SECRET);

    // at-rest：注入通道的密文用 withSecret 的 cipher 解不开（证明走的是注入通道）。
    const dir = createdDirs.at(-1)!;
    const raw = await readRawStore(dir);
    const secretCipher = createCredentialCipherProvider({ env: buildEnvFixture().withSecret });
    expect(() => secretCipher.decrypt(raw[PSP_KEY])).toThrow();
    // 而注入通道自己的 cipher 解得开。
    expect(injectedPspCipher.decrypt(raw[PSP_KEY])).toBe(PLAINTEXT_SECRET);
  });

  it("recoverUnreadable 在安全路径下按 PSP cipher 解密（不误删有效 PSP 记录）", async () => {
    const { withSafeStorageKey } = buildEnvFixture();
    const service = createCredentialService({ env: withSafeStorageKey });
    await service.save(PSP_KEY, PLAINTEXT_SECRET);

    // 正常解密 → 返回明文，记录保留（assertCurrent 未抛 → 不走删除臂）。
    const value = await service.recoverUnreadable(PSP_KEY, () => {});
    expect(value).toBe(PLAINTEXT_SECRET);

    const dir = createdDirs.at(-1)!;
    const raw = await readRawStore(dir);
    expect(raw[PSP_KEY]).toBeDefined();
  });
});
