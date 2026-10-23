import type { ReactNode } from "react";

/** A line above a tab's output about the tab itself, with what to do about it. */
export function TerminalNotice({
  message,
  title,
  actions,
}: {
  message: ReactNode;
  title?: string;
  actions: ReactNode;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1 text-xs text-muted-foreground"
      data-terminal-notice="true"
    >
      <span className="min-w-0 flex-1 truncate" title={title}>
        {message}
      </span>
      {actions}
    </div>
  );
}
