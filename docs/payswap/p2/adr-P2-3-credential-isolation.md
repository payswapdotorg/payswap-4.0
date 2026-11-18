# ADR-P2-3 — PSP credential isolation from model-controlled processes

- Status: **accepted as the P2-Windows blocker plan** (owner disposition 2026-11-18:
  "Hardening = P2 blocker" — recorded in `live-acceptance-evidence.md` §10.2)
- Supersedes: the 2026-11-17-era framing that placed the same-user DPAPI boundary
  outside P2 (§10.2 of the evidence register supersedes that statement)
- Enforcement gate: `scripts/payswap/security/isolation-probe.cjs` — **visible RED**
  until this ADR's acceptance criteria hold; the milestone is DONE exactly when the
  probe exits 0

## 1. Context

The 2026-11-18 security probe (evidence register §10) demonstrated end-to-end that a
plain, non-Electron, same-user process recovers a freshly stored PSP credential:

```
%APPDATA%/ZCode Dev/session/Local State (os_crypt.encrypted_key, "DPAPI"-prefixed)
  → plain DPAPI unprotect (CurrentUser) → 32-byte master key
  → v2/payswap-psp-safe-storage-key (Chromium "v10" AES-GCM blob) → 64-hex file key
  → v2/credentials.json "enc:v1:" slot (services cipher, public repo format)
  → restricted-key plaintext
```

A model-controlled process **is** such a same-user child. The established P2 law —
"PSP credentials must not be exposed to the model" — is therefore violated by the
current architecture regardless of how reliably the authorized tool path behaves.
Key rotation (§10.1) contains the historical exposure; it does not change the
boundary. Electron 44's os_crypt scheme does not either.

## 2. Decision

**Deny-restricted agent child processes** (equivalent isolation per the TL's
"or equivalent" clause), implemented in two independently landable layers:

### Layer 1 — deny-protected credential paths

The desktop main owns the PSP credential material and marks every path carrying it
with an explicit **deny ACE for an app-private restricting SID** (`S-1-5-21-0-0-0-<app-fixed-rid>`,
syntactically valid, authorization-only):

- `%APPDATA%/ZCode Dev/session/Local State` (os_crypt master key)
- `<dataRoot>/.zcode/v2/payswap-psp-safe-storage-key`
- `<dataRoot>/.zcode/v2/credentials.json`

Deny ACEs apply to any token carrying that SID **as a restricting SID**; the desktop
main's own (unrestricted) token is unaffected, so all legitimate host-side reads keep
working unchanged.

### Layer 2 — restricted-token spawn for model-controlled children

Every model-controlled process tree root — the agent CLI spawned by the host
(`ZCodeAgentProcessManager`), and the MCP/tool children it spawns — is created via
`CreateRestrictedToken` + `CreateProcessAsUser` (a new mode on the existing C#
payswap helper binary) carrying the app-private restricting SID. Restriction
**inherits** to all descendants, so one root site covers Bash/node-repl/MCP/tool
children. Restriction can only be added, never removed, by the restricted process
itself; minting a clean token requires TCB privileges the child does not have.

### Layer 3 — behavioral regression fence

- The adversarial probe (and additional child variants: PowerShell/.NET, arbitrary
  same-user children) must be **BLOCKED at file read** — the acceptance criterion is
  `isolation-probe.cjs` exit 0.
- A New Task four-category read must still succeed **through the broker** after the
  isolation lands (the lawful narrow path must keep working; only the raw
  credential face is cut off).
- The full five-stage runner + 13-step receipt re-run on the isolated build.

## 3. Alternatives considered

| Option | Assessment |
|---|---|
| Dedicated Windows service identity (plan §4 Option A) | Strongest on paper; rejected for now — requires admin elevation to install, and the desktop↔service authentication has the same-user bootstrap problem (a pipe ACL keyed on SID cannot distinguish the desktop from a same-user model process; per-boot secret exchange is interceptable at spawn). Recorded as the escalation path if the restricted-token boundary is ever bypassed. |
| AppContainer for agent children | Insufficient alone — the child keeps the user SID, and default DACLs granting the user would still admit it; would additionally break normal tool networking/file behavior. |
| In-memory-only credentials (never at rest) | Does not survive restart-persistence (receipt step 6/7 requires the stored credential); moves, not removes, the decryption surface. |
| Encrypt with a hardware-bound key (TPM) | Protects at-rest against OTHER machines, not other same-user processes; does not address the finding. |

## 4. Consequences

- Same-user model-controlled children lose read access to every credential-carrying
  file; the recovery chain is blocked at its first file read.
- The desktop main keeps single-owner access; no protocol or store-format change.
- All legitimate agent capability (four-category reads, route discovery, evidence
  refresh) continues through the existing authenticated broker/reader-bridge.
- Deployment adds a helper-binary mode + first-run ACL hardening step; both ship in
  the desktop installer/dev chain (no admin elevation needed — the files are owned
  by the user).
- Honest boundary statement: the restricted-token boundary defends the *files*;
  memory-read of the desktop main process by a same-user process remains out of
  scope for this layer (that is a same-trust-boundary breakout — a different threat
  class, tracked separately in the hardening milestone).

## 5. Rollout

1. Helper mode: `--spawn-restricted <cmd> [args…]` (C# P/Invoke:
   OpenProcessToken → CreateRestrictedToken(restricting SID) → CreateProcessAsUser).
2. First-run ACL step in desktop main: attach the deny ACE to the three paths.
3. Wire `ZCodeAgentProcessManager` spawn through the helper (restricted mode).
4. Turn `scripts/payswap/security/isolation-probe.cjs` GREEN (exit 0) — this is the
   milestone's acceptance gate, with the PowerShell variant added to the probe.
5. Re-prove: New Task four-category read + five-stage runner + 13-step receipt on
   the isolated build; update evidence register §10 with the GREEN probe output.
