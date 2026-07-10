import TerminalPane from "./TerminalPane";

// Phase 1: a single full-screen terminal. Tabs and splits come in Phase 2.
export default function App() {
  return (
    <div className="h-full w-full bg-neutral-950">
      <TerminalPane sessionId="default" />
    </div>
  );
}
