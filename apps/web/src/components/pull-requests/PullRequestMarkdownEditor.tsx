/**
 * The box a body is rewritten in: a description, a title, or a remark already
 * posted. It owns the draft and nothing else — the caller sends the request
 * and says whether it is still in flight — so the same box serves every write.
 *
 * Preview renders through the same component the saved body will be read
 * through, which is the only way to see what the host's markdown becomes
 * before it is sent.
 */
import type { EnvironmentId } from "@threadlines/contracts";
import { useState } from "react";

import { cn } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export function PullRequestMarkdownEditor({
  value,
  cwd,
  environmentId,
  label,
  placeholder,
  saving,
  allowEmpty = false,
  rows = 6,
  className,
  onSave,
  onCancel,
}: {
  readonly value: string;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly placeholder?: string;
  readonly saving: boolean;
  /** A description may be cleared, which is how one is removed; a remark may not. */
  readonly allowEmpty?: boolean;
  readonly rows?: number;
  readonly className?: string;
  readonly onSave: (next: string) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [preview, setPreview] = useState(false);
  // The words this draft started from. React keeps a component instance
  // wherever the same position and key come round again, so an editor opened
  // on one remark can be handed another's words without being rebuilt, and
  // saving would then write the first remark's text onto the second.
  const [seed, setSeed] = useState(value);
  if (seed !== value) {
    setSeed(value);
    setDraft(value);
  }
  const empty = draft.trim().length === 0;
  const canSave = !saving && (allowEmpty || !empty);

  return (
    <div
      className={cn("flex flex-col gap-2", className)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !saving) {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      {preview ? (
        <div className="min-h-16 rounded-lg border border-border px-3 py-2">
          {empty ? (
            <p className="text-xs text-muted-foreground/55">Nothing to preview.</p>
          ) : (
            <ChatMarkdown text={draft} cwd={cwd} environmentId={environmentId} html="github" />
          )}
        </div>
      ) : (
        <Textarea
          autoFocus
          size="sm"
          rows={rows}
          disabled={saving}
          value={draft}
          placeholder={placeholder}
          aria-label={label}
          data-testid="pull-request-markdown-editor-input"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSave) {
              event.preventDefault();
              onSave(draft);
            }
          }}
        />
      )}
      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="xs"
          className="mr-auto text-muted-foreground/70"
          aria-pressed={preview}
          onClick={() => setPreview((current) => !current)}
        >
          {preview ? "Write" : "Preview"}
        </Button>
        <Button variant="ghost" size="xs" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          disabled={!canSave}
          data-testid="pull-request-markdown-editor-save"
          onClick={() => onSave(draft)}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
