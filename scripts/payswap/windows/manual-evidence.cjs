// 交互验收人工清单与回执严格校验（自 run-p2-acceptance.cjs 拆出 —— 800 行
// 仓库上限；conversation-acceptance 阶段的证据模板 —— 与
// docs/payswap/p2/ENVIRONMENT-READINESS-HANDOFF.md 同源同序）。

const MANUAL_CHECKLIST_ITEMS = [
  ["1", "Start the real PaySwap desktop application (pnpm dev:desktop:prod, or the installed package)", "the app window opens normally"],
  ["2", "Open the PaySwap connections section in Settings", "the section renders; the connect form is present"],
  ["3", "Connect the Stripe test account with the real restricted read-only key", "the connection lands connected (UI feedback)"],
  ["4", "Inspect the local credential files: ciphertext, never plaintext", "credentials.json contains the connectionId, zero key plaintext"],
  ["5", "Refresh the account", "evidence refreshes to verified; no re-entry of the key required"],
  ["6", "Restart the application (full quit, then start again)", "the connection persists; no re-connect needed"],
  ["7", "Refresh again after restart", "verified; the stored credential is used"],
  ["8", "Open the New Task conversation", "the conversation surface opens normally"],
  ["9", "Ask a natural-language question that requires balance, payment objects, customer summary and disputes data", "the answer reflects real Stripe data (consistent with the dashboard or harness artifacts)"],
  ["10", "Confirm the app used the production PaySwap tools and bridge (no bypass API path)", "the exchange ran through the New Task workflow; no separate Stripe chat surface"],
  ["11", "Check the conversation and logs for customer PII / credential leakage", "no key material, no sensitive PII in the transcript"],
  ["12", "Revoke the connection", "final state revoked; the local secret is deleted"],
  ["13", "Attempt a read after revocation", "typed refusal (fail-closed), not a crash"],
];

function renderManualChecklist() {
  const lines = [
    "# P2 conversation-acceptance — manual New Task evidence",
    "",
    "> Fill every `Result:` line below with what you actually observed, attach sanitized",
    "> screenshots next to this file, then save as `manual-new-task-evidence.md` and re-run:",
    "> `node scripts\\payswap\\windows\\run-p2-acceptance.cjs --stage conversation-acceptance --manual-evidence <path>`",
    "> Never paste the restricted key or customer PII into this file.",
    "",
  ];
  for (const [n, action, expected] of MANUAL_CHECKLIST_ITEMS) {
    lines.push(`## Step ${n}. ${action}`);
    lines.push(`- Expected: ${expected}`);
    lines.push(`- Observed: `);
    lines.push(`- Result: `);
    lines.push("");
  }
  lines.push("## Attestation");
  lines.push("- Operator: ");
  lines.push("- Date/time (local): ");
  lines.push("- Platform (winver output): ");
  lines.push("- App commit SHA: ");
  lines.push("");
  return lines.join("\n");
}

const CREDENTIAL_PATTERNS = [/rk_test_/, /rk_live_/, /sk_test_/, /sk_live_/, /whsec_/];

/** 人工回执严格校验（defect B 关闭）：报告存在 ≠ 验收成功。
 *  - 恰好 13 个步骤标题（Step 1..13），无缺、无重、无未知编号；
 *  - 每步有非空 Observed 且 Result 恰为 PASS（FAIL/BLOCKED/SKIP/空/未知值一律不过）；
 *  - attestation 四要素齐备（operator、date/time、Windows 版本号、40 hex commit SHA）；
 *  - 任何凭据材料形态命中即拒。 */
function validateManualEvidence(text, secret) {
  const problems = [];
  const stepHeadingRe = /^##\s*Step\s*(\d+)\./gm;
  const headings = [];
  let m;
  while ((m = stepHeadingRe.exec(text)) !== null) {
    headings.push({ n: Number.parseInt(m[1], 10), index: m.index });
  }
  const unknown = headings.filter((h) => h.n < 1 || h.n > MANUAL_CHECKLIST_ITEMS.length);
  if (unknown.length > 0) problems.push(`unknown step number(s) present: ${unknown.map((h) => h.n).join(", ")}`);
  for (let n = 1; n <= MANUAL_CHECKLIST_ITEMS.length; n += 1) {
    const found = headings.filter((h) => h.n === n);
    if (found.length === 0) {
      problems.push(`missing step heading: Step ${n}`);
      continue;
    }
    if (found.length > 1) {
      problems.push(`duplicate step heading: Step ${n} appears ${found.length} times`);
      continue;
    }
    const start = found[0].index;
    const nextHeading = text.indexOf("\n## ", start + 1);
    const section = nextHeading >= 0 ? text.slice(start, nextHeading) : text.slice(start);
    // 注意 [ \t]*：\s* 会跨行吞掉换行后下一行的首个非空白，令空 Observed 误判为有值。
    if (!/-\s*Observed:[ \t]*\S/.test(section)) {
      problems.push(`Step ${n}: 'Observed:' is empty — every step needs its own observation`);
    }
    const resultMatches = section.match(/-\s*Result:[^\n]*/g) || [];
    if (resultMatches.length === 0) {
      problems.push(`Step ${n}: no 'Result:' line`);
    } else {
      for (const line of resultMatches) {
        const value = (line.match(/-\s*Result:[ \t]*(\S+)/) || [])[1];
        if (value !== "PASS") {
          problems.push(`Step ${n}: Result is '${value || "(empty)"}' — only 'Result: PASS' is accepted (FAIL/BLOCKED/SKIP never passes)`);
        }
      }
    }
  }
  if (!/Operator:\s*\S/.test(text)) problems.push("Attestation 'Operator:' is empty");
  if (!/(Date\/time|Date\/time \(local\)):\s*\S/.test(text)) problems.push("Attestation 'Date/time' is empty");
  const platformLine = text.match(/Platform[^:\n]*:\s*(\S[^\n]*)/);
  if (!platformLine || !/10\.0\.\d+/.test(platformLine[1])) {
    problems.push("Attestation 'Platform' must contain the exact Windows version/build (10.0.<build> from winver)");
  }
  const shaLine = text.match(/App commit SHA:\s*(\S+)/);
  if (!shaLine || !/^[0-9a-f]{40}$/.test(shaLine[1])) {
    problems.push("Attestation 'App commit SHA' must be the exact 40-hex commit SHA of the tested application");
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) problems.push(`credential material detected in evidence (pattern ${pattern}) — sanitize and re-run`);
  }
  if (secret && text.includes(secret)) problems.push("evidence contains the live key itself");
  return problems;
}

module.exports = {
  MANUAL_CHECKLIST_ITEMS,
  CREDENTIAL_PATTERNS,
  validateManualEvidence,
  renderManualChecklist,
};
