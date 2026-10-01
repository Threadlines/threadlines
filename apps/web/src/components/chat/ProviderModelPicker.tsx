import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@threadlines/contracts";
import { memo, useEffect, useEffectEvent, useMemo, useState, type CSSProperties } from "react";
import { scopedThreadKey } from "@threadlines/client-runtime";
import { codexModelRetirementNotice } from "@threadlines/shared/model";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { ModelPickerContent } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  ModelEsque,
  getProviderScopedDisplayModelName,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
} from "./providerIconUtils";
import { setModelPickerOpen } from "../../modelPickerOpenState";
import { useOnScreenKeyboardInset } from "~/hooks/useOnScreenKeyboardInset";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useRoomRecipientStore } from "../../rooms";
import { THREAD_STATUS_DOT_CLASSES } from "../Sidebar.logic";
import { toastManager } from "../ui/toast";
import { RoomAgentsSection } from "./RoomAgentsSection";
import type { RoomAgentRow, RoomAgents } from "./useRoomAgents";

/** How long a palette's "Add agent" waits for the picker to be there. */
const ADD_AGENT_REQUEST_LAPSE_MS = 2_000;

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  /**
   * The instance currently selected in the composer. Drives the trigger
   * icon, label and the default-highlighted combobox row.
   */
  activeInstanceId: ProviderInstanceId;
  model: string;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /** Instance entries rendered in the sidebar + used to resolve display name. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  terminalOpen?: boolean;
  open?: boolean;
  /**
   * Preferred popup side. The composer passes "top" so the picker opens into
   * the conversation area rather than downward over the terminal panel, where
   * it would not fit. Base UI still flips to the other side when out of room.
   */
  side?: "top" | "bottom";
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  onOpenChange?: (open: boolean) => void;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  /**
   * The thread's agents, where the thread can hold more than one (Rooms on).
   * The button then names who the next message goes to, the card lists the
   * agents under the models and adds them, and the model list shows the
   * picked agent's model. `activeInstanceId`, `model` and the lock stay the
   * thread's own agent's.
   */
  room?: RoomAgents | null;
}) {
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;
  const room = props.room ?? null;
  /** "Add agent" was picked: the next model picked joins as a new agent. */
  const [adding, setAdding] = useState(false);
  const addAgentRequested = useRoomRecipientStore(
    (state) =>
      room !== null && state.addAgentRequested?.threadKey === scopedThreadKey(room.threadRef),
  );
  // On overlay-keyboard browsers (iOS Safari), focusing the picker's search
  // input slides the keyboard over the bottom-anchored popup. Lift the popup
  // by the covered height; ModelPickerContent shrinks its max-height by the
  // same amount (via --keyboard-inset) so the top stays on screen.
  const keyboardInset = useOnScreenKeyboardInset(isMenuOpen);

  // An added agent keeps its own model; the list shows and changes that one.
  const addressedAgent: RoomAgentRow | null =
    room !== null && room.recipient.id !== null ? room.recipient : null;
  const activeInstanceId = addressedAgent?.modelSelection.instanceId ?? props.activeInstanceId;
  const activeModel = addressedAgent?.modelSelection.model ?? props.model;
  // Resolve the active instance entry by exact routing key. The composer
  // resolves fallbacks before rendering this component; if the selected
  // instance disappears, do not infer a replacement from its driver kind.
  const activeEntry = useMemo(() => {
    return props.instanceEntries.find((entry) => entry.instanceId === activeInstanceId) ?? null;
  }, [activeInstanceId, props.instanceEntries]);

  const selectedInstanceOptions = props.modelOptionsByInstance.get(activeInstanceId) ?? [];
  const retirement =
    activeEntry?.driverKind === "codex" && addressedAgent === null
      ? codexModelRetirementNotice(activeModel, activeEntry.snapshot.auth.type)
      : undefined;
  // If the current slug belongs to a different instance (for example after
  // a provider switch or disable), prefer the active instance's first
  // option so the trigger icon and label stay in sync instead of showing
  // a stale foreign slug.
  const selectedModel =
    selectedInstanceOptions.find((option) => option.slug === activeModel) ??
    (retirement ? undefined : selectedInstanceOptions[0]);
  const triggerTitle = selectedModel
    ? activeEntry
      ? getProviderScopedDisplayModelName(selectedModel, activeEntry.driverKind, {
          preferShortName: true,
        })
      : getTriggerDisplayModelName(selectedModel)
    : activeModel;
  const triggerSubtitle = selectedModel?.subProvider;
  const triggerLabel = selectedModel ? getTriggerDisplayModelLabel(selectedModel) : activeModel;
  const duplicateDriverCount = props.instanceEntries.filter(
    (entry) => activeEntry !== null && entry.driverKind === activeEntry.driverKind,
  ).length;
  const showInstanceBadge = Boolean(activeEntry?.accentColor) || duplicateDriverCount > 1;

  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
    if (!open) {
      setAdding(false);
    }
  };

  // "Add agent" asked for from the command palette: open once the closing
  // palette has handed focus back, or the card would lose it and close at once.
  const openToAdd = useEffectEvent(() => {
    useRoomRecipientStore.getState().requestAddAgent(null);
    setAdding(true);
    props.onOpenChange?.(true);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(true);
    }
  });
  const cannotAdd = room?.editable === false;
  useEffect(() => {
    if (!addAgentRequested) return;
    const requestedAt = useRoomRecipientStore.getState().addAgentRequested?.at ?? 0;
    if (Date.now() - requestedAt > ADD_AGENT_REQUEST_LAPSE_MS || cannotAdd) {
      useRoomRecipientStore.getState().requestAddAgent(null);
      return;
    }
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(openToAdd);
    });
    return () => cancelAnimationFrame(frame);
  }, [addAgentRequested, cannotAdd]);

  useEffect(() => {
    setModelPickerOpen(isMenuOpen);
    return () => {
      setModelPickerOpen(false);
    };
  }, [isMenuOpen]);

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return;
    if (room !== null && adding) {
      setIsMenuOpen(false);
      void room.add(instanceId, model).catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not add the agent",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    if (room !== null && addressedAgent !== null) {
      setIsMenuOpen(false);
      void room.changeModel(addressedAgent, instanceId, model).catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: `Could not change the model of ${addressedAgent.name}`,
          description: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    props.onInstanceModelChange(instanceId, model);
    setIsMenuOpen(false);
  };

  // An added agent, or one being added, can be any model: the thread's own
  // agent's provider lock is its own.
  const lockedProvider = adding || addressedAgent !== null ? null : props.lockedProvider;
  const rowAction = adding
    ? ({ kind: "add", label: "Add" } as const)
    : addressedAgent !== null
      ? ({
          kind: "switch",
          label: `Switch ${addressedAgent.role ?? addressedAgent.modelName} to this`,
        } as const)
      : null;
  const rowsDisabledReason =
    adding || addressedAgent === null
      ? null
      : room?.editable === false
        ? "The thread is being created. Change agents once it is."
        : addressedAgent.status
          ? `${addressedAgent.name} is ${addressedAgent.status}. Change its model once it's done.`
          : null;
  const inRoom = room !== null && room.inRoom;

  return (
    <Popover
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 [&_svg]:mx-0",
              // A room's narrow button is wider by the faded icons, so the name
              // keeps the room it has outside a room whenever the row allows.
              props.compact
                ? inRoom
                  ? "max-w-48 shrink"
                  : "max-w-42 shrink"
                : "max-w-48 shrink-0 sm:max-w-56 sm:px-3",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        {inRoom && room !== null ? (
          <RoomPickerTriggerContent room={room} compact={props.compact === true} />
        ) : (
          <span
            className={cn(
              "flex min-w-0 w-full box-border items-center gap-2 overflow-hidden",
              props.compact ? "max-w-36 sm:pl-1" : undefined,
            )}
          >
            {activeEntry ? (
              <ProviderInstanceIcon
                driverKind={activeEntry.driverKind}
                displayName={activeEntry.displayName}
                accentColor={activeEntry.accentColor}
                showBadge={showInstanceBadge}
                className={showInstanceBadge ? "size-5" : "size-4"}
                iconClassName={cn("size-4", props.activeProviderIconClassName)}
                badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 text-[7px]"
              />
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      "min-w-0 flex-1 overflow-hidden",
                      triggerSubtitle
                        ? "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1"
                        : "truncate",
                    )}
                  />
                }
              >
                {triggerSubtitle ? (
                  <>
                    <span className="min-w-0 truncate">{triggerSubtitle}</span>
                    <span aria-hidden="true" className="shrink-0 opacity-60">
                      ·
                    </span>
                    <span className="min-w-0 truncate">{triggerTitle}</span>
                  </>
                ) : (
                  triggerTitle
                )}
              </TooltipTrigger>
              <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
            </Tooltip>
            <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        side={props.side}
        className="border-0 bg-transparent p-0 shadow-none before:hidden [--viewport-inline-padding:0] *:data-[slot=popover-viewport]:p-0"
        style={
          keyboardInset > 0
            ? ({
                translate: `0 -${keyboardInset}px`,
                "--keyboard-inset": `${keyboardInset}px`,
              } as CSSProperties)
            : undefined
        }
      >
        <ModelPickerContent
          notice={
            adding ? (
              <div className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground">
                Pick a model for the new agent. It reads the recent messages first. Rooms have no
                revert.
              </div>
            ) : retirement ? (
              <div
                className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground"
                role="status"
              >
                <p>{retirement.message}</p>
                {selectedInstanceOptions.some(
                  (option) => option.slug === retirement.replacement,
                ) ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="mt-1"
                    onClick={() =>
                      handleInstanceModelChange(activeInstanceId, retirement.replacement)
                    }
                  >
                    Use GPT-5.6 Sol
                  </Button>
                ) : null}
              </div>
            ) : null
          }
          activeInstanceId={adding ? props.activeInstanceId : activeInstanceId}
          model={adding ? "" : activeModel}
          lockedProvider={lockedProvider}
          lockedContinuationGroupKey={
            lockedProvider === null ? null : (props.lockedContinuationGroupKey ?? null)
          }
          {...(adding ? { openOnFavorites: true } : {})}
          rowAction={rowAction}
          rowsDisabledReason={rowsDisabledReason}
          footer={
            room !== null ? (
              <RoomAgentsSection
                agents={room}
                adding={adding}
                onStartAdding={() => setAdding(true)}
                onCancelAdding={() => setAdding(false)}
                onChosen={() => setIsMenuOpen(false)}
              />
            ) : null
          }
          instanceEntries={props.instanceEntries}
          {...(props.keybindings ? { keybindings: props.keybindings } : {})}
          modelOptionsByInstance={props.modelOptionsByInstance}
          terminalOpen={props.terminalOpen ?? false}
          onRequestClose={() => setIsMenuOpen(false)}
          onInstanceModelChange={handleInstanceModelChange}
        />
      </PopoverPopup>
    </Popover>
  );
});

