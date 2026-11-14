/**
 * PaySwap desktop PSP 键仓（Gate E2 desktop 行 —— addendum §5.2
 * 「safeStorage-backed cipher — the migration the source itself names」；
 * playbook P2 工作包；§5.2 的 backend 精确化见 pspSafeStorageBackendPolicy.ts）。
 *
 * Electron main 是唯一能访问 safeStorage 的进程（账户运行时也住 main ——
 * ADR-P2-2 Decision 1；safeStorage 是 main-only 模块）。本模块在 main 侧持有
 * PSP cipher 的随机 32 字节键：
 * - **at-rest**：键文件（app 配置目录 `payswap-psp-safe-storage-key`）只含
 *   safeStorage 包裹产物 —— OS 钥匙串之外的任何读者都拿不到键明文；0600
 *   私有模式；永不落明文、fallback 派生物或「未包裹的随机键」。
 * - **交付（ADR-P2-2 Decision 2/5 —— 旧 host-env 交付已取代）**：解包后的键
 *   经 buildPayswapPspHostEnv（法则单一实现，shared-payswap）组装为
 *   `ZCODE_PAYSWAP_PSP_KEY`，作为**进程内 env 视图**注入 desktop main 自己的
 *   账户运行时（accountRuntimeWiring 法则 2 —— 恰 warmup 产物，不携带
 *   process.env 其它键）。键与 PSP 密文**永不**渡经 host/agent 进程（host 只
 *   见法则投影；`ZCODE_PAYSWAP_PSP_KEY` 不进 host env —— host 侧无消费者）。
 * - **fail-closed（两级）**：①safeStorage 不可用 → null；②Linux 后端不在
 *   认可闭集（`basic_text` / `unknown` / 未知名 —— 硬编码密码不是 OS 钥匙串
 *   保护）→ null。两级都不建文件、不造 fallback 键、不 memoize null
 *   （app-ready 后可重试）；services 侧对 PSP 键 typed 拒绝
 *   （`PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE` —— 拒绝先于任何键文件/凭据/
 *   连接记录写）。
 * - **首写往返验证**：新生成的键必须证明 wrap→unwrap 往返成立才落盘并生效
 *   （fail-safe：不能往返的后端 = 不可用 —— 不落盘、不 memoize；fresh blob
 *   无既有密文依赖，与既有文件的解包失败区分处理）。
 * - **无静默轮换**：包裹键解不开（OS 钥匙串更换/迁移）→ typed
 *   `PAYSWAP_PSP_KEY_UNWRAP_FAILED`（shared 法则），文件字节原样保留 —— 轮换
 *   会让既有 PSP 密文永久失联；重连/重置语义归 P2.2 连接 UI。
 * - **并发**：ensure 内部串行（in-flight promise 去重）—— 并发 ensure 得到同一
 *   键、恰一次落盘；成功后 memoize（进程内不再触盘）。
 *
 * IO 全注入（safeStorage 端口 + fs 端口 + 平台值）—— 法则级测试无 Electron
 * 依赖；真实装配把 Electron 的 safeStorage、process.platform 与 node:fs
 * 适配进来。
 */

import { randomBytes } from "node:crypto";
import {
  buildPayswapPspHostEnv,
  createPayswapPspKeyUnwrapFailedError,
  PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY,
} from "@zcode/shared/payswap";
import { isSecurePayswapPspStorageBackendSelection } from "./pspSafeStorageBackendPolicy.js";

/** 键文件名（app 配置目录内；内容 = safeStorage 包裹产物，0600）。 */
export const PAYSWAP_PSP_KEY_STORE_FILE_NAME = "payswap-psp-safe-storage-key";

/**
 * Electron safeStorage 的结构端口（main-only API 的可注入面）。
 * 真实实现即 `import { safeStorage } from "electron"`（app ready 后可用）。
 *
 * `getSelectedStorageBackend()` 是 Linux-only API（Electron ≥15；44 的类型见
 * electron.d.ts —— 返回 `'basic_text' | 'gnome_libsecret' | 'kwallet' |
 * 'kwallet5' | 'kwallet6' | 'unknown'`）。本仓只在 linux 平台查询它（后端
 * 政策法则 2）；Electron 45+ 的异步 safeStorage 迁移不影响本端口的后端名契约。
 */
export interface PayswapPspSafeStoragePort {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface PayswapPspKeyStoreDependencies {
  safeStorage: PayswapPspSafeStoragePort;
  /** 进程平台（真实装配 = `process.platform`）—— 后端政策的裁决维度（Linux-only 查询）。 */
  platform: string;
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
   * - safeStorage 不可用，或 Linux 后端不在认可闭集（basic_text/unknown/未知名）
   *   → null（fail-closed：不建文件、不 memoize —— 可重试；拒绝先于任何读/写）。
   * - 首次 → 生成随机键，经 wrap→unwrap 往返验证后落 safeStorage 包裹文件；
   *   此后 memoize（进程内不触盘）。
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
      // fail-closed 第一级：不可用 → 不建文件、不造键；null 不 memoize（可重试）。
      return null;
    }
    if (
      !isSecurePayswapPspStorageBackendSelection(
        dependencies.platform,
        // Linux-only API（后端政策法则 2）—— 非 Linux 平台不查询后端名。
        dependencies.platform === "linux"
          ? dependencies.safeStorage.getSelectedStorageBackend()
          : undefined,
      )
    ) {
      // fail-closed 第二级：Linux basic_text/unknown/未知名（或未支持平台）——
      // 硬编码密码/未初始化后端不构成 §5.2 的 OS 钥匙串保护。与不可用同判：
      // 不建文件、不 memoize，可重试；拒绝先于任何读/写（边界测试钉 reads/writes
      // 双零）。
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
      // 首写往返验证（落盘前）：包裹产物必须可解回原键才生效 —— 不能往返的
      // 后端 = 不可用（fail-safe：不落盘、不 memoize、返回 null 可重试；fresh
      // blob 无既有密文依赖，与既有文件的 typed 解包失败区分 —— 落盘前验证，
      // 故无需清理路径）。
      let roundTrip: string;
      try {
        roundTrip = dependencies.safeStorage.decryptString(wrapped);
      } catch {
        return null;
      }
      if (roundTrip !== key) {
        return null;
      }
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
