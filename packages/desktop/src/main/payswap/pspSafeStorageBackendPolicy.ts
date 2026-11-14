/**
 * PaySwap P2 —— Gate E2 desktop 行的 Linux safeStorage 后端政策（addendum §5.2
 * 的 backend 精确化；架构师评审 2026-11-14 Blocker A 的法则模块）。
 *
 * 为什么 `isEncryptionAvailable()` 不充分（Electron 44.7.0 文档/类型的事实）：
 * - Linux 上 Electron 可以选择 `basic_text` 后端 —— 未识别的桌面环境，或显式
 *   `--password-store="basic"`。该后端用**硬编码明文密码**保护数据（Chromium
 *   OSCrypt 的 "peanuts" 家族），不是 OS 钥匙串 —— addendum §5.2 的决策表要求
 *   「OS keychain wraps the encryption key」，`basic_text` 不满足该要求。
 * - `isEncryptionAvailable()` 在 Linux 语义为「app 已 ready 且 secret key 可用」
 *   —— `basic_text` 的内存密码恒「可用」，因此该检查**不能**区分 OS 钥匙串保护
 *   与硬编码密码保护。区分的唯一 API 是 `getSelectedStorageBackend()`
 *   （Linux-only；Electron ≥15）。
 * - `unknown` = app ready 之前调用（后端未初始化）—— 同样不可证明 OS 钥匙串在
 *   保护，fail-closed 拒绝。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **Linux 认可闭集**：仅 `gnome_libsecret`、`kwallet`、`kwallet5`、`kwallet6`
 *    （Electron 44 类型的 Linux 后端全集减去 `basic_text` 与 `unknown`）。
 *    任何其它字符串（含未来的未知名）= 不认可 —— 新后端名必须经本法则的显式
 *    增补 + 测试矩阵扩展才能进入认可集。
 * 2. **macOS/Windows 不查后端名**：`getSelectedStorageBackend()` 是 Linux-only
 *    API（类型标注 `@platform linux`）；两平台的 OS 保护（Keychain / DPAPI）由
 *    `isEncryptionAvailable()` 门住即可。调用方不得在非 Linux 平台查询后端名。
 * 3. **其余平台 fail-closed**：Electron safeStorage 不支持的平台不持 PSP 键。
 * 4. **纯函数**：本模块无 IO、无 Electron import —— 平台与后端名都是注入值，
 *    法则级测试可做全矩阵。
 *
 * Electron 45+ 兼容注记：同步 safeStorage API 自 45 起标记弃用（异步
 * `isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync` 为
 * 继任）。本政策函数接受**字符串后端名**，不绑同步/异步 API 形态 —— 未来的异步
 * 适配只需把后端名的取得方式换成异步来源，credential-security 契约零改动。
 */

/**
 * Linux 认可的安全后端闭集（Electron 44 `SafeStorageBackend` 的 Linux 成员减去
 * `basic_text` 与 `unknown`；`kwallet` = kde4 时代的旧名，保留认可以免误拒
 * 老桌面 —— 与 Electron 自己的接受表一致）。
 */
export const PAYSWAP_PSP_SECURE_LINUX_STORAGE_BACKENDS: ReadonlySet<string> =
  new Set(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]);

/**
 * 平台感知的存储后端政策裁决：当前选定后端是否构成 addendum §5.2 要求的
 * 「OS 钥匙串保护」。
 *
 * @param platform 进程平台（真实装配 = `process.platform`；测试注入显式值）。
 * @param selectedBackend Linux 上 `safeStorage.getSelectedStorageBackend()` 的
 *   返回值；**非 Linux 平台不查询、传 `undefined`**（法则 2 —— API 是
 *   Linux-only，调用方不得在其它平台触碰它）。
 * @returns true = 认可（可建/读 PSP 包裹键）；false = fail-closed 拒绝（与
 *   「safeStorage 不可用」同判 —— 上游呈现 typed
 *   `PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE`）。
 */
export function isSecurePayswapPspStorageBackendSelection(
  platform: string,
  selectedBackend: string | null | undefined,
): boolean {
  switch (platform) {
    case "linux":
      return (
        typeof selectedBackend === "string" &&
        PAYSWAP_PSP_SECURE_LINUX_STORAGE_BACKENDS.has(selectedBackend)
      );
    // Keychain / DPAPI：OS 保护由 isEncryptionAvailable 门住；后端名不适用
    // （Linux-only API —— 见法则 2）。
    case "darwin":
    case "win32":
      return true;
    // 其余平台：fail-closed（法则 3）。
    default:
      return false;
  }
}
