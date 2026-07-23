import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  SourceControlRepositoryError,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlListRepositoriesInput,
  type SourceControlListRepositoriesResult,
  type SourceControlCloneProtocol,
  type SourceControlProviderKind,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryInfo,
  type SourceControlRepositoryLookupInput,
} from "@threadlines/contracts";
import { deriveRepositoryDirectoryName } from "@threadlines/shared/git";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);

export interface SourceControlRepositoryServiceShape {
  readonly lookupRepository: (
    input: SourceControlRepositoryLookupInput,
  ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
  readonly listRepositories: (
    input: SourceControlListRepositoriesInput,
  ) => Effect.Effect<SourceControlListRepositoriesResult, SourceControlRepositoryError>;
  readonly cloneRepository: (
    input: SourceControlCloneRepositoryInput,
  ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
  readonly publishRepository: (
    input: SourceControlPublishRepositoryInput,
  ) => Effect.Effect<SourceControlPublishRepositoryResult, SourceControlRepositoryError>;
}

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  SourceControlRepositoryServiceShape
>()("threadlines/source-control/SourceControlRepositoryService") {}

function detailFromUnknown(cause: unknown): string {
  if (typeof cause === "object" && cause !== null) {
    if ("detail" in cause && typeof cause.detail === "string" && cause.detail.length > 0) {
      return cause.detail;
    }
    if ("message" in cause && typeof cause.message === "string" && cause.message.length > 0) {
      return cause.message;
    }
  }

  return "An unexpected source control error occurred.";
}

function repositoryError(input: {
  readonly operation: string;
  readonly provider: SourceControlProviderKind;
  readonly detail: string;
  readonly cause?: unknown;
}): SourceControlRepositoryError {
  return new SourceControlRepositoryError({
    provider: input.provider,
    operation: input.operation,
    detail: input.detail,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    isSourceControlRepositoryError(cause)
      ? cause
      : repositoryError({
          operation,
          provider,
          detail: detailFromUnknown(cause),
          cause,
        }),
  );
}

function toRepositoryInfo(
  provider: SourceControlProviderKind,
  urls: SourceControlRepositoryCloneUrls,
): SourceControlRepositoryInfo {
  return {
    provider,
    nameWithOwner: urls.nameWithOwner,
    url: urls.url,
    sshUrl: urls.sshUrl,
  };
}

function repositoryBaseUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function selectRemoteUrl(
  urls: SourceControlRepositoryCloneUrls,
  protocol: SourceControlCloneProtocol | undefined,
): string {
  switch (protocol ?? "auto") {
    case "https":
      return urls.url;
    case "ssh":
    case "auto":
      return urls.sshUrl;
  }
}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), input.slice(2));
  }
  return input;
}

