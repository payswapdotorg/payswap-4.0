"use strict";
/**
 * W1 first-alive registration race battery (Battery 6) — extracted module.
 * The probe driver stays under the architecture max-lines cap; this battery
 * keeps its own file and receives the probe's IO seams via a context object.
 *
 * ctx: { record, client, startConsoleServer, waitForEndpoint, workDir, HELPER, repoRoot, wait }
 */
module.exports = function batteryRegistrationRaceW1(ctx) {
  const { record, client, startConsoleServer, waitForEndpoint, workDir, HELPER, repoRoot, wait } = ctx;
  const fs = require("node:fs");
  const path = require("node:path");
  const crypto = require("node:crypto");
  const { spawn, spawnSync } = require("node:child_process");

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
  return batteryRegistrationRaceW1();
}
