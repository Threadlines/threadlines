import { WorkflowIcon } from "lucide-react";

/**
 * The line under the composer while its message holds Claude's "ultracode":
 * what sending it will do, and the way to send it as plain text instead.
 */
export function ComposerWorkflowKeywordHint({
  suppressed,
  onToggle,
}: {
  readonly suppressed: boolean;
  readonly onToggle: (() => void) | undefined;
}) {
  return (
    <div
      className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[12px] leading-5 text-muted-foreground"
      data-composer-workflow-keyword={suppressed ? "plain" : "workflow"}
    >
      <WorkflowIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">
        {suppressed ? "Sends as plain text" : "Runs as a workflow"}
      </span>
      {onToggle ? (
        <>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            className="shrink-0 rounded-sm text-foreground/80 outline-none transition-colors hover:text-foreground focus-ring"
            onClick={onToggle}
          >
            {suppressed ? "Undo" : "Send as plain text"}
          </button>
        </>
      ) : null}
    </div>
  );
}
