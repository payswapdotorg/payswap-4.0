"use strict";

/**
 * PaySwap P2 验收 —— 平台无关的裁决纯函数（windows/linux 两 runner 共享）。
 *
 * 从 run-p2-acceptance.cjs（windows runner）抽出的共享法则面：退出码推导、
 * 泄漏裁决、preflight JSON 形状校验、RESULT_HARNESS 解析。两腿的语义必须
 * 逐字节一致（同一词汇闭集、同一退出码表、同一泄漏处置）—— 共享模块是
 * 防漂移的手段，不是便利。
 */

/** 词汇闭集：PASS < BOUNDARY/FAIL < SKIP/MANUAL-PENDING。
 *  0 = 全 PASS；1 = FAIL/BOUNDARY（含泄漏）；2 = SKIP/MANUAL-PENDING/assumption。 */
const VERDICT_RANK = { PASS: 0, BOUNDARY: 1, FAIL: 1, SKIP: 2, "MANUAL-PENDING": 2 };

/** 退出码唯一权威：由 results + 假设集合推导（纯函数；泄漏裁决先行生效）。 */
function computeExitCode(selectedStages, results, assumed) {
  let worst = 0;
  for (const stageId of selectedStages) {
    const verdict = results[stageId] ? results[stageId].verdict : "NOT-RUN";
    worst = Math.max(worst, VERDICT_RANK[verdict] ?? 1);
  }
  if (assumed && assumed.size > 0) worst = Math.max(worst, 2);
  return worst === 0 ? 0 : worst === 1 ? 1 : 2;
}

/** 泄漏裁决（纯函数）：命中即污染整个 run —— 所有 PASS 翻 FAIL，退出码必非 0。
 *  只改 results（唯一权威状态），summary 与退出码都从它派生。 */
function applyLeakVerdicts(results, leaks) {
  if (!leaks || leaks.length === 0) return results;
  const note = `credential leak detected in artifact(s): ${leaks.join(", ")}`;
  for (const stageId of Object.keys(results)) {
    if (results[stageId].verdict === "PASS") {
      results[stageId].verdict = "FAIL";
      results[stageId].note = note;
    }
  }
  return results;
}

/** preflight JSON 形状校验（纯函数）—— 形状不对 = 整个 run fail-closed。 */
function validatePreflightJson(parsed, expectedPlatform) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "preflight output is not a JSON object" };
  }
  if (parsed.platform !== expectedPlatform) {
    return { ok: false, reason: `preflight platform '${parsed.platform}' != runner platform '${expectedPlatform}'` };
  }
  if (!Array.isArray(parsed.stages) || parsed.stages.length === 0) {
    return { ok: false, reason: "preflight JSON has no stages array — stage records cannot be positively established" };
  }
  for (const stage of parsed.stages) {
    if (!stage || typeof stage.id !== "string" || typeof stage.executable !== "boolean") {
      return { ok: false, reason: "preflight stage record malformed (id/executable missing)" };
    }
  }
  return { ok: true };
}

/** RESULT_HARNESS 解析（live-acceptance-evidence.md §3 的判定语义）。 */
function parseResultHarness(text) {
  const match = /\bRESULT_HARNESS=(\d+)/.exec(text || "");
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

module.exports = { VERDICT_RANK, computeExitCode, applyLeakVerdicts, validatePreflightJson, parseResultHarness };
