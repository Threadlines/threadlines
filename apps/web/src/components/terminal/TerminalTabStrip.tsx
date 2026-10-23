import { PlusIcon, XIcon } from "lucide-react";
import { Fragment } from "react";

import { cn } from "~/lib/utils";
import { MINI_HORIZONTAL_SCROLLBAR_CLASS } from "../ui/scroll-area";
import { TooltipWrapper } from "../ui/tooltip";

/** One tab as the strip shows it. */
export interface TerminalStripTab {
  readonly terminalId: string;
  /** "Terminal 2": the number stays while the tab exists. */
  readonly label: string;
  readonly running: boolean;
  /** What runs in it, when that is known. */
  readonly command: string | null;
  /** How its shell ended, while it stays to be read. */
  readonly exit: { readonly code: number | null; readonly signal: number | null } | null;
  /** Where its shell started, for the tooltip. */
  readonly cwd: string | null;
}

export function describeTerminalExit(exit: {
  readonly code: number | null;
  readonly signal: number | null;
}): string {
  if (exit.signal) return `stopped by signal ${exit.signal}`;
  return exit.code === null ? "exited" : `exited ${exit.code}`;
}

/**
 * The terminal drawer's tabs, in the browser-tab look the right panel uses:
 * the active tab lifted onto the terminal's own background, the rest plain.
 * Tabs split side by side sit together; a dot marks a tab with something
 * running, followed by what runs; a tab whose shell failed says how it
 * ended. The ✕ (kill) shows on hover, always on touch screens, and its room
 * is always kept, as the browser panel's tabs do, so a tab never changes
 * width under the pointer. `+` opens a new tab. Too many tabs scroll.
 */
export function TerminalTabStrip({
  groups,
  activeTerminalId,
  onSelect,
  onClose,
  onNew,
  newLabel,
}: {
  /** Tabs by split group, in drawer order. */
  groups: ReadonlyArray<ReadonlyArray<TerminalStripTab>>;
  activeTerminalId: string;
  onSelect: (terminalId: string) => void;
  onClose: (terminalId: string) => void;
  onNew: () => void;
  newLabel: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-stretch">
      <div
        role="tablist"
        aria-label="Terminal tabs"
        className={cn(
          "flex min-w-0 shrink items-stretch gap-px overflow-x-auto",
          MINI_HORIZONTAL_SCROLLBAR_CLASS,
        )}
      >
        {groups.map((group, groupIndex) => (
          <Fragment key={group[0]?.terminalId ?? groupIndex}>
            {groupIndex > 0 ? (
              <span aria-hidden="true" className="mx-0.5 w-px self-center bg-border py-2" />
            ) : null}
            {group.map((tab) => (
              <TerminalTabButton
                key={tab.terminalId}
                tab={tab}
                active={tab.terminalId === activeTerminalId}
                onSelect={onSelect}
                onClose={onClose}
              />
            ))}
          </Fragment>
        ))}
      </div>
      <TooltipWrapper delay={0} side="bottom" tooltip={newLabel}>
        <button
          type="button"
          aria-label={newLabel}
          className="ms-0.5 inline-flex size-6 shrink-0 items-center justify-center self-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring pointer-coarse:size-8"
          onClick={onNew}
        >
          <PlusIcon className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipWrapper>
    </div>
  );
}

function TerminalTabButton({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: TerminalStripTab;
  active: boolean;
  onSelect: (terminalId: string) => void;
  onClose: (terminalId: string) => void;
}) {
  const tooltipLines = [
    tab.command ? `${tab.label}: ${tab.command}` : tab.label,
    tab.cwd ? `Started in ${tab.cwd}` : null,
    tab.exit ? `Its shell ${describeTerminalExit(tab.exit)}` : null,
  ].filter((line): line is string => line !== null);
  const tooltip = (
    <div className="space-y-0.5">
      {tooltipLines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
  return (
    <TooltipWrapper delay={400} side="bottom" tooltip={tooltip}>
      <div
        role="presentation"
        className={cn(
          "group/terminal-tab relative flex max-w-64 shrink-0 items-center rounded-t-md text-xs",
          "pr-6 pl-2",
          active
            ? "bg-background text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        data-terminal-tab={tab.terminalId}
        data-active={active ? "true" : undefined}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          onClose(tab.terminalId);
        }}
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={active}
          className="flex min-w-0 items-center gap-1.5 py-1 focus-ring"
          onClick={() => onSelect(tab.terminalId)}
        >
          {tab.running ? (
            <span
              aria-label="Running"
              role="img"
              className="size-1.5 shrink-0 rounded-full bg-success"
            />
          ) : null}
          <span className="shrink-0 whitespace-nowrap">{tab.label}</span>
          {tab.command ? (
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
              {tab.command}
            </span>
          ) : null}
          {tab.exit ? (
            <span className="shrink-0 font-mono text-[11px] text-destructive-foreground">
              {describeTerminalExit(tab.exit)}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          aria-label={`Kill ${tab.label}`}
          className={cn(
            "absolute top-1/2 right-1 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-[opacity,background-color,color] hover:bg-foreground/10 hover:text-foreground focus-ring pointer-coarse:size-6",
            "can-hover:opacity-0 group-hover/terminal-tab:opacity-100 focus-visible:opacity-100",
          )}
          onClick={() => onClose(tab.terminalId)}
        >
          <XIcon className="size-3" aria-hidden="true" />
        </button>
      </div>
    </TooltipWrapper>
  );
}
