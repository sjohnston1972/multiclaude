import { ReactNode, useEffect } from "react";

/** Shared modal + button primitives so every dialog looks the same. */

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  // Esc closes the dialog, matching normal desktop behaviour.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`flex max-h-[85vh] ${wide ? "w-[640px]" : "w-[480px]"} max-w-[95vw] flex-col rounded-lg border border-neutral-700 bg-neutral-900 shadow-xl`}
      >
        <div className="flex items-center justify-between border-b border-neutral-700 px-4 py-2">
          <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
          <button
            onClick={onClose}
            className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-700 hover:text-white"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>
        <div className="overflow-y-auto p-4 text-sm text-neutral-200">{children}</div>
      </div>
    </div>
  );
}

export function Button({
  onClick,
  children,
  kind = "normal",
  disabled,
  title,
}: {
  onClick?: () => void;
  children: ReactNode;
  kind?: "normal" | "primary" | "danger";
  disabled?: boolean;
  title?: string;
}) {
  const styles = {
    normal: "bg-neutral-700 hover:bg-neutral-600 text-neutral-100",
    primary: "bg-blue-600 hover:bg-blue-500 text-white",
    danger: "bg-red-700 hover:bg-red-600 text-white",
  }[kind];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${styles}`}
    >
      {children}
    </button>
  );
}

export function ToolbarButton({
  onClick,
  children,
  title,
}: {
  onClick: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rounded px-2.5 py-1 text-sm text-neutral-300 hover:bg-neutral-700 hover:text-white"
    >
      {children}
    </button>
  );
}
