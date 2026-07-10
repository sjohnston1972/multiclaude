// Desktop-notification preference + firing. The preference is per-browser (a
// device setting, not app state), so it lives in localStorage rather than the
// server-side state file.

const KEY = "multiclaude.notifications";

/** The user has asked for notifications (regardless of current permission). */
export function notificationsPreferred(): boolean {
  return localStorage.getItem(KEY) === "1";
}

/** Notifications are both wanted AND actually permitted right now. */
export function notificationsEnabled(): boolean {
  return (
    notificationsPreferred() &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  );
}

/**
 * Turn the preference on/off. Turning on requests browser permission if needed.
 * Returns true if notifications are now active (wanted + granted).
 */
export async function setNotifications(on: boolean): Promise<boolean> {
  if (!on) {
    localStorage.setItem(KEY, "0");
    return false;
  }
  if (typeof Notification === "undefined") return false;
  let perm = Notification.permission;
  if (perm === "default") perm = await Notification.requestPermission();
  const granted = perm === "granted";
  localStorage.setItem(KEY, granted ? "1" : "0");
  return granted;
}

export function notify(title: string, body: string): void {
  try {
    if (notificationsEnabled()) new Notification(title, { body });
  } catch {
    // notifications unsupported or blocked — silently ignore
  }
}
