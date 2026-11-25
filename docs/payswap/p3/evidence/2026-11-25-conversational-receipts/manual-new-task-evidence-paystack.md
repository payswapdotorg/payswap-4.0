# P2 conversation-acceptance — manual New Task evidence

> **P3 receipt instance — provider: Paystack (test mode)** (the canonical checklist is provider-neutral;
> this instance records the Paystack journey per the roadmap P3 row: the 13-step
> conversational receipt for the new providers). Connect the Paystack test-mode secret key through the
> connection UI (operator-supplied secret; never paste it anywhere else). Where a
> step names Stripe, perform the same action with Paystack and record what
> you actually observed. Never write the key/secret itself or credential prefixes
> like sk_/rk_ into this file.

> **Walk record (honesty note):** this instance was walked on the operator's machine at the
> operator's delegated instruction ("you can do the 13-step conversational receipt"). Every
> Observed line below is a real output captured from the running production application
> (this checkout launched in production mode), its real DOM/notices, its real
> store files, and the live SYSTEM custodian's decision log. Screenshots are in
> `artifacts/p3-receipt/` (step1-app-window.png … step13-post-revoke-refusal.png). Nothing is
> paraphrased from an expectation; the one deviation from the happy path (the plugin needed
> install/enable before the tools mounted, recorded under Step 8) is recorded as observed.

## Step 1. Start the real PaySwap desktop application (pnpm dev:desktop:prod, or the installed package)
- Expected: the app window opens normally
- Observed: the dev-production checkout app (ZCode Dev profile) launched and opened to the workspace after operator OAuth login; task list, composer and sidebar rendered normally (screenshot step1-after-login.png).
- Result: PASS

## Step 2. Open the PaySwap connections section in Settings
- Expected: the section renders; the connect form is present
- Observed: Settings → "Payment connections" opened via the settings UI; the connect form rendered with the Provider picker (Paystack selectable), Secret key field, display name field and Connect button (screenshot step2-payswap-connections-section.png).
- Result: PASS

## Step 3. Connect the Stripe test account with the real restricted read-only key
- Expected: the connection lands connected (UI feedback)
- Observed: performed with the Paystack test-mode secret key per this instance's provider: provider picker → Paystack, operator test key pasted into the Secret key field, Connect clicked; the UI answered the positive notice "Account connected." and a row appeared with status Connected, mode Test (screenshot step3-paystack-connected.png). Zero network at connect (store write only — the credential landed in the SYSTEM custodian, see Step 4).
- Result: PASS

## Step 4. Inspect the local credential files: ciphertext, never plaintext
- Expected: credentials.json contains the connectionId, zero key plaintext
- Observed: connections store (~/.zcode/v2/payswap-connections.json) contains the record (paystack/test/connected, id a359e321…) with ZERO key plaintext; credentials.json carries NO slot for this connection at all (custodian path — custody holds it); the SYSTEM custodian's decision log records a successful named-slot push for this connection's api-key (48-byte secret, blob SYSTEM-DPAPI wrapped; ACL denies user read — verified by the isolation probe earlier the same day).
- Result: PASS

## Step 5. Refresh the account
- Expected: evidence refreshes to verified; no re-entry of the key required
- Observed: "Refresh evidence" clicked on the real row; the UI answered the positive notice "Credentials verified with the provider." — verified against the real Paystack API with no account identifier displayed (the typed identity-gap presentation: the provider authenticated the credential; no id is fabricated) — row stayed connected (screenshot step5-refresh-notice.png).
- Result: PASS

## Step 6. Restart the application (full quit, then start again)
- Expected: the connection persists; no re-connect needed
- Observed: the app process tree was fully killed and relaunched; after login the connections section listed the same row a359e321… with status Connected — persisted, no re-connect performed.
- Result: PASS

## Step 7. Refresh again after restart
- Expected: verified; the stored credential is used
- Observed: refresh clicked again → "Credentials verified with the provider." (verified) with the row still Connected — the stored custodian-held credential was used, no re-entry (screenshot step7-refresh-after-restart.png).
- Result: PASS

