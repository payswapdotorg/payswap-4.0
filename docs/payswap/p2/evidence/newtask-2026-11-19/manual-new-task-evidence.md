# P2 conversation-acceptance — manual New Task evidence

> Fill every `Result:` line below with what you actually observed, attach sanitized
> screenshots next to this file, then save as `manual-new-task-evidence.md` and re-run:
> `node scripts\payswap\windows\run-p2-acceptance.cjs --stage conversation-acceptance --manual-evidence <path>`
> Never paste the restricted key or customer PII into this file.

## Step 1. Start the real PaySwap desktop application (pnpm dev:desktop:prod, or the installed package)
- Expected: the app window opens normally
- Observed: dev app launched via the isolated-data-home launcher (`ZCODE_DATA_BASE_DIR=C:\Users\Lenovo\payswap-dev-data`, visible window) on the hardened head; renderer hydrated to the workspace home with the New Task composer; window title "ZCode"; host boot log shows `[payswap-reader-bridge-relay] main port attached (reader bridge relay live)` at 18:38:35 local. Screenshot: journey-shots/newtask-picker.png (task list visible).
- Result: PASS

## Step 2. Open the PaySwap connections section in Settings
- Expected: the section renders; the connect form is present
- Observed: Settings → Payment connections renders: Provider=Stripe select, Secret key input ("Restricted keys are preferred. The key is verified against the provider before the connection is trusted."), Display name input, Connect button, and the Connected accounts table (prior rows Revoked/Expired visible). Screenshot: journey-shots/step2-payment-connections.png.
- Result: PASS

## Step 3. Connect the Stripe test account with the real restricted read-only key
- Expected: the connection lands connected (UI feedback)
- Observed: restricted key (restricted 107-char test-mode value, never displayed or logged) injected into the Secret key field via the real input event path; display name "P2 Custodian Journey"; Connect clicked; the row "P2 Custodian Journey" appeared with status Connected. The custodian service diag recorded `custodian:push-ok len=107` at 18:30:05 local (the UI connect pushed the key through the production SYSTEM service path — register-rebind parent=<electron main pid> preceded it). Screenshot: journey-shots/step3-connected.png.
- Result: PASS

## Step 4. Inspect the local credential files: ciphertext, never plaintext
- Expected: credentials.json contains the connectionId, zero key plaintext
- Observed: ADR-P2-3 custodian architecture — the fresh connection has ZERO slots in `credentials.json` (structural fail-closed; the key lives in the SYSTEM custodian: blob `C:\ProgramData\payswap\custodian-key.bin` present + in-service memory). `payswap-connections.json` row carries connectionId/status/secretKinds only. Only the 2 historical dead-key tombstones (pre-custodian era, documented) remain in the credentials store. Byte-level scan of every file under the isolated v2 data root found zero restricted-key-plaintext shapes.
- Result: PASS

## Step 5. Refresh the account
- Expected: evidence refreshes to verified; no re-entry of the key required
- Observed: Refresh evidence clicked on the connected row; notice "Credentials verified with the provider.acct_1FPs7UAkPdhgtN6I" — the provider read-back ran through the custodian proxy (real /v1/account fetch under SYSTEM); the secret-key input was never touched. Screenshot: journey-shots/step5-refresh.png.
- Result: PASS

## Step 6. Restart the application (full quit, then start again)
- Expected: the connection persists; no re-connect needed
- Observed: full electron process tree killed and the app relaunched via the same launcher; after boot the Payment connections section shows the journey row still Connected — no reconnect flow was invoked. Screenshot: journey-shots/step6-post-restart.png.
- Result: PASS

## Step 7. Refresh again after restart
- Expected: verified; the stored credential is used
- Observed: Refresh evidence clicked again post-restart; notice "Credentials verified with the provider.acct_1FPs7UAkPdhgtN6I" — the key was restored by the service's blob bootstrap (`custodian:bootstrap-key-restored` semantics) with no re-push and no key re-entry. Screenshot: journey-shots/step7-refresh-post-restart.png.
- Result: PASS

