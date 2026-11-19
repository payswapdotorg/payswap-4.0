# New Task conversational evidence (redacted transcript excerpts) — 2026-11-18

Environment: dev desktop (`pnpm dev:desktop:prod`), isolated data home
(`ZCODE_DATA_BASE_DIR=C:\Users\Lenovo\payswap-dev-data`), model GLM-5.3
(Z.ai Start Plan), tested branch state `15d1eca6` (p2/acceptance-runner-fail-closed).
Operator consents recorded in-session: financial workspace (S2) and acceptance-key
connection, both performed through the real settings UIs.

## Arm 1 — four-category overview (connection: "stripe (test)", test mode)

User: "Using the PaySwap account overview, show me my connected Stripe account:
current balance, recent payment objects, customer summary, and any disputes. All
four categories please."

Model tool call: MCP Gateway — `payswap_get_account_overview` (no connectionId).
Broker audit: `dispatched op:get_account_overview peerPid:5488` (verified peer;
see broker-audit.jsonl, ts 1795027809144).

Answer (verbatim table content, test-mode sandbox data):

1. Balance — USD 69,854.06 available / 0.00 pending; EUR 147.48 available / 0.00 pending.
2. Payment objects — 10 charges: 8 succeeded, 2 failed ($2.50, $25.00 on Sep 3);
   successful volume ≈ $191.00 + €2.00.
3. Customers — 10 sanitized projections (id + description + created only; no
   email/name/PII): 6 "PaySwap live test customer" (Aug 4, 2026) + 4 unlabeled (Oct 2025).
4. Disputes — empty list.

Note: exactly one connected account existed; no connectionId was passed — the
deterministic single-account auto-resolve attached the detail in the same answer.

## Arm 2 — revoke → typed refusal (checklist steps 12–13)

Settings → Payment connections → Revoke → UI: "Connection revoked. The locally
stored secret was deleted." (store row tombstoned status=revoked, updatedAt
2026-11-18T18:54:09.236Z; see §10 security note).

User: "Pull a fresh PaySwap account overview right now — balance, payment
objects, customers, disputes. All four categories."

Model tool call: `payswap_get_account_overview` → typed refusal (revoked state).

Answer (verbatim): "Fresh pull complete — but the situation changed: your Stripe
connection has been revoked." Table: Balance / Payment objects / Customers /
Disputes → each "unavailable — connection revoked". "I can't restore the
connection from my side — re-authorization has to happen in the PaySwap plugin
UI." — **no improvisation, no direct Stripe access, no credential recovery**.
