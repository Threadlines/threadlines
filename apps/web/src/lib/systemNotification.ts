/**
 * Shows a system notification, for something that needs the user while they
 * are away from the window, through the page's Notification API. The desktop
 * app's window shows them without asking (it allows notifications); a browser
 * tab shows one only where the user already allowed it there, and is never
 * prompted from here. Clicking it brings the window forward. `tag` replaces
 * an earlier notification with the same tag. False when none was shown.
 */
export function showSystemNotification(input: {
  readonly title: string;
  readonly body: string;
  readonly tag?: string;
}): boolean {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  try {
    const notification = new Notification(input.title, {
      body: input.body,
      ...(input.tag !== undefined ? { tag: input.tag } : {}),
    });
    notification.addEventListener("click", () => {
      window.focus();
      notification.close();
    });
    return true;
  } catch {
    // Some browsers only allow them from a service worker.
    return false;
  }
}
