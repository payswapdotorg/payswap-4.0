#!/usr/bin/env node
"use strict";

/**
 * PaySwap P2 —— 原生 Windows 验收 runner（环境就绪审计 2026-11-17 交付物）。
 *
 * 使命：在**原生 Windows 桌面机**上以可复现、不静默跳过的方式执行 P2 验收五分类，
 * 产出消毒证据工件（日志 + summary.json + SHA-256 manifest）。本 runner 是
 * `docs/payswap/p2/ENVIRONMENT-READINESS-HANDOFF.md` 的执行面；语义登记于
 * `docs/payswap/p2/environment-readiness-report.md`。
 *
 * 五分类（handoff「Windows acceptance runner」条款 —— runner 必须区分，不得合并）：
 *   1. windows-build          原生 Windows 构建测试（frozen install + CI 证明的
 *                              build:bootstrap 序列）
 *   2. windows-secure-storage  Windows 安全存储测试（真 Electron DPAPI 探针 +
 *                              生产键仓法则回归 + harness 平台门回归）
 *   3. windows-desktop-e2e     Windows 桌面 E2E（真实窗口连接旅程 spec：
 *                              payswap-connection-ui —— 合成键、无网络面）
 *   4. stripe-live             真 Stripe live 测试账户测试（E2E live spec +
 *                              对话面 live harness —— 真键、真 api.stripe.com）
 *   5. conversation-acceptance 对话级验收（New Task 全流程：自动半 = live harness
 *                              的桥两跳形态；交互半 = 人工清单 + 证据回执校验）
 *
 * 不静默跳过纪律（硬法则）：
 * - 每阶段执行前跑 preflight（preflight-env.cjs --json）；能力缺失 → 该阶段判
 *   SKIP(reason)，**run 级永不因 SKIP 而绿**（退出码 2；--allow-skip 仅显式承认，
 *   退出码不变）。
 * - 阶段结论词汇闭集：PASS / FAIL / BOUNDARY / SKIP / MANUAL-PENDING。
 *   BOUNDARY = live harness 的 RESULT_HARNESS=1（lawful typed 拒绝边界 —— 证据
 *   已取回但**不是** P2 终局；不得按绿报告）。
 * - MANUAL-PENDING = 交互验收的证据回执缺席（对话级验收需要真人 + 真应用）。
 *
 * 秘密纪律：ZCODE_E2E_STRIPE_LIVE_KEY 只经子进程 env 注入；所有落盘日志先做
 * 键值置换（<redacted-live-key>），工件定稿前逐文件**字节级**泄漏自检（发现即
 * FAIL + LEAK 标记，绝不落原始字节）。runner 自身永不回显键值。
 *
 * 用法（原生 Windows，repo 根目录，PowerShell 或 cmd）：
 *   node scripts\payswap\windows\run-p2-acceptance.cjs --list
 *   node scripts\payswap\windows\run-p2-acceptance.cjs --dry-run
 *   node scripts\payswap\windows\run-p2-acceptance.cjs                       # 全五阶段
 *   node scripts\payswap\windows\run-p2-acceptance.cjs --stage windows-secure-storage
 *   set ZCODE_E2E_STRIPE_LIVE_KEY=rk_test_...   # 0600 env 文件加载后（勿入命令行历史）
 *   node scripts\payswap\windows\run-p2-acceptance.cjs --stage stripe-live
 *
 * 退出码：0 = 所选阶段全 PASS；1 = 任一 FAIL/BOUNDARY；2 = 任一 SKIP/MANUAL-PENDING
 * （或 --assume-stage-passed 在场）；3 = 用法错误。
 */

const cp = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PREFLIGHT = path.join(REPO_ROOT, "scripts", "payswap", "preflight-env.cjs");
const PROBE_SCRIPT = path.join(REPO_ROOT, "scripts", "payswap", "electron-safe-storage-probe.cjs");
const GATE_TEST = path.join(REPO_ROOT, "scripts", "payswap", "live", "safe-storage-backend-gate.test.mjs");
const LIVE_MAIN = path.join(REPO_ROOT, "scripts", "payswap", "live", "main.cjs");
const BUILD_LIVE_HARNESS = path.join(REPO_ROOT, "scripts", "payswap", "live", "build-live-harness.mjs");
const MANUAL_EVIDENCE = require("./manual-evidence.cjs");
const { MANUAL_CHECKLIST_ITEMS, CREDENTIAL_PATTERNS, validateManualEvidence, renderManualChecklist } = MANUAL_EVIDENCE;
const RUNNER_REDACTION = require("./runner-redaction.cjs");
const { REDACTION, longestSecretPrefixSuffix, RedactingLog, leakScan, sanitizeLeaks } = RUNNER_REDACTION;

