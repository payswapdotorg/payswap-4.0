"use strict";
/**
 * Custodian v1.1 post-deploy live verification (redeployed SYSTEM service).
 * Sequence (non-destructive; custody starts empty after the redeploy wipe):
 *   1. G1 genuine electron main registers + named-slot push (synthetic) + drop
 *      → the v1.1 named-slot lifecycle on the live service;
 *   2. G1 terminated → ATK wins the rebind race (recorded honestly) → all four
 *      custody ops of the arriving genuine desktop refused (exit 70, EOF, empty
 *      stdout) → ATK terminated → G3 fresh genuine main rebinds;
 *   3. custody is left EMPTY (no provider material touched).
 * Sanitization: exit codes + stable codes only; no token/key/canary material.
 */
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");

const ELECTRON = "C:\\Users\\Lenovo\\source\\repos\\payswap-4.0\\node_modules\\electron\\dist\\electron.exe";
const HELPER = "C:\\Users\\Lenovo\\source\\repos\\payswap-4.0\\packages\\desktop\\bundled-tools\\win32-x64\\payswap-broker-peer\\payswap-broker-peer-helper.exe";
const SHOTS = "C:\\Users\\Lenovo\\payswap-live-tools\\redteam";

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function idleMain(file) {
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
function run(args, stdin) {
  const r = spawnSync(HELPER, args, { encoding: "utf8", windowsHide: true, ...(stdin !== undefined ? { input: stdin } : {}) });
  return { code: r.status, outEmpty: (r.stdout || "") === "", err: (r.stderr || "").trim().slice(0, 60) };
}
const out = { pid: process.pid };
out.register = run(["--custodian-register"]);
let slotPush = null, slotDrop = null;
if (out.register.code === 0) {
  slotPush = run(["--custodian-push", "--slot", "payswap:psp:liveverify:slot-a"], "rk_liveverify_" + "5".repeat(60) + "\\n");
  slotDrop = run(["--custodian-drop", "--slot", "payswap:psp:liveverify:slot-a"]);
}
console.log("W11-LIVE " + JSON.stringify({ pid: out.pid, register: { exit: out.register.code }, slotPush: slotPush ? { exit: slotPush.code, ok: slotPush.code === 0 } : null, slotDrop: slotDrop ? { exit: slotDrop.code, ok: slotDrop.code === 0 } : null }));
setInterval(() => {}, 60000);
`);
}

function evilMain(file) {
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
function run(args, stdin) {
  const r = spawnSync(HELPER, args, { encoding: "utf8", windowsHide: true, ...(stdin !== undefined ? { input: stdin } : {}) });
  return { code: r.status, outEmpty: (r.stdout || "") === "" };
}
const out = { pid: process.pid };
out.register = run(["--custodian-register"]);
console.log("W11-EVIL " + JSON.stringify(out));
setInterval(() => {}, 60000);
`);
}

