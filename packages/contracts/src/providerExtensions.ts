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

export const ProviderExtensionMcpServer = Schema.Struct({
  name: TrimmedNonEmptyString,
  authStatus: Schema.optional(TrimmedNonEmptyString),
  status: Schema.optional(TrimmedNonEmptyString),
  transport: Schema.optional(TrimmedNonEmptyString),
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

export const ProviderInstructionFile = Schema.Struct({
  kind: ProviderInstructionFileKind,
  scope: ProviderInstructionFileScope,
  path: TrimmedNonEmptyString,
  relativePath: Schema.optional(TrimmedNonEmptyString),
  exists: Schema.Boolean,
  editable: Schema.Boolean,
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

export class ProviderExtensionsError extends Schema.TaggedErrorClass<ProviderExtensionsError>()(
  "ProviderExtensionsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
