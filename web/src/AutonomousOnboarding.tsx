import { Modal } from "./components";

/**
 * R11 first-run onboarding. Explains the pattern once; dismissable and re-openable
 * from the help icon in the launcher. "Seen" is stored in localStorage.
 */

const SEEN_KEY = "multiclaude.autonomous.onboarded";

export function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* private mode — just show it again next time */
  }
}

export default function AutonomousOnboarding({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Autonomous runs — how this works" onClose={onClose} wide>
      <div className="space-y-3 text-sm text-neutral-300">
        <p>
          An <span className="font-semibold text-neutral-100">Autonomous run</span> hands a task to Claude Code in a
          resumable, observable loop: it does <em>one step per turn</em>, commits each change, and stops when the work is
          done — or when it hits something it shouldn't guess through.
        </p>
        <div>
          <p className="font-semibold text-neutral-100">A good PLAN.md is the whole game.</p>
          <p>
            Every step is one small commit-able chunk that ends in an <em>executable</em> verify (a test that passes, a
            build that exits 0). See the plan template shipped with the "New autonomous project" scaffold.
          </p>
        </div>
        <div>
          <p className="font-semibold text-neutral-100">What multiclaude does for you, automatically:</p>
          <ul className="ml-5 list-disc space-y-0.5">
            <li>pins a session UUID so the run survives usage-limit resets and restarts</li>
            <li>creates a rollback tag before it starts, so one click returns the repo to launch state</li>
            <li>keeps the state files (PLAN.md / PROGRESS.md / DONE) and the discipline block in place</li>
            <li>shows every action live, and surfaces a Blockers entry the moment Claude writes one</li>
          </ul>
        </div>
        <div>
          <p className="font-semibold text-neutral-100">What it does not do — write PLAN.md.</p>
          <p>That is your job, and the highest-leverage part. A vague plan makes an unattended run dangerous.</p>
        </div>
        <div className="flex justify-end pt-1">
          <button
            onClick={() => {
              markOnboarded();
              onClose();
            }}
            className="rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-500"
          >
            Got it
          </button>
        </div>
      </div>
    </Modal>
  );
}
