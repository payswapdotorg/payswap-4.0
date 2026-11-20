"use strict";
/**
 * W1 REGISTRATION-RACE TEST (live installed SYSTEM service, single sequence,
 * NON-DESTRUCTIVE). Round 3 item 2 — the permanent adversarial regression for
 * the documented residual first-alive registration race (ADR §A0.5 item 2).
 *
 * Console-mode battery companion: scripts/payswap/security/custodian-service-probe.cjs
 * batteryRegistrationRaceW1 (synthetic, private paths, all four ops for every
 * actor). This live leg proves the same contract against the REAL installed
 * service boundary (production pipe/token/identity gates, real electron image):
 *
 *  1. G1 genuine electron main registers + get /v1/balance → the documented
 *     positive read-only check through the live restricted key (§3.4 of the
 *     round-3 handoff; the key itself is never read by this script);
 *  2. G1 terminated → retained handle signals;
 *  3. ATK (same configured electron image, attacker-controlled entry) WINS the
 *     first-alive rebind race — recorded honestly — and drives get through the
 *     INCUMBENT custody material (the worst-case residual: the winner can USE
 *     the live credential; recorded as an HTTP status only);
 *  4. G2 genuine recovery-attempt main arrives while the attacker holds the
 *     registration: register/push/get/drop ALL refused — exit 70, EOF, empty
 *     stdout (the exact boundary the desktop maps to typed
 *     `custodian_unavailable` / inactive register-refused);
 *  5. ATK terminated → G3 fresh genuine main registers (documented recovery)
 *     and get answers again through the intact custody channel;
 *  6. NON-DESTRUCTIVE LAW: the attacker does NOT push/drop on the live service
 *     (the winner's push/drop control is proven synthetically in the console
 *     battery); custody blob/memory are never written — no restore needed.
 *
 * Sanitization: no token, no key material, no canary values, no reply bodies —
 * only exit codes, HTTP statuses and stable stderr codes are recorded.
 */
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");

const ELECTRON = "C:\\Users\\Lenovo\\source\\repos\\payswap-4.0\\node_modules\\electron\\dist\\electron.exe";
const HELPER = "C:\\Users\\Lenovo\\source\\repos\\payswap-4.0\\packages\\desktop\\bundled-tools\\win32-x64\\payswap-broker-peer\\payswap-broker-peer-helper.exe";
const STAGED_BINARY = "C:\\Users\\Lenovo\\source\\repos\\payswap-4.0\\packages\\desktop\\bundled-tools\\win32-x64\\payswap-broker-peer\\payswap-broker-peer-helper.exe";
const SHOTS = "C:\\Users\\Lenovo\\payswap-live-tools\\redteam";

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function writeIdleMain(file) {
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
function run(args, stdin) {
  const r = spawnSync(HELPER, args, { encoding: "utf8", windowsHide: true, ...(stdin !== undefined ? { input: stdin } : {}) });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim().slice(0, 60) };
}
const reg = run(["--custodian-register"]);
let status = null;
if (reg.code === 0) {
  const get = run(["--custodian-get", "--path", "/v1/balance"]);
  try { status = JSON.parse(get.out).status; } catch {}
  console.log("W1-LIVE-G1 " + JSON.stringify({ pid: process.pid, register: { exit: reg.code }, get: { exit: get.code, stripeStatus: status } }));
} else {
  console.log("W1-LIVE-G1 " + JSON.stringify({ pid: process.pid, register: { exit: reg.code, err: reg.err } }));
}
setInterval(() => {}, 60000);
`);
}

function writeEvilMain(file) {
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
function run(args, stdin) {
  const r = spawnSync(HELPER, args, { encoding: "utf8", windowsHide: true, ...(stdin !== undefined ? { input: stdin } : {}) });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim().slice(0, 60) };
}
const out = { pid: process.pid, image: process.execPath.toLowerCase() };
out.register = run(["--custodian-register"]);
// the race winner reaches the custody channel through the INCUMBENT material
// (worst-case residual — recorded as an HTTP status only; never a body).
let status = null;
if (out.register.code === 0) {
  const get = run(["--custodian-get", "--path", "/v1/balance"]);
  try { status = JSON.parse(get.out).status; } catch {}
  out.get = { exit: get.code, stripeStatus: status };
}
console.log("W1-LIVE-EVIL " + JSON.stringify(out));
setInterval(() => {}, 60000);
`);
}

