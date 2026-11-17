#!/usr/bin/env node
"use strict";

/**
 * PaySwap P2 —— 环境预检（preflight；环境就绪审计 2026-11-17 交付物）。
 *
 * 回答一个问题：**本机现在能执行哪些 P2 验收测试**——并给出逐项证据与可执行
 * 修复动作。零依赖（Node >= 18 即可跑；仓库引擎是 >= 24），不触碰任何秘密值。
 *
 * 检查面（每项 pass/warn/fail/skip + detail + hint）：
 *   os / node / pnpm / git / build-tools / resources / desktop-session /
 *   electron / safe-storage-probe / stripe-network / stripe-live-key /
 *   stripe-auth-probe
 *
 * 五类验收阶段的可执行裁决（A/B/C 五分类 —— 见 run-p2-acceptance.cjs 与
 * docs/payswap/p2/ENVIRONMENT-READINESS-HANDOFF.md）：
 *   windows-build | windows-secure-storage | windows-desktop-e2e |
 *   stripe-live | conversation-acceptance
 *
 * 用法：
 *   node scripts/payswap/preflight-env.cjs                 # 人类可读表
 *   node scripts/payswap/preflight-env.cjs --json          # 机读（runner 消费）
 *   node scripts/payswap/preflight-env.cjs --require-live-key   # live 键缺席即红
 *   node scripts/payswap/preflight-env.cjs --skip-electron-probe    # 离线/免 GUI
 *
 * 秘密纪律：live 键只做在场/格式检查，**值永不回显**（日志/evidence 零键材料）；
 * 授权探针只报 HTTP 状态、对象类型与 account id（acct_* —— 登记先例公开它）。
 *
 * 退出码：0 = 无 fail 级检查项；1 = 存在 fail 级检查项（hint 里有修复动作）；
 * 2 = 用法错误。warn 不影响退出码（如 RAM 偏低、live 键缺席且未 --require-live-key）。
 */

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ROOT_PACKAGE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
const ELECTRON_CANDIDATES = [
  path.join(REPO_ROOT, "packages", "desktop", "node_modules", "electron"),
  path.join(REPO_ROOT, "node_modules", "electron"),
];
const PROBE_SCRIPT = path.join(REPO_ROOT, "scripts", "payswap", "electron-safe-storage-probe.cjs");
const PROBE_MARKER = "PAYSWAP_SAFE_STORAGE_PROBE";
const LINUX_SECURE_BACKENDS = new Set(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]);
const STRIPE_BALANCE_URL = "https://api.stripe.com/v1/balance";

const args = process.argv.slice(2);
const WANT_JSON = args.includes("--json");
const REQUIRE_LIVE_KEY = args.includes("--require-live-key");
const SKIP_ELECTRON_PROBE = args.includes("--skip-electron-probe");
const NO_STRIPE_AUTH_PROBE = args.includes("--no-probe-stripe-auth");
const HELP = args.includes("--help") || args.includes("-h");
const UNKNOWN_ARGS = args.filter(
  (a) =>
    !["--json", "--require-live-key", "--skip-electron-probe", "--no-probe-stripe-auth", "--help", "-h"].includes(a),
);
if (HELP || UNKNOWN_ARGS.length > 0) {
  if (UNKNOWN_ARGS.length > 0) console.error(`unknown argument(s): ${UNKNOWN_ARGS.join(", ")}`);
  console.log(
    "usage: node scripts/payswap/preflight-env.cjs [--json] [--require-live-key] [--skip-electron-probe] [--no-probe-stripe-auth]",
  );
  process.exit(UNKNOWN_ARGS.length > 0 ? 2 : 0);
}

const LIVE_KEY = (process.env.ZCODE_E2E_STRIPE_LIVE_KEY || "").trim();
const checks = [];

function record(id, title, status, detail, hint) {
  checks.push({ id, title, status, detail, hint: hint || null });
  return status;
}

function run(command, argv, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(command, argv, { timeout: timeoutMs, cwd: REPO_ROOT, windowsHide: true }, (error, stdout, stderr) => {
        resolve({
          error: error ? String(error.message || error) : null,
          stdout: typeof stdout === "string" ? stdout.trim() : "",
          stderr: typeof stderr === "string" ? stderr.trim() : "",
        });
      });
    } catch (error) {
      resolve({ error: String(error.message || error), stdout: "", stderr: "" });
    }
  });
}

