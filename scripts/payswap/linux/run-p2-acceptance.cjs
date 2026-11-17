#!/usr/bin/env node
"use strict";

/**
 * PaySwap P2-Linux —— Linux 桌面验收 runner（P2 里程碑分解 2026-11-17 交付物）。
 *
 * 使命：在**真实 Linux 桌面腿**（Xvfb + D-Bus 会话 + gnome-keyring Secret
 * Service —— 系统安装或 PAYSWAP_LINUX_LEG_STACK 前缀）上以可复现、不静默
 * 跳过的方式执行 P2 验收五分类，产出消毒证据工件（日志 + summary.json +
 * SHA-256 manifest）。与 windows runner（scripts/payswap/windows/）共享裁决
 * 法则（scripts/payswap/acceptance-verdicts.cjs）与消毒/人工证据模块
 * （runner-redaction.cjs / manual-evidence.cjs —— 平台中立）。
 *
 * 五分类（里程碑分解条款 —— runner 必须区分，不得合并）：
 *   1. linux-build             Linux 构建链（frozen install + E2B 配方证明的
 *                              桌面链构建：e2e-report + @zcode/desktop... build
 *                              + E2E store-bridge renderer）。内存受限机
 *                              （~4GiB）自动带 ZCODE_DESKTOP_BUILD_SOURCEMAPS=off
 *                              （见 vite.config.ts 的注释与该开关的登记）。
 *   2. linux-secure-storage    Linux 安全存储（真 Electron gnome_libsecret 探针
 *                              〔显示腿内〕+ 生产键仓法则回归 + harness 平台门回归）
 *   3. linux-desktop-e2e       Linux 桌面 E2E（真实窗口连接旅程 spec：
 *                              payswap-connection-ui，gnome-libsecret 腿，合成键）
 *   4. stripe-live             真 Stripe live 测试（E2E live spec + 对话面 live
 *                              harness —— 真键、真 api.stripe.com，显示腿内）
 *   5. conversation-acceptance 对话级验收（New Task 全流程：交互清单 + 证据回执
 *                              校验 —— 与 windows runner 同一清单与校验器）
 *
 * 不静默跳过纪律 / 秘密纪律 / 退出码语义：与 windows runner 逐字一致
 * （scripts/payswap/windows/run-p2-acceptance.cjs 头注释；法则面共享于
 * scripts/payswap/acceptance-verdicts.cjs）。
 *
 * 用法（Linux，repo 根目录）：
 *   node scripts/payswap/linux/run-p2-acceptance.cjs --list
 *   node scripts/payswap/linux/run-p2-acceptance.cjs --dry-run
 *   PAYSWAP_LINUX_LEG_STACK=/path/to/prefix node scripts/payswap/linux/run-p2-acceptance.cjs
 *   ZCODE_E2E_STRIPE_LIVE_KEY=rk_test_... node scripts/payswap/linux/run-p2-acceptance.cjs --stage stripe-live
 *
 * 退出码：0 = 所选阶段全 PASS；1 = 任一 FAIL/BOUNDARY；2 = 任一 SKIP/
 * MANUAL-PENDING（或 --assume-stage-passed 在场）；3 = 用法错误。
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
const LEG_SESSION = path.join(__dirname, "leg-session.sh");
const CHROMEDRIVER_PREFLIGHT = path.join(REPO_ROOT, "packages", "desktop", "scripts", "chromedriver-preflight.mjs");
const WDIO_DRIVER_CACHE = path.join(REPO_ROOT, ".cache", "wdio-browser-drivers");
const MANUAL_EVIDENCE = require("../windows/manual-evidence.cjs");
const { validateManualEvidence, renderManualChecklist } = MANUAL_EVIDENCE;
const RUNNER_REDACTION = require("../windows/runner-redaction.cjs");
const { REDACTION, longestSecretPrefixSuffix, RedactingLog, leakScan, sanitizeLeaks } = RUNNER_REDACTION;
const { computeExitCode, applyLeakVerdicts, validatePreflightJson, parseResultHarness } = require("../acceptance-verdicts.cjs");
const LEG_STACK = require("./leg-stack.cjs");

const STAGE_ORDER = [
  "linux-build",
  "linux-secure-storage",
  "linux-desktop-e2e",
  "stripe-live",
  "conversation-acceptance",
];

/** 内存受限构建（~4GiB cgroup）的既定形态：sourcemap 关闭（E2E 面不消费
 *  .map；vite.config.ts 的 ZCODE_DESKTOP_BUILD_SOURCEMAPS 开关注释）+ V8 堆
 *  上限。大内存机可用 PAYSWAP_LINUX_FULL_MEMORY_BUILD=1 保持完整生产面。 */
