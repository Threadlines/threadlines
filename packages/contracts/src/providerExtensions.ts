import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ProviderExtensionsInventoryInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  providerThreadId: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderExtensionsInventoryInput = typeof ProviderExtensionsInventoryInput.Type;

export const ProviderExtensionProviderStatus = Schema.Literals([
  "ready",
  "partial",
  "error",
  "disabled",
  "unsupported",
]);
export type ProviderExtensionProviderStatus = typeof ProviderExtensionProviderStatus.Type;

export const ProviderExtensionPlugin = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.optional(Schema.Boolean),
  installed: Schema.optional(Schema.Boolean),
  source: Schema.optional(TrimmedNonEmptyString),
  scope: Schema.optional(TrimmedNonEmptyString),
  authPolicy: Schema.optional(TrimmedNonEmptyString),
  installPolicy: Schema.optional(TrimmedNonEmptyString),
  availability: Schema.optional(TrimmedNonEmptyString),
  marketplaceName: Schema.optional(TrimmedNonEmptyString),
  marketplacePath: Schema.optional(TrimmedNonEmptyString),
  remoteMarketplaceName: Schema.optional(TrimmedNonEmptyString),
  version: Schema.optional(TrimmedNonEmptyString),
  installPath: Schema.optional(TrimmedNonEmptyString),
  installedAt: Schema.optional(IsoDateTime),
  lastUpdated: Schema.optional(IsoDateTime),
  installCount: Schema.optional(NonNegativeInt),
  projectPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderExtensionPlugin = typeof ProviderExtensionPlugin.Type;

export const ProviderExtensionSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedString),
  shortDescription: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.optional(Schema.Boolean),
  scope: Schema.optional(TrimmedNonEmptyString),
  source: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderExtensionSkill = typeof ProviderExtensionSkill.Type;

export const ProviderExtensionMcpTool = Schema.Struct({
  name: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedString),
  description: Schema.optional(TrimmedString),
  inputSchema: Schema.optional(Schema.Unknown),
  outputSchema: Schema.optional(Schema.Unknown),
  annotations: Schema.optional(Schema.Unknown),
});
export type ProviderExtensionMcpTool = typeof ProviderExtensionMcpTool.Type;

export const ProviderExtensionMcpResource = Schema.Struct({
  name: TrimmedNonEmptyString,
  uri: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedString),
  description: Schema.optional(TrimmedString),
  mimeType: Schema.optional(TrimmedNonEmptyString),
  size: Schema.optional(NonNegativeInt),
  annotations: Schema.optional(Schema.Unknown),
});
export type ProviderExtensionMcpResource = typeof ProviderExtensionMcpResource.Type;

export const ProviderExtensionMcpResourceTemplate = Schema.Struct({
  name: TrimmedNonEmptyString,
  uriTemplate: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedString),
  description: Schema.optional(TrimmedString),
  mimeType: Schema.optional(TrimmedNonEmptyString),
  annotations: Schema.optional(Schema.Unknown),
});
export type ProviderExtensionMcpResourceTemplate = typeof ProviderExtensionMcpResourceTemplate.Type;

export const ProviderExtensionMcpServer = Schema.Struct({
  name: TrimmedNonEmptyString,
  authStatus: Schema.optional(TrimmedNonEmptyString),
  status: Schema.optional(TrimmedNonEmptyString),
  transport: Schema.optional(TrimmedNonEmptyString),
  tools: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  toolDefinitions: Schema.optional(Schema.Array(ProviderExtensionMcpTool)),
  resources: Schema.optional(Schema.Array(ProviderExtensionMcpResource)),
  resourceTemplates: Schema.optional(Schema.Array(ProviderExtensionMcpResourceTemplate)),
  toolCount: Schema.optional(NonNegativeInt),
  resourceCount: Schema.optional(NonNegativeInt),
  detail: Schema.optional(TrimmedString),
});
export type ProviderExtensionMcpServer = typeof ProviderExtensionMcpServer.Type;

export const ProviderExtensionApp = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedString),
  enabled: Schema.optional(Schema.Boolean),
  accessible: Schema.optional(Schema.Boolean),
});
export type ProviderExtensionApp = typeof ProviderExtensionApp.Type;

export const ProviderExtensionProviderInventory = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  status: ProviderExtensionProviderStatus,
  message: Schema.optional(TrimmedString),
  plugins: Schema.Array(ProviderExtensionPlugin),
  skills: Schema.Array(ProviderExtensionSkill),
  mcpServers: Schema.Array(ProviderExtensionMcpServer),
  apps: Schema.Array(ProviderExtensionApp),
});
export type ProviderExtensionProviderInventory = typeof ProviderExtensionProviderInventory.Type;

export const ProviderInstructionFileKind = Schema.Literals(["codex-agents", "claude-instructions"]);
export type ProviderInstructionFileKind = typeof ProviderInstructionFileKind.Type;