function compareSemverLoose(actual, required) {
  const parse = (v) => v.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const [a1, a2, a3] = parse(actual);
  const [r1, r2, r3] = parse(required);
  if (a1 !== r1) return a1 > r1 ? 1 : -1;
  if (a2 !== r2) return a2 > r2 ? 1 : -1;
  if (a3 !== r3) return a3 > r3 ? 1 : -1;
  return 0;
}

async function checkOs() {
  const platform = process.platform;
  let detail = `platform=${platform} arch=${process.arch} release=${os.release()} hostname=${os.hostname()}`;
  if (platform === "win32") {
    const ver = await run("cmd", ["/c", "ver"], 8000);
    if (ver.stdout) detail += ` | ${ver.stdout.replace(/\r?\n/g, " ")}`;
  } else if (platform === "linux") {
    try {
      detail += ` | ${fs.readFileSync("/etc/os-release", "utf8").split("\n").find((l) => l.startsWith("PRETTY_NAME")) || ""}`;
    } catch {
      /* best effort */
    }
    detail += ` | container=${fs.existsSync("/.dockerenv") ? "yes" : "no"}`;
  }
  const supported = platform === "win32" || platform === "linux" || platform === "darwin";
  record(
    "os",
    "Operating system",
    supported ? "pass" : "fail",
    detail,
    supported
      ? null
      : "P2 acceptance supports win32 (primary), linux (vm live recipes) and darwin only",
  );
  return platform;
}

async function checkNode() {
  const actual = process.versions.node;
  const required = (ROOT_PACKAGE.engines && ROOT_PACKAGE.engines.node) || ">=24.0.0";
  const floor = required.replace(">=", "");
  const ok = compareSemverLoose(actual, floor) >= 0;
  record(
    "node",
    "Node.js version (repo engine)",
    ok ? "pass" : "fail",
    `node=${actual} (repo requires ${required})`,
    ok ? null : `install Node ${floor}+ (repo pins node 24)`,
  );
}

async function checkPnpm() {
  const pinned = (ROOT_PACKAGE.packageManager || "pnpm@10.33.2").replace("pnpm@", "");
  const res = await run("pnpm", ["--version"], 15000);
  if (res.error) {
    record(
      "pnpm",
      "pnpm version (repo packageManager)",
      "fail",
      `pnpm not invocable: ${res.error}`,
      `corepack enable && corepack prepare pnpm@${pinned} --activate`,
    );
    return;
  }
  const actual = res.stdout.split(/\r?\n/)[0];
  const ok = actual === pinned;
  record(
    "pnpm",
    "pnpm version (repo packageManager)",
    ok ? "pass" : "warn",
    `pnpm=${actual} (repo pins ${pinned})`,
    ok ? null : `corepack prepare pnpm@${pinned} --activate (frozen-lockfile install expects the pinned version)`,
  );
}

async function checkGit() {
  const res = await run("git", ["--version"], 10000);
  record(
    "git",
    "git presence",
    res.error ? "fail" : "pass",
    res.error ? `git not invocable: ${res.error}` : res.stdout,
    res.error ? "install git (needed for checkout + husky prepare)" : null,
  );
}

async function checkBuildTools(platform) {
  if (platform === "linux") {
    const gcc = await run("gcc", ["--version"], 8000);
    const make = await run("make", ["--version"], 8000);
    const ok = !gcc.error && !make.error;
    record(
      "build-tools",
      "build toolchain (linux)",
      ok ? "pass" : "warn",
      `gcc=${gcc.error ? "missing" : "present"} make=${make.error ? "missing" : "present"}`,
      ok ? null : "native rebuild steps may need gcc/make (apt-get install build-essential)",
    );
  } else if (platform === "win32") {
    // The repo's Windows helper path uses the OS built-in csc.exe (.NET Framework),
    // which is not on PATH by default — presence here is advisory, not gating.
    const csc = await run("where", ["csc"], 8000);
    record(
      "build-tools",
      "build toolchain (win32)",
      "pass",
      `csc-on-PATH=${csc.error ? "no (advisory — repo prepare script resolves the OS built-in csc.exe itself)" : "yes"}; VS Build Tools only needed for native-module rebuilds`,
    );
  } else {
    record("build-tools", "build toolchain", "skip", `not checked on ${platform}`);
  }
}

