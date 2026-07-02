import { XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { FileSelectionContextDraft } from "~/lib/fileSelectionContext";
import { formatFileSelectionContextLabel } from "~/lib/fileSelectionContext";
import { openFileInActiveViewer } from "~/fileViewerStore";
import { COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME } from "../composerInlineChip";
import { VscodeEntryIcon } from "./VscodeEntryIcon";
import { useTheme } from "../../hooks/useTheme";
import { TooltipWrapper } from "../ui/tooltip";

interface ComposerPendingFileSelectionContextsProps {
  contexts: ReadonlyArray<FileSelectionContextDraft>;
  onRemove: (contextId: string) => void;
  className?: string;
}

const CHIP_CONTAINER_CLASS_NAME =
  "inline-flex max-w-56 items-center gap-0.5 rounded-md border border-border/70 bg-accent/40 py-1 pr-1 pl-2 transition-colors hover:bg-accent/60";

const CHIP_TRIGGER_CLASS_NAME =
  "inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-[12px] font-medium leading-tight text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * Quoted file spans attached to the draft, rendered as composer chips like
 * terminal and transcript-highlight contexts. Clicking a chip reopens the
 * file viewer at the quoted range.
 */
export function ComposerPendingFileSelectionContexts({
  contexts,
  onRemove,
  className,
}: ComposerPendingFileSelectionContextsProps) {
  const { resolvedTheme } = useTheme();
  if (contexts.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {contexts.map((context) => (
        <div key={context.id} className={CHIP_CONTAINER_CLASS_NAME}>
          <TooltipWrapper tooltip={`Open ${context.relativePath}`}>
            <button
              type="button"
              className={CHIP_TRIGGER_CLASS_NAME}
              onClick={() =>
                openFileInActiveViewer({
                  path: context.relativePath,
                  ...(context.wholeFile
                    ? {}
                    : { line: context.startLine, endLine: context.endLine }),
                })
              }
            >
              <VscodeEntryIcon
                pathValue={context.relativePath}
                kind="file"
                theme={resolvedTheme}
                className="size-3.5 shrink-0"
              />
              <span className="truncate">{formatFileSelectionContextLabel(context)}</span>
            </button>
          </TooltipWrapper>
          <button
            type="button"
            aria-label={`Remove ${context.relativePath} from the draft`}
            className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
            onClick={() => onRemove(context.id)}
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
