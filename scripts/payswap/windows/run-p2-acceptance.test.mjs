// P2 acceptance runner 回归矩阵（2026-11-17 架构师评审三缺陷的负路径钉死）。
// 只用 node --test + node:assert（零依赖，与 safe-storage-backend-gate.test.mjs 同款）。
// 全部使用合成测试密钥（rk_test_SYNTHETIC_*）—— 绝不引入真实凭据材料。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const runner = require("./run-p2-acceptance.cjs");

const SECRET = "rk_test_SYNTHETIC0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const REDACTION = "<redacted-live-key>";

async function tmpDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// A — 凭据置换与泄漏处置（流式 carry-over；stderr 同流；工件消毒先行）
// ---------------------------------------------------------------------------

test("A1: complete secret in one chunk is fully redacted in emitted + flushed output", async () => {
  const dir = await tmpDir("p2a1-");
  const log = new runner.RedactingLog(path.join(dir, "a1.log"), SECRET, { echo: false });
  log.append(`before ${SECRET} after\n`);
  await log.flush();
  const body = fs.readFileSync(path.join(dir, "a1.log"), "utf8");
  assert.equal(body.includes(SECRET), false, "raw secret must never reach disk");
  assert.equal(body, `before ${REDACTION} after\n`);
});

test("A2: secret split across two chunks is redacted", async () => {
  const dir = await tmpDir("p2a2-");
  const log = new runner.RedactingLog(path.join(dir, "a2.log"), SECRET, { echo: false });
  const cut = 12;
  log.append(SECRET.slice(0, cut));
  log.append(`${SECRET.slice(cut)} tail\n`);
  await log.flush();
  const body = fs.readFileSync(path.join(dir, "a2.log"), "utf8");
  assert.equal(body.includes(SECRET), false);
  assert.equal(body.includes(SECRET.slice(0, cut)), false, "held partial prefix must not be emitted");
  assert.equal(body, `${REDACTION} tail\n`);
});

test("A3: secret split byte-by-byte across many chunks is redacted", async () => {
  const dir = await tmpDir("p2a3-");
  const log = new runner.RedactingLog(path.join(dir, "a3.log"), SECRET, { echo: false });
  for (const ch of `x${SECRET}y`) log.append(ch);
  await log.flush();
  const body = fs.readFileSync(path.join(dir, "a3.log"), "utf8");
  assert.equal(body.includes(SECRET), false);
  assert.equal(body, `x${REDACTION}y`);
});

test("A4: secret arriving via a stderr chunk routed through the same log is redacted", async () => {
  const dir = await tmpDir("p2a4-");
  const log = new runner.RedactingLog(path.join(dir, "a4.log"), SECRET, { echo: false });
  log.append("stdout ok\n");
  log.append(`stderr leaked ${SECRET}\n`);
  await log.flush();
  const body = fs.readFileSync(path.join(dir, "a4.log"), "utf8");
  assert.equal(body.includes(SECRET), false);
  assert.equal(body, `stdout ok\nstderr leaked ${REDACTION}\n`);
});

test("A5: secret in a nested artifact is detected, sanitized, and re-scan is clean", async () => {
  const dir = await tmpDir("p2a5-");
  const nested = path.join(dir, "live-harness-out", "deep");
  await fsp.mkdir(nested, { recursive: true });
  const contaminated = path.join(nested, "evidence.json");
  await fsp.writeFile(contaminated, JSON.stringify({ note: `carry ${SECRET} inside` }), "utf8");
  await fsp.writeFile(path.join(dir, "clean.txt"), "no secrets here", "utf8");

  const hits = await runner.leakScan(dir, SECRET);
  assert.deepEqual(hits.sort(), [path.join("live-harness-out", "deep", "evidence.json")]);

  const sanitized = await runner.sanitizeLeaks(dir, SECRET);
  assert.equal(sanitized.length, 1);
  const body = await fsp.readFile(contaminated, "utf8");
  assert.equal(body.includes(SECRET), false);
  assert.equal(body.includes(REDACTION), true);
  const rescan = await runner.leakScan(dir, SECRET);
  assert.deepEqual(rescan, [], "re-scan after sanitization must be clean");
});

