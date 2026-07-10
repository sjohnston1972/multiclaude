import { useEffect, useRef, useState } from "react";
import { api, SessionInfo } from "./api";
import { Button, Modal } from "./components";

/**
 * Type one command and send it (with Enter) to every live session at once —
 * e.g. tell every Claude the same thing, or run `/clear` everywhere.
 */
export default function BroadcastModal({ onClose }: { onClose: () => void }) {
  const [command, setCommand] = useState("");
  const [sent, setSent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionCount, setSessionCount] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    api<SessionInfo[]>("/api/sessions")
      .then((list) => setSessionCount(list.length))
      .catch(() => setSessionCount(null));
  }, []);

  const send = async () => {
    setError(null);
    try {
      const r = await api<{ sent: number }>("/api/broadcast", {
        method: "POST",
        body: { command },
      });
      setSent(r.sent);
      setCommand("");
      inputRef.current?.focus();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title="Broadcast to all sessions" onClose={onClose} wide>
      <p className="mb-3 text-neutral-400">
        Sends this line, followed by Enter, to{" "}
        {sessionCount === null ? "all" : sessionCount} live session
        {sessionCount === 1 ? "" : "s"} — attached tabs and background sessions alike.
      </p>
      {error && <p className="mb-2 rounded bg-red-950 px-3 py-1.5 text-red-300">{error}</p>}
      {sent !== null && !error && (
        <p className="mb-2 rounded bg-green-950 px-3 py-1.5 text-green-300">
          Sent to {sent} session{sent === 1 ? "" : "s"}.
        </p>
      )}
      <div className="flex gap-2">
        <input
          ref={inputRef}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
          placeholder="Command to run in every session…"
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 outline-none focus:border-blue-600"
        />
        <Button kind="primary" onClick={() => void send()}>
          Send
        </Button>
      </div>
    </Modal>
  );
}
