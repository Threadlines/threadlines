/**
 * The composer control for rooms: who the next message goes to.
 *
 * Lists the thread's own agent and every agent added to it, marks the one
 * working and the one answering on the side, and lets the user pick a
 * recipient, name an agent ("GPT-6 Astra 2 (Reviewer)"), remove one, or add
 * one from the same model list the model picker uses. In a thread with one
 * agent it is a single icon button that adds the first one.
 */
import {
  type ClientOrchestrationCommand,
  type ModelSelection,
  type OrchestrationThreadParticipant,
  type ProviderInstanceId,
  type ResolvedKeybindingsConfig,
  ROOM_AGENT_ROLE_MAX_LENGTH,
  type ScopedThreadRef,
  ThreadParticipantId,
} from "@threadlines/contracts";
import { activeParticipants } from "@threadlines/shared/threadParticipants";
import { ChevronDownIcon, PencilIcon, PlusIcon, UsersRoundIcon, XIcon } from "lucide-react";
import { memo, useState } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { cn, newCommandId, randomUUID } from "~/lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  buildRoomAgentLabels,
  nextRoomAgentName,
  roomAgentKey,
  roomModelName,
  useRoomRecipientStore,
} from "../../rooms";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ModelPickerContent } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { renameRoomAgent } from "./roomAgentActions";
import { type ModelEsque, getPickerModelName } from "./providerIconUtils";

interface AgentRow {
  readonly id: ThreadParticipantId | null;
  /** "GPT-6 Astra 2 (Reviewer)". */
  readonly name: string;
  /** "GPT-6 Astra 2": what stays when the user's name is cleared. */
  readonly modelName: string;
  readonly role: string | null;
  readonly modelSelection: ModelSelection;
}

