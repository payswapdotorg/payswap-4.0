#!/usr/bin/env node
"use strict";

/**
 * PaySwap P2 —— Electron safeStorage 运行时探针（DPAPI / Keychain / Libsecret 的
 * 真运行时自证；环境就绪审计 2026-11-17 交付物）。
 *
 * 在**真实 Electron main 进程**内回答四个问题（进程外脚本无法回答 —— safeStorage
 * 是 main-only API，且 DPAPI/Keychain 的真实行为只有真运行时才作数）：
 *   1. `safeStorage.isEncryptionAvailable()`（win32 = DPAPI 就绪、darwin = Keychain
 *      就绪、linux = secret store 就绪）
 *   2. encrypt→decrypt 往返是否成立（且密文 ≠ 明文 —— 不是恒等变换）
 *   3. linux：实际选中的后端名（Linux-only API —— 仅 linux 查询，与
 *      safe-storage-backend-gate.cjs 法则 2 同纪律；win32/darwin 恒 null，
 *      **不发明** Windows 后端名 API）
 *   4. 平台/版本事实（platform、electron、node —— 证据登记用）
 *
 * 输出契约：stdout 恰一行 `PAYSWAP_SAFE_STORAGE_PROBE {...json...}`（前缀标记 ——
 * Electron/Chromium 可能在 stdout 打其它噪声行，消费方按前缀解析）。
 * 退出码：0 = available + 往返 ok；1 = 不可用/往返失败/异常；2 = 平台不受支持。
 * 秘密纪律：探针不接触任何真实凭据（探针载荷是随机合成串）；输出无秘密面。
 *
 * 运行（node 直驱 electron cli —— 跨平台免 .cmd shim 解析；hoisted 布局下
 * electron 也可能落在 repo 根 node_modules）：
 *   node packages/desktop/node_modules/electron/cli.js scripts/payswap/electron-safe-storage-probe.cjs
 *   （linux 容器腿加 --no-sandbox；linux 钥匙串腿加 --password-store=gnome-libsecret）
 */

const { app, safeStorage } = require("electron");

const PROBE_MARKER = "PAYSWAP_SAFE_STORAGE_PROBE";

app.disableHardwareAcceleration();

function finish(result, exitCode) {
  console.log(`${PROBE_MARKER} ${JSON.stringify(result)}`);
  app.exit(exitCode);
}

app.whenReady().then(() => {
  const result = {
    harness: "payswap-safe-storage-probe",
    platform: process.platform,
    electron: process.versions.electron || null,
    node: process.versions.node || null,
    isEncryptionAvailable: false,
    roundTrip: "not-attempted",
    backendSelected: null,
  };

  if (process.platform !== "linux" && process.platform !== "win32" && process.platform !== "darwin") {
    result.error = `unsupported platform '${process.platform}'`;
    finish(result, 2);
    return;
  }

  try {
    result.isEncryptionAvailable = safeStorage.isEncryptionAvailable();
    if (result.isEncryptionAvailable) {
      const probePayload = `payswap-p2-probe:${Date.now().toString(36)}:${Math.random()
        .toString(36)
        .slice(2, 10)}`;
      const encrypted = safeStorage.encryptString(probePayload);
      const decrypted = safeStorage.decryptString(encrypted);
      const cipherIsPlaintext = encrypted.equals(Buffer.from(probePayload, "utf8"));
      result.roundTrip = decrypted === probePayload && !cipherIsPlaintext ? "ok" : "mismatch";
    }
    // Linux-only API —— 仅 linux 查询（win32/darwin 不触碰；生产键仓同款平台门）。
    if (process.platform === "linux" && typeof safeStorage.getSelectedStorageBackend === "function") {
      result.backendSelected = safeStorage.getSelectedStorageBackend();
    }
    finish(result, result.isEncryptionAvailable && result.roundTrip === "ok" ? 0 : 1);
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
    finish(result, 1);
  }
}).catch((error) => {
  console.error("[safe-storage-probe] boot failed:", error && error.message ? error.message : error);
  app.exit(1);
});
