/**
 * PaySwap P2 —— Gate E2：desktop safeStorage PSP 键仓（addendum §5.2 desktop 行
 * 「safeStorage-backed cipher — the migration the source itself names」；§5.2 的
 * backend 精确化 = pspSafeStorageBackendPolicy —— 架构师评审 2026-11-14
 * Blocker A 的键仓边界证明）。
 *
 * desktop main（唯一能访问 Electron safeStorage 的进程）持有 PSP cipher 的随机
 * 32 字节键：
 * - **at-rest**：键文件只含 safeStorage 包裹产物（OS 钥匙串外的任何读者都拿不到
 *   键明文）；0600 私有模式；永不落明文或 fallback 派生物。
 * - **交付（ADR-P2-2 Decision 2/5）**：解包后的键经 buildPayswapPspHostEnv 组装为
 *   `ZCODE_PAYSWAP_PSP_KEY`，作为 desktop main 内账户运行时的进程内 env 视图
 *   （键与 PSP 密文不出 main 进程；不再跨进程交付 host）。
 * - **fail-closed 两级**：safeStorage 不可用 → null；Linux 后端不在认可闭集
 *   （basic_text / unknown / 未知名）→ null —— 两级都拒绝先于任何读/写。
 * - **首写往返验证**：fresh 包裹产物解不回原键 = 不可用（不落盘、可重试）。
 * - **无静默轮换**：包裹键解不开（OS 钥匙串更换/迁移）→ typed
 *   `PAYSWAP_PSP_KEY_UNWRAP_FAILED`，不静默轮换（轮换会让既有 PSP 密文永久
 *   失联 —— 重连语义归 P2.2 连接 UI）。
 * - **并发**：ensure 串行化（in-flight 去重）—— 两个并发 ensure 得到同一键、
 *   恰一次落盘。
 *
 * fake safeStorage 只证明「仓只持久化 safeStorage 产物、且经它往返」；at-rest
 * 的密码学强度是真实 safeStorage 的属性（钥匙串外不可解）。后端政策的纯函数
 * 全矩阵见 payswap-psp-storage-backend-policy.test.ts；本文件是**键仓边界**
 * （真实 createPayswapPspKeyStore + 真实 fs 落盘路径）的证明 —— 不是仅模拟
 * isEncryptionAvailable() === false 的单级测试。
 */

import { mkdtempSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPayswapPspHostEnv,
  createPayswapPspKeyStore,
  PAYSWAP_PSP_KEY_STORE_FILE_NAME,
  type PayswapPspKeyStoreDependencies,
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
  backend: string;
  /** throwOnBackendQuery = true 时 getSelectedStorageBackend 抛错（非 Linux 平台「永不查询」的哨兵）。 */
  throwOnBackendQuery: boolean;
  setAvailable(value: boolean): void;
  setBackend(value: string): void;
}

