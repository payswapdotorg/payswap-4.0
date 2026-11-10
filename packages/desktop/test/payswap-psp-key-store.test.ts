/**
 * PaySwap P2 —— Gate E2：desktop safeStorage PSP 键仓（addendum §5.2 desktop 行
 * 「safeStorage-backed cipher — the migration the source itself names」）。
 *
 * desktop main（唯一能访问 Electron safeStorage 的进程）持有 PSP cipher 的随机
 * 32 字节键：
 * - **at-rest**：键文件只含 safeStorage 包裹产物（OS 钥匙串外的任何读者都拿不到
 *   键明文）；0600 私有模式；永不落明文或 fallback 派生物。
 * - **交付**：解包后的键经 host env（`ZCODE_PAYSWAP_PSP_KEY` —— hostProcessLocalEnv
 *   通道，BIGMODEL_OAUTH_APP_SECRET 同款）交付 host 进程；services 侧凭它构建
 *   PSP cipher（packages/services/test/payswap-credential-security.test.ts 的
 *   desktop 行）。
 * - **fail-closed**：safeStorage 不可用 → null（不建文件、不造 fallback 键）；
 *   包裹键解不开（OS 钥匙串更换/迁移）→ typed `PAYSWAP_PSP_KEY_UNWRAP_FAILED`，
 *   不静默轮换（轮换会让既有 PSP 密文永久失联 —— 重连语义归 P2.2 连接 UI）。
 * - **并发**：ensure 串行化（in-flight 去重）—— 两个并发 ensure 得到同一键、
 *   恰一次落盘。
 *
 * fake safeStorage 只证明「仓只持久化 safeStorage 产物、且经它往返」；at-rest
 * 的密码学强度是真实 safeStorage 的属性（钥匙串外不可解）。
 */

import { mkdtempSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPayswapPspHostEnv,
  createPayswapPspKeyStore,
  PAYSWAP_PSP_KEY_STORE_FILE_NAME,
  type PayswapPspSafeStoragePort,
} from "../src/main/payswap/pspCredentialKeyStore.js";
import {
  isPayswapPspKeyUnwrapFailedError,
  PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY,
} from "@zcode/shared/payswap";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const WRAP_MARKER = Buffer.from("fake-safe-storage-wrapped:");

interface FakeSafeStorage extends PayswapPspSafeStoragePort {
  available: boolean;
  setAvailable(value: boolean): void;
}

function createFakeSafeStorage(): FakeSafeStorage {
  const port: FakeSafeStorage = {
    available: true,
    setAvailable(value: boolean) {
      port.available = value;
    },
    isEncryptionAvailable: () => port.available,
    encryptString: (plainText: string) =>
      Buffer.concat([WRAP_MARKER, Buffer.from(plainText, "utf-8")]),
    decryptString: (encrypted: Buffer) => {
      if (!encrypted.subarray(0, WRAP_MARKER.length).equals(WRAP_MARKER)) {
        throw new Error("fake safeStorage: unwrap failed");
      }
      return encrypted.subarray(WRAP_MARKER.length).toString("utf-8");
    },
  };
  return port;
}

interface Harness {
  store: ReturnType<typeof createPayswapPspKeyStore>;
  safeStorage: FakeSafeStorage;
  dir: string;
  keyStorePath: string;
  reads: string[];
  writes: { path: string; data: Buffer }[];
}

const createdDirs: string[] = [];