function buildMemoryEnv() {
  if (process.env.PAYSWAP_LINUX_FULL_MEMORY_BUILD === "1") return {};
  return {
    ZCODE_DESKTOP_BUILD_SOURCEMAPS: "off",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--max-old-space-size=2048`,
  };
}

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

/** 子进程执行 + 全量日志捕获（stdout/stderr 合流、键值置换、超时保护）。
 *  Linux 上 pnpm 是 node 脚本 —— 直接 spawn 即可（win32 .cmd shim 问题不存在）。 */
function execStep(log, command, args, options = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...options.env };
    const child = cp.spawn(command, args, {
      cwd: options.cwd || REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
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

/** 子进程 preflight（--json）：launch 失败 / 无 JSON / 平台不符 = {ok:false}。
 *  preflight 以**腿栈环境**运行（PAYSWAP_LINUX_LEG_STACK 透传）—— 能力裁决
 *  与 runner 执行面必须看到同一个栈。 */
async function runPreflight() {
  const out = await new Promise((resolve) => {
    let buf = "";
    const child = cp.spawn(process.execPath, [PREFLIGHT, "--json", "--require-live-key"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
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
  const shape = validatePreflightJson(parsed, process.platform);
  if (!shape.ok) return shape;
  return { ok: true, preflight: parsed, exitCode: out.code };
}

// ---------------------------------------------------------------------------
// 阶段实现
// ---------------------------------------------------------------------------

function stageDir(artifactsDir, stageId) {
  return path.join(artifactsDir, stageId);
}

async function stageLinuxBuild(context) {
  const dir = stageDir(context.artifactsDir, "linux-build");
  const log = new RedactingLog(path.join(dir, "linux-build.log"), context.secret);
  const steps = [];
  const buildEnv = buildMemoryEnv();
  log.append(
    `[runner] build face: ${
      Object.keys(buildEnv).length > 0
        ? "memory-constrained (ZCODE_DESKTOP_BUILD_SOURCEMAPS=off + heap cap; PAYSWAP_LINUX_FULL_MEMORY_BUILD=1 to keep full production sourcemap face)"
        : "full production face (PAYSWAP_LINUX_FULL_MEMORY_BUILD=1)"
    }\n`,
  );

  if (!context.options.skipInstall) {
    log.append("[runner] step: pnpm install --frozen-lockfile\n");
    const install = await execStep(log, "pnpm", ["install", "--frozen-lockfile"], { timeoutMs: 20 * 60 * 1000 });
    steps.push({ name: "pnpm install --frozen-lockfile", code: install.code });
  } else {
    log.append("[runner] step: pnpm install skipped (--skip-install)\n");
    steps.push({ name: "pnpm install --frozen-lockfile", code: 0, skipped: true });
  }

  // E2B vm-mega-setup 配方证明的桌面链（e2e-report 是 pretest:e2e 依赖）。
  log.append("[runner] step: pnpm --filter @zcode/e2e-report run build:node\n");
  const report = await execStep(log, "pnpm", ["--filter", "@zcode/e2e-report", "run", "build:node"], {
    timeoutMs: 10 * 60 * 1000,
    env: buildEnv,
  });
  steps.push({ name: "pnpm --filter @zcode/e2e-report run build:node", code: report.code });

  log.append("[runner] step: pnpm --filter @zcode/desktop... run build (E2B-proven desktop chain)\n");
  const desktop = await execStep(log, "pnpm", ["--filter", "@zcode/desktop...", "run", "build"], {
    timeoutMs: 40 * 60 * 1000,
    env: buildEnv,
  });
  steps.push({ name: "pnpm --filter @zcode/desktop... run build", code: desktop.code });

  // E2E renderer 以 store-bridge define 重建（wdio onPrepare 的 SKIP_BUILD 前提）。
  log.append("[runner] step: E2E store-bridge renderer build (VITE_ZCODE_E2E_STORE_BRIDGE=1)\n");
  const renderer = await execStep(log, "pnpm", ["exec", "vite", "build"], {
    cwd: path.join(REPO_ROOT, "packages", "desktop"),
    timeoutMs: 20 * 60 * 1000,
    env: {
      ...buildEnv,
      NODE_ENV: "production",
      VITE_ZCODE_E2E_STORE_BRIDGE: "1",
    },
  });
  steps.push({ name: "vite build with VITE_ZCODE_E2E_STORE_BRIDGE=1 (E2E renderer face)", code: renderer.code });

  // 断言：renderer 产物真的带上了 bridge define（形状不对就不是 E2E 面）。
  let bridgeOk = false;
  if (renderer.code === 0) {
    const assetsDir = path.join(REPO_ROOT, "packages", "desktop", "out", "renderer", "assets");
    try {
      for (const entry of await fsp.readdir(assetsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
        const source = await fsp.readFile(path.join(assetsDir, entry.name), "utf8");
        if (/VITE_ZCODE_E2E_STORE_BRIDGE["']?\s*:\s*["'`]1/.test(source)) {
          bridgeOk = true;
          break;
        }
      }
    } catch {
      bridgeOk = false;
    }
  }
  steps.push({
    name: "renderer store-bridge compiled marker assert",
    code: bridgeOk ? 0 : 1,
  });

  await log.flush();
  return { verdict: steps.every((s) => s.code === 0) ? "PASS" : "FAIL", steps, logPath: log.filePath };
}

