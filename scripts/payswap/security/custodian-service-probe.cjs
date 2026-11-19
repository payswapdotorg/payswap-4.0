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
 *                             refused / unreachable / not-confirmed.
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
  // options: { testGate?: string, blob?: string, diag?: string }
  // 每 server 独立管道名 —— 同名管道被 server1 占用时 server2 无法监听（客户端
  // 会带着 server2 的 token 连上 server1 → token-mismatch EOF，伪 70）。
  const uniquePipe = pipeName + "-" + crypto.randomBytes(3).toString("hex");
  const args = [
    "--svc-console",
    "--image",
    "C:\\nonexistent\\electron.exe",
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