export const ProviderInstructionFileScope = Schema.Literals(["project", "project-local", "user"]);
export type ProviderInstructionFileScope = typeof ProviderInstructionFileScope.Type;

export const ProviderInstructionFileReadOnlyReason = Schema.Literals([
  "symbolic-link",
  "not-regular-file",
  "unreadable",
]);
export type ProviderInstructionFileReadOnlyReason =
  typeof ProviderInstructionFileReadOnlyReason.Type;

export const ProviderInstructionFile = Schema.Struct({
  kind: ProviderInstructionFileKind,
  scope: ProviderInstructionFileScope,
  path: TrimmedNonEmptyString,
  relativePath: Schema.optional(TrimmedNonEmptyString),
  exists: Schema.Boolean,
  editable: Schema.Boolean,
  readOnlyReason: Schema.optional(ProviderInstructionFileReadOnlyReason),
  contents: Schema.optional(Schema.String),
});
export type ProviderInstructionFile = typeof ProviderInstructionFile.Type;

export const ProviderInstructionFilesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ProviderInstructionFilesInput = typeof ProviderInstructionFilesInput.Type;

export const ProviderInstructionFilesResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: IsoDateTime,
  instructionFiles: Schema.Array(ProviderInstructionFile),
});
export type ProviderInstructionFilesResult = typeof ProviderInstructionFilesResult.Type;

export const ProviderExtensionsInventoryResult = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
  generatedAt: IsoDateTime,
  providers: Schema.Array(ProviderExtensionProviderInventory),
  instructionFiles: Schema.Array(ProviderInstructionFile),
});
export type ProviderExtensionsInventoryResult = typeof ProviderExtensionsInventoryResult.Type;

export const ProviderInstructionWriteInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  kind: ProviderInstructionFileKind,
  contents: Schema.String.check(Schema.isMaxLength(200_000)),
});
export type ProviderInstructionWriteInput = typeof ProviderInstructionWriteInput.Type;

export const ProviderInstructionWriteResult = Schema.Struct({
  file: ProviderInstructionFile,
});
export type ProviderInstructionWriteResult = typeof ProviderInstructionWriteResult.Type;

const ProviderExtensionActionBaseInput = {
  cwd: Schema.optional(TrimmedNonEmptyString),
  providerInstanceId: ProviderInstanceId,
};

export const ProviderExtensionMcpOAuthStartInput = Schema.Struct({
  ...ProviderExtensionActionBaseInput,
  serverName: TrimmedNonEmptyString,
  scopes: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  timeoutSecs: Schema.optional(NonNegativeInt),
});
export type ProviderExtensionMcpOAuthStartInput = typeof ProviderExtensionMcpOAuthStartInput.Type;

export const ProviderExtensionMcpOAuthStartResult = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  serverName: TrimmedNonEmptyString,
  authorizationUrl: Schema.optional(TrimmedNonEmptyString),
  terminalCommand: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type ProviderExtensionMcpOAuthStartResult = typeof ProviderExtensionMcpOAuthStartResult.Type;

export const ProviderExtensionOperationStatusInput = Schema.Struct({
  operationId: TrimmedNonEmptyString,
});
export type ProviderExtensionOperationStatusInput =
  typeof ProviderExtensionOperationStatusInput.Type;

export const ProviderExtensionOperationStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "expired",
]);
export type ProviderExtensionOperationStatus = typeof ProviderExtensionOperationStatus.Type;

export const ProviderExtensionOperationStatusResult = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  status: ProviderExtensionOperationStatus,
  message: Schema.optional(TrimmedString),
  error: Schema.optional(TrimmedString),
  completedAt: Schema.optional(IsoDateTime),
});
export type ProviderExtensionOperationStatusResult =
  typeof ProviderExtensionOperationStatusResult.Type;

export const ProviderExtensionMcpReloadInput = Schema.Struct({
  ...ProviderExtensionActionBaseInput,
});
export type ProviderExtensionMcpReloadInput = typeof ProviderExtensionMcpReloadInput.Type;

export const ProviderExtensionMcpReloadResult = Schema.Struct({
  reloaded: Schema.Boolean,
});
export type ProviderExtensionMcpReloadResult = typeof ProviderExtensionMcpReloadResult.Type;

export const ProviderExtensionSkillToggleInput = Schema.Struct({
  ...ProviderExtensionActionBaseInput,
  name: Schema.optional(TrimmedNonEmptyString),
  path: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
});
export type ProviderExtensionSkillToggleInput = typeof ProviderExtensionSkillToggleInput.Type;

export const ProviderExtensionSkillToggleResult = Schema.Struct({
  effectiveEnabled: Schema.Boolean,
});
export type ProviderExtensionSkillToggleResult = typeof ProviderExtensionSkillToggleResult.Type;

