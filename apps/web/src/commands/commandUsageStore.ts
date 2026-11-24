/**
 * Which commands this device uses, for the palette's Suggested group
 * (docs/design/command-palette.md, section 6). Per command id, and per list
 * item as `<command>:<item>`: a count and when it was last used. Kept on this
 * device only, never sent anywhere.
 */
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";

export const COMMAND_USAGE_STORAGE_KEY = "threadlines:command-usage:v1";
/** Enough for every command and a few list items each; the oldest go first. */
const MAX_ENTRIES = 200;

const CommandUsageEntry = Schema.Struct({ count: Schema.Number, lastUsedAt: Schema.Number });
const CommandUsageRecord = Schema.Record(Schema.String, CommandUsageEntry);
export type CommandUsageEntry = typeof CommandUsageEntry.Type;
type CommandUsageRecord = typeof CommandUsageRecord.Type;

function readRecord(): CommandUsageRecord {
  try {
    return getLocalStorageItem(COMMAND_USAGE_STORAGE_KEY, CommandUsageRecord) ?? {};
  } catch {
    return {};
  }
}

interface CommandUsageState {
  readonly byKey: CommandUsageRecord;
  readonly recordUse: (key: string, now?: number) => void;
}

export const useCommandUsageStore = create<CommandUsageState>()((set) => ({
  byKey: readRecord(),
  recordUse: (key, now = Date.now()) =>
    set((state) => {
      const previous = state.byKey[key];
      const entries = Object.entries({
        ...state.byKey,
        [key]: { count: (previous?.count ?? 0) + 1, lastUsedAt: now },
      })
        .toSorted((left, right) => right[1].lastUsedAt - left[1].lastUsedAt)
        .slice(0, MAX_ENTRIES);
      const byKey = Object.fromEntries(entries);
      try {
        setLocalStorageItem(COMMAND_USAGE_STORAGE_KEY, byKey, CommandUsageRecord);
      } catch {
        // A full or blocked storage keeps this session's counts only.
      }
      return { byKey };
    }),
}));

/** The usage key of a command, or of one item of a list command. */
export function commandUsageKey(commandId: string, itemId?: string): string {
  return itemId === undefined ? commandId : `${commandId}:${itemId}`;
}

/**
 * Up to `limit` of `candidates`, most used first (ties to the most recent),
 * then `fallback` in its own order to fill the rest. Only candidates count:
 * a command not offered now is never suggested.
 */
export function suggestCommands<Id extends string>(input: {
  readonly candidates: ReadonlyArray<Id>;
  readonly usage: CommandUsageRecord;
  readonly fallback: ReadonlyArray<Id>;
  readonly limit: number;
}): Id[] {
  const offered = new Set(input.candidates);
  const used = input.candidates
    .filter((id) => input.usage[id] !== undefined)
    .toSorted((left, right) => {
      const a = input.usage[left]!;
      const b = input.usage[right]!;
      return b.count - a.count || b.lastUsedAt - a.lastUsedAt;
    });
  const picked = used.slice(0, input.limit);
  for (const id of input.fallback) {
    if (picked.length >= input.limit) break;
    if (offered.has(id) && !picked.includes(id)) picked.push(id);
  }
  return picked;
}
