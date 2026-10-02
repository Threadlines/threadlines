import { useEffect } from "react";

import { forgetCachedBrowserProfilePartition } from "../../lib/browserProfiles";
import { onProjectRemoved } from "../../store";

/**
 * Forgets the in-app browser profile of a project when it is deleted.
 *
 * A profile is a partition on disk holding a project's sign-ins, and deleting
 * the project does not delete it. Only the deletion itself counts: a project
 * missing from a list is not proof (two projects in one folder are merged in
 * the list, and a list mid-reconnect is partial), and wrongly forgetting one
 * signs someone out for good. A deletion that happens while this app is not
 * connected is missed; "Clear all browser data" in Settings still reaches it.
 *
 * Rendered once at the app root, in the desktop app only. Renders nothing.
 */
export function BrowserProfileReconciler() {
  useEffect(() => {
    const bridge = window.desktopBridge;
    const listProfiles = bridge?.previewListProfiles;
    const forgetProfile = bridge?.previewForgetProfile;
    if (listProfiles === undefined || forgetProfile === undefined) {
      return;
    }
    return onProjectRemoved((environmentId, projectId) => {
      void listProfiles()
        .then(async (profiles) => {
          for (const profile of profiles) {
            if (profile.environmentId !== environmentId || profile.projectId !== projectId) {
              continue;
            }
            await forgetProfile({ partition: profile.partition });
            forgetCachedBrowserProfilePartition(environmentId, projectId);
          }
        })
        .catch((error: unknown) => {
          console.warn("Failed to forget a deleted project's browser profile", {
            environmentId,
            projectId,
            error,
          });
        });
    });
  }, []);

  return null;
}
