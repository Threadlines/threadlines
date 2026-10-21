import { Link } from "@tanstack/react-router";

import { APP_BASE_NAME, APP_STAGE_LABEL, APP_VERSION } from "../../branding";
import { ThreadlinesGlyph } from "../Icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The Threadlines logo and name, a link home whose tooltip carries the
 * version. It heads the title row on a wide screen and the phone's sheet.
 */
export function AppWordmark() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            aria-label={`Go to ${APP_BASE_NAME} home`}
            data-testid="app-wordmark"
            className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 text-foreground outline-hidden transition-colors hover:text-foreground/80 focus-ring [-webkit-app-region:no-drag]"
            to="/"
          >
            <ThreadlinesGlyph aria-hidden="true" className="h-3 w-auto shrink-0" />
            <span className="truncate text-sm font-semibold tracking-tight">{APP_BASE_NAME}</span>
          </Link>
        }
      />
      <TooltipPopup side="bottom" sideOffset={4}>
        <div className="flex flex-col gap-0.5">
          <span>Home</span>
          <span className="text-[10px] text-muted-foreground">
            {APP_STAGE_LABEL} · Version {APP_VERSION}
          </span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
