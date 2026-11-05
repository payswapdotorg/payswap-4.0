#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CANONICAL_RELATIVE = "docs/payswap/p0/10-roadmap.md";
const REQUIRED_MILESTONES = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"];
const VALID_STATUSES = "not_started|in_progress|blocked|gate_passed|complete";

function markdownFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) found.push(...markdownFiles(absolute));
    else if (entry.endsWith(".md")) found.push(absolute);
  }
  return found;
}

function readRequired(path, label, errors) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    errors.push(`Cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

export function validateRoadmap(repositoryRoot = DEFAULT_ROOT) {
  const root = resolve(repositoryRoot);
  const docsRoot = join(root, "docs", "payswap");
  const canonicalPath = join(root, CANONICAL_RELATIVE);
  const indexPath = join(docsRoot, "README.md");
  const playbookPath = join(docsRoot, "IMPLEMENTATION-PLAYBOOK.md");
  const errors = [];

  if (!existsSync(docsRoot)) return ["Missing docs/payswap directory."];

  const roadmap = readRequired(canonicalPath, "canonical roadmap", errors);
  const index = readRequired(indexPath, "PaySwap documentation index", errors);
  const playbook = readRequired(playbookPath, "implementation playbook", errors);

  if (!roadmap.includes("## Live delivery status — single authoritative register")) {
    errors.push("Canonical roadmap is missing its authoritative live-status register.");
  }
  if (!roadmap.includes("## Execution authority and autonomous phase advancement")) {
    errors.push("Canonical roadmap is missing the autonomous phase-advancement contract.");
  }
  if (!index.includes(CANONICAL_RELATIVE) || !index.includes("only authoritative roadmap")) {
    errors.push("Documentation index must identify and link the only authoritative roadmap.");
  }
  if (!playbook.includes(CANONICAL_RELATIVE) || !playbook.includes("do not ask for the next phase")) {
    errors.push("Implementation playbook must bind to the canonical roadmap and autonomous advancement.");
  }

  for (const milestone of REQUIRED_MILESTONES) {
    const headingPattern = new RegExp(`^### ${milestone}\\s+—\\s+.+$`, "gm");
    const count = [...roadmap.matchAll(headingPattern)].length;
    if (count !== 1) {
      errors.push(`Canonical roadmap must define exactly one ${milestone} milestone heading; found ${count}.`);
    }
    const statusPattern = new RegExp(`^\\| ${milestone}(?: — [^|]+)? \\| (${VALID_STATUSES}) \\|`, "m");
    if (!statusPattern.test(roadmap)) {
      errors.push(`Canonical status register is missing a valid status row for ${milestone}.`);
    }
  }

  for (const path of markdownFiles(docsRoot)) {
    if (path === canonicalPath) continue;
    if (/roadmap/i.test(basename(path))) {
      errors.push(`A second roadmap-named document is not allowed: ${relative(root, path)}`);
    }
    const content = readFileSync(path, "utf8");
    const duplicateHeadings = content.match(/^### P[1-9]\s+—\s+.+$/gm) ?? [];
    if (duplicateHeadings.length > 0) {
      errors.push(`Milestone definitions found outside the canonical roadmap: ${relative(root, path)}`);
    }
  }

  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = validateRoadmap();
  if (errors.length > 0) {
    console.error(`PaySwap roadmap integrity FAILED (${errors.length} finding(s)):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log("PaySwap roadmap integrity passed: one canonical P1–P9 roadmap and status register.");
  }
}