/** 从探针日志行解析 PAYSWAP_SAFE_STORAGE_PROBE JSON（main.cjs 同款标记协议）。 */
function parseProbeJson(text) {
  const match = /PAYSWAP_SAFE_STORAGE_PROBE (\{.*\})/.exec(text || "");
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

async function stageLinuxSecureStorage(context) {
  const dir = stageDir(context.artifactsDir, "linux-secure-storage");
  const log = new RedactingLog(path.join(dir, "linux-secure-storage.log"), context.secret);
  const steps = [];
  const legEnv = context.legStackEnv;

  // 1) 真 Electron gnome_libsecret 探针（显示腿内：Xvfb + D-Bus + gnome-keyring）。
  //    参数形态与 preflight-env.cjs 的探针调用一致：electron 开关在脚本路径之前。
  log.append("[runner] step: real-Electron safeStorage probe inside the display leg (expected backend: gnome_libsecret)\n");
  const probeLogPath = path.join(dir, "probe.log");
  const probeLog = new RedactingLog(probeLogPath, context.secret);
  const probe = await execStep(
    probeLog,
    "bash",
    [LEG_SESSION, process.execPath, context.electronCli, "--no-sandbox", "--password-store=gnome-libsecret", PROBE_SCRIPT],
    {
      timeoutMs: 5 * 60 * 1000,
      env: legEnv,
    },
  );
  await probeLog.flush();
  const probeText = await fsp.readFile(probeLogPath, "utf8").catch(() => "");
  const probeJson = parseProbeJson(probeText);
  const probeBackendOk = probeJson && probeJson.backendSelected === "gnome_libsecret";
  const probeAvailableOk = probeJson && probeJson.isEncryptionAvailable === true;
  const probeRoundTripOk = probeJson && probeJson.roundTrip === "ok";
  steps.push({
    name: "electron safeStorage probe (exit 0 + backend=gnome_libsecret + isEncryptionAvailable=true + roundTrip=ok)",
    code: probe.code === 0 && probeBackendOk && probeAvailableOk && probeRoundTripOk ? 0 : 1,
  });
  log.append(
    `[runner] probe: exit=${probe.code} backend=${probeJson ? probeJson.backendSelected : "unparsable"} available=${probeJson ? probeJson.isEncryptionAvailable : "unparsable"} roundTrip=${probeJson ? probeJson.roundTrip : "unparsable"}\n`,
  );

  // 2) 生产键仓法则回归（linux 平台值流入测试矩阵）—— CI 同款调用面。
  log.append("\n[runner] step: production P2 law battery (vitest --project engineering, CI-canonical, linux)\n");
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
    { timeoutMs: 15 * 60 * 1000, env: { NODE_OPTIONS: "--max-old-space-size=2048" } },
  );
  steps.push({ name: "vitest: P2 engineering law battery (13 suites, CI-canonical surface)", code: vitest.code });

  // 3) harness 平台门回归（linux 后端名闭集钉死）。
  log.append("\n[runner] step: harness platform-gate regression (node --test)\n");
  const gate = await execStep(log, process.execPath, ["--test", GATE_TEST], { timeoutMs: 60 * 1000 });
  steps.push({ name: "node --test safe-storage-backend-gate (linux backend closed set)", code: gate.code });

  await log.flush();
  return {
    verdict: steps.every((s) => s.code === 0) ? "PASS" : "FAIL",
    steps,
    logPath: log.filePath,
    note: "libsecret proof = real Electron runtime round-trip on the real gnome-keyring Secret Service (display leg); at-rest ciphertext inspection is carried by the linux-desktop-e2e / stripe-live specs",
  };
}