// G2: the arriving genuine desktop — all four custody ops while the attacker
// holds the registration (push uses a synthetic canary; it is refused before
// any data flows, so the live service is never written).
function writeG2Main(file) {
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
function run(args, stdin) {
  const r = spawnSync(HELPER, args, { encoding: "utf8", windowsHide: true, ...(stdin !== undefined ? { input: stdin } : {}) });
  return { code: r.status, outEmpty: (r.stdout || "") === "", err: (r.stderr || "").trim().slice(0, 60) };
}
const out = { pid: process.pid };
out.register = run(["--custodian-register"]);
out.push = run(["--custodian-push"], "rk_w1live_refused_" + "0".repeat(64) + "\\n");
out.get = run(["--custodian-get", "--path", "/v1/balance"]);
out.drop = run(["--custodian-drop"]);
console.log("W1-LIVE-G2 " + JSON.stringify(out));
process.exit(0);
`);
}

function writeG3Main(file) {
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
function run(args, stdin) {
  const r = spawnSync(HELPER, args, { encoding: "utf8", windowsHide: true, ...(stdin !== undefined ? { input: stdin } : {}) });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim().slice(0, 60) };
}
const reg = run(["--custodian-register"]);
const out = { pid: process.pid, register: { exit: reg.code } };
let status = null;
if (reg.code === 0) {
  const get = run(["--custodian-get", "--path", "/v1/balance"]);
  try { status = JSON.parse(get.out).status; } catch {}
  out.get = { exit: get.code, stripeStatus: status };
}
console.log("W1-LIVE-G3 " + JSON.stringify(out));
process.exit(0);
`);
}

async function waitAndRead(child, marker, timeoutMs) {
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (out.includes(marker)) return out;
    await wait(300);
  }
  return out;
}

function parseMarker(out, marker) {
  const line = out.split("\n").find((l) => l.includes(marker));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(line.indexOf(marker) + marker.length).replace(/\r/g, ""));
  } catch {
    return null;
  }
}

