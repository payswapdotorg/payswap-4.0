#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SECURITY PROBE BATTERY — PAYSWAP CUSTODIAN SERVICE (console-mode protocol)
 * ═══════════════════════════════════════════════════════════════════════════
 * Run:  node scripts/payswap/security/custodian-service-probe.cjs
 *
 * Permanent (not manual-grep) regression battery for the custodian service,
 * exercised through the helper's console protocol mode against PRIVATE pipe/
 * endpoint/blob/diag paths (never the production service or its files):
 *
 *   A2 diag hygiene ......... a synthetic push secret must never appear in any
 *                             diagnostic output or client capture (permanent
 *                             regression test, not a one-off grep);
 *   A4 identity gates ....... without the console test seam the gate is EXACT:
 *                             a non-electron parent register is refused and a
 *                             COPIED helper binary is refused;
 *   A4 deadlines ............ a client that sends nothing / a partial token /
 *                             an oversized line cannot stall the service — a
 *                             valid client arriving immediately after each
 *                             rejected client is still served;
 *   A4 durable custody ...... push acks ok only after blob write + readback
 *                             verify; persistence failure = ok:false; drop
 *                             acks ok only after the blob is verifiably gone;
 *   client contract ......... stable exit codes (0/70/71/72) for ok / gate
 *                             refused / unreachable / not-confirmed;
 *   W1 registration race .... the documented residual (ADR §A0.5 item 2):
 *                             an attacker electron that WINS the first-alive
 *                             race after the genuine main dies is recorded
 *                             honestly, the arriving genuine desktop is
 *                             refused LOUDLY on all four custody ops (exit 70
 *                             EOF — the exact boundary the desktop maps to
 *                             typed `custodian_unavailable`), no attacker
 *                             canary material reaches the genuine side, and
 *                             the documented recovery path works after the
 *                             attacker exits.
 *
 * Isolation laws: the probe uses a unique pipe name, private endpoint file,
 * private blob path and private diag path; it never touches
 * C:\ProgramData\payswap or the installed SYSTEM service. Key material is
 * never printed (the synthetic secret is random and never echoed on success).
 * Exit 0 = every battery passed; exit 1 = at least one failed (visible gate).
 */
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const HELPER =
  process.env.PAYSWAP_CUSTODIAN_HELPER ||
  path.join(
    repoRoot,
    "packages",
    "desktop",
    "bundled-tools",
    "win32-x64",
    "payswap-broker-peer",
    "payswap-broker-peer-helper.exe",
  );

if (!fs.existsSync(HELPER)) {
  console.error("custodian-probe: helper binary missing —", HELPER);
  console.error(
    "custodian-probe: compile it first (prepare-payswap-broker-peer-helper.mjs)",
  );
  process.exit(1);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "payswap-custodian-probe-"));
