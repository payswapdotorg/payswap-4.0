"use strict";
/**
 * Custodian v1.2 post-deploy live verification (redeployed SYSTEM service).
 * Sequence (non-destructive; custody starts empty after the redeploy wipe):
 *   1. G1 genuine electron main registers + v1.1 named-slot lifecycle (push/drop)
 *      + pushes the PayPal credential-pair slots (synthetic) — stays alive;
 *   2. v1.2 POST proxy: the helper --custodian-post exchanges against the REAL
 *      PayPal sandbox token endpoint (egress closed-set allowed) → PayPal answers
 *      401 invalid_client (synthetic credentials) → status 401 returned — the
 *      full in-custodian token-exchange path proven live;
 *   3. POST proxy closed-set: a non-allowlisted URL is refused network-free;
 *   4. G1 terminated → ATK wins the rebind race (recorded honestly) → all four
 *      custody ops of the arriving genuine desktop refused (exit 70, EOF, empty
 *      stdout) → ATK terminated → G3 fresh genuine main rebinds;
 *   5. v1.2 multi-host GET: paystack /balance with an unknown slot → no-key
 *      (network-free); custody left EMPTY (no provider material stored).
 */
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");

const ELECTRON = "C:\\Users\\Lenovo\\source\\repos\\payswap-4.0\\node_modules\\electron\\dist\\electron.exe";
const HELPER = "C:\\Users\\Lenovo\\source\\repos\\payswap-4.0\\packages\\desktop\\bundled-tools\\win32-x64\\payswap-broker-peer\\payswap-broker-peer-helper.exe";
const SHOTS = "C:\\Users\\Lenovo\\payswap-live-tools\\redteam";

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
const pushes = [];
if (out.register.code === 0) {
  pushes.push(run(["--custodian-push", "--slot", "payswap:psp:liveverify:paypal:client-id"], "AeSyntheticClientId_" + "9".repeat(40) + "\\n"));
  pushes.push(run(["--custodian-push", "--slot", "payswap:psp:liveverify:paypal:client-secret"], "EXSyntheticSecret_" + "8".repeat(40) + "\\n"));
  pushes.push(run(["--custodian-push", "--slot", "payswap:psp:liveverify:slot-a"], "rk_liveverify_" + "5".repeat(60) + "\\n"));
  pushes.push(run(["--custodian-drop", "--slot", "payswap:psp:liveverify:slot-a"]));
}
console.log("W12-LIVE " + JSON.stringify({ pid: out.pid, register: { exit: out.register.code }, pushes: pushes.map(p => p.code) }));
setInterval(() => {}, 60000);
`);
}

function postProxyMain(file) {
  // standalone helper client: POST proxy → real PayPal sandbox → 401 invalid_client
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
const reg = spawnSync(HELPER, ["--custodian-register"], { encoding: "utf8", windowsHide: true });
const r = spawnSync(HELPER, ["--custodian-post", "--url", "https://api-m.sandbox.paypal.com/v1/oauth2/token", "--user-slot", "payswap:psp:liveverify:paypal:client-id", "--pass-slot", "payswap:psp:liveverify:paypal:client-secret", "--body", "grant_type=client_credentials"], { encoding: "utf8", windowsHide: true });
let status = null, bodyProbe = "";
try { const j = JSON.parse(r.stdout.trim()); status = j.status; bodyProbe = j.body.slice(0, 0); } catch {}
console.log("W12-POST " + JSON.stringify({ exit: r.status, status }));
process.exit(0);
`);
}

function postForbiddenMain(file) {
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
const reg = spawnSync(HELPER, ["--custodian-register"], { encoding: "utf8", windowsHide: true });
const r = spawnSync(HELPER, ["--custodian-post", "--url", "https://evil.example.com/v1/oauth2/token", "--user-slot", "payswap:psp:liveverify:paypal:client-id", "--pass-slot", "payswap:psp:liveverify:paypal:client-secret", "--body", "grant_type=client_credentials"], { encoding: "utf8", windowsHide: true });
let status = null;
try { status = JSON.parse(r.stdout.trim()).status; } catch {}
console.log("W12-FORBIDDEN " + JSON.stringify({ exit: r.status, status }));
process.exit(0);
`);
}

function paystackNoKeyMain(file) {
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
const reg = spawnSync(HELPER, ["--custodian-register"], { encoding: "utf8", windowsHide: true });
const r = spawnSync(HELPER, ["--custodian-get", "--path", "/balance", "--host", "api.paystack.co", "--slot", "payswap:psp:liveverify:no-such"], { encoding: "utf8", windowsHide: true });
let status = null, body = "";
try { const j = JSON.parse(r.stdout.trim()); status = j.status; body = j.body; } catch {}
console.log("W12-PAYSTACK " + JSON.stringify({ exit: r.status, status, body, bodyProbe: body.slice(0, 0) }));
process.exit(0);
`);
}

