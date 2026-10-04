/**
 * One agent as a flat row: logo, name, a quiet label, version, one status
 * line, and its actions on the right. Setup's Connect step and both groups on
 * the Providers settings page draw agents with this, so an agent looks the
 * same wherever it appears.
 *
 * Rows are hairline dividers, not boxes. Color appears only when the user has
 * to act (an amber or red dot before the status line); a healthy agent has
 * none.
 *
 * @module AgentRow
 */
import { ArrowUpIcon } from "lucide-react";
import type { ComponentProps, MouseEvent, ReactNode } from "react";

import { cn } from "../../lib/utils";

export type AgentRowTone = "none" | "warning" | "error";

const ROW_TOGGLE_IGNORE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "[role='button']",
  "[role='switch']",
  "[data-agent-row-toggle-ignore]",
].join(",");

/** True when a click landed on a control inside the row rather than the row itself. */
function isAgentRowControlTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(ROW_TOGGLE_IGNORE_SELECTOR) !== null;
}

export function AgentRow({
  icon,
  name,
  label,
  version,
  versionExtra,
  status,
  wrapStatus = false,
  tone = "none",
  actions,
  trailing,
  expanded = false,
  onToggle,
  className,
  children,
  ...rest
}: {
  readonly icon: ReactNode;
  readonly name: ReactNode;
  /** Quiet label after the name, such as "Optional". */
  readonly label?: string | undefined;
  readonly version?: string | null | undefined;
  /** Inline after the version, e.g. the update tag or an instance id chip. */
  readonly versionExtra?: ReactNode;
  readonly status: ReactNode;
  /** Let a long status (an install guide with its link) wrap instead of truncating. */
  readonly wrapStatus?: boolean;
  readonly tone?: AgentRowTone;
  readonly actions?: ReactNode;
  /** After the actions, e.g. the open/close chevron. */
  readonly trailing?: ReactNode;
  readonly expanded?: boolean;
  /** Makes the row itself clickable (controls inside it keep their own clicks). */
  readonly onToggle?: (() => void) | undefined;
  readonly className?: string | undefined;
  /** The opened row's content, drawn under the header. */
  readonly children?: ReactNode;
} & Omit<ComponentProps<"div">, "children" | "className">) {
  const handleClick = onToggle
    ? (event: MouseEvent<HTMLDivElement>) => {
        if (isAgentRowControlTarget(event.target)) return;
        onToggle();
      }
    : undefined;

  return (
    <div
      className={cn("border-b border-border/60", expanded && "bg-muted/[0.07]", className)}
      data-agent-row-expanded={expanded ? "true" : "false"}
      {...rest}
    >
      <div
        className={cn(
          "flex min-h-13 flex-wrap items-center gap-x-3 gap-y-2 px-1 py-2.5",
          onToggle && "cursor-pointer transition-colors hover:bg-muted/[0.07]",
        )}
        onClick={handleClick}
      >
        <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
        <div className="min-w-48 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
              {name}
            </span>
            {label ? (
              <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.07em] text-muted-foreground/55">
                {label}
              </span>
            ) : null}
            {version ? (
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground/62">
                {version}
              </span>
            ) : null}
            {versionExtra}
          </div>
          <div
            className={cn(
              "mt-0.5 flex min-w-0 gap-1.5 text-xs text-muted-foreground",
              wrapStatus ? "items-start" : "items-center",
            )}
            data-agent-row-status={tone}
          >
            {tone === "none" ? null : (
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  tone === "warning" ? "bg-warning" : "bg-destructive",
                )}
              />
            )}
            <span className={cn("min-w-0", !wrapStatus && "truncate")}>{status}</span>
          </div>
        </div>
        {actions ? (
          <div className="ml-auto flex min-w-0 max-w-full shrink-0 items-center justify-end gap-2">
            {actions}
          </div>
        ) : null}
        {trailing}
      </div>
      {children}
    </div>
  );
}

/**
 * The static "↑ 2.1.301" tag next to a version. Rendered as the trigger of
 * the update popover; it never animates.
 */
export function AgentUpdateTag({
  version,
  className,
  ...props
}: { readonly version: string } & ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded px-1 py-px font-mono text-[10.5px] text-primary-readable transition-colors",
        "bg-primary-readable/12 hover:bg-primary-readable/22 focus-ring",
        className,
      )}
      aria-label={`Update available: ${version}`}
      {...props}
    >
      <ArrowUpIcon className="size-3" aria-hidden />
      {version.replace(/^v/, "")}
    </button>
  );
}
