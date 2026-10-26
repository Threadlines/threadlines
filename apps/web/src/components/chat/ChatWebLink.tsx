import type { ScopedThreadRef } from "@threadlines/contracts";
import {
  memo,
  useCallback,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { isElectron } from "../../env";
import { readLocalApi } from "../../localApi";
import {
  canOpenInBrowserPanel,
  isPlainPrimaryClick,
  openUrlInBrowserPanel,
  readLinkOpenTarget,
  webLinkClickTarget,
} from "../browser/openInBrowserPanel";
import { isLinkToPullRequest } from "../pull-requests/pullRequests.logic";
import { failureNotice, toastManager } from "../ui/toast";
import { copyWithNotice } from "../ui/copyWithNotice";
import { useThreadPullRequestLinks } from "./ThreadPullRequestLinkContext";

/**
 * The anchor's own props ride along, `ref` included, so a hover-card trigger
 * or tooltip can wrap the link and reach the element: a wrapper that dropped
 * them would leave the card with nothing to listen to.
 */
export interface ChatWebLinkProps extends Omit<
  ComponentProps<"a">,
  "href" | "children" | "className" | "title"
> {
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
 * A link to one of the thread's pull requests opens it in the Pull request
 * tab, the same place the sidebar badge goes. Any other page follows
 * `webLinkClickTarget`: by default the plain click stays in the thread's
 * browser, because a link an agent wrote is about the work in front of you
 * and leaving to read it costs you the place you were. Whatever goes outside
 * -- by the user's choice, a modifier, a middle click, or a thread without a
 * panel -- falls through to the anchor's own behaviour, so the link is never
 * less capable than an ordinary one.
 */
export const ChatWebLink = memo(function ChatWebLink({
  href,
  threadRef,
  children,
  className,
  title,
  onClick,
  onContextMenu,
  ...anchorProps
}: ChatWebLinkProps) {
  const pullRequestLinks = useThreadPullRequestLinks();
  const tabPullRequest =
    pullRequestLinks?.pullRequests.find((pullRequest) =>
      isLinkToPullRequest(href, pullRequest.url),
    ) ?? null;
  const opensPullRequestTab = tabPullRequest !== null;

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) {
        return;
      }
      if (tabPullRequest !== null && isPlainPrimaryClick(event)) {
        event.preventDefault();
        event.stopPropagation();
        pullRequestLinks?.open(tabPullRequest.number);
        return;
      }
      if (
        !isElectron ||
        threadRef === null ||
        webLinkClickTarget(event, readLinkOpenTarget()) !== "browser-panel"
      ) {
        return;
      }
      if (!openUrlInBrowserPanel(threadRef, href)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [href, onClick, pullRequestLinks, tabPullRequest, threadRef],
  );

  const handleContextMenu = useCallback(
    async (event: ReactMouseEvent<HTMLAnchorElement>) => {
      onContextMenu?.(event);
      const api = readLocalApi();
      if (!api || event.defaultPrevented) return;

      event.preventDefault();
      event.stopPropagation();

      // The browser-panel entry only appears where the plain click does not
      // go there, so every destination stays one right-click away.
      const offersBrowserPanel =
        (opensPullRequestTab || readLinkOpenTarget() !== "browser-panel") &&
        canOpenInBrowserPanel(threadRef);
      const clicked = await api.contextMenu.show(
        [
          ...(offersBrowserPanel
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
            failureNotice({
              title: "Couldn't open the link",
              error,
            }),
          );
        });
        return;
      }
      if (clicked === "copy-link") {
        void copyWithNotice(href, "link address");
      }
    },
    [href, onContextMenu, opensPullRequestTab, threadRef],
  );

  return (
    <a
      target="_blank"
      rel="noopener noreferrer"
      {...anchorProps}
      href={href}
      className={className}
      title={title}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {children}
    </a>
  );
});