async function stageLinuxDesktopE2E(context) {
  const dir = stageDir(context.artifactsDir, "linux-desktop-e2e");
  const log = new RedactingLog(path.join(dir, "linux-desktop-e2e.log"), context.secret);
  const steps = [];
  const legEnv = context.legStackEnv;

  // 1) chromedriver 预取（容器腿同源：精确 Chromium 版本可能无 linux 驱动发布，
  //    预检入口解析兼容回退版，经 CHROMEDRIVER_PATH 显式注入）。
  log.append("[runner] step: chromedriver preflight into the repo driver cache\n");
  const driverLogPath = path.join(dir, "chromedriver-preflight.log");
  const driverLog = new RedactingLog(driverLogPath, context.secret);
  const driverPrepare = await execStep(driverLog, process.execPath, [CHROMEDRIVER_PREFLIGHT, "prepare", WDIO_DRIVER_CACHE], {
    timeoutMs: 10 * 60 * 1000,
    env: legEnv,
  });
  let driverBin = null;
  if (driverPrepare.code === 0) {
    try {
      driverBin = cp.execFileSync(
        process.execPath,
        [CHROMEDRIVER_PREFLIGHT, "path", WDIO_DRIVER_CACHE],
        { env: { ...process.env, ...legEnv }, encoding: "utf8" },
      ).trim();
    } catch {
      driverBin = null;
    }
  }
  await driverLog.flush();
  const driverOk = driverPrepare.code === 0 && driverBin && fs.existsSync(driverBin);
  steps.push({
    name: "chromedriver-preflight prepare + path (compatible driver resolved)",
    code: driverOk ? 0 : 1,
  });
  log.append(`[runner] chromedriver: ${driverBin || "NOT RESOLVED"}\n`);

  if (!driverOk) {
    await log.flush();
    return { verdict: "FAIL", steps, logPath: log.filePath };
  }

  // 2) payswap-connection-ui spec —— 显示腿内（真实窗口、真实 ipcMain、真实
  //    store 文件、真实 gnome_libsecret 后端；合成键、replay-isolated）。
  log.append("[runner] step: desktop E2E — payswap-connection-ui spec on the gnome-libsecret leg (real window, real ipcMain, real store files; synthetic secrets, replay-isolated)\n");
  const specLogPath = path.join(dir, "wdio-connection-ui.log");
  const specLog = new RedactingLog(specLogPath, context.secret);
  const runStamp = context.runStamp;
  const e2e = await execStep(
    specLog,
    "bash",
    [
      LEG_SESSION,
      "pnpm",
      "--filter",
      "@zcode/desktop",
      "test:e2e",
    ],
    {
      timeoutMs: 45 * 60 * 1000,
      cwd: REPO_ROOT,
      env: {
        ...legEnv,
        ZCODE_E2E_CONTAINER: "1",
        ZCODE_E2E_SKIP_BUILD: "1",
        ZCODE_E2E_KEYRING: "gnome-libsecret",
        ZCODE_E2E_SPEC: "./test/e2e/payswap-connection-ui.test.ts",
        ZCODE_E2E_RUN_ID: `p2-acceptance-${runStamp}`,
        ZCODE_E2E_SPEC_RETRIES: "2",
        ZCODE_E2E_EXTRA_APP_ARGS:
          "--password-store=gnome-libsecret --use-fake-device-for-media-stream --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion",
        CHROMEDRIVER_PATH: driverBin,
      },
    },
  );
  steps.push({
    name: "wdio: payswap-connection-ui.test.ts (connection journey, at-rest ciphertext, refresh closed set, revoke, corrupted-key restart — gnome-libsecret leg)",
    code: e2e.code,
  });

  await specLog.flush();
  await log.flush();
  return {
    verdict: steps.every((s) => s.code === 0) ? "PASS" : "FAIL",
    steps,
    logPath: log.filePath,
  };
}

