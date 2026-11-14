/**
 * PaySwap PSP 凭据安全存储法则（addendum §5.2 Gate E2 —— 平台级凭据安全；
 * playbook P2「write Gate E2 tests first」）。
 *
 * 法则（normative，addendum §5.2 原文）：
 * - **Source fact**：`ZCODE_CREDENTIAL_SECRET` 缺席时，上游 cipher key 由公开数据
 *   确定性派生（`zcode-credential-fallback:${platform()}:${homedir()}:${username}`
 *   —— credentialCipherProvider 的 defaultCredentialSecret）。公开派生不是秘密：
 *   任何拿到 store 文件的人（备份、同步目录、同机其它进程）都能解密。PSP
 *   （payment service provider）凭据绝不允许落在这个派生键下。
 * - **决策表（per-platform，§5.2 原表）**：
 *   | Host | PSP 凭据存储要求 |
 *   |---|---|
 *   | Electron desktop | safeStorage 包裹的 cipher（OS 钥匙串包裹加密键 —— 源注释自己命名的迁移） |
 *   | Server / remote | `ZCODE_CREDENTIAL_SECRET`（真实 secret manager）—— 必需，非可选 |
 *   | 两者皆无 | **fail-closed**：拒绝存储 PSP 凭据（typed error；连接 UI 呈现） |
 * - **键命名空间**：`payswap:psp:*` 是 PSP 凭据键的权威命名空间（「the
 *   deterministic fallback is never used for `payswap:psp:*` keys」）。前缀精确
 *   `payswap:psp:`（`payswap:psp` 无尾冒号、`payswap:pspx:*` 等不在命名空间内）；
 *   退化空段（`payswap:psp:`）视为在命名空间内 —— fail-closed，宁可拒绝存储。
 * - **优先级**：desktop 上 safeStorage 键与 secret 同时在位时取 safe_storage
 *   （§5.2 表的 desktop 行是 OS 钥匙串；secret 是 server 行的要求 —— 按 host 取
 *   平台适当的那一个）。
 * - **交付通道（desktop）**：safeStorage 只存在于 Electron main；host 进程
 *   （utilityProcess，凭据服务的家）经 host env 键 `ZCODE_PAYSWAP_PSP_KEY`
 *   收到 main 解包后的随机键（hostProcessLocalEnv 通道 —— BIGMODEL_OAuth_APP_SECRET
 *   同款纪律：只交付 host，不进 renderer、不进 agent 子进程）。desktop main 的
 *   键仓实现住 desktop-payswap（pspCredentialKeyStore.ts）；services 侧凭本模块
 *   的 env 键常量读取。两侧引用同一常量 —— 永不漂移。
 * - **两类 typed 失败不重叠**：存储不可用（`PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE`
 *   —— 既无 safeStorage 键也无 secret，fail-closed 拒绝）与键仓解包失败
 *   （`PAYSWAP_PSP_KEY_UNWRAP_FAILED` —— OS 钥匙串更换/迁移后包裹键解不开；
 *   不静默轮换 —— 轮换会让既有 PSP 密文永久失联，重连语义归 P2.2 连接 UI）。
 *
 * 证明两级：法则级行（本模块决策表全行 + 命名空间矩阵 + typed 形状）住
 * bootstrap/tests/payswap-credential-security.test.ts；真实凭据库行（services）
 * 与 desktop safeStorage 键仓行住各自包内同名套件。
 */

/**
 * PSP 凭据键的权威命名空间前缀（§5.2：「`payswap:psp:*` keys」）。前缀精确匹配；
 * 键名其余段由 provider 域自由使用（如 `payswap:psp:stripe`）。
 */
export const PAYSWAP_PSP_CREDENTIAL_KEY_PREFIX = "payswap:psp:" as const;

/**
 * 键是否落在 PSP 凭据命名空间（`payswap:psp:*`）。前缀精确 `payswap:psp:`；
 * `payswap:psp`（无尾冒号）与 `payswap:pspx:*` 不在命名空间内（上游键与其它
 * payswap 键一律不受 PSP 政策影响 —— preservation 的键面边界）。
 */
export function isPayswapPspCredentialKey(key: string): boolean {
  return key.startsWith(PAYSWAP_PSP_CREDENTIAL_KEY_PREFIX);
}

/**
 * desktop main → host 进程交付 safeStorage 解包键的 host env 键（单一事实源：
 * 写侧 desktop-payswap 键仓、读侧 services 凭据服务共用本常量）。
 */
export const PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY = "ZCODE_PAYSWAP_PSP_KEY" as const;

