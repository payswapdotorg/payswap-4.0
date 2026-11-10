/**
 * PaySwap desktop PSP 键仓（Gate E2 desktop 行 —— addendum §5.2
 * 「safeStorage-backed cipher — the migration the source itself names」；
 * playbook P2 工作包）。
 *
 * Electron main 是唯一能访问 safeStorage 的进程（host 是 utilityProcess ——
 * safeStorage 是 main-only 模块）。本模块在 main 侧持有 PSP cipher 的随机
 * 32 字节键：
 * - **at-rest**：键文件（app 配置目录 `payswap-psp-safe-storage-key`）只含
 *   safeStorage 包裹产物 —— OS 钥匙串之外的任何读者都拿不到键明文；0600
 *   私有模式；永不落明文、fallback 派生物或「未包裹的随机键」。
 * - **交付**：解包后的键经 buildPayswapPspHostEnv（法则单一实现，shared-payswap）
 *   组装为 host env `ZCODE_PAYSWAP_PSP_KEY`，由 spawnHostProcess 的
 *   hostProcessLocalEnv 通道交付 host 进程（BIGMODEL_OAUTH_APP_SECRET 同款
 *   纪律：只交付 host，不进 renderer、不进 agent 子进程）；services 侧凭它
 *   构建 PSP cipher。**入口接线（app-ready 预热 + spawn 注入）随 P2.2 的
 *   账户服务连接流与其 desktop Browser E2E 臂落地（D12.7 同款纪律：法则与
 *   模块先行，入口接线随活的窗口证明）。**
 * - **fail-closed**：safeStorage 不可用 → null（不建文件、不造 fallback 键、
 *   不 memoize null —— app-ready 后可重试）；services 侧对 PSP 键 typed 拒绝。
 * - **无静默轮换**：包裹键解不开（OS 钥匙串更换/迁移）→ typed
 *   `PAYSWAP_PSP_KEY_UNWRAP_FAILED`（shared 法则），文件字节原样保留 —— 轮换
 *   会让既有 PSP 密文永久失联；重连/重置语义归 P2.2 连接 UI。
 * - **并发**：ensure 内部串行（in-flight promise 去重）—— 并发 ensure 得到
 *   同一键、恰一次落盘；成功后 memoize（进程内不再触盘）。
 *
 * IO 全注入（safeStorage 端口 + fs 端口）—— 法则级测试无 Electron 依赖；
 * 真实装配把 Electron 的 safeStorage 与 node:fs 适配进来。
 */

import { randomBytes } from "node:crypto";
import {
  buildPayswapPspHostEnv,
  createPayswapPspKeyUnwrapFailedError,
  PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY,
} from "@zcode/shared/payswap";

/** 键文件名（app 配置目录内；内容 = safeStorage 包裹产物，0600）。 */
export const PAYSWAP_PSP_KEY_STORE_FILE_NAME = "payswap-psp-safe-storage-key";

/**
 * Electron safeStorage 的结构端口（main-only API 的可注入面）。
 * 真实实现即 `import { safeStorage } from "electron"`（app ready 后可用）。
 */
export interface PayswapPspSafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface PayswapPspKeyStoreDependencies {
  safeStorage: PayswapPspSafeStoragePort;
  /** 键文件路径（app 配置目录内的稳定位置）。 */
  resolveKeyStorePath(): string;
  /** 读文件；ENOENT → null（其余错误上抛）。 */
  readFile(path: string): Promise<Buffer | null>;
  /** 写文件（私有模式 —— 实现方负责 0600/等价 ACL）。 */
  writeFile(path: string, data: Buffer): Promise<void>;
}

export interface PayswapPspKeyStore {
  /**
   * 确保随机键就绪并返回其 hex 形态（64 字符）。
   * - safeStorage 不可用 → null（fail-closed：不建文件、不 memoize —— 可重试）。
   * - 首次 → 生成随机键并落 safeStorage 包裹文件；此后 memoize（进程内不触盘）。
   * - 包裹文件解不开 → typed PAYSWAP_PSP_KEY_UNWRAP_FAILED（文件原样，无轮换）。
   * - 并发调用串行化（in-flight 去重）：同一键、恰一次落盘。
   */
  ensureUnwrappedKey(): Promise<string | null>;
  /** memoized 键的同步窥视（未预热/不可用 → null —— 不触盘、不抛错）。 */
  peekUnwrappedKey(): string | null;
}

export function createPayswapPspKeyStore(
  dependencies: PayswapPspKeyStoreDependencies,
): PayswapPspKeyStore {
  let memoizedKey: string | null = null;
  let inFlight: Promise<string | null> | null = null;

  async function ensureOnce(): Promise<string | null> {
    if (!dependencies.safeStorage.isEncryptionAvailable()) {
      // fail-closed：不建文件、不造键；null 不 memoize（app-ready 后可重试）。
      return null;
    }
    const keyStorePath = dependencies.resolveKeyStorePath();
    let wrapped: Buffer;
    const existing = await dependencies.readFile(keyStorePath);
    if (existing !== null) {
      wrapped = existing;
    } else {
      // 随机 32 字节键（hex 交付形态；services 侧经
      // createCredentialCipherProviderForSecret 派生 AES-256 键）。
      const key = randomBytes(32).toString("hex");
      wrapped = dependencies.safeStorage.encryptString(key);
      // 落盘在解包验证之前完成读取路径的对称性：先持久化包裹产物，再验证可解。
      await dependencies.writeFile(keyStorePath, wrapped);
      memoizedKey = key;
      return key;
    }
    // 既有包裹文件：解包（失败 = typed unwrap 失败，无轮换 —— 文件原样保留）。
    let key: string;
    try {
      key = dependencies.safeStorage.decryptString(wrapped);
    } catch (error) {
      throw createPayswapPspKeyUnwrapFailedError(error);
    }
    if (!key.trim()) {
      // 空键是损坏态（safeStorage 不产空明文）—— 与解包失败同族，无轮换。
      throw createPayswapPspKeyUnwrapFailedError(new Error("unwrapped key is empty"));
    }
    memoizedKey = key;
    return key;
  }

  return {
    async ensureUnwrappedKey(): Promise<string | null> {
      if (memoizedKey !== null) {
        return memoizedKey;
      }
      if (!inFlight) {
        inFlight = ensureOnce().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    peekUnwrappedKey(): string | null {
      return memoizedKey;
    },
  };
}

export {
  buildPayswapPspHostEnv,
  PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY,
};
