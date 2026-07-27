import type {
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  VcsCommitDetailsInput,
  VcsCommitDetailsResult,
  VcsCommitGraphInput,
  VcsCommitGraphResult,
  VcsDiscardChangesInput,
  VcsDiscardChangesResult,
  VcsStageChangesInput,
  VcsStageChangesResult,
  VcsUnstageChangesInput,
  VcsUnstageChangesResult,
  VcsWorkingTreeDiffInput,
  VcsWorkingTreeDiffResult,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateTagInput,
  VcsCreateTagResult,
  VcsDeleteBranchInput,
  VcsDeleteBranchResult,
  GitApplyAuthRemediationInput,
  GitApplyAuthRemediationResult,
  GitAuthRemediationPlan,
  GitAuthRemediationPlanInput,
  GitGenerateCommitMessageInput,
  GitGenerateCommitMessageResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsMergeRefInput,
  VcsMergeRefResult,
  VcsPullInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsStatusResult,
} from "./git.ts";
import type { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem.ts";
import type {
  ProjectFaviconInput,
  ProjectFaviconResult,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import type { ProviderInstanceId } from "./providerInstance.ts";
import type {
  ProviderRealtimeAppendAudioInput,
  ProviderRealtimeAudioChunk,
  ProviderRealtimeStartInput,
} from "./provider.ts";
import type {
  ProviderExtensionMcpOAuthStartInput,
  ProviderExtensionMcpOAuthStartResult,
  ProviderExtensionMcpReloadInput,
  ProviderExtensionMcpReloadResult,
  ProviderExtensionMcpResourceReadInput,
  ProviderExtensionMcpResourceReadResult,
  ProviderExtensionMcpToolCallInput,
  ProviderExtensionMcpToolCallResult,
  ProviderExtensionOperationStatusInput,
  ProviderExtensionOperationStatusResult,
  ProviderExtensionPluginInstallInput,
  ProviderExtensionPluginInstallResult,
  ProviderExtensionPluginMarketplaceRefreshInput,
  ProviderExtensionPluginMarketplaceRefreshResult,
  ProviderExtensionPluginReadInput,
  ProviderExtensionPluginReadResult,
  ProviderExtensionPluginToggleInput,
  ProviderExtensionPluginToggleResult,
  ProviderExtensionPluginUninstallInput,
  ProviderExtensionPluginUninstallResult,
  ProviderExtensionPluginUpdateInput,
  ProviderExtensionPluginUpdateResult,
  ProviderExtensionSkillToggleInput,
  ProviderExtensionSkillToggleResult,
  ProviderExtensionsInventoryInput,
  ProviderExtensionsInventoryResult,
  ProviderInstructionFilesInput,
  ProviderInstructionFilesResult,
  ProviderInstructionWriteInput,
  ProviderInstructionWriteResult,
} from "./providerExtensions.ts";
import type {
  ServerConfig,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerProviderRateLimitResetCreditConsumeInput,
  ServerProviderRateLimitResetCreditConsumeResult,
  ServerProviderUpdateBlockerResolutionResult,
  ServerProviderUpdateInput,
  ServerProviderUpdatedPayload,
  ServerRemoveKeybindingResult,
  ServerResolveBackgroundRunsInput,
  ServerResolveBackgroundRunsResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerStopBackgroundRunInput,
  ServerTraceDiagnosticsResult,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import type { ServerRemoveKeybindingInput, ServerUpsertKeybindingInput } from "./server.ts";
import * as Schema from "effect/Schema";

import type {
  PreviewAutomationHost,
  PreviewAutomationRequest,
  PreviewAutomationResponse,
} from "./previewAutomation.ts";
import type {
  ChatAttachmentReadInput,
  ChatAttachmentReadResult,
  ClientOrchestrationCommand,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetRevertPlanInput,
  OrchestrationGetRevertPlanResult,
  OrchestrationThreadSearchInput,
  OrchestrationThreadSearchResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadStreamItem,
} from "./orchestration.ts";
import { EnvironmentId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AuthBearerBootstrapResult, AuthSessionState, AuthWebSocketTokenResult } from "./auth.ts";
import { AdvertisedEndpoint } from "./remoteAccess.ts";
import { EditorId } from "./editor.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { PreviewAutomationTargetSchema } from "./previewAutomation.ts";
import type { ClientSettings, ServerSettings, ServerSettingsPatch } from "./settings.ts";
import type {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlListRepositoriesInput,
  SourceControlListRepositoriesResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  children?: readonly ContextMenuItem<T>[];
}

export interface ContextMenuItemSchemaType {
  readonly id: string;
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly children?: readonly ContextMenuItemSchemaType[];
}

export const ContextMenuItemSchema: Schema.Codec<ContextMenuItemSchemaType> = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  destructive: Schema.optionalKey(Schema.Boolean),
  disabled: Schema.optionalKey(Schema.Boolean),
  children: Schema.optionalKey(
    Schema.Array(
      Schema.suspend((): Schema.Codec<ContextMenuItemSchemaType> => ContextMenuItemSchema),
    ),
  ),
});

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";
export type DesktopUpdateChannel = "latest" | "nightly";
export type DesktopAppStageLabel = "Alpha" | "Dev" | "Nightly";
export type DesktopTaskbarStatus = "idle" | "working" | "completed";
export type DesktopCaptureScreenshotMode = "interactive";
export type DesktopCapturedScreenshotSource =
  | "macos-screencapture"
  | "windows-snipping-tool-clipboard";

export const DesktopUpdateStatusSchema = Schema.Literals([
  "disabled",
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "error",
]);
export const DesktopRuntimeArchSchema = Schema.Literals(["arm64", "x64", "other"]);
export const DesktopThemeSchema = Schema.Literals(["light", "dark", "system"]);
export const DesktopUpdateChannelSchema = Schema.Literals(["latest", "nightly"]);
export const DesktopAppStageLabelSchema = Schema.Literals(["Alpha", "Dev", "Nightly"]);
export const DesktopTaskbarStatusSchema = Schema.Literals(["idle", "working", "completed"]);
export const DesktopCaptureScreenshotModeSchema = Schema.Literals(["interactive"]);
export const DesktopCapturedScreenshotSourceSchema = Schema.Literals([
  "macos-screencapture",
  "windows-snipping-tool-clipboard",
]);

export interface DesktopAppBranding {
  baseName: string;
  stageLabel: DesktopAppStageLabel;
  displayName: string;
  version: string;
}

export const DesktopAppBrandingSchema = Schema.Struct({
  baseName: Schema.String,
  stageLabel: DesktopAppStageLabelSchema,
  displayName: Schema.String,
  version: TrimmedNonEmptyString,
});

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export const DesktopRuntimeInfoSchema = Schema.Struct({
  hostArch: DesktopRuntimeArchSchema,
  appArch: DesktopRuntimeArchSchema,
  runningUnderArm64Translation: Schema.Boolean,
});

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  channel: DesktopUpdateChannel;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export const DesktopUpdateStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  status: DesktopUpdateStatusSchema,
  channel: DesktopUpdateChannelSchema,
  currentVersion: Schema.String,
  hostArch: DesktopRuntimeArchSchema,
  appArch: DesktopRuntimeArchSchema,
  runningUnderArm64Translation: Schema.Boolean,
  availableVersion: Schema.NullOr(Schema.String),
  downloadedVersion: Schema.NullOr(Schema.String),
  downloadPercent: Schema.NullOr(Schema.Number),
  checkedAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  errorContext: Schema.NullOr(Schema.Literals(["check", "download", "install"])),
  canRetry: Schema.Boolean,
});

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export const DesktopUpdateActionResultSchema = Schema.Struct({
  accepted: Schema.Boolean,
  completed: Schema.Boolean,
  state: DesktopUpdateStateSchema,
});