const STAGE_ORDER = [
  "windows-build",
  "windows-secure-storage",
  "windows-desktop-e2e",
  "stripe-live",
  "conversation-acceptance",
];

function parseArgs(argv) {
  const options = {
    stages: [],
    list: false,
    dryRun: false,
    artifactsDir: null,
    skipInstall: false,
    allowSkip: false,
    assumeStagePassed: [],
    manualEvidence: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--stage") {
      const value = argv[i + 1];
      if (!value) return { error: "--stage requires a value" };
      if (!STAGE_ORDER.includes(value)) return { error: `unknown stage '${value}' (use --list)` };
      options.stages.push(value);
      i += 1;
    } else if (arg === "--list") {
      options.list = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--artifacts-dir") {
      const value = argv[i + 1];
      if (!value) return { error: "--artifacts-dir requires a value" };
      options.artifactsDir = value;
      i += 1;
    } else if (arg === "--skip-install") {
      options.skipInstall = true;
    } else if (arg === "--allow-skip") {
      options.allowSkip = true;
    } else if (arg === "--assume-stage-passed") {
      const value = argv[i + 1];
      if (!value) return { error: "--assume-stage-passed requires a value" };
      if (!STAGE_ORDER.includes(value)) return { error: `unknown stage '${value}'` };
      options.assumeStagePassed.push(value);
      i += 1;
    } else if (arg === "--manual-evidence") {
      const value = argv[i + 1];
      if (!value) return { error: "--manual-evidence requires a path" };
      options.manualEvidence = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      return { error: `unknown argument '${arg}'` };
    }
  }
  if (options.stages.length === 0) options.stages = [...STAGE_ORDER];
  return { options };
}

