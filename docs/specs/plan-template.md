# PLAN.md template

**What this is:** the reusable shape for any autonomous-run PLAN.md. multiclaude ships this as
the "New autonomous project" scaffold (spec R12).

**Why it matters more than the tooling:** the supervisor loop is trivial. The PLAN.md is where
all the leverage is. A good plan makes an unattended run boring; a vague one makes it dangerous.

---

## Authoring rules

**Every step must have an executable verify.** This is the single non-negotiable rule.

| ❌ Not a verify | ✅ A verify |
|---|---|
| "Auth works" | `npx vitest run test/auth.test.ts` → PASS |
| "Endpoint is functional" | `curl -s localhost:8787/api/health` returns `{"status":"healthy"}` |
| "Migration applied" | `npm run d1:migrate:local` prints "1 migration applied" |
| "UI renders" | `npm run build` exits 0 and `dist/index.html` exists |

If you cannot write a command whose exit code or output tells you unambiguously pass/fail, the
step is too vague. Split it or sharpen it.

**Other rules:**

- One step = one commit. If it needs two commits, it's two steps.
- Three files max per step. More than that and a retry has too much surface to get wrong.
- **No paths outside the repo root** unless you have explicitly granted access via `--add-dir`.
  This was the exact thing that blocked the 2026-07-13 run. multiclaude's pre-flight will warn
  you, but the plan should not need the warning.
- State invariants once at the top. Every step inherits them.
- End with an explicit STOP boundary naming what would come next and *why the run must not do it*.
- Keep the plan reviewable at a glance. If a step needs a lot of code detail, put the detail in a
  separate design doc and reference it: `(detailed plan, Task 4)`.

---

## Template — copy from here

```markdown
# <Project> — PLAN.md (<Phase name and scope>)

Autonomous-run plan. Each step is one small, commit-able chunk that ends in a verifiable
check. Do **one step per turn**, commit, append a timestamped line to `PROGRESS.md`.
Stop after Step <N>.

**Invariants (apply to every step):** <language / package manager / test runner /
type-safety rules / naming conventions / success + error envelope shapes / branch policy /
anything that must never be violated>.

---

1. **<Short imperative title>.** <One or two sentences of what to build. Name the files.>
   **Verify:** <exact command> → <exact expected result>.
   **Commit:** `<conventional commit message>`.

2. **<Short imperative title>.** <...>
   **Verify:** <exact command> → <exact expected result>.
   **Commit:** `<conventional commit message>`.

<... 8-15 steps total ...>

N. **Green capstone.** Add `docs/<phase>-status.md` summarising what this phase delivers.
   **Verify:** full local gate green — <every check command chained with &&> all exit 0.
   **Commit:** `docs: <phase> complete`.
   **Then:** create empty file `DONE` at repo root and stop.

---

## STOP HERE — <next phase> boundary

Do **not** proceed past Step N autonomously. The next work (<name it>) requires <name the
exact thing: a secret not in .env / an account mutation / a paid API call / a production
deploy / a decision only a human can make>. When all N steps are done, create the empty
`DONE` file and stop.
```

---

## Worked example — a good step

From the Foundry Clarion Phase 0-1 plan. Note: names the files, names the test, names the
expected assertions, names the commit message.

```markdown
5. **Role resolution & guard.** Create `server/lib/auth.ts` — `resolveClarionRole(db, claims)`
   (returns stored role; bootstraps an org `owner`/`admin` with no row to Clarion `admin`;
   else `null`) and `requireClarionRole(min)` middleware; add `test/auth.test.ts`.
   **Verify:** `npx vitest run test/auth.test.ts` → PASS (stored-role, owner-bootstrap,
   member-null cases).
   **Commit:** `feat: Clarion role resolution + requireClarionRole guard`.
```

---

## Worked example — a bad step, and why

```markdown
3. **Set up authentication.**
   **Verify:** auth is working.
   **Commit:** `feat: auth`.
```

Three failures: no files named, so Claude invents its own structure and the next step's
assumptions break. No executable verify, so "done" is a judgement call — exactly what you cannot
afford at 3am. Scope is unbounded, so it could be one commit or fifteen, and a retry after a
usage-limit reset has no idea where it got to.

---

## The companion PROGRESS.md

Seed it before launch (multiclaude's pre-flight will offer to do this). Minimum viable:

```markdown
# <Project> — PROGRESS.md

Handoff log for the autonomous run. See `PLAN.md` for the steps.

## Status

No steps completed yet. Next: **Step 1 — <title>.**

## Log

<!-- Append one line per completed step:
- 2026-07-14T09:00Z — Step 1 done: scaffold + npm install (exit 0). commit abc1234
-->

## Blockers

<!-- If the plan is ambiguous or a step can't be verified, write the question here,
     then create DONE and stop. -->
```