export interface DesktopUpdateCheckResult {
  checked: boolean;
  state: DesktopUpdateState;
}

export const DesktopUpdateCheckResultSchema = Schema.Struct({
  checked: Schema.Boolean,
  state: DesktopUpdateStateSchema,
});

export type DesktopTaskbarThreadState = "running" | "completed";

export const DesktopTaskbarThreadStateSchema = Schema.Literals(["running", "completed"]);

/** A thread surfaced in the desktop status item menu (click-to-open). */
export interface DesktopTaskbarThreadSummary {
  threadId: string;
  environmentId: string;
  title: string;
  state: DesktopTaskbarThreadState;
}

export const DesktopTaskbarThreadSummarySchema = Schema.Struct({
  threadId: Schema.String,
  environmentId: Schema.String,
  title: Schema.String,
  state: DesktopTaskbarThreadStateSchema,
});

export interface DesktopTaskbarStatusInput {
  status: DesktopTaskbarStatus;
  description?: string;
  runningThreadCount?: number;
  /** Threads that finished while the app was unfocused (drives dock/taskbar badges). */
  completedThreadCount?: number;
  /** Unseen-completed and running threads, in display order for the status item menu. */
  threads?: readonly DesktopTaskbarThreadSummary[];
}

export const DesktopTaskbarStatusInputSchema = Schema.Struct({
  status: DesktopTaskbarStatusSchema,
  description: Schema.optionalKey(Schema.String),
  runningThreadCount: Schema.optionalKey(Schema.Number),
  completedThreadCount: Schema.optionalKey(Schema.Number),
  threads: Schema.optionalKey(Schema.Array(DesktopTaskbarThreadSummarySchema)),
});

/** Optional structured payload accompanying a desktop menu action. */
export interface DesktopMenuActionPayload {
  environmentId?: string;
  threadId?: string;
}

/**
 * Preview automation, the surface the agent will eventually drive.
 *
 * Keyed by the guest's webContents id rather than a thread: the renderer owns
 * the <webview> and is the only side that knows which element belongs to which
 * thread, so it registers the pairing and the main process stays a dumb
 * executor that cannot act on a tab nobody claimed.
 */
export const DesktopPreviewTargetSchema = Schema.Struct({
  webContentsId: Schema.Number,
});
export type DesktopPreviewTarget = typeof DesktopPreviewTargetSchema.Type;

export const DesktopPreviewEvaluateInputSchema = Schema.Struct({
  webContentsId: Schema.Number,
  expression: Schema.String,
});
export type DesktopPreviewEvaluateInput = typeof DesktopPreviewEvaluateInputSchema.Type;

