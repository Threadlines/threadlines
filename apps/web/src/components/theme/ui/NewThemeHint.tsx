/**
 * What "New theme" shows above the message box (docs/design/custom-themes.md,
 * "Switching"): how making a theme works, and a few ideas that finish the
 * sentence it put in the message box. It closes with its ✕, when the
 * sentence is sent, or when the user clears it.
 */
import { XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";

/** What "New theme" puts in the message box, for the user to finish. */
export const NEW_THEME_PROMPT = "Make me a Threadlines theme that feels like ";

/** Ways to finish the sentence, for someone who doesn't know where to start. */
const NEW_THEME_IDEAS = [
  "a rainy night in Tokyo",
  "a quiet lagoon with sea turtles",
  "an 8-bit forest at dusk",
  "warm paper and ink",
] as const;

export function NewThemeHint({
  onPickIdea,
  onClose,
}: {
  readonly onPickIdea: (prompt: string) => void;
  readonly onClose: () => void;
}) {
  return (
    <div className="px-2.5 pt-2 pb-2">
      <div className="flex items-center gap-2 px-0.5">
        <span className="text-[12px] font-medium text-foreground">New theme</span>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Close new theme"
          tooltip="Close"
          onClick={onClose}
        >
          <XIcon className="size-3.5" aria-hidden />
        </Button>
      </div>
      <p className="px-0.5 text-[12px] leading-[17px] text-muted-foreground">
        Finish the sentence below and send it. The agent makes the theme, then you can try it before
        you keep it.
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {NEW_THEME_IDEAS.map((idea) => (
          <Button
            key={idea}
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onPickIdea(`${NEW_THEME_PROMPT}${idea}.`)}
          >
            {idea}
          </Button>
        ))}
      </div>
    </div>
  );
}
