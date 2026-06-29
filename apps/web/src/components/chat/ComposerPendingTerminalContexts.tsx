import { TerminalIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME } from "../composerInlineChip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { cn } from "~/lib/utils";
import {
  type TerminalContextDraft,
  formatTerminalContextLabel,
  isTerminalContextExpired,
  normalizeTerminalContextText,
} from "~/lib/terminalContext";
import { CONTEXT_PREVIEW_CARD_LABEL_CLASS_NAME } from "./TranscriptHighlightContextCard";

interface ComposerPendingTerminalContextsProps {
  contexts: ReadonlyArray<TerminalContextDraft>;
  onRemove: (contextId: string) => void;
  className?: string;
}

interface ComposerPendingTerminalContextChipProps {
  context: TerminalContextDraft;
  onRemove?: ((contextId: string) => void) | undefined;
}

const CHIP_CONTAINER_CLASS_NAME =
  "inline-flex max-w-56 items-center gap-0.5 rounded-md border border-border/70 bg-accent/40 py-1 pr-1 pl-2 transition-colors hover:bg-accent/60";

const CHIP_TRIGGER_CLASS_NAME =
  "inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-[12px] font-medium leading-tight text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring";
const UPDATE_ANIMATION_MS = 950;

function terminalContextUpdateSignature(context: TerminalContextDraft): string {
  return [
    context.terminalId,
    context.terminalLabel,
    context.lineStart,
    context.lineEnd,
    context.text,
  ].join("\u001f");
}

export function ComposerPendingTerminalContextChip({
  context,
  onRemove,
}: ComposerPendingTerminalContextChipProps) {
  const updateSignature = useMemo(() => terminalContextUpdateSignature(context), [context]);
  const previousUpdateSignatureRef = useRef(updateSignature);
  const animationFrameRef = useRef<number | null>(null);
  const animationTimeoutRef = useRef<number | null>(null);
  const [isUpdateAnimating, setIsUpdateAnimating] = useState(false);
  const label = formatTerminalContextLabel(context);
  const expired = isTerminalContextExpired(context);
  const previewText = expired
    ? `Terminal context expired. Remove and re-add ${label} to include it in your message.`
    : normalizeTerminalContextText(context.text);

  useEffect(() => {
    if (previousUpdateSignatureRef.current === updateSignature) {
      return;
    }
    previousUpdateSignatureRef.current = updateSignature;
    if (typeof window === "undefined") {
      return;
    }
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
    }
    if (animationTimeoutRef.current !== null) {
      window.clearTimeout(animationTimeoutRef.current);
    }
    setIsUpdateAnimating(false);
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      setIsUpdateAnimating(true);
      animationTimeoutRef.current = window.setTimeout(() => {
        animationTimeoutRef.current = null;
        setIsUpdateAnimating(false);
      }, UPDATE_ANIMATION_MS);
    });
  }, [updateSignature]);

  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      if (animationTimeoutRef.current !== null) {
        window.clearTimeout(animationTimeoutRef.current);
      }
    };
  }, []);

  return (
    <Popover>
      <span
        className={cn(
          CHIP_CONTAINER_CLASS_NAME,
          expired && "border-destructive/35 bg-destructive/8 text-destructive",
          isUpdateAnimating && "terminal-context-attachment-updated",
        )}
        data-terminal-context-expired={expired ? "true" : undefined}
        data-terminal-context-updated={isUpdateAnimating ? "true" : undefined}
      >
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={`Preview ${label}`}
              className={CHIP_TRIGGER_CLASS_NAME}
            >
              <TerminalIcon
                className={cn("size-3.5 shrink-0 opacity-85", expired && "opacity-100")}
              />
              <span className="min-w-0 truncate">{label}</span>
            </button>
          }
        />
        {onRemove ? (
          <button
            type="button"
            aria-label={`Remove ${label}`}
            onClick={() => onRemove(context.id)}
            className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
          >
            <XIcon className="size-3" />
          </button>
        ) : null}
      </span>
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={8}
        className="w-80 max-w-[calc(100vw-2rem)]"
      >
        <div className="flex w-full flex-col gap-1.5">
          <span className={CONTEXT_PREVIEW_CARD_LABEL_CLASS_NAME}>{label}</span>
          <pre
            className={cn(
              "max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] leading-snug text-muted-foreground",
              expired && "border-destructive/25 bg-destructive/8 text-destructive-foreground",
            )}
          >
            {previewText}
          </pre>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function ComposerPendingTerminalContexts(props: ComposerPendingTerminalContextsProps) {
  const { contexts, onRemove, className } = props;

  if (contexts.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {contexts.map((context) => (
        <ComposerPendingTerminalContextChip
          key={context.id}
          context={context}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}
