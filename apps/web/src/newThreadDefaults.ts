/**
 * What a new thread starts with on a computer (Settings › Threads): the
 * computer's default model and the agents beside its own, checked against the
 * providers that computer has, and the draft step that applies them. Every
 * "new thread" surface goes through `useNewThreadState`, which calls
 * `applyNewThreadDefaultsToDraft`.
 */
import {
  type EnvironmentId,
  type ModelSelection,
  type NewThreadRoomAgent,
  type ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
  type ThreadCreateParticipant,
  ThreadParticipantId,
} from "@threadlines/contracts";
import { roomsEnabled } from "@threadlines/shared/serverSettings";
import { nextRoomAgentName } from "@threadlines/shared/threadParticipants";

import { getPickerModelName } from "./components/chat/providerIconUtils";
import { type DraftId, type DraftRoom, useComposerDraftStore } from "./composerDraftStore";
import { readPrimaryEnvironmentDescriptor } from "./environments/primary/context";
import { useSavedEnvironmentRuntimeStore } from "./environments/runtime";
import { randomUUID } from "./lib/utils";
import {
  deriveDisplayProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "./providerInstances";
import { roomModelName } from "./rooms";
import { getServerConfig, onServerConfigUpdated } from "./rpc/serverState";

/** How long a new thread waits for its computer's settings before going without. */
export const NEW_THREAD_SETTINGS_WAIT_MS = 3_000;

type ComputerConfig = Pick<ServerConfig, "settings" | "providers">;

/**
 * Whether an agent on this instance can run on the computer: false only when
 * the computer's providers are known and the instance is gone or turned off.
 * Not installed or signed out still counts: the user can fix that, and the
 * composer says so.
 */
export function canRunOnComputer(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): boolean {
  if (providers.length === 0) {
    return true;
  }
  return (
    deriveDisplayProviderInstanceEntries(providers).find((entry) => entry.instanceId === instanceId)
      ?.enabled === true
  );
}

/** The computer's defaults that can run there; Rooms off means no agents. */
export function resolveNewThreadDefaults(config: ComputerConfig): {
  readonly modelSelection: ModelSelection | null;
  readonly roomAgents: ReadonlyArray<NewThreadRoomAgent>;
} {
  const { settings, providers } = config;
  const modelSelection =
    settings.newThreadModelSelection !== null &&
    canRunOnComputer(providers, settings.newThreadModelSelection.instanceId)
      ? settings.newThreadModelSelection
      : null;
  const roomAgents = roomsEnabled(settings)
    ? settings.newThreadRoomAgents.filter((agent) =>
        canRunOnComputer(providers, agent.modelSelection.instanceId),
      )
    : [];
  return { modelSelection, roomAgents };
}

/**
 * The default agents as a new thread's participants: fresh ids, and names
 * numbered past the thread's own agent and each other, as adding them in the
 * model picker would.
 */
export function buildNewThreadParticipants(input: {
  readonly agents: ReadonlyArray<NewThreadRoomAgent>;
  /** The thread's own agent's model, when known. */
  readonly primaryModelSelection: ModelSelection | null;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly newId?: () => ThreadParticipantId;
}): ReadonlyArray<ThreadCreateParticipant> {
  const newId = input.newId ?? (() => ThreadParticipantId.make(randomUUID()));
  const modelName = (selection: ModelSelection) =>
    roomModelName(selection, input.instanceEntries, (model, entry) =>
      getPickerModelName(model, entry.driverKind),
    );
  const taken =
    input.primaryModelSelection === null ? [] : [modelName(input.primaryModelSelection)];
  return input.agents.map((agent) => {
    const handle = nextRoomAgentName(modelName(agent.modelSelection), taken);
    taken.push(handle);
    return {
      id: newId(),
      handle,
      modelSelection: agent.modelSelection,
      ...(agent.role !== undefined ? { role: agent.role } : {}),
    };
  });
}

/**
 * The settings and providers of the computer a thread lives on: the one this
 * app talks to for settings, or a saved computer's. Never another computer's
 * in its place (on a phone the app-wide config is whichever paired computer
 * is on screen), so the app-wide one counts only when it names this computer.
 */
export function readComputerConfig(environmentId: EnvironmentId): ServerConfig | null {
  const primaryEnvironmentId = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
  const appConfig = getServerConfig();
  // The app-wide copy goes first when it is this computer's: settings edits
  // land there before the computer confirms them.
  if (
    environmentId === primaryEnvironmentId ||
    appConfig?.environment.environmentId === environmentId
  ) {
    return appConfig;
  }
  return useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig ?? null;
}

/**
 * The computer's config, waiting for it when it has not arrived yet (the
 * first new thread at startup), at most `timeoutMs`. Null when it never came.
 */
export function waitForComputerConfig(
  environmentId: EnvironmentId,
  timeoutMs: number = NEW_THREAD_SETTINGS_WAIT_MS,
): Promise<ServerConfig | null> {
  const ready = readComputerConfig(environmentId);
  if (ready !== null) {
    return Promise.resolve(ready);
  }
  return new Promise((resolve) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    // A source can deliver it while it is being subscribed to.
    const keep = (cleanup: () => void) => {
      if (settled) cleanup();
      else cleanups.push(cleanup);
    };
    const finish = (config: ServerConfig | null) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      resolve(config);
    };
    const check = () => {
      const config = readComputerConfig(environmentId);
      if (config !== null) finish(config);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    keep(() => clearTimeout(timer));
    keep(onServerConfigUpdated(check));
    keep(useSavedEnvironmentRuntimeStore.subscribe(check));
    check();
  });
}

