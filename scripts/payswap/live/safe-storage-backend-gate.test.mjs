import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

/**
 * PaySwap P2 live harness —— safeStorage 平台门的法则级回归（node --test，零
 * Electron 依赖：safeStorage 端口与平台值全注入）。
 *
 * 钉住的回归行（环境就绪审计 2026-11-17 的核心缺陷）：win32/darwin 路径**永不
 * 调用** `getSelectedStorageBackend()`（Electron 的 Linux-only API —— 源码
 * `#if BUILDFLAG(IS_LINUX)`；win32 运行时上方法不存在，调用即 TypeError，live
 * harness 在原生 Windows 上无法起步）。任何回归性的无条件调用都会被本文件里的
 * throwing spy 立即击红。
 *
 * 运行：node --test scripts/payswap/live/safe-storage-backend-gate.test.mjs
 * （CI 挂载：.github/workflows/payswap-roadmap.yml —— 与 validate-roadmap 同一
 * 节点，零依赖、秒级。）
 */

const require_ = createRequire(import.meta.url);
const {
  assertLiveSafeStorageBackend,
  LINUX_DEFAULT_EXPECTED_BACKEND,
} = require_("./safe-storage-backend-gate.cjs");

/** 真实 Electron win32/darwin 形态的 safeStorage 端口：**没有**
 * getSelectedStorageBackend 方法（Linux-only API 的运行时事实）。 */
function makeNonLinuxSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (buf) => buf.toString("utf8").replace(/^enc:/, ""),
    // 故意不定义 getSelectedStorageBackend —— 与真实 win32/darwin 运行时一致。
  };
}

/** throwing spy：Linux-only API 在非 linux 平台被触碰时立即爆炸（回归行）。 */
function makeSpyThatMustNotBeCalled() {
  return function spy() {
    throw new Error(
      "REGRESSION: getSelectedStorageBackend() was called on a non-linux platform — Linux-only API must never be touched on win32/darwin",
    );
  };
}

test("linux: real keychain backend passes and is recorded", () => {
  const calls = [];
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => {
      calls.push("getSelectedStorageBackend");
      return "gnome_libsecret";
    },
    encryptString: (p) => Buffer.from(p),
    decryptString: (b) => b.toString("utf8"),
  };
  const result = assertLiveSafeStorageBackend({ safeStorage, platform: "linux" });
  assert.equal(result.gate, "linux-backend-name");
  assert.equal(result.backendSelected, "gnome_libsecret");
  assert.deepEqual(calls, ["getSelectedStorageBackend"]);
});

test("linux: basic_text (hardcoded password) fails closed", () => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "basic_text",
    encryptString: (p) => Buffer.from(p),
    decryptString: (b) => b.toString("utf8"),
  };
  assert.throws(
    () => assertLiveSafeStorageBackend({ safeStorage, platform: "linux" }),
    /basic_text/,
  );
});

test("linux: unknown backend fails closed", () => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "unknown",
    encryptString: (p) => Buffer.from(p),
    decryptString: (b) => b.toString("utf8"),
  };
  assert.throws(
    () => assertLiveSafeStorageBackend({ safeStorage, platform: "linux" }),
    /unknown.*gnome_libsecret|gnome_libsecret.*unknown/s,
  );
});

test("linux: expected-backend override is honored (kwallet5 leg)", () => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "kwallet5",
    encryptString: (p) => Buffer.from(p),
    decryptString: (b) => b.toString("utf8"),
  };
  const result = assertLiveSafeStorageBackend({
    safeStorage,
    platform: "linux",
    expectedBackend: "kwallet5",
  });
  assert.equal(result.backendSelected, "kwallet5");
});

test("linux: default expectation is gnome_libsecret", () => {
  assert.equal(LINUX_DEFAULT_EXPECTED_BACKEND, "gnome_libsecret");
});

test("linux: missing Linux-only API fails closed (pre-Electron-15 runtime shape)", () => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    // getSelectedStorageBackend absent — cannot prove a real keychain backend.
    encryptString: (p) => Buffer.from(p),
    decryptString: (b) => b.toString("utf8"),
  };
  assert.throws(
    () => assertLiveSafeStorageBackend({ safeStorage, platform: "linux" }),
    /getSelectedStorageBackend/,
  );
});

test("win32: DPAPI availability gates the check — Linux-only API is NEVER called (regression row)", () => {
  const safeStorage = makeNonLinuxSafeStorage({ available: true });
  // Even if a runtime ever exposed the API cross-platform, the win32 path must
  // not touch it: attach a throwing spy.
  safeStorage.getSelectedStorageBackend = makeSpyThatMustNotBeCalled();
  const result = assertLiveSafeStorageBackend({
    safeStorage,
    platform: "win32",
    expectedBackend: undefined,
  });
  assert.equal(result.gate, "win32-dpapi-availability");
  assert.equal(result.backendSelected, null);
});

test("win32: isEncryptionAvailable() === false fails closed", () => {
  const safeStorage = makeNonLinuxSafeStorage({ available: false });
  safeStorage.getSelectedStorageBackend = makeSpyThatMustNotBeCalled();
  assert.throws(
    () => assertLiveSafeStorageBackend({ safeStorage, platform: "win32" }),
    /isEncryptionAvailable\(\) 为 false|isEncryptionAvailable\(\).*false/s,
  );
});

test("darwin: Keychain availability gates the check — Linux-only API is NEVER called (regression row)", () => {
  const safeStorage = makeNonLinuxSafeStorage({ available: true });
  safeStorage.getSelectedStorageBackend = makeSpyThatMustNotBeCalled();
  const result = assertLiveSafeStorageBackend({ safeStorage, platform: "darwin" });
  assert.equal(result.gate, "darwin-keychain-availability");
  assert.equal(result.backendSelected, null);
});

test("darwin: isEncryptionAvailable() === false fails closed", () => {
  const safeStorage = makeNonLinuxSafeStorage({ available: false });
  safeStorage.getSelectedStorageBackend = makeSpyThatMustNotBeCalled();
  assert.throws(
    () => assertLiveSafeStorageBackend({ safeStorage, platform: "darwin" }),
    /isEncryptionAvailable\(\) 为 false|isEncryptionAvailable\(\).*false/s,
  );
});

test("unsupported platform fails closed (policy law 3)", () => {
  const safeStorage = makeNonLinuxSafeStorage({ available: true });
  safeStorage.getSelectedStorageBackend = makeSpyThatMustNotBeCalled();
  assert.throws(
    () => assertLiveSafeStorageBackend({ safeStorage, platform: "freebsd" }),
    /不支持的平台/,
  );
});

test("win32: an expectedBackend value is not consumed and never invents a backend name", () => {
  const safeStorage = makeNonLinuxSafeStorage({ available: true });
  safeStorage.getSelectedStorageBackend = makeSpyThatMustNotBeCalled();
  // Even with a legacy "dpapi" expectation floating in the environment, the
  // win32 gate must return backendSelected: null — no fabricated API answer.
  const result = assertLiveSafeStorageBackend({
    safeStorage,
    platform: "win32",
    expectedBackend: "dpapi",
  });
  assert.equal(result.backendSelected, null);
  assert.equal(result.gate, "win32-dpapi-availability");
});
