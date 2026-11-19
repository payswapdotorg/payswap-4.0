"use strict";
/**
 * F6 IMPERSONATION TEST (live service, single-process full sequence).
 *
 * 1. spawn a GENUINE electron main (configured image) that registers via the
 *    genuine helper and STAYS ALIVE (the launcher keeps its stdio pipes open —
 *    a dead launcher closes pipes and kills the electron child);
 * 2. launch the impersonator: the SAME configured electron image with an
 *    attacker-controlled entry script, driving the genuine helper;
 * 3. EXPECT: register refused (first-alive-wins — the registered main is alive),
 *    data ops refused (parent pid != registered pid);
 * 4. kill the genuine main; spawn a fresh electron main → registration SUCCEEDS
 *    (documented residual race window — asserted so it cannot silently change);
 * 5. cleanup + custody restore note.
 */
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");

const ELECTRON = "C:\\Users\\Lenovo\\source\\repos\\payswap-4.0\\node_modules\\electron\\dist\\electron.exe";
const HELPER = "C:\\Users\\Lenovo\\source\\repos\\payswap-4.0\\packages\\desktop\\bundled-tools\\win32-x64\\payswap-broker-peer\\payswap-broker-peer-helper.exe";
const SHOTS = "C:\\Users\\Lenovo\\payswap-live-tools\\redteam";

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function writeIdleMain(file) {
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
const r = spawnSync(HELPER, ["--custodian-register"], { encoding: "utf8", windowsHide: true });
console.log("IDLE-REGISTER status=" + r.status + " out=" + (r.stdout || "").trim().slice(0, 60));
setInterval(() => {}, 60000);
`);
}

function writeEvilMain(file) {
  fs.writeFileSync(file, `
const { spawnSync } = require("node:child_process");
const HELPER = ${JSON.stringify(HELPER)};
function run(args, stdin) {
  const r = spawnSync(HELPER, args, { encoding: "utf8", windowsHide: true, ...(stdin !== undefined ? { input: stdin } : {}) });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const out = { pid: process.pid, image: process.execPath.toLowerCase() };
const reg = run(["--custodian-register"]);
out.register = { exit: reg.code, reply: reg.out.slice(0, 80), err: reg.err.slice(0, 60) };
const synthetic = "rk_f6synthetic_" + require("node:crypto").randomBytes(36).toString("hex");
const push = run(["--custodian-push"], synthetic + "\\n");
out.push = { exit: push.code, reply: push.out.slice(0, 60), err: push.err.slice(0, 60) };
const get = run(["--custodian-get", "--path", "/v1/balance"]);
let status = null;
try { status = JSON.parse(get.out).status; } catch {}
out.get = { exit: get.code, stripeStatus: status, err: get.err.slice(0, 60) };
const drop = run(["--custodian-drop"]);
out.drop = { exit: drop.code, reply: drop.out.slice(0, 60), err: drop.err.slice(0, 60) };
console.log("EVIL-RESULT " + JSON.stringify(out));
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

const results = [];
const record = (name, attackSucceeded, detail) => {
  results.push({ name, attackSucceeded });
  console.log((attackSucceeded ? "ATTACK-SUCCEEDED " : "ATTACK-BLOCKED   ") + name + (detail ? " — " + detail : ""));
};

async function main() {
  // 1. genuine main: registers and STAYS ALIVE (launcher holds pipes)
  writeIdleMain("C:\\Users\\Lenovo\\payswap-live-tools\\redteam\\genuine-idle.cjs");
  const genuine = spawn(ELECTRON, ["C:\\Users\\Lenovo\\payswap-live-tools\\redteam\\genuine-idle.cjs"], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const genuineOut = await waitAndRead(genuine, "IDLE-REGISTER", 30000);
  const genuineRegistered = genuineOut.includes("status=0");
  const genuinePid = genuine.pid;
  console.log("[f6] genuine main pid=" + genuinePid + " registered:", genuineRegistered, "|", genuineOut.trim().slice(0, 80));
  if (!genuineRegistered) {
    genuine.kill();
    console.log("[f6] genuine registration failed — aborting");
    process.exit(1);
  }

  try {
    // 2. the impersonator
    writeEvilMain("C:\\Users\\Lenovo\\payswap-live-tools\\redteam\\evil-main.cjs");
    const evil = spawnSync(ELECTRON, ["C:\\Users\\Lenovo\\payswap-live-tools\\redteam\\evil-main.cjs"], {
      encoding: "utf8", windowsHide: true, timeout: 120000,
    });
    const line = (evil.stdout || "").split("\n").find((l) => l.includes("EVIL-RESULT"));
    if (!line) {
      console.log("[f6] evil main produced no result:", (evil.stdout || "").slice(0, 200), (evil.stderr || "").slice(0, 120));
      process.exit(1);
    }
    const out = JSON.parse(line.slice(line.indexOf("EVIL-RESULT") + 12).replace(/\r/g, ""));
    console.log("[f6] impersonating electron pid=" + out.pid, "image-ok:", out.image === ELECTRON.toLowerCase());

    const registerOk = out.register.exit === 0 && out.register.reply.includes('"ok":true');
    const pushOk = out.push.exit === 0 && out.push.reply.includes('"ok":true');
    const getOk = out.get.exit === 0 && out.get.stripeStatus !== null;
    const dropOk = out.drop.exit === 0 && out.drop.reply.includes('"ok":true');

    record("register (attacker electron rebinds while genuine alive)", registerOk, JSON.stringify(out.register));
    record("push (attacker took custody)", pushOk, JSON.stringify(out.push));
    record("get (attacker used custody for a provider read)", getOk, JSON.stringify(out.get));
    record("drop (attacker destroyed custody)", dropOk, JSON.stringify(out.drop));
    const anySuccess = registerOk || pushOk || getOk || dropOk;

    // 3. documented residual: genuine dies → fresh electron main rebinds
    genuine.kill();
    await wait(1500);
    writeIdleMain("C:\\Users\\Lenovo\\payswap-live-tools\\redteam\\reborn-idle.cjs");
    const reborn = spawnSync(ELECTRON, ["C:\\Users\\Lenovo\\payswap-live-tools\\redteam\\reborn-idle.cjs"], {
      encoding: "utf8", windowsHide: true, timeout: 60000,
    });
    const rebornOk = (reborn.stdout || "").includes("status=0");
    console.log((rebornOk ? "RESIDUAL-CONFIRMED " : "RESIDUAL-CHANGED   ") + "fresh electron main rebinds after genuine death — " + (reborn.stdout || "").trim().slice(0, 90));

    console.log("[f6] VERDICT: " + (anySuccess ? "F6 CONFIRMED — impersonation reached the custodian" : "F6 BLOCKED — impersonation refused while the genuine main is alive"));
    if (anySuccess) {
      console.log("[f6] RESTORE-NOTES: custody was touched — run service-mode-harness.cjs full to restore the live credential");
    }
    fs.writeFileSync(SHOTS + "\\f6-live-result.json", JSON.stringify({ results, out, rebornOk }, null, 1));
    process.exit(anySuccess ? 0 : 2);
  } finally {
    try { genuine.kill(); } catch {}
  }
}

main().catch((e) => { console.error("f6 test crashed:", e.message); process.exit(1); });