async function checkResources() {
  const totalMemGb = os.totalmem() / 1024 ** 3;
  let freeDiskGb = null;
  try {
    const stat = fs.statfsSync(REPO_ROOT);
    freeDiskGb = (stat.bavail * stat.bsize) / 1024 ** 3;
  } catch {
    /* best effort */
  }
  const memStatus = totalMemGb >= 7.5 ? "pass" : "warn";
  const diskStatus = freeDiskGb === null ? "warn" : freeDiskGb >= 8 ? "pass" : "fail";
  record(
    "resources",
    "RAM / free disk",
    diskStatus === "fail" ? "fail" : memStatus,
    `cpus=${os.cpus().length} ram=${totalMemGb.toFixed(1)}GB free-disk=${freeDiskGb === null ? "unknown" : `${freeDiskGb.toFixed(1)}GB`}`,
    diskStatus === "fail"
      ? "free at least 8GB (workspace install + electron + build artifacts)"
      : totalMemGb < 7.5
        ? "E2E sharding prefers >= 8GB RAM; single-shard runs may still work"
        : null,
  );
}

function checkDesktopSession(platform) {
  if (platform === "win32") {
    const session = process.env.SESSIONNAME || "(unset)";
    const interactive = /Console|RDP-Tcp/.test(session);
    record(
      "desktop-session",
      "Interactive Windows desktop session",
      interactive ? "pass" : "warn",
      `SESSIONNAME='${session}' (Console/RDP-Tcp = interactive desktop)`,
      interactive
        ? null
        : "run from an interactive desktop (RDP/console) — session-0/service contexts are not a desktop acceptance environment",
    );
    return interactive;
  }
  if (platform === "linux") {
    const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY || "";
    record(
      "desktop-session",
      "Display session (linux live leg)",
      display ? "pass" : "warn",
      `DISPLAY='${process.env.DISPLAY || ""}' WAYLAND_DISPLAY='${process.env.WAYLAND_DISPLAY || ""}'`,
      display
        ? null
        : "linux live recipes (vm-run-live.sh / vm-harness-only.sh) provision their own dbus/gnome-keyring/Xvfb leg — run them inside the VM recipe, not a bare headless shell",
    );
    return Boolean(display);
  }
  record("desktop-session", "Interactive desktop session", "skip", `not checked on ${platform}`);
  return false;
}