/** The model a draft's own agent has right now, if any. */
function draftActiveSelection(draftId: DraftId): ModelSelection | null {
  const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
  const active = draft?.activeProvider ?? null;
  return active === null ? null : (draft?.modelSelectionByProvider[active] ?? null);
}

/** The model last picked on this device, if any. */
function lastUsedSelection(): ModelSelection | null {
  const state = useComposerDraftStore.getState();
  const active = state.stickyActiveProvider;
  return active === null ? null : (state.stickyModelSelectionByProvider[active] ?? null);
}

/**
 * Everything of a draft the user can change: its composer (text, attachments,
 * model) and its agents. Each is replaced, never edited, when it changes.
 */
function draftSetup(draftId: DraftId) {
  const state = useComposerDraftStore.getState();
  return {
    composer: state.getComposerDraft(draftId),
    room: state.getDraftSession(draftId)?.room,
  };
}

/**
 * The latest defaults request per draft: a draft moved again while one
 * computer's settings were on their way belongs to the newer request.
 */
const latestRequestByDraft = new Map<DraftId, number>();
/** Request numbers, unique across drafts so a finished one is never mistaken for a new one. */
let lastRequest = 0;

/**
 * Sets a new thread's draft up with its computer's defaults. When that
 * computer's settings have not arrived yet (the first new thread at startup),
 * the draft is usable meanwhile and the defaults follow when they come, unless
 * the user has started on the draft by then: late settings never override
 * what the user did. `keepModel` leaves the model alone (a draft moved to
 * another computer after its model was picked).
 */
export async function applyNewThreadDefaultsToDraft(
  draftId: DraftId,
  environmentId: EnvironmentId,
  options?: { readonly keepModel?: boolean },
): Promise<void> {
  const request = ++lastRequest;
  latestRequestByDraft.set(draftId, request);
  const arrivedLate = readComputerConfig(environmentId) === null;
  if (arrivedLate) {
    // The device's last used model needs no settings: it applies now, so the
    // draft has it even if the user starts before the computer's defaults come.
    useComposerDraftStore.getState().applyNewThreadDefaults(draftId, null, options);
  }
  const setupBefore = draftSetup(draftId);
  const config = await waitForComputerConfig(environmentId);

  const store = useComposerDraftStore.getState();
  const session = store.getDraftSession(draftId);
  if (latestRequestByDraft.get(draftId) !== request) {
    // A newer request owns the draft (it moved again).
    return;
  }
  latestRequestByDraft.delete(draftId);
  const setupAfter = draftSetup(draftId);
  if (
    session === null ||
    session.environmentId !== environmentId ||
    (session.promotedTo ?? null) !== null ||
    (arrivedLate &&
      (setupAfter.composer !== setupBefore.composer || setupAfter.room !== setupBefore.room))
  ) {
    // Gone, moved, being sent, or worked on while the settings were on their way.
    return;
  }
  const keepModel = options?.keepModel === true;
  const applyOptions = keepModel ? { keepModel: true } : undefined;

  if (config === null) {
    store.applyNewThreadDefaults(draftId, null, applyOptions);
    return;
  }
  const defaults = resolveNewThreadDefaults(config);
  let room: DraftRoom | null = null;
  if (defaults.roomAgents.length > 0) {
    const primaryModelSelection = keepModel
      ? draftActiveSelection(draftId)
      : (defaults.modelSelection ?? lastUsedSelection());
    room = {
      agents: buildNewThreadParticipants({
        agents: defaults.roomAgents,
        primaryModelSelection,
        instanceEntries: deriveDisplayProviderInstanceEntries(config.providers),
      }),
    };
  }
  store.applyNewThreadDefaults(
    draftId,
    { modelSelection: defaults.modelSelection, room },
    applyOptions,
  );
}

/**
 * A draft moved to another computer before its first message takes that
 * computer's room, and its model too unless the user picked the model.
 */
export function applyMovedDraftDefaults(
  draftId: DraftId,
  toEnvironmentId: EnvironmentId,
): Promise<void> {
  const picked = useComposerDraftStore.getState().getComposerDraft(draftId)?.modelPicked === true;
  return applyNewThreadDefaultsToDraft(draftId, toEnvironmentId, { keepModel: picked });
}