export const DesktopPreviewConsoleEntrySchema = Schema.Struct({
  level: Schema.String,
  text: Schema.String,
  at: Schema.String,
});
export type DesktopPreviewConsoleEntry = typeof DesktopPreviewConsoleEntrySchema.Type;

export const DesktopPreviewNetworkFailureSchema = Schema.Struct({
  url: Schema.String,
  status: Schema.NullOr(Schema.Number),
  errorText: Schema.NullOr(Schema.String),
  at: Schema.String,
});
export type DesktopPreviewNetworkFailure = typeof DesktopPreviewNetworkFailureSchema.Type;

/**
 * An element the agent can address, taken from the accessibility tree.
 *
 * `ref` is a backend node id: stable for the life of the document, and handed
 * back verbatim to act on the element. Targeting by ref rather than by a
 * selector string means there is nothing to parse and nothing ambiguous -- the
 * agent acts on something it was actually shown.
 */
export const DesktopPreviewElementSchema = Schema.Struct({
  ref: Schema.Number,
  role: Schema.String,
  name: Schema.String,
  value: Schema.NullOr(Schema.String),
  disabled: Schema.Boolean,
});
export type DesktopPreviewElement = typeof DesktopPreviewElementSchema.Type;

/**
 * How the user points at the page.
 *
 * "element" is one thing under the cursor. "region" is a dragged rectangle, for
 * when the thing worth talking about is a row of cards or a whole section
 * rather than any single node -- describing that one element at a time is the
 * work the rectangle exists to avoid.
 */
export const DesktopPreviewPickModeSchema = Schema.Literals(["element", "region"]);
export type DesktopPreviewPickMode = typeof DesktopPreviewPickModeSchema.Type;

export const DesktopPreviewPickInputSchema = Schema.Struct({
  webContentsId: Schema.Number,
  /** The app's resolved theme; the pick cursor is drawn to match it. */
  colorScheme: Schema.Literals(["light", "dark"]),
  mode: DesktopPreviewPickModeSchema,
});
export type DesktopPreviewPickInput = typeof DesktopPreviewPickInputSchema.Type;

/**
 * Marking up the page rather than pointing at it.
 *
 * "draw" leaves ink, "erase" takes a stroke back off, null clears the lot. The
 * marks are never reported anywhere: they exist so a screenshot can carry them,
 * which is why turning the mode off is also how you start over.
 */
export const DesktopPreviewAnnotationModeSchema = Schema.Literals(["draw", "erase"]);
export type DesktopPreviewAnnotationMode = typeof DesktopPreviewAnnotationModeSchema.Type;

export const DesktopPreviewAnnotateInputSchema = Schema.Struct({
  webContentsId: Schema.Number,
  mode: Schema.NullOr(DesktopPreviewAnnotationModeSchema),
});
export type DesktopPreviewAnnotateInput = typeof DesktopPreviewAnnotateInputSchema.Type;

export const DesktopPreviewRevealInputSchema = Schema.Struct({
  webContentsId: Schema.Number,
  selector: Schema.String,
});
export type DesktopPreviewRevealInput = typeof DesktopPreviewRevealInputSchema.Type;

export const DesktopPreviewClickInputSchema = Schema.Struct({
  webContentsId: Schema.Number,
  target: PreviewAutomationTargetSchema,
});
export type DesktopPreviewClickInput = typeof DesktopPreviewClickInputSchema.Type;

export const DesktopPreviewTypeInputSchema = Schema.Struct({
  webContentsId: Schema.Number,
  target: PreviewAutomationTargetSchema,
  text: Schema.String,
  /** Replace what is already in the field rather than appending to it. */
  clear: Schema.optional(Schema.Boolean),
});
export type DesktopPreviewTypeInput = typeof DesktopPreviewTypeInputSchema.Type;

