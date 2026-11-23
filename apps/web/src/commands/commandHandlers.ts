/**
 * Who can do each command right now (docs/design/command-palette.md,
 * section 2). Whoever owns a behavior registers a handler for its command
 * with `useCommandHandlers`; a command with no handler is not offered.
 *
 * Two halves, kept apart on purpose:
 *
 * - What the palette sees (title, description, flags, a list's items) is
 *   compared with the last version on every commit of the owner, and
 *   published only when it differs. An owner that re-renders on every
 *   streamed token publishes nothing, so the open palette does not redraw.
 * - What runs (`run`, a list item's `run`) is replaced on every commit and
 *   read at the moment of use, by id, so it is never stale.
 *
 * A handler is the guarded way in: the function its button or shortcut ends
 * in, never the bare action behind it, and registered only while that path
 * would act. This module loads at startup with its owners, so it imports only
 * the catalog's types.
 */
import type { AppCommandId } from "@threadlines/shared/appCommands";
import { useId, useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";

/** "cancelled": the user said no (a confirmation, a closed dialog), so it doesn't count as use. */
export type CommandRunResult = void | "cancelled";
export type CommandRun = () => CommandRunResult | Promise<CommandRunResult>;

/** One row of a list command (a project, a theme, a script, a computer). */
export interface CommandListItem {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly keywords?: ReadonlyArray<string> | undefined;
  /** The heading it sits under on the list page. */
  readonly group?: string | undefined;
  /** Drawn beside it. Not compared: derive it from the item, not from render state. */
  readonly icon?: ReactNode;
  readonly run: CommandRun;
}

interface CommandHandlerBase {
  /** Replaces the catalog's title ("Hide sidebar", "Open pull request #12"). */
  readonly title?: string | undefined;
  /** Shown in bold after the title ("New thread in **Project**"). */
  readonly titleEmphasis?: string | undefined;
  /** Replaces the catalog's `about`. */
  readonly description?: string | undefined;
  /** Words that find it besides the catalog's (a project name, "#12"). */
  readonly keywords?: ReadonlyArray<string> | undefined;
  /** Shown, but not run. */
  readonly disabledReason?: string | undefined;
  /** Works inside the palette, which stays open. */
  readonly keepOpen?: boolean | undefined;
  /** Needs focus back in the page first: runs one frame after the palette closes. */
  readonly afterFocusReturns?: boolean | undefined;
  /** Opens another dialog, which owns where focus goes when it closes. */
  readonly opensDialog?: boolean | undefined;
}

export interface CommandActionHandler extends CommandHandlerBase {
  readonly run: CommandRun;
  readonly items?: undefined;
}

export interface CommandListHandler extends CommandHandlerBase {
  /** Memoize it: an unchanged array is one comparison. */
  readonly items: ReadonlyArray<CommandListItem>;
  readonly run?: undefined;
  /** The list page's field placeholder. */
  readonly placeholder?: string | undefined;
}

export type CommandHandler = CommandActionHandler | CommandListHandler;

/** A falsy entry means "not offered right now". */
export type CommandHandlerMap = {
  readonly [Id in AppCommandId]?: CommandHandler | null | false | undefined;
};

/** What the palette sees of a list item: everything but its `run`. */
export interface OfferedListItem {
  readonly id: string;
  readonly title: string;
  readonly description: string | undefined;
  readonly disabled: boolean;
  readonly keywords: ReadonlyArray<string> | undefined;
  readonly group: string | undefined;
  readonly icon: ReactNode;
}

/** What the palette sees of an offered command: everything but its functions. */
export interface OfferedCommand {
  readonly id: AppCommandId;
  readonly title: string | undefined;
  readonly titleEmphasis: string | undefined;
  readonly description: string | undefined;
  readonly keywords: ReadonlyArray<string> | undefined;
  readonly disabledReason: string | undefined;
  readonly keepOpen: boolean;
  readonly afterFocusReturns: boolean;
  readonly opensDialog: boolean;
  readonly placeholder: string | undefined;
  /** Null for an action; a list command's current items. */
  readonly items: ReadonlyArray<OfferedListItem> | null;
}

interface Slot {
  /** Later registrations win when two owners register the same command. */
  readonly order: number;
  handlers: CommandHandlerMap;
  offered: ReadonlyMap<AppCommandId, OfferedCommand>;
  /** The raw items each list was last described from, to skip comparing an unchanged array. */
  itemsSource: ReadonlyMap<AppCommandId, ReadonlyArray<CommandListItem>>;
}

const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();
let nextOrder = 0;
let snapshot: ReadonlyMap<AppCommandId, OfferedCommand> = new Map();

function sameStrings(
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function describeItem(
  item: CommandListItem,
  previous: OfferedListItem | undefined,
): OfferedListItem {
  const disabled = item.disabled === true;
  if (
    previous &&
    previous.id === item.id &&
    previous.title === item.title &&
    previous.description === item.description &&
    previous.disabled === disabled &&
    previous.group === item.group &&
    sameStrings(previous.keywords, item.keywords)
  ) {
    return previous;
  }
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    disabled,
    keywords: item.keywords,
    group: item.group,
    icon: item.icon,
  };
}

function describeItems(
  items: ReadonlyArray<CommandListItem>,
  previous: ReadonlyArray<OfferedListItem> | null | undefined,
): ReadonlyArray<OfferedListItem> {
  const described = items.map((item, index) => describeItem(item, previous?.[index]));
  return previous &&
    previous.length === described.length &&
    described.every((item, index) => item === previous[index])
    ? previous
    : described;
}

function describe(
  id: AppCommandId,
  handler: CommandHandler,
  previous: OfferedCommand | undefined,
  previousItemsSource: ReadonlyArray<CommandListItem> | undefined,
): OfferedCommand {
  const items =
    handler.items === undefined
      ? null
      : handler.items === previousItemsSource && previous?.items
        ? previous.items
        : describeItems(handler.items, previous?.items);
  const next: OfferedCommand = {
    id,
    title: handler.title,
    titleEmphasis: handler.titleEmphasis,
    description: handler.description,
    keywords: handler.keywords,
    disabledReason: handler.disabledReason,
    keepOpen: handler.keepOpen === true,
    afterFocusReturns: handler.afterFocusReturns === true,
    opensDialog: handler.opensDialog === true,
    placeholder: handler.items === undefined ? undefined : handler.placeholder,
    items,
  };
  if (
    previous &&
    previous.title === next.title &&
    previous.titleEmphasis === next.titleEmphasis &&
    previous.description === next.description &&
    sameStrings(previous.keywords, next.keywords) &&
    previous.disabledReason === next.disabledReason &&
    previous.keepOpen === next.keepOpen &&
    previous.afterFocusReturns === next.afterFocusReturns &&
    previous.opensDialog === next.opensDialog &&
    previous.placeholder === next.placeholder &&
    previous.items === next.items
  ) {
    return previous;
  }
  return next;
}

function rebuildSnapshot(): void {
  const owners = [...slots.values()].toSorted((left, right) => left.order - right.order);
  const next = new Map<AppCommandId, OfferedCommand>();
  for (const slot of owners) {
    for (const [id, offered] of slot.offered) next.set(id, offered);
  }
  // A change the palette can't see (an owner of nothing leaving, a handler
  // shadowed by a newer owner) keeps the old snapshot and tells no one.
  if (
    next.size === snapshot.size &&
    [...next].every(([id, offered]) => snapshot.get(id) === offered)
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

/**
 * Records an owner's handlers. The functions are kept every time; the
 * palette hears about it only when what it shows changed.
 */
export function publishCommandHandlers(slotKey: string, handlers: CommandHandlerMap): void {
  let slot = slots.get(slotKey);
  if (!slot) {
    slot = { order: nextOrder++, handlers, offered: new Map(), itemsSource: new Map() };
    slots.set(slotKey, slot);
  }
  slot.handlers = handlers;
  const offered = new Map<AppCommandId, OfferedCommand>();
  const itemsSource = new Map<AppCommandId, ReadonlyArray<CommandListItem>>();
  let changed = false;
  for (const id of Object.keys(handlers) as AppCommandId[]) {
    const handler = handlers[id];
    if (!handler) continue;
    const previous = slot.offered.get(id);
    const described = describe(id, handler, previous, slot.itemsSource.get(id));
    if (described !== previous) changed = true;
    offered.set(id, described);
    if (handler.items !== undefined) itemsSource.set(id, handler.items);
  }
  if (offered.size !== slot.offered.size) changed = true;
  slot.itemsSource = itemsSource;
  if (!changed) return;
  slot.offered = offered;
  rebuildSnapshot();
}

export function withdrawCommandHandlers(slotKey: string): void {
  if (!slots.delete(slotKey)) return;
  rebuildSnapshot();
}

function ownerOf(id: AppCommandId): Slot | null {
  let owner: Slot | null = null;
  for (const slot of slots.values()) {
    if (slot.offered.has(id) && (owner === null || slot.order > owner.order)) owner = slot;
  }
  return owner;
}

/** The handler offered for a command now, read when it is used; null when it is gone. */
export function resolveCommandHandler(id: AppCommandId): CommandHandler | null {
  return ownerOf(id)?.handlers[id] || null;
}

/** A list command's item now, by id; null when the list or the item is gone. */
export function resolveCommandListItem(id: AppCommandId, itemId: string): CommandListItem | null {
  const handler = resolveCommandHandler(id);
  if (!handler?.items) return null;
  return handler.items.find((item) => item.id === itemId) ?? null;
}

/** Hears every change to what is offered; the palette subscribes through `useOfferedCommands`. */
export function subscribeOfferedCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getOfferedCommands(): ReadonlyMap<AppCommandId, OfferedCommand> {
  return snapshot;
}

/**
 * Registers this component's commands for as long as it is mounted. Pass a
 * new object every render if that is easiest: only what the palette shows is
 * compared, and only a difference reaches it.
 */
export function useCommandHandlers(handlers: CommandHandlerMap): void {
  const slotKey = useId();
  useLayoutEffect(() => {
    publishCommandHandlers(slotKey, handlers);
  });
  useLayoutEffect(() => () => withdrawCommandHandlers(slotKey), [slotKey]);
}

/** The commands offered now; re-renders only when one is added, removed or relabeled. */
export function useOfferedCommands(): ReadonlyMap<AppCommandId, OfferedCommand> {
  return useSyncExternalStore(subscribeOfferedCommands, getOfferedCommands, getOfferedCommands);
}

/** Tests only: forgets every registration. */
export function resetCommandHandlersForTests(): void {
  slots.clear();
  snapshot = new Map();
  for (const listener of listeners) listener();
}
