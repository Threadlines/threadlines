/**
 * The block a remark occupies inside a diff, on the line it belongs to.
 *
 * Two shapes, one anatomy: a draft is a box being typed into, a comment is
 * words already written. Both carry the range they hang on and whatever
 * actions the surface offers. The surface renders the body itself, so this
 * knows nothing about where the markdown or the reactions come from.
 */
import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/** True for the send gesture every composer in the app uses. */
export function isCommentSubmitShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.key === "Enter";
}

export interface DiffCommentSecondaryAction {
  readonly label: string;
  readonly onAction: (body: string) => void;
}

/**
 * A remark being written on a line. Escape abandons it, Ctrl or Cmd with Enter
 * sends it, and the primary button says where it is going.
 */
export function DiffCommentDraft({
  rangeLabel,
  value,
  onChange,
  onCancel,
  onSubmit,
  submitLabel,
  secondaryAction,
  placeholder = "Leave a comment",
  pending = false,
  className,
}: {
  readonly rangeLabel: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onCancel: () => void;
  readonly onSubmit: (body: string) => void;
  readonly submitLabel: string;
  readonly secondaryAction?: DiffCommentSecondaryAction;
  readonly placeholder?: string;
  readonly pending?: boolean;
  readonly className?: string;
}) {
  const trimmed = value.trim();
  return (
    <div
      data-diff-comment-draft
      className={cn("px-3 py-2 font-sans text-foreground", className)}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Textarea
        autoFocus
        size="sm"
        rows={3}
        value={value}
        placeholder={placeholder}
        aria-label={`Comment on ${rangeLabel}`}
        data-testid="diff-comment-draft-input"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
            return;
          }
          if (isCommentSubmitShortcut(event) && !pending && trimmed.length > 0) {
            event.preventDefault();
            onSubmit(trimmed);
          }
        }}
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="mr-auto font-mono text-[10px] text-muted-foreground/55">{rangeLabel}</span>
        <Button variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        {secondaryAction ? (
          <Button
            variant="outline"
            size="xs"
            disabled={pending || trimmed.length === 0}
            onClick={() => secondaryAction.onAction(trimmed)}
          >
            {secondaryAction.label}
          </Button>
        ) : null}
        <Button
          size="xs"
          disabled={pending || trimmed.length === 0}
          data-testid="diff-comment-draft-submit"
          onClick={() => onSubmit(trimmed)}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * A remark already written, or a whole conversation of them. Hairlines rather
 * than a card: the diff around it is already a surface, and a second box
 * inside it would be a box in a box.
 */
export function DiffCommentAnnotation({
  heading,
  actions,
  children,
  className,
}: {
  /** The one line that identifies the remark: who, when, and its state. */
  readonly heading: ReactNode;
  /** Controls that sit at the end of the heading line. */
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      data-diff-comment-annotation
      className={cn(
        "group/diff-comment border-border/60 border-y bg-background px-3 py-2 font-sans text-foreground",
        className,
      )}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/60">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">{heading}</span>
        {actions}
      </div>
      {children}
    </div>
  );
}
