/**
 * A known assistant's mark (Grok Bot's, ChatGPT's, ...), shown beside its
 * name where Settings and the approval dialog name an assistant. A plain
 * glyph in the brand's own color, never in a tile; nothing for an assistant
 * Threadlines doesn't know.
 */
import type { KnownAssistant } from "@threadlines/contracts";

import { cn } from "../../lib/utils";
import { ClaudeAI, CursorIcon, GrokBotIcon, type Icon, MuseIcon, OpenAI } from "../Icons";

/**
 * Each assistant's own mark: Grok Bot's face (not xAI's mark, which is Grok
 * Build's), ChatGPT's knot (dots are ChatGPT's agents and sign in through it),
 * Claude's (Claude Duet signs in through claude.ai), Muse's and Cursor's.
 */
const MARKS: Record<KnownAssistant, Icon> = {
  "grok-bot": GrokBotIcon,
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
