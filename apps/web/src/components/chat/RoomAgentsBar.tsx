/**
 * The top of the model picker in a thread that can hold more agents: one pill
 * per agent, the picked one being who the next message goes to. The model
 * list and settings under it are that agent's. Picking a pill keeps the
 * picker open, so its model and effort can be changed in the same visit.
 * "+" adds an agent: the next model picked joins as a new one.
 */
import { ROOM_AGENT_ROLE_MAX_LENGTH } from "@threadlines/contracts";
import { PencilIcon, UserRoundPlusIcon, XIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { failureNotice, toastManager } from "../ui/toast";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { roomAgentKey } from "../../rooms";
import type { RoomAgentRow, RoomAgents } from "./useRoomAgents";
import { providerInstanceShowsBadge } from "../../providerInstances";
import { THREAD_STATUS_DOT_CLASSES } from "../Sidebar.logic";

const PILL_CLASS =
  "group/agent relative flex h-7 min-w-0 max-w-48 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-9 pointer-coarse:text-sm";

const PILL_ARROW_STEPS: Partial<Record<string, 1 | -1 | "first" | "last">> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
  Home: "first",
  End: "last",
};

/** The pill's own small buttons: on the pointed-at, focused, or picked-on-touch pill. */
const PILL_ACTION_CLASS =
  "rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:text-foreground pointer-coarse:p-1.5";

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
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-1.5 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div role="radiogroup" aria-label="Send to" className="flex min-w-0 items-center gap-1">
        {agents.rows.map((row, index) => {
          const selected = !props.adding && row.id === agents.recipient.id;
          // One tab stop for the group: the picked pill, or the first while adding.
          const tabStop = props.adding ? index === 0 : selected;
          const isRenaming = renaming === roomAgentKey(row.id);
          const busy = row.status !== null;
          const canEdit = agents.editable && !isRenaming && !props.adding;
          return (
            <div
              key={row.id ?? "primary"}
              role="radio"
              aria-checked={selected}
              tabIndex={tabStop ? 0 : -1}
              data-room-agent-row={row.id ?? "primary"}
              title={row.id === null ? `${row.name}, the thread's main agent` : row.name}
              className={cn(
                PILL_CLASS,
                selected
                  ? "bg-control text-foreground shadow-(--control-shadow)"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              onClick={() => choose(row)}
              onDoubleClick={() => {
                if (canEdit) setRenaming(roomAgentKey(row.id));
              }}
              onKeyDown={(event) => {
                // Keys on the pill's own buttons and name box are theirs.
                if (event.target !== event.currentTarget) return;
                const step = PILL_ARROW_STEPS[event.key];
                if (step !== undefined) {
                  // Like any radio group: arrows move and pick, wrapping round.
                  event.preventDefault();
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
                  event.currentTarget.parentElement
                    ?.querySelector<HTMLElement>(
                      `[data-room-agent-row="${nextRow.id ?? "primary"}"]`,
                    )
                    ?.focus();
                } else if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  choose(row);
                } else if (event.key === "F2" && canEdit) {
                  event.preventDefault();
                  setRenaming(roomAgentKey(row.id));
                } else if ((event.key === "Delete" || event.key === "Backspace") && canEdit) {
                  if (row.id !== null && !busy) {
                    event.preventDefault();
                    remove(row);
                  }
                }
              }}
            >
              {row.entry ? (
                <span className="relative flex shrink-0">
                  <ProviderInstanceIcon
                    instanceId={row.entry.instanceId}
                    driverKind={row.entry.driverKind}
                    displayName={row.entry.displayName}
                    accentColor={row.entry.accentColor}
                    // An extra account wears its letter, so two accounts on one
                    // model can be told apart.
                    showBadge={providerInstanceShowsBadge(row.entry)}
                    badgeClassName="right-[-0.3rem] bottom-[-0.2rem] h-2.5 min-w-2.5 px-0 text-[6px] shadow-none"
                    className="size-3.5 pointer-coarse:size-4"
                    iconClassName="size-3.5 pointer-coarse:size-4"
                  />
                  {busy ? (
                    // "working" reads blue, like the sidebar; amber is for warnings.
                    <span
                      data-room-agent-working="true"
                      className={cn(
                        "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full",
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
                  onBlur={(event) => rename(row, event.currentTarget.value)}
                />
              ) : (
                <span className="min-w-0 truncate font-medium">{row.role ?? row.modelName}</span>
              )}
              {row.id === null && !isRenaming ? (
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                  main
                </span>
              ) : null}
              {canEdit ? (
                <span
                  className={cn(
                    "hidden shrink-0 items-center gap-0.5 group-hover/agent:flex group-focus-within/agent:flex",
                    // No pointer to point with on touch: the picked pill shows them.
                    selected && "pointer-coarse:flex",
                  )}
                >
                  <button
                    type="button"
                    aria-label={`Rename ${row.name}`}
                    className={PILL_ACTION_CLASS}
                    onClick={(event) => {
                      event.stopPropagation();
                      setRenaming(roomAgentKey(row.id));
                    }}
                  >
                    <PencilIcon aria-hidden="true" className="size-3" />
                  </button>
                  {row.id !== null && !busy ? (
                    <button
                      type="button"
                      aria-label={`Remove ${row.name}`}
                      className={PILL_ACTION_CLASS}
                      onClick={(event) => {
                        event.stopPropagation();
                        remove(row);
                      }}
                    >
                      <XIcon aria-hidden="true" className="size-3" />
                    </button>
                  ) : null}
                </span>
              ) : null}
            </div>
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