test("A6: detected leak flips PASS stages to FAIL in the authoritative state and forces a non-zero exit code", () => {
  const results = {
    "windows-build": { verdict: "PASS", steps: [] },
    "windows-secure-storage": { verdict: "PASS", steps: [] },
    "stripe-live": { verdict: "BOUNDARY", steps: [] },
  };
  const stages = Object.keys(results);
  // 无泄漏：BOUNDARY ⇒ 1（非绿），PASS 不受影响
  assert.equal(runner.computeExitCode(stages, results, new Set()), 1);
  // 泄漏：所有 PASS 翻 FAIL，退出码仍非 0
  runner.applyLeakVerdicts(results, ["live-harness-out/evidence.json"]);
  assert.equal(results["windows-build"].verdict, "FAIL");
  assert.equal(results["windows-secure-storage"].verdict, "FAIL");
  assert.equal(results["stripe-live"].verdict, "BOUNDARY", "non-PASS verdicts keep their closed-set value");
  assert.equal(runner.computeExitCode(stages, results, new Set()), 1);
  // 泄漏 + 全 PASS 场景也绝不可能是 0（泄漏绝不可能退出 0）
  const allPass = { s: { verdict: "PASS" } };
  assert.equal(runner.computeExitCode(["s"], allPass, new Set()), 0);
  runner.applyLeakVerdicts(allPass, ["x"]);
  assert.equal(runner.computeExitCode(["s"], allPass, new Set()), 1);
});

test("A7: emitted stream (echo) is post-redaction even with split chunks", async () => {
  const dir = await tmpDir("p2a7-");
  const original = process.stdout.write;
  const emitted = [];
  process.stdout.write = (chunk) => {
    emitted.push(String(chunk));
    return true;
  };
  try {
    const log = new runner.RedactingLog(path.join(dir, "a7.log"), SECRET);
    log.append(SECRET.slice(0, 5));
    log.append(SECRET.slice(5));
    await log.flush();
  } finally {
    process.stdout.write = original;
  }
  assert.equal(emitted.join("").includes(SECRET), false, "terminal emission must be post-redaction");
  assert.equal(emitted.join(""), `${REDACTION}`);
});

// ---------------------------------------------------------------------------
// B — 人工回执严格校验（存在 ≠ 成功；FAIL 永不过）
// ---------------------------------------------------------------------------

const COMMIT = "a".repeat(40);

function buildValidEvidence() {
  const lines = ["# P2 conversation-acceptance — manual New Task evidence", ""];
  for (const [n, action, expected] of runner.MANUAL_CHECKLIST_ITEMS) {
    lines.push(`## Step ${n}. ${action}`);
    lines.push(`- Expected: ${expected}`);
    lines.push("- Observed: saw exactly what was expected on the real desktop app");
    lines.push("- Result: PASS");
    lines.push("");
  }
  lines.push("## Attestation");
  lines.push("- Operator: TL-on-windows");
  lines.push("- Date/time (local): 2026-11-17 15:00");
  lines.push("- Platform (winver output): Microsoft Windows [Version 10.0.26200.9974]");
  lines.push(`- App commit SHA: ${COMMIT}`);
  lines.push("");
  return lines.join("\n");
}

test("B1: fully valid 13-step report with complete attestation passes", () => {
  assert.deepEqual(runner.validateManualEvidence(buildValidEvidence(), null), []);
});

test("B2: a deliberately completed report with Result: FAIL on all 13 steps NEVER passes", () => {
  const text = buildValidEvidence().replace(/- Result: PASS/g, "- Result: FAIL (network unreachable)");
  const problems = runner.validateManualEvidence(text, null);
  assert.equal(problems.length >= 13, true, "every failed step must be named");
  assert.equal(problems.some((p) => p.includes("Step 13")), true);
});

