/**
 * PaySwap P2 —— Gate E2 Linux safeStorage 后端政策（pspSafeStorageBackendPolicy.ts）
 * 的纯函数全矩阵证明（架构师评审 2026-11-14 Blocker A 的法则级半；键仓边界级
 * 见 payswap-psp-key-store.test.ts）。
 *
 * 被测法则（模块文件头）：
 * 1. Linux 认可闭集 = Electron 44 的 Linux 后端全集减 basic_text/unknown；
 *    闭集外的任何字符串（含未来未知名）fail-closed。
 * 2. macOS/Windows 不查后端名（Linux-only API —— 键仓边界测试的哨兵抛错半
 *    证明「不查询」；本文件证明政策对 undefined 后端名的裁决）。
 * 3. 其余平台 fail-closed。
 *
 * Electron 44.7.0 的 getSelectedStorageBackend 类型（electron.d.ts）：
 * 'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown'
 */

import {
  isSecurePayswapPspStorageBackendSelection,
  PAYSWAP_PSP_SECURE_LINUX_STORAGE_BACKENDS,
} from "../src/main/payswap/pspSafeStorageBackendPolicy.js";
import { describe, expect, it } from "vitest";

const ELECTRON_44_LINUX_BACKEND_UNION = [
  "basic_text",
  "gnome_libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
  "unknown",
] as const;

describe("payswap PSP safeStorage backend policy (Gate E2 backend precision) — the pure law", () => {
  it("认可闭集 = Electron 44 Linux 后端全集减 basic_text 与 unknown（防止闭集与类型漂移）", () => {
    const allowed = ELECTRON_44_LINUX_BACKEND_UNION.filter(
      (backend) => backend !== "basic_text" && backend !== "unknown",
    );
    expect([...PAYSWAP_PSP_SECURE_LINUX_STORAGE_BACKENDS].sort()).toEqual(
      [...allowed].sort(),
    );
  });

  it("linux：认可集内全接受（gnome_libsecret / kwallet 家族）", () => {
    for (const backend of PAYSWAP_PSP_SECURE_LINUX_STORAGE_BACKENDS) {
      expect(isSecurePayswapPspStorageBackendSelection("linux", backend)).toBe(true);
    }
  });

  it("linux：basic_text 拒绝（硬编码密码不是 OS 钥匙串 —— Blocker A 本体）", () => {
    expect(isSecurePayswapPspStorageBackendSelection("linux", "basic_text")).toBe(false);
  });

  it("linux：unknown 拒绝（app ready 前的未初始化态不可证明保护）", () => {
    expect(isSecurePayswapPspStorageBackendSelection("linux", "unknown")).toBe(false);
  });

  it("linux：闭集外字符串（未来未知名/畸形值）拒绝；null/undefined 拒绝", () => {
    expect(isSecurePayswapPspStorageBackendSelection("linux", "some_future_backend")).toBe(false);
    expect(isSecurePayswapPspStorageBackendSelection("linux", "")).toBe(false);
    expect(isSecurePayswapPspStorageBackendSelection("linux", null)).toBe(false);
    expect(isSecurePayswapPspStorageBackendSelection("linux", undefined)).toBe(false);
  });

  it("darwin/win32：后端名不适用（Linux-only API —— undefined 也接受；OS 保护由 isEncryptionAvailable 门住）", () => {
    expect(isSecurePayswapPspStorageBackendSelection("darwin", undefined)).toBe(true);
    expect(isSecurePayswapPspStorageBackendSelection("win32", undefined)).toBe(true);
    // 即便传入了后端名（调用方违约），也不据其裁决 —— 平台路由优先。
    expect(isSecurePayswapPspStorageBackendSelection("darwin", "basic_text")).toBe(true);
    expect(isSecurePayswapPspStorageBackendSelection("win32", "unknown")).toBe(true);
  });

  it("其余平台 fail-closed（safeStorage 不支持的平台不持 PSP 键）", () => {
    for (const platform of ["freebsd", "openbsd", "sunos", "android", "cygwin", ""]) {
      expect(isSecurePayswapPspStorageBackendSelection(platform, "gnome_libsecret")).toBe(false);
      expect(isSecurePayswapPspStorageBackendSelection(platform, undefined)).toBe(false);
    }
  });
});
