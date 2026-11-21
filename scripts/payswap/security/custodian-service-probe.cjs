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


// Battery 7 — v1.1 named credential slots (custodian multi-secret round):
// push/drop/get accept an optional --slot (the credential storage key —
// provider + random connection id + kind, never a secret); the LEGACY no-slot
// path is byte-for-byte unchanged (the existing batteries are that proof).
// Slot charset is fail-closed ([A-Za-z0-9:._-], 1..128); GET slot resolution
// never borrows another slot (missing slot = honest network-free no-key).
// ---------------------------------------------------------------------------
async function batteryNamedSlots() {
  const server = startConsoleServer({ testGate: "node", blob: path.join(workDir, "blob-named.bin") });
  const endpoint = waitForEndpoint(server.endpointFile);
  if (endpoint === null) {
    record("slot:server-start", false, "endpoint never appeared");
    server.child.kill();
    return;
  }
  const slotA = "payswap:psp:probe:11111111-1111-4111-8111-111111111111:api-key";
  const slotB = "payswap:psp:probe:22222222-2222-4222-8222-222222222222:client-secret";
  client(server.endpointFile, ["--custodian-register"]);
  const pushA = client(server.endpointFile, ["--custodian-push", "--slot", slotA], "rk_slot_a_" + "1".repeat(60) + "\n");
  record(
    "slot:push-named-ok",
    pushA.code === 0 && pushA.out.includes('"ok":true'),
    "exit=" + pushA.code + " (named slot pushed; canary never echoed)",
  );
  const pushB = client(server.endpointFile, ["--custodian-push", "--slot", slotB], "rk_slot_b_" + "2".repeat(60) + "\n");
  record(
    "slot:push-second-ok",
    pushB.code === 0 && pushB.out.includes('"ok":true'),
    "exit=" + pushB.code + " (a second slot coexists — the old single-slot overwrite boundary is structurally solved)",
  );
  const getUnknown = client(server.endpointFile, ["--custodian-get", "--path", "/v1/balance", "--slot", "payswap:psp:probe:no-such:api-key"]);
  record(
    "slot:get-unknown-slot-no-key",
    getUnknown.code === 0 && getUnknown.out.includes('"body":"no-key"'),
    "exit=" + getUnknown.code + " (missing slot = no-key before any egress; slot isolation holds)",
  );
  const pushEvil = client(server.endpointFile, ["--custodian-push", "--slot", "../evil"], "rk_slot_evil_" + "3".repeat(60) + "\n");
  const getEvil = client(server.endpointFile, ["--custodian-get", "--path", "/v1/balance", "--slot", "../evil"]);
  record(
    "slot:invalid-charset-refused",
    pushEvil.code === 72 && pushEvil.out === "" && getEvil.code === 0 && getEvil.out.includes('"body":"no-key"'),
    "push exit=" + pushEvil.code + " (ok:false refusal — the slot-invalid detail stays server-side, client stdout empty), get exit=" + getEvil.code + " (no-key) — traversal never reaches a blob path",
  );
  const dropA = client(server.endpointFile, ["--custodian-drop", "--slot", slotA]);
  const getAfterDrop = client(server.endpointFile, ["--custodian-get", "--path", "/v1/balance", "--slot", slotA]);
  record(
    "slot:drop-then-get-no-key",
    dropA.code === 0 && dropA.out.includes('"ok":true') && getAfterDrop.code === 0 && getAfterDrop.out.includes('"body":"no-key"'),
    "drop exit=" + dropA.code + ", get exit=" + getAfterDrop.code + " (per-slot verifiable drop)",
  );
  const pushLegacy = client(server.endpointFile, ["--custodian-push"], "rk_slot_legacy_" + "4".repeat(60) + "\n");
  record(
    "slot:legacy-push-still-ok",
    pushLegacy.code === 0 && pushLegacy.out.includes('"ok":true'),
    "exit=" + pushLegacy.code + " (no-slot push = the legacy single-slot wire, unchanged)",
  );
  // v1.2 egress closed-set: hostile host / cross-host path / post-URL out of set
  // → network-free egress-forbidden (never an outbound request).
  const getEvilHost = client(server.endpointFile, ["--custodian-get", "--path", "/v1/balance", "--slot", slotB, "--host", "evil.com"]);
  record(
    "slot:v12-get-host-not-in-set",
    getEvilHost.code === 0 && getEvilHost.out.includes('"body":"egress-forbidden"'),
    "exit=" + getEvilHost.code + " (host not in the per-host closed set → network-free refusal)",
  );
  const getCrossHost = client(server.endpointFile, ["--custodian-get", "--path", "/v1/account", "--slot", slotB, "--host", "api.paystack.co"]);
  record(
    "slot:v12-get-cross-host-path-refused",
    getCrossHost.code === 0 && getCrossHost.out.includes('"body":"egress-forbidden"'),
    "exit=" + getCrossHost.code + " (stripe path on the paystack host → refused)",
  );
  const postEvil = client(server.endpointFile, ["--custodian-post", "--url", "https://evil.example.com/v1/oauth2/token", "--user-slot", slotA, "--pass-slot", slotB, "--body", "grant_type=client_credentials"]);
  record(
    "slot:v12-post-url-not-in-set",
    postEvil.code === 0 && postEvil.out.includes('"body":"egress-forbidden"'),
    "exit=" + postEvil.code + " (post URL not in the token allowlist → network-free refusal)",
  );
  const postMissing = client(server.endpointFile, ["--custodian-post", "--url", "https://api-m.sandbox.paypal.com/v1/oauth2/token", "--user-slot", "payswap:psp:probe:no-such", "--pass-slot", slotB, "--body", "grant_type=client_credentials"]);
  record(
    "slot:v12-post-missing-slot-no-key",
    postMissing.code === 0 && postMissing.out.includes('"body":"no-key"'),
    "exit=" + postMissing.code + " (either slot missing → no-key; never partial auth)",
  );
  // re-push both slots (slotA was dropped by the earlier drop arm; slotB by nothing —
  // but the v1.2 post arms may have consumed state; re-push for determinism).
  client(server.endpointFile, ["--custodian-push", "--slot", slotA], "rk_slot_a_" + "1".repeat(60) + "\n");
  client(server.endpointFile, ["--custodian-push", "--slot", slotB], "rk_slot_b_" + "2".repeat(60) + "\n");
  client(server.endpointFile, ["--custodian-push", "--slot", slotB], "rk_slot_b_" + "2".repeat(60) + "\n");
  // v1.3 token+data closed-set: token URL out of set / data URL out of set /
  // missing slots → network-free refusals (never an outbound request).
  const tgEvilToken = client(server.endpointFile, ["--custodian-token-get", "--token-url", "https://evil.example.com/v1/oauth2/token", "--user-slot", slotA, "--pass-slot", slotB, "--data-url", "https://api-m.sandbox.paypal.com/v1/reporting/transactions"]);
  record(
    "slot:v13-token-get-token-url-forbidden",
    tgEvilToken.code === 0 && tgEvilToken.out.includes('"body":"egress-forbidden"'),
    "exit=" + tgEvilToken.code + " (token URL not in the allowlist → network-free refusal)",
  );
  const tgEvilData = client(server.endpointFile, ["--custodian-token-get", "--token-url", "https://api-m.sandbox.paypal.com/v1/oauth2/token", "--user-slot", slotA, "--pass-slot", slotB, "--data-url", "https://evil.example.com/v1/reporting/transactions"]);
  record(
    "slot:v13-token-get-data-url-forbidden",
    tgEvilData.code === 0 && tgEvilData.out.includes('"body":"data-url-forbidden"'),
    "exit=" + tgEvilData.code + " (data URL host/path out of the closed set → network-free refusal)",
  );
  const tgMissing = client(server.endpointFile, ["--custodian-token-get", "--token-url", "https://api-m.sandbox.paypal.com/v1/oauth2/token", "--user-slot", "payswap:psp:probe:no-such", "--pass-slot", slotB, "--data-url", "https://api-m.sandbox.paypal.com/v1/reporting/transactions"]);
  record(
    "slot:v13-token-get-missing-slot-no-key",
    tgMissing.code === 0 && tgMissing.out.includes('"body":"no-key"'),
    "exit=" + tgMissing.code + " (either slot missing → no-key; never partial auth)",
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
    await batteryNamedSlots();
    await require("./custodian-battery-w1.cjs")({
      record,
      client,
      startConsoleServer,
      waitForEndpoint,
      workDir,
      HELPER,
      repoRoot,
      wait,
    });
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