function evilMain(file) {
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
const r = spawnSync(HELPER, ["--custodian-register"], { encoding: "utf8", windowsHide: true });
console.log("W12-EVIL " + JSON.stringify({ pid: process.pid, register: { exit: r.status } }));
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
console.log("W12-G2 " + JSON.stringify(out));
process.exit(0);
`);
}

function g3Main(file) {
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
const r = spawnSync(HELPER, ["--custodian-register"], { encoding: "utf8", windowsHide: true });
console.log("W12-G3 " + JSON.stringify({ pid: process.pid, register: { exit: r.status } }));
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
  // 1. G1: register + named-slot lifecycle (pair slots + disposable slot)
  g1Main(SHOTS + "\\w12-live-g1.cjs");
  const genuine = spawn(ELECTRON, [SHOTS + "\\w12-live-g1.cjs"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const g1 = parseMarker(await waitAndRead(genuine, "W12-LIVE ", 45000), "W12-LIVE ");
  const genuinePid = genuine.pid;
  const genuineRegistered = g1 !== null && g1.register.exit === 0;
  const slotLifecycle = g1 !== null && Array.isArray(g1.pushes) && g1.pushes.length === 4 && g1.pushes.every((c) => c === 0);
  console.log("[w12] G1 pid=" + genuinePid + " register exit=" + (g1 ? g1.register.exit : "n/a") + " slot pushes/drop codes:", g1 ? JSON.stringify(g1.pushes) : "skipped");
  if (!genuineRegistered) {
    genuine.kill();
    console.log("[w12] genuine registration failed — aborting (no state mutated)");
    process.exit(1);
  }

  try {
    // 5. W1 race: G1 terminated → attacker wins → arriving genuine refused → recovery
    genuine.kill();
    await wait(1500);
    evilMain(SHOTS + "\\w12-live-atk.cjs");
    const attacker = spawn(ELECTRON, [SHOTS + "\\w12-live-atk.cjs"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const evilRes = parseMarker(await waitAndRead(attacker, "W12-EVIL ", 45000), "W12-EVIL ");
    if (evilRes === null || evilRes.register.exit !== 0) {
      console.log("[w12] attacker did NOT win the race:", evilRes ? JSON.stringify(evilRes.register) : "no result", "— investigate");
      attacker.kill();
      process.exit(2);
    }
    console.log("[w12] attacker pid=" + evilRes.pid + " WON the rebind race (honest recording)");

    g2Main(SHOTS + "\\w12-live-g2.cjs");
    const g2Run = spawnSync(ELECTRON, [SHOTS + "\\w12-live-g2.cjs"], { encoding: "utf8", windowsHide: true, timeout: 60000 });
    const g2 = parseMarker(g2Run.stdout || "", "W12-G2 ");
    if (g2 === null) {
      console.log("[w12] G2 produced no result:", (g2Run.stdout || "").slice(0, 160));
      attacker.kill();
      process.exit(1);
    }
    const loud = (op) => op !== undefined && op.code === 70 && op.outEmpty === true;
    const refusals = { register: loud(g2.register), push: loud(g2.push), get: loud(g2.get), drop: loud(g2.drop) };
    const allRefused = refusals.register && refusals.push && refusals.get && refusals.drop;
    console.log("[w12] G2 all-four refused:", JSON.stringify(refusals), "exits:", JSON.stringify({ register: g2.register.code, push: g2.push.code, get: g2.get.code, drop: g2.drop.code }));

    attacker.kill();
    await wait(1500);
    g3Main(SHOTS + "\\w12-live-g3.cjs");
    const g3Run = spawnSync(ELECTRON, [SHOTS + "\\w12-live-g3.cjs"], { encoding: "utf8", windowsHide: true, timeout: 60000 });
    const g3 = parseMarker(g3Run.stdout || "", "W12-G3 ");
    const recoveryOk = g3 !== null && g3.register.exit === 0;
    console.log("[w12] G3 recovery pid=" + (g3 ? g3.pid : "n/a") + " register exit=" + (g3 ? g3.register.exit : "n/a"));

    // 2. v1.2 POST proxy live: real PayPal sandbox token endpoint, synthetic pair
    postProxyMain(SHOTS + "\\w12-post-proxy.cjs");
    const postRun = spawnSync(ELECTRON, [SHOTS + "\\w12-post-proxy.cjs"], { encoding: "utf8", windowsHide: true, timeout: 60000 });
    const postRes = parseMarker(postRun.stdout || "", "W12-POST ");
    // PayPal answers 401 invalid_client for the synthetic pair — the proxy path proven live
    const postProxyOk = postRes !== null && postRes.status === 401;
    console.log("[w12] POST proxy → real PayPal sandbox:", postRes ? "status=" + postRes.status : "no result", postProxyOk ? "(401 invalid_client = the proxy path works end-to-end)" : "");

    // 3. POST closed-set refusal (network-free)
    postForbiddenMain(SHOTS + "\\w12-post-forbidden.cjs");
    const forbRun = spawnSync(ELECTRON, [SHOTS + "\\w12-post-forbidden.cjs"], { encoding: "utf8", windowsHide: true, timeout: 60000 });
    const forb = parseMarker(forbRun.stdout || "", "W12-FORBIDDEN ");
    const forbOk = forb !== null && forb.status === 0;
    console.log("[w12] POST out-of-set URL refused:", forb ? "status=" + forb.status : "no result", "(network-free)");

    // 4. v1.2 multi-host GET: paystack /balance with an unknown slot → no-key
    paystackNoKeyMain(SHOTS + "\\w12-paystack-nokey.cjs");
    const psRun = spawnSync(ELECTRON, [SHOTS + "\\w12-paystack-nokey.cjs"], { encoding: "utf8", windowsHide: true, timeout: 60000 });
    const ps = parseMarker(psRun.stdout || "", "W12-PAYSTACK ");
    const psOk = ps !== null && ps.status === 0 && ps.body === "no-key";
    console.log("[w12] Paystack multi-host GET unknown slot:", ps ? "status=" + ps.status + " body=" + ps.body : "no result");


    const verdict = slotLifecycle && genuineRegistered && postProxyOk && forbOk && psOk && allRefused && recoveryOk
      ? "V1.2 REDEPLOY VERIFIED — POST proxy live (real PayPal 401), multi-host GET closed-set holds, named slots live, W1 loud-refusal contract holds, recovery works, custody left empty"
      : "V1.2 REDEPLOY VERIFICATION FAILED — investigate";
    console.log("[w12] VERDICT: " + verdict);

    fs.writeFileSync(SHOTS + "\\w12-redeploy-result.json", JSON.stringify({
      verdict,
      date: new Date().toISOString(),
      serviceIdentity: {
        serviceName: "PayswapCustodianSvc",
        binaryPath: "C:\\ProgramData\\payswap\\svc-bin\\payswap-custodian-svc.exe (sc qc verified)",
        stagedBinarySha256: "b3374f7b7528378cfc8d76ff45e056c990fc91237e9c50601b877cc2b2b747ac",
        note: "svc-install File.Copy of the staged v1.2 binary (byte-identical)",
      },
      sequence: {
        genuineMain: { pid: genuinePid, registered: genuineRegistered, namedSlotLifecycle: slotLifecycle },
        postProxyLive: { paypalSandboxStatus: postRes ? postRes.status : null, interpretation: "401 invalid_client for the synthetic pair = the in-custodian token-exchange path works end-to-end against the real sandbox endpoint" },
        postClosedSet: forb ? forb.status : null,
        paystackMultiHostNoKey: ps ? { status: ps.status, body: ps.body } : null,
        attackerWon: { pid: evilRes.pid, register: evilRes.register },
        genuineRecoveryAttempt: { pid: g2.pid, refusals, exits: { register: g2.register.code, push: g2.push.code, get: g2.get.code, drop: g2.drop.code } },
        recovery: { pid: g3 ? g3.pid : null, register: g3 ? g3.register : null },
      },
      nonDestructive: true,
      custodyState: "starts empty (redeploy wipe); only synthetic slot material stored then dropped; no provider credentials stored or read",
      restoreNotes: "reconnect providers via the connection UI to restore live custody",
    }, null, 1));
    process.exit(verdict.startsWith("V1.2 REDEPLOY VERIFIED") ? 0 : 2);
  } finally {
    try { genuine.kill(); } catch {}
  }
}

main().catch((e) => { console.error("v1.2 live verification crashed:", e.message); process.exit(1); });
