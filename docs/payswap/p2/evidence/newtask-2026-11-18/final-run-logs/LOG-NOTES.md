# Sanitized stage-log excerpt note
windows-build.log.tail200 and windows-desktop-e2e.log.tail300 are the verdict-bearing tails of the full build/e2e logs (full copies remain in artifacts/p2-acceptance/2026-11-18T20-12-16-275Z/, git-ignored).
The desktop-e2e log contains the e2e spec's PUBLIC format-valid fixture key (sk_test_e5f6a7b8… from payswap-connection-ui.test.ts) — a committed fixture, not a secret.
