import type { ComponentType } from "react";

import { AlertKindRow, AlertsOnThisDeviceRow } from "../../pushAlerts/PushAlertsSettings";
import { KeepAwakeForScheduledTasksRow, RunInBackgroundRow } from "./DesktopBackgroundRows";
import { DownloadedModelsRow, HoldToRecordRow, SpeechModelRow } from "./DictationSettings";
import type { SettingsRowPlaceId } from "./settingsPlaceAvailability";
import {
  AddProjectStartsInRow,
  AgentBrowserSitesRow,
  AgentsPanelRow,
  AssistantStreamingRow,
  ChangedFilesInChatRow,
  ClearBrowserDataRow,
  DiagnosticsRow,
  HideWhitespaceRow,
  OpenLinksRow,
  PhoneSettingsRow,
  PreventSleepRow,
  TerminalScreenReaderRow,
  TerminalTextSizeRow,
  ThemeRow,
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
  AgentInvitesRow,
  AgentPagesRow,
  AgentThreadsRow,
  BackupWritingModelRow,
  ClaudeArtifactsRow,
  ClaudeSuggestionsRow,
  ClaudeWorkflowSizeRow,
  CommandRequestsRow,
  ConfirmArchiveRow,
  ConfirmDeleteRow,
  DefaultThreadEnvModeRow,
  NewThreadAgentRow,
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
  "general.alertsOnThisDevice": live(AlertsOnThisDeviceRow),
  "general.alertNeedsYou": live(() => <AlertKindRow kind="needs_you" />),
  "general.alertFinished": live(() => <AlertKindRow kind="finished" />),
  "general.alertFailed": live(() => <AlertKindRow kind="failed" />),
  "general.theme": live(ThemeRow),
  "general.timeFormat": live(TimeFormatRow),
  "general.streamReplies": live(AssistantStreamingRow),
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
  "general.sitesAgentsCanVisit": live(AgentBrowserSitesRow),
  "general.clearBrowserData": live(ClearBrowserDataRow),
  "general.version": live(VersionRow),
  "general.updateTrack": live(UpdateTrackRow),
  "general.usageAnalytics": live(UsageAnalyticsRow),
  "general.diagnostics": live(DiagnosticsRow),
  "general.phoneSettings": live(PhoneSettingsRow),
  // Threads
  "threads.agent": live(NewThreadAgentRow),
  "threads.room": live(NewThreadRoomRow),
  "threads.startIn": live(DefaultThreadEnvModeRow),
  "threads.worktreesFrom": live(NewWorktreeBaseRow),
  "threads.agentThreads": live(AgentThreadsRow),
  "threads.agentPages": live(AgentPagesRow),
  "threads.claudeArtifacts": live(ClaudeArtifactsRow),
  "threads.claudeWorkflowSize": live(ClaudeWorkflowSizeRow),
  "threads.claudeSuggestions": live(ClaudeSuggestionsRow),
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
  "connections.sameNetwork": LINK,
  "connections.tailscale": LINK,
  "connections.oneTimeLink": LINK,
} as const satisfies { readonly [Id in SettingsRowPlaceId]: SettingsRowEntry };
