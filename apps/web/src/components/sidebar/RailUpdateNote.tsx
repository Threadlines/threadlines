import type { DesktopUpdateState } from "@threadlines/contracts";

import { useWaitingUpdateLine } from "../../lib/whatsNew";

/**
 * The rail update card's line about what the waiting update brings, read from
 * its GitHub release while the card shows. A chunk of its own (the card loads
 * it lazily), so startup never carries the release-notes code; until the line
 * is known there is simply no line.
 */
export default function RailUpdateNote({ state }: { readonly state: DesktopUpdateState }) {
  const line = useWaitingUpdateLine(state);
  if (!line) return null;
  return (
    // Wraps rather than stretching the card for a long title.
    <span className="max-w-64 text-[11.5px] leading-4" data-testid="rail-update-card-note">
      {line}
    </span>
  );
}