export const DesktopPreviewPressInputSchema = Schema.Struct({
  webContentsId: Schema.Number,
  key: Schema.String,
  modifiers: Schema.optionalKey(Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"]))),
});
export type DesktopPreviewPressInput = typeof DesktopPreviewPressInputSchema.Type;

export const DesktopPreviewScrollInputSchema = Schema.Struct({
  webContentsId: Schema.Number,
  deltaX: Schema.optionalKey(Schema.Number),
  deltaY: Schema.optionalKey(Schema.Number),
  target: Schema.optionalKey(PreviewAutomationTargetSchema),
});
export type DesktopPreviewScrollInput = typeof DesktopPreviewScrollInputSchema.Type;

export const DesktopPreviewWaitForInputSchema = Schema.Struct({
  webContentsId: Schema.Number,
  target: Schema.optionalKey(PreviewAutomationTargetSchema),
  text: Schema.optionalKey(Schema.String),
  urlContains: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(Schema.Number),
});
export type DesktopPreviewWaitForInput = typeof DesktopPreviewWaitForInputSchema.Type;

export const DesktopPreviewStatusSchema = Schema.Struct({
  webContentsId: Schema.Number,
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  attached: Schema.Boolean,
  /** Console output since the page last navigated, oldest first. */
  console: Schema.Array(DesktopPreviewConsoleEntrySchema),
  /** Requests that failed or returned >= 400 since the page last navigated. */
  networkFailures: Schema.Array(DesktopPreviewNetworkFailureSchema),
});
export type DesktopPreviewStatus = typeof DesktopPreviewStatusSchema.Type;

export const DesktopPreviewViewportInputSchema = Schema.Struct({
  webContentsId: Schema.Number,
  /** null clears the override and lets the page size itself to the element. */
  width: Schema.NullOr(Schema.Number),
  height: Schema.NullOr(Schema.Number),
});
export type DesktopPreviewViewportInput = typeof DesktopPreviewViewportInputSchema.Type;

export const DesktopPreviewColorSchemeInputSchema = Schema.Struct({
  webContentsId: Schema.Number,
  colorScheme: Schema.Literals(["light", "dark"]),
});
export type DesktopPreviewColorSchemeInput = typeof DesktopPreviewColorSchemeInputSchema.Type;

export const DesktopPreviewScreenshotSchema = Schema.Struct({
  dataUrl: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
});
export type DesktopPreviewScreenshot = typeof DesktopPreviewScreenshotSchema.Type;

/** A server listening on this machine, offered as a destination for the preview. */
export const DesktopLocalServerSchema = Schema.Struct({
  port: Schema.Number,
  processName: Schema.String,
  pid: Schema.Number,
  /** The served page's title, which identifies a server better than "node". */
  title: Schema.NullOr(Schema.String),
});
export type DesktopLocalServer = typeof DesktopLocalServerSchema.Type;

/**
 * An element the user pointed at in the preview.
 *
 * Described rather than referenced: a backend node id is only valid for the
 * document that produced it, so handing one to an agent that will act minutes
 * later, possibly after a reload, would be a dangling pointer. Role and name
 * are what the agent looks elements up by anyway.
 */
export const DesktopPreviewPickedElementSchema = Schema.Struct({
  tagName: Schema.String,
  /** Accessible role and name, matching how snapshot elements are identified. */
  role: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  /** A CSS path good enough to find the element again by hand. */
  selector: Schema.String,
  text: Schema.NullOr(Schema.String),
  /** What the user said about it while picking; the reason the element matters. */
  note: Schema.NullOr(Schema.String),
  /**
   * Style tweaks made on the page while annotating, as before-and-after pairs.
   * A proposal, not an edit: the page is a scratch pad and nothing here has
   * touched the source.
   */
  styleChanges: Schema.Array(
    Schema.Struct({
      property: Schema.String,
      from: Schema.String,
      to: Schema.String,
    }),
  ),
  rect: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
  url: Schema.String,
});
export type DesktopPreviewPickedElement = typeof DesktopPreviewPickedElementSchema.Type;

export const DesktopPreviewSnapshotSchema = Schema.Struct({
  ...DesktopPreviewStatusSchema.fields,
  elements: Schema.Array(DesktopPreviewElementSchema),
});
export type DesktopPreviewSnapshot = typeof DesktopPreviewSnapshotSchema.Type;

export const DesktopCaptureScreenshotInputSchema = Schema.Struct({
  mode: DesktopCaptureScreenshotModeSchema,
});
export type DesktopCaptureScreenshotInput = typeof DesktopCaptureScreenshotInputSchema.Type;

export const DesktopCapturedScreenshotSchema = Schema.Struct({
  name: Schema.String,
  mimeType: Schema.Literal("image/png"),
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  capturedAt: Schema.String,
  source: DesktopCapturedScreenshotSourceSchema,
});
export type DesktopCapturedScreenshot = typeof DesktopCapturedScreenshotSchema.Type;

export const DesktopCaptureScreenshotResultSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("captured"),
    image: DesktopCapturedScreenshotSchema,
  }),
  Schema.Struct({
    status: Schema.Literal("cancelled"),
    message: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    status: Schema.Literal("unsupported"),
    message: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    message: Schema.String,
  }),
]);
export type DesktopCaptureScreenshotResult = typeof DesktopCaptureScreenshotResultSchema.Type;

export interface DesktopEnvironmentBootstrap {
  label: string;
  httpBaseUrl: string | null;
  wsBaseUrl: string | null;
  bootstrapToken?: string;
}

export const DesktopEnvironmentBootstrapSchema = Schema.Struct({
  label: Schema.String,
  httpBaseUrl: Schema.NullOr(Schema.String),
  wsBaseUrl: Schema.NullOr(Schema.String),
  bootstrapToken: Schema.optionalKey(Schema.String),
});

export const DesktopSshEnvironmentTargetSchema = Schema.Struct({
  alias: Schema.String,
  hostname: Schema.String,
  username: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
});
export type DesktopSshEnvironmentTarget = typeof DesktopSshEnvironmentTargetSchema.Type;

export type DesktopSshHostSource = "ssh-config" | "known-hosts";
export const DesktopSshHostSourceSchema = Schema.Literals(["ssh-config", "known-hosts"]);

export interface DesktopDiscoveredSshHost extends DesktopSshEnvironmentTarget {
  source: DesktopSshHostSource;
}

