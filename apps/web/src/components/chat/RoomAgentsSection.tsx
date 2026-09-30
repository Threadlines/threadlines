/**
 * The bottom of the model picker in a thread that can hold more agents: who
 * the next message goes to, and "Add agent". It sits right above the button
 * that opened the picker (under the thumb on a phone). Clicking an agent sends
 * to it and closes the picker; the model list above shows that agent's model.
 */
import { ROOM_AGENT_ROLE_MAX_LENGTH } from "@threadlines/contracts";
import { PencilIcon, UserRoundPlusIcon, XIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { toastManager } from "../ui/toast";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { roomAgentKey } from "../../rooms";
import type { RoomAgentRow, RoomAgents } from "./useRoomAgents";

const ROW_CLASS =
  "group/agent flex h-7 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-xs outline-none hover:bg-accent focus-visible:bg-accent pointer-coarse:h-10 pointer-coarse:text-sm";

export const RoomAgentsSection = memo(function RoomAgentsSection(props: {
  agents: RoomAgents;
  /** "Add agent" was picked: the list above adds its pick as a new agent. */
  adding: boolean;
  onStartAdding: () => void;
  onCancelAdding: () => void;
  /** An agent was picked to send to: the picker closes. */
  onChosen: () => void;
}) {
  const { agents } = props;
  /** The row being renamed, by `roomAgentKey`. */
  const [renaming, setRenaming] = useState<string | null>(null);

  const failed = (title: string) => (error: unknown) =>
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    });

  const rename = (row: RoomAgentRow, typed: string) => {
    setRenaming(null);
    void agents.rename(row, typed).catch(failed(`Could not rename ${row.modelName}`));
  };
  const remove = (row: RoomAgentRow) => {
    void agents.remove(row).catch(failed(`Could not remove ${row.name}`));
  };
  const choose = (row: RoomAgentRow) => {
    agents.choose(row.id);
    props.onChosen();
  };

  const showRows = agents.inRoom || props.adding;
  return (
    // Shrinks with the card on a short screen; a long list of agents scrolls.
    <div
      data-room-agents-section="true"
      className="flex min-h-0 shrink flex-col border-t border-border p-1"
    >
      {showRows ? (
        <div className="px-2 pt-0.5 pb-1 font-mono text-[10.5px] text-muted-foreground">
          Send to
        </div>
      ) : null}
      {showRows ? (
        <div
          role="listbox"
          aria-label="Send to"
          className="min-h-0 max-h-35 overflow-y-auto overscroll-contain pointer-coarse:max-h-50"
        >
          {agents.rows.map((row) => {
            const selected = !props.adding && row.id === agents.recipient.id;
            const isRenaming = renaming === roomAgentKey(row.id);
            const busy = row.status !== null;
            return (
              <div
                key={row.id ?? "primary"}
                role="option"
                aria-selected={selected}
                tabIndex={0}
                data-room-agent-row={row.id ?? "primary"}
                title={row.id === null ? `${row.name}, the thread's main agent` : row.name}
                className={cn(
                  ROW_CLASS,
                  selected ? "bg-accent/70 text-foreground" : "text-foreground/80",
                )}
                onClick={() => choose(row)}
                onKeyDown={(event) => {
                  // Keys on the row's own buttons and name box are theirs.
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    choose(row);
                  }
                }}
              >
                {row.entry ? (
                  <ProviderInstanceIcon
                    driverKind={row.entry.driverKind}
                    displayName={row.entry.displayName}
                    accentColor={row.entry.accentColor}
                    showBadge={false}
                    className="size-3.5 pointer-coarse:size-4"
                    iconClassName="size-3.5 pointer-coarse:size-4"
                  />
                ) : null}
                <span className="min-w-0 shrink-0 truncate font-medium">{row.modelName}</span>
                {isRenaming ? (
                  // The model's name stays; the user names the agent after it.
                  // The box grows with the name; `size` keeps it at its minimum
                  // where the browser can't size fields to content.
                  <input
                    autoFocus
                    aria-label={`Name for ${row.modelName}`}
                    defaultValue={row.role ?? ""}
                    placeholder="Name"
                    size={1}
                    maxLength={ROOM_AGENT_ROLE_MAX_LENGTH}
                    className="field-sizing-content h-5 min-w-20 max-w-40 rounded-sm border border-border bg-transparent px-1.5 outline-none placeholder:text-muted-foreground/60 focus:border-ring"
                    onClick={(event) => event.stopPropagation()}
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
                ) : row.role ? (
                  <span className="min-w-0 truncate text-muted-foreground">({row.role})</span>
                ) : null}
                {row.id === null && agents.inRoom && !isRenaming ? (
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
                    main
                  </span>
                ) : null}
                <span className="ml-auto shrink-0 font-mono text-[10.5px] text-warning">
                  {row.status}
                </span>
                {agents.editable && !isRenaming && !props.adding ? (
                  // Shown on the pointed-at row, and always on the picked one
                  // where there is no pointer to point with.
                  <span
                    className={cn(
                      "hidden shrink-0 items-center gap-0.5 group-hover/agent:flex group-focus-within/agent:flex",
                      selected && "pointer-coarse:flex",
                    )}
                  >
                    <button
                      type="button"
                      aria-label={`Rename ${row.name}`}
                      className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground pointer-coarse:p-1.5"
                      onClick={(event) => {
                        event.stopPropagation();
                        setRenaming(roomAgentKey(row.id));
                      }}
                    >
                      <PencilIcon aria-hidden="true" className="size-3.5" />
                    </button>
                    {row.id !== null && !busy ? (
                      <button
                        type="button"
                        aria-label={`Remove ${row.name}`}
                        className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground pointer-coarse:p-1.5"
                        onClick={(event) => {
                          event.stopPropagation();
                          remove(row);
                        }}
                      >
                        <XIcon aria-hidden="true" className="size-3.5" />
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {props.adding ? (
        <div
          data-room-agent-row="new"
          className={cn(
            ROW_CLASS,
            "cursor-default text-foreground outline-1 -outline-offset-1 outline-dashed outline-foreground/25 hover:bg-transparent",
          )}
        >
          <UserRoundPlusIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="font-medium">New agent</span>
          <button
            type="button"
            aria-label="Stop adding an agent"
            className="ml-auto rounded-sm p-0.5 text-muted-foreground hover:text-foreground pointer-coarse:p-1.5"
            onClick={props.onCancelAdding}
          >
            <XIcon aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      ) : agents.editable ? (
        <button
          type="button"
          data-room-add-agent="true"
          className={cn(ROW_CLASS, "font-medium text-muted-foreground hover:text-foreground")}
          onClick={props.onStartAdding}
        >
          <UserRoundPlusIcon aria-hidden="true" className="size-3.5 shrink-0" />
          Add agent
          {agents.inRoom ? null : (
            <span className="ml-auto truncate font-normal text-muted-foreground/70">
              Bring another model into this thread
            </span>
          )}
        </button>
      ) : null}
    </div>
  );
});