function g2Main(file) {
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
function run(args, stdin) {
  const r = spawnSync(HELPER, args, { encoding: "utf8", windowsHide: true, ...(stdin !== undefined ? { input: stdin } : {}) });
  return { code: r.status, outEmpty: (r.stdout || "") === "" };
}
const out = { pid: process.pid };
out.register = run(["--custodian-register"]);
out.push = run(["--custodian-push"], "rk_w1live_refused_" + "0".repeat(64) + "\\n");
out.get = run(["--custodian-get", "--path", "/v1/balance"]);
out.drop = run(["--custodian-drop"]);
console.log("W11-G2 " + JSON.stringify(out));
process.exit(0);
`);
}

function g3Main(file) {
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
const r = spawnSync(HELPER, ["--custodian-register"], { encoding: "utf8", windowsHide: true });
console.log("W11-G3 " + JSON.stringify({ pid: process.pid, register: { exit: r.status } }));
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
  try { return JSON.parse(line.slice(line.indexOf(marker) + marker.length).replace(/\r/g, "")); }
  catch { return null; }
}

async function main() {
  // 1. genuine main: registers, named-slot push + drop on the live service, stays alive
  idleMain(SHOTS + "\\w11-live-g1.cjs");
  const genuine = spawn(ELECTRON, [SHOTS + "\\w11-live-g1.cjs"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const g1 = parseMarker(await waitAndRead(genuine, "W11-LIVE ", 45000), "W11-LIVE ");
  const genuinePid = genuine.pid;
  const genuineRegistered = g1 !== null && g1.register.exit === 0;
  const slotLifecycle = g1 !== null && g1.slotPush && g1.slotPush.exit === 0 && g1.slotPush.ok && g1.slotDrop && g1.slotDrop.exit === 0 && g1.slotDrop.ok;
  console.log("[w11] G1 pid=" + genuinePid + " register exit=" + (g1 ? g1.register.exit : "n/a"),
    "named-slot push/drop:", g1 && g1.slotPush ? g1.slotPush.exit + "/" + (g1.slotDrop ? g1.slotDrop.exit : "n/a") : "skipped");
  if (!genuineRegistered) {
    genuine.kill();
    console.log("[w11] genuine registration failed — aborting (no state mutated)");
    process.exit(1);
  }

  try {
    // 2. genuine terminated → attacker wins the documented race (recorded honestly)
    genuine.kill();
    await wait(1500);
    evilMain(SHOTS + "\\w11-live-atk.cjs");
    const attacker = spawn(ELECTRON, [SHOTS + "\\w11-live-atk.cjs"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const evilRes = parseMarker(await waitAndRead(attacker, "W11-EVIL ", 45000), "W11-EVIL ");
    if (evilRes === null || evilRes.register.code !== 0) {
      console.log("[w11] attacker did NOT win the race:", evilRes ? JSON.stringify(evilRes.register) : "no result", "— investigate");
      attacker.kill();
      process.exit(2);
    }
    console.log("[w11] attacker pid=" + evilRes.pid + " WON the rebind race (honest recording)");

    // 3. the arriving genuine desktop is refused LOUDLY (all four ops)
    g2Main(SHOTS + "\\w11-live-g2.cjs");
    const g2Run = spawnSync(ELECTRON, [SHOTS + "\\w11-live-g2.cjs"], { encoding: "utf8", windowsHide: true, timeout: 60000 });
    const g2 = parseMarker(g2Run.stdout || "", "W11-G2 ");
    if (g2 === null) {
      console.log("[w11] G2 produced no result:", (g2Run.stdout || "").slice(0, 160));
      attacker.kill();
      process.exit(1);
    }
    const loud = (op) => op !== undefined && op.code === 70 && op.outEmpty === true;
    const refusals = { register: loud(g2.register), push: loud(g2.push), get: loud(g2.get), drop: loud(g2.drop) };
    const allRefused = refusals.register && refusals.push && refusals.get && refusals.drop;
    console.log("[w11] G2 all-four refused:", JSON.stringify(refusals),
      "exits:", JSON.stringify({ register: g2.register.code, push: g2.push.code, get: g2.get.code, drop: g2.drop.code }));

    // 4. attacker exits → documented recovery
    attacker.kill();
    await wait(1500);
    g3Main(SHOTS + "\\w11-live-g3.cjs");
    const g3Run = spawnSync(ELECTRON, [SHOTS + "\\w11-live-g3.cjs"], { encoding: "utf8", windowsHide: true, timeout: 60000 });
    const g3 = parseMarker(g3Run.stdout || "", "W11-G3 ");
    const recoveryOk = g3 !== null && g3.register.exit === 0;
    console.log("[w11] G3 recovery pid=" + (g3 ? g3.pid : "n/a") + " register exit=" + (g3 ? g3.register.exit : "n/a"));

    const verdict = slotLifecycle && genuineRegistered && allRefused && recoveryOk
      ? "V1.1 REDEPLOY VERIFIED — named slots live, W1 loud-refusal contract holds, recovery works, custody left empty"
      : "V1.1 REDEPLOY VERIFICATION FAILED — investigate";
    console.log("[w11] VERDICT: " + verdict);

    fs.writeFileSync(SHOTS + "\\w11-redeploy-result.json", JSON.stringify({
      verdict,
      date: new Date().toISOString(),
      serviceIdentity: {
        serviceName: "PayswapCustodianSvc",
        binaryPath: "C:\\ProgramData\\payswap\\svc-bin\\payswap-custodian-svc.exe (sc qc verified)",
        stagedBinarySha256: "e3902b3ae61bb3f08c47b54bb595e2ca20ea9f8076538adcb8804c017a35c90d",
        note: "svc-install File.Copy of the staged v1.1 binary (byte-identical)",
      },
      sequence: {
        genuineMain: { pid: genuinePid, registered: genuineRegistered, namedSlotLifecycle: slotLifecycle },
        attackerWon: { pid: evilRes.pid, register: evilRes.register },
        genuineRecoveryAttempt: { pid: g2.pid, refusals, exits: { register: g2.register.code, push: g2.push.code, get: g2.get.code, drop: g2.drop.code } },
        recovery: { pid: g3 ? g3.pid : null, register: g3 ? g3.register : null },
      },
      nonDestructive: true,
      custodyState: "starts empty (redeploy wipe) and stays empty — no provider material stored or read",
      restoreNotes: "reconnect the Stripe provider via the connection UI to restore live custody (the pre-deploy blob was wiped by the redeploy by design)",
    }, null, 1));
    process.exit(verdict.startsWith("V1.1 REDEPLOY VERIFIED") ? 0 : 2);
  } finally {
    try { genuine.kill(); } catch {}
  }
}

main().catch((e) => { console.error("v1.1 live verification crashed:", e.message); process.exit(1); });
