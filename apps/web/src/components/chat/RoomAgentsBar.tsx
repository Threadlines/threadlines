/**
 * The top of the model picker in a thread that can hold more agents: one pill
 * per agent, the picked one being who the next message goes to. The model
 * list and settings under it are that agent's. Picking a pill keeps the
 * picker open, so its model and effort can be changed in the same visit.
 * "+" adds an agent: the next model picked joins as a new one.
 *
 * A pill holds only its icon, name and "main" tag. Pointing at one swaps the
 * icon for a ⋯ button in the same box, which opens Rename, Make main agent and
 * Remove; so do a right-click and, on touch, a long press. Nothing appears
 * beside the name, so a pill never changes size under the pointer: one that
 * grew could wrap to the next line, out from under it, and flicker between the
 * two.
 */
import { ROOM_AGENT_ROLE_MAX_LENGTH } from "@threadlines/contracts";
import { EllipsisIcon, UserRoundPlusIcon, XIcon } from "lucide-react";
import { memo, useCallback, useRef, useState } from "react";
import type * as React from "react";

import { cn } from "~/lib/utils";
import { useTouchHoldMenu } from "../../hooks/useTouchHoldMenu";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { failureNotice, toastManager } from "../ui/toast";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { roomAgentKey } from "../../rooms";
import type { RoomAgentRow, RoomAgents } from "./useRoomAgents";
import { providerInstanceShowsBadge } from "../../providerInstances";
import { THREAD_STATUS_DOT_CLASSES } from "../Sidebar.logic";

const PILL_CLASS =
  "group/agent relative flex h-7 min-w-0 max-w-48 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-9 pointer-coarse:text-sm";

type PillStep = 1 | -1 | "first" | "last";

const PILL_ARROW_STEPS: Partial<Record<string, PillStep>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
  Home: "first",
  End: "last",
};

/** The "New agent" pill's ×. */
const PILL_ACTION_CLASS =
  "rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:text-foreground pointer-coarse:p-1.5";

/** The icon's box, which the ⋯ shares. */
const PILL_ICON_SIZE = "size-3.5 pointer-coarse:size-4";

