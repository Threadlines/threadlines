import {
  ArchiveIcon,
  ChevronRightIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatTokens, formatUsd } from "@threadlines/shared/usageFormat";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AUTO_ARCHIVE_INACTIVE_THREADS_DAY_OPTIONS,
  type AutoArchiveInactiveThreadsDays,
  defaultInstanceIdForDriver,
  type DesktopUpdateChannel,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type UsageWindowDays,
} from "@threadlines/contracts";
import { scopeThreadRef } from "@threadlines/client-runtime";
import { agentInvitesChoice, agentThreadsMode } from "@threadlines/shared/serverSettings";
import { DEFAULT_UNIFIED_SETTINGS } from "@threadlines/contracts/settings";
import {
  PROVIDER_ACCOUNT_DRIVER_KINDS,
  supportsProviderAccounts,
} from "@threadlines/shared/providerAccounts";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import { APP_VERSION } from "../../branding";
import { getDesktopUpdateButtonTooltip } from "../../components/desktopUpdate.logic";
import {
  canRequestProviderRateLimitResetCredit,
  useProviderRateLimitResetCredit,
} from "../ProviderRateLimitResetCredit";
import { isElectron } from "../../env";
import { useDesktopUpdateAction } from "../../hooks/useDesktopUpdateAction";
import { useTheme } from "../../hooks/useTheme";
import { updateSettingsAndPersist, useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { readEnvironmentApi } from "../../environmentApi";
import { setDesktopUpdateStateQueryData } from "../../lib/desktopUpdateReactQuery";
import {
  deriveUsageWindow,
  usageSummaryQueryOptions,
  useUsageEnvironmentTargets,
} from "../../lib/usageReactQuery";
import {
  resolveAppModelSelectionState,
  resolveTextGenerationBackupModelSelectionState,
} from "../../modelSelection";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { useShallow } from "zustand/react/shallow";
import {
  selectBootstrapCompleteForActiveEnvironment,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "../../lib/archivedThreadsState";
import { formatRelativeTime } from "../../timestampFormat";
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
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import {
  type ArchivedThreadItem,
  type ArchivedThreadProject,
  ArchivedThreadsSection,
} from "./ArchivedThreadsSection";
import { ProviderInstanceCard, type ProviderAddAccountControls } from "./ProviderInstanceCard";
import { addAccountMenuLabel, isThreadlinesAccountFolder } from "./providerAccounts.logic";
import { formatProviderInstanceName } from "../../providerInstances";
import { getDriverOption } from "./providerDriverMeta";
import { thisComputerLabel } from "./agentStatus";
import {
  buildProviderEnablementPatch,
  deriveMaintainedProviderRows,
  isProviderRowEnabled,
} from "./providerEnablement";
import { useProviderUpdateRunner } from "./useProviderUpdateRunner";
import { usePrimaryEnvironmentDescriptor } from "../../environments/primary/context";
import {
  ARCHIVED_THREAD_DELETE_AGE_OPTIONS,
  type ArchivedThreadDeleteAgeDays,
  buildArchivedThreadBulkDeleteConfirmationMessage,
  buildProviderInstanceUpdatePatch,
  compareArchivedThreadsNewestFirst,
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
import { DictationSettings } from "./DictationSettings";
import {
  SettingResetButton,
  SettingsGroup,
  SettingsPageContainer,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useServerObservability, useServerProviders } from "../../rpc/serverState";
import { cn, newCommandId } from "../../lib/utils";
import { roomsEnabledFor } from "../../hooks/useRoomsEnabled";

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

const INACTIVE_THREAD_ARCHIVE_COMMAND_DELAY_MS = 25;
const ARCHIVED_THREAD_DELETE_COMMAND_DELAY_MS = 25;
const DEFAULT_ARCHIVED_THREAD_DELETE_AGE_DAYS: ArchivedThreadDeleteAgeDays = 90;
/** A month reads as "recently" without being a single noisy week. */
const USAGE_SETTINGS_WINDOW_DAYS: UsageWindowDays = 30;

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
    <span className="me-1 text-[11.5px] text-muted-foreground">
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
          description="Stable gets full releases. Nightly gets a new build every day, and you can switch back any time."
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
                <SelectItem value="latest">Stable</SelectItem>
                <SelectItem value="nightly">Nightly</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </>
  );
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
  const writingStyle = settings.sourceControlWritingStyle;
  const defaultWritingStyle = DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle;
  const isSourceControlWritingStyleDirty =
    writingStyle.mode !== defaultWritingStyle.mode ||
    writingStyle.customInstructions !== defaultWritingStyle.customInstructions ||
    writingStyle.followPrTemplates !== defaultWritingStyle.followPrTemplates;
  const isSourceControlWriterModelDirty = !Equal.equals(
    settings.sourceControlWriterModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.sourceControlWriterModelSelection ?? null,
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
        ? ["Wrap diff lines"]
        : []),
      ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
        ? ["Diff whitespace changes"]
        : []),
      ...(settings.diffChangesOnly !== DEFAULT_UNIFIED_SETTINGS.diffChangesOnly
        ? ["Diff changes-only view"]
        : []),
      ...(settings.chatChangedFilesDefaultExpanded !==
      DEFAULT_UNIFIED_SETTINGS.chatChangedFilesDefaultExpanded
        ? ["Changed files in chat"]
        : []),
      ...(settings.autoArchiveInactiveThreadsDays !==
      DEFAULT_UNIFIED_SETTINGS.autoArchiveInactiveThreadsDays
        ? ["Auto-archive inactive threads"]
        : []),
      ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
        ? ["Stream replies"]
        : []),
      ...(settings.preventSleepDuringActiveTurns !==
      DEFAULT_UNIFIED_SETTINGS.preventSleepDuringActiveTurns
        ? ["Keep awake during turns"]
        : []),
      ...(settings.usageAnalyticsEnabled !== DEFAULT_UNIFIED_SETTINGS.usageAnalyticsEnabled
        ? ["Usage analytics"]
        : []),
      ...(Duration.toMillis(settings.automaticGitFetchInterval) !==
      Duration.toMillis(DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval)
        ? ["Automatic Git fetch interval"]
        : []),
      ...(settings.sourceControlPanelDefaultOpen !==
      DEFAULT_UNIFIED_SETTINGS.sourceControlPanelDefaultOpen
        ? ["Source control panel default"]
        : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["Start in"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["Add project base directory"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Confirm archive"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Confirm delete"]
        : []),
      ...(settings.wrapUpThreadsOnPullRequestSettled !==
      DEFAULT_UNIFIED_SETTINGS.wrapUpThreadsOnPullRequestSettled
        ? ["Wrap up merged threads"]
        : []),
      ...(settings.newThreadModelSelection !== null ? ["New thread agent"] : []),
      ...(settings.newThreadRoomAgents.length > 0 ? ["New thread room"] : []),
      ...(settings.agentBrowserSitePolicy !== DEFAULT_UNIFIED_SETTINGS.agentBrowserSitePolicy
        ? ["Sites agents can visit"]
        : []),
      ...(!roomsEnabledFor(settings) ? ["Rooms"] : []),
      ...(agentInvitesChoice(settings) !== "ask" ? ["Agents bringing in other agents"] : []),
      ...(agentThreadsMode(settings) !== "ask" ? ["Agents can start threads"] : []),
      ...(settings.wrapUpChildThreadsOnFinish !==
      DEFAULT_UNIFIED_SETTINGS.wrapUpChildThreadsOnFinish
        ? ["Wrap up finished child threads"]
        : []),
      ...(isGitWritingModelDirty ? ["Writing model"] : []),
      ...(isGitWritingBackupModelDirty ? ["Backup writing model"] : []),
      ...(isSourceControlWritingStyleDirty ? ["Source control writing style"] : []),
      ...(isSourceControlWriterModelDirty ? ["Source control writer model"] : []),
    ],
    [
      isGitWritingBackupModelDirty,
      isGitWritingModelDirty,
      isSourceControlWriterModelDirty,
      isSourceControlWritingStyleDirty,
      settings.autoArchiveInactiveThreadsDays,
      settings.chatChangedFilesDefaultExpanded,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.wrapUpThreadsOnPullRequestSettled,
      settings.newThreadModelSelection,
      settings.newThreadRoomAgents,
      settings.enableRooms,
      settings.agentInvites,
      settings.agentThreads,
      settings.wrapUpChildThreadsOnFinish,
      settings.addProjectBaseDirectory,
      settings.agentBrowserSitePolicy,
      settings.defaultThreadEnvMode,
      settings.diffChangesOnly,
      settings.diffIgnoreWhitespace,
      settings.diffWordWrap,
      settings.automaticGitFetchInterval,
      settings.enableAssistantStreaming,
      settings.preventSleepDuringActiveTurns,
      settings.sourceControlPanelDefaultOpen,
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
      preventSleepDuringActiveTurns: DEFAULT_UNIFIED_SETTINGS.preventSleepDuringActiveTurns,
      usageAnalyticsEnabled: DEFAULT_UNIFIED_SETTINGS.usageAnalyticsEnabled,
      automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
      sourceControlPanelDefaultOpen: DEFAULT_UNIFIED_SETTINGS.sourceControlPanelDefaultOpen,
      defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
      wrapUpThreadsOnPullRequestSettled: DEFAULT_UNIFIED_SETTINGS.wrapUpThreadsOnPullRequestSettled,
      newThreadModelSelection: DEFAULT_UNIFIED_SETTINGS.newThreadModelSelection,
      newThreadRoomAgents: DEFAULT_UNIFIED_SETTINGS.newThreadRoomAgents,
      agentBrowserSitePolicy: DEFAULT_UNIFIED_SETTINGS.agentBrowserSitePolicy,
      enableRooms: true,
      agentInvites: "ask",
      agentThreads: "ask",
      wrapUpChildThreadsOnFinish: DEFAULT_UNIFIED_SETTINGS.wrapUpChildThreadsOnFinish,
      textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
      textGenerationBackupModelSelection:
        DEFAULT_UNIFIED_SETTINGS.textGenerationBackupModelSelection,
      sourceControlWritingStyle: DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle,
      sourceControlWriterModelSelection: DEFAULT_UNIFIED_SETTINGS.sourceControlWriterModelSelection,
    });
    onRestored?.();
  }, [changedSettingLabels, onRestored, setTheme, updateSettings]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

