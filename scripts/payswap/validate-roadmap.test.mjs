import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateRoadmap } from "./validate-roadmap.mjs";

const milestones = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "payswap-roadmap-test-"));
  const docs = join(root, "docs", "payswap");
  mkdirSync(join(docs, "p0"), { recursive: true });
  const headings = milestones.map((id) => `### ${id} — Example milestone`).join("\n");
  const rows = milestones.map((id) => `| ${id} | not_started | fixture |`).join("\n");
  writeFileSync(
    join(docs, "p0", "10-roadmap.md"),
    `## Live delivery status — single authoritative register\n${rows}\n## Execution authority and autonomous phase advancement\n${headings}\n`,
  );
  writeFileSync(join(docs, "README.md"), "The only authoritative roadmap is docs/payswap/p0/10-roadmap.md.\n");
  writeFileSync(
    join(docs, "IMPLEMENTATION-PLAYBOOK.md"),
    "Uses docs/payswap/p0/10-roadmap.md; do not ask for the next phase.\n",
  );
  return root;
}

test("accepts exactly one canonical P1–P9 roadmap with all status rows", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { force: true, recursive: true }));
  assert.deepEqual(validateRoadmap(root), []);
});

test("rejects a duplicate milestone definition outside the canonical roadmap", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { force: true, recursive: true }));
  writeFileSync(
    join(root, "docs", "payswap", "secondary-plan.md"),
    "### P3 — A copied milestone definition\n",
  );
  assert.ok(validateRoadmap(root).some((issue) => issue.includes("Milestone definitions found outside")));
});

test("rejects a missing milestone heading and invalid status", (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const roadmapPath = join(root, "docs", "payswap", "p0", "10-roadmap.md");
  const original = readFileSync(roadmapPath, "utf8");
  writeFileSync(
    roadmapPath,
    original.replace("### P9 — Example milestone\n", "").replace("| P4 | not_started | fixture |", "| P4 | done | fixture |"),
  );
  const issues = validateRoadmap(root);
  assert.ok(issues.some((issue) => issue.includes("exactly one P9 milestone heading")));
  assert.ok(issues.some((issue) => issue.includes("valid status row for P4")));
});