function quoteForWindowsShell(token) {
  if (/[\s"^&|<>()!]/.test(token)) return `"${token.replace(/"/g, '""')}"`;
  return token;
}

/** 子进程执行 + 全量日志捕获（stdout/stderr 合流、键值置换、超时保护）。 */
function execStep(log, command, args, options = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(options.env || {}) };
    // Windows 的 pnpm 是 .cmd shim —— Node >= 20 的 EINVAL 防线要求走 shell；
    // 命令词表为 runner 固定词（无用户输入拼接），引号由 quoteForWindowsShell 负责。
    const viaShell = process.platform === "win32" && command !== process.execPath;
    const child = viaShell
      ? cp.spawn([command, ...args].map(quoteForWindowsShell).join(" "), {
          shell: true,
          cwd: options.cwd || REPO_ROOT,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : cp.spawn(command, args, {
          cwd: options.cwd || REPO_ROOT,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (!settled) {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          }
        }, options.timeoutMs)
      : null;
    child.stdout.on("data", (d) => log.append(d.toString("utf8")));
    child.stderr.on("data", (d) => log.append(d.toString("utf8")));
    child.on("error", (error) => {
      settled = true;
      if (timer) clearTimeout(timer);
      log.append(`\n[runner] spawn error: ${error.message}\n`);
      resolve({ code: -1 });
    });
    child.on("close", (code) => {
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: code === null ? -1 : code });
    });
  });
}

async function sha256File(filePath) {
  const content = await fsp.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
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

/** 子进程 preflight（--json）：launch 失败 / 无 JSON / 平台不符 = {ok:false}。
 *  preflight 自身按 fail-level 检查退 1 但仍产出合法 JSON —— 那是合法的「能力
 *  裁决」（阶段按 executable=false 得到诚实 SKIP），不算 malformed。 */
async function runPreflight(options = {}) {
  const script = options.script || PREFLIGHT;
  const expectedPlatform = options.platform || process.platform;
  const out = await new Promise((resolve) => {
    let buf = "";
    const child = cp.spawn(process.execPath, [script, "--json", "--require-live-key"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      buf += d.toString("utf8");
    });
    child.on("error", (error) => resolve({ code: -1, buf, spawnError: String(error.message || error) }));
    child.on("close", (code) => resolve({ code: code === null ? -1 : code, buf }));
  });
  if (out.spawnError) {
    return { ok: false, reason: `preflight process failed to launch: ${out.spawnError}` };
  }
  const start = out.buf.indexOf("{");
  if (start < 0) {
    return { ok: false, reason: `preflight produced no JSON (exit=${out.code})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(out.buf.slice(start));
  } catch {
    return { ok: false, reason: `preflight JSON unparsable (exit=${out.code})` };
  }
  const shape = validatePreflightJson(parsed, expectedPlatform);
  if (!shape.ok) return shape;
  return { ok: true, preflight: parsed, exitCode: out.code };
}

// ---------------------------------------------------------------------------
// 交互验收人工清单（conversation-acceptance 阶段的证据模板 —— 与
// docs/payswap/p2/ENVIRONMENT-READINESS-HANDOFF.md 同源同序）
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 阶段实现
// ---------------------------------------------------------------------------

function stageDir(artifactsDir, stageId) {
  return path.join(artifactsDir, stageId);
}

async function stageWindowsBuild(context) {
  const dir = stageDir(context.artifactsDir, "windows-build");
  const log = new RedactingLog(path.join(dir, "windows-build.log"), context.secret);
  const steps = [];
  if (!context.options.skipInstall) {
    log.append("[runner] step: pnpm install --frozen-lockfile\n");
    const install = await execStep(log, "pnpm", ["install", "--frozen-lockfile"], { timeoutMs: 20 * 60 * 1000 });
    steps.push({ name: "pnpm install --frozen-lockfile", code: install.code });
  } else {
    log.append("[runner] step: pnpm install skipped (--skip-install)\n");
    steps.push({ name: "pnpm install --frozen-lockfile", code: 0, skipped: true });
  }
  log.append("[runner] step: pnpm build:bootstrap (workspace packages + desktop build:no-runtime-assets — the CI-proven sequence)\n");
  const build = await execStep(log, "pnpm", ["build:bootstrap"], { timeoutMs: 40 * 60 * 1000 });
  steps.push({ name: "pnpm build:bootstrap", code: build.code });
  await log.flush();
  return { verdict: steps.every((s) => s.code === 0) ? "PASS" : "FAIL", steps, logPath: log.filePath };
}

async function stageWindowsSecureStorage(context) {
  const dir = stageDir(context.artifactsDir, "windows-secure-storage");
  const log = new RedactingLog(path.join(dir, "windows-secure-storage.log"), context.secret);
  const steps = [];

  // 1) 真 Electron DPAPI 探针（isEncryptionAvailable + 往返 + 平台事实）。
  log.append("[runner] step: real-Electron safeStorage DPAPI probe\n");
  const probe = await execStep(log, process.execPath, [context.electronCli, PROBE_SCRIPT], {
    timeoutMs: 3 * 60 * 1000,
  });
  steps.push({ name: "electron safeStorage DPAPI probe (exit 0 = available + round-trip ok)", code: probe.code === 0 ? 0 : 1 });

  // 2) 生产键仓法则回归（win32 平台值流入测试矩阵）——CI 同款调用面：
  //    仓库根 `pnpm exec vitest run --project engineering <repo 相对路径>`（ci.yml
  //    "Payswap P2 engineering law battery"）。--filter exec 形态在包目录内找不
  //    到 workspace 工程（No test files found），不是合法的调用面。
  log.append("\n[runner] step: production P2 law battery (vitest --project engineering, CI-canonical, win32)\n");
  const vitest = await execStep(
    log,
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--project",
      "engineering",
      "packages/desktop/test/payswap-account-connection-ipc.test.ts",
      "packages/desktop/test/payswap-account-runtime-wiring.test.ts",
      "packages/desktop/test/payswap-psp-key-store.test.ts",
      "packages/desktop/test/payswap-psp-warmup.test.ts",
      "packages/desktop/test/payswap-psp-storage-backend-policy.test.ts",
      "packages/desktop/test/payswap-reader-bridge-entry.test.ts",
      "packages/desktop/test/payswap-reader-bridge-relay.test.ts",
      "packages/services/test/payswap-account-data.test.ts",
      "packages/services/test/payswap-account-runtime.test.ts",
      "packages/services/test/payswap-account-service.test.ts",
      "packages/services/test/payswap-credential-security.test.ts",
      "packages/services/test/payswap-stripe-read-back.test.ts",
      "packages/ui/test/payswap-connection-ui-presentation.test.ts",
    ],
    { timeoutMs: 15 * 60 * 1000 },
  );
  steps.push({ name: "vitest: P2 engineering law battery (13 suites, CI-canonical surface)", code: vitest.code });

  // 3) harness 平台门回归（win32 路径永不触碰 Linux-only API）。
  log.append("\n[runner] step: harness platform-gate regression (node --test)\n");
  const gate = await execStep(log, process.execPath, ["--test", GATE_TEST], { timeoutMs: 60 * 1000 });
  steps.push({ name: "node --test safe-storage-backend-gate (win32 never calls getSelectedStorageBackend)", code: gate.code });

  await log.flush();
  return {
    verdict: steps.every((s) => s.code === 0) ? "PASS" : "FAIL",
    steps,
    logPath: log.filePath,
    note: "DPAPI proof = real Electron runtime round-trip + production key-store law on win32; at-rest ciphertext inspection is carried by the windows-desktop-e2e / stripe-live specs",
  };
}

async function stageWindowsDesktopE2E(context) {
  const dir = stageDir(context.artifactsDir, "windows-desktop-e2e");
  const log = new RedactingLog(path.join(dir, "windows-desktop-e2e.log"), context.secret);
  log.append("[runner] step: desktop E2E — payswap-connection-ui spec (real window, real ipcMain, real store files; synthetic secrets, replay-isolated)\n");
  const e2e = await execStep(
    log,
    "pnpm",
    ["--filter", "@zcode/desktop", "test:e2e", "--", "--spec", "test/e2e/payswap-connection-ui.test.ts"],
    {
      timeoutMs: 45 * 60 * 1000,
      env: { ZCODE_E2E_RUN_ID: `p2-acceptance-${context.runStamp}` },
    },
  );
  await log.flush();
  return {
    verdict: e2e.code === 0 ? "PASS" : "FAIL",
    steps: [
      {
        name: "wdio: payswap-connection-ui.test.ts (connection journey, at-rest ciphertext, refresh closed set, revoke, corrupted-key restart)",
        code: e2e.code,
      },
    ],
    logPath: log.filePath,
  };
}

function parseResultHarness(text) {
  const match = /\bRESULT_HARNESS=(\d+)/.exec(text || "");
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

async function stageStripeLive(context) {
  const dir = stageDir(context.artifactsDir, "stripe-live");
  const log = new RedactingLog(path.join(dir, "stripe-live.log"), context.secret);
  const steps = [];

  if (!context.secret) {
    await log.flush();
    return {
      verdict: "SKIP",
      steps,
      logPath: log.filePath,
      skipReason: "ZCODE_E2E_STRIPE_LIVE_KEY absent — live stages require the restricted test key",
    };
  }

  // 1) E2E live spec：真键经真连接 UI（connect→verified→revoke，stronger-than-CI）。
  log.append("[runner] step: E2E live spec — payswap-connection-live (real restricted key through the real connection UI)\n");
  const e2e = await execStep(
    log,
    "pnpm",
    ["--filter", "@zcode/desktop", "test:e2e", "--", "--spec", "test/e2e/payswap-connection-live.test.ts"],
    {
      timeoutMs: 45 * 60 * 1000,
      env: {
        ZCODE_E2E_STRIPE_LIVE_KEY: context.secret,
        ZCODE_E2E_RUN_ID: `p2-acceptance-live-${context.runStamp}`,
      },
    },
  );
  steps.push({
    name: "wdio: payswap-connection-live.test.ts (connect connected / refresh verified / revoke + at-rest deletion)",
    code: e2e.code,
  });

  // 2) 对话面 live harness：生产装配 × 真桥 × 真键（build → electron main.cjs）。
  log.append("\n[runner] step: build the live harness bundle from source\n");
  const built = await execStep(log, process.execPath, [BUILD_LIVE_HARNESS], { timeoutMs: 10 * 60 * 1000 });
  steps.push({ name: "node scripts/payswap/live/build-live-harness.mjs", code: built.code });

  let harnessVerdict = "FAIL";
  if (built.code === 0) {
    const liveOutDir = path.join(dir, "live-harness-out");
    await fsp.mkdir(liveOutDir, { recursive: true });
    log.append("\n[runner] step: conversational live harness — real Electron main, real api.stripe.com\n");
    const harness = await execStep(log, process.execPath, [context.electronCli, LIVE_MAIN], {
      timeoutMs: 20 * 60 * 1000,
      env: {
        ZCODE_E2E_STRIPE_LIVE_KEY: context.secret,
        ZCODE_PAYSWAP_LIVE_OUT_DIR: liveOutDir,
      },
    });
    // RESULT 语义（scripts/payswap/live/README.md）：0 = 四类别数据落地；
    // 1 = 拒绝边界（typed refusal —— lawful 但非终局）；其余/缺席 = 完整性失败。
    const resultText = await fsp.readFile(path.join(liveOutDir, "RESULT-harness.txt"), "utf8").catch(() => null);
    const resultValue = parseResultHarness(resultText);
    if (harness.code === 0 && resultValue === 0) {
      harnessVerdict = "PASS";
      steps.push({
        name: "electron main.cjs live harness (RESULT_HARNESS=0 — four-category data via direct + bridge forms)",
        code: 0,
      });
    } else if (resultValue === 1) {
      harnessVerdict = "BOUNDARY";
      steps.push({
        name: "electron main.cjs live harness (RESULT_HARNESS=1 — typed refusal boundary, e.g. read_back_unavailable on a not-yet-activated account)",
        code: 1,
        boundary: true,
      });
    } else {
      steps.push({
        name: `electron main.cjs live harness (exit=${harness.code}, RESULT_HARNESS=${resultValue === null ? "unparsable/missing" : resultValue})`,
        code: 1,
      });
    }
  } else {
    steps.push({ name: "live harness bundle build failed", code: built.code });
  }

  await log.flush();
  if (steps[0].code !== 0) return { verdict: "FAIL", steps, logPath: log.filePath };
  if (harnessVerdict === "PASS") return { verdict: "PASS", steps, logPath: log.filePath };
  if (harnessVerdict === "BOUNDARY") {
    return {
      verdict: "BOUNDARY",
      steps,
      logPath: log.filePath,
      note: "live harness reached the lawful typed-refusal boundary (RESULT_HARNESS=1): evidence retrieved, but this is NOT P2 final evidence — see docs/payswap/p2/live-acceptance-evidence.md §1.3 (account activation) and re-run after the blocker clears",
    };
  }
  return { verdict: "FAIL", steps, logPath: log.filePath };
}

async function stageConversationAcceptance(context) {
  const dir = stageDir(context.artifactsDir, "conversation-acceptance");
  await fsp.mkdir(dir, { recursive: true });
  const checklistPath = path.join(dir, "manual-new-task-checklist.md");
  await fsp.writeFile(checklistPath, renderManualChecklist(), "utf8");

  const evidencePath =
    context.options.manualEvidence || path.join(dir, "manual-new-task-evidence.md");
  if (!fs.existsSync(evidencePath)) {
    return {
      verdict: "MANUAL-PENDING",
      steps: [],
      logPath: checklistPath,
      note: `interactive New Task acceptance requires a human in the real app — checklist emitted to ${path.relative(REPO_ROOT, checklistPath)}; fill it in, save as manual-new-task-evidence.md, re-run with --manual-evidence`,
    };
  }
  const text = await fsp.readFile(evidencePath, "utf8");
  const problems = validateManualEvidence(text, context.secret);
  if (problems.length > 0) {
    return {
      verdict: "FAIL",
      steps: [],
      logPath: evidencePath,
      note: `manual evidence validation failed: ${problems.join("; ")}`,
    };
  }
  const passed = (text.match(/-\s*Result:\s*PASS\b/g) || []).length;
  return {
    verdict: "PASS",
    steps: [{ name: "manual New Task evidence validated (13/13 PASS + full attestation)", code: 0, answered: passed }],
    logPath: evidencePath,
    note: "operator-attested interactive evidence (manual, not automated) — recorded as such in the summary",
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const STAGE_TITLES = {
  "windows-build": "Windows build tests (frozen install + CI-proven build sequence)",
  "windows-secure-storage": "Windows secure-storage tests (real-Electron DPAPI probe + key-store law regression)",
  "windows-desktop-e2e": "Windows desktop E2E (real-window connection journey spec)",
  "stripe-live": "Real Stripe live-test-account tests (E2E live spec + conversational live harness)",
  "conversation-acceptance": "Conversation-level acceptance (New Task workflow — bridge forms automated in stripe-live + interactive manual evidence)",
};

async function main() {
  const { error, options } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(`[runner] usage error: ${error}`);
    console.error("run with --help for usage");
    process.exit(3);
  }
  if (options.help) {
    console.log(
      [
        "usage: node scripts/payswap/windows/run-p2-acceptance.cjs [--stage <id>]... [--dry-run] [--list]",
        "       [--artifacts-dir <path>] [--skip-install] [--allow-skip]",
        "       [--assume-stage-passed <id>]... [--manual-evidence <path>]",
        "",
        `stages (in order): ${STAGE_ORDER.join(" -> ")}`,
      ].join("\n"),
    );
    process.exit(0);
  }
  if (options.list) {
    for (const id of STAGE_ORDER) console.log(`${id.padEnd(26)} ${STAGE_TITLES[id]}`);
    process.exit(0);
  }

  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactsDir = options.artifactsDir
    ? path.resolve(options.artifactsDir)
    : path.join(REPO_ROOT, "artifacts", "p2-acceptance", runStamp);
  await fsp.mkdir(artifactsDir, { recursive: true });

  const secret = (process.env.ZCODE_E2E_STRIPE_LIVE_KEY || "").trim() || null;
  // fail-closed preflight（defect C 关闭）：launch 失败 / JSON 缺失或畸形 / 平台不符
  // ⇒ preflightResult.ok=false ⇒ 所有选定阶段判 FAIL，run 退出码 1，绝不执行任何阶段。
  const preflightResult = await runPreflight();
  let preflight = null;
  let preflightStages = {};
  if (preflightResult.ok) {
    preflight = preflightResult.preflight;
    await fsp.writeFile(path.join(artifactsDir, "preflight.json"), JSON.stringify(preflight, null, 2), "utf8");
    preflightStages = Object.fromEntries(preflight.stages.map((s) => [s.id, s]));
  } else {
    await fsp.writeFile(
      path.join(artifactsDir, "preflight-error.txt"),
      `preflight unusable — no stage may execute (fail-closed):\n${preflightResult.reason}\n`,
      "utf8",
    );
  }

  function resolveElectronCli() {
    const candidates = [
      path.join(REPO_ROOT, "packages", "desktop", "node_modules", "electron", "cli.js"),
      path.join(REPO_ROOT, "node_modules", "electron", "cli.js"),
    ];
    for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
    return null;
  }
  const context = {
    options,
    artifactsDir,
    runStamp,
    secret,
    electronCli: resolveElectronCli(),
    preflight,
  };

  const results = {};
  const assumed = new Set(options.assumeStagePassed);

  console.log(`[runner] P2 acceptance — platform=${process.platform} — ${new Date().toISOString()}`);
  console.log(`[runner] artifacts: ${path.relative(REPO_ROOT, artifactsDir)}`);
  console.log(`[runner] stages selected: ${options.stages.join(", ")}`);
  if (!preflightResult.ok) {
    console.log(`[runner] PREFLIGHT UNUSABLE (fail-closed): ${preflightResult.reason}`);
    console.log("[runner] no stage will execute — nothing may run on an absent/invalid preflight result");
  }
  if (options.dryRun) console.log("[runner] DRY-RUN: preflight + plan only, nothing executes");

  for (const stageId of STAGE_ORDER) {
    if (!options.stages.includes(stageId)) continue;

    // fail-closed 门 1：preflight 不可用 ⇒ FAIL，绝不执行（缺席的结果永远不是执行许可）。
    if (!preflightResult.ok) {
      console.log(`\n[${stageId}] FAIL — preflight unusable: ${preflightResult.reason}`);
      results[stageId] = { verdict: "FAIL", steps: [], note: `preflight unusable (fail-closed): ${preflightResult.reason}` };
      continue;
    }

    // fail-closed 门 2：选定阶段必须拥有 preflight 阶段记录（无记录 = FAIL，不是放行）。
    const pre = preflightStages[stageId];
    if (!pre) {
      console.log(`\n[${stageId}] FAIL — no preflight stage record for '${stageId}' (fail-closed)`);
      results[stageId] = { verdict: "FAIL", steps: [], note: "no preflight stage record — capability never positively established" };
      continue;
    }

    // 能力门（preflight 裁决；缺能力 = SKIP，绝不静默转绿）。
    if (!pre.executable) {
      console.log(`\n[${stageId}] SKIP — preflight gate: ${pre.reasons.join("; ")}`);
      results[stageId] = { verdict: "SKIP", steps: [], skipReason: pre.reasons.join("; ") };
      continue;
    }

    // 依赖门（本 run 的先行阶段须 PASS，或被 --assume-stage-passed 显式承认）。
    const dependencies = {
      "windows-secure-storage": ["windows-build"],
      "windows-desktop-e2e": ["windows-build"],
      "stripe-live": ["windows-build", "windows-secure-storage"],
      "conversation-acceptance": ["stripe-live"],
    }[stageId] || [];
    const unmet = dependencies.filter(
      (dep) => !(options.stages.includes(dep) && results[dep] && results[dep].verdict === "PASS") && !assumed.has(dep),
    );
    if (unmet.length > 0) {
      console.log(
        `\n[${stageId}] SKIP — prerequisite stage(s) not green in this run: ${unmet.join(", ")} (use --assume-stage-passed only when re-running stages against an already-green session)`,
      );
      results[stageId] = { verdict: "SKIP", steps: [], skipReason: `prerequisites not green: ${unmet.join(", ")}` };
      continue;
    }

    if (options.dryRun) {
      console.log(`\n[${stageId}] DRY-RUN — would execute: ${STAGE_TITLES[stageId]}`);
      results[stageId] = { verdict: "SKIP", steps: [], skipReason: "dry-run" };
      continue;
    }

    console.log(`\n[${stageId}] ${STAGE_TITLES[stageId]}`);
    let outcome;
    if (stageId === "windows-build") {
      outcome = await stageWindowsBuild(context);
    } else if (stageId === "windows-secure-storage") {
      outcome = context.electronCli
        ? await stageWindowsSecureStorage(context)
        : { verdict: "SKIP", steps: [], skipReason: "electron cli.js not resolvable (run windows-build first)" };
    } else if (stageId === "windows-desktop-e2e") {
      outcome = await stageWindowsDesktopE2E(context);
    } else if (stageId === "stripe-live") {
      outcome = context.electronCli
        ? await stageStripeLive(context)
        : { verdict: "SKIP", steps: [], skipReason: "electron cli.js not resolvable (run windows-build first)" };
    } else {
      outcome = await stageConversationAcceptance(context);
    }
    results[stageId] = outcome;
    console.log(`[${stageId}] verdict: ${outcome.verdict}`);
    if (outcome.note) console.log(`[${stageId}] ${outcome.note}`);
  }

  // 工件定稿：summary.json + 字节级泄漏自检 + SHA-256 manifest。
  const summary = {
    runner: "payswap-p2-acceptance",
    startedAt: runStamp,
    platform: process.platform,
    platformRelease: os.release(),
    node: process.versions.node,
    commit: cp.execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
    dryRun: options.dryRun,
    assumedStagesPassed: options.assumeStagePassed,
    secretPresent: Boolean(secret),
    stages: {},
  };
  // 工件定稿次序（defect A 关闭）：泄漏扫描 → 裁决污染 results（唯一权威状态）
  // → 就地消毒 → 复扫确认 → 渲染 summary（自 results）→ 写 manifest（只哈希消毒后工件）。
  const leaks = await leakScan(artifactsDir, secret);
  const sanitized = leaks.length > 0 ? await sanitizeLeaks(artifactsDir, secret) : [];
  let rescanHits = leaks;
  if (sanitized.length > 0) {
    rescanHits = await leakScan(artifactsDir, secret);
    if (rescanHits.length > 0) {
      // 消毒后仍命中（如二进制内嵌等不可置换形态）——删除污染文件，绝不让原文进入证据链。
      for (const rel of rescanHits) {
        await fsp.rm(path.join(artifactsDir, rel), { force: true });
      }
      rescanHits = await leakScan(artifactsDir, secret);
    }
  }
  applyLeakVerdicts(results, leaks);
  summary.leakScan = { performed: Boolean(secret), hits: leaks, sanitized, rescanClean: rescanHits.length === 0 };
  for (const [stageId, outcome] of Object.entries(results)) {
    summary.stages[stageId] = {
      verdict: outcome.verdict,
      steps: outcome.steps || [],
      note: outcome.note || outcome.skipReason || null,
      logPath: outcome.logPath ? path.relative(REPO_ROOT, outcome.logPath) : null,
    };
  }
  await fsp.writeFile(path.join(artifactsDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

  const manifest = [];
  async function walk(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else manifest.push(`${await sha256File(full)}  ${path.relative(artifactsDir, full)}`);
    }
  }
  await walk(artifactsDir);
  await fsp.writeFile(path.join(artifactsDir, "MANIFEST-sha256.txt"), manifest.sort().join("\n") + "\n", "utf8");

  // 汇总表 + 退出码同源于 results（泄漏裁决已在其上生效 —— 泄漏绝不可能退出 0）。
  const exitCode = computeExitCode(options.stages, results, assumed);
  console.log("\n================ P2 acceptance summary ================");
  for (const stageId of options.stages) {
    const verdict = results[stageId] ? results[stageId].verdict : "NOT-RUN";
    console.log(`${stageId.padEnd(26)} ${verdict}`);
  }
  console.log("=======================================================");
  if (leaks.length > 0) {
    console.log(`[runner] LEAK HANDLING: ${leaks.length} artifact(s) contaminated; sanitized: ${sanitized.join(", ") || "(none)"}; rescan clean=${rescanHits.length === 0}`);
  }
  if (exitCode === 0) {
    console.log("ALL SELECTED STAGES PASS — attach artifacts/summary.json + MANIFEST-sha256.txt to the evidence register.");
  } else if (exitCode === 1) {
    console.log("NOT GREEN — a stage FAILED or reached a typed-refusal BOUNDARY; no green report is permitted.");
  } else {
    console.log(
      `NOT GREEN — at least one stage was SKIPPED or MANUAL-PENDING${assumed.size > 0 ? " (or a prerequisite was assumed)" : ""}: a skipped test is never a pass${options.allowSkip ? "" : " (--allow-skip records acknowledgement but does not turn the run green)"}.`,
    );
  }
  process.exit(exitCode);
}

/** 退出码唯一权威：由 results + 假设集合推导（纯函数；泄漏裁决先行生效）。
 *  0 = 全 PASS；1 = FAIL/BOUNDARY（含泄漏）；2 = SKIP/MANUAL-PENDING/assumption。 */
function computeExitCode(selectedStages, results, assumed) {
  const verdictRank = { PASS: 0, BOUNDARY: 1, FAIL: 1, SKIP: 2, "MANUAL-PENDING": 2 };
  let worst = 0;
  for (const stageId of selectedStages) {
    const verdict = results[stageId] ? results[stageId].verdict : "NOT-RUN";
    worst = Math.max(worst, verdictRank[verdict] ?? 1);
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

if (require.main === module) {
  main().catch((error) => {
    console.error("[runner] fatal:", error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = {
  RedactingLog,
  longestSecretPrefixSuffix,
  validateManualEvidence,
  validatePreflightJson,
  runPreflight,
  leakScan,
  sanitizeLeaks,
  applyLeakVerdicts,
  computeExitCode,
  MANUAL_CHECKLIST_ITEMS,
  CREDENTIAL_PATTERNS,
  manualEvidenceModule: MANUAL_EVIDENCE,
};
