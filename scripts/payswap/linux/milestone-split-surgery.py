#!/usr/bin/env python3
"""P2 → P2-Linux + P2-Windows milestone decomposition (roadmap surgery).

Keeps the shared engineering history on the P2-Linux row (the E2B live evidence
is Linux/gnome_libsecret), adds a concise P2-Windows row pointing at it, splits
the milestone definition section, updates the reconciliation line, and rewrites
the validator + test fixture milestone list.
"""
import io
import re
import sys

REPO = "/home/z/my-project/repo"
ROADMAP = f"{REPO}/docs/payswap/p0/10-roadmap.md"
VALIDATOR = f"{REPO}/scripts/payswap/validate-roadmap.mjs"
VALIDATOR_TEST = f"{REPO}/scripts/payswap/validate-roadmap.test.mjs"
PLAYBOOK = f"{REPO}/docs/payswap/IMPLEMENTATION-PLAYBOOK.md"


def read(path):
    with io.open(path, encoding="utf-8") as fh:
        return fh.read()


def write(path, text):
    with io.open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


roadmap = read(ROADMAP)
lines = roadmap.split("\n")

# ---------------------------------------------------------------------------
# 1) Register row block (P2 row = the physical block from the "| P2 —" line to
#    the line ending with " |" that closes the cell).
# ---------------------------------------------------------------------------
start = next(i for i, l in enumerate(lines) if l.startswith("| P2 — Stripe read-only vertical |"))
end = start
while not lines[end].rstrip().endswith("|") or end == start:
    end += 1
    if lines[end].rstrip().endswith(" |") and end > start:
        break
p2_block = lines[start : end + 1]
assert p2_block[0].startswith("| P2 — Stripe read-only vertical | in_progress |"), p2_block[0][:80]
assert p2_block[-1].rstrip().endswith("|"), p2_block[-1][-60:]

old_body = p2_block[0][len("| P2 — Stripe read-only vertical | in_progress |"):]
old_continuation = p2_block[1:]

decomposition_note = (
    "  **里程碑分解（2026-11-17，TL 裁决）：** P2 按验收平台分解为 P2-Linux 与\n"
    "  P2-Windows 两个独立可关闭的里程碑（validator 法则同步更新 ——\n"
    "  scripts/payswap/validate-roadmap.mjs REQUIRED_MILESTONES）。两腿共享同一\n"
    "  工程法则面与全部历史证据：Gate E2 键仓（本行登记的 RED→GREEN 全量）、\n"
    "  单写者账户服务、reader bridge、只读工具面闭集与 typed 拒绝法则、上述 E2B\n"
    "  Linux live 实证工具链（`scripts/payswap/live/`）—— **本行的历史段落对两腿\n"
    "  同等有效**。分立的是验收执行面：Linux 腿（本行）= 真实 Linux 桌面\n"
    "  （Xvfb/D-Bus/gnome-keyring 腿 recipe 或原生桌面会话）上的五分类验收\n"
    "  （linux-build / linux-secure-storage / linux-desktop-e2e / stripe-live /\n"
    "  conversation-acceptance —— runner `scripts/payswap/linux/run-p2-acceptance.cjs`\n"
    "  （2026-11-17 交付：腿栈统一解析 + 显示腿包装器 + 五分类 runner + 14 例回归\n"
    "  矩阵 + preflight Linux 阶段裁决；TL Linux 沙箱实测 linux-build /\n"
    "  linux-secure-storage（真 Electron gnome_libsecret 探针 + 13 套件 129/129 +\n"
    "  平台门 12/12）/ linux-desktop-e2e（connection-ui 7/7，首过率 100%）三阶段\n"
    "  PASS，消毒工件 + SHA-256 manifest 落 artifacts/p2-acceptance-linux/）；\n"
    "  2026-11-14 的 E2B 实证即本腿在 gnome_libsecret 后端上的既有证据）；Windows 腿\n"
    "  = DPAPI 面的原生 Windows 五分类验收（见 P2-Windows 行）。**P2-Linux 可独立\n"
    "  关闭**：关闭条件 = 五分类全 PASS（RESULT_E2E=0、RESULT_HARNESS=0 —— 四类别\n"
    "  真数据落地）+ 13 步交互回执严格校验通过 + 消毒工件与 SHA-256 清单登记；若\n"
    "  Stripe 账户激活/键供给仍卡在用户控制步，该边界如实登记、不冒充完成（2026-11-17\n"
    "  现状：stripe-live / conversation-acceptance 诚实 SKIP —— 键须在验收机本地经\n"
    "  0600 env 文件供给，账户 onboarding 身份段未完成）。 |"
)