function createFakeSafeStorage(): FakeSafeStorage {
  const port: FakeSafeStorage = {
    available: true,
    backend: "gnome_libsecret",
    throwOnBackendQuery: false,
    setAvailable(value: boolean) {
      port.available = value;
    },
    setBackend(value: string) {
      port.backend = value;
    },
    isEncryptionAvailable: () => port.available,
    getSelectedStorageBackend: () => {
      if (port.throwOnBackendQuery) {
        throw new Error("getSelectedStorageBackend must not be consulted off linux");
      }
      return port.backend;
    },
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

/** 往返坏后端：fresh 包裹产物解不回（throw 或错值 —— 首写往返验证的被测对象）。 */
function createRoundTripBrokenSafeStorage(mode: "throw" | "wrong-value"): FakeSafeStorage {
  const port = createFakeSafeStorage();
  port.decryptString = (_encrypted: Buffer) => {
    if (mode === "throw") throw new Error("fake safeStorage: round-trip broken");
    return "wrong-value-not-the-key";
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

function buildHarness(
  options?: Partial<Pick<PayswapPspKeyStoreDependencies, "safeStorage" | "platform">>,
): Harness {
  const safeStorage = options?.safeStorage ?? createFakeSafeStorage();
  const dir = mkdtempSync(join(tmpdir(), "payswap-psp-key-store-"));
  createdDirs.push(dir);
  const keyStorePath = join(dir, PAYSWAP_PSP_KEY_STORE_FILE_NAME);
  const reads: string[] = [];
  const writes: { path: string; data: Buffer }[] = [];
  const store = createPayswapPspKeyStore({
    safeStorage,
    platform: options?.platform ?? "linux",
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
      platform: "linux",
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

describe("payswap PSP key store — Gate E2 backend policy at the key-store boundary (Blocker A)", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it("linux basic_text（available=true）：null；拒绝先于任何读/写（reads/writes 双零）；后端恢复后可再试", async () => {
    // basic_text 是硬编码密码后端（Electron 未识别桌面环境 / --password-store=basic）
    // —— isEncryptionAvailable() 在该后端可为 true，但不是 OS 钥匙串保护。
    harness.safeStorage.setBackend("basic_text");

    expect(await harness.store.ensureUnwrappedKey()).toBeNull();
    // 拒绝先于任何读/写：文件缺席、零读、零写、不 memoize。
    await expect(readFile(harness.keyStorePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(harness.reads).toHaveLength(0);
    expect(harness.writes).toHaveLength(0);
    expect(harness.store.peekUnwrappedKey()).toBeNull();

    // 后端翻回认可集（如 DE 被识别 / 钥匙串服务上线）→ 正常建键（null 不 memoize）。
    harness.safeStorage.setBackend("gnome_libsecret");
    const key = await harness.store.ensureUnwrappedKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("linux unknown（app ready 前）：null；零读零写 —— 未初始化后端不可证明 OS 钥匙串保护", async () => {
    harness.safeStorage.setBackend("unknown");

    expect(await harness.store.ensureUnwrappedKey()).toBeNull();
    await expect(readFile(harness.keyStorePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(harness.reads).toHaveLength(0);
    expect(harness.writes).toHaveLength(0);
  });

  it("linux 未认可后端名（未来的未知名）：null —— 认可闭集外的任何字符串 fail-closed", async () => {
    harness.safeStorage.setBackend("some_future_backend");

    expect(await harness.store.ensureUnwrappedKey()).toBeNull();
    expect(harness.writes).toHaveLength(0);
  });

  it("linux kwallet6（认可集成员）：正常建键 —— KWallet 家族与 gnome_libsecret 同列认可闭集", async () => {
    harness.safeStorage.setBackend("kwallet6");
    const key = await harness.store.ensureUnwrappedKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(harness.writes).toHaveLength(1);
  });

  it("darwin：正常建键且永不查询后端名（Linux-only API —— 查询即哨兵抛错）", async () => {
    const macHarness = buildHarness({ platform: "darwin" });
    macHarness.safeStorage.throwOnBackendQuery = true; // 若被查询 → 抛错 → 测试失败
    const key = await macHarness.store.ensureUnwrappedKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(macHarness.writes).toHaveLength(1);
  });

  it("win32：正常建键且永不查询后端名（DPAPI 的 OS 保护由 isEncryptionAvailable 门住）", async () => {
    const winHarness = buildHarness({ platform: "win32" });
    winHarness.safeStorage.throwOnBackendQuery = true;
    const key = await winHarness.store.ensureUnwrappedKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(winHarness.writes).toHaveLength(1);
  });

  it("未支持平台（如 freebsd）：fail-closed —— null、零写（safeStorage 不支持的平台不持 PSP 键）", async () => {
    const bsdHarness = buildHarness({ platform: "freebsd" });
    expect(await bsdHarness.store.ensureUnwrappedKey()).toBeNull();
    expect(bsdHarness.writes).toHaveLength(0);
  });

  it("linux 既有键文件 + 后端退化为 basic_text：null（不尝试解包 —— 硬编码密码不是既有键的保护者）", async () => {
    const key = await harness.store.ensureUnwrappedKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // 新仓实例（进程重启语义）+ 后端退化（DE 变更/钥匙串服务消失）。
    harness.safeStorage.setBackend("basic_text");
    const degradedReads: string[] = [];
    const degradedStore = createPayswapPspKeyStore({
      safeStorage: harness.safeStorage,
      platform: "linux",
      resolveKeyStorePath: () => harness.keyStorePath,
      readFile: async (path) => {
        degradedReads.push(path);
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
    // 拒绝先于读：既有文件存在也不读（policy 检查在 readFile 之前）。
    expect(await degradedStore.ensureUnwrappedKey()).toBeNull();
    expect(degradedReads).toHaveLength(0);
  });
});

describe("payswap PSP key store — first-write round-trip verification (fresh-blob gate)", () => {
  it("fresh 包裹产物解不开（throw）→ null：不落盘、不 memoize；后端修复后可再试", async () => {
    const broken = createRoundTripBrokenSafeStorage("throw");
    const harness = buildHarness({ safeStorage: broken });

    expect(await harness.store.ensureUnwrappedKey()).toBeNull();
    await expect(readFile(harness.keyStorePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(harness.writes).toHaveLength(0);
    expect(harness.store.peekUnwrappedKey()).toBeNull();

    // 修复（后端恢复正常往返）→ 重试成功（null 不 memoize）。
    const fixed = createFakeSafeStorage();
    const fixedHarness = buildHarness({ safeStorage: fixed });
    expect(await fixedHarness.store.ensureUnwrappedKey()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fresh 包裹产物解出错误值（非 throw）→ null：不落盘 —— 往返必须逐字节等于原键", async () => {
    const broken = createRoundTripBrokenSafeStorage("wrong-value");
    const harness = buildHarness({ safeStorage: broken });

    expect(await harness.store.ensureUnwrappedKey()).toBeNull();
    await expect(readFile(harness.keyStorePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(harness.writes).toHaveLength(0);
  });

  it("健康后端的 fresh 往返（既有默认路径）持续成立：落盘的包裹产物可被同一后端解回（对称性）", async () => {
    const harness = buildHarness();
    const key = await harness.store.ensureUnwrappedKey();
    const onDisk = await readFile(harness.keyStorePath);
    expect(harness.safeStorage.decryptString(onDisk)).toBe(key);
  });
});
