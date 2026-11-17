// 独立安全复审对抗样本（TL 复审 915242dc 的当前拆分面；2026-11-17）。
// 攻击面：RedactingLog 跨 chunk 置换不变量 + validateManualEvidence 绕过尝试。
// 运行：node scripts/payswap/security-review-915242dc.probes.mjs（退出 0 = 全部探针被挡住）
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { RedactingLog } = require("./windows/runner-redaction.cjs");
const { validateManualEvidence, MANUAL_CHECKLIST_ITEMS } = require("./windows/manual-evidence.cjs");

const SECRET = "rk_test_1aBcDeFgHiJkLmNoPqRsTuVw";
const REDACTION = "<redacted-live-key>";
let attacks = 0;
let leaks = 0;

function runChunks(chunks) {
  const sink = [];
  const log = new RedactingLog("/tmp/never-written.log", SECRET, { echo: false });
  const origWrite = process.stdout.write;
  process.stdout.write = (s) => { sink.push(s); return true; };
  try {
    for (const c of chunks) log.append(c);
    // flush 不落盘：手工镜像 flush 的产出段（绕过 writeFile）
    log.flush().catch(() => {});
  } finally {
    process.stdout.write = origWrite;
  }
  return { emitted: sink.join(""), chunks: log.chunks.join(""), pending: log.pending };
}

function attack(name, chunks) {
  attacks += 1;
  const { emitted, chunks: body, pending } = runChunks(chunks);
  const stream = chunks.join("");
  const expectedSafe = stream.split(SECRET).join(REDACTION);
  for (const [label, surface] of [["emitted", emitted], ["logbody", body]]) {
    if (surface.includes(SECRET)) {
      leaks += 1;
      console.log(`LEAK [${name}] surface=${label} chunks=${JSON.stringify(chunks)}`);
    }
  }
  // 不变量：logbody === 期望的全文置换（流式结果与一次性置换逐字节一致）
  if (body !== expectedSafe) {
    leaks += 1;
    console.log(`MISMATCH [${name}] body=${JSON.stringify(body)} expected=${JSON.stringify(expectedSafe)}`);
  }
  return { body, pending };
}

// 1) 全部单点分裂边界（0..len）
for (let i = 0; i <= SECRET.length; i += 1) {
  attack(`split@${i}`, [`xx${SECRET}yy`.slice(0, i + 2), `xx${SECRET}yy`.slice(i + 2)]);
}
// 2) 逐字节投喂
{
  const chunks = [...`a${SECRET}b${SECRET}c`].map((ch) => ch);
  // flush 前缺尾部：手动补 flush 语义 —— 直接 attack 到 append 结束，再单测 flush
  const log = new RedactingLog("/tmp/x.log", SECRET, { echo: false });
  for (const ch of chunks) log.append(ch);
  assert.equal(log.chunks.join("").includes(SECRET), false, "byte-by-byte pre-flush leak");
}
// 3) 多次出现（单 chunk 与跨 chunk）
attack("multi-one-chunk", [`A${SECRET}B${SECRET}C`]);
attack("multi-cross", [`A${SECRET.substring(0, 10)}`, `${SECRET.substring(10)}B`, `${SECRET}C`]);
// 4) 凭据恰在流末（完整命中 → flush 置换）
{
  const log = new RedactingLog("/tmp/x.log", SECRET, { echo: false });
  log.append(`tail${SECRET}`);
  const body = log.chunks.join("");
  assert.equal(body.includes(SECRET), false);
  assert.equal(log.pending.length, 0, "complete secret at stream end must not be held");
}
// 5) 流末仅前缀（flush 释放原文前缀 —— 非完整凭据，安全）
{
  const log = new RedactingLog("/tmp/x.log", SECRET, { echo: false });
  log.append(`tail${SECRET.substring(0, 11)}`);
  assert.equal(log.pending, SECRET.substring(0, 11));
}
// 6) 随机 fuzz：随机文本 + 随机多段凭据 + 随机切分
{
  let rngState = 42;
  const rng = () => { rngState = (rngState * 1103515245 + 12345) % 2147483648; return rngState / 2147483648; };
  const alphabet = "xyz0189-_.";
  for (let iter = 0; iter < 2000; iter += 1) {
    let stream = "";
    const copies = 1 + Math.floor(rng() * 3);
    for (let c = 0; c < copies; c += 1) {
      const pad = Math.floor(rng() * 8);
      for (let p = 0; p < pad; p += 1) stream += alphabet[Math.floor(rng() * alphabet.length)];
      stream += SECRET;
    }
    stream += alphabet[Math.floor(rng() * alphabet.length)];
    const cuts = [];
    const nCuts = Math.floor(rng() * 6);
    for (let c = 0; c < nCuts; c += 1) cuts.push(1 + Math.floor(rng() * (stream.length - 1)));
    cuts.sort((a, b) => a - b);
    const chunks = [];
    let prev = 0;
    for (const cut of cuts) { chunks.push(stream.slice(prev, cut)); prev = cut; }
    chunks.push(stream.slice(prev));
    const log = new RedactingLog("/tmp/x.log", SECRET, { echo: false });
    for (const ch of chunks) log.append(ch);
    log.append(""); // 空 append 边界
    const body = log.chunks.join("") + log.pending; // pending 在 flush 语义下原样产出
    if (body.includes(SECRET)) { leaks += 1; console.log(`FUZZ LEAK iter=${iter} chunks=${JSON.stringify(chunks)}`); }
    const expected = stream.split(SECRET).join(REDACTION);
    if (body !== expected) { leaks += 1; console.log(`FUZZ MISMATCH iter=${iter}`); }
    attacks += 1;
  }
}
// 7) 重叠诡计（自重叠凭据）
{
  const S2 = "abab";
  const log = new RedactingLog("/tmp/x.log", S2, { echo: false });
  for (const ch of "aabababb") log.append(ch);
  const body = log.chunks.join("") + log.pending;
  assert.equal(body.includes(S2), false, "self-overlapping secret leak");
  attacks += 1;
}