export const RoomAgentPicker = memo(function RoomAgentPicker(props: {
  threadRef: ScopedThreadRef;
  /** The thread's own agent. */
  primaryModelSelection: ModelSelection;
  /** The user's name for the thread's own agent, if any. */
  primaryRole?: string | undefined;
  participants: ReadonlyArray<OrchestrationThreadParticipant>;
  recipientId: ThreadParticipantId | null;
  /** The agent with a turn in flight, if any. */
  workingId: ThreadParticipantId | null | undefined;
  /** The agent answering on the side, if any. */
  answeringId?: ThreadParticipantId | null | undefined;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  keybindings?: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  /** The row being renamed, by `roomAgentKey`. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const choose = useRoomRecipientStore((state) => state.choose);
  const present = activeParticipants({ participants: props.participants });
  const inRoom = props.participants.length > 0;

  const entryFor = (instanceId: ProviderInstanceId) =>
    props.instanceEntries.find((entry) => entry.instanceId === instanceId);
  const pickerName = (
    model: ProviderInstanceEntry["models"][number],
    entry: ProviderInstanceEntry,
  ) => getPickerModelName(model, entry.driverKind);
  // Every agent is named by its model, like the model picker names it.
  const labels = buildRoomAgentLabels(
    {
      modelSelection: props.primaryModelSelection,
      participants: props.participants,
      agentRole: props.primaryRole,
    },
    props.instanceEntries,
    pickerName,
  );
  const rowFor = (id: ThreadParticipantId | null, selection: ModelSelection): AgentRow => {
    const label = labels?.get(roomAgentKey(id));
    const modelName =
      label?.modelName ?? roomModelName(selection, props.instanceEntries, pickerName);
    return {
      id,
      name: label?.name ?? modelName,
      modelName,
      role: label?.role ?? null,
      modelSelection: selection,
    };
  };

  const rows: AgentRow[] = [
    rowFor(null, props.primaryModelSelection),
    ...present.map((participant) => rowFor(participant.id, participant.modelSelection)),
  ];
  const recipient = rows.find((row) => row.id === props.recipientId) ?? rows[0]!;

  const setMenuOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setAdding(false);
      setRenaming(null);
    }
  };

  /** Save the user's name for an agent; an empty one clears it. */
  const renameAgent = async (row: AgentRow, typed: string) => {
    setRenaming(null);
    const role = typed.trim().slice(0, ROOM_AGENT_ROLE_MAX_LENGTH) || null;
    if (role === row.role) return;
    try {
      await renameRoomAgent(props.threadRef, row.id, role);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not rename ${row.modelName}`,
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const dispatch = async (command: ClientOrchestrationCommand) => {
    const api = readEnvironmentApi(props.threadRef.environmentId);
    if (!api) {
      throw new Error("This computer is not connected.");
    }
    await api.orchestration.dispatchCommand(command);
  };

  const addAgent = async (instanceId: ProviderInstanceId, model: string) => {
    // The name it will be shown with, stored so the agents and the server's
    // messages call it the same.
    const handle = nextRoomAgentName(
      roomModelName({ instanceId, model }, props.instanceEntries, pickerName),
      labels ? [...labels.values()].map((label) => label.modelName) : [rows[0]!.modelName],
    );
    const id = ThreadParticipantId.make(randomUUID());
    setMenuOpen(false);
    try {
      await dispatch({
        type: "thread.participant.add",
        commandId: newCommandId(),
        threadId: props.threadRef.threadId,
        participant: { id, handle, modelSelection: { instanceId, model } },
        createdAt: new Date().toISOString(),
      });
      choose(props.threadRef, id);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not add the agent",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const removeAgent = async (participant: AgentRow) => {
    if (participant.id === null) return;
    try {
      await dispatch({
        type: "thread.participant.remove",
        commandId: newCommandId(),
        threadId: props.threadRef.threadId,
        participantId: participant.id,
        createdAt: new Date().toISOString(),
      });
      if (props.recipientId === participant.id) {
        choose(props.threadRef, null);
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not remove ${participant.name}`,
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <Popover open={open} onOpenChange={setMenuOpen}>
      {recipient.id !== null ? (
        <PopoverTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              data-chat-room-agent-picker="true"
              className={cn(
                "min-w-0 shrink-0 justify-start overflow-hidden whitespace-nowrap px-1.5 text-foreground/85 hover:text-foreground [&_svg]:mx-0",
                // A named agent ("GPT-6 Astra (Reviewer)") gets a little more room.
                props.compact ? "max-w-32" : recipient.role ? "max-w-60" : "max-w-44",
              )}
              aria-label={`Send to ${recipient.name}`}
              title={recipient.name}
            />
          }
        >
          {/* The people icon, not the provider's: this names who the message
              goes to, and must not read as the model picker it replaces. */}
          <span className="flex min-w-0 items-center gap-2.5 overflow-hidden">
            <UsersRoundIcon aria-hidden="true" className="size-4 shrink-0 opacity-70" />
            <span className="min-w-0 truncate">{recipient.name}</span>
            <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
          </span>
        </PopoverTrigger>
      ) : (
        // Sending to the thread's own agent: the model picker beside this
        // already names it, so this stays an icon (with the agent count in a
        // room) rather than printing the same name twice.
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    data-chat-room-agent-picker="true"
                    // The footer's gap is dropped here so the count sits
                    // as far from the model picker as the people icon sits
                    // from an added agent's name.
                    className="-me-1 shrink-0 gap-0.5 pr-1 pl-1.5 text-muted-foreground/70 hover:text-foreground/80"
                    aria-label={inRoom ? "Send to another agent" : "Add an agent to this thread"}
                  />
                }
              />
            }
          >
            <UsersRoundIcon aria-hidden="true" className="size-4" />
            {inRoom ? (
              <span className="font-mono text-[10.5px] tabular-nums">{rows.length}</span>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {inRoom ? "Send to another agent" : "Add an agent to this thread"}
          </TooltipPopup>
        </Tooltip>
      )}
      <PopoverPopup
        align="start"
        side="top"
        className={cn(
          adding || !inRoom
            ? "border-0 bg-transparent p-0 shadow-none before:hidden [--viewport-inline-padding:0] *:data-[slot=popover-viewport]:p-0"
            : "w-max min-w-44 max-w-80",
        )}
        // The list is as tight as the composer's other menus.
        {...(adding || !inRoom
          ? {}
          : { viewportClassName: "p-1 [--viewport-inline-padding:--spacing(1)]" })}
      >
        {adding || !inRoom ? (
          <ModelPickerContent
            activeInstanceId={props.primaryModelSelection.instanceId}
            model=""
            lockedProvider={null}
            instanceEntries={props.instanceEntries}
            {...(props.keybindings ? { keybindings: props.keybindings } : {})}
            modelOptionsByInstance={props.modelOptionsByInstance}
            terminalOpen={props.terminalOpen}
            notice={
              <div className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground">
                Pick a model to add to this thread. It joins with the recent messages, and only one
                agent works at a time. Rooms have no revert.
              </div>
            }
            onRequestClose={() => setMenuOpen(false)}
            openOnFavorites
            onInstanceModelChange={(instanceId, model) => {
              void addAgent(instanceId, model);
            }}
          />
        ) : (
          <div role="listbox" aria-label="Send to" className="flex flex-col text-sm">
            <div className="px-2 pt-0.5 pb-1 font-mono text-[10.5px] text-muted-foreground">
              Send to
            </div>
            {rows.map((row) => {
              const entry = entryFor(row.modelSelection.instanceId);
              const selected = row.id === recipient.id;
              const working = props.workingId !== undefined && props.workingId === row.id;
              const answering = props.answeringId !== undefined && props.answeringId === row.id;
              const busy = working || answering;
              const isRenaming = renaming === roomAgentKey(row.id);
              return (
                <div
                  key={row.id ?? "primary"}
                  role="option"
                  aria-selected={selected}
                  tabIndex={0}
                  title={row.id === null ? `${row.name}, the thread's own agent` : row.name}
                  className={cn(
                    "group flex h-7 cursor-default items-center gap-2 rounded-sm px-2 outline-none hover:bg-accent focus-visible:bg-accent",
                    selected ? "bg-accent/70 text-foreground" : "text-foreground/80",
                  )}
                  onClick={() => {
                    choose(props.threadRef, row.id);
                    setMenuOpen(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      choose(props.threadRef, row.id);
                      setMenuOpen(false);
                    }
                  }}
                >
                  {entry ? (
                    <ProviderInstanceIcon
                      driverKind={entry.driverKind}
                      displayName={entry.displayName}
                      accentColor={entry.accentColor}
                      showBadge={false}
                      className="size-4"
                      iconClassName="size-4"
                    />
                  ) : null}
                  <span className="min-w-0 shrink-0 truncate font-medium">{row.modelName}</span>
                  {isRenaming ? (
                    // The model's name stays; the user names the agent after it.
                    <input
                      autoFocus
                      aria-label={`Name for ${row.modelName}`}
                      defaultValue={row.role ?? ""}
                      placeholder="Name, like Reviewer"
                      maxLength={ROOM_AGENT_ROLE_MAX_LENGTH}
                      className="h-5 min-w-0 flex-1 rounded-sm border border-border bg-transparent px-1.5 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-ring"
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
                      onBlur={(event) => void renameAgent(row, event.currentTarget.value)}
                    />
                  ) : row.role ? (
                    <span className="min-w-0 truncate text-muted-foreground">({row.role})</span>
                  ) : null}
                  {/* Only what changes gets words; who is picked is the row's
                      highlight, and the thread's own agent is always first. */}
                  <span className="ml-auto shrink-0 font-mono text-[10.5px] text-warning">
                    {working ? "working" : answering ? "answering" : null}
                  </span>
                  {isRenaming ? null : (
                    <button
                      type="button"
                      aria-label={`Rename ${row.name}`}
                      className="hidden shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground group-hover:block"
                      onClick={(event) => {
                        event.stopPropagation();
                        setRenaming(roomAgentKey(row.id));
                      }}
                    >
                      <PencilIcon aria-hidden="true" className="size-3.5" />
                    </button>
                  )}
                  {row.id !== null && !busy && !isRenaming ? (
                    <button
                      type="button"
                      aria-label={`Remove ${row.name}`}
                      className="hidden shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground group-hover:block"
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenuOpen(false);
                        void removeAgent(row);
                      }}
                    >
                      <XIcon aria-hidden="true" className="size-3.5" />
                    </button>
                  ) : null}
                </div>
              );
            })}
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              className="flex h-7 items-center gap-2 rounded-sm px-2 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent"
              onClick={() => setAdding(true)}
            >
              <PlusIcon aria-hidden="true" className="size-4" />
              Add agent
            </button>
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
});
