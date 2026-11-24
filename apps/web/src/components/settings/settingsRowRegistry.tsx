import type { ComponentType } from "react";

import {
  AlertKindRow,
  AlertSoundRow,
  AlertsOnThisDeviceRow,
  AlertsQuietAtComputerRow,
} from "../../pushAlerts/PushAlertsSettings";
import {
  ThemeGlassRow,
  ThemeMotionRow,
  ThemeSameEverywhereRow,
} from "../theme/ui/ThemeSettingsRows";
import { ThemeSystemPairRow } from "../theme/ui/ThemeSystemPairRow";
import { KeepAwakeForScheduledTasksRow, RunInBackgroundRow } from "./DesktopBackgroundRows";
import { AgentDeviceAccessRow, UseDevicesRow } from "./DevicesSettings";
import { DownloadedModelsRow, HoldToRecordRow, SpeechModelRow } from "./DictationSettings";
import type { SettingsRowPlaceId } from "./settingsPlaceAvailability";
import { ProjectNotesModeRow } from "./ProjectNotesSection";
import {
  AddProjectStartsInRow,
  AgentBrowserSitesRow,
  BrowserSignInsRow,
  AgentsPanelRow,
  AssistantStreamingRow,
  BrowserPageSizeRow,
  BrowserSearchEngineRow,
  ChangedFilesInChatRow,
  ClearBrowserDataRow,
  DiagnosticsRow,
  FollowUpDeliveryRow,
  ReportProblemRow,
  HideWhitespaceRow,
  OpenLinksRow,
  PhoneSettingsRow,
  PreventSleepRow,
  TerminalScreenReaderRow,
  TerminalTextSizeRow,
  TimeFormatRow,
  UpdateTrackRow,
  UsageAnalyticsRow,
  VersionRow,
  WrapDiffLinesRow,
} from "./SettingsPanels";
import {
  FetchIntervalRow,
  FollowPrTemplatesRow,
  OpenPanelByDefaultRow,
  WriterModelRow,
  WritingStyleRow,
} from "./SourceControlSettings";
import {
  AntigravitySuggestionsRow,
  ClaudeSuggestionsRow,
  CodexSuggestionsRow,
} from "./ProviderSuggestionsSection";
import {
  AgentInvitesRow,
  AgentPagesRow,
  AgentThreadsRow,
  AgentThreadsShareWorktreesRow,
  BackupWritingModelRow,
  ClaudeArtifactsRow,
  ClaudeWorkflowSizeRow,
  CommandRequestsRow,
  ConfirmArchiveRow,
  ConfirmDeleteRow,
  ContinueAfterUsageLimitsRow,
  ContinueAfterRestartRow,
  DefaultThreadEnvModeRow,
  GeneralChatsPlacementRow,
  NewThreadAccessRow,
  NewThreadAgentRow,
  NewThreadModeRow,
  NewThreadRoomRow,
  NewWorktreeBaseRow,
  RoomsRow,
  StartAgentsWhileTypingRow,
  WrapUpChildThreadsRow,
  WrapUpIdleThreadsRow,
  WrapUpMergedThreadsRow,
  WritingModelRow,
} from "./ThreadsSettings";

/**
 * How the settings search draws each settings row (docs/design/settings-search.md).
 *
 * - `live`: the row's own component, the one its page draws, so a result is
 *   the real switch, menu or field and works where it stands.
 * - `link`: the row's state belongs to its page (a list it shares, a scope
 *   the page picks, dialogs the page owns), so a result names it and opens
 *   the page at it instead.
 *
 * Typed over every settings row in the catalog: a new row doesn't compile
 * until it says which it is.
 */
export type SettingsRowEntry =
  | { readonly kind: "live"; readonly Row: ComponentType }
  | { readonly kind: "link" };

const live = (Row: ComponentType): SettingsRowEntry => ({ kind: "live", Row });
const LINK: SettingsRowEntry = { kind: "link" };

