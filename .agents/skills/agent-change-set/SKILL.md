---
name: agent-change-set
description: Use when a task prompt mentions a change set, change-set, relay run or executor-mode, or asks to apply TL-authored files mechanically. Applies hash-pinned change sets with scripts/apply-change-set.mjs so a low-capability executor model never authors, retypes or reformats content.
---

# Agent change set (low-capability executor mode)

A change set turns a coding task into a byte-exact file transfer. The technical lead (TL) authors
every file, the manifest pins each file with a SHA-256, and `scripts/apply-change-set.mjs` does the
rest: precondition checks, an all-or-nothing write, a byte re-check and an exact commit. The executor
model contributes no content and no judgement, so a cheaper or weaker model cannot lower the quality
of what lands in the repository.

Why it exists (P4 wave 6 relay run): an executor that was asked to apply a specification wrote its
own test battery, re-flowed a normative law block, replaced module law comments, edited a test after
the RED commit, and bypassed a host block instead of stopping. Each of those failures needs a verb
the executor does not have in this mode: there is only `apply`, `run` and `report`.

## Change-set layout

```
<change-set-dir>/                 # must live OUTSIDE the repository worktree
  files/<repo-relative/path>      # complete final files, exactly as they must exist in the repo
  manifest.json                   # written by `pack`; never edited by hand
```

`manifest.json`:

| Field       | Meaning                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `schema`    | `1`                                                                                           |
| `name`      | Short id `[A-Za-z0-9_.-]{1,64}`, echoed in the receipt                                         |
| `base`      | Full commit sha the TL authored against; it must be an ancestor of `HEAD`                      |
| `files[]`   | `path` (repo-relative, forward slashes), `before` (sha256 of the base content, `null` = new), `after` (sha256 the written bytes must have) |
| `commit`    | Optional: `subject`, `body`, `trailers[]`; when present the tool stages exactly the listed files and commits |

The tool enforces: text only (UTF-8, no NUL byte), BOM stripped, CRLF/CR folded to LF, exactly one
trailing newline, a clean worktree, every target still equal to its base content, paths that stay
inside the repository, and a change-set directory outside the worktree. Not supported: deletions,
renames, file modes, binary files.

## Commands (from the repository root)

```bash
node scripts/apply-change-set.mjs pack <change-set-dir> --base <commit> --name <id> [--subject <s>] [--body <b>] [--trailer <t>]
node scripts/apply-change-set.mjs apply <change-set-dir>
```

`pack` runs once per change set and refuses to overwrite an existing `manifest.json`. `apply` prints
a receipt whose last line starts with `next`. Every failure prints one or more lines that start with
`STOP: ` and exits with code 1.

## Executor protocol (binding)

1. You never author, retype, reformat, translate, "improve" or comment any file content, test, doc,
   commit subject or PR text. If something is missing from the change set, that is a STOP.
2. Run only the commands of the run sheet, one command per block, in the given order.
3. Any `STOP:` line, failed gate, unexpected value or host block means stop. Paste the verbatim
   output. Never fix, never retry with a different invocation, never bypass a hook.
4. Never force-push, amend, rebase, reset, stash, open pull requests or call the GitHub API unless
   the run sheet names that exact command.
5. Your final answer is the tool receipt plus the requested verbatim command output. Nothing else.

## Run-sheet template (the TL fills every `<angle-bracket>` field)

```
executor-mode: change set      protocol: .agents/skills/agent-change-set/SKILL.md
Clone: <path>   Branch: <name> (created from <commit>)
Change sets, in order:
  1. node scripts/apply-change-set.mjs apply <dir>
     gates: <one command per line>      expected: <exact values>
  2. ...
Finish: <the single push command>
Report: the receipt of every apply and the verbatim output of every gate command.
```

## TL checklist before handing a change set to an executor

- Every file is the complete final file: no anchors, no diffs, no "insert after line N".
- Files are UTF-8, LF, no BOM; `pack` ran against the pinned base commit.
- RED and GREEN are separate change sets, and the run sheet names the exact failing and passing
  counts (a row that already passes at the base is a regression pin, not RED evidence).
- Every gate has an expected value, and every expected value was read from the repository.
- Gate commands are single commands without `.ps1` helper files (hosts may block script files).
- The change-set directory lives outside the clone, and the executor model is told the protocol
  applies for the whole session.