// Server-authoritative rows shared between the desktop General page and the
// phone surface's "This Computer" section. Each row reads and writes the
// unified settings store itself so both surfaces stay in sync by construction.
function AssistantStreamingRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      title="Stream replies"
      description="Show the agent's reply while it's being written."
      resetAction={
        settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
          <SettingResetButton
            label="stream replies"
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
  );
}

function PreventSleepRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      title="Keep awake during turns"
      description="Stops the computer sleeping while an agent works. The screen still locks. macOS and Windows."
      resetAction={
        settings.preventSleepDuringActiveTurns !==
        DEFAULT_UNIFIED_SETTINGS.preventSleepDuringActiveTurns ? (
          <SettingResetButton
            label="keep awake during turns"
            onClick={() =>
              updateSettings({
                preventSleepDuringActiveTurns:
                  DEFAULT_UNIFIED_SETTINGS.preventSleepDuringActiveTurns,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.preventSleepDuringActiveTurns}
          onCheckedChange={(checked) =>
            updateSettings({ preventSleepDuringActiveTurns: Boolean(checked) })
          }
          aria-label="Prevent sleep during turns"
        />
      }
    />
  );
}

/**
 * Where agents may take the built-in browser without asking. Kept on this
 * computer with the browser it governs; each project can choose otherwise from
 * the browser's own menu.
 */
function AgentBrowserSitesRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      title="Sites agents can visit"
      description="Local addresses always open. Other sites can ask you first or open freely. Each project can change this in the browser menu."
      resetAction={
        settings.agentBrowserSitePolicy !== DEFAULT_UNIFIED_SETTINGS.agentBrowserSitePolicy ? (
          <SettingResetButton
            label="sites agents can visit"
            onClick={() =>
              updateSettings({
                agentBrowserSitePolicy: DEFAULT_UNIFIED_SETTINGS.agentBrowserSitePolicy,
              })
            }
          />
        ) : null
      }
      control={
        <Select
          value={settings.agentBrowserSitePolicy}
          onValueChange={(value) => {
            if (value === "ask" || value === "any") {
              updateSettings({ agentBrowserSitePolicy: value });
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-44" aria-label="Sites agents can visit">
            <SelectValue>
              {settings.agentBrowserSitePolicy === "any" ? "Any site" : "Ask first"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="ask">Ask first</SelectItem>
            <SelectItem value="any">Any site</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}

function UsageAnalyticsRow() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      title="Usage analytics"
      description="Anonymous usage counts that show us installs and reliability. Never prompts, code, file paths, repository names, terminal output, or secrets."
      resetAction={
        settings.usageAnalyticsEnabled !== DEFAULT_UNIFIED_SETTINGS.usageAnalyticsEnabled ? (
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
          onCheckedChange={(checked) => updateSettings({ usageAnalyticsEnabled: Boolean(checked) })}
          aria-label="Share anonymous usage analytics"
        />
      }
    />
  );
}

/**
 * Clears the built-in browser's data for every project at once, plus the
 * profile all projects shared before each had its own. Desktop only, like the
 * browser itself. The desktop reloads open tabs, so none stays signed in.
 */
function ClearBrowserDataRow() {
  const [isClearing, setIsClearing] = useState(false);

  const clearBrowserData = useCallback(async () => {
    const clearAll = window.desktopBridge?.previewClearAllBrowsingData;
    if (clearAll === undefined || isClearing) {
      return;
    }
    const confirmed = await ensureLocalApi().dialogs.confirm(
      [
        "Clear all browser data?",
        "You'll be signed out of every site in the built-in browser, in every project.",
      ].join("\n"),
    );
    if (!confirmed) {
      return;
    }
    setIsClearing(true);
    try {
      await clearAll();
      toastManager.add({ type: "success", title: "Browser data cleared" });
    } catch {
      toastManager.add({
        type: "error",
        title: "Couldn't clear all browser data",
        description: "Some projects may still be signed in. Try again.",
      });
    } finally {
      setIsClearing(false);
    }
  }, [isClearing]);

  return (
    <SettingsRow
      title="Clear all browser data"
      description="Signs you out of every site in the built-in browser, in every project."
      control={
        <Button
          type="button"
          variant="destructive-outline"
          size="sm"
          className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
          disabled={isClearing}
          onClick={() => void clearBrowserData()}
        >
          {isClearing ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <Trash2Icon className="size-3.5" />
          )}
          <span>{isClearing ? "Clearing" : "Clear data"}</span>
        </Button>
      }
    />
  );
}

/**
 * Settings › General: how the app looks, chat and diff display, dictation,
 * this computer, privacy and version. How threads start and end lives on the
 * Threads page. On a phone, settings stored with the paired computer sit under
 * "This Computer"; the rest are stored in the phone's browser.
 */
export function GeneralSettingsPanel({ surface = "full" }: { surface?: "full" | "phone" }) {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const isPhoneSurface = surface === "phone";
  const observability = useServerObservability();
  const diagnosticsDescription = formatDiagnosticsDescription({
    localTracingEnabled: observability?.localTracingEnabled ?? false,
    otlpTracesEnabled: observability?.otlpTracesEnabled ?? false,
    otlpTracesUrl: observability?.otlpTracesUrl,
    otlpMetricsEnabled: observability?.otlpMetricsEnabled ?? false,
    otlpMetricsUrl: observability?.otlpMetricsUrl,
  });

  return (
    <SettingsPageContainer>
      <SettingsPageHeader section="/settings/general" />
      <SettingsSection title="Appearance">
        <SettingsRow
          title="Theme"
          description="How Threadlines looks."
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
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Time format"
          description="System default follows your computer's clock setting."
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
                <SelectItem value="locale">{TIMESTAMP_FORMAT_LABELS.locale}</SelectItem>
                <SelectItem value="12-hour">{TIMESTAMP_FORMAT_LABELS["12-hour"]}</SelectItem>
                <SelectItem value="24-hour">{TIMESTAMP_FORMAT_LABELS["24-hour"]}</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Chat & diffs">
        {/* On a phone this one is the paired computer's: it sits under This Computer. */}
        {!isPhoneSurface ? <AssistantStreamingRow /> : null}

        <SettingsRow
          title="Changed files in chat"
          description="Open the list of changed files under each reply."
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

        <SettingsRow
          title="Wrap diff lines"
          description="Wrap long lines when the diff panel opens."
          resetAction={
            settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
              <SettingResetButton
                label="wrap diff lines"
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
          description="Leave out edits that only change spacing."
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
      </SettingsSection>

      <DictationSettings />

      <SettingsSection title="This computer">
        {isPhoneSurface ? <AssistantStreamingRow /> : null}

        <PreventSleepRow />

        {!isPhoneSurface ? (
          <SettingsRow
            title="Add project starts in"
            description="Where the folder picker opens. Empty means your home folder (~/)."
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
        ) : null}

        {isPhoneSurface ? <UsageAnalyticsRow /> : null}
        {isElectron ? <AgentBrowserSitesRow /> : null}
        {isElectron && !isPhoneSurface ? <ClearBrowserDataRow /> : null}
      </SettingsSection>

      <SettingsSection title={isPhoneSurface ? "About" : "Privacy & about"}>
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
            <UsageAnalyticsRow />
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
            description={
              'Appearance, chat and thread-closing preferences are stored in this browser. Settings under "This Computer", and the Threads page\'s new-thread, Rooms and writing settings, apply to your paired computer.'
            }
          />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/**
 * The bridge from provider setup to what those providers have actually cost:
 * one flat, clickable line above the agent rows, named for its window so the
 * figures cannot be mistaken for all-time totals.
 */
function ProviderUsageLinkRow() {
  const targets = useUsageEnvironmentTargets();
  // The same scan the usage page reads, narrowed here rather than re-fetched.
  const usageQuery = useQuery(usageSummaryQueryOptions({ targets }));
  const scan = usageQuery.data ?? null;
  const merged = useMemo(
    () => (scan ? deriveUsageWindow(scan, USAGE_SETTINGS_WINDOW_DAYS).merged : null),
    [scan],
  );

  return (
    <Link
      className="group/usage-tile flex items-center gap-3 rounded-[inherit] px-3.5 py-2.5 transition-colors hover:bg-foreground/[0.03] focus-ring"
      data-testid="settings-usage-link"
      to="/usage"
    >
      <span className="shrink-0 text-[13.5px] font-medium text-foreground select-none">
        Last {USAGE_SETTINGS_WINDOW_DAYS} days
      </span>
      {/* One typeface AND one color: mixing brightness on a line of small
          mono type erodes the dim glyphs' anti-aliased bottom edge. */}
      {merged ? (
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground tabular-nums">
          {formatTokens(merged.totalTokens)} tokens · {formatUsd(merged.costUsd)} API-equivalent
        </span>
      ) : (
        <span className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">
          Reading provider transcripts…
        </span>
      )}
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors group-hover/usage-tile:text-foreground">
        View usage
        <ChevronRightIcon className="size-3.5" />
      </span>
    </Link>
  );
}

/** "In use" / "Not in use": a section title above its run of agent rows. */
function ProviderGroupHeading({
  label,
  count,
  first = false,
}: {
  label: string;
  count: number;
  first?: boolean;
}) {
  return (
    <div className={cn("flex items-baseline gap-2 px-1 pb-2", first ? "pt-0" : "pt-7")}>
      <h2 className="text-[15px] leading-5 font-semibold text-foreground">{label}</h2>
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{count}</span>
    </div>
  );
}

export function ProviderSettingsPanel({
  focusedInstanceId = null,
}: {
  /**
   * The row to open on arrival, from the route's `?instance=`. It is how a
   * sign-in started elsewhere in the app hands off to this page, which owns
   * the interactive terminal those surfaces have no room for.
   */
  readonly focusedInstanceId?: string | null;
} = {}) {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverProviders = useServerProviders();
  const primaryEnvironment = usePrimaryEnvironmentDescriptor();
  const computerLabel = thisComputerLabel(primaryEnvironment?.platform.os);
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [openInstanceDetails, setOpenInstanceDetails] = useState<Record<string, boolean>>({});
  // Extra accounts: rows that start sign-in as soon as they can (just added),
  // requests from the header's "+" to show an agent's add-account form, and
  // the account waiting for its removal to be confirmed.
  const [autoSignInIds, setAutoSignInIds] = useState<ReadonlySet<string>>(() => new Set());
  const [addAccountRequests, setAddAccountRequests] = useState<Record<string, number>>({});
  const [accountToRemove, setAccountToRemove] = useState<ProviderSettingsRow | null>(null);
  const [isRemovingAccount, setIsRemovingAccount] = useState(false);
  const settleAutoSignIn = useCallback((instanceId: ProviderInstanceId) => {
    setAutoSignInIds((existing) => {
      if (!existing.has(instanceId)) return existing;
      const next = new Set(existing);
      next.delete(instanceId);
      return next;
    });
  }, []);
  useEffect(() => {
    if (focusedInstanceId === null) {
      return;
    }
    setOpenInstanceDetails((existing) =>
      existing[focusedInstanceId] === true ? existing : { ...existing, [focusedInstanceId]: true },
    );
  }, [focusedInstanceId]);
  const {
    pendingRateLimitResetCredit,
    isConsumingRateLimitResetCredit,
    requestRateLimitResetCredit,
    rateLimitResetCreditDialog,
  } = useProviderRateLimitResetCredit();
  const refreshingRef = useRef(false);
  const updateRunner = useProviderUpdateRunner(serverProviders);

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
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

  const rows = useMemo(() => deriveMaintainedProviderRows(settings), [settings]);
  const inUseRows = rows.filter(isProviderRowEnabled);
  const notInUseRows = rows.filter((row) => !isProviderRowEnabled(row));

  const providerInstancePatch = (row: ProviderSettingsRow, next: ProviderInstanceConfig) =>
    buildProviderInstanceUpdatePatch({
      settings,
      instanceId: row.instanceId,
      instance: next,
      driver: row.driver,
      isDefault: row.isDefault,
    });
  const updateProviderInstance = (row: ProviderSettingsRow, next: ProviderInstanceConfig) => {
    updateSettings(providerInstancePatch(row, next));
  };

  const setProviderInstanceEnabled = (row: ProviderSettingsRow, enabled: boolean) =>
    updateSettingsAndPersist(
      buildProviderEnablementPatch({ settings, changes: [{ row, enabled }] }),
    );

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

  /** Restores a default slot's settings, leaving it on or off as it is. */
  const resetDefaultInstance = (driverKind: ProviderDriverKind, enabled: boolean) => {
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
        [driverKind]: { ...defaultLegacyProvider, enabled },
      } as typeof settings.providers,
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, defaultInstanceId),
      providerModelPreferences: withoutProviderInstanceKey(
        settings.providerModelPreferences,
        defaultInstanceId,
      ),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], defaultInstanceId),
    });
  };

  const openProviderRow = (instanceId: ProviderInstanceId) => {
    setOpenInstanceDetails((existing) =>
      existing[instanceId] === true ? existing : { ...existing, [instanceId]: true },
    );
    window.requestAnimationFrame(() => {
      document
        .querySelector(`[data-provider-instance-id="${CSS.escape(String(instanceId))}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  };

  const requestAddAccount = (driver: ProviderDriverKind) => {
    const instanceId = defaultInstanceIdForDriver(driver);
    setAddAccountRequests((existing) => ({
      ...existing,
      [instanceId]: (existing[instanceId] ?? 0) + 1,
    }));
    openProviderRow(instanceId);
  };

  const addAccountControlsFor = (
    row: ProviderSettingsRow,
  ): ProviderAddAccountControls | undefined => {
    if (!supportsProviderAccounts(String(row.driver))) return undefined;
    const accounts = rows.filter(
      (candidate) => candidate.driver === row.driver && !candidate.isDefault,
    );
    return {
      agentName: getDriverOption(row.driver)?.label ?? String(row.driver),
      existingNames: accounts.map((account) => account.instance.displayName ?? ""),
      existingColors: accounts.map((account) => account.instance.accentColor),
      openRequest: addAccountRequests[row.instanceId] ?? 0,
      onAdded: (instanceId, startSignIn) => {
        if (startSignIn) {
          setAutoSignInIds((existing) => new Set(existing).add(instanceId));
        }
        openProviderRow(instanceId);
      },
    };
  };

  const confirmRemoveAccount = async () => {
    const row = accountToRemove;
    if (!row || isRemovingAccount) return;
    setIsRemovingAccount(true);
    try {
      await ensureLocalApi().server.removeProviderAccount({ instanceId: row.instanceId });
      // Favorites and model order live on this device; the server removed the rest.
      updateSettings({
        providerModelPreferences: withoutProviderInstanceKey(
          settings.providerModelPreferences,
          row.instanceId,
        ),
        favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], row.instanceId),
      });
      setAccountToRemove(null);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not remove the account",
        description: error instanceof Error ? error.message : "Try again in a moment.",
      });
    } finally {
      setIsRemovingAccount(false);
    }
  };

  const renderRow = (row: ProviderSettingsRow) => {
    const driverOption = getDriverOption(row.driver);
    const liveProvider = serverProviders.find(
      (candidate) => candidate.instanceId === row.instanceId,
    );
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
    const providerResetCredits = liveProvider?.accountUsage?.rateLimitResetCredits;
    const resetLabel = driverOption?.label ?? String(row.driver);
    return (
      <ProviderInstanceCard
        key={row.instanceId}
        instanceId={row.instanceId}
        instance={row.instance}
        driverOption={driverOption}
        liveProvider={liveProvider}
        isExpanded={openInstanceDetails[row.instanceId] ?? false}
        signInHandoffActive={row.instanceId === focusedInstanceId}
        onExpandedChange={(open) =>
          setOpenInstanceDetails((existing) => ({
            ...existing,
            [row.instanceId]: open,
          }))
        }
        onUpdate={(next) => updateProviderInstance(row, next)}
        onSaveInstance={(next) => updateSettingsAndPersist(providerInstancePatch(row, next))}
        onEnabledChange={(enabled) => setProviderInstanceEnabled(row, enabled)}
        onDelete={row.isDefault ? undefined : () => deleteProviderInstance(row.instanceId)}
        onRemoveAccount={
          !row.isDefault && supportsProviderAccounts(String(row.driver))
            ? () => setAccountToRemove(row)
            : undefined
        }
        addAccount={addAccountControlsFor(row)}
        autoSignIn={autoSignInIds.has(row.instanceId)}
        onAutoSignInSettled={settleAutoSignIn}
        onResetDefaults={
          row.isDefault && row.isDirty
            ? () => resetDefaultInstance(row.driver, isProviderRowEnabled(row))
            : undefined
        }
        computerLabel={computerLabel}
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
        updateControls={updateRunner.controlsFor(liveProvider)}
        onResetAccountUsage={
          canResetProviderUsage && providerResetCredits
            ? () =>
                requestRateLimitResetCredit({
                  instanceId: row.instanceId,
                  providerLabel: liveProvider?.displayName?.trim() || resetLabel,
                  resetCredits: providerResetCredits,
                })
            : undefined
        }
        accountUsageResetInFlight={
          pendingRateLimitResetCredit?.instanceId === row.instanceId
            ? isConsumingRateLimitResetCredit
            : undefined
        }
      />
    );
  };

  return (
    <SettingsPageContainer>
      <SettingsPageHeader
        section="/settings/providers"
        description={`Agents run on ${primaryEnvironment?.label ?? computerLabel}. Favorites and model order are saved on this device.`}
        actions={
          <div className="flex items-center gap-1">
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              disabled={isRefreshingProviders}
              onClick={() => void refreshProviders()}
              aria-label="Refresh provider status"
            >
              {isRefreshingProviders ? (
                <LoaderIcon className="size-3 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3" />
              )}
              Check again
            </Button>
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              render={<Link to="/setup" />}
            >
              Open setup
            </Button>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-6 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    aria-label="Add an account or provider instance"
                  />
                }
              >
                <PlusIcon className="size-3" />
              </MenuTrigger>
              <MenuPopup align="end" className="min-w-52">
                {PROVIDER_ACCOUNT_DRIVER_KINDS.map((driver) => (
                  <MenuItem
                    key={driver}
                    onClick={() => requestAddAccount(ProviderDriverKind.make(driver))}
                  >
                    {addAccountMenuLabel(
                      getDriverOption(ProviderDriverKind.make(driver))?.label ?? driver,
                    )}
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem onClick={() => setIsAddInstanceDialogOpen(true)}>
                  Custom instance…
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        }
      />
      <SettingsGroup>
        <ProviderUsageLinkRow />
      </SettingsGroup>
      <div className="flex flex-col">
        {/* One keyed list, headings included: a row that moves between the
            groups is reordered, not remounted, so it keeps its open state and
            a one-click install that is waiting for the server. Rows draw the
            group behind each run (AgentRow, data-group-row). */}
        {[
          <ProviderGroupHeading
            key="heading:in-use"
            label="In use"
            count={inUseRows.length}
            first
          />,
          ...(inUseRows.length > 0
            ? inUseRows.map(renderRow)
            : [
                <p
                  key="empty:in-use"
                  data-group-row=""
                  className="px-3.5 py-3 text-[12.5px] text-muted-foreground"
                >
                  No agents are turned on. Turn one on below, or{" "}
                  <Link className="text-foreground hover:text-primary-readable" to="/setup">
                    open setup
                  </Link>
                  .
                </p>,
              ]),
          ...(notInUseRows.length > 0
            ? [
                <ProviderGroupHeading
                  key="heading:not-in-use"
                  label="Not in use"
                  count={notInUseRows.length}
                />,
                ...notInUseRows.map(renderRow),
              ]
            : []),
        ]}
      </div>

      <AddProviderInstanceDialog
        open={isAddInstanceDialogOpen}
        onOpenChange={setIsAddInstanceDialogOpen}
      />
      <AlertDialog
        open={accountToRemove !== null}
        onOpenChange={(open) => {
          if (!open && !isRemovingAccount) setAccountToRemove(null);
        }}
      >
        <AlertDialogPopup>
          {accountToRemove ? (
            <RemoveAccountDialogBody
              row={accountToRemove}
              agentName={
                getDriverOption(accountToRemove.driver)?.label ?? String(accountToRemove.driver)
              }
              removing={isRemovingAccount}
              onConfirm={() => void confirmRemoveAccount()}
            />
          ) : null}
        </AlertDialogPopup>
      </AlertDialog>
      {rateLimitResetCreditDialog}
    </SettingsPageContainer>
  );
}

/** What removing an extra account does, said before it happens. */
function RemoveAccountDialogBody(props: {
  readonly row: ProviderSettingsRow;
  readonly agentName: string;
  readonly removing: boolean;
  readonly onConfirm: () => void;
}) {
  const name = formatProviderInstanceName({
    agentName: props.agentName,
    displayName: props.row.instance.displayName,
    isDefault: false,
  });
  const ownedFolder = isThreadlinesAccountFolder({
    instanceId: String(props.row.instanceId),
    driver: String(props.row.driver),
    config: props.row.instance.config,
  });
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
        <AlertDialogDescription>
          {ownedFolder
            ? `Threadlines signs this account out and deletes its private folder. Its chats stay, and can continue on another ${props.agentName} account.`
            : "Threadlines stops using this account. Your folder and the sign-in in it are left as they are."}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="outline" />} disabled={props.removing}>
          Cancel
        </AlertDialogClose>
        <Button variant="destructive" disabled={props.removing} onClick={props.onConfirm}>
          {props.removing ? "Removing…" : "Remove account"}
        </Button>
      </AlertDialogFooter>
    </>
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
      <div className="mt-3 border-t border-group-divider py-2.5 text-xs text-muted-foreground">
        No threads are currently inactive for {days}+ days.
      </div>
    );
  }

  const visibleGroups = groups.slice(0, 5);
  const remainingGroupCount = groups.length - visibleGroups.length;

  return (
    <div className="mt-3 border-t border-group-divider py-2.5">
      <div className="grid gap-1.5 text-xs">
        {visibleGroups.map((group) => (
          <div
            key={`${group.threads[0]?.environmentId ?? "unknown"}:${group.threads[0]?.projectId ?? "unknown"}`}
            className="flex min-w-0 items-center justify-between gap-3"
          >
            <span className="min-w-0 truncate text-muted-foreground">
              {group.project?.name ?? "Unknown project"}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {formatThreadCount(group.count)}
            </span>
          </div>
        ))}
        {remainingGroupCount > 0 ? (
          <div className="text-xs text-muted-foreground">
            {remainingGroupCount} more projects have eligible inactive threads.
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ArchivedThreadsPanel({ hostedStatic }: { readonly hostedStatic: boolean }) {
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
  // Until the first workspace snapshot lands there are no projects to ask for archives,
  // which would otherwise read as "No archived threads". Same rule as the chat index.
  const bootstrapComplete = useStore(selectBootstrapCompleteForActiveEnvironment);
  const isWorkspaceLoading = !hostedStatic && !bootstrapComplete;
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

  const archivedThreads = useMemo((): ReadonlyArray<ArchivedThreadItem> => {
    const projectsByKey = new Map<string, ArchivedThreadProject>();
    for (const { environmentId, snapshot } of archivedSnapshots) {
      for (const project of snapshot.projects) {
        const key = `${environmentId}:${project.id}`;
        projectsByKey.set(key, {
          key,
          id: project.id,
          environmentId,
          name: project.title,
          cwd: project.workspaceRoot,
        });
      }
    }

    return archivedSnapshots
      .flatMap(({ environmentId, snapshot }) =>
        snapshot.threads.flatMap((thread) => {
          const project = projectsByKey.get(`${environmentId}:${thread.projectId}`);
          return project ? [{ ...thread, environmentId, project }] : [];
        }),
      )
      .toSorted(compareArchivedThreadsNewestFirst);
  }, [archivedSnapshots]);

  const archivedDeleteSelection = useMemo(() => {
    const nowMs = Date.now();
    const threads = archivedThreads.filter((thread) =>
      isArchivedThreadOlderThan({
        archivedAt: thread.archivedAt,
        olderThanDays: archivedThreadDeleteAgeDays,
        nowMs,
      }),
    );
    const groupsByProjectKey = new Map<string, { projectName: string; count: number }>();
    for (const thread of threads) {
      const group = groupsByProjectKey.get(thread.project.key);
      groupsByProjectKey.set(thread.project.key, {
        projectName: thread.project.name,
        count: (group?.count ?? 0) + 1,
      });
    }

    return { groups: [...groupsByProjectKey.values()], threads };
  }, [archivedThreads, archivedThreadDeleteAgeDays]);

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
    async (thread: ArchivedThreadItem) => {
      try {
        await confirmAndDeleteThread(scopeThreadRef(thread.environmentId, thread.id), {
          title: thread.title,
        });
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

  const unarchiveArchivedThread = useCallback(
    async (thread: ArchivedThreadItem) => {
      try {
        await unarchiveThread(scopeThreadRef(thread.environmentId, thread.id));
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
    },
    [refreshArchivedThreads, unarchiveThread],
  );

  const handleArchivedThreadContextMenu = useCallback(
    async (thread: ArchivedThreadItem, position: { x: number; y: number }) => {
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
        await unarchiveArchivedThread(thread);
      } else if (clicked === "delete") {
        await deleteArchivedThread(thread);
      }
    },
    [deleteArchivedThread, unarchiveArchivedThread],
  );

  return (
    <SettingsPageContainer>
      <SettingsPageHeader section="/settings/archived" />
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
                  <SelectItem key={days} value={String(days)}>
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
                    <SelectItem key={days} value={String(days)}>
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
      <ArchivedThreadsSection
        threads={archivedThreads}
        isLoading={isLoadingArchive || isWorkspaceLoading}
        error={archiveError}
        onUnarchive={(thread) => void unarchiveArchivedThread(thread)}
        onDelete={(thread) => void deleteArchivedThread(thread)}
        onContextMenu={(thread, position) => void handleArchivedThreadContextMenu(thread, position)}
      />
    </SettingsPageContainer>
  );
}