p2_linux_block = ["| P2-Linux — Stripe read-only vertical (Linux desktop closure) | in_progress |" + old_body]
p2_linux_block += old_continuation[:-1]  # keep continuation lines, drop the final closing line
p2_linux_block[-1] = p2_linux_block[-1]  # untouched
# The last continuation line previously ended with " |" and closed the row; the
# decomposition note now closes it instead.
if p2_linux_block and p2_linux_block[-1].rstrip().endswith("|"):
    p2_linux_block[-1] = p2_linux_block[-1].rstrip()
    if p2_linux_block[-1].endswith("|"):
        p2_linux_block[-1] = p2_linux_block[-1][:-1].rstrip()
p2_linux_block += decomposition_note.split("\n")

p2_windows_block = [
    "| P2-Windows — Stripe read-only vertical (native Windows closure) | in_progress |",
    "  承接 P2 的原生 Windows 验收面。**与 P2-Linux 共享全部工程法则与历史证据**",
    "  （共享史见 P2-Linux 行：Gate E2 键仓 RED→GREEN、单写者账户服务 + reader",
    "  bridge、E2B Linux live 实证工具链 —— 两腿同一法则，本行不重复登记）。2026-11-17",
    "  环境就绪审计：TL Linux 沙箱对原生 Windows 验收**结构性 BLOCKED**（无 Windows",
    "  内核/桌面/DPAPI）；harness 平台缺陷已修复（win32 永不触碰 Linux-only",
    "  `getSelectedStorageBackend`）；交付原生 Windows 五分类验收 runner",
    "  （`scripts/payswap/windows/run-p2-acceptance.cjs`：windows-build /",
    "  windows-secure-storage / windows-desktop-e2e / stripe-live /",
    "  conversation-acceptance；SKIP 永不转绿）+ Windows preflight + 执行手册",
    "  （`docs/payswap/p2/ENVIRONMENT-READINESS-HANDOFF.md`）。独立评审三缺陷",
    "  （跨 chunk 消毒 / 回执严格校验 / preflight 失败关闭）已修复（消毒库",
    "  `scripts/payswap/windows/runner-redaction.cjs` + 两腿共享裁决法则",
    "  `scripts/payswap/acceptance-verdicts.cjs`，回归矩阵挂 CI）。**剩余执行面 = 一台原生 Windows",
    "  交互桌面机 + 真实受限只读键 + 已激活账户**（stripe-live 语义与 P2-Linux 行",
    "  同一条款）；关闭条件 = 五分类全 PASS（RESULT_E2E=0、RESULT_HARNESS=0）+ 13",
    "  步回执严格校验 + 消毒工件登记；E2B/WSL2/Linux 结果不得冒充 Windows 验收。 |",
]

lines[start : end + 1] = p2_linux_block + p2_windows_block
roadmap = "\n".join(lines)