function resolveElectron() {
  for (const candidate of ELECTRON_CANDIDATES) {
    const pkgPath = path.join(candidate, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        const cli = path.join(candidate, "cli.js");
        if (fs.existsSync(cli)) {
          return { version: pkg.version, cli, dir: candidate };
        }
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

async function checkSafeStorageProbe(platform, electron) {
  if (SKIP_ELECTRON_PROBE) {
    record("safe-storage-probe", "Electron safeStorage runtime probe", "skip", "--skip-electron-probe given");
    return;
  }
  if (!electron) {
    record(
      "safe-storage-probe",
      "Electron safeStorage runtime probe",
      "skip",
      "electron not installed yet — run pnpm install --frozen-lockfile, then re-run preflight",
    );
    return;
  }
  if (platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    record(
      "safe-storage-probe",
      "Electron safeStorage runtime probe",
      "skip",
      "headless linux without a display — the vm live recipes provision Xvfb themselves; DPAPI proof is a win32-runner stage",
    );
    return;
  }
  const probeArgs = [electron.cli];
  if (platform === "linux") {
    probeArgs.push("--no-sandbox");
    if (!process.env.ZCODE_PAYSWAP_LIVE_EXPECT_BACKEND || process.env.ZCODE_PAYSWAP_LIVE_EXPECT_BACKEND === "gnome_libsecret") {
      probeArgs.push("--password-store=gnome-libsecret");
    }
  }
  probeArgs.push(PROBE_SCRIPT);
  const res = await run(process.execPath, probeArgs, 120000);
  const markerLine = res.stdout.split(/\r?\n/).find((l) => l.startsWith(PROBE_MARKER));
  let probe = null;
  if (markerLine) {
    try {
      probe = JSON.parse(markerLine.slice(PROBE_MARKER.length + 1));
    } catch {
      /* fallthrough */
    }
  }
  if (!probe) {
    record(
      "safe-storage-probe",
      "Electron safeStorage runtime probe",
      "fail",
      `probe produced no parsable result (exit=${res.error ? "err" : 0}; stderr=${res.stderr.slice(0, 300) || "(empty)"})`,
      "run the probe manually: node packages/desktop/node_modules/electron/cli.js scripts/payswap/electron-safe-storage-probe.cjs",
    );
    return;
  }
  if (probe.platform !== platform) {
    record(
      "safe-storage-probe",
      "Electron safeStorage runtime probe",
      "fail",
      `probe platform '${probe.platform}' != preflight platform '${platform}'`,
    );
    return;
  }
  const roundTripOk = probe.isEncryptionAvailable === true && probe.roundTrip === "ok";
  let status = roundTripOk ? "pass" : "fail";
  let hint = null;
  if (platform === "linux" && roundTripOk) {
    const expected = process.env.ZCODE_PAYSWAP_LIVE_EXPECT_BACKEND || "gnome_libsecret";
    if (!LINUX_SECURE_BACKENDS.has(probe.backendSelected)) {
      status = "fail";
      hint = `linux backend '${probe.backendSelected}' is outside the secure closed set (basic_text/unknown are not OS-keychain protection) — use the vm live recipe (--password-store=gnome-libsecret + org.freedesktop.secrets)`;
    } else if (probe.backendSelected !== expected) {
      hint = `backend '${probe.backendSelected}' is secure but differs from expected '${expected}' — set ZCODE_PAYSWAP_LIVE_EXPECT_BACKEND if this leg is intentional`;
    }
  } else if (platform === "win32" && !roundTripOk) {
    hint = "on Windows, isEncryptionAvailable() must be true after app-ready and the DPAPI round-trip must succeed — a false here is an abnormal state that must be investigated, not bypassed";
  }
  record(
    "safe-storage-probe",
    "Electron safeStorage runtime probe (real Electron main process)",
    status,
    `platform=${probe.platform} electron=${probe.electron} available=${probe.isEncryptionAvailable} roundTrip=${probe.roundTrip} backendSelected=${probe.backendSelected}`,
    hint,
  );
}

async function checkStripeNetwork() {
  try {
    const response = await fetch(STRIPE_BALANCE_URL, { signal: AbortSignal.timeout(15000) });
    // Any HTTP answer (401 expected without auth) proves network reachability.
    record(
      "stripe-network",
      "Stripe API network reachability",
      response.status > 0 ? "pass" : "fail",
      `GET ${STRIPE_BALANCE_URL} (unauthenticated) -> HTTP ${response.status} (401 expected — proves reachability)`,
    );
    return true;
  } catch (error) {
    record(
      "stripe-network",
      "Stripe API network reachability",
      LIVE_KEY ? "fail" : "warn",
      `network error: ${String(error.message || error)}`,
      LIVE_KEY
        ? "live stages need direct HTTPS access to api.stripe.com (check egress proxies/firewalls)"
        : "live stages are not selected here; reachability becomes mandatory once a live key is supplied",
    );
    return false;
  }
}

function checkLiveKey() {
  if (!LIVE_KEY) {
    record(
      "stripe-live-key",
      "ZCODE_E2E_STRIPE_LIVE_KEY presence (value never shown)",
      REQUIRE_LIVE_KEY ? "fail" : "warn",
      "absent",
      REQUIRE_LIVE_KEY
        ? "supply the restricted read-only test key (rk_test_*) via a 0600 env file — never via command lines or chat transcripts"
        : "stripe-live / conversation-acceptance stages require it; windows-build/secure-storage/desktop-e2e do not",
    );
    return null;
  }
  if (/^rk_test_/.test(LIVE_KEY)) {
    record("stripe-live-key", "ZCODE_E2E_STRIPE_LIVE_KEY presence (value never shown)", "pass", "present, restricted test-mode key (rk_test_*)");
    return "restricted-test";
  }
  if (/^(sk|rk)_live_/.test(LIVE_KEY)) {
    record(
      "stripe-live-key",
      "ZCODE_E2E_STRIPE_LIVE_KEY presence (value never shown)",
      "fail",
      "present, but LIVE-MODE — forbidden for P2 acceptance",
      "P2 acceptance only ever uses test-mode keys; a live key must never be supplied to the acceptance tooling",
    );
    return "live-forbidden";
  }
  if (/^sk_test_/.test(LIVE_KEY)) {
    record(
      "stripe-live-key",
      "ZCODE_E2E_STRIPE_LIVE_KEY presence (value never shown)",
      "warn",
      "present, but SECRET test key (sk_test_*) — full-access shape, not the restricted read-only shape",
      "mint a restricted key with Read on Account/Accounts/Balance/Charges/Customers/Disputes (the P2 read face) and use rk_test_*",
    );
    return "secret-test";
  }
  record(
    "stripe-live-key",
    "ZCODE_E2E_STRIPE_LIVE_KEY presence (value never shown)",
    "warn",
    "present, unrecognized format (P2 expects a restricted test key, rk_test_*)",
    "verify the key type in the Stripe dashboard (Developers > API keys > Restricted keys)",
  );
  return "unknown";
}

async function checkStripeAuthProbe(keyShape, networkOk) {
  if (!LIVE_KEY || keyShape === "live-forbidden" || NO_STRIPE_AUTH_PROBE) {
    record(
      "stripe-auth-probe",
      "Stripe authorized read-back probe (key never shown)",
      "skip",
      !LIVE_KEY ? "no live key supplied" : NO_STRIPE_AUTH_PROBE ? "--no-probe-stripe-auth given" : "live-mode key forbidden — refusing to use it",
    );
    return;
  }
  if (!networkOk) {
    record("stripe-auth-probe", "Stripe authorized read-back probe (key never shown)", "skip", "network unreachable — skipping authorized probe");
    return;
  }
  try {
    const response = await fetch(STRIPE_BALANCE_URL, {
      headers: { Authorization: `Bearer ${LIVE_KEY}` },
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 200 && body.object === "balance") {
      record(
        "stripe-auth-probe",
        "Stripe authorized read-back probe (key never shown)",
        "pass",
        `GET /v1/balance -> HTTP 200, object=balance${body.livemode === false ? ", livemode=false" : ""}`,
      );
      return;
    }
    record(
      "stripe-auth-probe",
      "Stripe authorized read-back probe (key never shown)",
      "fail",
      `GET /v1/balance -> HTTP ${response.status}, error=${body && body.error ? body.error.code || body.error.type : "(none)"}`,
      "a restricted key rejected on /v1/balance means the key lacks the Balance read permission or has been revoked — check the Stripe dashboard before running live stages",
    );
  } catch (error) {
    record(
      "stripe-auth-probe",
      "Stripe authorized read-back probe (key never shown)",
      "fail",
      `network error: ${String(error.message || error)}`,
    );
  }
}

function deriveStages(platform, checksById, interactiveSession) {
  const ok = (id) => checksById[id] && checksById[id].status === "pass";
  const toolchain = ok("node") && (checksById.pnpm && checksById.pnpm.status !== "fail") && ok("git");
  const electronOk = ok("electron");
  const probeOk = ok("safe-storage-probe");
  const keyOk = checksById["stripe-live-key"] && checksById["stripe-live-key"].status === "pass";
  const networkOk = ok("stripe-network") || (checksById["stripe-network"] && checksById["stripe-network"].status === "warn");
  const authOk = ok("stripe-auth-probe");
  const isWin = platform === "win32";
  const stages = [];

  stages.push({
    id: "windows-build",
    applicable: isWin,
    executable: isWin && toolchain,
    reasons: !isWin
      ? [`platform is ${platform} — the windows-build stage proves the native Windows toolchain`]
      : toolchain
        ? []
        : ["node/pnpm/git prerequisites not all green (see checks above)"],
  });
  stages.push({
    id: "windows-secure-storage",
    applicable: isWin,
    executable: isWin && toolchain && electronOk && probeOk,
    reasons: !isWin
      ? [`platform is ${platform} — DPAPI proof is a win32-only stage`]
      : [
          ...(toolchain ? [] : ["toolchain prerequisites not green"]),
          ...(electronOk ? [] : ["electron not installed (pnpm install --frozen-lockfile)"]),
          ...(probeOk ? [] : ["safeStorage runtime probe not green (real Electron DPAPI round-trip)"]),
        ],
  });
  stages.push({
    id: "windows-desktop-e2e",
    applicable: isWin,
    executable: isWin && toolchain && electronOk && interactiveSession,
    reasons: !isWin
      ? [`platform is ${platform} — desktop E2E needs the native Windows interactive desktop`]
      : [
          ...(toolchain ? [] : ["toolchain prerequisites not green"]),
          ...(electronOk ? [] : ["electron not installed"]),
          ...(interactiveSession ? [] : ["no interactive desktop session (SESSIONNAME)"]),
        ],
  });
  const liveExecutable = toolchain && electronOk && keyOk && networkOk && (authOk || !LIVE_KEY ? authOk : false);
  stages.push({
    id: "stripe-live",
    applicable: isWin || platform === "linux",
    executable: (isWin || platform === "linux") && liveExecutable,
    reasons: !(isWin || platform === "linux")
      ? [`platform ${platform} is outside the live recipes (win32 runner / linux vm recipes)`]
      : [
          ...(toolchain ? [] : ["toolchain prerequisites not green"]),
          ...(electronOk ? [] : ["electron not installed"]),
          ...(keyOk ? [] : ["restricted test key (rk_test_*) not verified present"]),
          ...(networkOk ? [] : ["api.stripe.com unreachable"]),
          ...(authOk ? [] : ["authorized read-back probe not green"]),
        ],
  });
  stages.push({
    id: "conversation-acceptance",
    applicable: isWin,
    executable: isWin && liveExecutable && interactiveSession,
    reasons: !isWin
      ? [`platform is ${platform} — the New Task conversational acceptance runs on the native Windows desktop app`]
      : [
          ...(liveExecutable ? [] : ["stripe-live prerequisites not green (the conversational face needs a connected, activated account)"]),
          ...(interactiveSession ? [] : ["no interactive desktop session"]),
        ],
  });
  return stages;
}

async function checkElectron(platform) {
  const electron = resolveElectron();
  record(
    "electron",
    "Electron runtime (repo desktop pin)",
    electron ? "pass" : "fail",
    electron
      ? `electron=${electron.version} cli=${path.relative(REPO_ROOT, electron.cli)} (desktop pins 44.7.0)`
      : "electron package not installed yet",
    electron ? null : "run `pnpm install --frozen-lockfile` (hoisted layout links electron under node_modules/)",
  );
  return electron;
}

function humanReport(platform, stages) {
  const width = 58;
  console.log(`\nP2 environment preflight — platform=${platform} — ${new Date().toISOString()}`);
  console.log("=".repeat(width + 12));
  for (const c of checks) {
    const mark = c.status === "pass" ? "PASS" : c.status === "warn" ? "WARN" : c.status === "skip" ? "SKIP" : "FAIL";
    console.log(`[${mark}] ${c.title}`);
    console.log(`       ${c.detail}`);
    if (c.hint) console.log(`       -> ${c.hint}`);
  }
  console.log("=".repeat(width + 12));
  console.log("Acceptance-stage executability (a stage reported not-executable is never silently skipped by the runner):");
  for (const s of stages) {
    const mark = !s.applicable ? "N/A " : s.executable ? "EXEC" : "GATED";
    console.log(`[${mark}] ${s.id}${s.reasons.length > 0 ? ` — ${s.reasons.join("; ")}` : ""}`);
  }
  const fails = checks.filter((c) => c.status === "fail");
  console.log("=".repeat(width + 12));
  if (fails.length > 0) {
    console.log(`RESULT: FAIL (${fails.length} fail-level check(s) — fix the -> hints above and re-run)`);
  } else {
    console.log("RESULT: no fail-level checks (see WARN/SKIP lines for stage gating)");
  }
}

(async () => {
  const platform = await checkOs();
  await checkNode();
  await checkPnpm();
  await checkGit();
  await checkBuildTools(platform);
  await checkResources();
  const interactiveSession = checkDesktopSession(platform);
  const electron = await checkElectron(platform);
  await checkSafeStorageProbe(platform, electron);
  const networkOk = await checkStripeNetwork();
  const keyShape = checkLiveKey();
  await checkStripeAuthProbe(keyShape, networkOk);

  const checksById = Object.fromEntries(checks.map((c) => [c.id, c]));
  const stages = deriveStages(platform, checksById, interactiveSession);
  const failCount = checks.filter((c) => c.status === "fail").length;

  if (WANT_JSON) {
    console.log(
      JSON.stringify(
        { startedAt: new Date().toISOString(), platform, checks, stages, failCount, exitCode: failCount > 0 ? 1 : 0 },
        null,
        2,
      ),
    );
  } else {
    humanReport(platform, stages);
  }
  process.exit(failCount > 0 ? 1 : 0);
})();