export const DesktopDiscoveredSshHostSchema = Schema.Struct({
  alias: Schema.String,
  hostname: Schema.String,
  username: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
  source: DesktopSshHostSourceSchema,
});

export interface DesktopSshEnvironmentBootstrap {
  target: DesktopSshEnvironmentTarget;
  httpBaseUrl: string;
  wsBaseUrl: string;
  pairingToken: string | null;
  remotePort?: number;
  remoteServerKind?: "external" | "managed";
}

export const DesktopSshEnvironmentBootstrapSchema = Schema.Struct({
  target: DesktopSshEnvironmentTargetSchema,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  pairingToken: Schema.NullOr(Schema.String),
  remotePort: Schema.optionalKey(Schema.Number),
  remoteServerKind: Schema.optionalKey(Schema.Literals(["external", "managed"])),
});

export interface DesktopSshPasswordPromptRequest {
  requestId: string;
  destination: string;
  username: string | null;
  prompt: string;
  expiresAt: string;
}

export const DesktopSshPasswordPromptRequestSchema = Schema.Struct({
  requestId: Schema.String,
  destination: Schema.String,
  username: Schema.NullOr(Schema.String),
  prompt: Schema.String,
  expiresAt: Schema.String,
});

export const DesktopSshPasswordPromptCancelledType = "ssh-password-prompt-cancelled" as const;

export const DesktopSshPasswordPromptCancelledResultSchema = Schema.Struct({
  type: Schema.Literal(DesktopSshPasswordPromptCancelledType),
  message: Schema.String,
});

export const DesktopSshEnvironmentEnsureOptionsSchema = Schema.Struct({
  issuePairingToken: Schema.optionalKey(Schema.Boolean),
});

export const DesktopSshEnvironmentEnsureInputSchema = Schema.Struct({
  target: DesktopSshEnvironmentTargetSchema,
  options: Schema.optionalKey(DesktopSshEnvironmentEnsureOptionsSchema),
});

export const DesktopSshEnvironmentEnsureResultSchema = Schema.Union([
  DesktopSshEnvironmentBootstrapSchema,
  DesktopSshPasswordPromptCancelledResultSchema,
]);

export const DesktopSshHttpBaseUrlInputSchema = Schema.Struct({
  httpBaseUrl: Schema.String,
});

export const DesktopSshBearerRequestInputSchema = Schema.Struct({
  httpBaseUrl: Schema.String,
  bearerToken: Schema.String,
});

export const DesktopSshBearerBootstrapInputSchema = Schema.Struct({
  httpBaseUrl: Schema.String,
  credential: Schema.String,
});

export const DesktopSshPasswordPromptResolutionInputSchema = Schema.Struct({
  requestId: Schema.String,
  password: Schema.NullOr(Schema.String),
});

export const PersistedSavedEnvironmentRecordSchema = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  wsBaseUrl: Schema.String,
  httpBaseUrl: Schema.String,
  createdAt: Schema.String,
  lastConnectedAt: Schema.NullOr(Schema.String),
  desktopSsh: Schema.optionalKey(DesktopSshEnvironmentTargetSchema),
  relay: Schema.optionalKey(
    Schema.Struct({
      relayOrigin: Schema.String,
      sessionId: Schema.String,
    }),
  ),
});
export type PersistedSavedEnvironmentRecord = typeof PersistedSavedEnvironmentRecordSchema.Type;

export type DesktopServerExposureMode = "local-only" | "network-accessible";

export const DesktopServerExposureModeSchema = Schema.Literals([
  "local-only",
  "network-accessible",
]);

export interface DesktopServerExposureState {
  mode: DesktopServerExposureMode;
  endpointUrl: string | null;
  advertisedHost: string | null;
  tailscaleServeEnabled: boolean;
  tailscaleServePort: number;
}

export const DesktopServerExposureStateSchema = Schema.Struct({
  mode: DesktopServerExposureModeSchema,
  endpointUrl: Schema.NullOr(Schema.String),
  advertisedHost: Schema.NullOr(Schema.String),
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: Schema.Number,
});

export const DesktopRelayPairingSessionSchema = Schema.Struct({
  pairingUrl: Schema.String,
  relayOrigin: Schema.String,
  sessionId: Schema.String,
  expiresAt: IsoDateTime,
  status: Schema.optionalKey(Schema.Literals(["open", "reconnecting", "disconnected"])),
});
export type DesktopRelayPairingSession = typeof DesktopRelayPairingSessionSchema.Type;
export const DesktopRelayPairingSessionOrNullSchema = Schema.NullOr(
  DesktopRelayPairingSessionSchema,
);

export interface PickFolderOptions {
  initialPath?: string | null;
}

