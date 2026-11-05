/**
 * A known assistant's mark (Grok Bot's, ChatGPT's, ...), shown beside its
 * name where Settings and the approval dialog name an assistant. A plain
 * glyph in the brand's own color, never in a tile; nothing for an assistant
 * Threadlines doesn't know.
 */
import type { KnownAssistant, OutsideAgentRef } from "@threadlines/contracts";
import { PlugIcon } from "lucide-react";

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
  readonly className?: string | undefined;
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

/**
 * The mark of whoever outside Threadlines started a thread: the assistant's
 * own when Threadlines knew which one it was, else a plain plug (local
 * agents, the `threadlines` command, keys it couldn't place, and threads
 * started before the assistant was kept). Callers carry the label.
 */
export function OutsideOriginMark({
  origin,
  className,
}: {
  readonly origin: Pick<OutsideAgentRef, "assistant">;
  readonly className?: string;
}) {
  return origin.assistant !== undefined ? (
    <AssistantMark assistant={origin.assistant} className={className} />
  ) : (
    <PlugIcon
      aria-hidden
      className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
      data-testid="outside-origin-plug"
    />
  );
}
