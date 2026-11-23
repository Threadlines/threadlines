/**
 * Running an offered command from the palette, in today's order: resolve the
 * row again by id against the current handlers and take its function, close
 * unless it keeps the palette open, then run it in the same tick, or one
 * frame later for a command that needs focus back in the page first. A run
 * that resolves to "cancelled" is not counted as use.
 */
import type { AppCommandId } from "@threadlines/shared/appCommands";

import {
  resolveCommandHandler,
  resolveCommandListItem,
  type CommandRun,
  type CommandRunResult,
} from "./commandHandlers";
import { commandUsageKey } from "./commandUsageStore";

export type CommandRunOutcome =
  /** The row is gone, or shown disabled: nothing happened. */
  | "unavailable"
  /** A list command: the caller opens its page. */
  | "list"
  | "ran";

export interface RunCommandInput {
  readonly id: AppCommandId;
  /** An item of a list command. */
  readonly itemId?: string | undefined;
  /** Closes the palette. `handingOver`: another dialog owns where focus goes. */
  readonly close: (options: { readonly handingOver: boolean }) => void;
  readonly recordUse: (key: string) => void;
  readonly onError: (error: unknown) => void;
  /** One frame later, for commands that wait for focus to come back. */
  readonly nextFrame?: (callback: () => void) => void;
}

export function runCommand(input: RunCommandInput): CommandRunOutcome {
  const handler = resolveCommandHandler(input.id);
  if (!handler || handler.disabledReason !== undefined) return "unavailable";

  let run: CommandRun;
  if (input.itemId === undefined) {
    if (handler.items !== undefined) return "list";
    run = handler.run;
  } else {
    const item = resolveCommandListItem(input.id, input.itemId);
    if (!item || item.disabled) return "unavailable";
    run = item.run;
  }

  if (!handler.keepOpen) input.close({ handingOver: handler.opensDialog === true });
  const settle = (result: CommandRunResult | Promise<CommandRunResult>) => {
    void Promise.resolve(result).then(
      (outcome) => {
        if (outcome === "cancelled") return;
        // An item counts for its list too, so a script run every day brings
        // "Run script…" into Suggested.
        input.recordUse(input.id);
        if (input.itemId !== undefined) input.recordUse(commandUsageKey(input.id, input.itemId));
      },
      (error: unknown) => input.onError(error),
    );
  };
  const start = () => {
    try {
      settle(run());
    } catch (error) {
      input.onError(error);
    }
  };
  if (handler.afterFocusReturns) {
    (input.nextFrame ?? ((callback) => window.requestAnimationFrame(callback)))(start);
  } else {
    start();
  }
  return "ran";
}