export const ProviderExtensionPluginReadInput = Schema.Struct({
  ...ProviderExtensionActionBaseInput,
  pluginName: TrimmedNonEmptyString,
  marketplacePath: Schema.optional(TrimmedNonEmptyString),
  remoteMarketplaceName: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderExtensionPluginReadInput = typeof ProviderExtensionPluginReadInput.Type;

export const ProviderExtensionPluginReadResult = Schema.Struct({
  plugin: Schema.Unknown,
});
export type ProviderExtensionPluginReadResult = typeof ProviderExtensionPluginReadResult.Type;

export const ProviderExtensionPluginInstallInput = Schema.Struct({
  ...ProviderExtensionActionBaseInput,
  pluginName: TrimmedNonEmptyString,
  marketplacePath: Schema.optional(TrimmedNonEmptyString),
  remoteMarketplaceName: Schema.optional(TrimmedNonEmptyString),
  scope: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderExtensionPluginInstallInput = typeof ProviderExtensionPluginInstallInput.Type;

export const ProviderExtensionPluginInstallResult = Schema.Struct({
  authPolicy: TrimmedNonEmptyString,
  appsNeedingAuth: Schema.Array(Schema.Unknown),
});
export type ProviderExtensionPluginInstallResult = typeof ProviderExtensionPluginInstallResult.Type;

export const ProviderExtensionPluginUninstallInput = Schema.Struct({
  ...ProviderExtensionActionBaseInput,
  pluginId: TrimmedNonEmptyString,
  scope: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderExtensionPluginUninstallInput =
  typeof ProviderExtensionPluginUninstallInput.Type;

export const ProviderExtensionPluginUninstallResult = Schema.Struct({
  uninstalled: Schema.Boolean,
});
export type ProviderExtensionPluginUninstallResult =
  typeof ProviderExtensionPluginUninstallResult.Type;

export const ProviderExtensionPluginToggleInput = Schema.Struct({
  ...ProviderExtensionActionBaseInput,
  pluginId: TrimmedNonEmptyString,
  scope: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
});
export type ProviderExtensionPluginToggleInput = typeof ProviderExtensionPluginToggleInput.Type;

export const ProviderExtensionPluginToggleResult = Schema.Struct({
  effectiveEnabled: Schema.Boolean,
});
export type ProviderExtensionPluginToggleResult = typeof ProviderExtensionPluginToggleResult.Type;

export const ProviderExtensionPluginUpdateInput = Schema.Struct({
  ...ProviderExtensionActionBaseInput,
  pluginId: TrimmedNonEmptyString,
  scope: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderExtensionPluginUpdateInput = typeof ProviderExtensionPluginUpdateInput.Type;

export const ProviderExtensionPluginUpdateResult = Schema.Struct({
  updated: Schema.Boolean,
});
export type ProviderExtensionPluginUpdateResult = typeof ProviderExtensionPluginUpdateResult.Type;

export const ProviderExtensionPluginMarketplaceRefreshInput = Schema.Struct({
  ...ProviderExtensionActionBaseInput,
  marketplaceName: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderExtensionPluginMarketplaceRefreshInput =
  typeof ProviderExtensionPluginMarketplaceRefreshInput.Type;

export const ProviderExtensionPluginMarketplaceRefreshResult = Schema.Struct({
  refreshed: Schema.Boolean,
  output: Schema.optional(TrimmedString),
});
export type ProviderExtensionPluginMarketplaceRefreshResult =
  typeof ProviderExtensionPluginMarketplaceRefreshResult.Type;

export const ProviderExtensionMcpToolCallInput = Schema.Struct({
  ...ProviderExtensionActionBaseInput,
  serverName: TrimmedNonEmptyString,
  toolName: TrimmedNonEmptyString,
  providerThreadId: TrimmedNonEmptyString,
  arguments: Schema.optional(Schema.Unknown),
});
export type ProviderExtensionMcpToolCallInput = typeof ProviderExtensionMcpToolCallInput.Type;

export const ProviderExtensionMcpToolCallResult = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  structuredContent: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
  meta: Schema.optional(Schema.Unknown),
});
export type ProviderExtensionMcpToolCallResult = typeof ProviderExtensionMcpToolCallResult.Type;

export const ProviderExtensionMcpResourceReadInput = Schema.Struct({
  ...ProviderExtensionActionBaseInput,
  serverName: TrimmedNonEmptyString,
  uri: TrimmedNonEmptyString,
  providerThreadId: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderExtensionMcpResourceReadInput =
  typeof ProviderExtensionMcpResourceReadInput.Type;

export const ProviderExtensionMcpResourceReadResult = Schema.Struct({
  contents: Schema.Array(Schema.Unknown),
});
export type ProviderExtensionMcpResourceReadResult =
  typeof ProviderExtensionMcpResourceReadResult.Type;

export class ProviderExtensionsError extends Schema.TaggedErrorClass<ProviderExtensionsError>()(
  "ProviderExtensionsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