/**
 * The model button in a room: who the next message goes to, in front, with
 * up to two other agents' icons faded behind it and a dot on one at work,
 * blue like the sidebar's "working" (amber is for warnings). Agents at work
 * take the faded spots first, so a dot is the last thing left out. Phones get
 * the same stack. When the composer's left controls (the `composer-left`
 * container in ChatComposer) get too narrow to keep about seven characters of
 * the name, the faded icons drop out one at a time, the last one first (and
 * all at once beside the model fallback chip). On a narrow composer a named
 * agent goes by its name alone, like the sidebar.
 */
function RoomPickerTriggerContent(props: { room: RoomAgents; compact: boolean }) {
  const { recipient, rows } = props.room;
  const others = rows.filter((row) => row !== recipient);
  const icons = [
    recipient,
    ...[
      ...others.filter((row) => row.status !== null),
      ...others.filter((row) => row.status === null),
    ].slice(0, 2),
  ];
  const name = props.compact ? (recipient.role ?? recipient.modelName) : recipient.name;
  const busy = rows.filter((row) => row.status !== null);
  return (
    <span
      className={cn(
        "flex min-w-0 w-full box-border items-center gap-2 overflow-hidden",
        props.compact ? "max-w-42 sm:pl-1" : undefined,
      )}
    >
      {/* Isolated so the dots sit above the icons overlapping them. */}
      <span aria-hidden="true" className="isolate flex shrink-0 items-center">
        {icons.map((row, index) => (
          <span
            key={row.id ?? "primary"}
            data-room-trigger-agent={row.id ?? "primary"}
            className={cn(
              "relative flex size-4 shrink-0 items-center justify-center",
              index > 0 && "-ms-[5px]",
              // Each faded icon costs the name 11px; these widths (inside the
              // row's padding) keep about seven characters of it: three icons
              // on a 402px phone, two at 390px, one at 375px.
              index === 1 && "@max-[163px]/composer-left:hidden",
              index === 2 && "@max-[174px]/composer-left:hidden",
              // The fallback chip takes that room on a narrow composer.
              index > 0 &&
                props.compact &&
                "group-data-[model-fallback-chip=true]/composer-left:hidden",
            )}
          >
            {row.entry ? (
              <ProviderInstanceIcon
                driverKind={row.entry.driverKind}
                displayName={row.entry.displayName}
                accentColor={row.entry.accentColor}
                showBadge={false}
                // Faded behind the one in front, with a notch cut where it
                // sits. Only the icon fades: the dot stays whole and bright.
                className={cn(
                  "size-4",
                  index > 0 &&
                    "opacity-55 [mask-image:radial-gradient(circle_at_-3px_50%,transparent_9px,black_9.5px)]",
                )}
                iconClassName="size-4"
              />
            ) : null}
            {row.status !== null ? (
              <span
                data-room-trigger-working="true"
                className={cn(
                  "absolute -right-0.5 -bottom-0.5 z-10 size-1.5 rounded-full",
                  THREAD_STATUS_DOT_CLASSES.blue,
                )}
              />
            ) : null}
          </span>
        ))}
      </span>
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
          {name}
        </TooltipTrigger>
        <TooltipPopup side="top">
          {recipient.name}
          {busy.map((row) => (
            <span key={row.id ?? "primary"} className="block text-muted-foreground">
              {row.name} is {row.status}
            </span>
          ))}
        </TooltipPopup>
      </Tooltip>
      <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
    </span>
  );
}