export const PickFolderOptionsSchema = Schema.Struct({
  initialPath: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export interface DesktopBridge {
  getAppBranding: () => DesktopAppBranding | null;
  getLocalEnvironmentBootstrap: () => DesktopEnvironmentBootstrap | null;
  getClientSettings: () => Promise<ClientSettings | null>;
  setClientSettings: (settings: ClientSettings) => Promise<void>;
  getSavedEnvironmentRegistry: () => Promise<readonly PersistedSavedEnvironmentRecord[]>;
  setSavedEnvironmentRegistry: (
    records: readonly PersistedSavedEnvironmentRecord[],
  ) => Promise<void>;
  getSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<string | null>;
  setSavedEnvironmentSecret: (environmentId: EnvironmentId, secret: string) => Promise<boolean>;
  removeSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<void>;
  discoverSshHosts: () => Promise<readonly DesktopDiscoveredSshHost[]>;
  ensureSshEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { issuePairingToken?: boolean },
  ) => Promise<DesktopSshEnvironmentBootstrap>;
  disconnectSshEnvironment: (target: DesktopSshEnvironmentTarget) => Promise<void>;
  fetchSshEnvironmentDescriptor: (httpBaseUrl: string) => Promise<ExecutionEnvironmentDescriptor>;
  bootstrapSshBearerSession: (
    httpBaseUrl: string,
    credential: string,
  ) => Promise<AuthBearerBootstrapResult>;
  fetchSshSessionState: (httpBaseUrl: string, bearerToken: string) => Promise<AuthSessionState>;
  issueSshWebSocketToken: (
    httpBaseUrl: string,
    bearerToken: string,
  ) => Promise<AuthWebSocketTokenResult>;
  onSshPasswordPrompt: (listener: (request: DesktopSshPasswordPromptRequest) => void) => () => void;
  resolveSshPasswordPrompt: (requestId: string, password: string | null) => Promise<void>;
  getServerExposureState: () => Promise<DesktopServerExposureState>;
  setServerExposureMode: (mode: DesktopServerExposureMode) => Promise<DesktopServerExposureState>;
  setTailscaleServeEnabled: (input: {
    readonly enabled: boolean;
    readonly port?: number;
  }) => Promise<DesktopServerExposureState>;
  getAdvertisedEndpoints: () => Promise<readonly AdvertisedEndpoint[]>;
  getRelayPairingSession: () => Promise<DesktopRelayPairingSession | null>;
  createRelayPairingSession: () => Promise<DesktopRelayPairingSession>;
  disconnectRelayPairingSession: () => Promise<void>;
  pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  captureScreenshot?: (
    input: DesktopCaptureScreenshotInput,
  ) => Promise<DesktopCaptureScreenshotResult>;
  previewAttach?: (input: DesktopPreviewTarget) => Promise<DesktopPreviewStatus>;
  previewDetach?: (input: DesktopPreviewTarget) => Promise<void>;
  previewStatus?: (input: DesktopPreviewTarget) => Promise<DesktopPreviewStatus>;
  previewEvaluate?: (input: DesktopPreviewEvaluateInput) => Promise<unknown>;
  previewSnapshot?: (input: DesktopPreviewTarget) => Promise<DesktopPreviewSnapshot>;
  previewClick?: (input: DesktopPreviewClickInput) => Promise<void>;
  previewType?: (input: DesktopPreviewTypeInput) => Promise<void>;
  previewPress?: (input: DesktopPreviewPressInput) => Promise<void>;
  previewScroll?: (input: DesktopPreviewScrollInput) => Promise<void>;
  previewWaitFor?: (input: DesktopPreviewWaitForInput) => Promise<void>;
  previewLocalServers?: () => Promise<readonly DesktopLocalServer[]>;
  previewScreenshot?: (input: DesktopPreviewTarget) => Promise<DesktopPreviewScreenshot>;
  previewOpenDevTools?: (input: DesktopPreviewTarget) => Promise<void>;
  previewSetColorScheme?: (input: DesktopPreviewColorSchemeInput) => Promise<void>;
  /** Resolves empty when picking is cancelled or times out. Region picks
   *  resolve many elements at once; element picks resolve at most one. */
  previewPickElement?: (
    input: DesktopPreviewPickInput,
  ) => Promise<readonly DesktopPreviewPickedElement[]>;
  previewCancelPick?: (input: DesktopPreviewTarget) => Promise<void>;
  /** Arms drawing or erasing on the page, or clears the marks when null. */
  previewSetAnnotationMode?: (input: DesktopPreviewAnnotateInput) => Promise<void>;
  /** Resolves false when the element is no longer on the page. */
  previewRevealElement?: (input: DesktopPreviewRevealInput) => Promise<boolean>;
  previewSetViewport?: (input: DesktopPreviewViewportInput) => Promise<void>;
  previewClearBrowsingData?: () => Promise<void>;
  previewClearCache?: () => Promise<void>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  setTaskbarStatus?: (input: DesktopTaskbarStatusInput) => Promise<void>;
  onMenuAction: (
    listener: (action: string, payload?: DesktopMenuActionPayload) => void,
  ) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  setUpdateChannel: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
}

/**
 * APIs bound to the local app shell, not to any particular backend environment.
 *
 * These capabilities describe the desktop/browser host that the user is
 * currently running: dialogs, editor/external-link opening, context menus, and
 * app-level settings/config access. They must not be used as a proxy for
 * "whatever environment the user is targeting", because in a multi-environment
 * world the local shell and a selected backend environment are distinct
 * concepts.
 */
export interface LocalApi {
  dialogs: {
    pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  persistence: {
    getClientSettings: () => Promise<ClientSettings | null>;
    setClientSettings: (settings: ClientSettings) => Promise<void>;
    getSavedEnvironmentRegistry: () => Promise<readonly PersistedSavedEnvironmentRecord[]>;
    setSavedEnvironmentRegistry: (
      records: readonly PersistedSavedEnvironmentRecord[],
    ) => Promise<void>;
    getSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<string | null>;
    setSavedEnvironmentSecret: (environmentId: EnvironmentId, secret: string) => Promise<boolean>;
    removeSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<void>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    /**
     * Refresh provider snapshots. When `input.instanceId` is supplied only that
     * configured instance is probed; otherwise every configured instance is
     * refreshed (legacy untargeted refresh).
     */
    refreshProviders: (input?: {
      readonly instanceId?: ProviderInstanceId;
    }) => Promise<ServerProviderUpdatedPayload>;
    consumeProviderRateLimitResetCredit: (
      input: ServerProviderRateLimitResetCreditConsumeInput,
    ) => Promise<ServerProviderRateLimitResetCreditConsumeResult>;
    updateProvider: (input: ServerProviderUpdateInput) => Promise<ServerProviderUpdatedPayload>;
    resolveProviderUpdateBlockers: (
      input: ServerProviderUpdateInput,
    ) => Promise<ServerProviderUpdateBlockerResolutionResult>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    removeKeybinding: (input: ServerRemoveKeybindingInput) => Promise<ServerRemoveKeybindingResult>;
    getSettings: () => Promise<ServerSettings>;
    updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
    discoverSourceControl: () => Promise<SourceControlDiscoveryResult>;
    getTraceDiagnostics: () => Promise<ServerTraceDiagnosticsResult>;
    getProcessDiagnostics: () => Promise<ServerProcessDiagnosticsResult>;
    getProcessResourceHistory: (
      input: ServerProcessResourceHistoryInput,
    ) => Promise<ServerProcessResourceHistoryResult>;
    signalProcess: (input: ServerSignalProcessInput) => Promise<ServerSignalProcessResult>;
    resolveBackgroundRuns: (
      input: ServerResolveBackgroundRunsInput,
    ) => Promise<ServerResolveBackgroundRunsResult>;
    stopBackgroundRun: (input: ServerStopBackgroundRunInput) => Promise<ServerSignalProcessResult>;
    getProviderExtensions: (
      input: ProviderExtensionsInventoryInput,
    ) => Promise<ProviderExtensionsInventoryResult>;
    startProviderExtensionMcpOAuth: (
      input: ProviderExtensionMcpOAuthStartInput,
    ) => Promise<ProviderExtensionMcpOAuthStartResult>;
    getProviderExtensionOperationStatus: (
      input: ProviderExtensionOperationStatusInput,
    ) => Promise<ProviderExtensionOperationStatusResult>;
    reloadProviderExtensionMcpServers: (
      input: ProviderExtensionMcpReloadInput,
    ) => Promise<ProviderExtensionMcpReloadResult>;
    setProviderExtensionSkillEnabled: (
      input: ProviderExtensionSkillToggleInput,
    ) => Promise<ProviderExtensionSkillToggleResult>;
    readProviderExtensionPlugin: (
      input: ProviderExtensionPluginReadInput,
    ) => Promise<ProviderExtensionPluginReadResult>;
    installProviderExtensionPlugin: (
      input: ProviderExtensionPluginInstallInput,
    ) => Promise<ProviderExtensionPluginInstallResult>;
    uninstallProviderExtensionPlugin: (
      input: ProviderExtensionPluginUninstallInput,
    ) => Promise<ProviderExtensionPluginUninstallResult>;
    setProviderExtensionPluginEnabled: (
      input: ProviderExtensionPluginToggleInput,
    ) => Promise<ProviderExtensionPluginToggleResult>;
    updateProviderExtensionPlugin: (
      input: ProviderExtensionPluginUpdateInput,
    ) => Promise<ProviderExtensionPluginUpdateResult>;
    refreshProviderExtensionPluginMarketplaces: (
      input: ProviderExtensionPluginMarketplaceRefreshInput,
    ) => Promise<ProviderExtensionPluginMarketplaceRefreshResult>;
    callProviderExtensionMcpTool: (
      input: ProviderExtensionMcpToolCallInput,
    ) => Promise<ProviderExtensionMcpToolCallResult>;
    readProviderExtensionMcpResource: (
      input: ProviderExtensionMcpResourceReadInput,
    ) => Promise<ProviderExtensionMcpResourceReadResult>;
    getProviderInstructionFiles: (
      input: ProviderInstructionFilesInput,
    ) => Promise<ProviderInstructionFilesResult>;
    writeProviderInstructionFile: (
      input: ProviderInstructionWriteInput,
    ) => Promise<ProviderInstructionWriteResult>;
  };
}

/**
 * APIs bound to a specific backend environment connection.
 *
 * These operations must always be routed with explicit environment context.
 * They represent remote stateful capabilities such as orchestration, terminal,
 * project, VCS, and provider operations. In multi-environment mode, each environment gets
 * its own instance of this surface, and callers should resolve it by
 * `environmentId` rather than reaching through the local desktop bridge.
 */
export interface EnvironmentApi {
  /** Offers this client's browser panel as the page the agent acts on. */
  previewAutomation: {
    connect: (
      input: PreviewAutomationHost,
      listener: (request: PreviewAutomationRequest) => void,
    ) => () => void;
    respond: (response: PreviewAutomationResponse) => Promise<void>;
  };
  terminal: {
    open: (input: typeof TerminalOpenInput.Encoded) => Promise<TerminalSessionSnapshot>;
    write: (input: typeof TerminalWriteInput.Encoded) => Promise<void>;
    resize: (input: typeof TerminalResizeInput.Encoded) => Promise<void>;
    clear: (input: typeof TerminalClearInput.Encoded) => Promise<void>;
    restart: (input: typeof TerminalRestartInput.Encoded) => Promise<TerminalSessionSnapshot>;
    close: (input: typeof TerminalCloseInput.Encoded) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  realtime: {
    appendAudio: (input: ProviderRealtimeAppendAudioInput) => Promise<void>;
    subscribeAudio: (
      input: ProviderRealtimeStartInput,
      callback: (audio: ProviderRealtimeAudioChunk) => void,
    ) => () => void;
  };
  projects: {
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
    listEntries: (input: ProjectListEntriesInput) => Promise<ProjectListEntriesResult>;
    readFile: (input: ProjectReadFileInput) => Promise<ProjectReadFileResult>;
    favicon: (input: ProjectFaviconInput) => Promise<ProjectFaviconResult>;
  };
  /** Provider capabilities scoped to this backend environment. Optional so
   * newer clients can still connect to older Threadlines servers. */
  providers?: {
    getExtensions: (
      input: ProviderExtensionsInventoryInput,
    ) => Promise<ProviderExtensionsInventoryResult>;
  };
  attachments: {
    read: (input: ChatAttachmentReadInput) => Promise<ChatAttachmentReadResult>;
  };
  filesystem: {
    browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
  };
  sourceControl: {
    lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Promise<SourceControlRepositoryInfo>;
    listRepositories: (
      input: SourceControlListRepositoriesInput,
    ) => Promise<SourceControlListRepositoriesResult>;
    cloneRepository: (
      input: SourceControlCloneRepositoryInput,
    ) => Promise<SourceControlCloneRepositoryResult>;
    publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Promise<SourceControlPublishRepositoryResult>;
  };
  vcs: {
    listRefs: (input: VcsListRefsInput) => Promise<VcsListRefsResult>;
    commitGraph: (input: VcsCommitGraphInput) => Promise<VcsCommitGraphResult>;
    commitDetails: (input: VcsCommitDetailsInput) => Promise<VcsCommitDetailsResult>;
    workingTreeDiff: (input: VcsWorkingTreeDiffInput) => Promise<VcsWorkingTreeDiffResult>;
    discardChanges: (input: VcsDiscardChangesInput) => Promise<VcsDiscardChangesResult>;
    stageChanges: (input: VcsStageChangesInput) => Promise<VcsStageChangesResult>;
    unstageChanges: (input: VcsUnstageChangesInput) => Promise<VcsUnstageChangesResult>;
    createWorktree: (input: VcsCreateWorktreeInput) => Promise<VcsCreateWorktreeResult>;
    removeWorktree: (input: VcsRemoveWorktreeInput) => Promise<void>;
    createRef: (input: VcsCreateRefInput) => Promise<VcsCreateRefResult>;
    createTag: (input: VcsCreateTagInput) => Promise<VcsCreateTagResult>;
    deleteBranch: (input: VcsDeleteBranchInput) => Promise<VcsDeleteBranchResult>;
    switchRef: (input: VcsSwitchRefInput) => Promise<VcsSwitchRefResult>;
    mergeRef: (input: VcsMergeRefInput) => Promise<VcsMergeRefResult>;
    init: (input: VcsInitInput) => Promise<void>;
    pull: (input: VcsPullInput) => Promise<VcsPullResult>;
    refreshLocalStatus: (input: VcsStatusInput) => Promise<VcsStatusLocalResult>;
    refreshStatus: (input: VcsStatusInput) => Promise<VcsStatusResult>;
    onStatus: (
      input: VcsStatusInput,
      callback: (status: VcsStatusResult) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
  git: {
    generateCommitMessage: (
      input: GitGenerateCommitMessageInput,
    ) => Promise<GitGenerateCommitMessageResult>;
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
    authRemediationPlan: (input: GitAuthRemediationPlanInput) => Promise<GitAuthRemediationPlan>;
    applyAuthRemediation: (
      input: GitApplyAuthRemediationInput,
    ) => Promise<GitApplyAuthRemediationResult>;
  };
  orchestration: {
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    getRevertPlan: (
      input: OrchestrationGetRevertPlanInput,
    ) => Promise<OrchestrationGetRevertPlanResult>;
    searchThreads: (
      input: OrchestrationThreadSearchInput,
    ) => Promise<OrchestrationThreadSearchResult>;
    getArchivedShellSnapshot: () => Promise<OrchestrationShellSnapshot>;
    subscribeShell: (
      callback: (event: OrchestrationShellStreamItem) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
    subscribeThread: (
      input: OrchestrationSubscribeThreadInput,
      callback: (event: OrchestrationThreadStreamItem) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
}