function buildHarness(): Harness {
  const safeStorage = createFakeSafeStorage();
  const dir = mkdtempSync(join(tmpdir(), "payswap-psp-key-store-"));
  createdDirs.push(dir);
  const keyStorePath = join(dir, PAYSWAP_PSP_KEY_STORE_FILE_NAME);
  const reads: string[] = [];
  const writes: { path: string; data: Buffer }[] = [];
  const store = createPayswapPspKeyStore({
    safeStorage,
    resolveKeyStorePath: () => keyStorePath,
    readFile: async (path) => {
      reads.push(path);
      try {
        return await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    writeFile: async (path, data) => {
      writes.push({ path, data });
      await writeFile(path, data, { mode: 0o600 });
    },
  });
  return { store, safeStorage, dir, keyStorePath, reads, writes };
}

afterAll(async () => {
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("payswap PSP key store (Gate E2 desktop arm) — safeStorage-backed key", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it("首次 ensure：生成 64-hex 随机键；文件只含 safeStorage 包裹产物；0600 私有", async () => {
    const key = await harness.store.ensureUnwrappedKey();

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // 文件存在，且内容恰好是 safeStorage.encryptString(key) 的产物 —— 仓不添加
    // 任何明文、元数据或 fallback 派生物。
    const onDisk = await readFile(harness.keyStorePath);
    expect(onDisk.equals(harness.safeStorage.encryptString(key))).toBe(true);
    // 仓的唯一落盘产物就是包裹字节：恰一次写、写的就是包裹产物、没有第二份
    // （明文键的不可落盘是真实 safeStorage 的密码学属性 —— fake 是透明包裹，
    // 断言只能钉住「仓自己从不写明文」，见文件头注释）。
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]!.path).toBe(harness.keyStorePath);
    expect(harness.writes[0]!.data.equals(onDisk)).toBe(true);
    // 0600 私有模式（posix；Windows 跳过）。
    if (process.platform !== "win32") {
      const mode = (await stat(harness.keyStorePath)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("重复 ensure 与并发 ensure：同一键；memoized 路径不再读盘；并发恰一次落盘", async () => {
    const [a, b] = await Promise.all([
      harness.store.ensureUnwrappedKey(),
      harness.store.ensureUnwrappedKey(),
    ]);
    expect(a).toBe(b);
    expect(harness.writes).toHaveLength(1);

    const again = await harness.store.ensureUnwrappedKey();
    expect(again).toBe(a);
    // memoized：第三次 ensure 不再读盘（并发窗口内恰一次读 + 零追加）。
    expect(harness.reads).toHaveLength(1);
    const readsAfter = harness.reads.length;
    const peeked = harness.store.peekUnwrappedKey();
    expect(peeked).toBe(a);
    expect(harness.reads.length).toBe(readsAfter);
    // 真正的文件字节与唯一一次写一致（没有第二次覆盖写）。
    const onDisk = await readFile(harness.keyStorePath);
    expect(onDisk.equals(harness.writes[0]!.data)).toBe(true);
  });

  it("safeStorage 不可用 → null；不建文件；可用性恢复后可再试（null 不被 memoize）", async () => {
    harness.safeStorage.setAvailable(false);

    expect(await harness.store.ensureUnwrappedKey()).toBeNull();
    await expect(readFile(harness.keyStorePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(harness.writes).toHaveLength(0);

    // 可用性翻转（例如 app-ready 后重试）→ 正常建键。
    harness.safeStorage.setAvailable(true);
    const key = await harness.store.ensureUnwrappedKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("包裹键解不开（钥匙串更换/损坏）→ typed unwrap 失败；文件不被重写（无静默轮换）", async () => {
    const firstKey = await harness.store.ensureUnwrappedKey();
    // 新仓实例（memoize 不跨实例）读被污染的文件。
    const safeStorage2 = createFakeSafeStorage();
    const store2 = createPayswapPspKeyStore({
      safeStorage: safeStorage2,
      resolveKeyStorePath: () => harness.keyStorePath,
      readFile: async (path) => {
        try {
          return await readFile(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      writeFile: async (path, data) => {
        await writeFile(path, data, { mode: 0o600 });
      },
    });
    await writeFile(harness.keyStorePath, Buffer.from("not-wrapped-by-this-keychain"));

    await expect(store2.ensureUnwrappedKey()).rejects.toSatisfy(
      isPayswapPspKeyUnwrapFailedError,
    );
    // 文件字节原样保留（不轮换、不清理 —— 重连/重置语义归 P2.2 连接 UI）。
    const onDisk = await readFile(harness.keyStorePath);
    expect(onDisk.toString("utf-8")).toBe("not-wrapped-by-this-keychain");
    // 原仓的 memoized 键不受影响（进程内已解包的键继续可用）。
    expect(harness.store.peekUnwrappedKey()).toBe(firstKey);
  });

  it("buildPayswapPspHostEnv：null → 空对象；键 → 单一 ZCODE_PAYSWAP_PSP_KEY 交付", () => {
    expect(buildPayswapPspHostEnv(null)).toEqual({});
    const key = "b".repeat(64);
    expect(buildPayswapPspHostEnv(key)).toEqual({
      [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: key,
    });
  });
});