# ---------------------------------------------------------------------------
# 2) Milestone definition section split.
# ---------------------------------------------------------------------------
old_section = """### P2 — Stripe read-only account connection and capability discovery (the vertical)
**Scope:** real Stripe authorization (API key / OAuth per deliverable 04), the
account service + credential storage upgrade (**Gate E2**, addendum §5.2 —
per-platform: desktop safeStorage, server secret-manager `ZCODE_CREDENTIAL_SECRET`,
fail-closed when neither is available; the deterministic fallback is never used for
`payswap:psp:*` keys), evidence-backed capability discovery, read-only operations
in conversation.
**Acceptance:** a real Stripe account connects via the platform shell with
credentials landing ONLY in the upgraded store — **Gate E2 acceptance:** connection
with only the fallback available refuses (typed error, E2E); at rest no PSP secret
is decryptable under the fallback-derived key; non-PSP `ICredentialService`
behavior unchanged; capabilities are answered from provider read-back evidence with
typed refusals where unconfigured; read-only ops (balances, payment objects,
customers, disputes…) run conversationally; NO write operation exists in the tool
surface yet; browser-verified connection/onboarding flow; battery green.
"""
assert old_section in roadmap, "P2 milestone section not found verbatim"

new_sections = """### P2-Linux — Stripe read-only account connection and capability discovery (the vertical, Linux desktop closure)
**Scope:** the Linux closure of the vertical: real Stripe authorization (API key /
OAuth per deliverable 04), the account service + credential storage upgrade
(**Gate E2**, addendum §5.2 — per-platform: desktop safeStorage with the Linux
secure-backend closed set [gnome_libsecret / kwallet family — basic_text and
unknown fail closed, no weak-backend fallback], server secret-manager
`ZCODE_CREDENTIAL_SECRET`, fail-closed when neither is available; the deterministic
fallback is never used for `payswap:psp:*` keys), evidence-backed capability
discovery, read-only operations in conversation — executed on a real Linux desktop
acceptance environment (Xvfb + D-Bus + gnome-keyring Secret Service leg recipe or a
native Linux desktop session; a bare headless shell is not an acceptance
environment).
**Acceptance:** a real Stripe account connects via the platform shell on Linux with
credentials landing ONLY in the upgraded store and a secure OS keychain backend
selected — **Gate E2 acceptance:** connection with only the fallback available
refuses (typed error, E2E); at rest no PSP secret is decryptable under the
fallback-derived key; non-PSP `ICredentialService` behavior unchanged; capabilities
are answered from provider read-back evidence with typed refusals where
unconfigured; the four read-only categories (balance, payment objects, customers
privacy-safe summary, disputes) return real data conversationally through the
production path (official PaySwap plugin/MCP → authenticated broker → single-writer
account service → Stripe adapter — no bypass chat surface, no second credential
store, no raw-key exposure to the model); secure-storage laws proven in a REAL
Electron runtime, never mocks: encryption available, ciphertext at rest, restart
persistence, corrupted-backend fail-closed, revocation deletes the key; NO write
operation exists in the tool surface; browser-verified connection/onboarding flow;
battery green. Closure = the five Linux acceptance stages
(linux-build, linux-secure-storage, linux-desktop-e2e, stripe-live with
RESULT_E2E=0 and RESULT_HARNESS=0, conversation-acceptance with the 13-step manual
receipt validated) all green on the exact head with sanitized artifacts and a
SHA-256 manifest.

### P2-Windows — Stripe read-only account connection and capability discovery (the vertical, native Windows closure)
**Scope:** the same vertical under the same laws on native Windows: DPAPI-backed
safeStorage (the `isEncryptionAvailable` gate — win32 has no backend-name API and
none is invented), executed by the native-Windows acceptance runner on an
interactive desktop session (RDP/console — session-0/service contexts are not
acceptance environments); an E2B/WSL2/Linux result can never substitute.
**Acceptance:** identical to P2-Linux with the platform substitutions — the
DPAPI round-trip proven in a real Electron runtime (isEncryptionAvailable=false on
Windows is an abnormal state: recorded FAIL and investigated, never bypassed); the
five-category native-Windows runner (windows-build, windows-secure-storage,
windows-desktop-e2e, stripe-live, conversation-acceptance) all green with
leak-scan-clean sanitized artifacts (SHA-256 manifest; a credential leak
invalidates the phase and the leaked bytes are never retained) and the 13-step
manual New Task evidence validated by the strict receipt contract (all PASS,
non-empty observations, no missing/duplicate/unknown steps); the four read-only
categories return real data conversationally through the same production path with
RESULT_E2E=0 and RESULT_HARNESS=0; NO write operation exists in the tool surface;
battery green.
"""
roadmap = roadmap.replace(old_section, new_sections)