export const RoomAgentsBar = memo(function RoomAgentsBar(props: {
  agents: RoomAgents;
  /** "+" was picked: the list below adds its pick as a new agent. */
  adding: boolean;
  onStartAdding: () => void;
  onCancelAdding: () => void;
}) {
  const { agents } = props;
  /** The pill being renamed, by `roomAgentKey`. */
  const [renaming, setRenaming] = useState<string | null>(null);

  const failed = (title: `Couldn't ${string}`) => (error: unknown) =>
    toastManager.add(failureNotice({ title, error }));
  const rename = (row: RoomAgentRow, typed: string) => {
    setRenaming(null);
    void agents.rename(row, typed).catch(failed(`Couldn't rename ${row.modelName}`));
  };
  const remove = (row: RoomAgentRow) => {
    void agents.remove(row).catch(failed(`Couldn't remove ${row.name}`));
  };
  const makeMain = (row: RoomAgentRow) => {
    void agents.makeMain(row).catch(failed(`Couldn't make ${row.name} main`));
  };
  // Picking an agent while adding one means "not a new one after all".
  const choose = (row: RoomAgentRow) => {
    if (props.adding) props.onCancelAdding();
    agents.choose(row.id);
  };

  if (!agents.inRoom && !props.adding) {
    // Only the thread's own agent: the bar is just the way in.
    return agents.editable ? (
      <div className="flex shrink-0 items-center border-b border-border px-1.5 py-1">
        <button
          type="button"
          data-room-add-agent="true"
          className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent pointer-coarse:h-10 pointer-coarse:text-sm"
          onClick={props.onStartAdding}
        >
          <UserRoundPlusIcon aria-hidden="true" className="size-3.5 shrink-0" />
          Add agent
          <span className="ms-auto truncate font-normal text-muted-foreground/70">
            Bring another model into this thread
          </span>
        </button>
      </div>
    ) : null;
  }

  return (
    <div
      data-room-agents-bar="true"
      className="flex shrink-0 items-start gap-1 border-b border-border px-1.5 py-1.5"
    >
      {/* Pills wrap onto more lines rather than scroll: every agent stays in
          view, and "+" keeps its place at the end of the first line. */}
      <div
        role="radiogroup"
        aria-label="Send to"
        className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
      >
        {agents.rows.map((row, index) => {
          const selected = !props.adding && row.id === agents.recipient.id;
          const isRenaming = renaming === roomAgentKey(row.id);
          return (
            <AgentPill
              key={row.id ?? "primary"}
              row={row}
              selected={selected}
              // One tab stop for the group: the picked pill, or the first while adding.
              tabStop={props.adding ? index === 0 : selected}
              isRenaming={isRenaming}
              hasMenu={agents.editable && !props.adding}
              onChoose={() => choose(row)}
              onStep={(step, pill) => {
                // Like any radio group: arrows move and pick, wrapping round.
                const count = agents.rows.length;
                const next =
                  step === "first"
                    ? 0
                    : step === "last"
                      ? count - 1
                      : (index + step + count) % count;
                const nextRow = agents.rows[next];
                if (!nextRow) return;
                choose(nextRow);
                pill.parentElement
                  ?.querySelector<HTMLElement>(`[data-room-agent-row="${nextRow.id ?? "primary"}"]`)
                  ?.focus();
              }}
              onStartRename={() => setRenaming(roomAgentKey(row.id))}
              onRename={(typed) => rename(row, typed)}
              onMakeMain={() => makeMain(row)}
              onRemove={() => remove(row)}
            />
          );
        })}
        {props.adding ? (
          <div
            data-room-agent-row="new"
            aria-checked={true}
            role="radio"
            className={cn(
              PILL_CLASS,
              "cursor-default text-foreground outline-1 -outline-offset-1 outline-dashed outline-foreground/30",
            )}
          >
            <UserRoundPlusIcon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="font-medium">New agent</span>
            <button
              type="button"
              aria-label="Stop adding an agent"
              className={PILL_ACTION_CLASS}
              onClick={props.onCancelAdding}
            >
              <XIcon aria-hidden="true" className="size-3" />
            </button>
          </div>
        ) : null}
      </div>
      {!props.adding && agents.editable ? (
        <button
          type="button"
          data-room-add-agent="true"
          aria-label="Add agent"
          title="Add agent"
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-9"
          onClick={props.onStartAdding}
        >
          <UserRoundPlusIcon aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
});

/**
 * One agent's pill. Its menu (Rename, Make main agent, Remove) opens from the
 * ⋯ that takes the icon's place under the pointer or keyboard focus, from a
 * right-click, or from a long press on touch, and always drops from the pill's
 * left edge.
 */
function AgentPill(props: {
  row: RoomAgentRow;
  selected: boolean;
  tabStop: boolean;
  isRenaming: boolean;
  /** The user may rename, promote and remove agents here (not while adding one). */
  hasMenu: boolean;
  onChoose: () => void;
  onStep: (step: PillStep, pill: HTMLElement) => void;
  onStartRename: () => void;
  onRename: (typed: string) => void;
  onMakeMain: () => void;
  onRemove: () => void;
}) {
  const { row, selected, isRenaming, hasMenu } = props;
  const pillRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Rename from the menu: the menu must not take focus back from the name box.
  const renameFromMenu = useRef(false);
  const busy = row.status !== null;
  const canEdit = hasMenu && !isRenaming;
  // Events from the menu reach the pill through React's tree, though the menu
  // sits elsewhere on the page: only the pill's own count as touching it.
  const onPill = (event: React.SyntheticEvent) =>
    event.currentTarget.contains(event.target as Node);

  // A held finger opened the menu, which came up under it: when it lifts, the
  // browser's mouse press at that spot lands outside the menu and would close
  // it. Set from the hold until the finger has been up for a moment.
  const hold = useRef<{ liftedAt: number | null } | null>(null);
  const holdStillDown = () => {
    const liftedAt = hold.current?.liftedAt;
    return liftedAt === null || (liftedAt !== undefined && performance.now() - liftedAt < 400);
  };
  const openFromHold = useCallback(() => {
    hold.current = { liftedAt: null };
    setMenuOpen(true);
  }, []);
  const onContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.target as Node)) return;
      event.preventDefault();
      if (!canEdit) return;
      // Android sends this for a held finger, ahead of the hold's own timer.
      hold.current =
        (event.nativeEvent as PointerEvent).pointerType === "touch" ? { liftedAt: null } : null;
      setMenuOpen(true);
    },
    [canEdit],
  );
  const touchHold = useTouchHoldMenu<HTMLDivElement>({ open: openFromHold, onContextMenu });
  const lift = () => {
    if (hold.current?.liftedAt === null) hold.current.liftedAt = performance.now();
  };
  const pillTouchHold = {
    ...touchHold,
    // A new press ends the hold. One on the open menu is the menu's own: timed
    // as another hold on the pill, it would swallow the tap on Rename or Remove.
    onPointerDownCapture: (event: React.PointerEvent<HTMLDivElement>) => {
      hold.current = null;
      touchHold.onPointerDownCapture(event);
      if (!onPill(event)) touchHold.onPointerCancel();
    },
    onPointerUp: () => {
      lift();
      touchHold.onPointerUp();
    },
    onPointerCancel: () => {
      lift();
      touchHold.onPointerCancel();
    },
  };

  return (
    <div
      ref={pillRef}
      role="radio"
      aria-checked={selected}
      tabIndex={props.tabStop ? 0 : -1}
      data-room-agent-row={row.id ?? "primary"}
      data-menu-open={menuOpen || undefined}
      title={row.isMain ? `${row.name}, the thread's main agent` : row.name}
      className={cn(
        PILL_CLASS,
        selected
          ? "bg-control text-foreground shadow-(--control-shadow)"
          : // The menu's backdrop takes the hover: the open menu keeps the fill.
            "text-muted-foreground hover:bg-accent hover:text-foreground data-menu-open:bg-accent data-menu-open:text-foreground",
      )}
      {...(canEdit ? pillTouchHold : {})}
      onClick={(event) => {
        if (onPill(event)) props.onChoose();
      }}
      onDoubleClick={(event) => {
        if (onPill(event) && canEdit) props.onStartRename();
      }}
      onKeyDown={(event) => {
        // Keys on the pill's ⋯, its menu and its name box are theirs.
        if (event.target !== event.currentTarget) return;
        const step = PILL_ARROW_STEPS[event.key];
        if (step !== undefined) {
          event.preventDefault();
          props.onStep(step, event.currentTarget);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onChoose();
        } else if (event.key === "F2" && canEdit) {
          event.preventDefault();
          props.onStartRename();
        } else if ((event.key === "Delete" || event.key === "Backspace") && canEdit) {
          if (row.id !== null && !row.isMain && !busy) {
            event.preventDefault();
            props.onRemove();
          }
        }
      }}
    >
      {row.entry || hasMenu ? (
        <span className="relative flex shrink-0">
          {row.entry ? (
            <span
              className={cn(
                "flex",
                // Swapped for the ⋯ where there's a pointer to point with.
                canEdit &&
                  "group-hover/agent:invisible group-focus-visible/agent:invisible group-has-focus-visible/agent:invisible group-data-menu-open/agent:invisible",
              )}
            >
              <ProviderInstanceIcon
                instanceId={row.entry.instanceId}
                driverKind={row.entry.driverKind}
                displayName={row.entry.displayName}
                accentColor={row.entry.accentColor}
                // An extra account wears its letter, so two accounts on one
                // model can be told apart.
                showBadge={providerInstanceShowsBadge(row.entry)}
                badgeClassName="right-[-0.3rem] bottom-[-0.2rem] h-2.5 min-w-2.5 px-0 text-[6px] shadow-none"
                className={PILL_ICON_SIZE}
                iconClassName={PILL_ICON_SIZE}
              />
            </span>
          ) : (
            <span aria-hidden="true" className={PILL_ICON_SIZE} />
          )}
          {/* Mounted while the name box is open too: a menu that unmounted
              as Rename opened it would pull focus back from the box. */}
          {hasMenu ? (
            <Menu
              open={menuOpen}
              onOpenChange={(open, details) => {
                // The finger that held the pill, lifting. Its press must not
                // close the menu, nor take the keyboard focus out of it:
                // Escape would then close the picker around the menu instead.
                if (!open && details.reason === "outside-press" && holdStillDown()) {
                  details.cancel();
                  details.event.preventDefault();
                  return;
                }
                setMenuOpen(open);
              }}
            >
              <MenuTrigger
                render={
                  <button
                    type="button"
                    aria-label={`${row.name} options`}
                    className={cn(
                      "absolute inset-0 flex items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground",
                      // Hidden, it can't be focused or tapped; a touch screen
                      // reaches the menu by a long press instead.
                      "invisible",
                      canEdit &&
                        "group-hover/agent:visible group-focus-visible/agent:visible group-has-focus-visible/agent:visible group-data-menu-open/agent:visible",
                      // Open, a faint fill 2px past the box, outside the layout.
                      "before:absolute before:-inset-0.5 before:rounded-sm data-popup-open:text-foreground data-popup-open:before:bg-foreground/10",
                    )}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  />
                }
              >
                <EllipsisIcon aria-hidden="true" className={cn("relative", PILL_ICON_SIZE)} />
              </MenuTrigger>
              <MenuPopup
                anchor={pillRef}
                align="start"
                finalFocus={() => {
                  const keepFocus = renameFromMenu.current;
                  renameFromMenu.current = false;
                  // Back to the pill: the ⋯ may be hidden again by now.
                  return keepFocus ? false : pillRef.current;
                }}
              >
                <MenuItem
                  onClick={() => {
                    renameFromMenu.current = true;
                    props.onStartRename();
                  }}
                >
                  Rename…
                </MenuItem>
                {!row.isMain ? (
                  <MenuItem onClick={props.onMakeMain}>Make main agent</MenuItem>
                ) : null}
                {row.id !== null && !row.isMain ? (
                  // A working agent can't leave yet: the server refuses it.
                  <MenuItem disabled={busy} onClick={props.onRemove}>
                    Remove from thread
                  </MenuItem>
                ) : null}
              </MenuPopup>
            </Menu>
          ) : null}
          {busy ? (
            // "working" reads blue, like the sidebar; amber is for warnings.
            <span
              data-room-agent-working="true"
              className={cn(
                "pointer-events-none absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full",
                THREAD_STATUS_DOT_CLASSES.blue,
              )}
            />
          ) : null}
        </span>
      ) : null}
      {isRenaming ? (
        // The model's name stays; the user names the agent after it.
        <input
          autoFocus
          aria-label={`Name for ${row.modelName}`}
          defaultValue={row.role ?? ""}
          placeholder="Name"
          size={1}
          maxLength={ROOM_AGENT_ROLE_MAX_LENGTH}
          className="field-sizing-content h-5 min-w-16 max-w-32 rounded-sm border border-border bg-transparent px-1.5 text-xs outline-none focus:border-ring"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              event.currentTarget.value = row.role ?? "";
              event.currentTarget.blur();
            } else if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          onBlur={(event) => props.onRename(event.currentTarget.value)}
        />
      ) : (
        <span className="min-w-0 truncate font-medium">{row.role ?? row.modelName}</span>
      )}
      {row.isMain && !isRenaming ? (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">main</span>
      ) : null}
    </div>
  );
}
