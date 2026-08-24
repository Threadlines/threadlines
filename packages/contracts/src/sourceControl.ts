import * as Schema from "effect/Schema";
import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { VcsDriverKind } from "./vcs.ts";

export const SourceControlProviderKind = Schema.Literals([
  "github",
  "gitlab",
  "azure-devops",
  "bitbucket",
  "unknown",
]);
export type SourceControlProviderKind = typeof SourceControlProviderKind.Type;

export const SourceControlProviderInfo = Schema.Struct({
  kind: SourceControlProviderKind,
  name: TrimmedNonEmptyString,
  baseUrl: Schema.String,
});
export type SourceControlProviderInfo = typeof SourceControlProviderInfo.Type;

export const ChangeRequestState = Schema.Literals(["open", "closed", "merged"]);
export type ChangeRequestState = typeof ChangeRequestState.Type;

export const ChangeRequest = Schema.Struct({
  provider: SourceControlProviderKind,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: ChangeRequestState,
  updatedAt: Schema.Option(Schema.DateTimeUtc),
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepositoryNameWithOwner: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  headRepositoryOwnerLogin: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type ChangeRequest = typeof ChangeRequest.Type;

export const SourceControlRepositoryCloneUrls = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
  defaultBranch: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlRepositoryCloneUrls = typeof SourceControlRepositoryCloneUrls.Type;

export const SourceControlRepositoryVisibility = Schema.Literals(["private", "public", "internal"]);
export type SourceControlRepositoryVisibility = typeof SourceControlRepositoryVisibility.Type;

export const SourceControlCloneProtocol = Schema.Literals(["auto", "ssh", "https"]);
export type SourceControlCloneProtocol = typeof SourceControlCloneProtocol.Type;

export const SourceControlRepositoryInfo = Schema.Struct({
  provider: SourceControlProviderKind,
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
export type SourceControlRepositoryInfo = typeof SourceControlRepositoryInfo.Type;

export const SourceControlRepositoryLookupInput = Schema.Struct({
  provider: SourceControlProviderKind,
  repository: TrimmedNonEmptyString,
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlRepositoryLookupInput = typeof SourceControlRepositoryLookupInput.Type;

export const SourceControlListRepositoriesInput = Schema.Struct({
  provider: SourceControlProviderKind,
  cwd: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type SourceControlListRepositoriesInput = typeof SourceControlListRepositoriesInput.Type;

export const SourceControlListRepositoriesResult = Schema.Struct({
  repositories: Schema.Array(SourceControlRepositoryInfo),
});
export type SourceControlListRepositoriesResult = typeof SourceControlListRepositoriesResult.Type;

export const SourceControlCloneRepositoryInput = Schema.Struct({
  provider: Schema.optional(SourceControlProviderKind),
  repository: Schema.optional(TrimmedNonEmptyString),
  remoteUrl: Schema.optional(TrimmedNonEmptyString),
  destinationPath: TrimmedNonEmptyString,
  protocol: Schema.optional(SourceControlCloneProtocol),
});
export type SourceControlCloneRepositoryInput = typeof SourceControlCloneRepositoryInput.Type;

export const SourceControlCloneRepositoryResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  repository: Schema.NullOr(SourceControlRepositoryInfo),
});
export type SourceControlCloneRepositoryResult = typeof SourceControlCloneRepositoryResult.Type;

export const SourceControlPublishRepositoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  provider: SourceControlProviderKind,
  repository: TrimmedNonEmptyString,
  visibility: SourceControlRepositoryVisibility,
  description: Schema.optional(TrimmedNonEmptyString),
  team: Schema.optional(TrimmedNonEmptyString),
  remoteName: Schema.optional(TrimmedNonEmptyString),
  protocol: Schema.optional(SourceControlCloneProtocol),
});
export type SourceControlPublishRepositoryInput = typeof SourceControlPublishRepositoryInput.Type;

export const SourceControlPublishStatus = Schema.Literals(["pushed", "remote_added"]);
export type SourceControlPublishStatus = typeof SourceControlPublishStatus.Type;

export const SourceControlPublishRepositoryResult = Schema.Struct({
  repository: SourceControlRepositoryInfo,
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  upstreamBranch: Schema.optional(TrimmedNonEmptyString),
  status: SourceControlPublishStatus,
});
export type SourceControlPublishRepositoryResult = typeof SourceControlPublishRepositoryResult.Type;

export const SourceControlDiscoveryStatus = Schema.Literals(["available", "missing"]);
export type SourceControlDiscoveryStatus = typeof SourceControlDiscoveryStatus.Type;

export const SourceControlProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type SourceControlProviderAuthStatus = typeof SourceControlProviderAuthStatus.Type;

export const SourceControlProviderAuth = Schema.Struct({
  status: SourceControlProviderAuthStatus,
  account: Schema.Option(TrimmedNonEmptyString),
  host: Schema.Option(TrimmedNonEmptyString),
  detail: Schema.Option(TrimmedNonEmptyString),
  preferredProtocol: Schema.optional(SourceControlCloneProtocol),
});
export type SourceControlProviderAuth = typeof SourceControlProviderAuth.Type;

export const SourceControlToolVersionAdvisoryStatus = Schema.Literals([
  "unknown",
  "install_available",
  "current",
  "behind_latest",
  "recommended_update",
]);
export type SourceControlToolVersionAdvisoryStatus =
  typeof SourceControlToolVersionAdvisoryStatus.Type;

export const SourceControlToolVersionAdvisorySeverity = Schema.Literals(["info", "warning"]);
export type SourceControlToolVersionAdvisorySeverity =
  typeof SourceControlToolVersionAdvisorySeverity.Type;

export const SourceControlToolUpdateTarget = Schema.Literals([
  "github-cli",
  "git",
  "gitlab-cli",
  "azure-cli",
]);
export type SourceControlToolUpdateTarget = typeof SourceControlToolUpdateTarget.Type;

export const SourceControlToolUpdateOperation = Schema.Literals(["install", "update"]);
export type SourceControlToolUpdateOperation = typeof SourceControlToolUpdateOperation.Type;

export const SourceControlToolVersionAdvisoryAction = Schema.Union([
  Schema.Struct({
    label: TrimmedNonEmptyString,
    kind: Schema.Literals(["copyCommand", "openUrl"]),
    value: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    label: TrimmedNonEmptyString,
    kind: Schema.Literal("runUpdate"),
    target: SourceControlToolUpdateTarget,
    operation: Schema.optional(SourceControlToolUpdateOperation),
  }),
]);
export type SourceControlToolVersionAdvisoryAction =
  typeof SourceControlToolVersionAdvisoryAction.Type;

export const SourceControlToolVersionAdvisory = Schema.Struct({
  status: SourceControlToolVersionAdvisoryStatus,
  severity: SourceControlToolVersionAdvisorySeverity,
  currentVersion: Schema.NullOr(TrimmedNonEmptyString),
  latestVersion: Schema.NullOr(TrimmedNonEmptyString),
  recommendedVersion: Schema.NullOr(TrimmedNonEmptyString),
  checkedAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(TrimmedNonEmptyString),
  notificationKey: Schema.NullOr(TrimmedNonEmptyString),
  actions: Schema.Array(SourceControlToolVersionAdvisoryAction),
});
export type SourceControlToolVersionAdvisory = typeof SourceControlToolVersionAdvisory.Type;

const SourceControlDiscoverySharedFields = {
  label: TrimmedNonEmptyString,
  executable: Schema.optional(TrimmedNonEmptyString),
  status: SourceControlDiscoveryStatus,
  version: Schema.Option(TrimmedNonEmptyString),
  installHint: TrimmedNonEmptyString,
  detail: Schema.Option(TrimmedNonEmptyString),
  versionAdvisory: Schema.optionalKey(SourceControlToolVersionAdvisory),
} as const;

export const VcsDiscoveryItem = Schema.Struct({
  kind: VcsDriverKind,
  implemented: Schema.Boolean,
  ...SourceControlDiscoverySharedFields,
});
export type VcsDiscoveryItem = typeof VcsDiscoveryItem.Type;

export const SourceControlProviderDiscoveryItem = Schema.Struct({
  kind: SourceControlProviderKind,
  ...SourceControlDiscoverySharedFields,
  auth: SourceControlProviderAuth,
});
export type SourceControlProviderDiscoveryItem = typeof SourceControlProviderDiscoveryItem.Type;

export const SourceControlDiscoveryResult = Schema.Struct({
  versionControlSystems: Schema.Array(VcsDiscoveryItem),
  sourceControlProviders: Schema.Array(SourceControlProviderDiscoveryItem),
});
export type SourceControlDiscoveryResult = typeof SourceControlDiscoveryResult.Type;

export const SourceControlToolUpdateInput = Schema.Struct({
  target: SourceControlToolUpdateTarget,
  operation: Schema.optional(SourceControlToolUpdateOperation),
});
export type SourceControlToolUpdateInput = typeof SourceControlToolUpdateInput.Type;

export const SourceControlToolUpdateResult = Schema.Struct({
  target: SourceControlToolUpdateTarget,
  operation: SourceControlToolUpdateOperation,
  status: Schema.Literals(["succeeded", "started", "unchanged"]),
  previousVersion: Schema.NullOr(TrimmedNonEmptyString),
  currentVersion: Schema.NullOr(TrimmedNonEmptyString),
  discovery: SourceControlDiscoveryResult,
});
export type SourceControlToolUpdateResult = typeof SourceControlToolUpdateResult.Type;

export class SourceControlToolUpdateError extends Schema.TaggedErrorClass<SourceControlToolUpdateError>()(
  "SourceControlToolUpdateError",
  {
    target: SourceControlToolUpdateTarget,
    reason: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class SourceControlProviderError extends Schema.TaggedErrorClass<SourceControlProviderError>()(
  "SourceControlProviderError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Source control provider ${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

export class SourceControlRepositoryError extends Schema.TaggedErrorClass<SourceControlRepositoryError>()(
  "SourceControlRepositoryError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Source control repository operation ${this.operation} failed for ${this.provider}: ${this.detail}`;
  }
}