const pipeName = "payswap-custodian-probe-" + crypto.randomBytes(6).toString("hex");

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail: detail || "" });
  console.log((passed ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
}

function startConsoleServer(options) {
  // options: { testGate?: string, blob?: string, diag?: string, image?: string }
  // 每 server 独立管道名 —— 同名管道被 server1 占用时 server2 无法监听（客户端
  // 会带着 server2 的 token 连上 server1 → token-mismatch EOF，伪 70）。
  const uniquePipe = pipeName + "-" + crypto.randomBytes(3).toString("hex");
  const args = [
    "--svc-console",
    "--image",
    options.image || "C:\\nonexistent\\electron.exe",
    "--pipe",
    uniquePipe,
    "--endpoint",
    path.join(workDir, "endpoint-" + crypto.randomBytes(4).toString("hex") + ".json"),
    "--blob",
    options.blob || path.join(workDir, "blob.bin"),
  ];
  if (options.diag) args.push("--diag", options.diag);
  if (options.testGate) args.push("--test-gate", options.testGate);
  const child = spawn(HELPER, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const endpointFile = args[args.indexOf("--endpoint") + 1];
  return { child, endpointFile };
}

function waitForEndpoint(endpointFile, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(endpointFile)) return JSON.parse(fs.readFileSync(endpointFile, "utf8"));
    } catch {
      /* file mid-write */
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return null;
}

/** spawn a helper client against a private endpoint file; returns {code, out, err}. */
function client(endpointFile, opArgs, stdin) {
  const r = spawnSync(
    HELPER,
    ["--endpoint-file", endpointFile, ...opArgs],
    { encoding: "utf8", windowsHide: true, ...(stdin !== undefined ? { input: stdin } : {}) },
  );
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

/** raw TCP-shaped pipe client for hostile-deadline cases. */
function rawPipe(endpointFile, actions) {
  return new Promise((resolve) => {
    let endpoint;
    try {
      endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8"));
    } catch {
      resolve(false);
      return;
    }
    const socket = net.connect("\\\\.\\pipe\\" + endpoint.pipe);
    const done = (result) => {
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    socket.on("connect", () => {
      try { actions(socket); } catch { done(false); }
    });
    socket.on("error", () => done(false));
    // give the server its configured deadline + slack, then report connected-ness
    const timer = setTimeout(() => done(socket.readyState !== "closed"), 7000);
    timer.unref();
  });
}

async function wait(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function syntheticSecret() {
  return "rk_probe_" + crypto.randomBytes(36).toString("hex");
}

function fileContains(pathToScan, needle) {
  try {
    return fs.readFileSync(pathToScan, "utf8").includes(needle);
  } catch {
    return false;
  }
}

function dirContains(dir, needle) {
  let found = false;
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (fs.statSync(p).isDirectory()) found = found || dirContains(p, needle);
    else found = found || fileContains(p, needle);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Battery 1 — A2 diag hygiene (permanent regression: no secret in diagnostics)
// ---------------------------------------------------------------------------
async function batteryDiagHygiene() {
  const diagFile = path.join(workDir, "diag-hygiene.log");
  const server = startConsoleServer({ testGate: "node", diag: diagFile });
  const endpoint = waitForEndpoint(server.endpointFile);
  if (endpoint === null) {
    record("diag-hygiene:server-start", false, "endpoint never appeared");
    server.child.kill();
    return;
  }
  record("diag-hygiene:server-start", true);

  const secret = syntheticSecret();
  const reg = client(server.endpointFile, ["--custodian-register"]);
  record("diag-hygiene:register-ok", reg.code === 0, "exit=" + reg.code);
  const push = client(server.endpointFile, ["--custodian-push"], secret + "\n");
  record("diag-hygiene:push-ok", push.code === 0 && push.out.includes('"ok":true'), "exit=" + push.code);
  record(
    "diag-hygiene:no-secret-in-diag",
    !fileContains(diagFile, secret),
    "synthetic secret must never reach the diag file",
  );
  record(
    "diag-hygiene:no-secret-in-client-capture",
    !push.out.includes(secret) && !push.err.includes(secret) && !reg.out.includes(secret),
    "client stdout/stderr never echoes the secret",
  );
  record(
    "diag-hygiene:no-opline-in-diag",
    !fileContains(diagFile, '"op"') && !fileContains(diagFile, '"key"'),
    "diag must not carry operation payloads at all",
  );
  const drop = client(server.endpointFile, ["--custodian-drop"]);
  record("diag-hygiene:drop-ok", drop.code === 0 && drop.out.includes('"ok":true'), "exit=" + drop.code);
  server.child.kill();
}

// ---------------------------------------------------------------------------
// Battery 5 — F6 impersonation (model-controlled same-user process launches the
// EXACT configured electron image with an attacker-controlled entry script and
// drives the genuine helper). Law: while a genuine desktop main is REGISTERED
// and alive, the impersonator must be refused at registration AND at data ops
// (first-alive-wins + registered-pid binding). A re-registration after the
// genuine main dies is expected to SUCCEED — that race window is the documented
// residual (ADR §A0.3), asserted here so it cannot silently change.
// ---------------------------------------------------------------------------
async function batteryImpersonationF6() {
  const ELECTRON =
    process.env.PAYSWAP_CUSTODIAN_ELECTRON ||
    path.join(repoRoot, "node_modules", "electron", "dist", "electron.exe");
  if (!fs.existsSync(ELECTRON)) {
    record("f6:electron-present", false, "electron image missing — battery skipped");
    return;
  }
  // Server WITHOUT --test-gate: production gates (exact electron image + first-
  // alive-wins + registered-pid data binding). --image pins the REAL electron
  // image so the genuine-looking impersonator passes the image layer.
  const server = startConsoleServer({ image: ELECTRON });
  const endpoint = waitForEndpoint(server.endpointFile);
  if (endpoint === null) {
    record("f6:server-start", false, "endpoint never appeared");
    server.child.kill();
    return;
  }

  const idleMain = path.join(workDir, "idle-main.cjs");
  fs.writeFileSync(
    idleMain,
    `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
const ep = ${JSON.stringify(server.endpointFile)};
const r = spawnSync(HELPER, ["--endpoint-file", ep, "--custodian-register"], { encoding: "utf8", windowsHide: true });
console.log("IDLE-REGISTER exit=" + r.status);
setInterval(() => {}, 60000);
`,
  );
  // the idle main registers through the genuine helper (parent = electron image)
  const idleChild = spawn(ELECTRON, [idleMain], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let idleOut = "";
  idleChild.stdout.on("data", (d) => (idleOut += d));
  const idleReady = await (async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (idleOut.includes("IDLE-REGISTER")) return idleOut.includes("exit=0");
      await wait(300);
    }
    return false;
  })();
  record("f6:genuine-registration-established", idleReady, idleOut.trim().slice(0, 60));
  if (!idleReady) {
    idleChild.kill();
    server.child.kill();
    return;
  }

  // the impersonator: same configured image, attacker-controlled entry script
  const evilMain = path.join(workDir, "evil-main.cjs");
  fs.writeFileSync(
    evilMain,
    `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
const ep = ${JSON.stringify(server.endpointFile)};
function run(args, stdin) {
  const r = spawnSync(HELPER, ["--endpoint-file", ep, ...args], { encoding: "utf8", windowsHide: true, ...(stdin !== undefined ? { input: stdin } : {}) });
  return { code: r.status, out: (r.stdout || "").trim() };
}
const reg = run(["--custodian-register"]);
const push = run(["--custodian-push"], "rk_f6probe_" + "0".repeat(70) + "\\n");
const get = run(["--custodian-get", "--path", "/v1/balance"]);
const drop = run(["--custodian-drop"]);
console.log("EVIL " + JSON.stringify({ register: reg, push, get, drop }));
process.exit(0);
`,
  );

  const evilChild = spawn(ELECTRON, [evilMain], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let evilOut = "";
  evilChild.stdout.on("data", (d) => (evilOut += d));
  await (async () => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (evilOut.includes("EVIL ") || evilChild.exitCode !== null) return;
      await wait(300);
    }
  })();
  const evilLine = evilOut.split("\n").find((l) => l.startsWith("EVIL "));
  if (!evilLine) {
    record("f6:impersonator-ran", false, "evil main produced no result: " + evilOut.slice(0, 120));
    idleChild.kill();
    evilChild.kill();
    server.child.kill();
    return;
  }
  const evil = JSON.parse(evilLine.slice(5).replace(/\r/g, ""));
  record(
    "f6:impersonator-register-refused-while-genuine-alive",
    evil.register.code === 70 && evil.register.out === "",
    "exit=" + evil.register.code + " (in-registered main alive → rebind refused)",
  );
  record(
    "f6:impersonator-push-refused-while-genuine-alive",
    evil.push.code === 70,
    "exit=" + evil.push.code + " (parent pid != registered pid)",
  );
  record(
    "f6:impersonator-get-refused-while-genuine-alive",
    evil.get.code === 70,
    "exit=" + evil.get.code,
  );
  record(
    "f6:impersonator-drop-refused-while-genuine-alive",
    evil.drop.code === 70,
    "exit=" + evil.drop.code + " (all four custody ops blocked for the impersonator)",
  );

  // documented residual: after the genuine main dies, a fresh electron main's
  // registration SUCCEEDS (the rebind path — also the legitimate restart path,
  // and the race window an impersonator could win at that instant). Asserted
  // here so the residual cannot silently change in either direction.
  idleChild.kill();
  await wait(1500);
  const rebornMain = path.join(workDir, "reborn-main.cjs");
  fs.writeFileSync(
    rebornMain,
    `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
const ep = ${JSON.stringify(server.endpointFile)};
const r = spawnSync(HELPER, ["--endpoint-file", ep, "--custodian-register"], { encoding: "utf8", windowsHide: true });
console.log("REBORN-REGISTER exit=" + r.status);
process.exit(0);
`,
  );
  const reborn = spawnSync(ELECTRON, [rebornMain], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  const rebornOk = (reborn.stdout || "").includes("REBORN-REGISTER exit=0");
  record(
    "f6:residual-rebind-after-genuine-death-expected",
    rebornOk,
    "fresh electron main rebinds once the registered main is dead (race window — must stay visible, not silently change)",
  );

  // service restart: registration is in-memory and must clear — a fresh electron
  // main registers against the restarted server (the legitimate recovery path).
  server.child.kill();
  await wait(800);
  const restarted = startConsoleServer({ image: ELECTRON });
  const restartedEndpoint = waitForEndpoint(restarted.endpointFile);
  if (restartedEndpoint === null) {
    record("f6:service-restart-registration-cleared", false, "restarted endpoint never appeared");
    restarted.child.kill();
    return;
  }
  // re-write the idle main against the RESTARTED server's endpoint
  fs.writeFileSync(
    idleMain,
    `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
const ep = ${JSON.stringify(restarted.endpointFile)};
const r = spawnSync(HELPER, ["--endpoint-file", ep, "--custodian-register"], { encoding: "utf8", windowsHide: true });
console.log("IDLE-REGISTER exit=" + r.status);
process.exit(0);
`,
  );
  const afterRestart = spawnSync(ELECTRON, [idleMain], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  record(
    "f6:service-restart-registration-cleared",
    (afterRestart.stdout || "").includes("IDLE-REGISTER exit=0"),
    "fresh registration after restart (in-memory state cleared)",
  );
  evilChild.kill();
  restarted.child.kill();
}


// ---------------------------------------------------------------------------
// Battery 6 — W1 first-alive registration race (round 3 item 2; ADR §A0.5
// item 2, open by design). The attacker electron WINS the documented race
// after the genuine main dies; the race winner is recorded honestly (register
// + all four custody ops at the winner's disposal, including reading the
// INCUMBENT custody material left by the genuine main); the arriving genuine
// desktop is refused LOUDLY — exit 70 with an empty stdout (EOF, no reply
// bytes) on all four custody ops, the exact service boundary the desktop's
// custodianClient.ts maps to inactive `register-refused` provisioning and
// typed `custodian_unavailable` — no attacker canary material reaches the
// genuine side, the diag records the rebinding pid, and the documented
// recovery path (fresh genuine main rebinds once the attacker exits; genuine
// re-push overwrites attacker custody material) is proven. This leg pins the
// loud-refusal contract so it cannot silently change in either direction;
// closing the race itself is the deferred OS-level identity-separation task.
// ---------------------------------------------------------------------------
async function batteryRegistrationRaceW1() {
  const ELECTRON =
    process.env.PAYSWAP_CUSTODIAN_ELECTRON ||
    path.join(repoRoot, "node_modules", "electron", "dist", "electron.exe");
  if (!fs.existsSync(ELECTRON)) {
    record("w1:electron-present", false, "electron image missing — battery skipped");
    return;
  }
  const diagFile = path.join(workDir, "diag-w1.log");
  const blobFile = path.join(workDir, "w1-blob.bin");
  const server = startConsoleServer({ image: ELECTRON, diag: diagFile, blob: blobFile });
  const endpoint = waitForEndpoint(server.endpointFile);
  if (endpoint === null) {
    record("w1:server-start", false, "endpoint never appeared");
    server.child.kill();
    return;
  }

  const diagLines = () => {
    try {
      return fs
        .readFileSync(diagFile, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.length > 0);
    } catch {
      return [];
    }
  };
  const diagCount = (needle) => diagLines().filter((l) => l.includes(needle)).length;

  // Scenario sequencing law (console seam): every PUSH in this battery targets
  // an ABSENT blob (create). The A4 storage boundary hardens the blob to
  // SYSTEM-only after each verified push — correct fail-closed behavior — so a
  // console-mode service (running as the user, not SYSTEM) can never
  // File.Replace an existing blob: push-while-exists surfaces as the honest
  // ok:false persist-failure (RED-phase evidence, round 3 item 2). Replace-
  // while-exists is exercised on the live SYSTEM-service leg, where the
  // service retains FullControl by design. The battery therefore drops
  // custody before each later push; the live leg records the winner
  // overwriting the INCUMBENT material (its worst-case residual).
  //
  // Canary discipline: synthetic random canaries only, with distinct lengths
  // so the diag `push-ok len=<n>` decision lines prove WHICH material custody
  // holds at each point. Canaries are never echoed by the helper (A2) and are
  // asserted absent from every genuine-side capture and from the diag file.
  const genuineCanary = "rk_w1genuine_" + crypto.randomBytes(28).toString("hex");
  const genuineCanary2 = "rk_w1genuine2_" + crypto.randomBytes(30).toString("hex");
  const attackerCanary = "rk_w1attacker_" + crypto.randomBytes(32).toString("hex");

  const collect = (child, marker, timeoutMs) =>
    new Promise((resolve) => {
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      const deadline = Date.now() + timeoutMs;
      const poll = setInterval(() => {
        if (out.includes(marker) || Date.now() > deadline) {
          clearInterval(poll);
          resolve(out);
        }
      }, 300);
    });

  const parseResult = (text, marker) => {
    const line = text.split("\n").find((l) => l.startsWith(marker));
    if (!line) return null;
    try {
      return JSON.parse(line.slice(line.indexOf(marker) + marker.length + 1).replace(/\r/g, ""));
    } catch {
      return null;
    }
  };

  // --- A. genuine registration + the full four-op channel (pre-attack) ---
  const idleMain = path.join(workDir, "w1-idle-main.cjs");
  fs.writeFileSync(
    idleMain,
    `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
const ep = ${JSON.stringify(server.endpointFile)};
function run(args, stdin) {
  const r = spawnSync(HELPER, ["--endpoint-file", ep, ...args], { encoding: "utf8", windowsHide: true, ...(stdin !== undefined ? { input: stdin } : {}) });
  return { code: r.status, out: (r.stdout || "").trim() };
}
const reg = run(["--custodian-register"]);
const get = run(["--custodian-get", "--path", "/v1/balance"]);
const push = run(["--custodian-push"], ${JSON.stringify(genuineCanary)} + "\\n");
const drop = run(["--custodian-drop"]);
console.log("W1-GENUINE-ESTABLISHED " + JSON.stringify({ register: reg, get, push, drop }));
setInterval(() => {}, 60000);
`,
  );
  const genuineChild = spawn(ELECTRON, [idleMain], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const genuinePid = genuineChild.pid;
  const genuineOut = await collect(genuineChild, "W1-GENUINE-ESTABLISHED", 45000);
  const genuineRes = parseResult(genuineOut, "W1-GENUINE-ESTABLISHED");
  record(
    "w1:genuine-registers",
    genuineRes !== null && genuineRes.register.code === 0,
    genuineRes ? "pid=" + genuinePid + " exit=" + genuineRes.register.code : "no result line — " + genuineOut.slice(0, 100),
  );
  record(
    "w1:genuine-get-empty-custody-no-key",
    genuineRes !== null && genuineRes.get.code === 0 && genuineRes.get.out.includes('"body":"no-key"'),
    genuineRes ? "exit=" + genuineRes.get.code + " body=no-key (honest custody state — deterministic, network-free)" : "no result line",
  );
  record(
    "w1:genuine-push-establishes-custody",
    genuineRes !== null && genuineRes.push.code === 0 && genuineRes.push.out.includes('"ok":true') &&
      diagCount("custodian:push-ok len=" + genuineCanary.length) === 1,
    genuineRes ? "exit=" + genuineRes.push.code + " (verified persistence = the channel is proven before the attack)" : "no result line",
  );
  record(
    "w1:genuine-custody-drop-verified",
    genuineRes !== null && genuineRes.drop.code === 0 && genuineRes.drop.out.includes('"ok":true') &&
      !fs.existsSync(blobFile),
    genuineRes ? "exit=" + genuineRes.drop.code + " (blob verifiably gone — custody empty at attack time)" : "no result line",
  );

  // registered-main-alive is observable: a non-electron probe register is
  // refused by the ALIVE gate first (diag `register-alive-exists registered=<genuinePid>`).
  const probeWhileAlive = client(server.endpointFile, ["--custodian-register"]);
  const aliveBeforeDeath = diagCount("custodian:register-alive-exists registered=" + genuinePid);
  record(
    "w1:alive-gate-refuses-probe-while-genuine-alive",
    probeWhileAlive.code === 70 && aliveBeforeDeath === 1,
    "probe exit=" + probeWhileAlive.code + " diag alive-exists registered=" + genuinePid + " count=" + aliveBeforeDeath,
  );

  // --- B. genuine death: the alive state must transition (retained handle signals) ---
  genuineChild.kill();
  await wait(1500);
  const probeAfterDeath = client(server.endpointFile, ["--custodian-register"]);
  const aliveAfterDeath = diagCount("custodian:register-alive-exists registered=" + genuinePid);
  const gateRejectsAfterDeath = diagCount("custodian:register-gate-reject");
  record(
    "w1:genuine-death-clears-alive-state",
    probeAfterDeath.code === 70 &&
      aliveAfterDeath === aliveBeforeDeath &&
      gateRejectsAfterDeath >= 1,
    "probe exit=" +
      probeAfterDeath.code +
      " (refused by the IMAGE gate now, not the alive gate — alive-exists " +
      aliveBeforeDeath +
      "→" +
      aliveAfterDeath +
      ", register-gate-reject=" +
      gateRejectsAfterDeath +
      ")",
  );

  // --- C. attacker wins the documented race (recorded honestly) ---
  const evilMain = path.join(workDir, "w1-evil-main.cjs");
  fs.writeFileSync(
    evilMain,
    `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
const ep = ${JSON.stringify(server.endpointFile)};
function run(args, stdin) {
  const r = spawnSync(HELPER, ["--endpoint-file", ep, ...args], { encoding: "utf8", windowsHide: true, ...(stdin !== undefined ? { input: stdin } : {}) });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim().slice(0, 60) };
}
const out = { pid: process.pid, image: process.execPath.toLowerCase() };
out.register = run(["--custodian-register"]);
out.get = run(["--custodian-get", "--path", "/v1/balance"]);
out.push = run(["--custodian-push"], ${JSON.stringify(attackerCanary)} + "\\n");
out.drop = run(["--custodian-drop"]);
// re-push leaves the strongest adversarial state: custody holds ATTACKER
// material while the attacker process stays alive and registered.
out.repush = run(["--custodian-push"], ${JSON.stringify(attackerCanary)} + "\\n");
console.log("W1-EVIL-RESULT " + JSON.stringify(out));
setInterval(() => {}, 60000);
`,
  );
  const attackerChild = spawn(ELECTRON, [evilMain], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const attackerPid = attackerChild.pid;
  const attackerOut = await collect(attackerChild, "W1-EVIL-RESULT", 60000);
  const evilRes = parseResult(attackerOut, "W1-EVIL-RESULT");
  if (evilRes === null) {
    record("w1:attacker-ran", false, "attacker main produced no result: " + attackerOut.slice(0, 120));
    attackerChild.kill();
    server.child.kill();
    return;
  }
  record(
    "w1:attacker-wins-race-register",
    evilRes.register.code === 0 && evilRes.register.out.includes('"ok":true'),
    "pid=" + attackerPid + " exit=" + evilRes.register.code + " (the documented race is real — recorded honestly, not hidden)",
  );
  record(
    "w1:attacker-rebind-recorded-in-diag",
    diagCount("custodian:register-rebind parent=" + attackerPid) === 1,
    "diag records the rebinding pid (ADR §A0.5 item 2)",
  );
  record(
    "w1:attacker-get-reaches-custody-no-key",
    evilRes.get.code === 0 && evilRes.get.out.includes('"body":"no-key"'),
    "exit=" +
      evilRes.get.code +
      " body=no-key (the winner queries custody and receives its honest state; the winner overwriting the INCUMBENT material is recorded on the live SYSTEM-service leg)",
  );
  record(
    "w1:attacker-push-controls-custody",
    evilRes.push.code === 0 && evilRes.push.out.includes('"ok":true') &&
      diagCount("custodian:push-ok len=" + attackerCanary.length) >= 1,
    "exit=" + evilRes.push.code + " (attacker canary in custody — length " + attackerCanary.length + "; both attacker pushes are verified by the time this is evaluated)",
  );
  record(
    "w1:attacker-drop-destroys-custody",
    evilRes.drop.code === 0 && evilRes.drop.out.includes('"ok":true') &&
      diagCount("custodian:push-ok len=" + attackerCanary.length) === 2,
    "exit=" +
      evilRes.drop.code +
      " (drop acks ok only after the blob is verifiably gone server-side — verify-before-ack; the subsequent attacker re-push succeeding on the CREATE path proves the blob was absent between the drop and the re-push)",
  );
  record(
    "w1:attacker-repush-restores-canary",
    evilRes.repush.code === 0 &&
      evilRes.repush.out.includes('"ok":true') &&
      diagCount("custodian:push-ok len=" + attackerCanary.length) === 2 &&
      fs.existsSync(blobFile),
    "exit=" +
      evilRes.repush.code +
      " (custody holds attacker material again; diag push-ok len=" +
      attackerCanary.length +
      " x" +
      diagCount("custodian:push-ok len=" + attackerCanary.length) +
      ")",
  );

  // --- D. the arriving genuine desktop is refused LOUDLY (the core contract) ---
  const recoveryAttemptMain = path.join(workDir, "w1-recovery-attempt-main.cjs");
  fs.writeFileSync(
    recoveryAttemptMain,
    `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
const ep = ${JSON.stringify(server.endpointFile)};
function run(args, stdin) {
  const r = spawnSync(HELPER, ["--endpoint-file", ep, ...args], { encoding: "utf8", windowsHide: true, ...(stdin !== undefined ? { input: stdin } : {}) });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim().slice(0, 60) };
}
const out = { pid: process.pid };
out.register = run(["--custodian-register"]);
out.push = run(["--custodian-push"], ${JSON.stringify(genuineCanary2)} + "\\n");
out.get = run(["--custodian-get", "--path", "/v1/balance"]);
out.drop = run(["--custodian-drop"]);
console.log("W1-G2-RESULT " + JSON.stringify(out));
process.exit(0);
`,
  );
  const g2 = spawnSync(ELECTRON, [recoveryAttemptMain], { encoding: "utf8", windowsHide: true, timeout: 60000 });
  const g2Out = g2.stdout || "";
  const g2Err = g2.stderr || "";
  const g2Res = parseResult(g2Out, "W1-G2-RESULT");
  if (g2Res === null) {
    record("w1:genuine-recovery-attempt-ran", false, "recovery attempt main produced no result: " + g2Out.slice(0, 120));
    attackerChild.kill();
    server.child.kill();
    return;
  }
  const loudRefusal = (opResult) => opResult !== undefined && opResult.code === 70 && opResult.out === "";
  record(
    "w1:genuine-register-refused-while-attacker-holds",
    loudRefusal(g2Res.register),
    "exit=" + g2Res.register.code + " stdout-empty=" + (g2Res.register.out === "") + " (exit 70 EOF = the exact boundary custodianClient.ts maps to inactive register-refused → typed custodian_unavailable)",
  );
  record(
    "w1:genuine-push-refused-while-attacker-holds",
    loudRefusal(g2Res.push),
    "exit=" + g2Res.push.code + " stdout-empty=" + (g2Res.push.out === ""),
  );
  record(
    "w1:genuine-get-refused-while-attacker-holds",
    loudRefusal(g2Res.get),
    "exit=" + g2Res.get.code + " stdout-empty=" + (g2Res.get.out === "") + " (no reply bytes at all — attacker custody material cannot flow to the genuine app)",
  );
  record(
    "w1:genuine-drop-refused-while-attacker-holds",
    loudRefusal(g2Res.drop),
    "exit=" + g2Res.drop.code + " stdout-empty=" + (g2Res.drop.out === "") + " (all four custody ops refused)",
  );
  record(
    "w1:diag-alive-exists-against-attacker-pid",
    diagCount("custodian:register-alive-exists registered=" + attackerPid) >= 1,
    "diag alive-exists against attacker pid=" +
      diagCount("custodian:register-alive-exists registered=" + attackerPid) +
      " (the genuine desktop's arrival was refused BECAUSE the attacker holds the registration — visible, not silent)",
  );
  record(
    "w1:diag-data-gate-reject-for-genuine",
    diagCount("custodian:data-gate-reject parent=" + g2Res.pid) === 3,
    "data-gate-reject parent=" +
      g2Res.pid +
      " count=" +
      diagCount("custodian:data-gate-reject parent=" + g2Res.pid) +
      " (push/get/drop each refused at the data gate — kernel facts, not transport accidents)",
  );
  const genuineCaptureText = [genuineOut, g2Out, g2Err].join("\n");
  record(
    "w1:no-attacker-canary-reaches-genuine",
    !genuineCaptureText.includes(attackerCanary),
    "attacker canary absent from every genuine-side stdout/stderr capture (no attacker credential material reached the genuine application)",
  );

  // --- E. documented recovery: attacker exits → fresh genuine main rebinds ---
  attackerChild.kill();
  await wait(1500);
  const recoveryFinalMain = path.join(workDir, "w1-recovery-final-main.cjs");
  fs.writeFileSync(
    recoveryFinalMain,
    `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
const ep = ${JSON.stringify(server.endpointFile)};
function run(args, stdin) {
  const r = spawnSync(HELPER, ["--endpoint-file", ep, ...args], { encoding: "utf8", windowsHide: true, ...(stdin !== undefined ? { input: stdin } : {}) });
  return { code: r.status, out: (r.stdout || "").trim() };
}
const out = { pid: process.pid };
out.register = run(["--custodian-register"]);
out.drop = run(["--custodian-drop"]);
out.get = run(["--custodian-get", "--path", "/v1/balance"]);
out.push = run(["--custodian-push"], ${JSON.stringify(genuineCanary2)} + "\\n");
console.log("W1-G3-RESULT " + JSON.stringify(out));
process.exit(0);
`,
  );
  const g3 = spawnSync(ELECTRON, [recoveryFinalMain], { encoding: "utf8", windowsHide: true, timeout: 60000 });
  const g3Out = g3.stdout || "";
  const g3Res = parseResult(g3Out, "W1-G3-RESULT");
  if (g3Res === null) {
    record("w1:recovery-main-ran", false, "recovery main produced no result: " + g3Out.slice(0, 120));
    server.child.kill();
    return;
  }
  record(
    "w1:recovery-register-after-attacker-exit",
    g3Res.register.code === 0 && g3Res.register.out.includes('"ok":true'),
    "pid=" + g3Res.pid + " exit=" + g3Res.register.code + " (documented rebind recovery path works once the attacker exits)",
  );
  record(
    "w1:recovery-rebind-recorded-in-diag",
    diagCount("custodian:register-rebind parent=" + g3Res.pid) === 1,
    "diag records the recovery rebind (old registration state discarded)",
  );
  record(
    "w1:recovery-drop-purges-attacker-material",
    g3Res.drop.code === 0 && g3Res.drop.out.includes('"ok":true') &&
      diagCount("custodian:push-ok len=" + genuineCanary2.length) === 1,
    "exit=" +
      g3Res.drop.code +
      " (the recovered genuine desktop purges the attacker's leftover custody material — drop acks ok only after the blob is verifiably gone server-side; the subsequent genuine push succeeding on the CREATE path proves the purge happened)",
  );
  record(
    "w1:recovery-get-empty-custody-no-key",
    g3Res.get.code === 0 && g3Res.get.out.includes('"body":"no-key"'),
    "exit=" + g3Res.get.code + " body=no-key (restored channel answers the genuine app with honest custody state — deterministic)",
  );
  record(
    "w1:recovery-push-restores-genuine-custody",
    g3Res.push.code === 0 &&
      g3Res.push.out.includes('"ok":true') &&
      diagCount("custodian:push-ok len=" + genuineCanary2.length) === 1 &&
      fs.existsSync(blobFile),
    "exit=" +
      g3Res.push.code +
      " (custody restored to GENUINE material — diag push-ok len=" +
      genuineCanary2.length +
      "; the attacker's length-" +
      attackerCanary.length +
      " material was purged first)",
  );
  const fullGenuineCaptureText = [genuineOut, g2Out, g2Err, g3Out, g3.stderr || ""].join("\n");
  record(
    "w1:no-canary-material-anywhere-in-genuine-captures",
    !fullGenuineCaptureText.includes(attackerCanary) &&
      !fullGenuineCaptureText.includes(genuineCanary) &&
      !fullGenuineCaptureText.includes(genuineCanary2),
    "no canary material echoed anywhere on the genuine side (A2 capture discipline holds under the race)",
  );
  record(
    "w1:no-canary-material-in-diag",
    !diagLines().some((l) => l.includes(attackerCanary) || l.includes(genuineCanary) || l.includes(genuineCanary2)),
    "no canary material in any diag decision line (A2 hygiene holds under the race)",
  );
  server.child.kill();
}

// ---------------------------------------------------------------------------
// Battery 2 — A4 exact identity gates (no console seam = exact image laws)
// ---------------------------------------------------------------------------
async function batteryExactGates() {
  // Server WITHOUT --test-gate: parent image gate = exact configured image
  // (C:\nonexistent\electron.exe) — a node-parented register must be refused.
  const server = startConsoleServer({});
  const endpoint = waitForEndpoint(server.endpointFile);
  if (endpoint === null) {
    record("exact-gates:server-start", false, "endpoint never appeared");
    server.child.kill();
    return;
  }
  const reg = client(server.endpointFile, ["--custodian-register"]);
  record(
    "exact-gates:non-electron-register-refused",
    reg.code === 70 && reg.out.trim() === "",
    "exit=" + reg.code + " (EOF no reply)",
  );
  // A copied helper binary must be refused by the client-image gate.
  const copyPath = path.join(workDir, "helper-copy.exe");
  fs.copyFileSync(HELPER, copyPath);
  const copied = spawnSync(
    copyPath,
    ["--endpoint-file", server.endpointFile, "--custodian-register"],
    { encoding: "utf8", windowsHide: true },
  );
  record(
    "exact-gates:copied-helper-refused",
    copied.status === 70 && !(copied.stdout || "").includes("ok"),
    "exit=" + copied.status + " (copied image != configured client helper)",
  );
  server.child.kill();
}

// ---------------------------------------------------------------------------
// Battery 3 — A4 protocol deadlines (no hostile client may stall the service)
// ---------------------------------------------------------------------------
async function batteryDeadlines() {
  const server = startConsoleServer({ testGate: "node" });
  const endpoint = waitForEndpoint(server.endpointFile);
  if (endpoint === null) {
    record("deadlines:server-start", false, "endpoint never appeared");
    server.child.kill();
    return;
  }
  const validAfter = async (label, hostile) => {
    await rawPipe(server.endpointFile, hostile);
    const reg = client(server.endpointFile, ["--custodian-register"]);
    record(
      "deadlines:valid-client-served-after-" + label,
      reg.code === 0,
      "exit=" + reg.code,
    );
  };
  await validAfter("silent-client", () => {
    /* sends nothing */
  });
  await validAfter("partial-token", (s) => s.write("ab"));
  await validAfter("oversized-line", (s) => s.write("A".repeat(40000) + "\n"));
  // A client holding a connection open must not block the next valid client.
  const held = rawPipe(server.endpointFile, () => {
    /* keeps socket open */
  });
  await wait(500);
  const reg = client(server.endpointFile, ["--custodian-register"]);
  record("deadlines:valid-client-served-while-held-open", reg.code === 0, "exit=" + reg.code);
  server.child.kill();
  await held;
}

// ---------------------------------------------------------------------------
// Battery 4 — A4 durable custody (push/drop verify before ack)
// ---------------------------------------------------------------------------
async function batteryDurableCustody() {
  const blob = path.join(workDir, "blob-durable.bin");
  const server = startConsoleServer({ testGate: "node", blob });
  const endpoint = waitForEndpoint(server.endpointFile);
  if (endpoint === null) {
    record("custody:server-start", false, "endpoint never appeared");
    server.child.kill();
    return;
  }
  const secret = syntheticSecret();
  client(server.endpointFile, ["--custodian-register"]);
  const push = client(server.endpointFile, ["--custodian-push"], secret + "\n");
  record("custody:push-ok", push.code === 0 && push.out.includes('"ok":true'), "exit=" + push.code);
  record("custody:blob-persisted", fs.existsSync(blob), "blob present after verified push");
  record("custody:blob-not-plaintext", !fileContains(blob, secret), "blob must be SYSTEM-DPAPI wrapped");
  // Persistence failure seam: blob parent is a FILE (not a directory) — the
  // service must answer ok:false (client exit 72), never lie about custody.
  const notADir = path.join(workDir, "not-a-dir");
  fs.writeFileSync(notADir, "x");
  const server2 = startConsoleServer({
    testGate: "node",
    blob: path.join(notADir, "blob.bin"),
    diag: path.join(workDir, "diag-persist-failure.log"),
  });
  const endpoint2 = waitForEndpoint(server2.endpointFile);
  const reg2 = client(server2.endpointFile, ["--custodian-register"]);
  record("custody:persist-seam-register-ok", reg2.code === 0, "exit=" + reg2.code);
  const push2 = client(server2.endpointFile, ["--custodian-push"], secret + "\n");
  record(
    "custody:persist-failure-not-confirmed",
    push2.code === 72 && !push2.out.includes('"ok":true'),
    "exit=" + push2.code + " (persist-failed must not ack ok)",
  );
  server2.child.kill();
  const drop = client(server.endpointFile, ["--custodian-drop"]);
  record("custody:drop-ok", drop.code === 0 && drop.out.includes('"ok":true'), "exit=" + drop.code);
  record("custody:blob-verifiably-gone", !fs.existsSync(blob), "blob absent after drop");
  // Client contract: unreachable service = 71.
  const unreachable = client(path.join(workDir, "no-such-endpoint.json"), ["--custodian-register"]);
  record("custody:unreachable-exit-71", unreachable.code === 71, "exit=" + unreachable.code);
  server.child.kill();
}

async function main() {
  console.log("custodian-service-probe: helper =", HELPER);
  try {
    await batteryDiagHygiene();
    await batteryExactGates();
    await batteryDeadlines();
    await batteryDurableCustody();
    await batteryImpersonationF6();
    await batteryRegistrationRaceW1();
  } finally {
    // never leave probe artifacts behind (unless debugging a failure)
    if (!process.env.PAYSWAP_CUSTODIAN_PROBE_KEEP) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    } else {
      console.log("custodian-service-probe: artifacts kept at", workDir);
    }
  }
  const failed = results.filter((r) => !r.passed);
  console.log(
    "custodian-service-probe: " +
      (results.length - failed.length) +
      "/" +
      results.length +
      " checks passed",
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("custodian-service-probe: crashed —", e.message);
  process.exit(1);
});