test("B3: missing step heading fails", () => {
  const text = buildValidEvidence().replace(/^## Step 7\..*\n(?:- .*\n)*/m, "");
  const problems = runner.validateManualEvidence(text, null);
  assert.equal(problems.some((p) => p.includes("missing step heading: Step 7")), true);
});

test("B4: empty Observed fails", () => {
  const text = buildValidEvidence().replace(/- Observed: saw exactly what was expected on the real desktop app/, "- Observed: ");
  const problems = runner.validateManualEvidence(text, null);
  assert.equal(problems.some((p) => p.startsWith("Step 1:") && p.includes("Observed")), true);
});

test("B5: duplicate step heading fails", () => {
  const text = buildValidEvidence() + "\n## Step 5. duplicate\n- Observed: x\n- Result: PASS\n";
  const problems = runner.validateManualEvidence(text, null);
  assert.equal(problems.some((p) => p.includes("duplicate step heading: Step 5")), true);
});

test("B6: short or malformed commit SHA fails", () => {
  const text = buildValidEvidence().replace(`- App commit SHA: ${COMMIT}`, "- App commit SHA: abc123");
  const problems = runner.validateManualEvidence(text, null);
  assert.equal(problems.some((p) => p.includes("40-hex commit SHA")), true);
});

test("B7: credential material anywhere in the report fails", () => {
  for (const snippet of ["rk_test_REALLOOKINGKEY123", "sk_live_x", "sk_test_y", "whsec_z"]) {
    const text = buildValidEvidence().replace("- Operator: TL-on-windows", `- Operator: TL ${snippet}`);
    const problems = runner.validateManualEvidence(text, null);
    assert.equal(problems.some((p) => p.includes("credential material")), true, `pattern ${snippet} must be rejected`);
  }
  const withSecret = buildValidEvidence().replace("- Operator: TL-on-windows", `- Operator: TL ${SECRET}`);
  const problems = runner.validateManualEvidence(withSecret, SECRET);
  assert.equal(problems.some((p) => p.includes("live key itself")), true);
});

test("B8: unknown or absent Result values fail", () => {
  const unknown = buildValidEvidence().replace(/- Result: PASS/g, "- Result: PASSED");
  assert.equal(runner.validateManualEvidence(unknown, null).some((p) => p.includes("only 'Result: PASS'")), true);
  const blocked = buildValidEvidence().replace(/- Result: PASS/g, "- Result: BLOCKED");
  assert.equal(runner.validateManualEvidence(blocked, null).some((p) => p.includes("BLOCKED")), true);
  const absent = buildValidEvidence().replace(/- Result: PASS\n/g, "");
  assert.equal(runner.validateManualEvidence(absent, null).some((p) => p.includes("no 'Result:' line")), true);
});

test("B9: unknown step numbers and incomplete attestation fail", () => {
  const extra = buildValidEvidence() + "\n## Step 99. invented\n- Observed: x\n- Result: PASS\n";
  assert.equal(runner.validateManualEvidence(extra, null).some((p) => p.includes("unknown step number")), true);
  const noPlatform = buildValidEvidence().replace(
    "- Platform (winver output): Microsoft Windows [Version 10.0.26200.9974]",
    "- Platform (winver output): Windows",
  );
  assert.equal(runner.validateManualEvidence(noPlatform, null).some((p) => p.includes("10.0.<build>")), true);
});

test("B10: empty attestation lines never borrow the next line's content (review finding: \\s* cross-line)", () => {
  // 2026-11-17 安全复审发现：Operator/Date/time 的空值检查曾是 \\s*\\S —— 跨行
  // 吞掉换行后把下一行首字符当值。与 Observed 的 [ \t] 修复同类，同修。
  const noOperator = buildValidEvidence().replace("- Operator: TL-on-windows", "- Operator: ");
  assert.equal(runner.validateManualEvidence(noOperator, null).some((p) => p.includes("'Operator:' is empty")), true);
  const noDate = buildValidEvidence().replace(
    "- Date/time (local): 2026-11-17 15:00",
    "- Date/time (local): ",
  );
  assert.equal(runner.validateManualEvidence(noDate, null).some((p) => p.includes("'Date/time' is empty")), true);
  // 值写在下一行（跨行借用）同样不过
  const dateNextLine = buildValidEvidence().replace(
    "- Date/time (local): 2026-11-17 15:00",
    "- Date/time (local): \n2026-11-17 15:00",
  );
  assert.equal(runner.validateManualEvidence(dateNextLine, null).some((p) => p.includes("'Date/time' is empty")), true);
  // "(local)" 后缀不得被当作值（alternation 顺序缺陷：空值 + "(local)" 形态）
  const plainDateEmpty = buildValidEvidence().replace(
    "- Date/time (local): 2026-11-17 15:00",
    "- Date/time: ",
  );
  assert.equal(runner.validateManualEvidence(plainDateEmpty, null).some((p) => p.includes("'Date/time' is empty")), true);
});

// ---------------------------------------------------------------------------
// C — preflight fail-closed（launch 失败 / 畸形输出 / 缺记录 / 平台不符绝不放行）
// ---------------------------------------------------------------------------

async function spawnNodeEval(code) {
  const dir = await tmpDir("p2c-script-");
  const script = path.join(dir, "fake-preflight.cjs");
  await fsp.writeFile(script, code, "utf8");
  return script;
}

test("C1: preflight process that cannot launch fails closed", async () => {
  // 平台差异：POSIX 上 spawn ENOENT → launch-failed；Windows 上 node 找不到模块 →
  // exit 1 + 非 JSON。两种形态都必须 fail-closed（ok=false）。
  const result = await runner.runPreflight({ script: path.join(os.tmpdir(), "does-not-exist-404.cjs") });
  assert.equal(result.ok, false);
  assert.ok(result.reason && result.reason.length > 0);
});

test("C2: preflight exiting non-zero with no JSON fails closed", async () => {
  const script = await spawnNodeEval("process.exit(3);");
  const result = await runner.runPreflight({ script, platform: process.platform });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no JSON/);
});