## Step 8. Open the New Task conversation
- Expected: the conversation surface opens normally
- Observed: New Task opened in the workspace. First attempt honestly recorded a setup gap: the PaySwap plugin was present in Settings→Plugins but not yet installed/enabled in this fresh dev profile (its gateway server was not running and the agent reported no payswap tools), even though the Financial-workspace opt-in was saved (options.financialWorkspace=true in the CLI config) — the enable flag itself was missing from enabledPlugins and was completed during the walk. After install+enable (gateway server visible in the host process list: payswap/0.1.0/dist/server.mjs) and a fresh task, the conversation surface ran normally with the payswap tools available.
- Result: PASS

## Step 9. Ask a natural-language question that requires balance, payment objects, customer summary and disputes data
- Expected: the answer reflects real Stripe data (consistent with the dashboard or harness artifacts)
- Observed: the natural-language question was answered by the model (z-ai/glm-5.3-flash) calling the account-overview tool through the production path; the answer carried REAL Paystack test data: Balance Available GHS 200 / pending none; 6 payment transactions (real ids <txn-id>, amounts in minor units, abandoned status); 6 customers as redacted projections only (CUS_* id + created, description null — PII never left the adapter); Disputes reported unavailable exactly as the tool states ("official records carry no top-level amount/currency/reason fields… not zero — simply not readable"); Capabilities unknown via the typed refusal code capability_evidence_not_exposed with its full operator-readable message ("Paystack's documented API exposes no capability read-back surface (official API reference checked 2026-11-24). Account capabilities are unknown — do not infer them from balances, transactions or customers."). Screenshots final-answer.png / task5-final.png; the model summary reads "balance and the payment/customer lists came back with real data (test mode); disputes are unavailable (not zero — simply not readable), and capabilities are unknown".
- Result: PASS

## Step 10. Confirm the app used the production PaySwap tools and bridge (no bypass API path)
- Expected: the exchange ran through the New Task workflow; no separate Stripe chat surface
- Observed: the exchange ran inside the New Task conversation only; the model's tool call went plugin MCP gateway (stdio) → broker → host account service → provider adapters (the same path proven by the runner's conversational harness earlier the same day); no separate chat surface, no direct provider call from the model surface; the answer's data shape matches the tool's typed detail law exactly (evidence XOR capabilityRefusal; per-category statuses).
- Result: PASS

## Step 11. Check the conversation and logs for customer PII / credential leakage
- Expected: no key material, no sensitive PII in the transcript
- Observed: programmatic scan of the entire conversation DOM text: zero occurrences of the operator key; app logs (all launch sessions) and the data-dir logs: zero key material; customer rows in the answer carry only id+created (redaction-by-construction held on the live surface); disputes/capability messages carry no credential or PII material.
- Result: PASS

## Step 12. Revoke the connection
- Expected: final state revoked; the local secret is deleted
- Observed: Revoke clicked on the real row → notice "Connection revoked. The locally stored secret was deleted." (muted), row status Revoked; the SYSTEM custodian's log records the verified drop of this connection's named slot and the connection's named-slot blob is verifiably absent from disk afterwards (derived path checked; exists=false).
- Result: PASS

## Step 13. Attempt a read after revocation
- Expected: typed refusal (fail-closed), not a crash
- Observed: refresh attempted on the revoked row → the UI answers the terminal revoked notice again (muted, fail-closed terminal state), no crash, and the custodian log shows no new get/push after the drop (zero provider touch on the revoked path) (screenshot step13-post-revoke-refusal.png).
- Result: PASS

## Attestation
- Operator: Lenovo (account owner) — walk executed by the TL agent on the operator's machine at the operator's delegated instruction; all observations captured programmatically from the real application, its stores and the live custodian service (see the honesty note above)
- Date/time (local): 2026-11-25 16:34 – 17:58 (local machine clock)
- Platform (winver output): 10.0.26200 Build 26200
- App commit SHA: 5e48a4621772272769cafc27cc296868bd48489b
