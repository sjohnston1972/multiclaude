import { useEffect, useRef, useState } from "react";
import { api, SessionInfo } from "./api";
import { Button, Modal } from "./components";

/**
 * Type one command and send it (with Enter) to every live session at once —
 * e.g. tell every Claude the same thing, or run `/clear` everywhere. Presets
 * cover the most common Claude slash commands, shell commands, and controls.
 */

interface Preset {
  label: string;
  command: string;
  enter?: boolean; // false = send raw with no trailing Enter (control sequences)
  title?: string;
}

const CLAUDE_PRESETS: Preset[] = [
  { label: "/clear", command: "/clear", title: "Clear each Claude conversation" },
  { label: "/compact", command: "/compact", title: "Compact each conversation" },
  { label: "/cost", command: "/cost", title: "Show token cost in each session" },
  { label: "/status", command: "/status", title: "Show status in each session" },
  { label: "/model", command: "/model", title: "Open the model picker in each session" },
  { label: "/exit", command: "/exit", title: "Exit Claude in every session" },
];

const SHELL_PRESETS: Preset[] = [
  { label: "cls", command: "cls", title: "Clear the terminal screen" },
  { label: "git status", command: "git status" },
  { label: "git pull", command: "git pull" },
  { label: "git fetch --all", command: "git fetch --all" },
];

// Control sequences are sent raw (no trailing Enter). fromCharCode keeps the
// literal control bytes out of the source file.
const CTRL_C = String.fromCharCode(3); // ETX
const ESC = String.fromCharCode(27);
const CONTROL_PRESETS: Preset[] = [
  { label: "Enter ⏎", command: "", enter: true, title: "Send a bare Enter to every session" },
  {
    label: "Interrupt (Ctrl-C)",
    command: CTRL_C,
    enter: false,
    title: "Send Ctrl-C to interrupt every session",
  },
  { label: "Esc", command: ESC, enter: false, title: "Send Escape to every session" },
];

export default function BroadcastModal({ onClose }: { onClose: () => void }) {
  const [command, setCommand] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionCount, setSessionCount] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    api<SessionInfo[]>("/api/sessions")
      .then((list) => setSessionCount(list.length))
      .catch(() => setSessionCount(null));
  }, []);

  const send = async (cmd: string, enter = true, label?: string) => {
    setError(null);
    try {
      const r = await api<{ sent: number }>("/api/broadcast", {
        method: "POST",
        body: { command: cmd, enter },
      });
      setSent(`Sent ${label ? `"${label}"` : ""} to ${r.sent} session${r.sent === 1 ? "" : "s"}.`);
      inputRef.current?.focus();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const presetRow = (heading: string, presets: Preset[]) => (
    <div className="mb-2">
      <p className="mb-1 text-xs uppercase text-neutral-500">{heading}</p>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p.label}
            title={p.title ?? `Send "${p.command}" to every session`}
            onClick={() => void send(p.command, p.enter ?? true, p.label)}
            className="rounded border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-sm text-neutral-200 hover:border-blue-600 hover:bg-neutral-700"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <Modal title="Broadcast to all sessions" onClose={onClose} wide>
      <p className="mb-3 text-neutral-400">
        Sends to {sessionCount === null ? "all" : sessionCount} live session
        {sessionCount === 1 ? "" : "s"} — attached tabs and background sessions alike.
      </p>
      {error && <p className="mb-2 rounded bg-red-950 px-3 py-1.5 text-red-300">{error}</p>}
      {sent && !error && <p className="mb-2 rounded bg-green-950 px-3 py-1.5 text-green-300">{sent}</p>}

      <div className="mb-3 flex gap-2">
        <input
          ref={inputRef}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send(command, true, command);
          }}
          placeholder="Custom command to run in every session…"
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 outline-none focus:border-blue-600"
        />
        <Button kind="primary" onClick={() => void send(command, true, command)}>
          Send
        </Button>
      </div>

      <div className="border-t border-neutral-700 pt-3">
        {presetRow("Claude slash commands", CLAUDE_PRESETS)}
        {presetRow("Shell", SHELL_PRESETS)}
        {presetRow("Controls", CONTROL_PRESETS)}
      </div>
    </Modal>
  );
}
