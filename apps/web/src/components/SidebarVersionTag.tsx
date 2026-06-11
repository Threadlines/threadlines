import { APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// The chip shows only the release triple ("0.0.19"); prerelease/build tails
// ("-nightly.4") and the release stage stay in the tooltip so the footer
// never crowds the button beside it.
const COMPACT_APP_VERSION = APP_VERSION.split(/[-+]/)[0] ?? APP_VERSION;

/** Faded compact version chip for sidebar footers; hover reveals stage + full version. */
export function SidebarVersionTag() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // h-7 matches the size="sm" footer buttons so both texts center
          // within the same box height instead of drifting apart.
          <span className="inline-flex h-7 shrink-0 cursor-default items-center pr-1 text-[9px] tracking-tight tabular-nums text-muted-foreground/40">
            v{COMPACT_APP_VERSION}
          </span>
        }
      />
      <TooltipPopup side="top">
        {APP_STAGE_LABEL} · Version {APP_VERSION}
      </TooltipPopup>
    </Tooltip>
  );
}