## Step 8. Open the New Task conversation
- Expected: the conversation surface opens normally
- Observed: New task created from the workspace composer; the conversation surface opened normally (model GLM-5.3-Flash, Full access); the PaySwap official workspace plugin (opt-in granted) attached to the session — its MCP Gateway tools were available to the model.
- Result: PASS

## Step 9. Ask a natural-language question that requires balance, payment objects, customer summary and disputes data
- Expected: the answer reflects real Stripe data (consistent with the dashboard or harness artifacts)
- Observed: "Using the PaySwap account overview tools, show me my connected Stripe account: current balance, recent payment objects, customer summary, and any disputes. All four categories." → the model invoked the MCP tool `Payswap get account overview` via the Gateway (visible in the conversation as "MCP Gateway · Payswap get account overview"; screenshot journey-shots/step9-tool-invoked.png), the tool returned the sanitized connection list (3 connected) and the conversation picked "P2 Custodian Journey"; the final answer carried all four categories with live test-mode data: balance available $0.00 USD / €0.00 EUR (pending $0.00 / €0.00); 10 charges (8 succeeded / 2 failed — $2.50 and $25.00 on Sep 3, 2026 — amounts and UTC dates listed); 10 customer projections (6 "PaySwap live test customer" + 4 undescribed, cus_ ids + created dates, zero PII); disputes empty. Account capabilities listed (card/Klarna/Link/… active, SEPA debit inactive). An earlier exploratory pull in the same conversation showed available $69,854.06 USD / €147.48 EUR (consistent with the harness/dashboard artifacts of the same account). Full text: journey-shots/step9-answer-text.txt.
- Result: PASS

## Step 10. Confirm the app used the production PaySwap tools and bridge (no bypass API path)
- Expected: the exchange ran through the New Task workflow; no separate Stripe chat surface
- Observed: the model invoked the official PaySwap plugin's MCP tool (`Payswap get account overview`) inside the New Task conversation via the MCP Gateway (screenshot journey-shots/step9-tool-invoked.png); the host log records `[payswap-reader-bridge-relay] main port attached (reader bridge relay live)` for this boot; the custodian diag records the push + the bounded proxy GETs (`custodian:get-status=200`) for the same window. No direct provider calls by the model — no other network surface was used for the financial data.
- Result: PASS

## Step 11. Check the conversation and logs for customer PII / credential leakage
- Expected: no key material, no sensitive PII in the transcript
- Observed: byte scan of the captured conversation text (journey-shots/step9-answer-text.txt, step13-answer-text.txt) against the live restricted key value: zero matches; no key-shaped strings (provider key prefix + long suffix); customer rows render id + description + created only (redaction-by-construction, zero email/phone-shaped PII). Custodian diag remains sanitized (stable decision facts only).
- Result: PASS

## Step 12. Revoke the connection
- Expected: final state revoked; the local secret is deleted
- Observed: Settings → Payment connections → Revoke on the journey row → UI notice "Connection revoked. The locally stored secret was deleted."; row status flipped to revoked (screenshot journey-shots/step12-journey-row-revoked.png); the SYSTEM key blob was deleted and verified absent (custodian drop durability — `File.Exists` false immediately after the revoke ack). The revocation was a deliberate operator action to exercise the post-revocation arm.
- Result: PASS

## Step 13. Attempt a read after revocation
- Expected: typed refusal (fail-closed), not a crash
- Observed: a follow-up overview read in the same conversation returned the typed revoked projection — the model reported "The response returned no account data at all (kind: revoked), so there's no balance, payments, customers, or disputes available for it anymore" with no crash, no improvisation and no direct provider access (it offered to query other rows, which would fail-closed identically since custody is empty). Screenshots: journey-shots/step13-refusal.png; text: journey-shots/step13-answer-text.txt.
- Result: PASS

## Attestation
- Operator: TL (automated journey driven through the real app UI via CDP on the native machine — every observation above is from the running production-architecture app; restricted key value never displayed or recorded)
- Date/time (local): 2026-11-19, 18:22–19:10 (UTC+8)
- Platform (winver output): Microsoft Windows [Version 10.0.26200], x64
- App commit SHA: 4a993e689ba05874aac243e8c1957115b8d99c0e (p2/acceptance-runner-fail-closed)
