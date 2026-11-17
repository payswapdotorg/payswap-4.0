"use strict";

/**
 * P2-Linux runner 回归矩阵（scripts/payswap/linux/run-p2-acceptance.cjs +
 * leg-stack.cjs）。与 windows runner 的 24 例矩阵同纪律：只测纯函数面与
 * 法则恒量 —— 不启动 Electron、不联网、不碰真实凭据。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const runner = require("./run-p2-acceptance.cjs");
const legStack = require("./leg-stack.cjs");
const verdicts = require("../acceptance-verdicts.cjs");

// ---------------------------------------------------------------------------
// 1) 阶段表完整性（五分类、顺序、依赖面是登记条款 —— 漂移即回归）
// ---------------------------------------------------------------------------

const HERE = path.dirname(new URL(import.meta.url).pathname);

test("stage order is the five-category decomposition, in order", () => {
  // STAGE_ORDER 不经 module.exports 泄露（runner 内部表）；经 --list 自证。
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath, [path.join(HERE, "run-p2-acceptance.cjs"), "--list"], {
    encoding: "utf8",
  });
  const ids = out
    .split(/\r?\n/)
    .map((l) => /^(\S+)\s/.exec(l)?.[1])
    .filter(Boolean);
  assert.deepEqual(ids, [
    "linux-build",
    "linux-secure-storage",
    "linux-desktop-e2e",
    "stripe-live",
    "conversation-acceptance",
  ]);
});

test("usage error exits 3 (unknown stage / unknown arg)", () => {
  const { execFileSync } = require("node:child_process");
  for (const args of [["--stage", "bogus"], ["--bogus-flag"]]) {
    let code = 0;
    try {
      execFileSync(process.execPath, [path.join(HERE, "run-p2-acceptance.cjs"), ...args], {
        stdio: "pipe",
      });
    } catch (error) {
      code = error.status;
    }
    assert.equal(code, 3, `expected exit 3 for ${args.join(" ")}`);
  }
});

// ---------------------------------------------------------------------------
// 2) 构建面（内存受限开关）
// ---------------------------------------------------------------------------

test("buildMemoryEnv defaults to the memory-constrained face (sourcemap off + heap cap)", () => {
  const env = runner.buildMemoryEnv();
  assert.equal(env.ZCODE_DESKTOP_BUILD_SOURCEMAPS, "off");
  assert.match(env.NODE_OPTIONS, /--max-old-space-size=2048/);
});

test("PAYSWAP_LINUX_FULL_MEMORY_BUILD=1 keeps the full production face", () => {
  const previous = process.env.PAYSWAP_LINUX_FULL_MEMORY_BUILD;
  process.env.PAYSWAP_LINUX_FULL_MEMORY_BUILD = "1";
  try {
    assert.deepEqual(runner.buildMemoryEnv(), {});
  } finally {
    if (previous === undefined) delete process.env.PAYSWAP_LINUX_FULL_MEMORY_BUILD;
    else process.env.PAYSWAP_LINUX_FULL_MEMORY_BUILD = previous;
  }
});

// ---------------------------------------------------------------------------
// 3) 探针 / RESULT 解析（标记协议）
// ---------------------------------------------------------------------------

test("parseProbeJson: marker line -> object; absent/malformed -> null", () => {
  assert.deepEqual(runner.parseProbeJson('noise\nPAYSWAP_SAFE_STORAGE_PROBE {"backendSelected":"gnome_libsecret","isEncryptionAvailable":true,"roundTrip":"ok"}\ntail'), {
    backendSelected: "gnome_libsecret",
    isEncryptionAvailable: true,
    roundTrip: "ok",
  });
  assert.equal(runner.parseProbeJson("no marker here"), null);
  assert.equal(runner.parseProbeJson('PAYSWAP_SAFE_STORAGE_PROBE {not json'), null);
  assert.equal(runner.parseProbeJson(null), null);
});

test("parseResultHarness: shared semantics (RESULT_HARNESS=n)", () => {
  assert.equal(runner.parseResultHarness("...\nRESULT_HARNESS=0\n"), 0);
  assert.equal(runner.parseResultHarness("RESULT_HARNESS=1"), 1);
  assert.equal(runner.parseResultHarness("missing"), null);
});

test("linux runner and windows runner share the verdict law module (no drift)", () => {
  const windowsRunner = require("../windows/run-p2-acceptance.cjs");
  assert.equal(runner.parseResultHarness, verdicts.parseResultHarness);
  assert.equal(windowsRunner.computeExitCode, verdicts.computeExitCode);
  assert.equal(windowsRunner.applyLeakVerdicts, verdicts.applyLeakVerdicts);
});

// ---------------------------------------------------------------------------
// 4) 腿栈解析（前缀 / 系统 / 错误路径）
// ---------------------------------------------------------------------------

test("resolveLegStackEnvironment: no prefix -> system form (no env deltas)", () => {
  const result = legStack.resolveLegStackEnvironment({ PAYSWAP_LINUX_LEG_STACK: "" });
  assert.equal(result.prefix, null);
  assert.deepEqual(result.env, {});
});

test("resolveLegStackEnvironment: prefix -> PATH/LD_LIBRARY_PATH/GSETTINGS_SCHEMA_DIR deltas", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leg-stack-"));
  try {
    fs.mkdirSync(path.join(tmp, "usr", "bin"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "usr", "lib", "x86_64-linux-gnu"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "usr", "share", "glib-2.0", "schemas"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "usr", "share", "glib-2.0", "schemas", "gschemas.compiled"), "");
    const result = legStack.resolveLegStackEnvironment({ PAYSWAP_LINUX_LEG_STACK: tmp, PATH: "/usr/bin" });
    assert.equal(result.prefix, tmp);
    assert.equal(result.env.PATH, `${path.join(tmp, "usr", "bin")}:/usr/bin`);
    assert.equal(result.env.LD_LIBRARY_PATH, path.join(tmp, "usr", "lib", "x86_64-linux-gnu"));
    assert.equal(result.env.GSETTINGS_SCHEMA_DIR, path.join(tmp, "usr", "share", "glib-2.0", "schemas"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("probeLegStack: missing binaries reported per-command; nonexistent prefix is an error", () => {
  const empty = legStack.probeLegStack({ PATH: "/nonexistent-leg-stack-bin" });
  assert.equal(empty.ok, false);
  assert.equal(empty.commands.length, 3);
  assert.ok(empty.commands.every((c) => !c.ok));

  const bogus = legStack.probeLegStack({ PAYSWAP_LINUX_LEG_STACK: "/definitely/not/here", PATH: "/usr/bin" });
  assert.equal(bogus.ok, false);
  assert.match(bogus.error, /does not exist/);
});

test("probeLegStack: stub stack resolves all three commands", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leg-stack-ok-"));
  try {
    const binDir = path.join(tmp, "usr", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    for (const command of legStack.LEG_STACK_COMMANDS) {
      fs.writeFileSync(path.join(binDir, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    const probe = legStack.probeLegStack({ PAYSWAP_LINUX_LEG_STACK: tmp, PATH: "/usr/bin" });
    assert.equal(probe.ok, true);
    assert.ok(probe.commands.every((c) => c.ok && c.path && c.path.startsWith(path.join(tmp, "usr", "bin"))));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5) 共享裁决法则（在 linux 语义下再钉一遍 —— 词汇闭集与退出码表）
// ---------------------------------------------------------------------------

test("computeExitCode: closed vocabulary and exit table", () => {
  assert.equal(verdicts.computeExitCode(["a"], { a: { verdict: "PASS" } }, new Set()), 0);
  assert.equal(verdicts.computeExitCode(["a"], { a: { verdict: "BOUNDARY" } }, new Set()), 1);
  assert.equal(verdicts.computeExitCode(["a"], { a: { verdict: "FAIL" } }, new Set()), 1);
  assert.equal(verdicts.computeExitCode(["a"], { a: { verdict: "SKIP" } }, new Set()), 2);
  assert.equal(verdicts.computeExitCode(["a"], { a: { verdict: "MANUAL-PENDING" } }, new Set()), 2);
  assert.equal(verdicts.computeExitCode(["a"], {}, new Set()), 1, "NOT-RUN is never green");
  assert.equal(verdicts.computeExitCode(["a"], { a: { verdict: "PASS" } }, new Set(["a"])), 2, "assumption never green");
});

test("applyLeakVerdicts: a leak turns every PASS into FAIL", () => {
  const results = { "linux-build": { verdict: "PASS" }, "stripe-live": { verdict: "SKIP" } };
  verdicts.applyLeakVerdicts(results, ["stripe-live/live-harness.log"]);
  assert.equal(results["linux-build"].verdict, "FAIL");
  assert.match(results["linux-build"].note, /live-harness\.log/);
  assert.equal(results["stripe-live"].verdict, "SKIP", "non-PASS verdicts keep their honest state");
});

test("validatePreflightJson: shape law (platform + stages array + record shape)", () => {
  assert.equal(verdicts.validatePreflightJson({ platform: "linux", stages: [{ id: "linux-build", executable: true }] }, "linux").ok, true);
  assert.equal(verdicts.validatePreflightJson({ platform: "linux", stages: [] }, "linux").ok, false);
  assert.equal(verdicts.validatePreflightJson({ platform: "win32", stages: [{ id: "x", executable: true }] }, "linux").ok, false);
  assert.equal(verdicts.validatePreflightJson({ platform: "linux", stages: [{ id: "x" }] }, "linux").ok, false);
  assert.equal(verdicts.validatePreflightJson(null, "linux").ok, false);
});

// ---------------------------------------------------------------------------
// manual evidence — 平台感知 attestation（安全复审修复：linux 腿的回执不再被
// win32 的 10.0.<build> 硬编码卡死；两腿互不替代）
// ---------------------------------------------------------------------------

const manualEvidence = require("../windows/manual-evidence.cjs");

const LINUX_UNAME =
  "Linux c-6afc86c4 5.10.134-013.15.kangaroo.al8.x86_64 #1 SMP Debian GNU/Linux 13 (trixie)";

function buildValidLinuxEvidence() {
  const lines = ["# P2 conversation-acceptance — manual New Task evidence (Linux leg)", ""];
  for (const [n, action, expected] of manualEvidence.MANUAL_CHECKLIST_ITEMS) {
    lines.push(`## Step ${n}. ${action}`);
    lines.push(`- Expected: ${expected}`);
    lines.push("- Observed: saw exactly what was expected on the real desktop app (Linux leg)");
    lines.push("- Result: PASS");
    lines.push("");
  }
  lines.push("## Attestation");
  lines.push("- Operator: TL-on-linux");
  lines.push("- Date/time (local): 2026-11-17 19:30");
  lines.push(`- Platform (uname -a output): ${LINUX_UNAME}`);
  lines.push(`- App commit SHA: ${"a".repeat(40)}`);
  lines.push("");
  return lines.join("\n");
}

test("manual evidence (linux): a Linux receipt with kernel-version platform passes", () => {
  assert.deepEqual(runner.validateManualEvidence(buildValidLinuxEvidence(), null, "linux"), []);
});

test("manual evidence (linux): Windows-form platform string is rejected — legs are not interchangeable", () => {
  const text = buildValidLinuxEvidence().replace(
    `- Platform (uname -a output): ${LINUX_UNAME}`,
    "- Platform (winver output): Microsoft Windows [Version 10.0.26200.9974]",
  );
  const problems = runner.validateManualEvidence(text, null, "linux");
  assert.equal(problems.some((p) => p.includes("Windows platform string")), true);
});

test("manual evidence (linux): platform line without a kernel version is rejected", () => {
  const text = buildValidLinuxEvidence().replace(
    `- Platform (uname -a output): ${LINUX_UNAME}`,
    "- Platform (uname -a output): Debian GNU/Linux",
  );
  const problems = runner.validateManualEvidence(text, null, "linux");
  assert.equal(problems.some((p) => p.includes("kernel version")), true);
});

test("manual evidence: default platform stays the historical win32 form (windows-matrix contract)", () => {
  const problems = runner.validateManualEvidence(buildValidLinuxEvidence(), null);
  assert.equal(problems.some((p) => p.includes("10.0.<build>")), true);
});

test("renderManualChecklist(linux) points at the linux runner (uname label; no winver, no backslash path)", () => {
  const checklist = manualEvidence.renderManualChecklist("linux");
  assert.equal(checklist.includes("scripts/payswap/linux/run-p2-acceptance.cjs"), true);
  assert.equal(checklist.includes("uname -a output"), true);
  assert.equal(checklist.includes("winver"), false);
  assert.equal(checklist.includes("\\"), false);
  // 模板落盘即待填回执：13 个步骤标题齐备
  assert.equal((checklist.match(/^##\s*Step\s*\d+\./gm) || []).length, 13);
});
