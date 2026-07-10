import {
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
  type ThreadBootstrapCreateThread,
} from "@threadlines/contracts";
import type { UnifiedSettings } from "@threadlines/contracts/settings";
import { createModelSelection } from "@threadlines/shared/model";

import { type ComposerThreadDraftState, type DraftSessionState } from "../composerDraftStore";
import { getComposerProviderState } from "../components/chat/composerProviderState";
import { resolveAppModelSelectionForInstance } from "../modelSelection";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../providerInstances";
import type { Project, Thread } from "../types";

const CODEX_DRIVER = ProviderDriverKind.make("codex");

export type ProviderReviewThreadBootstrap = Omit<
  ThreadBootstrapCreateThread,
  "createdAt" | "title"
>;

export interface ProviderReviewContext {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: ThreadBootstrapCreateThread["runtimeMode"];
  readonly providerDriver: ProviderDriverKind | null;
  readonly providerLabel: string;
  readonly unavailableReason: string | null;
  readonly bootstrap: ProviderReviewThreadBootstrap | null;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
}

export function resolveProviderReviewContext(input: {
  readonly thread: Thread | null | undefined;
  readonly draftSession: DraftSessionState | null | undefined;
  readonly composerDraft:
    | Pick<
        ComposerThreadDraftState,
        "activeProvider" | "modelSelectionByProvider" | "runtimeMode" | "interactionMode"
      >
    | null
    | undefined;
  readonly project: Pick<Project, "defaultModelSelection"> | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
}): ProviderReviewContext {
  const session = input.thread?.session ?? null;
  const providerInstanceEntries = deriveProviderInstanceEntries(input.providers).filter(
    (entry) => entry.driverKind === CODEX_DRIVER,
  );
  const selectableProviderEntries = providerInstanceEntries.filter(
    (entry) => entry.enabled && entry.installed && entry.isAvailable && entry.status === "ready",
  );
  const sessionInstanceId =
    session?.provider === CODEX_DRIVER
      ? (session.providerInstanceId ?? defaultInstanceIdForDriver(CODEX_DRIVER))
      : null;
  const selectedInstanceIdCandidates = [
    input.composerDraft?.activeProvider,
    sessionInstanceId,
    input.thread?.modelSelection.instanceId,
    input.project?.defaultModelSelection?.instanceId,
    defaultInstanceIdForDriver(CODEX_DRIVER),
  ];
  const providerEntry =
    selectedInstanceIdCandidates
      .map((instanceId) =>
        selectableProviderEntries.find((entry) => entry.instanceId === instanceId),
      )
      .find((entry) => entry !== undefined) ?? selectableProviderEntries[0];
  const selectedInstanceId = providerEntry?.instanceId ?? defaultInstanceIdForDriver(CODEX_DRIVER);
  const legacyInstanceId = ProviderInstanceId.make(CODEX_DRIVER);
  const optionSource =
    input.composerDraft?.modelSelectionByProvider[selectedInstanceId] ??
    input.composerDraft?.modelSelectionByProvider[legacyInstanceId] ??
    (input.thread?.modelSelection.instanceId === selectedInstanceId
      ? input.thread.modelSelection
      : undefined) ??
    (input.project?.defaultModelSelection?.instanceId === selectedInstanceId
      ? input.project.defaultModelSelection
      : undefined);
  const selectedModel =
    resolveAppModelSelectionForInstance(
      selectedInstanceId,
      input.settings,
      input.providers,
      optionSource?.model,
    ) ??
    optionSource?.model ??
    DEFAULT_MODEL_BY_PROVIDER[CODEX_DRIVER] ??
    "gpt-5.4";
  const selectedProviderState = getComposerProviderState({
    provider: CODEX_DRIVER,
    model: selectedModel,
    models: providerEntry?.models ?? [],
    prompt: "",
    modelOptions: optionSource?.options,
  });
  const modelSelection = createModelSelection(
    selectedInstanceId,
    selectedModel,
    selectedProviderState.modelOptionsForDispatch,
  );
  const runtimeMode =
    input.composerDraft?.runtimeMode ??
    input.draftSession?.runtimeMode ??
    input.thread?.runtimeMode ??
    "full-access";
  const interactionMode =
    input.composerDraft?.interactionMode ??
    input.draftSession?.interactionMode ??
    input.thread?.interactionMode ??
    "default";
  const providerLabel =
    providerEntry?.displayName ??
    PROVIDER_DISPLAY_NAMES[CODEX_DRIVER] ??
    String(selectedInstanceId);

  const unavailableReason = (() => {
    if (input.thread == null && input.draftSession == null) {
      return "Open a thread before starting a code review.";
    }
    if (input.project == null) {
      return "The current thread's project is unavailable.";
    }
    if (providerInstanceEntries.length === 0) {
      return "No Codex provider is configured.";
    }
    if (!providerEntry) {
      return "Codex is unavailable. Enable or install it before starting a review.";
    }
    if (providerEntry.models.length === 0) {
      return `${providerLabel} has no available models.`;
    }
    return null;
  })();

  const threadContext = input.thread ?? input.draftSession;
  const bootstrap =
    threadContext && input.project
      ? {
          projectId: threadContext.projectId,
          modelSelection,
          runtimeMode,
          interactionMode,
          branch: threadContext.branch,
          worktreePath: threadContext.worktreePath,
        }
      : null;

  return {
    modelSelection,
    runtimeMode,
    providerDriver: providerEntry?.driverKind ?? null,
    providerLabel,
    unavailableReason,
    bootstrap,
    providerInstanceEntries: selectableProviderEntries,
  };
}
