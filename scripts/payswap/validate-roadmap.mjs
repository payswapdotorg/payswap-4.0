#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const docsRoot = join(repositoryRoot, "docs", "payswap");
const canonicalRelative = "docs/payswap/p0/10-roadmap.md";
const canonicalPath = join(repositoryRoot, canonicalRelative);
const indexPath = join(docsRoot, "README.md");
const playbookPath = join(docsRoot, "IMPLEMENTATION-PLAYBOOK.md");
const requiredMilestones = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"];
const errors = [];

function read(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    errors.push(`Cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

function markdownFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) found.push(...markdownFiles(absolute));
    else if (entry.endsWith(".md")) found.push(absolute);
  }
  return found;
}

const roadmap = read(canonicalPath, "canonical roadmap");
const index = read(indexPath, "PaySwap documentation index");
const playbook = read(playbookPath, "implementation playbook");

if (!roadmap.includes("## Live delivery status — single authoritative register")) {
  errors.push("Canonical roadmap is missing its authoritative live-status register.");
}
if (!roadmap.includes("## Execution authority and autonomous phase advancement")) {
  errors.push("Canonical roadmap is missing the autonomous phase-advancement contract.");
}

for (const milestone of requiredMilestones) {
  const headingPattern = new RegExp(`^### ${milestone}\\s+—\\s+.+$`, "gm");
  const count = [...roadmap.matchAll(headingPattern)].length;
  if (count !== 1) errors.push(`Canonical roadmap must define exactly one ${milestone} milestone heading; found ${count}.`);
  const statusPattern = new RegExp(`^\\| ${milestone} \\| (not_started|in_progress|blocked|gate_passed|complete) \\|`, "m");
  if (!statusPattern.test(roadmap)) errors.push(`Canonical status register is missing a valid status row for ${milestone}.`);
}

if (!index.includes(canonicalRelative)) errors.push("Documentation index does not point to the canonical roadmap.");
if (!playbook.includes(canonicalRelative)) errors.push("Implementation playbook does not bind itself to the canonical roadmap.");

const duplicateHeadingPattern = /^### P[1-9]\s+—\s+.+$/gm;
for (const path of markdownFiles(docsRoot)) {
  if (path === canonicalPath) continue;
  const content = readFileSync(path, "utf8");
  if (duplicateHeadingPattern.test(content)) {
    errors.push(`Duplicate milestone heading found outside the canonical roadmap: ${relative(repositoryRoot, path)}`);
  }
  duplicateHeadingPattern.lastIndex = 0;
}

if (errors.length) {
  process.stderr.write(`PaySwap roadmap integrity FAILED (\\${errors.length} finding(s)):\\n`);
  for (const error of errors) process.stderr.write(`- ${error}\\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("PaySwap roadmap integrity passed: one canonical P1–P9 roadmap and status register.\\n");
}
