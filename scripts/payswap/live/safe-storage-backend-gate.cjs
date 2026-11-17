"use strict";

/**
 * PaySwap P2 live harness —— safeStorage「真实 OS 钥匙串后端」的平台感知门
 * （环境就绪审计 2026-11-17 的收口模块）。
 *
 * 缺陷背景（本仓实测确认，登记于 docs/payswap/p2/environment-readiness-report.md）：
 * `main.cjs` 步骤 1 原先**无条件**调用 `safeStorage.getSelectedStorageBackend()`
 * —— 该 API 是 Electron 的 **Linux-only** 面（源码 `#if BUILDFLAG(IS_LINUX)` 编译
 * 期裁剪；Electron 44.7.0 的类型标注 `@platform linux`），win32/darwin 运行时上
 * 该方法不存在，调用即 `TypeError`。live harness 因此在原生 Windows 上**无法
 * 起步**——而生产键仓 `pspCredentialKeyStore.ts` 的同名查询早已按
 * `pspSafeStorageBackendPolicy.ts` 法则 2 平台门住（仅 linux 查询）。本模块把
 * 同一法则下沉为 harness 侧的可测纯函数。
 *
 * 法则（与 pspSafeStorageBackendPolicy.ts 对齐；违反即缺陷）：
 * 1. **linux = 后端名闭集**：`getSelectedStorageBackend()` 是区分真实 OS 钥匙串
 *    （gnome_libsecret/kwallet 族）与 `basic_text` 硬编码明文密码的**唯一** API
 *    —— linux 上必须查询且必须命中认可闭集（默认期望 gnome_libsecret；
 *    `ZCODE_PAYSWAP_LIVE_EXPECT_BACKEND` 可覆盖，用于 kwallet 腿）。
 * 2. **win32/darwin = isEncryptionAvailable 门**：两平台的 OS 保护（DPAPI /
 *    Keychain）由 `isEncryptionAvailable()` 门住即可；**不得**在非 Linux 平台
 *    触碰 `getSelectedStorageBackend()`（Linux-only API —— 调用方纪律，与生产
 *    键仓同一法则）。Windows 上**不存在**「后端名」API —— 不得发明一个。
 * 3. **其余平台 fail-closed**：Electron safeStorage 不支持的平台不承载 live
 *    实证（与生产政策法则 3 同判）。
 * 4. **纯函数 / IO 全注入**：safeStorage 端口与平台值注入 —— 法则级测试
 *    （safe-storage-backend-gate.test.mjs）无 Electron 依赖，win32 路径
 *    「永不调用 Linux-only API」是钉死的回归行。
 */

/** linux 缺省期望后端（与 vm 腿 recipe 一致：--password-store=gnome-libsecret）。 */
const LINUX_DEFAULT_EXPECTED_BACKEND = "gnome_libsecret";

/**
 * 平台感知的「真实 OS 钥匙串后端」断言（live 实证的硬前置）。
 *
 * @param {object} options
 * @param {Pick<Electron.SafeStorage, "isEncryptionAvailable" | "getSelectedStorageBackend" | "encryptString" | "decryptString">} options.safeStorage
 *   Electron safeStorage 结构端口（真实装配 = live Electron main 的 safeStorage）。
 * @param {string} options.platform 进程平台（真实装配 = `process.platform`）。
 * @param {string | undefined} [options.expectedBackend] linux 期望后端名
 *   （缺省 gnome_libsecret；win32/darwin 不消费 —— 无后端名 API，见法则 2）。
 * @returns {{ gate: "linux-backend-name" | "win32-dpapi-availability" | "darwin-keychain-availability", backendSelected: string | null }}
 *   结局事实（进证据 detail：gate = 本平台用了哪道门；backendSelected = linux
 *   实际后端名，非 linux 恒 null —— 不是「发明」的后端名）。
 * @throws {Error} 任一门未命中（fail-closed —— 与原步骤 1 的失败语义同族：
 *   抛出即步骤失败，live 实证不得在该环境上成立）。
 */
function assertLiveSafeStorageBackend(options) {
  const safeStorage = options.safeStorage;
  const platform = options.platform;
  const expectedBackend = options.expectedBackend;

  if (platform === "linux") {
    // 法则 1：后端名闭集（Linux-only API —— 只有 linux 允许且必须查询）。
    if (typeof safeStorage.getSelectedStorageBackend !== "function") {
      throw new Error(
        "safeStorage.getSelectedStorageBackend 在本 Linux 运行时不可用（Electron >= 15 方有该 API）—— 无法证明真实 OS 钥匙串后端",
      );
    }
    const backendSelected = safeStorage.getSelectedStorageBackend();
    const expected = expectedBackend || LINUX_DEFAULT_EXPECTED_BACKEND;
    if (backendSelected !== expected) {
      throw new Error(
        `safeStorage 后端为 '${backendSelected}'，期望 '${expected}' —— live 实证要求真实 OS 钥匙串后端（--password-store=gnome-libsecret + org.freedesktop.secrets 在场）`,
      );
    }
    return { gate: "linux-backend-name", backendSelected };
  }

  if (platform === "win32" || platform === "darwin") {
    // 法则 2：DPAPI/Keychain 的 OS 保护由 isEncryptionAvailable 门住；
    // getSelectedStorageBackend 是 Linux-only API —— 本分支**结构性不触碰**它
    // （回归测试以 throwing spy 钉死：任何回归性无条件调用立即红）。
    if (typeof safeStorage.isEncryptionAvailable !== "function") {
      throw new Error(
        `safeStorage.isEncryptionAvailable 在 ${platform} 上不可用 —— 非 Electron main 进程或运行时形态异常`,
      );
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        `safeStorage.isEncryptionAvailable() 为 false（${platform === "win32" ? "DPAPI" : "Keychain"} 不可用 —— live 实证要求 OS 级保护；Windows 上该值在 app ready 后应为 true，false 即异常态）`,
      );
    }
    return {
      gate: platform === "win32" ? "win32-dpapi-availability" : "darwin-keychain-availability",
      backendSelected: null,
    };
  }

  // 法则 3：其余平台 fail-closed（与生产后端政策法则 3 同判）。
  throw new Error(
    `不支持的平台 '${platform}' —— live 实证仅在 linux（gnome_libsecret）/ win32（DPAPI）/ darwin（Keychain）上成立`,
  );
}

module.exports = {
  assertLiveSafeStorageBackend,
  LINUX_DEFAULT_EXPECTED_BACKEND,
};
