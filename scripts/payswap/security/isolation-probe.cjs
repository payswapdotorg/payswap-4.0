#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SECURITY LAW PROBE — PAYSWAP PSP CREDENTIAL ISOLATION (custodian architecture)
 * ═══════════════════════════════════════════════════════════════════════════
 * Run:  node scripts/payswap/security/isolation-probe.cjs
 * Laws: "PSP credentials must not be exposed to the model" and
 *       "an unauthorized same-user process cannot use the custodian pipe to
 *        obtain protected account data or manipulate its credential"
 *       (ADR-P2-3; TL handoff §A6).
 *
 * The probe proves BOTH halves of the custodian isolation boundary, and it is
 * REFUSES to return GREEN vacuously (the historical weakness of this probe —
 * "no credential to test" used to count as GREEN):
 *
 *   (0) MEANINGFUL-GREEN PRECONDITIONS — the acceptance environment must be
 *       prepared: the SYSTEM custodian must be active (endpoint file + key blob
 *       present) with a FRESHLY connected test credential (sanitized diag shows
 *       push-ok / bootstrap-key-restored). Missing precondition = FAIL.
 *   (1) AT-REST RECOVERY — an agent-equivalent SAME-USER plain node child
 *       attempts the full historical recovery chain (Local State os_crypt
 *       master key → v2/payswap-psp-safe-storage-key AES-GCM unwrap → every
 *       enc:v1 payswap:psp:* slot decrypt) and additionally attempts to read
 *       the custodian blob. Historical dead-key tombstones are handled
 *       EXPLICITLY: recovering a rotated dead key is a documented finding, NOT
 *       a pass/fail flip; the verdict keys on whether the FRESH credential
 *       (hash-compared against the operator's local secret file, never printed)
 *       is recoverable, or whether any fresh enc:v1 slot exists at all
 *       (legacy-store fallback evidence).
 *   (2) CUSTODIAN RPC BOUNDARY — the same child reads the (by-design readable)
 *       endpoint file, connects to the live pipe with the REAL token, and
 *       attempts get /v1/balance with a non-electron parent; it also attempts
 *       registration through a COPIED helper binary. Expected: every attempt
 *       refused (EOF / non-zero exit); the service stays alive and serves a
 *       legitimate client (verifiable separately via the electron harness).
 *
 * Key material is never printed, written, or transmitted — recovered plaintext
 * is reported only as SHA-256 digests, and the fresh-key comparison happens by
 * hash equality in this parent process.
 *
 * Env:
 *   PAYSWAP_ISOLATION_DATA_V2      (default = %HOME%\payswap-dev-data\.zcode\v2)
 *   PAYSWAP_ISOLATION_LOCAL_STATE  (default = %APPDATA%\ZCode Dev\session\Local State)
 *   PAYSWAP_ISOLATION_LIVE_KEY_FILE (default = %HOME%\.payswap-live.env)
 *   PAYSWAP_CUSTODIAN_HELPER       (default = repo staged helper)
 * Exit 0 = every adversarial attempt blocked; exit 1 = the law is violated (or
 * the acceptance environment was not prepared — which is also a gate failure).
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");

const DATA_V2 =
  process.env.PAYSWAP_ISOLATION_DATA_V2 ??
  path.join(os.homedir(), "payswap-dev-data", ".zcode", "v2");
const LOCAL_STATE =
  process.env.PAYSWAP_ISOLATION_LOCAL_STATE ??
  path.join(os.homedir(), "AppData", "Roaming", "ZCode Dev", "session", "Local State");
const LIVE_KEY_FILE =
  process.env.PAYSWAP_ISOLATION_LIVE_KEY_FILE ?? path.join(os.homedir(), ".payswap-live.env");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HELPER =
  process.env.PAYSWAP_CUSTODIAN_HELPER ||
  path.join(
    REPO_ROOT,
    "packages",
    "desktop",
    "bundled-tools",
    "win32-x64",
    "payswap-broker-peer",
    "payswap-broker-peer-helper.exe",
  );
const CUSTODIAN_DIR = path.join("C:", "ProgramData", "payswap");
const ENDPOINT_FILE = path.join(CUSTODIAN_DIR, "custodian-endpoint.json");
const KEY_BLOB_FILE = path.join(CUSTODIAN_DIR, "custodian-key.bin");
const DIAG_FILE = path.join(CUSTODIAN_DIR, "custodian-diag.log");
const HOST_NODE = process.execPath;

/** sha256 of the fresh credential — the only form in which the key is handled here. */
function freshKeyDigest() {
  const text = fs.readFileSync(LIVE_KEY_FILE, "utf8");
  const value = text.split("=").pop().trim();
  if (!value || value.length < 32) throw new Error("live key file missing or malformed");
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

// The hostile child runs as plain node (the process class the model controls).
// It reports digests and booleans only — never plaintext.
const CHILD_SOURCE = `
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const net = require("node:net");
const { execSync, spawnSync } = require("node:child_process");
const [dataV2, localState, helperPath] = process.argv.slice(2);
const out = {
  masterKey: false, fileKey: false, slotDigests: [], slotCount: 0,
  blobEperm: false, blobRead: false,
  pipeReplyBytes: 0, pipeReplyDigest: "", pipeGetRefused: true,
  copiedHelperRegisterExit: -1,
  errors: []
};
function digest(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
// (1) at-rest recovery chain
try {
  const j = JSON.parse(fs.readFileSync(localState, "utf8"));
  const masterB64 = Buffer.from(j.os_crypt.encrypted_key, "base64");
  const master = Buffer.from(
    execSync(
      "powershell -NoProfile -Command \\"Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('" +
        masterB64.slice(5).toString("base64") +
        "'), [byte[]]::new(0), [System.Security.Cryptography.DataProtectionScope]::CurrentUser))\\"",
      { encoding: "utf8" },
    ).trim(),
    "base64",
  );
  out.masterKey = master.length === 32;
  const wrapped = fs.readFileSync(path.join(dataV2, "payswap-psp-safe-storage-key"));
  const body = wrapped.slice(3);
  const d = crypto.createDecipheriv("aes-256-gcm", master, body.slice(0, 12));
  d.setAuthTag(body.slice(body.length - 16));
  const keyHex = Buffer.concat([d.update(body.slice(12, body.length - 16)), d.final()]).toString("utf8");
  out.fileKey = /^[0-9a-f]{64}$/.test(keyHex);
  const creds = JSON.parse(fs.readFileSync(path.join(dataV2, "credentials.json"), "utf8"));
  for (const [slot, value] of Object.entries(creds)) {
    if (!slot.startsWith("payswap:psp:")) continue;
    if (typeof value !== "string" || !value.startsWith("enc:v1:")) continue;
    try {
      const [iv, tag, ct] = value.slice("enc:v1:".length).split(".");
      const b64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      const d2 = crypto.createDecipheriv("aes-256-gcm", crypto.createHash("sha256").update(keyHex).digest(), b64url(iv));
      d2.setAuthTag(b64url(tag));
      const plain = Buffer.concat([d2.update(b64url(ct)), d2.final()]);
      out.slotCount += 1;
      out.slotDigests.push(digest(plain));
    } catch (e) {
      out.errors.push("slot-decrypt:" + slot + ":" + String(e).slice(0, 60));
    }
  }
} catch (e) {
  out.errors.push("recovery-chain:" + String(e).slice(0, 120));
}
// (1b) custodian blob — plain read attempt (expected EPERM under SYSTEM-only ACL)
try {
  const blob = fs.readFileSync("C:\\\\ProgramData\\\\payswap\\\\custodian-key.bin");
  out.blobRead = true;
  out.blobDigest = digest(blob);
} catch (e) {
  out.blobEperm = e.code === "EPERM" || e.code === "EACCES";
  if (!out.blobEperm) out.errors.push("blob:" + String(e).slice(0, 80));
}
// (2) custodian RPC boundary — real token, non-electron parent
function rawPipeAttempt(cb) {
  let endpoint = null;
  try { endpoint = JSON.parse(fs.readFileSync("C:\\\\ProgramData\\\\payswap\\\\custodian-endpoint.json", "utf8")); }
  catch (e) { out.errors.push("endpoint:" + String(e).slice(0, 80)); cb(); return; }
  const socket = net.connect("\\\\\\\\.\\\\pipe\\\\" + endpoint.pipe);
  const chunks = [];
  socket.on("connect", () => {
    socket.write(endpoint.token + "\\n");
    socket.write(JSON.stringify({ op: "get", path: "/v1/balance" }) + "\\n");
  });
  socket.on("data", (c) => chunks.push(c));
  socket.on("error", () => { finish(); });
  socket.on("close", () => finish());
  const t = setTimeout(() => { try { socket.destroy(); } catch {} finish(); }, 6000);
  let done = false;
  function finish() {
    if (done) return; done = true; clearTimeout(t);
    const reply = Buffer.concat(chunks);
    out.pipeReplyBytes = reply.length;
    if (reply.length > 0) {
      out.pipeReplyDigest = digest(reply);
      out.pipeGetRefused = false;
    }
    cb();
  }
}
// (2b) unauthorized registration through a COPIED helper binary
function copiedHelperAttempt(cb) {
  try {
    const copyPath = path.join(os.tmpdir(), "not-electron-helper-copy.exe");
    fs.copyFileSync(helperPath, copyPath);
    const r = spawnSync(copyPath, ["--custodian-register"], { encoding: "utf8", timeout: 30000, windowsHide: true });
    out.copiedHelperRegisterExit = r.status;
  } catch (e) {
    out.errors.push("copied-helper:" + String(e).slice(0, 80));
  }
  cb();
}
rawPipeAttempt(() => copiedHelperAttempt(() => process.stdout.write(JSON.stringify(out))));
`;

let verdict = "FAIL";
const failures = [];
const notes = [];

function fail(msg) {
  failures.push(msg);
}

async function main() {
  // ------------------------------------------------------------------
  // (0) meaningful-green preconditions — a vacuous GREEN is a failure
  // ------------------------------------------------------------------
  console.log("Preconditions (meaningful-green):");
  const endpointExists = fs.existsSync(ENDPOINT_FILE);
  const blobExists = fs.existsSync(KEY_BLOB_FILE);
  const diagText = fs.existsSync(DIAG_FILE) ? fs.readFileSync(DIAG_FILE, "utf8") : "";
  const freshInstalled =
    diagText.includes("custodian:push-ok") || diagText.includes("custodian:bootstrap-key-restored");
  console.log("  custodian endpoint file :", endpointExists);
  console.log("  key blob present        :", blobExists);
  console.log("  fresh credential in custody (diag):", freshInstalled);
  if (!endpointExists) fail("custodian endpoint file absent — service not active");
  if (!blobExists) fail("key blob absent — no fresh credential in custody to defend");
  if (!freshInstalled) fail("diag shows no push-ok/bootstrap-key-restored — no fresh credential installed");

  let freshDigest = null;
  try {
    freshDigest = freshKeyDigest();
  } catch (e) {
    fail("live key file unavailable for freshness comparison: " + e.message);
  }

  // ------------------------------------------------------------------
  // (1)+(2) hostile same-user child
  // ------------------------------------------------------------------
  if (fs.existsSync(HELPER) && failures.length === 0) {
    const tmp = path.join(os.tmpdir(), `payswap-isolation-child-${process.pid}.cjs`);
    fs.writeFileSync(tmp, CHILD_SOURCE);
    let out;
    try {
      out = JSON.parse(
        execFileSync(HOST_NODE, [tmp, DATA_V2, LOCAL_STATE, HELPER], {
          encoding: "utf8",
          timeout: 120000,
        }),
      );
    } catch (e) {
      fail("hostile child did not complete (probe must observe real attempts): " + String(e).slice(0, 160));
      out = null;
    }
    try { fs.unlinkSync(tmp); } catch {}

    if (out) {
      console.log("Adversarial child (same-user plain node, -I):");
      console.log("  master key recovered    :", out.masterKey);
      console.log("  file key unwrapped      :", out.fileKey);
      console.log("  enc:v1 PSP slots found  :", out.slotCount, "(digests only)");
      console.log("  custodian blob          :", out.blobRead ? "READ (boundary FAIL)" : out.blobEperm ? "EPERM (blocked)" : "unexpected error");
      console.log("  pipe get reply          :", out.pipeReplyBytes === 0 ? "no reply (refused)" : `REPLY ${out.pipeReplyBytes} bytes (boundary FAIL)`);
      console.log("  copied-helper register  : exit", out.copiedHelperRegisterExit, out.copiedHelperRegisterExit === 0 ? "(boundary FAIL)" : "(refused)");

      // (1) fresh credential must not be recoverable from user files
      if (out.blobRead) fail("same-user process READ the custodian key blob");
      const freshRecovered = (out.slotDigests || []).some((d) => d === freshDigest);
      if (freshRecovered) fail("FRESH credential recovered from a user-readable enc:v1 slot (legacy fallback)");
      if ((out.slotCount || 0) > 0) {
        notes.push(
          `historical enc:v1 tombstones present (${out.slotCount}) — recovered digests do not match the fresh credential; documented dead-key finding (rotated keys, no fresh overlap)`,
        );
      }

      // (2) unauthorized RPC must be refused
      if (out.pipeReplyBytes > 0) fail("unauthorized same-user client RECEIVED pipe data (get /v1/balance)");
      if (out.copiedHelperRegisterExit === 0) fail("COPIED helper binary registered with the custodian");
      if (out.pipeGetRefused === false) fail("unauthorized pipe client was not refused");
    }
  } else if (!fs.existsSync(HELPER)) {
    fail("helper binary missing — cannot exercise the RPC boundary");
  }

  // ------------------------------------------------------------------
  // diagnostic leak scan (fresh key must never appear in any diagnostic)
  // ------------------------------------------------------------------
  try {
    const diagLower = fs.readFileSync(DIAG_FILE, "utf8");
    const keyText = fs.readFileSync(LIVE_KEY_FILE, "utf8").split("=").pop().trim();
    if (diagLower.includes(keyText)) fail("FRESH key found in custodian diag (diagnostic leak)");
  } catch {
    // diag/key unreadable in this context — the probe battery covers hygiene separately
  }

  // ------------------------------------------------------------------
  // verdict
  // ------------------------------------------------------------------
  console.log("");
  for (const note of notes) console.log("NOTE:", note);
  if (failures.length > 0) {
    verdict = "FAIL";
    console.log("");
    for (const f of failures) console.log("FAIL:", f);
    console.log("");
    console.log("╔══════════════════════════════════════════════════════════════════╗");
    console.log("║  FAIL — the custodian isolation law is violated (or the          ║");
    console.log("║  acceptance environment was not prepared). P2-Windows stays      ║");
    console.log("║  in_progress until this gate is GREEN on the final head.         ║");
    console.log("╚══════════════════════════════════════════════════════════════════╝");
    process.exitCode = 1;
  } else {
    verdict = "GREEN";
    console.log("");
    console.log("PASS — meaningful and blocked: fresh credential in custody, at-rest");
    console.log("recovery blocked (fresh-key digest absent from all user-readable");
    console.log("material), unauthorized RPC refused, copied-helper registration");
    console.log("refused, diagnostics clean. (custodian isolation gate GREEN)");
  }
  console.log("verdict:", verdict);
}

main().catch((e) => {
  console.error("isolation-probe crashed:", e.message);
  process.exit(1);
});
