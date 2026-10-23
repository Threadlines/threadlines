import type { ReactNode } from "react";

import { CodeBlockRunButton, CodeBlockRunNotes } from "./CommandRuns";
import { MessageCopyButton } from "./MessageCopyButton";

/**
 * A fenced code block: copy button, and in a settled agent reply a shell
 * command also gets a Run (or Put in terminal) button and, under it, how its
 * latest run went (CommandRuns.tsx). The buttons sit on the code's first line.
 * A diagram uses the same frame, with its own buttons before Copy.
 */
export function MarkdownCodeBlock({
  code,
  language,
  actions,
  findIgnored = false,
  children,
}: {
  code: string;
  language: string | undefined;
  /** Buttons before Copy. */
  actions?: ReactNode;
  /** Find in chat reads past the whole block (a diagram, drawn or as source). */
  findIgnored?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="chat-markdown-codeblock-group"
      {...(findIgnored ? { "data-chat-find-ignore": "" } : {})}
    >
      <div className="chat-markdown-codeblock leading-snug">
        <div className="chat-markdown-codeblock-actions" data-chat-find-ignore="">
          {actions}
          <CodeBlockRunButton code={code} language={language} />
          <MessageCopyButton
            text={code}
            ariaLabel="Copy code block"
            size="icon-xs"
            className="chat-markdown-copy-button"
          />
        </div>
        {children}
      </div>
      <CodeBlockRunNotes code={code} language={language} />
    </div>
  );
}