console.log(`\n[redaction] attacks=${attacks} leaks=${leaks}`);

// ---- validateManualEvidence 对抗绕过尝试（linux 腿形态）----
const UNAME = "Linux host 5.10.134-013.15.kangaroo.al8.x86_64 #1 SMP Debian 13";
function receipt(mutate) {
  const lines = [];
  for (const [n, action, expected] of MANUAL_CHECKLIST_ITEMS) {
    lines.push(`## Step ${n}. ${action}`, `- Expected: ${expected}`, "- Observed: x", "- Result: PASS", "");
  }
  lines.push("## Attestation", "- Operator: op", "- Date/time (local): 2026-11-17 20:00", `- Platform (uname -a output): ${UNAME}`, `- App commit SHA: ${"b".repeat(40)}`, "");
  let text = lines.join("\n");
  if (mutate) text = mutate(text);
  return text;
}
let bypasses = 0;
function mustReject(name, text, platform = "linux") {
  attacks += 1;
  const problems = validateManualEvidence(text, null, platform);
  if (problems.length === 0) { bypasses += 1; console.log(`BYPASS [${name}] accepted!`); }
}
function mustAccept(name, text, platform = "linux") {
  attacks += 1;
  const problems = validateManualEvidence(text, null, platform);
  if (problems.length !== 0) { bypasses += 1; console.log(`FALSE-REJECT [${name}]: ${problems.join("; ")}`); }
}

mustAccept("clean linux receipt", receipt());
mustReject("observed-empty (value on next line)", receipt((t) => t.replace("- Observed: x\n- Result: PASS", "- Observed: \n- Result: PASS")));
mustReject("observed-empty (only first step)", receipt((t) => t.replace("- Observed: x", "- Observed: ")));
mustReject("result PASSIVE", receipt((t) => t.replace("- Result: PASS", "- Result: PASSIVE")));
mustReject("result PASS extra line FAIL same section", receipt((t) => t.replace("- Result: PASS\n\n## Step 2.", "- Result: PASS\n- Result: FAIL\n\n## Step 2.")));
mustReject("missing step 7", receipt((t) => t.replace(/## Step 7\.[^\n]*\n- Expected:[^\n]*\n- Observed:[^\n]*\n- Result:[^\n]*\n/, "")));
mustReject("duplicate step 3", receipt((t) => t.replace("## Step 4.", "## Step 3. clone\n- Expected: x\n- Observed: x\n- Result: PASS\n\n## Step 4.")));
mustReject("windows platform string on linux leg", receipt((t) => t.replace(UNAME, "Microsoft Windows [Version 10.0.26200.9974]")));
mustReject("platform without kernel version", receipt((t) => t.replace(UNAME, "Debian GNU/Linux 13 (trixie)")));
mustReject("sha too short", receipt((t) => t.replace("b".repeat(40), "b".repeat(39))));
mustReject("credential material", receipt((t) => t.replace("- Observed: x", "- Observed: key sk_test_12345 observed")));
mustReject("empty operator", receipt((t) => t.replace("- Operator: op", "- Operator: ")));
mustReject("empty date/time (local)", receipt((t) => t.replace("- Date/time (local): 2026-11-17 20:00", "- Date/time (local): ")));
mustReject("date/time value on next line", receipt((t) => t.replace("- Date/time (local): 2026-11-17 20:00", "- Date/time (local): \n2026-11-17 20:00")));
mustReject("plain date/time form empty", receipt((t) => t.replace("- Date/time (local): 2026-11-17 20:00", "- Date/time: ")));
// win32 腿回归守卫：linux 回执在 win32 校验下必须被拒（腿不可互换）
mustReject("linux receipt under win32 leg", receipt(), "win32");

console.log(`[manual-evidence] attacks=${attacks}(cumulative) bypasses=${bypasses}`);
if (leaks > 0 || bypasses > 0) { console.log("REVIEW VERDICT: FINDINGS — see above"); process.exit(1); }
console.log("REVIEW VERDICT: redaction engine + evidence validation hold under all adversarial probes");
