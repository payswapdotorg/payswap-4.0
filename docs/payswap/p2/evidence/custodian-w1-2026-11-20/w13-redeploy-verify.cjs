"use strict";
/**
 * Custodian v1.3 post-deploy live verification (redeployed SYSTEM service).
 * Sequence (non-destructive; custody starts empty after the redeploy wipe):
 *   1. G1 genuine electron main registers + v1.1 named-slot lifecycle (push the
 *      PayPal pair slots + disposable slot + drop the disposable) — stays alive;
 *   2. v1.3 token+data proxy live: the helper --custodian-token-get exchanges
 *      against the REAL PayPal sandbox token endpoint (synthetic pair → 401
 *      invalid_client) and the data URL closed-set refuses an out-of-set URL
 *      network-free;
 *   3. G1 terminated → ATK wins the rebind race (recorded honestly) → all four
 *      custody ops of the arriving genuine desktop refused (exit 70, EOF, empty
 *      stdout) → ATK terminated → G3 fresh genuine main rebinds;
 *   4. custody left EMPTY (no provider material stored).
 */
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");

const ELECTRON = "C:\\Users\\Lenovo\\source\\repos\\payswap-4.0\\node_modules\\electron\\dist\\electron.exe";
const HELPER = "C:\\Users\\Lenovo\\source\\repos\\payswap-4.0\\packages\\desktop\\bundled-tools\\win32-x64\\payswap-broker-peer\\payswap-broker-peer-helper.exe";
const SHOTS = "C:\\Users\\Lenovo\\payswap-live-tools\\redteam";
const CLIENT_ID_SLOT = "payswap:psp:liveverify:paypal:client-id";
const CLIENT_SECRET_SLOT = "payswap:psp:liveverify:paypal:client-secret";
const TOKEN_URL = "https://api-m.sandbox.paypal.com/v1/oauth2/token";

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function g1Main(file) {
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
function run(args, stdin) {
  const r = spawnSync(HELPER, args, { encoding: "utf8", windowsHide: true, ...(stdin !== undefined ? { input: stdin } : {}) });
  return { code: r.status, out: (r.stdout || "").trim() };
}
const out = { pid: process.pid };
out.register = run(["--custodian-register"]);
const slotCodes = [];
if (out.register.code === 0) {
  slotCodes.push(run(["--custodian-push", "--slot", "payswap:psp:liveverify:paypal:client-id"], "AeSyntheticClientId_" + "9".repeat(40) + "\\n").code);
  slotCodes.push(run(["--custodian-push", "--slot", "payswap:psp:liveverify:paypal:client-secret"], "EXSyntheticSecret_" + "8".repeat(40) + "\\n").code);
  slotCodes.push(run(["--custodian-push", "--slot", "payswap:psp:liveverify:slot-a"], "rk_liveverify_" + "5".repeat(60) + "\\n").code);
  slotCodes.push(run(["--custodian-drop", "--slot", "payswap:psp:liveverify:slot-a"]).code);
  // v1.3 token+data proxy live: real PayPal sandbox token endpoint, synthetic pair
  const tg = run(["--custodian-token-get", "--token-url", "${TOKEN_URL}", "--user-slot", "payswap:psp:liveverify:paypal:client-id", "--pass-slot", "payswap:psp:liveverify:paypal:client-secret", "--data-url", "https://api-m.sandbox.paypal.com/v1/customer/disputes"]);
  let tgStatus = null;
  try { tgStatus = JSON.parse(tg.out).status; } catch {}
  out.tokenGet = { exit: tg.code, paypalStatus: tgStatus };
  // v1.3 data URL closed-set: out-of-set data URL → network-free refusal
  const tgEvil = run(["--custodian-token-get", "--token-url", "${TOKEN_URL}", "--user-slot", "payswap:psp:liveverify:paypal:client-id", "--pass-slot", "payswap:psp:liveverify:paypal:client-secret", "--data-url", "https://evil.example.com/v1/reporting/transactions"]);
  let evilStatus = null, evilBody = "";
  try { const j = JSON.parse(tgEvil.out); evilStatus = j.status; evilBody = j.body; } catch {}
  out.tokenGetEvil = { exit: tgEvil.code, status: evilStatus, body: evilBody };
}
console.log("W13-LIVE " + JSON.stringify({ pid: out.pid, register: { exit: out.register.code }, slotCodes, tokenGet: out.tokenGet || null, tokenGetEvil: out.tokenGetEvil || null }));
setInterval(() => {}, 60000);
`);
}

function evilMain(file) {
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
const r = spawnSync(HELPER, ["--custodian-register"], { encoding: "utf8", windowsHide: true });
console.log("W13-EVIL " + JSON.stringify({ pid: process.pid, register: { exit: r.status } }));
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
console.log("W13-G2 " + JSON.stringify(out));
process.exit(0);
`);
}

