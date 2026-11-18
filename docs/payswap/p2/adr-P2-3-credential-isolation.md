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

**First attempt (2026-11-18) — deny-restricted agent child processes — REJECTED by
live Windows privilege reality.** Implementation detail: `CreateRestrictedToken`
works, but `CreateProcessAsUser` with the derived restricted token fails with
**win32 1314 (ERROR_PRIVILEGE_NOT_HELD)** — SeIncreaseQuotaPrivilege is not held by
a non-elevated desktop process (Windows 11 26200 default token), and the documented
alternatives (`CreateProcessWithTokenW`) need SeImpersonatePrivilege — likewise not
held. Undocumented workarounds (NtSetInformationProcess ProcessAccessToken swap) are
against the repo's documented-API discipline. The helper binary retains the
`--harden-path` / `--harden-child` / `--spawn-restricted` modes as the probe
instrumentation, but the restricted-token spawn layer cannot ship.

**Accepted design — dedicated-identity custodian helper** (the TL's Option A,
realized without a permanent Windows service install):

### Layer 1 — one-time elevated provisioning (operator-gated, UAC step)

A local account `payswap-broker` (random 32-char password, generated at provision
time, stored **only** in the helper-readable provisioned store whose DACL grants
just that account + SYSTEM). Provisioning = one elevated `net user /add` +
password hand-off; never repeated.

### Layer 2 — custodian helper = the ONLY reader/decryptor

The existing payswap-broker-peer helper gains `--custodian` mode: it calls
`LogonUser("payswap-broker", …)` (no caller privilege required for
LOGON32_LOGON_BATCH/INTERACTIVE with explicit credentials — verified against the
Win32 contract) and impersonates, then:

- reads the PSP wrapped-key + `credentials.json` slots (DACLS re-keyed: grant
  `payswap-broker` + SYSTEM only, **revoke Lenovo read**),
- derives the cipher, performs the Stripe read-back itself (the four categories
  + account evidence),
- returns **redacted projections only** over the existing authenticated
  reader-bridge/relay channel (D14.8 image-path gate machinery).

The desktop main never holds — not even as ciphertext — the PSP credential: the
store file is unreadable to Lenovo/model processes by DACL, and the plaintext
exists only inside the impersonated helper process.

### Layer 3 — adversarial acceptance (unchanged, sharpened)

- `scripts/payswap/security/isolation-probe.cjs` GREEN: same-user child is blocked
  at file read (DACLS deny Lenovo outright — stronger than the restricted-token
  design's conditional protection).
- The helper's authenticated channel stays hash/image-gated (D14.8) so model-side
  processes cannot drive the custodian directly.
- New Task four-category read re-proved through the custodian; full five-stage
  runner + 13-step receipt re-run on the isolated build.

## 3. Alternatives considered

| Option | Assessment |
|---|---|
| Restricted-token agent children (first attempt) | REJECTED live: `CreateProcessAsUser` needs SeIncreaseQuotaPrivilege (win32 1314 on 26200); `CreateProcessWithTokenW` needs SeImpersonatePrivilege; both absent from non-elevated desktop processes. Undocumented NtSetInformationProcess token-swap rejected on documented-API discipline. |
| Full Windows service (permanent install) | Heavier than the custodian helper for the same guarantee (the custodian impersonates a dedicated identity per-call instead of a service hosting it permanently); no service-control-manager surface, no install-time service ACLs. Escalation path if the LogonUser-based custodian proves fragile. |
| AppContainer for agent children | Insufficient alone (child keeps user SID; default DACLs granting the user still admit it) and cripples normal tool behavior (loopback/network denied). |
| In-memory-only credentials (never at rest) | Breaks receipt steps 6/7 (restart persistence); moves the surface. |
| TPM-bound encryption | Protects against other machines, not same-user processes. |

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
