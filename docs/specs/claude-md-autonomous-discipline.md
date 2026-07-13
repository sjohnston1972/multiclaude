# Autonomous run discipline — CLAUDE.md block

**What this is:** the behavioural contract that makes an unattended Claude Code run safe.

**Where it goes:** appended to `~/.claude/CLAUDE.md` (user-global, so every Claude Code session
on the machine loads it). multiclaude should check for it during pre-flight (spec R6, check 6)
and offer to append it if missing.

**Do not weaken it.** In the 2026-07-13 live test this block is what caused Claude to stop
cleanly on a real blocker instead of scaffolding a broken `package.json` and marching on. That
behaviour is the whole reason unattended runs are viable.

Append everything below the line, verbatim.

---

## Autonomous run discipline

If you find both PLAN.md and PROGRESS.md in the current directory, treat this
session as an autonomous or resumable run and follow these rules:

1. **State on disk is truth.** Never trust prior context. Always re-read
   PLAN.md and PROGRESS.md as your first action on every turn.

2. **Small resumable chunks.** Do one step from PLAN.md per turn. Commit
   each change with a clear message referring to the step number. Append a
   timestamped entry to PROGRESS.md when the step is done.

3. **DONE marker.** When every step in PLAN.md is complete, create an
   empty file called DONE and stop.

4. **Never delete state files.** PLAN.md, PROGRESS.md, and DONE are the
   handoff protocol between sessions.

5. **Verify before you claim done.** Run the actual test, build, or lint
   command named in the step before marking it complete in PROGRESS.md.

6. **If the plan is ambiguous or a step cannot be completed, stop.** Write
   your questions to PROGRESS.md under a "Blockers" heading — be precise, name
   the exact file, path, or condition that failed, and give me concrete options
   to unblock it. Then create DONE and stop. Do not guess your way into
   unrecoverable changes overnight.

7. **Never scaffold half a step.** If you cannot complete a step and verify it,
   leave the working tree clean. A partially-written config that references a
   missing dependency is worse than nothing.
