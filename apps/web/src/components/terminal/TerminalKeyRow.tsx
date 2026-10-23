import { cn } from "~/lib/utils";

/** Keys a phone's keyboard lacks, as the bytes a terminal sends for them. */
export const TERMINAL_EXTRA_KEYS: ReadonlyArray<{
  readonly label: string;
  readonly name: string;
  readonly data: string | null;
}> = [
  { label: "esc", name: "Escape", data: "\u001b" },
  { label: "tab", name: "Tab", data: "\t" },
  { label: "ctrl", name: "Control", data: null },
  { label: "←", name: "Left arrow", data: "\u001b[D" },
  { label: "↑", name: "Up arrow", data: "\u001b[A" },
  { label: "↓", name: "Down arrow", data: "\u001b[B" },
  { label: "→", name: "Right arrow", data: "\u001b[C" },
  { label: "^C", name: "Stop (Control C)", data: "\u0003" },
];

/**
 * What a key typed right after the sticky Ctrl sends: its control code for
 * a letter or one of `@[\]^_`, else the key itself.
 */
export function controlCodeFor(data: string): string {
  if (data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code - 0x40) : data;
}

/**
 * The row of keys under the terminal on touch screens: Escape, Tab, a sticky
 * Ctrl for the next key typed, the arrows, and Ctrl+C. Pressing one never
 * takes focus from the terminal, so the keyboard stays up.
 */
export function TerminalKeyRow({
  ctrlArmed,
  onKey,
  onToggleCtrl,
}: {
  ctrlArmed: boolean;
  onKey: (data: string) => void;
  onToggleCtrl: () => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border px-2 py-1"
      data-terminal-key-row="true"
    >
      {TERMINAL_EXTRA_KEYS.map((key) => {
        const isCtrl = key.data === null;
        return (
          <button
            key={key.name}
            type="button"
            aria-label={key.name}
            aria-pressed={isCtrl ? ctrlArmed : undefined}
            className={cn(
              "inline-flex h-8 min-w-10 shrink-0 items-center justify-center rounded-md px-2 font-mono text-xs transition-colors",
              isCtrl && ctrlArmed
                ? "bg-control-active text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            // Keeps the terminal focused (and the keyboard open) under the tap.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (key.data === null) {
                onToggleCtrl();
                return;
              }
              onKey(key.data);
            }}
          >
            {key.label}
          </button>
        );
      })}
    </div>
  );
}
