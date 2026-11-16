import type { ScopedThreadRef } from "@threadlines/contracts";
import { useNavigate } from "@tanstack/react-router";
import type React from "react";
import { useCallback } from "react";

import type { ThreadPullRequest } from "../components/pull-requests/pullRequests.logic";
import { failureNotice, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { buildThreadRouteParams } from "../threadRoutes";

/**
 * What a thread row's pull request badge does when clicked. A plain click
 * opens the thread's Pull request tab, which is where the app can actually
 * show it; a modifier or the middle button is the browser's "open it
 * somewhere else" gesture, and the host is that somewhere else.
 * `beforeNavigate` runs before the in-app open (a phone sheet steps aside).
 */
export function useOpenThreadPullRequest(beforeNavigate?: () => void) {
  const navigate = useNavigate();
  return useCallback(
    (
      event: React.MouseEvent<HTMLElement>,
      pullRequest: Pick<ThreadPullRequest, "number" | "url">,
      threadRef: ScopedThreadRef,
    ) => {
      event.preventDefault();
      event.stopPropagation();

      if (!(event.metaKey || event.ctrlKey || event.button === 1)) {
        beforeNavigate?.();
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
          search: { pullRequest: "1", pullRequestNumber: pullRequest.number },
        });
        return;
      }

      const api = readLocalApi();
      if (!api) {
        toastManager.add({ type: "error", title: "Can't open links here" });
        return;
      }

      void api.shell.openExternal(pullRequest.url).catch((error) => {
        toastManager.add(
          failureNotice({
            title: "Couldn't open the pull request",
            error,
          }),
        );
      });
    },
    [beforeNavigate, navigate],
  );
}