export const SETTINGS_ROWS = {
  // General
  "general.alertSound": live(AlertSoundRow),
  "general.alertsOnThisDevice": live(AlertsOnThisDeviceRow),
  "general.alertNeedsYou": live(() => <AlertKindRow kind="needs_you" />),
  "general.alertFinished": live(() => <AlertKindRow kind="finished" />),
  "general.alertFailed": live(() => <AlertKindRow kind="failed" />),
  "general.alertsQuietAtComputer": live(AlertsQuietAtComputerRow),
  "general.streamReplies": live(AssistantStreamingRow),
  "general.followUpDelivery": live(FollowUpDeliveryRow),
  "general.timeFormat": live(TimeFormatRow),
  "general.changedFilesInChat": live(ChangedFilesInChatRow),
  "general.agentsPanel": live(AgentsPanelRow),
  "general.wrapDiffLines": live(WrapDiffLinesRow),
  "general.hideWhitespace": live(HideWhitespaceRow),
  "general.terminalTextSize": live(TerminalTextSizeRow),
  "general.terminalScreenReader": live(TerminalScreenReaderRow),
  "general.speechModel": live(SpeechModelRow),
  "general.holdToRecord": live(HoldToRecordRow),
  "general.downloadedModels": live(DownloadedModelsRow),
  "general.keepAwake": live(PreventSleepRow),
  "general.keepAwakeForScheduledTasks": live(KeepAwakeForScheduledTasksRow),
  "general.runInBackground": live(RunInBackgroundRow),
  "general.addProjectStartsIn": live(AddProjectStartsInRow),
  "general.openLinksIn": live(OpenLinksRow),
  "general.browserPageSize": live(BrowserPageSizeRow),
  "general.browserSearchEngine": live(BrowserSearchEngineRow),
  "general.sitesAgentsCanVisit": live(AgentBrowserSitesRow),
  "general.browserSignIns": live(BrowserSignInsRow),
  "general.clearBrowserData": live(ClearBrowserDataRow),
  "general.version": live(VersionRow),
  "general.updateTrack": live(UpdateTrackRow),
  "general.usageAnalytics": live(UsageAnalyticsRow),
  "general.diagnostics": live(DiagnosticsRow),
  "general.reportProblem": live(ReportProblemRow),
  "general.phoneSettings": live(PhoneSettingsRow),
  // Appearance: the gallery's filter and dialogs are the page's, so a result opens it.
  "appearance.theme": LINK,
  "appearance.sameEverywhere": live(ThemeSameEverywhereRow),
  "appearance.systemThemes": live(ThemeSystemPairRow),
  "appearance.glass": live(ThemeGlassRow),
  "appearance.motion": live(ThemeMotionRow),
  // Threads
  "threads.agent": live(NewThreadAgentRow),
  "threads.room": live(NewThreadRoomRow),
  "threads.mode": live(NewThreadModeRow),
  "threads.access": live(NewThreadAccessRow),
  "threads.startIn": live(DefaultThreadEnvModeRow),
  "threads.worktreesFrom": live(NewWorktreeBaseRow),
  "threads.agentThreads": live(AgentThreadsRow),
  "threads.agentThreadsShareWorktrees": live(AgentThreadsShareWorktreesRow),
  "threads.agentPages": live(AgentPagesRow),
  "threads.claudeArtifacts": live(ClaudeArtifactsRow),
  "threads.claudeWorkflowSize": live(ClaudeWorkflowSizeRow),
  "threads.continueAfterUsageLimits": live(ContinueAfterUsageLimitsRow),
  "threads.continueAfterRestart": live(ContinueAfterRestartRow),
  "threads.commandRequests": live(CommandRequestsRow),
  "threads.startWhileTyping": live(StartAgentsWhileTypingRow),
  "threads.enableRooms": live(RoomsRow),
  "threads.agentInvites": live(AgentInvitesRow),
  "threads.writingModel": live(WritingModelRow),
  "threads.backupWritingModel": live(BackupWritingModelRow),
  "threads.wrapUpIdle": live(WrapUpIdleThreadsRow),
  "threads.wrapUpMerged": live(WrapUpMergedThreadsRow),
  "threads.wrapUpChildren": live(WrapUpChildThreadsRow),
  "threads.confirmArchive": live(ConfirmArchiveRow),
  "threads.confirmDelete": live(ConfirmDeleteRow),
  "threads.generalChats": live(GeneralChatsPlacementRow),
  // Agent Instructions: one setting for every project on this computer.
  "instructions.notesMode": live(() => <ProjectNotesModeRow />),
  // Archives: each row reads the page's archived and inactive thread lists.
  "archived.autoArchive": LINK,
  "archived.archiveNow": LINK,
  "archived.deleteOld": LINK,
  // Plugins & Skills: the page picks the computer and project they apply to.
  "plugins.marketplaceSources": LINK,
  "plugins.mcpContext": LINK,
  // Source Control
  "sourceControl.openPanelByDefault": live(OpenPanelByDefaultRow),
  "sourceControl.fetchInterval": live(FetchIntervalRow),
  "sourceControl.writingStyle": live(WritingStyleRow),
  "sourceControl.followPrTemplates": live(FollowPrTemplatesRow),
  "sourceControl.writerModel": live(WriterModelRow),
  // Connections: the page owns their relay, network and pairing state and dialogs.
  "connections.connectDevice": LINK,
  "connections.agentAddress": LINK,
  "connections.connectAgent": LINK,
  "connections.threadlinesCommand": LINK,
  "connections.assistantAddress": LINK,
  "connections.addAssistant": LINK,
  "connections.sameNetwork": LINK,
  "connections.tailscale": LINK,
  "connections.oneTimeLink": LINK,
  // Devices
  "devices.enable": live(UseDevicesRow),
  "devices.agentAccess": live(AgentDeviceAccessRow),
  // Providers › Suggestions
  "providers.claudeSuggestions": live(ClaudeSuggestionsRow),
  "providers.codexSuggestions": live(CodexSuggestionsRow),
  "providers.antigravitySuggestions": live(AntigravitySuggestionsRow),
} as const satisfies { readonly [Id in SettingsRowPlaceId]: SettingsRowEntry };