/** §5.2 per-platform 决策表的输出。 */
export type PayswapPspCredentialStoragePolicy =
  /** desktop 行：safeStorage 包裹键在位（OS 钥匙串保护的随机键）。 */
  | "safe_storage"
  /** server 行：`ZCODE_CREDENTIAL_SECRET` 在位（真实 secret manager）。 */
  | "secret"
  /** neither 行：拒绝存储 PSP 凭据（fail-closed typed 拒绝）。 */
  | "fail_closed";

/** 决策表输入（services 侧按 env 事实组装；desktop main 按键仓结果组装）。 */
export interface PayswapPspCredentialStoragePolicyInput {
  /**
   * safeStorage 键是否在位（desktop main 已证明 safeStorage 可用并交付了随机键 ——
   * services 侧的形态是 env `ZCODE_PAYSWAP_PSP_KEY` 非空）。
   */
  safeStorageKeyConfigured: boolean;
  /** `ZCODE_CREDENTIAL_SECRET` 是否在位（server / remote 部署的必需通道）。 */
  credentialSecretConfigured: boolean;
}

/**
 * §5.2 决策表（全行）：
 * safeStorage 键在位 → safe_storage（desktop 行；OS 钥匙串优先于 secret —— 按
 * host 取平台适当的通道）；否则 secret 在位 → secret（server 行）；否则
 * fail_closed（neither 行 —— 确定性 fallback 派生键对 PSP 键永不可用）。
 */
export function resolvePayswapPspCredentialStoragePolicy(
  input: PayswapPspCredentialStoragePolicyInput,
): PayswapPspCredentialStoragePolicy {
  if (input.safeStorageKeyConfigured) {
    return "safe_storage";
  }
  if (input.credentialSecretConfigured) {
    return "secret";
  }
  return "fail_closed";
}

/** fail-closed 拒绝码（§5.2 neither 行的 typed 拒绝 —— 连接 UI / 账户服务消费）。 */
export const PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE_CODE =
  "PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE" as const;

export interface PayswapPspSecureStorageUnavailableError extends Error {
  code: typeof PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE_CODE;
}

/**
 * fail-closed typed 拒绝：既无 safeStorage 键也无 secret 时，PSP 凭据的
 * save/load 一律以此拒绝（确定性 fallback 派生键对 `payswap:psp:*` 键永不可用）。
 */
export function createPayswapPspSecureStorageUnavailableError(): PayswapPspSecureStorageUnavailableError {
  return Object.assign(
    new Error(
      "PSP credentials require platform-secure storage (desktop safeStorage or ZCODE_CREDENTIAL_SECRET); the deterministic fallback is never used for payswap:psp:* keys",
    ),
    { code: PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE_CODE },
  );
}

/** 类型守卫（code 精确匹配；永不字符串匹配 message）。 */
export function isPayswapPspSecureStorageUnavailableError(error: unknown): error is PayswapPspSecureStorageUnavailableError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE_CODE
  );
}

/**
 * 键仓解包失败码（desktop safeStorage 包裹键解不开 —— OS 钥匙串更换/迁移后的
 * 有界失败；与存储不可用是两类不同的 typed 失败，code 不重叠）。
 */
export const PAYSWAP_PSP_KEY_UNWRAP_FAILED_CODE = "PAYSWAP_PSP_KEY_UNWRAP_FAILED" as const;

export interface PayswapPspKeyUnwrapFailedError extends Error {
  code: typeof PAYSWAP_PSP_KEY_UNWRAP_FAILED_CODE;
}

/** 键仓解包失败 typed 错误（desktop-payswap 的 pspCredentialKeyStore 抛出）。 */
export function createPayswapPspKeyUnwrapFailedError(cause?: unknown): PayswapPspKeyUnwrapFailedError {
  return Object.assign(
    new Error(
      "The safeStorage-wrapped PSP key could not be unwrapped (OS keychain changed or the wrapped-key file is damaged); no silent rotation — reconnect semantics belong to the connection UI",
      cause !== undefined ? { cause } : {},
    ),
    { code: PAYSWAP_PSP_KEY_UNWRAP_FAILED_CODE },
  );
}

/** 类型守卫（code 精确匹配）。 */
export function isPayswapPspKeyUnwrapFailedError(error: unknown): error is PayswapPspKeyUnwrapFailedError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === PAYSWAP_PSP_KEY_UNWRAP_FAILED_CODE
  );
}

/**
 * 组装交付 host 进程的 PSP 键 env（desktop main → spawnHostProcess 的
 * hostProcessLocalEnv 通道）。null/空键 → 空对象（fail-closed：不注入即拒）；
 * 键在位 → 恰一个 env 条目（单一交付通道，无旁路）。
 */
export function buildPayswapPspHostEnv(unwrappedKey: string | null): Record<string, string> {
  const key = unwrappedKey?.trim();
  if (!key) {
    return {};
  }
  return { [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: key };
}
