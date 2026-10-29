/**
 * The notice the first launch of a newer stable release shows: its title and
 * a way into its notes (WhatsNewDialog.tsx loads this when the workspace has
 * painted).
 */
import { APP_BUILD_CHANNEL_LABEL, APP_VERSION } from "../branding";
import { claimUpdateNotice, loadReleaseNotes } from "../lib/whatsNew";
import { toastManager } from "./ui/toast";
import { openWhatsNewDialog } from "./WhatsNewDialog";

/**
 * Once per version on each device: the first launch of a stable release newer
 * than any this device ran before says so, with its title and a way into its
 * notes. Stays until closed; it never comes back for that version. Nightly
 * builds come every day, so they only move the device's record along.
 */
export async function announceUpdateOnce(): Promise<void> {
  if (!(await claimUpdateNotice())) return;
  if (APP_BUILD_CHANNEL_LABEL !== "Stable") return;
  const entry = (await loadReleaseNotes()).find((candidate) => candidate.version === APP_VERSION);
  if (!entry) return;
  const noticeId = toastManager.add({
    type: "info",
    title: `Updated to v${entry.version}`,
    description: entry.title,
    timeout: 0,
    actionProps: {
      children: "What's new",
      onClick: () => {
        toastManager.close(noticeId);
        openWhatsNewDialog();
      },
    },
    data: { actionVariant: "outline" },
  });
}
