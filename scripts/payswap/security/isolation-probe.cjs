#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SECURITY LAW PROBE — PAYSWAP PSP CREDENTIAL ISOLATION (visible failing gate)
 * ═══════════════════════════════════════════════════════════════════════════
 * Run:  node scripts/payswap/security/isolation-probe.mjs
 * Law:  "PSP credentials must not be exposed to the model."
 *
 * Owner disposition (2026-11-18, evidence register §10.2): same-user credential
 * recovery is a **P2-Windows blocker**. This probe is the visible RED gate: it
 * spawns agent-equivalent SAME-USER child processes (plain node — the exact
 * process class the model controls) and attempts the full recovery chain
 * against the live data home. RED until the ADR-P2-3 isolation lands:
 *
 *   child → Local State os_crypt master key (plain DPAPI, .NET ProtectedData)
 *         → v2/payswap-psp-safe-storage-key (v10 AES-GCM unwrap)
 *         → v2/credentials.json enc:v1 PSP slot decrypt
 *
 * Deliberately NOT wired into CI (a permanent red gate would block unrelated
 * work); it is the documented acceptance criterion for the hardening milestone:
 * the milestone is DONE exactly when this probe exits 0 (recovery blocked).
 * Key material is never printed, written, or transmitted.
 *
 * Env: PAYSWAP_ISOLATION_DATA_V2, PAYSWAP_ISOLATION_LOCAL_STATE (defaults =
 * the 2026-11-18 isolated dev home used for the P2-Windows acceptance run).
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DATA_V2 =
  process.env.PAYSWAP_ISOLATION_DATA_V2 ??
  path.join(os.homedir(), "payswap-dev-data", ".zcode", "v2");
const LOCAL_STATE =
  process.env.PAYSWAP_ISOLATION_LOCAL_STATE ??
  path.join(os.homedir(), "AppData", "Roaming", "ZCode Dev", "session", "Local State");
const HOST_NODE = process.execPath;

const CHILD_SOURCE = `"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execSync } = require("node:child_process");
const [v2, localState] = process.argv.slice(2);
const out = { masterKey: false, fileKey: false, slotDecrypted: false, shape: "" };
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
  const wrapped = fs.readFileSync(v2 + "/payswap-psp-safe-storage-key");
  const body = wrapped.slice(3);
  const d = crypto.createDecipheriv("aes-256-gcm", master, body.slice(0, 12));
  d.setAuthTag(body.slice(body.length - 16));
  const keyHex = Buffer.concat([d.update(body.slice(12, body.length - 16)), d.final()]).toString("utf8");
  out.fileKey = /^[0-9a-f]{64}$/.test(keyHex);
  const creds = JSON.parse(fs.readFileSync(v2 + "/credentials.json", "utf8"));
  const slot = Object.keys(creds).find((k) => k.startsWith("payswap:psp:stripe:") && k.endsWith(":api-key"));
  if (slot && typeof creds[slot] === "string" && creds[slot].startsWith("enc:v1:")) {
    const [iv, tag, ct] = creds[slot].slice("enc:v1:".length).split(".");
    const b64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const d2 = crypto.createDecipheriv("aes-256-gcm", crypto.createHash("sha256").update(keyHex).digest(), b64url(iv));
    d2.setAuthTag(b64url(tag));
    const plain = Buffer.concat([d2.update(b64url(ct)), d2.final()]).toString("utf8");
    out.slotDecrypted = plain.startsWith("rk_test_") || plain.startsWith("sk_test_");
    out.shape = plain.slice(0, 8);
  } else {
    out.noSlot = true;
  }
} catch (e) {
  out.blocked = true;
  out.reason = String(e).slice(0, 160);
}
process.stdout.write(JSON.stringify(out));
`;

let verdict = "RED";
try {
  const tmp = path.join(os.tmpdir(), `payswap-isolation-child-${process.pid}.cjs`);
  fs.writeFileSync(tmp, CHILD_SOURCE);
  const out = JSON.parse(
    execFileSync(HOST_NODE, [tmp, DATA_V2, LOCAL_STATE], { encoding: "utf8", timeout: 60000 }),
  );
  fs.unlinkSync(tmp);
  console.log("Adversarial child (same-user plain node):");
  console.log("  master key recovered :", out.masterKey);
  console.log("  file key unwrapped   :", out.fileKey);
  console.log("  PSP slot decrypted   :", out.slotDecrypted, out.shape ? `(shape ${out.shape}…)` : "");
  if (out.noSlot) console.log("  (no live enc:v1 slot present — chain proven up to the key material)");
  if (out.blocked) console.log("  blocked at:", out.reason);
  verdict = out.slotDecrypted || (out.fileKey && out.masterKey) ? "RED" : "GREEN";
} catch (e) {
  console.log("  child blocked at launch:", String(e).slice(0, 120));
  verdict = "GREEN";
}

console.log("");
if (verdict === "RED") {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  FAIL — the law is violated: a same-user non-Electron process    ║");
  console.log("║  recovers PSP credentials. P2-Windows stays in_progress          ║");
  console.log("║  (owner disposition: hardening = P2 blocker, ADR-P2-3).          ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  process.exit(1);
}
console.log("PASS — recovery blocked; the ADR-P2-3 isolation holds. (hardening gate GREEN)");
process.exit(0);
