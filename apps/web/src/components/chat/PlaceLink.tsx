import type { EnvironmentId } from "@threadlines/contracts";
import { type PlaceId, placePage } from "@threadlines/shared/appPlaces";
import { useRouter } from "@tanstack/react-router";
import { type ComponentType, createElement, type ReactNode } from "react";

import { placeArrivalHash, resolvePlaceLink } from "../../appPlaceLinks";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { isElectron } from "../../env";
import { placeLinkLabel } from "../../lib/chatMarkdownDocument";
import { cn } from "../../lib/utils";
import { SETTINGS_NAV_ITEMS } from "../settings/settingsNavigation";
import { useComputerLabel } from "../sidebar/linkedComputers";
import {
  NAVIGATION_DESTINATION_ICONS,
  resolveSelectedDestination,
} from "../sidebar/navigationRail.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  MARKDOWN_FILE_LINK_CLASS_NAME,
  MARKDOWN_FILE_LINK_ICON_CLASS_NAME,
  MARKDOWN_FILE_LINK_LABEL_CLASS_NAME,
} from "./markdownChipClasses";

/** The glyph of the page a place is on: its Settings menu icon, else its left-bar icon. */
function placePageIcon(
  placeId: PlaceId,
): ComponentType<{ className?: string; "aria-hidden"?: boolean }> {
  const pathname = placePage(placeId).route?.to ?? "/";
  return (
    SETTINGS_NAV_ITEMS.find((item) => item.to === pathname)?.icon ??
    NAVIGATION_DESTINATION_ICONS[
      resolveSelectedDestination({ pathname, openThreadIsGeneralChat: false })
    ]
  );
}

let placeLinkClicks = 0;

/** Each click's number, so clicking a place link again highlights the place again. */
function nextPlaceLinkClick(): number {
  placeLinkClicks += 1;
  return placeLinkClicks;
}

/**
 * A `threadlines-place:` link in a reply, as a chip naming the place. Clicking
 * opens its page with `#place=` in the hash, which the page's arrival hook
 * (usePlaceArrival) reads to scroll to the place and highlight it.
 *
 * A setting of another computer's thread is not something this app shows, so
 * that chip only names it and says where it is. A place this build doesn't
 * know (renamed since the message was written) reads as the link's words,
 * never as a link that goes nowhere.
 */
export function PlaceLink({
  href,
  linkText,
  threadEnvironmentId,
  className,
  children,
}: {
  readonly href: string;
  /** The link's own words, as plain text. */
  readonly linkText: string;
  /** The environment the reply's thread runs on, when it is in one. */
  readonly threadEnvironmentId: EnvironmentId | null;
  readonly className?: string | undefined;
  /** What the link drew as markdown, shown when the place is unknown. */
  readonly children: ReactNode;
}) {
  // Outside a router (a transcript rendered on its own) the chip still draws.
  const router: ReturnType<typeof useRouter> | undefined = useRouter({ warn: false });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const computerLabel = useComputerLabel();
  const target = resolvePlaceLink({
    href,
    threadEnvironmentId,
    primaryEnvironmentId,
    isDesktopApp: isElectron,
  });
  if (target === null) return children;

  const { placeId } = target;
  const content = (
    <>
      {/* A module-level icon looked up by page, so its identity never changes. */}
      {createElement(placePageIcon(placeId), {
        "aria-hidden": true,
        className: cn(MARKDOWN_FILE_LINK_ICON_CLASS_NAME, "text-current"),
      })}
      <span className={cn(MARKDOWN_FILE_LINK_LABEL_CLASS_NAME, "font-sans")}>
        {placeLinkLabel(linkText, placeId)}
      </span>
    </>
  );

  if (target.kind !== "open") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="link"
              aria-disabled="true"
              tabIndex={0}
              className={cn(MARKDOWN_FILE_LINK_CLASS_NAME, className)}
              data-place-link={placeId}
              data-elsewhere=""
            >
              {content}
            </span>
          }
        />
        <TooltipPopup side="top" className="text-[11px] leading-tight">
          {target.kind === "elsewhere"
            ? `In Threadlines on ${computerLabel(target.environmentId, "another computer")}`
            : "Only in the Threadlines desktop app"}
        </TooltipPopup>
      </Tooltip>
    );
  }

  const open = () => {
    void router?.navigate({
      href: `${target.href}#${placeArrivalHash(placeId, nextPlaceLinkClick())}`,
      // The hash names a place, not an element id; usePlaceArrival scrolls.
      hashScrollIntoView: false,
    });
  };

  return (
    <a
      href={router ? router.history.createHref(target.href) : target.href}
      className={cn(MARKDOWN_FILE_LINK_CLASS_NAME, "chat-markdown-place-link", className)}
      data-place-link={placeId}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        open();
      }}
      // Enter already follows a link; the chip reads as a button, so Space does too.
      onKeyDown={(event) => {
        if (event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
    >
      {content}
    </a>
  );
}