test("C3: non-JSON output fails closed", async () => {
  const script = await spawnNodeEval("console.log('this is not json');");
  const result = await runner.runPreflight({ script, platform: process.platform });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no JSON|unparsable/);
});

test("C4: JSON without a stages array fails closed", async () => {
  const script = await spawnNodeEval('console.log(JSON.stringify({ platform: process.platform, checks: [] }));');
  const result = await runner.runPreflight({ script, platform: process.platform });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no stages array/);
});

test("C5: platform mismatch between preflight JSON and runner fails closed", async () => {
  const script = await spawnNodeEval(
    'console.log(JSON.stringify({ platform: "haiku-os", stages: [{ id: "windows-build", executable: true }] }));',
  );
  const result = await runner.runPreflight({ script, platform: process.platform });
  assert.equal(result.ok, false);
  assert.match(result.reason, /platform/);
});

test("C6: malformed stage records fail closed (pure validator)", () => {
  const bad = runner.validatePreflightJson(
    { platform: process.platform, stages: [{ id: "windows-build" }] },
    process.platform,
  );
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /malformed/);
  const good = runner.validatePreflightJson(
    { platform: process.platform, stages: [{ id: "windows-build", executable: false, reasons: ["x"] }] },
    process.platform,
  );
  assert.equal(good.ok, true);
});

test("C7: valid preflight shape parses (ok=true, stages preserved)", async () => {
  const script = await spawnNodeEval(
    'console.log(JSON.stringify({ platform: process.platform, stages: [{ id: "windows-build", executable: false, reasons: ["synthetic"] }] }));',
  );
  const result = await runner.runPreflight({ script, platform: process.platform });
  assert.equal(result.ok, true);
  assert.equal(result.preflight.stages.length, 1);
  assert.equal(result.preflight.stages[0].id, "windows-build");
});

// 全局收尾：确保没有测试把真实密钥形态写进任何临时目录名
test("synthetic-only discipline", () => {
  assert.match(SECRET, /^rk_test_SYNTHETIC/);
});
