import type { ScopedThreadRef } from "@threadlines/contracts";
import { memo, useCallback, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { isElectron } from "../../env";
import { readLocalApi } from "../../localApi";
import { isPlainPrimaryClick, openUrlInBrowserPanel } from "../browser/openInBrowserPanel";
import { isLinkToPullRequest } from "../pull-requests/pullRequests.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { copyTextWithToast } from "./copyTextWithToast";
import { useThreadPullRequestLink } from "./ThreadPullRequestLinkContext";

export interface ChatWebLinkProps {
  href: string;
  /** Null when the transcript is rendered without a thread to open pages in. */
  threadRef: ScopedThreadRef | null;
  children: ReactNode;
  className?: string | undefined;
  /** The markdown link title, if the author wrote one. */
  title?: string | undefined;
}

/**
 * A web address in a transcript.
 *
 * The plain click stays in the app, because a link an agent wrote is about the
 * work in front of you and leaving to read it costs you the place you were. A
 * link to the thread's own pull request opens the Pull request tab, the same
 * place the sidebar badge goes; any other page goes to the thread's browser.
 * Everything else -- modifiers, middle click, and any thread without a panel --
 * falls through to the anchor's own behaviour, so the link is never less
 * capable than an ordinary one.
 */
export const ChatWebLink = memo(function ChatWebLink({
  href,
  threadRef,
  children,
  className,
  title,
}: ChatWebLinkProps) {
  const pullRequestLink = useThreadPullRequestLink();
  const opensPullRequestTab =
    pullRequestLink !== null && isLinkToPullRequest(href, pullRequestLink.url);

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (!isPlainPrimaryClick(event)) {
        return;
      }
      if (opensPullRequestTab) {
        event.preventDefault();
        event.stopPropagation();
        pullRequestLink?.open();
        return;
      }
      if (!isElectron || threadRef === null) {
        return;
      }
      if (!openUrlInBrowserPanel(threadRef, href)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [href, opensPullRequestTab, pullRequestLink, threadRef],
  );

  const handleContextMenu = useCallback(
    async (event: ReactMouseEvent<HTMLAnchorElement>) => {
      const api = readLocalApi();
      if (!api) return;

      event.preventDefault();
      event.stopPropagation();

      // The browser-panel entry only appears where the plain click no longer
      // goes there, so every destination stays one right-click away.
      const clicked = await api.contextMenu.show(
        [
          ...(opensPullRequestTab && threadRef !== null
            ? [{ id: "open-browser-panel", label: "Open in browser panel" } as const]
            : []),
          { id: "open-external", label: "Open in external browser" },
          { id: "copy-link", label: "Copy link address" },
        ] as const,
        { x: event.clientX, y: event.clientY },
      );

      if (clicked === "open-browser-panel" && threadRef !== null) {
        openUrlInBrowserPanel(threadRef, href);
        return;
      }
      if (clicked === "open-external") {
        void api.shell.openExternal(href).catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to open link",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        });
        return;
      }
      if (clicked === "copy-link") {
        copyTextWithToast(href, "Link address");
      }
    },
    [href, opensPullRequestTab, threadRef],
  );

  return (
    <a
      href={href}
      className={className}
      title={title}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {children}
    </a>
  );
});