async function stageStripeLive(context) {
  const dir = stageDir(context.artifactsDir, "stripe-live");
  const log = new RedactingLog(path.join(dir, "stripe-live.log"), context.secret);
  const steps = [];
  const legEnv = context.legStackEnv;

  if (!context.secret) {
    await log.flush();
    return {
      verdict: "SKIP",
      steps,
      logPath: log.filePath,
      skipReason: "ZCODE_E2E_STRIPE_LIVE_KEY absent — live stages require the restricted test key",
    };
  }

  // 0) chromedriver（live spec 同样走 wdio）。
  let driverBin = null;
  try {
    driverBin = cp.execFileSync(
      process.execPath,
      [CHROMEDRIVER_PREFLIGHT, "path", WDIO_DRIVER_CACHE],
      { env: { ...process.env, ...legEnv }, encoding: "utf8" },
    ).trim();
  } catch {
    driverBin = null;
  }
  if (!driverBin || !fs.existsSync(driverBin)) {
    const prepLog = new RedactingLog(path.join(dir, "chromedriver-preflight.log"), context.secret);
    await execStep(prepLog, process.execPath, [CHROMEDRIVER_PREFLIGHT, "prepare", WDIO_DRIVER_CACHE], {
      timeoutMs: 10 * 60 * 1000,
      env: legEnv,
    });
    await prepLog.flush();
    try {
      driverBin = cp.execFileSync(
        process.execPath,
        [CHROMEDRIVER_PREFLIGHT, "path", WDIO_DRIVER_CACHE],
        { env: { ...process.env, ...legEnv }, encoding: "utf8" },
      ).trim();
    } catch {
      driverBin = null;
    }
  }
  const driverOk = driverBin && fs.existsSync(driverBin);
  steps.push({ name: "chromedriver resolvable", code: driverOk ? 0 : 1 });
  if (!driverOk) {
    await log.flush();
    return { verdict: "FAIL", steps, logPath: log.filePath };
  }

  // 1) E2E live spec：真键经真连接 UI（connect→verified→revoke，stronger-than-CI）。
  log.append("[runner] step: E2E live spec — payswap-connection-live (real restricted key through the real connection UI, gnome-libsecret leg)\n");
  const e2eLogPath = path.join(dir, "wdio-connection-live.log");
  const e2eLog = new RedactingLog(e2eLogPath, context.secret);
  const e2e = await execStep(
    e2eLog,
    "bash",
    [LEG_SESSION, "pnpm", "--filter", "@zcode/desktop", "test:e2e"],
    {
      timeoutMs: 45 * 60 * 1000,
      env: {
        ...legEnv,
        ZCODE_E2E_STRIPE_LIVE_KEY: context.secret,
        ZCODE_E2E_RUN_ID: `p2-acceptance-live-${context.runStamp}`,
        ZCODE_E2E_SPEC: "./test/e2e/payswap-connection-live.test.ts",
        ZCODE_E2E_KEYRING: "gnome-libsecret",
        ZCODE_E2E_EXTRA_APP_ARGS: "--password-store=gnome-libsecret --use-fake-device-for-media-stream --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion",
        CHROMEDRIVER_PATH: driverBin,
      },
    },
  );
  await e2eLog.flush();
  steps.push({
    name: "wdio: payswap-connection-live.test.ts (connect connected / refresh verified / revoke + at-rest deletion)",
    code: e2e.code,
  });

  // 2) 对话面 live harness：生产装配 × 真桥 × 真键（build → 显示腿内 electron main.cjs）。
  log.append("\n[runner] step: build the live harness bundle from source\n");
  const built = await execStep(log, process.execPath, [BUILD_LIVE_HARNESS], { timeoutMs: 10 * 60 * 1000 });
  steps.push({ name: "node scripts/payswap/live/build-live-harness.mjs", code: built.code });

  let harnessVerdict = "FAIL";
  if (built.code === 0) {
    const liveOutDir = path.join(dir, "live-harness-out");
    await fsp.mkdir(liveOutDir, { recursive: true });
    log.append("\n[runner] step: conversational live harness — real Electron main, real api.stripe.com (display leg)\n");
    const harnessLogPath = path.join(dir, "live-harness.log");
    const harnessLog = new RedactingLog(harnessLogPath, context.secret);
    const harness = await execStep(
      harnessLog,
      "bash",
      [LEG_SESSION, process.execPath, context.electronCli, "--password-store=gnome-libsecret", "--no-sandbox", LIVE_MAIN],
      {
        timeoutMs: 20 * 60 * 1000,
        env: {
          ...legEnv,
          ZCODE_E2E_STRIPE_LIVE_KEY: context.secret,
          ZCODE_PAYSWAP_LIVE_OUT_DIR: liveOutDir,
        },
      },
    );
    await harnessLog.flush();
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
  if (steps[1].code !== 0) return { verdict: "FAIL", steps, logPath: log.filePath };
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
      note: `interactive New Task acceptance requires a human in the real app (Linux desktop or a VNC-attached display leg) — checklist emitted to ${path.relative(REPO_ROOT, checklistPath)}; fill it in, save as manual-new-task-evidence.md, re-run with --manual-evidence`,
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
  "linux-build": "Linux build tests (frozen install + E2B-proven desktop chain + E2E renderer face)",
  "linux-secure-storage": "Linux secure-storage tests (real-Electron gnome_libsecret probe on the display leg + key-store law regression)",
  "linux-desktop-e2e": "Linux desktop E2E (real-window connection journey spec, gnome-libsecret leg)",
  "stripe-live": "Real Stripe live-test-account tests (E2E live spec + conversational live harness, display leg)",
  "conversation-acceptance": "Conversation-level acceptance (New Task workflow — interactive manual evidence)",
};

function resolveElectronCli() {
  const candidates = [
    path.join(REPO_ROOT, "packages", "desktop", "node_modules", "electron", "cli.js"),
    path.join(REPO_ROOT, "node_modules", "electron", "cli.js"),
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return null;
}

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
        "usage: node scripts/payswap/linux/run-p2-acceptance.cjs [--stage <id>]... [--dry-run] [--list]",
        "       [--artifacts-dir <path>] [--skip-install] [--allow-skip]",
        "       [--assume-stage-passed <id>]... [--manual-evidence <path>]",
        "",
        `stages (in order): ${STAGE_ORDER.join(" -> ")}`,
        "",
        "environment:",
        "  PAYSWAP_LINUX_LEG_STACK=<prefix>   display/keyring stack prefix (system install works without it)",
        "  PAYSWAP_LINUX_FULL_MEMORY_BUILD=1  keep the full production sourcemap build face (needs ~8GB)",
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
    : path.join(REPO_ROOT, "artifacts", "p2-acceptance-linux", runStamp);
  await fsp.mkdir(artifactsDir, { recursive: true });

  const secret = (process.env.ZCODE_E2E_STRIPE_LIVE_KEY || "").trim() || null;
  // 腿栈环境（与 preflight 同一解析）。
  const legStack = LEG_STACK.probeLegStack();
  LEG_STACK.ensureXdgRuntimeDir();
  if (legStack.prefix) {
    console.log(`[runner] leg stack prefix: ${legStack.prefix}`);
  }

  // fail-closed preflight：launch 失败 / JSON 缺失或畸形 / 平台不符 ⇒ 所有选定
  // 阶段判 FAIL，run 退出码 1，绝不执行任何阶段。
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

  const context = {
    options,
    artifactsDir,
    runStamp,
    secret,
    electronCli: resolveElectronCli(),
    preflight,
    legStackEnv: legStack.env,
  };

  const results = {};
  const assumed = new Set(options.assumeStagePassed);

  console.log(`[runner] P2-Linux acceptance — platform=${process.platform} — ${new Date().toISOString()}`);
  console.log(`[runner] artifacts: ${path.relative(REPO_ROOT, artifactsDir)}`);
  console.log(`[runner] stages selected: ${options.stages.join(", ")}`);
  if (!preflightResult.ok) {
    console.log(`[runner] PREFLIGHT UNUSABLE (fail-closed): ${preflightResult.reason}`);
    console.log("[runner] no stage will execute — nothing may run on an absent/invalid preflight result");
  }
  if (options.dryRun) console.log("[runner] DRY-RUN: preflight + plan only, nothing executes");

  for (const stageId of STAGE_ORDER) {
    if (!options.stages.includes(stageId)) continue;

    if (!preflightResult.ok) {
      console.log(`\n[${stageId}] FAIL — preflight unusable: ${preflightResult.reason}`);
      results[stageId] = { verdict: "FAIL", steps: [], note: `preflight unusable (fail-closed): ${preflightResult.reason}` };
      continue;
    }

    const pre = preflightStages[stageId];
    if (!pre) {
      console.log(`\n[${stageId}] FAIL — no preflight stage record for '${stageId}' (fail-closed)`);
      results[stageId] = { verdict: "FAIL", steps: [], note: "no preflight stage record — capability never positively established" };
      continue;
    }

    if (!pre.executable) {
      console.log(`\n[${stageId}] SKIP — preflight gate: ${pre.reasons.join("; ")}`);
      results[stageId] = { verdict: "SKIP", steps: [], skipReason: pre.reasons.join("; ") };
      continue;
    }

    const dependencies = {
      "linux-secure-storage": ["linux-build"],
      "linux-desktop-e2e": ["linux-build"],
      "stripe-live": ["linux-build", "linux-secure-storage"],
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
    if (stageId === "linux-build") {
      outcome = await stageLinuxBuild(context);
    } else if (stageId === "linux-secure-storage") {
      outcome = context.electronCli
        ? await stageLinuxSecureStorage(context)
        : { verdict: "SKIP", steps: [], skipReason: "electron cli.js not resolvable (run linux-build first)" };
    } else if (stageId === "linux-desktop-e2e") {
      outcome = context.electronCli
        ? await stageLinuxDesktopE2E(context)
        : { verdict: "SKIP", steps: [], skipReason: "electron cli.js not resolvable (run linux-build first)" };
    } else if (stageId === "stripe-live") {
      outcome = context.electronCli
        ? await stageStripeLive(context)
        : { verdict: "SKIP", steps: [], skipReason: "electron cli.js not resolvable (run linux-build first)" };
    } else {
      outcome = await stageConversationAcceptance(context);
    }
    results[stageId] = outcome;
    console.log(`[${stageId}] verdict: ${outcome.verdict}`);
    if (outcome.note) console.log(`[${stageId}] ${outcome.note}`);
  }

  // 工件定稿：泄漏扫描 → 裁决污染 results → 就地消毒 → 复扫确认 → 渲染
  // summary → 写 manifest（只哈希消毒后工件）。
  const summary = {
    runner: "payswap-p2-acceptance-linux",
    startedAt: runStamp,
    platform: process.platform,
    platformRelease: os.release(),
    node: process.versions.node,
    legStack: { prefix: legStack.prefix, commands: legStack.commands },
    commit: cp.execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
    dryRun: options.dryRun,
    assumedStagesPassed: options.assumeStagePassed,
    secretPresent: Boolean(secret),
    stages: {},
  };
  const leaks = await leakScan(artifactsDir, secret);
  const sanitized = leaks.length > 0 ? await sanitizeLeaks(artifactsDir, secret) : [];
  let rescanHits = leaks;
  if (sanitized.length > 0) {
    rescanHits = await leakScan(artifactsDir, secret);
    if (rescanHits.length > 0) {
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

  const exitCode = computeExitCode(options.stages, results, assumed);
  console.log("\n================ P2-Linux acceptance summary ================");
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

if (require.main === module) {
  main().catch((error) => {
    console.error("[runner] fatal:", error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = {
  REDACTION,
  longestSecretPrefixSuffix,
  buildMemoryEnv,
  parseProbeJson,
  parseResultHarness,
  validateManualEvidence,
};
