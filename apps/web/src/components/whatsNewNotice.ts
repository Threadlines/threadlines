/**
 * The notice the first launch of a newer build shows, with a way into its
 * notes (WhatsNewDialog.tsx loads this when the workspace has painted).
 */
import { parseNightlyVersion } from "@threadlines/shared/releaseNotes";

import { APP_BUILD_CHANNEL_LABEL, APP_VERSION } from "../branding";
import {
  claimUpdateNotice,
  fetchNightlyBuilds,
  loadReleaseNotes,
  readPreviousAppVersion,
} from "../lib/whatsNew";
import { describeNightlyUpdate, planNightlyList } from "../lib/whatsNew.logic";
import { toastManager } from "./ui/toast";
import { openWhatsNewDialog } from "./WhatsNewDialog";

/**
 * Once per version on each device: the first launch of a build newer than any
 * this device ran before says so, and stays until closed. A stable release
 * names its title; a nightly names its one change or how many it brings since
 * the build before, read from GitHub, and says nothing when it only brings
 * internal changes or GitHub can't be reached.
 */
export async function announceUpdateOnce(): Promise<void> {
  if (!(await claimUpdateNotice())) return;
  if (APP_BUILD_CHANNEL_LABEL === "Stable") {
    const entry = (await loadReleaseNotes()).find((candidate) => candidate.version === APP_VERSION);
    if (entry) showUpdateNotice(`Updated to v${entry.version}`, entry.title);
    return;
  }
  const nightly = parseNightlyVersion(APP_VERSION);
  if (APP_BUILD_CHANNEL_LABEL !== "Nightly" || !nightly) return;
  const { since } = planNightlyList({
    appVersion: APP_VERSION,
    previousVersion: readPreviousAppVersion(),
    lastStableVersion: null,
  });
  const { builds, complete } = await fetchNightlyBuilds({ after: since, upTo: APP_VERSION });
  const description = describeNightlyUpdate({
    fresh: builds,
    since,
    complete,
    appVersion: APP_VERSION,
  });
  if (description) showUpdateNotice(`Updated to Nightly ${nightly.build}`, description);
}

function showUpdateNotice(title: string, description: string): void {
  const noticeId = toastManager.add({
    type: "info",
    title,
    description,
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
