import {
  ArchiveIcon,
  ArchiveX,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  AUTO_ARCHIVE_INACTIVE_THREADS_DAY_OPTIONS,
  type AutoArchiveInactiveThreadsDays,
  defaultInstanceIdForDriver,
  type DesktopUpdateChannel,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ScopedThreadRef,
} from "@threadlines/contracts";
import { scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import { DEFAULT_UNIFIED_SETTINGS } from "@threadlines/contracts/settings";
import { createModelSelection } from "@threadlines/shared/model";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@threadlines/shared/projectScripts";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import { APP_VERSION } from "../../branding";
import { getDesktopUpdateButtonTooltip } from "../../components/desktopUpdate.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  canRequestProviderRateLimitResetCredit,
  useProviderRateLimitResetCredit,
} from "../ProviderRateLimitResetCredit";
import { isElectron } from "../../env";
import { useDesktopUpdateAction } from "../../hooks/useDesktopUpdateAction";
import { useTheme } from "../../hooks/useTheme";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { readEnvironmentApi } from "../../environmentApi";
import { setDesktopUpdateStateQueryData } from "../../lib/desktopUpdateReactQuery";
import {
  getCustomModelOptionsByInstance,
  resolveDefaultTextGenerationBackupModelSelectionState,
  resolveAppModelSelectionState,
  resolveTextGenerationBackupModelSelectionState,
} from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  filterMaintainedProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { useShallow } from "zustand/react/shallow";
import {
  type AppState,
  selectProjectByRef,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  selectThreadByRef,
  useStore,
} from "../../store";
import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "../../lib/archivedThreadsState";
import { formatRelativeTime, formatRelativeTimeLabel } from "../../timestampFormat";
import {
  groupAutoArchiveCandidatesByProject,
  resolveAutoArchivePreviewDays,
  selectAutoArchiveCandidates,
  type AutoArchiveProjectGroup,
} from "../../threadAutoArchive";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateActive,
  type ProviderUpdateCandidate,
} from "../ProviderUpdateLaunchNotification.logic";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";
import {
  ARCHIVED_THREAD_DELETE_AGE_OPTIONS,
  type ArchivedThreadDeleteAgeDays,
  buildArchivedThreadBulkDeleteConfirmationMessage,
  buildProviderInstanceUpdatePatch,
  deriveProviderSettingsRows,
  formatArchivedThreadDeleteAgeLabel,
  formatAutoArchiveCandidateSummary,
  formatAutoArchiveDaysLabel,
  formatDiagnosticsDescription,
  formatThreadCount,
  isArchivedThreadOlderThan,
  parseArchivedThreadDeleteAgeDays,
  parseAutoArchiveDays,
  type ProviderSettingsRow,
} from "./SettingsPanels.logic";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { ProjectFavicon } from "../ProjectFavicon";
import { useServerObservability, useServerProviders } from "../../rpc/serverState";
import { newCommandId } from "../../lib/utils";
import {
  selectTerminalCommandTargetId,
  selectThreadTerminalState,
  useTerminalStateStore,
} from "../../terminalStateStore";
import { useUiStateStore } from "../../uiStateStore";
import type { ProviderAccountTerminalCommandRequest } from "./ProviderInstanceCard";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
  },
  {
    value: "light",
    label: "Light",
  },
  {
    value: "dark",
    label: "Dark",
  },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const MAINTAINED_PROVIDER_DRIVER_KINDS = DRIVER_OPTIONS.map((definition) => definition.value);
const INACTIVE_THREAD_ARCHIVE_COMMAND_DELAY_MS = 25;
const ARCHIVED_THREAD_DELETE_COMMAND_DELAY_MS = 25;
const PROVIDER_AUTH_TERMINAL_COLS = 120;
const PROVIDER_AUTH_TERMINAL_ROWS = 30;
const DEFAULT_ARCHIVED_THREAD_DELETE_AGE_DAYS: ArchivedThreadDeleteAgeDays = 90;

function waitForInactiveThreadArchiveCommandSlot(): Promise<void> {
  return new Promise((resolve) =>
    window.setTimeout(resolve, INACTIVE_THREAD_ARCHIVE_COMMAND_DELAY_MS),
  );
}

function waitForArchivedThreadDeleteCommandSlot(): Promise<void> {
  return new Promise((resolve) =>
    window.setTimeout(resolve, ARCHIVED_THREAD_DELETE_COMMAND_DELAY_MS),
  );
}

function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[key];
  return next;
}

