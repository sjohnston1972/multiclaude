/**
 * Standard PLAN.md / PROGRESS.md templates (R12), shared by the launch seeding
 * (Step 15) and the scaffold action (Step 18). The PLAN.md shape mirrors
 * docs/specs/plan-template.md — the leverage is in the plan, not the tooling.
 */

export const PROGRESS_HEADER = `# PROGRESS.md

Handoff log for the autonomous run. See PLAN.md for the steps.

## Status

No steps completed yet.

## Log

<!-- Append one line per completed step:
- <timestamp> — Step 1 done: <what> (verify passed). commit <sha>
-->

## Blockers

<!-- If the plan is ambiguous or a step can't be verified, write the question here,
     then create DONE and stop. -->
`;

export const PLAN_TEMPLATE = `# <Project> — PLAN.md (<phase name and scope>)

Autonomous-run plan. Each step is one small, commit-able chunk that ends in a verifiable
check. Do **one step per turn**, commit, append a timestamped line to PROGRESS.md.

**Invariants (apply to every step):** <language / package manager / test runner /
success + error envelope shapes / branch policy / anything that must never be violated>.

---

1. **<Short imperative title>.** <One or two sentences of what to build. Name the files.>
   **Verify:** <exact command> → <exact expected result>.
   **Commit:** \`<conventional commit message>\`.

2. **<Short imperative title>.** <...>
   **Verify:** <exact command> → <exact expected result>.
   **Commit:** \`<conventional commit message>\`.

<... 8-15 steps total ...>

N. **Green capstone.** Summarise what this phase delivers.
   **Verify:** full local gate green — <every check command chained with &&> all exit 0.
   **Commit:** \`docs: <phase> complete\`.
   **Then:** create the empty file \`DONE\` at repo root and stop.

---

## STOP HERE — <next phase> boundary

Do **not** proceed past Step N autonomously. The next work (<name it>) requires
<the exact thing: a secret not in .env / an account mutation / a paid API call /
a production deploy / a decision only a human can make>.
`;
