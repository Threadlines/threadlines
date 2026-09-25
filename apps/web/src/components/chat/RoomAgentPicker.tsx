/**
 * The composer control for rooms: who the next message goes to.
 *
 * Lists the thread's own agent and every agent added to it, marks the one
 * working, and lets the user pick a recipient, remove an agent, or add one
 * from the same model list the model picker uses. In a thread with one agent
 * it is a single icon button that adds the first one.
 */
import {
  type ClientOrchestrationCommand,
  type ModelSelection,
  type OrchestrationThreadParticipant,
  type ProviderInstanceId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  ThreadParticipantId,
} from "@threadlines/contracts";
import { activeParticipants } from "@threadlines/shared/threadParticipants";
import { CheckIcon, ChevronDownIcon, PlusIcon, UsersRoundIcon, XIcon } from "lucide-react";
import { memo, useState } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { cn, newCommandId, randomUUID } from "~/lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { suggestParticipantHandle, useRoomRecipientStore } from "../../rooms";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ModelPickerContent } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  type ModelEsque,
  getProviderScopedDisplayModelName,
  getTriggerDisplayModelName,
} from "./providerIconUtils";

interface AgentRow {
  readonly id: ThreadParticipantId | null;
  readonly name: string;
  readonly modelSelection: ModelSelection;
}

export const RoomAgentPicker = memo(function RoomAgentPicker(props: {
  threadRef: ScopedThreadRef;
  /** The thread's own agent. */
  primaryModelSelection: ModelSelection;
  participants: ReadonlyArray<OrchestrationThreadParticipant>;
  recipientId: ThreadParticipantId | null;
  /** The agent with a turn in flight, if any. */
  workingId: ThreadParticipantId | null | undefined;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  keybindings?: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const choose = useRoomRecipientStore((state) => state.choose);
  const present = activeParticipants({ participants: props.participants });
  const inRoom = props.participants.length > 0;

  const entryFor = (instanceId: ProviderInstanceId) =>
    props.instanceEntries.find((entry) => entry.instanceId === instanceId);
  // The same short name the model picker shows ("Opus 4.5", not "Claude Opus 4.5").
  const modelName = (selection: ModelSelection) => {
    const option = props.modelOptionsByInstance
      .get(selection.instanceId)
      ?.find((entry) => entry.slug === selection.model);
    const entry = entryFor(selection.instanceId);
    if (!option) return selection.model;
    return entry
      ? getProviderScopedDisplayModelName(option, entry.driverKind, { preferShortName: true })
      : getTriggerDisplayModelName(option);
  };

  const rows: AgentRow[] = [
    {
      id: null,
      name: modelName(props.primaryModelSelection),
      modelSelection: props.primaryModelSelection,
    },
    ...present.map((participant) => ({
      id: participant.id,
      name: `@${participant.handle}`,
      modelSelection: participant.modelSelection,
    })),
  ];
  const recipient = rows.find((row) => row.id === props.recipientId) ?? rows[0]!;

  const setMenuOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setAdding(false);
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
    const option = props.modelOptionsByInstance
      .get(instanceId)
      ?.find((entry) => entry.slug === model);
    const handle = suggestParticipantHandle({
      modelDisplayName: option ? getTriggerDisplayModelName(option) : model,
      model,
      providerName: entryFor(instanceId)?.displayName ?? String(instanceId),
      taken: present.map((participant) => participant.handle),
    });
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

  const recipientEntry = entryFor(recipient.modelSelection.instanceId);

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
                "min-w-0 shrink-0 justify-start overflow-hidden whitespace-nowrap px-2 text-foreground/85 hover:text-foreground [&_svg]:mx-0",
                props.compact ? "max-w-32" : "max-w-44",
              )}
              aria-label={`Send to ${recipient.name}`}
            />
          }
        >
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            {recipientEntry ? (
              <ProviderInstanceIcon
                driverKind={recipientEntry.driverKind}
                displayName={recipientEntry.displayName}
                accentColor={recipientEntry.accentColor}
                showBadge={false}
                className="size-4"
                iconClassName="size-4"
              />
            ) : null}
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
                    className="shrink-0 gap-1 px-2 text-muted-foreground/70 hover:text-foreground/80"
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
            : "w-64 p-1",
        )}
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
            onInstanceModelChange={(instanceId, model) => {
              void addAgent(instanceId, model);
            }}
          />
        ) : (
          <div role="listbox" aria-label="Send to" className="flex flex-col text-sm">
            <div className="px-2 pt-1.5 pb-1 font-mono text-[10.5px] text-muted-foreground">
              Send to
            </div>
            {rows.map((row) => {
              const entry = entryFor(row.modelSelection.instanceId);
              const selected = row.id === recipient.id;
              const working = props.workingId !== undefined && props.workingId === row.id;
              return (
                <div
                  key={row.id ?? "primary"}
                  role="option"
                  aria-selected={selected}
                  tabIndex={0}
                  className={cn(
                    "group flex h-8 cursor-default items-center gap-2 rounded-md px-2 outline-none hover:bg-accent focus-visible:bg-accent",
                    selected && "bg-accent/60",
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
                  <span className="min-w-0 truncate font-medium">{row.name}</span>
                  <span
                    className={cn(
                      "ml-auto shrink-0 font-mono text-[10.5px]",
                      working ? "text-warning" : "text-muted-foreground",
                    )}
                  >
                    {working
                      ? "working"
                      : row.id === null
                        ? "thread's agent"
                        : modelName(row.modelSelection)}
                  </span>
                  {selected ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
                  {row.id !== null && !working ? (
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
              className="flex h-8 items-center gap-2 rounded-md px-2 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent"
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