# ---------------------------------------------------------------------------
# 3) Reconciliation line.
# ---------------------------------------------------------------------------
old_reconciled = roadmap[roadmap.index("**Last reconciled:** 2026-11-15") :]
old_reconciled = old_reconciled[: old_reconciled.index("\n")]
new_reconciled = (
    "**Last reconciled:** 2026-11-17 (P2 decomposed into P2-Linux and P2-Windows — two "
    "independently closable milestones sharing one engineering law and the full history "
    "registered on the P2-Linux row; the environment-readiness audit and the three "
    "independent-review tooling fixes landed on PR #46; the Linux acceptance "
    "environment + five-stage runner delivered and green on its independently-executable "
    "half — linux-build / linux-secure-storage / linux-desktop-e2e PASS on the TL Linux "
    "leg; the remaining stripe-live / conversation-acceptance stages are gated on the "
    "restricted read-only key supply + account onboarding completion, both "
    "operator-controlled, honestly registered as SKIP; the Windows execution face runs "
    "on the native Windows machine per the handoff; P3 stays in_progress behind P2). "
    "The TL must update this register from actual merged Git state and CI evidence; "
    "never infer completion from a report or an unmerged branch."
)
roadmap = roadmap.replace(old_reconciled, new_reconciled)

write(ROADMAP, roadmap)

# ---------------------------------------------------------------------------
# 4) Validator + test fixture + playbook bullet.
# ---------------------------------------------------------------------------
validator = read(VALIDATOR)
validator = validator.replace(
    'const REQUIRED_MILESTONES = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"];',
    "// P2 is decomposed (2026-11-17 TL ruling): P2-Linux and P2-Windows are two\n"
    "// independently closable milestones sharing one engineering law; both must exist.\n"
    'const REQUIRED_MILESTONES = ["P1", "P2-Linux", "P2-Windows", "P3", "P4", "P5", "P6", "P7", "P8", "P9"];',
)
write(VALIDATOR, validator)

test = read(VALIDATOR_TEST)
test = test.replace(
    'const milestones = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"];',
    'const milestones = ["P1", "P2-Linux", "P2-Windows", "P3", "P4", "P5", "P6", "P7", "P8", "P9"];',
)
test = test.replace(
    'assert.ok(issues.some((issue) => issue.includes("exactly one P9 milestone heading")));',
    'assert.ok(issues.some((issue) => issue.includes("exactly one P9 milestone heading")));',
)
write(VALIDATOR_TEST, test)

playbook = read(PLAYBOOK)
old_bullet = "- **P2 — Stripe read-only vertical:** write Gate E2 tests first (fallback-derived PSP key refused; secure desktop/server storage required; stored secret cannot be decrypted with the old deterministic fallback). Then test real Stripe connection/onboarding in test mode, account read-back, evidence-backed capabilities and read-only operations. Assert that no write tool/operation is registered."
new_bullet = (
    "- **P2-Linux / P2-Windows — Stripe read-only vertical (platform-split closures):** "
    "write Gate E2 tests first (fallback-derived PSP key refused; secure desktop/server "
    "storage required — Linux secure-backend closed set, Windows DPAPI; stored secret "
    "cannot be decrypted with the old deterministic fallback). Then test real Stripe "
    "connection/onboarding in test mode, account read-back, evidence-backed capabilities "
    "and read-only operations on the target platform's real desktop acceptance "
    "environment (Linux: Xvfb/D-Bus/gnome-keyring leg; Windows: interactive RDP/console "
    "session). Assert that no write tool/operation is registered. The two closures are "
    "independent; neither platform's result substitutes for the other's."
)
assert old_bullet in playbook
playbook = playbook.replace(old_bullet, new_bullet)
write(PLAYBOOK, playbook)

print("roadmap surgery complete")