export const make = Effect.fn("makeSourceControlRepositoryService")(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const ensureConcreteProvider = (input: {
    readonly operation: string;
    readonly provider: SourceControlProviderKind;
  }) => {
    if (input.provider !== "unknown") {
      return Effect.succeed(input.provider);
    }

    return Effect.fail(
      repositoryError({
        operation: input.operation,
        provider: input.provider,
        detail: "Choose a source control provider before continuing.",
      }),
    );
  };

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(function* (
    input: SourceControlRepositoryLookupInput,
  ) {
    const providerKind = yield* ensureConcreteProvider({
      operation: "lookupRepository",
      provider: input.provider,
    });
    const provider = yield* providers.get(providerKind);
    const urls = yield* provider.getRepositoryCloneUrls({
      cwd: input.cwd ?? config.cwd,
      repository: input.repository.trim(),
    });
    return toRepositoryInfo(providerKind, urls);
  });

  const listRepositories = Effect.fn("SourceControlRepositoryService.listRepositories")(function* (
    input: SourceControlListRepositoriesInput,
  ) {
    const providerKind = yield* ensureConcreteProvider({
      operation: "listRepositories",
      provider: input.provider,
    });
    const provider = yield* providers.get(providerKind);
    const repositories = yield* provider.listRepositories({
      cwd: input.cwd ?? config.cwd,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    return { repositories };
  });

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* repositoryError({
          operation: "cloneRepository",
          provider: "unknown",
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePath(trimmed, path));
    },
  );

  const prepareConcreteDestination = Effect.fn(
    "SourceControlRepositoryService.prepareConcreteDestination",
  )(function* (normalizedDestination: string, provider: SourceControlProviderKind) {
    if (yield* fileSystem.exists(normalizedDestination).pipe(Effect.orElseSucceed(() => false))) {
      const entries = yield* fileSystem
        .readDirectory(normalizedDestination, { recursive: false })
        .pipe(
          Effect.mapError((cause) =>
            repositoryError({
              operation: "cloneRepository",
              provider,
              detail: "Destination path already exists and is not a directory.",
              cause,
            }),
          ),
        );
      if (entries.length > 0) {
        return yield* repositoryError({
          operation: "cloneRepository",
          provider,
          detail: "Destination path already exists and is not empty.",
        });
      }
    } else {
      yield* fileSystem.makeDirectory(path.dirname(normalizedDestination), { recursive: true });
    }

    return {
      destinationPath: normalizedDestination,
      parentPath: path.dirname(normalizedDestination),
      directoryName: path.basename(normalizedDestination),
    };
  });

  const prepareDestination = Effect.fn("SourceControlRepositoryService.prepareDestination")(
    function* (input: {
      readonly destinationPath: string;
      readonly provider: SourceControlProviderKind;
      readonly fallbackDirectoryName: string | null;
    }) {
      const normalizedDestination = yield* normalizeDestinationPath(input.destinationPath);
      if (
        input.fallbackDirectoryName &&
        (yield* fileSystem.exists(normalizedDestination).pipe(Effect.orElseSucceed(() => false)))
      ) {
        const entries = yield* fileSystem
          .readDirectory(normalizedDestination, { recursive: false })
          .pipe(
            Effect.mapError((cause) =>
              repositoryError({
                operation: "cloneRepository",
                provider: input.provider,
                detail: "Destination path already exists and is not a directory.",
                cause,
              }),
            ),
          );
        if (
          entries.length > 0 &&
          path.basename(normalizedDestination).toLowerCase() !==
            input.fallbackDirectoryName.toLowerCase()
        ) {
          return yield* prepareConcreteDestination(
            path.join(normalizedDestination, input.fallbackDirectoryName),
            input.provider,
          );
        }
      }

      return yield* prepareConcreteDestination(normalizedDestination, input.provider);
    },
  );

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
  ) {
    let provider: SourceControlProviderKind = input.provider ?? "unknown";
    const preparedDestination = yield* prepareDestination({
      destinationPath: input.destinationPath,
      provider,
      fallbackDirectoryName:
        deriveRepositoryDirectoryName(input.repository) ??
        deriveRepositoryDirectoryName(input.remoteUrl),
    });
    let repository: SourceControlRepositoryInfo | null = null;
    let remoteUrl = input.remoteUrl?.trim() ?? null;

    if (input.provider && input.repository) {
      repository = yield* lookupRepository({
        provider: input.provider,
        repository: input.repository,
        cwd: preparedDestination.parentPath,
      });
      remoteUrl = selectRemoteUrl(repository, input.protocol);
      provider = input.provider;
    }

    if (!remoteUrl) {
      return yield* repositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a repository path or clone URL before cloning.",
      });
    }

    yield* git.execute({
      operation: "SourceControlRepositoryService.cloneRepository",
      cwd: preparedDestination.parentPath,
      args: ["clone", remoteUrl, preparedDestination.directoryName],
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024,
    });

    return {
      cwd: preparedDestination.destinationPath,
      remoteUrl,
      repository,
    };
  });

  const publishRepository = Effect.fn("SourceControlRepositoryService.publishRepository")(
    function* (input: SourceControlPublishRepositoryInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "publishRepository",
        provider: input.provider,
      });
      const provider = yield* providers.get(providerKind);
      const localDetails = yield* git
        .statusDetails(input.cwd)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const hasCommits = yield* git
        .execute({
          operation: "SourceControlRepositoryService.publishRepository.headCheck",
          cwd: input.cwd,
          args: ["rev-parse", "--verify", "HEAD"],
        })
        .pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        );
      const urls = yield* provider.createRepository({
        cwd: input.cwd,
        repository: input.repository.trim(),
        visibility: input.visibility,
        ...(input.description ? { description: input.description.trim() } : {}),
        ...(input.team ? { team: input.team.trim() } : {}),
      });
      const remoteUrl = selectRemoteUrl(urls, input.protocol);
      const remoteName = yield* git.ensureRemote({
        cwd: input.cwd,
        preferredName: input.remoteName?.trim() || "origin",
        url: remoteUrl,
      });

      const providerDefaultBranch =
        urls.defaultBranch ??
        (yield* provider
          .getDefaultBranch({
            cwd: input.cwd,
            context: {
              provider: {
                kind: providerKind,
                name: providerKind,
                baseUrl: repositoryBaseUrl(urls.url),
              },
              remoteName,
              remoteUrl,
            },
          })
          .pipe(Effect.catch(() => Effect.succeed(null)))) ??
        "main";

      let publishBranch = localDetails?.branch ?? providerDefaultBranch;
      if (localDetails?.isDefaultBranch === true && publishBranch !== providerDefaultBranch) {
        const renamed = yield* git.renameBranch({
          cwd: input.cwd,
          oldBranch: publishBranch,
          newBranch: providerDefaultBranch,
        });
        publishBranch = renamed.branch;
      }

      // An empty local repo (no commits) would make `git push HEAD:...` fail
      // with an opaque "src refspec HEAD does not match any". Treat this as a
      // partial success: the remote was created and wired up, but there is
      // nothing to push yet. The unborn branch is still aligned with the
      // provider's default so the first commit publishes to the expected ref.
      if (!hasCommits) {
        return {
          repository: toRepositoryInfo(providerKind, urls),
          remoteName,
          remoteUrl,
          branch: publishBranch,
          status: "remote_added" as const,
        };
      }

      const pushResult = yield* git.pushCurrentBranch(input.cwd, null, { remoteName });

      return {
        repository: toRepositoryInfo(providerKind, urls),
        remoteName,
        remoteUrl,
        branch: pushResult.branch,
        ...(pushResult.upstreamBranch ? { upstreamBranch: pushResult.upstreamBranch } : {}),
        status: "pushed" as const,
      };
    },
  );

  return SourceControlRepositoryService.of({
    lookupRepository: (input) =>
      lookupRepository(input).pipe(mapRepositoryError("lookupRepository", input.provider)),
    listRepositories: (input) =>
      listRepositories(input).pipe(mapRepositoryError("listRepositories", input.provider)),
    cloneRepository: (input) =>
      cloneRepository(input).pipe(
        mapRepositoryError("cloneRepository", input.provider ?? "unknown"),
      ),
    publishRepository: (input) =>
      publishRepository(input).pipe(mapRepositoryError("publishRepository", input.provider)),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make());