async function main() {
  console.log("[w1-live] service identity capture");
  const qc = spawnSync("sc.exe", ["qc", "PayswapCustodianSvc"], { encoding: "utf8", windowsHide: true });
  const binLine = (qc.stdout || "").split("\n").find((l) => l.includes("BINARY_PATH_NAME"));
  const stagedSha = spawnSync("powershell", ["-NoProfile", "-Command",
    "(Get-FileHash -Algorithm SHA256 '" + STAGED_BINARY.replace(/\\/g, "\\\\") + "').Hash"], {
    encoding: "utf8", windowsHide: true,
  });
  const serviceIdentity = {
    serviceName: "PayswapCustodianSvc",
    binaryPath: binLine ? binLine.split(":").slice(1).join(":").trim() : null,
    stagedBinarySha256: (stagedSha.stdout || "").trim(),
    deployedBy: "svc-install File.Copy of the staged binary (byte-identical); the deployed copy is SYSTEM+Admins ACL-denied to this user",
    configuredImage: "C:\\Users\\Lenovo\\source\\repos\\payswap-4.0\\node_modules\\electron\\dist\\electron.exe (sc qc BINARY_PATH)",
    note: "custody blob/memory are NEVER written by this test (attacker push/drop deliberately omitted live; read-only gets only)",
  };
  console.log("[w1-live] service =", serviceIdentity.binaryPath, "staged sha =", serviceIdentity.stagedBinarySha256);

  // 1. genuine main: registers and STAYS ALIVE (launcher holds pipes)
  writeIdleMain(SHOTS + "\\w1-live-genuine-idle.cjs");
  const genuine = spawn(ELECTRON, [SHOTS + "\\w1-live-genuine-idle.cjs"], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const genuineOut = await waitAndRead(genuine, "W1-LIVE-G1", 45000);
  const g1 = parseMarker(genuineOut, "W1-LIVE-G1 ");
  const genuinePid = genuine.pid;
  const genuineRegistered = g1 !== null && g1.register.exit === 0;
  console.log("[w1-live] genuine main pid=" + genuinePid + " register exit=" + (g1 ? g1.register.exit : "n/a"),
    "get:", g1 && g1.get ? "exit=" + g1.get.exit + " stripeStatus=" + g1.get.stripeStatus : "skipped");
  if (!genuineRegistered) {
    genuine.kill();
    console.log("[w1-live] genuine registration failed — aborting (no state was mutated)");
    process.exit(1);
  }

  try {
    // 2. terminate the genuine main; the retained handle signals
    genuine.kill();
    await wait(1500);

    // 3. the attacker wins the documented race (recorded honestly)
    writeEvilMain(SHOTS + "\\w1-live-evil-main.cjs");
    const evil = spawn(ELECTRON, [SHOTS + "\\w1-live-evil-main.cjs"], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const evilOut = await waitAndRead(evil, "W1-LIVE-EVIL", 45000);
    const evilRes = parseMarker(evilOut, "W1-LIVE-EVIL ");
    if (evilRes === null || evilRes.register.code !== 0) {
      console.log("[w1-live] attacker did NOT win the race:", evilRes ? JSON.stringify(evilRes.register) : "no result",
        "(residual behavior changed — investigate before re-running)");
      evil.kill();
      process.exit(2);
    }
    console.log("[w1-live] attacker pid=" + evilRes.pid + " WON the rebind race; incumbent-material get:",
      evilRes.get ? "exit=" + evilRes.get.exit + " stripeStatus=" + evilRes.get.stripeStatus : "n/a");
    // the attacker stays alive holding the registration
    const attacker = evil;

    // 4. the arriving genuine desktop is refused LOUDLY (all four ops)
    writeG2Main(SHOTS + "\\w1-live-g2-attempt.cjs");
    const g2Run = spawnSync(ELECTRON, [SHOTS + "\\w1-live-g2-attempt.cjs"], {
      encoding: "utf8", windowsHide: true, timeout: 60000,
    });
    const g2 = parseMarker(g2Run.stdout || "", "W1-LIVE-G2 ");
    if (g2 === null) {
      console.log("[w1-live] G2 produced no result:", (g2Run.stdout || "").slice(0, 200), (g2Run.stderr || "").slice(0, 120));
      attacker.kill();
      process.exit(1);
    }
    const loud = (op) => op !== undefined && op.code === 70 && op.outEmpty === true;
    const refusalResults = {
      register: loud(g2.register),
      push: loud(g2.push),
      get: loud(g2.get),
      drop: loud(g2.drop),
    };
    console.log("[w1-live] G2 (genuine recovery attempt, pid=" + g2.pid + ") all four refused:",
      JSON.stringify(refusalResults),
      "exits:", JSON.stringify({ register: g2.register.code, push: g2.push.code, get: g2.get.code, drop: g2.drop.code }));

    // 5. attacker exits → documented recovery
    attacker.kill();
    await wait(1500);
    writeG3Main(SHOTS + "\\w1-live-g3-recovery.cjs");
    const g3Run = spawnSync(ELECTRON, [SHOTS + "\\w1-live-g3-recovery.cjs"], {
      encoding: "utf8", windowsHide: true, timeout: 60000,
    });
    const g3 = parseMarker(g3Run.stdout || "", "W1-LIVE-G3 ");
    const recoveryOk = g3 !== null && g3.register.exit === 0;
    console.log("[w1-live] G3 recovery pid=" + (g3 ? g3.pid : "n/a") + " register exit=" + (g3 ? g3.register.exit : "n/a"),
      "get:", g3 && g3.get ? "exit=" + g3.get.exit + " stripeStatus=" + g3.get.stripeStatus : "n/a");

    const allRefused = refusalResults.register && refusalResults.push && refusalResults.get && refusalResults.drop;
    const verdict = genuineRegistered && evilRes.register.code === 0 && allRefused && recoveryOk
      ? "W1 LOUD-REFUSAL CONTRACT HOLDS (race real + honest, genuine refused typed, recovery works)"
      : "W1 CONTRACT VIOLATED — investigate before merging";
    console.log("[w1-live] VERDICT: " + verdict);

    fs.writeFileSync(SHOTS + "\\w1-live-result.json", JSON.stringify({
      verdict,
      date: new Date().toISOString(),
      gate: "first-alive-wins rebind race is REAL and recorded honestly; the arriving genuine desktop is refused at ALL FOUR custody ops (exit 70, EOF, empty stdout — the exact boundary custodianClient.ts maps to inactive register-refused → typed custodian_unavailable); no attacker material flows to the genuine app (refused before any reply bytes); documented recovery (fresh genuine rebind) works after the attacker exits",
      sequence: {
        genuineMain: { pid: genuinePid, registered: genuineRegistered, get: g1 && g1.get },
        attackerWon: { pid: evilRes.pid, register: evilRes.register, incumbentGet: evilRes.get || null },
        genuineRecoveryAttempt: { pid: g2.pid, refusals: refusalResults, exits: { register: g2.register.code, push: g2.push.code, get: g2.get.code, drop: g2.drop.code } },
        recovery: { pid: g3 ? g3.pid : null, register: g3 ? g3.register : null, get: g3 ? g3.get : null },
      },
      serviceIdentity,
      nonDestructive: true,
      restoreNotes: "custody blob/memory never written (attacker push/drop omitted live by design; G2 push refused before any data flow) — no restore needed",
      consoleBatteryCompanion: "scripts/payswap/security/custodian-service-probe.cjs batteryRegistrationRaceW1 (54-check battery incl. 26 w1: checks — synthetic, private paths, all four ops for every actor)",
    }, null, 1));
    console.log("[w1-live] result written:", SHOTS + "\\w1-live-result.json");
    process.exit(verdict.startsWith("W1 LOUD-REFUSAL") ? 0 : 2);
  } finally {
    try { genuine.kill(); } catch {}
  }
}

main().catch((e) => { console.error("w1 live test crashed:", e.message); process.exit(1); });