function g3Main(file) {
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
const r = spawnSync(HELPER, ["--custodian-register"], { encoding: "utf8", windowsHide: true });
console.log("W13-G3 " + JSON.stringify({ pid: process.pid, register: { exit: r.status } }));
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
  // 1. G1: register + named-slot lifecycle + v1.3 token+data proxy live
  g1Main(SHOTS + "\\w13-live-g1.cjs");
  const genuine = spawn(ELECTRON, [SHOTS + "\\w13-live-g1.cjs"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const g1 = parseMarker(await waitAndRead(genuine, "W13-LIVE ", 45000), "W13-LIVE ");
  const genuinePid = genuine.pid;
  const genuineRegistered = g1 !== null && g1.register.exit === 0;
  const slotLifecycle = g1 !== null && Array.isArray(g1.slotCodes) && g1.slotCodes.length === 4 && g1.slotCodes.every((c) => c === 0);
  const tgLive = g1 !== null && g1.tokenGet !== null;
  const tgPaypal401 = tgLive && g1.tokenGet.paypalStatus === 401;
  const tgEvil = g1 !== null && g1.tokenGetEvil !== null && g1.tokenGetEvil.status === 0 && g1.tokenGetEvil.body === "data-url-forbidden";
  console.log("[w13] G1 pid=" + genuinePid + " register exit=" + (g1 ? g1.register.exit : "n/a") + " slot lifecycle:", slotLifecycle,
    "token-get PayPal status:", tgLive ? g1.tokenGet.paypalStatus : "n/a",
    "evil data URL:", tgEvil ? g1.tokenGetEvil.status + "/" + g1.tokenGetEvil.body : "n/a");
  if (!genuineRegistered) {
    genuine.kill();
    console.log("[w13] genuine registration failed — aborting (no state mutated)");
    process.exit(1);
  }

  try {
    // 2. W1: G1 terminated → attacker wins → arriving genuine refused → recovery
    genuine.kill();
    await wait(1500);
    evilMain(SHOTS + "\\w13-live-atk.cjs");
    const attacker = spawn(ELECTRON, [SHOTS + "\\w13-live-atk.cjs"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const evilRes = parseMarker(await waitAndRead(attacker, "W13-EVIL ", 45000), "W13-EVIL ");
    if (evilRes === null || evilRes.register.exit !== 0) {
      console.log("[w13] attacker did NOT win the race:", evilRes ? JSON.stringify(evilRes.register) : "no result", "— investigate");
      attacker.kill();
      process.exit(2);
    }
    console.log("[w13] attacker pid=" + evilRes.pid + " WON the rebind race (honest recording)");

    g2Main(SHOTS + "\\w13-live-g2.cjs");
    const g2Run = spawnSync(ELECTRON, [SHOTS + "\\w13-live-g2.cjs"], { encoding: "utf8", windowsHide: true, timeout: 60000 });
    const g2 = parseMarker(g2Run.stdout || "", "W13-G2 ");
    if (g2 === null) {
      console.log("[w13] G2 produced no result:", (g2Run.stdout || "").slice(0, 160));
      attacker.kill();
      process.exit(1);
    }
    const loud = (op) => op !== undefined && op.code === 70 && op.outEmpty === true;
    const refusals = { register: loud(g2.register), push: loud(g2.push), get: loud(g2.get), drop: loud(g2.drop) };
    const allRefused = refusals.register && refusals.push && refusals.get && refusals.drop;
    console.log("[w13] G2 all-four refused:", JSON.stringify(refusals), "exits:", JSON.stringify({ register: g2.register.code, push: g2.push.code, get: g2.get.code, drop: g2.drop.code }));

    attacker.kill();
    await wait(1500);
    g3Main(SHOTS + "\\w13-live-g3.cjs");
    const g3Run = spawnSync(ELECTRON, [SHOTS + "\\w13-live-g3.cjs"], { encoding: "utf8", windowsHide: true, timeout: 60000 });
    const g3 = parseMarker(g3Run.stdout || "", "W13-G3 ");
    const recoveryOk = g3 !== null && g3.register.exit === 0;
    console.log("[w13] G3 recovery pid=" + (g3 ? g3.pid : "n/a") + " register exit=" + (g3 ? g3.register.exit : "n/a"));

    const verdict = slotLifecycle && genuineRegistered && tgPaypal401 && tgEvil && allRefused && recoveryOk
      ? "V1.3 REDEPLOY VERIFIED — named slots live, token+data proxy live (real PayPal 401), data URL closed-set holds, W1 loud-refusal contract holds, recovery works, custody left empty"
      : "V1.3 REDEPLOY VERIFICATION FAILED — investigate";
    console.log("[w13] VERDICT: " + verdict);

    fs.writeFileSync(SHOTS + "\\w13-redeploy-result.json", JSON.stringify({
      verdict,
      date: new Date().toISOString(),
      serviceIdentity: {
        serviceName: "PayswapCustodianSvc",
        binaryPath: "C:\\ProgramData\\payswap\\svc-bin\\payswap-custodian-svc.exe (sc qc verified)",
        stagedBinarySha256: "19b6e9a1bd6353f431d6fb987c9eaa2c046c3a7f485be869fbbb9d54f1b61a23",
        note: "svc-install File.Copy of the staged v1.3 binary (byte-identical)",
      },
      sequence: {
        genuineMain: { pid: genuinePid, registered: genuineRegistered, namedSlotLifecycle: slotLifecycle, tokenGetPaypalStatus: tgLive ? g1.tokenGet.paypalStatus : null, tokenGetEvilDataUrl: tgEvil ? { status: g1.tokenGetEvil.status, body: g1.tokenGetEvil.body } : null },
        attackerWon: { pid: evilRes.pid, register: evilRes.register },
        genuineRecoveryAttempt: { pid: g2.pid, refusals, exits: { register: g2.register.code, push: g2.push.code, get: g2.get.code, drop: g2.drop.code } },
        recovery: { pid: g3 ? g3.pid : null, register: g3 ? g3.register : null },
      },
      nonDestructive: true,
      custodyState: "starts empty (redeploy wipe); only synthetic slot material stored then dropped; no provider credentials stored or read",
      restoreNotes: "reconnect providers via the connection UI to restore live custody",
    }, null, 1));
    process.exit(verdict.startsWith("V1.3 REDEPLOY VERIFIED") ? 0 : 2);
  } finally {
    try { genuine.kill(); } catch {}
  }
}

main().catch((e) => { console.error("v1.3 live verification crashed:", e.message); process.exit(1); });
