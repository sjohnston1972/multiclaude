import { useState } from "react";
import { AppSettings } from "./api";
import { Button, Modal } from "./components";
import { notificationsPreferred, setNotifications } from "./notifications";

export default function SettingsModal({
  settings,
  onSave,
  onClose,
}: {
  settings: AppSettings;
  onSave: (s: AppSettings) => void;
  onClose: () => void;
}) {
  const [fontSize, setFontSize] = useState(settings.fontSize);
  const [scrollback, setScrollback] = useState(settings.scrollback);
  const [notifications, setNotificationsState] = useState(notificationsPreferred());
  const [notifyNote, setNotifyNote] = useState<string | null>(null);

  const toggleNotifications = async (on: boolean) => {
    const active = await setNotifications(on);
    setNotificationsState(active);
    setNotifyNote(
      !on
        ? null
        : active
          ? "Desktop notifications enabled."
          : "Your browser blocked notifications — allow them for this site to enable."
    );
  };

  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <label className="flex items-center justify-between gap-4">
          <span>
            Font size
            <span className="block text-xs text-neutral-500">Terminal text size (8–32)</span>
          </span>
          <input
            type="number"
            min={8}
            max={32}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            className="w-24 rounded border border-neutral-700 bg-neutral-800 px-2 py-1"
          />
        </label>
        <label className="flex items-center justify-between gap-4">
          <span>
            Scrollback lines
            <span className="block text-xs text-neutral-500">
              How far you can scroll back (200–200,000)
            </span>
          </span>
          <input
            type="number"
            min={200}
            max={200000}
            step={1000}
            value={scrollback}
            onChange={(e) => setScrollback(Number(e.target.value))}
            className="w-24 rounded border border-neutral-700 bg-neutral-800 px-2 py-1"
          />
        </label>
        <div className="border-t border-neutral-700 pt-3">
          <label
            className="flex items-center gap-2"
            title="Show a desktop notification when a background session rings the terminal bell (e.g. Claude finishing). Requires granting your browser's notification permission."
          >
            <input
              type="checkbox"
              checked={notifications}
              onChange={(e) => void toggleNotifications(e.target.checked)}
            />
            <span>
              Desktop notifications when a session needs attention
              {notifyNote && (
                <span className="block text-xs text-neutral-500">{notifyNote}</span>
              )}
            </span>
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            kind="primary"
            onClick={() => {
              onSave({
                fontSize: Math.min(32, Math.max(8, fontSize || 14)),
                scrollback: Math.min(200000, Math.max(200, scrollback || 10000)),
              });
              onClose();
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