function withoutProviderInstanceFavorites(
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  instanceId: ProviderInstanceId,
) {
  return favorites.filter((favorite) => favorite.provider !== instanceId);
}

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  const lastCheckedRelative = lastCheckedAt ? formatRelativeTime(lastCheckedAt) : null;

  if (!lastCheckedRelative) {
    return null;
  }

  return (
    <span className="text-[11px] text-muted-foreground/60">
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const queryClient = useQueryClient();
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);
  const {
    state: updateState,
    kind: updateAction,
    disabled: updateButtonDisabled,
    run: runUpdateAction,
  } = useDesktopUpdateAction();

  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";

  const handleUpdateChannelChange = useCallback(
    (channel: DesktopUpdateChannel) => {
      const bridge = window.desktopBridge;
      if (
        !bridge ||
        typeof bridge.setUpdateChannel !== "function" ||
        channel === selectedUpdateChannel
      ) {
        return;
      }

      setIsChangingUpdateChannel(true);
      void bridge
        .setUpdateChannel(channel)
        .then((state) => {
          setDesktopUpdateStateQueryData(queryClient, state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not change update track",
              description: error instanceof Error ? error.message : "Update track change failed.",
            }),
          );
        })
        .finally(() => {
          setIsChangingUpdateChannel(false);
        });
    },
    [queryClient, selectedUpdateChannel],
  );

  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;

  const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[updateAction] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    updateAction === "download" || updateAction === "install"
      ? "Update available."
      : "Current version of the application.";

  return (
    <>
      <SettingsRow
        title={<AboutVersionTitle />}
        description={description}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant={updateAction === "install" ? "default" : "outline"}
                  disabled={updateButtonDisabled}
                  onClick={runUpdateAction}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      {hasDesktopBridge ? (
        <SettingsRow
          title="Update track"
          description="Stable follows full releases. Nightly follows the nightly desktop channel and can switch back to stable immediately."
          control={
            <Select
              value={selectedUpdateChannel}
              onValueChange={(value) => {
                handleUpdateChannelChange(value as DesktopUpdateChannel);
              }}
            >
              <SelectTrigger
                className="w-full sm:w-40"
                aria-label="Update track"
                disabled={isChangingUpdateChannel}
              >
                <SelectValue>
                  {selectedUpdateChannel === "nightly" ? "Nightly" : "Stable"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  Stable
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  Nightly
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </>
  );
}

function useProviderAccountTerminalRunner():
  | ((request: ProviderAccountTerminalCommandRequest) => Promise<void>)
  | undefined {
  const navigate = useNavigate();
  const lastChatThreadRef = useUiStateStore((state) => state.lastChatThreadRef);
  const thread = useStore(
    useMemo(
      () => (state: AppState) => selectThreadByRef(state, lastChatThreadRef),
      [lastChatThreadRef],
    ),
  );
  const projectRef = useMemo(
    () => (thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null),
    [thread],
  );
  const project = useStore(
    useMemo(() => (state: AppState) => selectProjectByRef(state, projectRef), [projectRef]),
  );

  return useMemo(() => {
    if (!lastChatThreadRef || !thread || !project) {
      return undefined;
    }

    return async (request: ProviderAccountTerminalCommandRequest) => {
      const api = readEnvironmentApi(lastChatThreadRef.environmentId);
      if (!api) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not open auth terminal",
            description: "The environment API is unavailable.",
          }),
        );
        return;
      }

      const worktreePath = thread.worktreePath ?? null;
      const cwd = projectScriptCwd({
        project: { cwd: project.cwd },
        worktreePath,
      });
      const runtimeEnv = projectScriptRuntimeEnv({
        project: { cwd: project.cwd },
        worktreePath,
      });
      const terminalStore = useTerminalStateStore.getState();
      const terminalState = selectThreadTerminalState(
        terminalStore.terminalStateByThreadKey,
        lastChatThreadRef,
      );
      const terminalId = selectTerminalCommandTargetId(
        terminalStore,
        lastChatThreadRef,
        request.terminalId,
      );

      terminalStore.setTerminalLaunchContext(lastChatThreadRef, { cwd, worktreePath });
      terminalStore.ensureTerminal(lastChatThreadRef, terminalId, { open: true, active: true });
      if (terminalState.runningTerminalIds.includes(terminalId)) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: lastChatThreadRef.environmentId,
            threadId: lastChatThreadRef.threadId,
          },
        });
        toastManager.add({
          type: "warning",
          title: `${request.title} terminal is already running`,
          description: "Finish or close the current auth command before starting another one.",
        });
        return;
      }
      terminalStore.setTerminalSubmittedCommand(lastChatThreadRef, terminalId, request.command);

      try {
        await api.terminal.open({
          threadId: lastChatThreadRef.threadId,
          terminalId,
          cwd,
          ...(worktreePath !== null ? { worktreePath } : {}),
          env: runtimeEnv,
          cols: PROVIDER_AUTH_TERMINAL_COLS,
          rows: PROVIDER_AUTH_TERMINAL_ROWS,
        });
        await api.terminal.write({
          threadId: lastChatThreadRef.threadId,
          terminalId,
          data: `${request.command}\r`,
        });
        await navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: lastChatThreadRef.environmentId,
            threadId: lastChatThreadRef.threadId,
          },
        });
        toastManager.add({
          type: "success",
          title: `${request.title} started`,
          description: "The command is running in the thread terminal.",
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not start ${request.title.toLowerCase()}`,
            description:
              error instanceof Error
                ? error.message
                : "Threadlines could not write the command to the terminal.",
          }),
        );
      }
    };
  }, [lastChatThreadRef, navigate, project, thread]);
}

export function useSettingsRestore(onRestored?: () => void) {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const isGitWritingBackupModelDirty = !Equal.equals(
    settings.textGenerationBackupModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationBackupModelSelection ?? null,
  );

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.sidebarThreadPreviewCount !== DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount
        ? ["Visible threads"]
        : []),
      ...(settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap
        ? ["Diff line wrapping"]
        : []),
      ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
        ? ["Diff whitespace changes"]
        : []),
      ...(settings.diffChangesOnly !== DEFAULT_UNIFIED_SETTINGS.diffChangesOnly
        ? ["Diff changes-only view"]
        : []),
      ...(settings.chatChangedFilesDefaultExpanded !==
      DEFAULT_UNIFIED_SETTINGS.chatChangedFilesDefaultExpanded
        ? ["Changed files chat block"]
        : []),
      ...(settings.autoArchiveInactiveThreadsDays !==
      DEFAULT_UNIFIED_SETTINGS.autoArchiveInactiveThreadsDays
        ? ["Auto-archive inactive threads"]
        : []),
      ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
        ? ["Agent responses"]
        : []),
      ...(settings.usageAnalyticsEnabled !== DEFAULT_UNIFIED_SETTINGS.usageAnalyticsEnabled
        ? ["Usage analytics"]
        : []),
      ...(Duration.toMillis(settings.automaticGitFetchInterval) !==
      Duration.toMillis(DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval)
        ? ["Automatic Git fetch interval"]
        : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["Add project base directory"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(isGitWritingModelDirty ? ["Git writing model"] : []),
      ...(isGitWritingBackupModelDirty ? ["Backup git writing model"] : []),
    ],
    [
      isGitWritingBackupModelDirty,
      isGitWritingModelDirty,
      settings.autoArchiveInactiveThreadsDays,
      settings.chatChangedFilesDefaultExpanded,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.addProjectBaseDirectory,
      settings.defaultThreadEnvMode,
      settings.diffChangesOnly,
      settings.diffIgnoreWhitespace,
      settings.diffWordWrap,
      settings.automaticGitFetchInterval,
      settings.enableAssistantStreaming,
      settings.usageAnalyticsEnabled,
      settings.sidebarThreadPreviewCount,
      settings.timestampFormat,
      theme,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    setTheme("system");
    updateSettings({
      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
      diffChangesOnly: DEFAULT_UNIFIED_SETTINGS.diffChangesOnly,
      diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
      diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
      chatChangedFilesDefaultExpanded: DEFAULT_UNIFIED_SETTINGS.chatChangedFilesDefaultExpanded,
      sidebarThreadPreviewCount: DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount,
      autoArchiveInactiveThreadsDays: DEFAULT_UNIFIED_SETTINGS.autoArchiveInactiveThreadsDays,
      enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
      usageAnalyticsEnabled: DEFAULT_UNIFIED_SETTINGS.usageAnalyticsEnabled,
      automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
      defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
      textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
      textGenerationBackupModelSelection:
        DEFAULT_UNIFIED_SETTINGS.textGenerationBackupModelSelection,
    });
    onRestored?.();
  }, [changedSettingLabels, onRestored, setTheme, updateSettings]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

export function GeneralSettingsPanel({ surface = "full" }: { surface?: "full" | "phone" }) {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const isPhoneSurface = surface === "phone";
  const observability = useServerObservability();
  const serverProviders = useServerProviders();
  const diagnosticsDescription = formatDiagnosticsDescription({
    localTracingEnabled: observability?.localTracingEnabled ?? false,
    otlpTracesEnabled: observability?.otlpTracesEnabled ?? false,
    otlpTracesUrl: observability?.otlpTracesUrl,
    otlpMetricsEnabled: observability?.otlpMetricsEnabled ?? false,
    otlpMetricsUrl: observability?.otlpMetricsUrl,
  });

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const gitModelInstanceEntries = sortProviderInstanceEntries(
    filterMaintainedProviderInstanceEntries(deriveProviderInstanceEntries(serverProviders)),
  );
  const textGenInstanceEntry = gitModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const textGenerationBackupModelSelection = resolveTextGenerationBackupModelSelectionState(
    settings,
    serverProviders,
    textGenerationModelSelection,
  );
  const defaultTextGenerationBackupModelSelection =
    resolveDefaultTextGenerationBackupModelSelectionState(
      settings,
      serverProviders,
      textGenerationModelSelection,
    );
  const textGenBackupInstanceId = textGenerationBackupModelSelection?.instanceId ?? null;
  const textGenBackupModel = textGenerationBackupModelSelection?.model ?? null;
  const textGenBackupModelOptions = textGenerationBackupModelSelection?.options;
  const gitBackupModelInstanceEntries = gitModelInstanceEntries.filter(
    (entry) => entry.driverKind !== textGenProvider,
  );
  const textGenBackupInstanceEntry = textGenBackupInstanceId
    ? gitBackupModelInstanceEntries.find((entry) => entry.instanceId === textGenBackupInstanceId)
    : undefined;
  const textGenBackupProvider: ProviderDriverKind =
    textGenBackupInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const gitModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const isGitWritingBackupModelDirty = !Equal.equals(
    settings.textGenerationBackupModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationBackupModelSelection ?? null,
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="Appearance">
        <SettingsRow
          title="Theme"
          description="Choose how Threadlines looks across the app."
          resetAction={
            theme !== "system" ? (
              <SettingResetButton label="theme" onClick={() => setTheme("system")} />
            ) : null
          }
          control={
            <Select
              value={theme}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  setTheme(value);
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                <SelectValue>
                  {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Time format"
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Review & Diffs">
        <SettingsRow
          title="Diff line wrapping"
          description="Set the default wrap state when the diff panel opens."
          resetAction={
            settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
              <SettingResetButton
                label="diff line wrapping"
                onClick={() =>
                  updateSettings({
                    diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffWordWrap}
              onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
              aria-label="Wrap diff lines by default"
            />
          }
        />

        <SettingsRow
          title="Hide whitespace changes"
          description="Set whether the diff panel ignores whitespace-only edits by default."
          resetAction={
            settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
              <SettingResetButton
                label="diff whitespace changes"
                onClick={() =>
                  updateSettings({
                    diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffIgnoreWhitespace}
              onCheckedChange={(checked) =>
                updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
              }
              aria-label="Hide whitespace changes by default"
            />
          }
        />

        <SettingsRow
          title="Changed files in chat"
          description="Expand the per-turn changes tree in agent responses by default."
          resetAction={
            settings.chatChangedFilesDefaultExpanded !==
            DEFAULT_UNIFIED_SETTINGS.chatChangedFilesDefaultExpanded ? (
              <SettingResetButton
                label="changed files in chat"
                onClick={() =>
                  updateSettings({
                    chatChangedFilesDefaultExpanded:
                      DEFAULT_UNIFIED_SETTINGS.chatChangedFilesDefaultExpanded,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.chatChangedFilesDefaultExpanded}
              onCheckedChange={(checked) =>
                updateSettings({ chatChangedFilesDefaultExpanded: Boolean(checked) })
              }
              aria-label="Expand changed files tree in chat by default"
            />
          }
        />
      </SettingsSection>

      {!isPhoneSurface ? (
        <SettingsSection title="Agent Behavior">
          <SettingsRow
            title="Agent responses"
            description="Stream response text while a turn is in progress."
            resetAction={
              settings.enableAssistantStreaming !==
              DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
                <SettingResetButton
                  label="agent responses"
                  onClick={() =>
                    updateSettings({
                      enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.enableAssistantStreaming}
                onCheckedChange={(checked) =>
                  updateSettings({ enableAssistantStreaming: Boolean(checked) })
                }
                aria-label="Stream agent responses"
              />
            }
          />

          <SettingsRow
            title="Text generation model"
            description="Configure the model used for generated thread titles, branch names, commit messages, and PR text."
            resetAction={
              isGitWritingModelDirty ? (
                <SettingResetButton
                  label="text generation model"
                  onClick={() =>
                    updateSettings({
                      textGenerationModelSelection:
                        DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  activeInstanceId={textGenInstanceId}
                  model={textGenModel}
                  lockedProvider={null}
                  instanceEntries={gitModelInstanceEntries}
                  modelOptionsByInstance={gitModelOptionsByInstance}
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                  onInstanceModelChange={(instanceId, model) => {
                    const nextPrimarySelection = resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(instanceId, model),
                      },
                      serverProviders,
                    );
                    updateSettings({
                      textGenerationModelSelection: nextPrimarySelection,
                      ...(settings.textGenerationBackupModelSelection !== null
                        ? {
                            textGenerationBackupModelSelection:
                              resolveTextGenerationBackupModelSelectionState(
                                {
                                  ...settings,
                                  textGenerationModelSelection: nextPrimarySelection,
                                },
                                serverProviders,
                                nextPrimarySelection,
                              ),
                          }
                        : {}),
                    });
                  }}
                />
                <TraitsPicker
                  provider={textGenProvider}
                  models={
                    // Use the exact instance's models (rather than the
                    // first-kind-match) so a custom text-gen instance like
                    // `codex_personal` gets its own model list, not the
                    // default Codex one.
                    textGenInstanceEntry?.models ?? []
                  }
                  model={textGenModel}
                  modelOptions={textGenModelOptions}
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                  onModelOptionsChange={(nextOptions) => {
                    updateSettings({
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...settings,
                          textGenerationModelSelection: createModelSelection(
                            textGenInstanceId,
                            textGenModel,
                            nextOptions,
                          ),
                        },
                        serverProviders,
                      ),
                    });
                  }}
                />
              </div>
            }
          />

          <SettingsRow
            title="Backup text generation model"
            description="Retry generated thread titles, branch names, commit messages, and PR text with a different provider when the primary provider fails."
            resetAction={
              isGitWritingBackupModelDirty ? (
                <SettingResetButton
                  label="backup text generation model"
                  onClick={() =>
                    updateSettings({
                      textGenerationBackupModelSelection:
                        DEFAULT_UNIFIED_SETTINGS.textGenerationBackupModelSelection,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {textGenerationBackupModelSelection &&
                textGenBackupInstanceId &&
                textGenBackupModel ? (
                  <>
                    <ProviderModelPicker
                      activeInstanceId={textGenBackupInstanceId}
                      model={textGenBackupModel}
                      lockedProvider={null}
                      instanceEntries={gitBackupModelInstanceEntries}
                      modelOptionsByInstance={gitModelOptionsByInstance}
                      triggerVariant="outline"
                      triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                      onInstanceModelChange={(instanceId, model) => {
                        const nextBackupSelection = resolveTextGenerationBackupModelSelectionState(
                          {
                            ...settings,
                            textGenerationBackupModelSelection: createModelSelection(
                              instanceId,
                              model,
                            ),
                          },
                          serverProviders,
                          textGenerationModelSelection,
                        );
                        if (!nextBackupSelection) return;
                        updateSettings({
                          textGenerationBackupModelSelection: nextBackupSelection,
                        });
                      }}
                    />
                    <TraitsPicker
                      provider={textGenBackupProvider}
                      models={textGenBackupInstanceEntry?.models ?? []}
                      model={textGenBackupModel}
                      modelOptions={textGenBackupModelOptions}
                      triggerVariant="outline"
                      triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                      onModelOptionsChange={(nextOptions) => {
                        const nextBackupSelection = resolveTextGenerationBackupModelSelectionState(
                          {
                            ...settings,
                            textGenerationBackupModelSelection: createModelSelection(
                              textGenBackupInstanceId,
                              textGenBackupModel,
                              nextOptions,
                            ),
                          },
                          serverProviders,
                          textGenerationModelSelection,
                        );
                        if (!nextBackupSelection) return;
                        updateSettings({
                          textGenerationBackupModelSelection: nextBackupSelection,
                        });
                      }}
                    />
                  </>
                ) : defaultTextGenerationBackupModelSelection ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() =>
                      updateSettings({
                        textGenerationBackupModelSelection:
                          defaultTextGenerationBackupModelSelection,
                      })
                    }
                  >
                    <PlusIcon className="size-3.5" />
                    <span>Add backup</span>
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">No different provider ready</span>
                )}
              </div>
            }
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title="Projects & Threads">
        {!isPhoneSurface ? (
          <>
            <SettingsRow
              title="New threads"
              description="Pick the default workspace mode for newly created draft threads."
              resetAction={
                settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
                  <SettingResetButton
                    label="new threads"
                    onClick={() =>
                      updateSettings({
                        defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Select
                  value={settings.defaultThreadEnvMode}
                  onValueChange={(value) => {
                    if (value === "local" || value === "worktree") {
                      updateSettings({ defaultThreadEnvMode: value });
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                    <SelectValue>
                      {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="local">
                      Local
                    </SelectItem>
                    <SelectItem hideIndicator value="worktree">
                      New worktree
                    </SelectItem>
                  </SelectPopup>
                </Select>
              }
            />

            <SettingsRow
              title="Add project starts in"
              description='Leave empty to start in your home folder ("~/"). On Windows, Desktop follows the real user Desktop folder, including OneDrive redirection.'
              resetAction={
                settings.addProjectBaseDirectory !==
                DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
                  <SettingResetButton
                    label="add project base directory"
                    onClick={() =>
                      updateSettings({
                        addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                      })
                    }
                  />
                ) : null
              }
              control={
                <DraftInput
                  className="w-full sm:w-72"
                  value={settings.addProjectBaseDirectory}
                  onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
                  placeholder="~/"
                  spellCheck={false}
                  aria-label="Add project base directory"
                />
              }
            />
          </>
        ) : null}

        <SettingsRow
          title="Archive confirmation"
          description="Require a second click on the inline archive action before a thread is archived."
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="archive confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label="Confirm thread archiving"
            />
          }
        />

        <SettingsRow
          title="Delete confirmation"
          description="Ask before deleting a thread and its chat history."
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="Confirm thread deletion"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="About">
        {isElectron ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description="Current version of the application."
          />
        )}
        {!isPhoneSurface ? (
          <>
            <SettingsRow
              title="Usage analytics"
              description="Share anonymous usage events so we can understand installs, active usage, providers, and reliability. Threadlines does not send prompts, code, file paths, repository names, terminal output, or secrets."
              resetAction={
                settings.usageAnalyticsEnabled !==
                DEFAULT_UNIFIED_SETTINGS.usageAnalyticsEnabled ? (
                  <SettingResetButton
                    label="usage analytics"
                    onClick={() =>
                      updateSettings({
                        usageAnalyticsEnabled: DEFAULT_UNIFIED_SETTINGS.usageAnalyticsEnabled,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.usageAnalyticsEnabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ usageAnalyticsEnabled: Boolean(checked) })
                  }
                  aria-label="Share anonymous usage analytics"
                />
              }
            />
            <SettingsRow
              title="Diagnostics"
              description={diagnosticsDescription}
              control={
                <Button render={<Link to="/settings/diagnostics" />} size="xs" variant="outline">
                  View diagnostics
                </Button>
              }
            />
          </>
        ) : (
          <SettingsRow
            title="Phone settings"
            description="Only browser-local preferences are shown here on the hosted phone app."
          />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function ProviderSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverProviders = useServerProviders();
  const runProviderTerminalCommand = useProviderAccountTerminalRunner();
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [updatingProviderDrivers, setUpdatingProviderDrivers] = useState<
    ReadonlySet<ProviderDriverKind>
  >(() => new Set());
  const [resolvingProviderUpdateBlockers, setResolvingProviderUpdateBlockers] = useState<
    ReadonlySet<ProviderInstanceId>
  >(() => new Set());
  const [openInstanceDetails, setOpenInstanceDetails] = useState<Record<string, boolean>>({});
  const {
    pendingRateLimitResetCredit,
    isConsumingRateLimitResetCredit,
    requestRateLimitResetCredit,
    rateLimitResetCreditDialog,
  } = useProviderRateLimitResetCredit();
  const refreshingRef = useRef(false);

  const providerUpdateCandidates = useMemo(
    () => collectProviderUpdateCandidates(serverProviders),
    [serverProviders],
  );
  const providerUpdateCandidateByInstanceId = useMemo(
    () => new Map(providerUpdateCandidates.map((candidate) => [candidate.instanceId, candidate])),
    [providerUpdateCandidates],
  );
  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenerationBackupModelSelection = resolveTextGenerationBackupModelSelectionState(
    settings,
    serverProviders,
    textGenerationModelSelection,
  );
  const textGenBackupInstanceId = textGenerationBackupModelSelection?.instanceId ?? null;
  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void ensureLocalApi()
      .server.refreshProviders()
      .catch((error: unknown) => {
        console.warn("Failed to refresh providers", error);
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshingProviders(false);
      });
  }, []);

  const runProviderUpdate = useCallback(async (candidate: ProviderUpdateCandidate) => {
    let started = false;
    setUpdatingProviderDrivers((previous) => {
      if (previous.has(candidate.driver)) {
        return previous;
      }
      started = true;
      const next = new Set(previous);
      next.add(candidate.driver);
      return next;
    });
    if (!started) {
      return;
    }

    try {
      await ensureLocalApi().server.updateProvider({
        provider: candidate.driver,
        instanceId: candidate.instanceId,
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not update ${PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver}`,
          description:
            error instanceof Error
              ? error.message
              : "The provider update command could not be started.",
        }),
      );
    } finally {
      setUpdatingProviderDrivers((previous) => {
        if (!previous.has(candidate.driver)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(candidate.driver);
        return next;
      });
    }
  }, []);

  const resolveProviderUpdateBlockers = useCallback(async (candidate: ProviderUpdateCandidate) => {
    let started = false;
    setResolvingProviderUpdateBlockers((previous) => {
      if (previous.has(candidate.instanceId)) {
        return previous;
      }
      started = true;
      const next = new Set(previous);
      next.add(candidate.instanceId);
      return next;
    });
    if (!started) {
      return;
    }

    try {
      const result = await ensureLocalApi().server.resolveProviderUpdateBlockers({
        provider: candidate.driver,
        instanceId: candidate.instanceId,
      });
      toastManager.add({
        type: result.remainingProcessCount > 0 ? "warning" : "success",
        title:
          result.remainingProcessCount > 0 ? "Claude is still running" : "Claude processes stopped",
        description: result.message,
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not stop Claude processes",
          description:
            error instanceof Error
              ? error.message
              : "Threadlines could not stop the processes blocking this update.",
        }),
      );
    } finally {
      setResolvingProviderUpdateBlockers((previous) => {
        if (!previous.has(candidate.instanceId)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(candidate.instanceId);
        return next;
      });
    }
  }, []);

  const rows = useMemo(
    () =>
      deriveProviderSettingsRows({
        settings,
        maintainedDriverKinds: MAINTAINED_PROVIDER_DRIVER_KINDS,
      }),
    [settings],
  );

  const updateProviderInstance = (
    row: ProviderSettingsRow,
    next: ProviderInstanceConfig,
    options?: {
      readonly textGenerationModelSelection?: Parameters<
        typeof buildProviderInstanceUpdatePatch
      >[0]["textGenerationModelSelection"];
      readonly textGenerationBackupModelSelection?: Parameters<
        typeof buildProviderInstanceUpdatePatch
      >[0]["textGenerationBackupModelSelection"];
    },
  ) => {
    updateSettings(
      buildProviderInstanceUpdatePatch({
        settings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
        textGenerationModelSelection: options?.textGenerationModelSelection,
        textGenerationBackupModelSelection: options?.textGenerationBackupModelSelection,
      }),
    );
  };

  const deleteProviderInstance = (id: ProviderInstanceId) => {
    updateSettings({
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, id),
      providerModelPreferences: withoutProviderInstanceKey(settings.providerModelPreferences, id),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], id),
      ...(textGenBackupInstanceId === id ? { textGenerationBackupModelSelection: null } : {}),
    });
  };

  const updateProviderModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderInstanceKey(settings.providerModelPreferences, instanceId);
    updateSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : {
              ...rest,
              [instanceId]: {
                hiddenModels,
                modelOrder,
              },
            },
    });
  };

  const updateProviderFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(nextFavoriteModels.map((slug) => slug.trim()).filter((slug) => slug.length > 0)),
    ];
    updateSettings({
      favorites: [
        ...withoutProviderInstanceFavorites(settings.favorites ?? [], instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  const resetDefaultInstance = (driverKind: ProviderDriverKind) => {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings | undefined
    >;
    const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
    const defaultLegacyProvider = defaultLegacyProviders[driverKind];
    if (defaultLegacyProvider === undefined) return;
    updateSettings({
      providers: {
        ...settings.providers,
        [driverKind]: defaultLegacyProvider,
      } as typeof settings.providers,
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, defaultInstanceId),
      providerModelPreferences: withoutProviderInstanceKey(
        settings.providerModelPreferences,
        defaultInstanceId,
      ),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], defaultInstanceId),
    });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Providers"
        headerAction={
          <div className="flex items-center gap-1.5">
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    onClick={() => setIsAddInstanceDialogOpen(true)}
                    aria-label="Add provider instance"
                  >
                    <PlusIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Add provider instance</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={isRefreshingProviders}
                    onClick={() => void refreshProviders()}
                    aria-label="Refresh provider status"
                  >
                    {isRefreshingProviders ? (
                      <LoaderIcon className="size-3 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh provider status</TooltipPopup>
            </Tooltip>
          </div>
        }
        contentClassName="overflow-visible rounded-none border-0 bg-transparent shadow-none before:hidden dark:shadow-none"
      >
        <div className="space-y-2.5">
          {rows.map((row) => {
            const driverOption = getDriverOption(row.driver);
            const liveProvider = serverProviders.find(
              (candidate) => candidate.instanceId === row.instanceId,
            );
            const updateCandidate = liveProvider
              ? providerUpdateCandidateByInstanceId.get(liveProvider.instanceId)
              : undefined;
            const isDriverUpdateRunning =
              updateCandidate !== undefined &&
              (updatingProviderDrivers.has(updateCandidate.driver) ||
                serverProviders.some(
                  (provider) =>
                    provider.driver === updateCandidate.driver && isProviderUpdateActive(provider),
                ));
            const showInlineUpdateButton =
              updateCandidate !== undefined &&
              hasOneClickUpdateProviderCandidate(updateCandidate, serverProviders);
            const canRunInlineUpdate =
              updateCandidate !== undefined &&
              canOneClickUpdateProviderCandidate(updateCandidate, serverProviders) &&
              !updatingProviderDrivers.has(updateCandidate.driver);
            const isResolvingUpdateBlockers =
              updateCandidate !== undefined &&
              resolvingProviderUpdateBlockers.has(updateCandidate.instanceId);
            const modelPreferences = settings.providerModelPreferences?.[row.instanceId] ?? {
              hiddenModels: [],
              modelOrder: [],
            };
            const favoriteModels = (settings.favorites ?? [])
              .filter((favorite) => favorite.provider === row.instanceId)
              .map((favorite) => favorite.model);
            const canResetProviderUsage = canRequestProviderRateLimitResetCredit(
              liveProvider,
              liveProvider?.accountUsage?.rateLimitResetCredits?.availableCount,
            );
            const resetLabel = driverOption?.label ?? String(row.driver);
            const headerAction =
              row.isDefault && row.isDirty ? (
                <SettingResetButton
                  label={`${resetLabel} provider settings`}
                  onClick={() => resetDefaultInstance(row.driver)}
                />
              ) : null;
            return (
              <ProviderInstanceCard
                key={row.instanceId}
                instanceId={row.instanceId}
                instance={row.instance}
                driverOption={driverOption}
                liveProvider={liveProvider}
                isExpanded={openInstanceDetails[row.instanceId] ?? false}
                onExpandedChange={(open) =>
                  setOpenInstanceDetails((existing) => ({
                    ...existing,
                    [row.instanceId]: open,
                  }))
                }
                onUpdate={(next) => {
                  const wasEnabled = row.instance.enabled ?? true;
                  const isDisabling = next.enabled === false && wasEnabled;
                  const shouldClearTextGen = isDisabling && textGenInstanceId === row.instanceId;
                  const shouldClearBackupTextGen =
                    isDisabling && textGenBackupInstanceId === row.instanceId;
                  if (shouldClearTextGen) {
                    updateProviderInstance(row, next, {
                      textGenerationModelSelection:
                        DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                      ...(shouldClearBackupTextGen
                        ? { textGenerationBackupModelSelection: null }
                        : {}),
                    });
                  } else if (shouldClearBackupTextGen) {
                    updateProviderInstance(row, next, {
                      textGenerationBackupModelSelection: null,
                    });
                  } else {
                    updateProviderInstance(row, next);
                  }
                }}
                onDelete={row.isDefault ? undefined : () => deleteProviderInstance(row.instanceId)}
                headerAction={headerAction}
                hiddenModels={modelPreferences.hiddenModels}
                favoriteModels={favoriteModels}
                modelOrder={modelPreferences.modelOrder}
                onHiddenModelsChange={(hiddenModels) =>
                  updateProviderModelPreferences(row.instanceId, {
                    ...modelPreferences,
                    hiddenModels,
                  })
                }
                onFavoriteModelsChange={(favoriteModels) =>
                  updateProviderFavoriteModels(row.instanceId, favoriteModels)
                }
                onModelOrderChange={(modelOrder) =>
                  updateProviderModelPreferences(row.instanceId, {
                    ...modelPreferences,
                    modelOrder,
                  })
                }
                onRunUpdate={
                  showInlineUpdateButton && updateCandidate
                    ? () => {
                        if (!canRunInlineUpdate) {
                          return;
                        }
                        void runProviderUpdate(updateCandidate);
                      }
                    : undefined
                }
                isUpdating={showInlineUpdateButton ? isDriverUpdateRunning : undefined}
                onResolveUpdateBlockers={
                  showInlineUpdateButton && updateCandidate
                    ? () => {
                        if (isResolvingUpdateBlockers) {
                          return;
                        }
                        void resolveProviderUpdateBlockers(updateCandidate);
                      }
                    : undefined
                }
                isResolvingUpdateBlockers={isResolvingUpdateBlockers}
                onResetAccountUsage={
                  canResetProviderUsage ? requestRateLimitResetCredit : undefined
                }
                accountUsageResetInFlight={
                  pendingRateLimitResetCredit?.instanceId === row.instanceId
                    ? isConsumingRateLimitResetCredit
                    : undefined
                }
                onRunTerminalCommand={runProviderTerminalCommand}
              />
            );
          })}
        </div>
      </SettingsSection>

      <AddProviderInstanceDialog
        open={isAddInstanceDialogOpen}
        onOpenChange={setIsAddInstanceDialogOpen}
      />
      {rateLimitResetCreditDialog}
    </SettingsPageContainer>
  );
}

function buildAutoArchiveConfirmationMessage(input: {
  readonly action: "enable" | "archive-now";
  readonly days: Exclude<AutoArchiveInactiveThreadsDays, 0>;
  readonly groups: ReadonlyArray<AutoArchiveProjectGroup>;
}): string {
  const count = input.groups.reduce((total, group) => total + group.count, 0);
  const projectLines = input.groups.slice(0, 6).map((group) => {
    const projectName = group.project?.name ?? "Unknown project";
    return `- ${projectName}: ${formatThreadCount(group.count)}`;
  });
  const remainingProjectCount = input.groups.length - projectLines.length;

  return [
    input.action === "enable"
      ? `Enable auto-archive after ${input.days} days?`
      : `Archive ${formatThreadCount(count)} inactive now?`,
    `This will move ${formatThreadCount(count)} inactive for ${input.days}+ days into Archive.`,
    "Pinned, running, approval, user-input, and actionable plan threads are skipped.",
    "",
    ...projectLines,
    ...(remainingProjectCount > 0 ? [`- ${remainingProjectCount} more projects`] : []),
  ].join("\n");
}

function AutoArchiveCandidatePreview({
  groups,
  days,
}: {
  readonly groups: ReadonlyArray<AutoArchiveProjectGroup>;
  readonly days: Exclude<AutoArchiveInactiveThreadsDays, 0>;
}) {
  if (groups.length === 0) {
    return (
      <div className="mt-3 border-t border-border/60 py-2.5 text-xs text-muted-foreground/75">
        No threads are currently inactive for {days}+ days.
      </div>
    );
  }

  const visibleGroups = groups.slice(0, 5);
  const remainingGroupCount = groups.length - visibleGroups.length;

  return (
    <div className="mt-3 border-t border-border/60 py-2.5">
      <div className="grid gap-1.5 text-xs">
        {visibleGroups.map((group) => (
          <div
            key={`${group.threads[0]?.environmentId ?? "unknown"}:${group.threads[0]?.projectId ?? "unknown"}`}
            className="flex min-w-0 items-center justify-between gap-3"
          >
            <span className="min-w-0 truncate text-muted-foreground">
              {group.project?.name ?? "Unknown project"}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground/80">
              {formatThreadCount(group.count)}
            </span>
          </div>
        ))}
        {remainingGroupCount > 0 ? (
          <div className="text-xs text-muted-foreground/70">
            {remainingGroupCount} more projects have eligible inactive threads.
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ArchivedThreadsPanel() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const sidebarThreads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const { unarchiveThread, deleteThread, confirmAndDeleteThread } = useThreadActions();
  const [isArchivingInactiveThreads, setIsArchivingInactiveThreads] = useState(false);
  const [isDeletingArchivedThreads, setIsDeletingArchivedThreads] = useState(false);
  const [archivedThreadDeleteAgeDays, setArchivedThreadDeleteAgeDays] =
    useState<ArchivedThreadDeleteAgeDays>(DEFAULT_ARCHIVED_THREAD_DELETE_AGE_DAYS);
  const environmentIds = useMemo(
    () => [...new Set(projects.map((project) => project.environmentId))],
    [projects],
  );
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(environmentIds);
  const autoArchivePreviewDays = resolveAutoArchivePreviewDays(
    settings.autoArchiveInactiveThreadsDays,
  );
  const inactiveThreadCandidates = useMemo(
    () =>
      selectAutoArchiveCandidates({
        threads: sidebarThreads,
        inactiveDays: autoArchivePreviewDays,
      }),
    [autoArchivePreviewDays, sidebarThreads],
  );
  const inactiveThreadGroups = useMemo(
    () =>
      groupAutoArchiveCandidatesByProject({
        candidates: inactiveThreadCandidates,
        projects,
      }),
    [inactiveThreadCandidates, projects],
  );

  const archivedGroups = useMemo(() => {
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects.map(
          (project) =>
            [
              `${environmentId}:${project.id}`,
              {
                id: project.id,
                environmentId,
                name: project.title,
                cwd: project.workspaceRoot,
              },
            ] as const,
        ),
      ),
    );
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => ({
        ...thread,
        environmentId,
      })),
    );

    return [...projectsByEnvironmentAndId.values()]
      .map((project) => ({
        project,
        threads: threads
          .filter(
            (thread) =>
              thread.projectId === project.id && thread.environmentId === project.environmentId,
          )
          .toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
      }))
      .filter((group) => group.threads.length > 0);
  }, [archivedSnapshots]);

  const archivedDeleteSelection = useMemo(() => {
    const nowMs = Date.now();
    const groups = archivedGroups
      .map(({ project, threads }) => {
        const selectedThreads = threads.filter((thread) =>
          isArchivedThreadOlderThan({
            archivedAt: thread.archivedAt,
            olderThanDays: archivedThreadDeleteAgeDays,
            nowMs,
          }),
        );

        return {
          projectName: project.name,
          count: selectedThreads.length,
          threads: selectedThreads,
        };
      })
      .filter((group) => group.count > 0);

    return {
      groups,
      threads: groups.flatMap((group) => group.threads),
    };
  }, [archivedGroups, archivedThreadDeleteAgeDays]);

  const handleAutoArchiveDaysChange = useCallback(
    async (value: string) => {
      const nextDays = parseAutoArchiveDays(value);
      if (nextDays === null || nextDays === settings.autoArchiveInactiveThreadsDays) {
        return;
      }

      if (nextDays !== 0) {
        const nextCandidates = selectAutoArchiveCandidates({
          threads: sidebarThreads,
          inactiveDays: nextDays,
        });
        if (nextCandidates.length > 0) {
          const confirmed = await ensureLocalApi().dialogs.confirm(
            buildAutoArchiveConfirmationMessage({
              action: "enable",
              days: nextDays,
              groups: groupAutoArchiveCandidatesByProject({
                candidates: nextCandidates,
                projects,
              }),
            }),
          );
          if (!confirmed) {
            return;
          }
        }
      }

      updateSettings({ autoArchiveInactiveThreadsDays: nextDays });
    },
    [projects, settings.autoArchiveInactiveThreadsDays, sidebarThreads, updateSettings],
  );

  const archiveInactiveThreadsNow = useCallback(async () => {
    if (inactiveThreadCandidates.length === 0 || isArchivingInactiveThreads) {
      return;
    }

    const confirmed = await ensureLocalApi().dialogs.confirm(
      buildAutoArchiveConfirmationMessage({
        action: "archive-now",
        days: autoArchivePreviewDays,
        groups: inactiveThreadGroups,
      }),
    );
    if (!confirmed) {
      return;
    }

    setIsArchivingInactiveThreads(true);
    let archivedCount = 0;
    let failedCount = 0;

    try {
      for (const thread of inactiveThreadCandidates) {
        const api = readEnvironmentApi(thread.environmentId);
        if (!api) {
          failedCount += 1;
          continue;
        }

        try {
          await api.orchestration.dispatchCommand({
            type: "thread.archive",
            commandId: newCommandId(),
            threadId: thread.id,
          });
          archivedCount += 1;
          refreshArchivedThreadsForEnvironment(thread.environmentId);
        } catch (error) {
          failedCount += 1;
          console.warn("Failed to archive inactive thread", {
            threadId: thread.id,
            environmentId: thread.environmentId,
            error,
          });
        }

        await waitForInactiveThreadArchiveCommandSlot();
      }

      if (archivedCount > 0) {
        toastManager.add({
          type: "success",
          title:
            archivedCount === 1
              ? "Archived one inactive thread"
              : `Archived ${archivedCount} inactive threads`,
          description: "Archived threads stay available from this page.",
        });
        refreshArchivedThreads();
      }

      if (failedCount > 0) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title:
              failedCount === 1
                ? "One inactive thread could not be archived"
                : `${failedCount} inactive threads could not be archived`,
            description: "Some environments may still be reconnecting.",
          }),
        );
      }
    } finally {
      setIsArchivingInactiveThreads(false);
    }
  }, [
    autoArchivePreviewDays,
    inactiveThreadCandidates,
    inactiveThreadGroups,
    isArchivingInactiveThreads,
    refreshArchivedThreads,
  ]);

  const handleArchivedThreadDeleteAgeChange = useCallback((value: string) => {
    const nextDays = parseArchivedThreadDeleteAgeDays(value);
    if (nextDays !== null) {
      setArchivedThreadDeleteAgeDays(nextDays);
    }
  }, []);

  const deleteArchivedThreadsByAge = useCallback(async () => {
    const threads = archivedDeleteSelection.threads;
    if (threads.length === 0 || isDeletingArchivedThreads) {
      return;
    }

    const confirmed = await ensureLocalApi().dialogs.confirm(
      buildArchivedThreadBulkDeleteConfirmationMessage({
        days: archivedThreadDeleteAgeDays,
        groups: archivedDeleteSelection.groups,
      }),
    );
    if (!confirmed) {
      return;
    }

    setIsDeletingArchivedThreads(true);
    let deletedCount = 0;
    let failedCount = 0;

    try {
      for (const thread of threads) {
        const api = readEnvironmentApi(thread.environmentId);
        if (!api) {
          failedCount += 1;
          continue;
        }

        try {
          await deleteThread(scopeThreadRef(thread.environmentId, thread.id));
          deletedCount += 1;
        } catch (error) {
          failedCount += 1;
          console.warn("Failed to delete archived thread", {
            threadId: thread.id,
            environmentId: thread.environmentId,
            error,
          });
        }

        await waitForArchivedThreadDeleteCommandSlot();
      }

      if (deletedCount > 0) {
        toastManager.add({
          type: "success",
          title:
            deletedCount === 1
              ? "Deleted one archived thread"
              : `Deleted ${deletedCount} archived threads`,
          description: `Deleted threads archived for ${archivedThreadDeleteAgeDays}+ days.`,
        });
        refreshArchivedThreads();
      }

      if (failedCount > 0) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title:
              failedCount === 1
                ? "One archived thread could not be deleted"
                : `${failedCount} archived threads could not be deleted`,
            description: "Some environments may still be reconnecting.",
          }),
        );
      }
    } finally {
      setIsDeletingArchivedThreads(false);
    }
  }, [
    archivedDeleteSelection,
    archivedThreadDeleteAgeDays,
    deleteThread,
    isDeletingArchivedThreads,
    refreshArchivedThreads,
  ]);

  const deleteArchivedThread = useCallback(
    async (threadRef: ScopedThreadRef, title: string) => {
      try {
        await confirmAndDeleteThread(threadRef, { title });
        refreshArchivedThreads();
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [confirmAndDeleteThread, refreshArchivedThreads],
  );

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, title: string, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        try {
          await unarchiveThread(threadRef);
          refreshArchivedThreads();
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unarchive thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (clicked === "delete") {
        await deleteArchivedThread(threadRef, title);
      }
    },
    [deleteArchivedThread, refreshArchivedThreads, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="Thread cleanup">
        <SettingsRow
          title="Auto-archive inactive threads"
          description="Moves old inactive threads out of active lists without deleting their history."
          status={
            settings.autoArchiveInactiveThreadsDays === 0
              ? formatAutoArchiveCandidateSummary(inactiveThreadCandidates.length, 0)
              : formatAutoArchiveCandidateSummary(
                  inactiveThreadCandidates.length,
                  settings.autoArchiveInactiveThreadsDays,
                )
          }
          resetAction={
            settings.autoArchiveInactiveThreadsDays !==
            DEFAULT_UNIFIED_SETTINGS.autoArchiveInactiveThreadsDays ? (
              <SettingResetButton
                label="auto-archive inactive threads"
                onClick={() =>
                  updateSettings({
                    autoArchiveInactiveThreadsDays:
                      DEFAULT_UNIFIED_SETTINGS.autoArchiveInactiveThreadsDays,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.autoArchiveInactiveThreadsDays)}
              onValueChange={(value) => {
                if (value !== null) {
                  void handleAutoArchiveDaysChange(value);
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-36" aria-label="Auto-archive inactive threads">
                <SelectValue>
                  {formatAutoArchiveDaysLabel(settings.autoArchiveInactiveThreadsDays)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {AUTO_ARCHIVE_INACTIVE_THREADS_DAY_OPTIONS.map((days) => (
                  <SelectItem key={days} hideIndicator value={String(days)}>
                    {formatAutoArchiveDaysLabel(days)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        >
          <AutoArchiveCandidatePreview
            groups={inactiveThreadGroups}
            days={autoArchivePreviewDays}
          />
        </SettingsRow>
        <SettingsRow
          title="Archive inactive threads now"
          description="Review the same safe candidates and move them to Archive immediately."
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
              disabled={inactiveThreadCandidates.length === 0 || isArchivingInactiveThreads}
              onClick={() => void archiveInactiveThreadsNow()}
            >
              {isArchivingInactiveThreads ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <ArchiveIcon className="size-3.5" />
              )}
              <span>
                {isArchivingInactiveThreads
                  ? "Archiving"
                  : inactiveThreadCandidates.length === 0
                    ? "Nothing to Archive"
                    : `Archive ${formatThreadCount(inactiveThreadCandidates.length)}`}
              </span>
            </Button>
          }
        />
        <SettingsRow
          title="Delete old archived threads"
          description="Permanently removes archived threads by how long they have been in Archive."
          status={`${formatThreadCount(archivedDeleteSelection.threads.length)} archived for ${archivedThreadDeleteAgeDays}+ days.`}
          control={
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
              <Select
                value={String(archivedThreadDeleteAgeDays)}
                onValueChange={(value) => {
                  if (value !== null) {
                    handleArchivedThreadDeleteAgeChange(value);
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-36" aria-label="Archived thread delete age">
                  <SelectValue>
                    {formatArchivedThreadDeleteAgeLabel(archivedThreadDeleteAgeDays)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {ARCHIVED_THREAD_DELETE_AGE_OPTIONS.map((days) => (
                    <SelectItem key={days} hideIndicator value={String(days)}>
                      {formatArchivedThreadDeleteAgeLabel(days)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                type="button"
                variant="destructive-outline"
                size="sm"
                className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                disabled={archivedDeleteSelection.threads.length === 0 || isDeletingArchivedThreads}
                onClick={() => void deleteArchivedThreadsByAge()}
              >
                {isDeletingArchivedThreads ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : (
                  <Trash2Icon className="size-3.5" />
                )}
                <span>
                  {isDeletingArchivedThreads
                    ? "Deleting"
                    : archivedDeleteSelection.threads.length === 0
                      ? "Nothing to Delete"
                      : `Delete ${formatThreadCount(archivedDeleteSelection.threads.length)}`}
                </span>
              </Button>
            </div>
          }
        />
      </SettingsSection>
      {archivedGroups.length === 0 ? (
        <SettingsSection title="Archived threads">
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchive ? (
                  <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchive
                  ? "Loading archived threads"
                  : archiveError
                    ? "Could not load archived threads"
                    : "No archived threads"}
              </span>
            }
            description={
              isLoadingArchive
                ? "Checking connected environments."
                : (archiveError ?? "Archived threads will appear here.")
            }
          />
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }) => (
          <SettingsSection
            key={project.id}
            title={project.name}
            icon={<ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />}
          >
            {projectThreads.map((thread) => (
              <SettingsRow
                key={thread.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void handleArchivedThreadContextMenu(
                    scopeThreadRef(thread.environmentId, thread.id),
                    thread.title,
                    {
                      x: event.clientX,
                      y: event.clientY,
                    },
                  );
                }}
                title={thread.title}
                description={
                  <>
                    Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                    {" \u00b7 Created "}
                    {formatRelativeTimeLabel(thread.createdAt)}
                  </>
                }
                control={
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                      onClick={() =>
                        void unarchiveThread(scopeThreadRef(thread.environmentId, thread.id))
                          .then(() => refreshArchivedThreads())
                          .catch((error) => {
                            toastManager.add(
                              stackedThreadToast({
                                type: "error",
                                title: "Failed to unarchive thread",
                                description:
                                  error instanceof Error ? error.message : "An error occurred.",
                              }),
                            );
                          })
                      }
                    >
                      <ArchiveX className="size-3.5" />
                      <span>Unarchive</span>
                    </Button>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="destructive-outline"
                            size="icon-xs"
                            className="size-7 rounded-md text-destructive-foreground"
                            aria-label={`Delete archived thread ${thread.title}`}
                            onClick={() =>
                              void deleteArchivedThread(
                                scopeThreadRef(thread.environmentId, thread.id),
                                thread.title,
                              )
                            }
                          >
                            <Trash2Icon className="size-3.5" />
                          </Button>
                        }
                      />
                      <TooltipPopup side="top">Delete thread</TooltipPopup>
                    </Tooltip>
                  </div>
                }
              />
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
