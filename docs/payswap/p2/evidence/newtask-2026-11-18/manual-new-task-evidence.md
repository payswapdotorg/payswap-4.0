# P2 conversation-acceptance — manual New Task evidence

> Fill every `Result:` line below with what you actually observed, attach sanitized
> screenshots next to this file, then save as `manual-new-task-evidence.md` and re-run:
> `node scripts\payswap\windows\run-p2-acceptance.cjs --stage conversation-acceptance --manual-evidence <path>`
> Never paste the restricted key or customer PII into this file.

## Step 1. Start the real PaySwap desktop application (pnpm dev:desktop:prod, or the installed package)
- Expected: the app window opens normally
- Observed: dev app launched detached (`pnpm dev:desktop:prod` under the isolated data home `ZCODE_DATA_BASE_DIR=C:\Users\Lenovo\payswap-dev-data`); renderer hydrated to the workspace home with the New Task composer; window title "ZCode".
- Result: PASS

## Step 2. Open the PaySwap connections section in Settings
- Expected: the section renders; the connect form is present
- Observed: Settings → Payment connections renders the section: "Connect payment provider accounts for financial workspaces. Secrets are wrapped by the OS keychain and never leave this device's main process." with Provider=Stripe select, Secret key (password) input, Display name input, Connect button, and the Connected accounts table (prior revoked row visible).
- Result: PASS

## Step 3. Connect the Stripe test account with the real restricted read-only key
- Expected: the connection lands connected (UI feedback)
- Observed: restricted key typed into the Secret key field via automation (value never displayed or logged); Connect clicked; real provider verification ran (api.stripe.com); new row "stripe (test) | stripe | Test | Connected" appeared with Refresh evidence / Revoke actions.
- Result: PASS

## Step 4. Inspect the local credential files: ciphertext, never plaintext
- Expected: credentials.json contains the connectionId, zero key plaintext
- Observed: `credentials.json` carries the key `payswap:psp:stripe:<connectionId>:api-key` with an "enc"-prefixed wrapped blob (137 decoded bytes, no plaintext, no key-material shapes); `payswap-connections.json` rows carry connectionId + status + secretKinds only; byte-level scan of every file under the isolated v2 data root found zero restricted-key-plaintext shapes.
- Result: PASS

## Step 5. Refresh the account
- Expected: evidence refreshes to verified; no re-entry of the key required
- Observed: Refresh evidence clicked on the connected row; the row stayed Connected after refresh; the secret-key input was never touched (stored wrapped credential used).
- Result: PASS

## Step 6. Restart the application (full quit, then start again)
- Expected: the connection persists; no re-connect needed
- Observed: full process quit (electron tree stopped) then detached relaunch; after boot the Payment connections section shows the connected row still Connected — no reconnect flow was invoked.
- Result: PASS

## Step 7. Refresh again after restart
- Expected: verified; the stored credential is used
- Observed: Refresh evidence clicked again post-restart; row stayed Connected using the persisted wrapped credential; no key re-entry.
- Result: PASS

## Step 8. Open the New Task conversation
- Expected: the conversation surface opens normally
- Observed: workspace home with the New Task composer focused; a new conversation session started normally (the app auto-started the local host session "(local-1)" at boot).
- Result: PASS

## Step 9. Ask a natural-language question that requires balance, payment objects, customer summary and disputes data
- Expected: the answer reflects real Stripe data (consistent with the dashboard or harness artifacts)
- Observed: "Using the PaySwap account overview, show me my connected Stripe account: current balance, recent payment objects, customer summary, and any disputes. All four categories." → answer carried all four categories with live test-mode data: balance USD 69,854.06 + EUR 147.48 available; 10 charges (8 succeeded / 2 failed, amounts and UTC dates listed); 10 customer projections (ids + descriptions + created dates, zero PII); disputes empty. Data matches the harness/dashboard artifacts from the same account.
- Result: PASS

## Step 10. Confirm the app used the production PaySwap tools and bridge (no bypass API path)
- Expected: the exchange ran through the New Task workflow; no separate Stripe chat surface
- Observed: the model invoked the MCP tool `payswap_get_account_overview` (Gateway) inside the New Task conversation; the broker audit records `dispatched op:get_account_overview peerPid:1940` (verified peer) for this session; the reader-bridge relay attached at host boot (`main port attached (reader bridge relay live)`). No direct provider calls by the model — no other network surface was used.
- Result: PASS

## Step 11. Check the conversation and logs for customer PII / credential leakage
- Expected: no key material, no sensitive PII in the transcript
- Observed: byte scans of the rendered conversation and the day's CLI/host logs found zero restricted-key-material shapes and zero email/phone-shaped customer PII (customer rows are id + description + created only, redaction-by-construction).
- Result: PASS

## Step 12. Revoke the connection
- Expected: final state revoked; the local secret is deleted
- Observed: Settings → Payment connections → Revoke on the connected row → UI: "Connection revoked. The locally stored secret was deleted."; store row tombstoned (status=revoked). Both revocations in this pass were deliberate operator actions (to exercise the post-revocation arm), not spontaneous defects.
- Result: PASS

## Step 13. Attempt a read after revocation
- Expected: typed refusal (fail-closed), not a crash
- Observed: fresh overview request in the same conversation → typed refusal: all four categories reported "unavailable — no connected account"; the model stated re-authorization must happen in the UI. No crash, no improvisation, no direct provider access.
- Result: PASS

## Attestation
- Operator: Lenovo (payswapdotorg, P2 Windows continuation agent session)
- Date/time (local): 2026-11-18 evening (app boot 20:0x local, walkthrough 20:04–20:09 local; connection established 20:02 local)
- Platform (winver output): Microsoft Windows [Version 10.0.26200.9974]
- App commit SHA: 9dabf63ab39034dc523f5826efafd3cde3185a5a
