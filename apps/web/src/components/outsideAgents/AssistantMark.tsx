/**
 * A known assistant's mark (Grok Bot's, ChatGPT's, ...), shown beside its
 * name where Settings and the approval dialog name an assistant. A plain
 * glyph in the brand's own color, never in a tile; nothing for an assistant
 * Threadlines doesn't know.
 */
import type { KnownAssistant } from "@threadlines/contracts";

import { cn } from "../../lib/utils";
import { ClaudeAI, CursorIcon, GrokIcon, type Icon, MuseIcon, OpenAI } from "../Icons";

const MARKS: Record<KnownAssistant, Icon> = {
  "grok-bot": GrokIcon,
  chatgpt: OpenAI,
  claude: ClaudeAI,
  muse: MuseIcon,
  cursor: CursorIcon,
};

export function AssistantMark({
  assistant,
  className,
}: {
  readonly assistant: KnownAssistant | null;
  readonly className?: string;
}) {
  if (assistant === null) return null;
  const Mark = MARKS[assistant];
  return (
    <Mark
      aria-hidden
      className={cn("size-3.5 shrink-0", className)}
      data-testid={`assistant-mark-${assistant}`}
    />
  );
}
