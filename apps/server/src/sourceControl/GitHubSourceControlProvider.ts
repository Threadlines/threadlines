import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  SourceControlProviderError,
  type ChangeRequest,
  type ChangeRequestState,
  type SourceControlRepositoryInfo,
} from "@t3tools/contracts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";

import * as GitHubCli from "./GitHubCli.ts";
import { findAuthenticatedGitHubAccount, parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";
import * as GitHubPullRequests from "./gitHubPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import * as SourceControlProviderDiscovery from "./SourceControlProviderDiscovery.ts";
const isSourceControlProviderError = Schema.is(SourceControlProviderError);

function providerError(
  operation: string,
  cause: GitHubCli.GitHubCliError,
): SourceControlProviderError {
  return new SourceControlProviderError({
    provider: "github",
    operation,
    detail: cause.detail,
    cause,
  });
}

function toChangeRequest(summary: GitHubCli.GitHubPullRequestSummary): ChangeRequest {
  return {
    provider: "github",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state ?? "open",
    updatedAt: Option.none(),
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  };
}

function toRepositoryInfo(
  summary: GitHubCli.GitHubRepositoryCloneUrls,
): SourceControlRepositoryInfo {
  return {
    provider: "github",
    nameWithOwner: summary.nameWithOwner,
    url: summary.url,
    sshUrl: summary.sshUrl,
  };
}

function repositoryFromContext(
  context: SourceControlProvider.SourceControlProviderContext | undefined,
): string | undefined {
  if (context?.provider.kind !== "github") {
    return undefined;
  }

  return parseGitHubRepositoryNameWithOwnerFromRemoteUrl(context.remoteUrl) ?? undefined;
}

function repositoryOptionFromContext(
  context: SourceControlProvider.SourceControlProviderContext | undefined,
): { readonly repository?: string } {
  const repository = repositoryFromContext(context);
  return repository !== undefined ? { repository } : {};
}

function repositoryFlagArgs(repository: string | undefined): ReadonlyArray<string> {
  const trimmed = repository?.trim() ?? "";
  return trimmed.length > 0 ? ["--repo", trimmed] : [];
}

function parseGitHubAuth(input: SourceControlProviderDiscovery.SourceControlAuthProbeInput) {
  const output = SourceControlProviderDiscovery.combinedAuthOutput(input);
  const authStatus = parseGitHubAuthStatus(input.stdout);
  const authenticatedAccount = findAuthenticatedGitHubAccount(authStatus.accounts);
  const host = authenticatedAccount?.host;

  if (authenticatedAccount) {
    return SourceControlProviderDiscovery.providerAuth({
      status: "authenticated",
      account: authenticatedAccount.account,
      host,
    });
  }

  const failedAccount = authStatus.accounts.find((entry) => entry.active) ?? authStatus.accounts[0];
  if (authStatus.parsed) {
    return SourceControlProviderDiscovery.providerAuth({
      status: "unauthenticated",
      host: failedAccount?.host,
      detail:
        failedAccount?.error ??
        "Run `gh auth login` to authenticate GitHub CLI with an active account.",
    });
  }

  if (input.exitCode !== 0) {
    return SourceControlProviderDiscovery.providerAuth({
      status: "unauthenticated",
      host,
      detail:
        SourceControlProviderDiscovery.firstSafeAuthLine(output) ??
        "Run `gh auth login` to authenticate GitHub CLI.",
    });
  }

  return SourceControlProviderDiscovery.providerAuth({
    status: "unknown",
    host,
    detail:
      SourceControlProviderDiscovery.firstSafeAuthLine(output) ??
      "GitHub CLI auth status could not be parsed.",
  });
}

export const discovery = {
  type: "cli",
  kind: "github",
  label: "GitHub",
  executable: "gh",
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json", "hosts"],
  parseAuth: parseGitHubAuth,
  installHint:
    "Install the GitHub command-line tool (`gh`) via https://cli.github.com/ or your package manager (for example `brew install gh`).",
} satisfies SourceControlProviderDiscovery.SourceControlCliDiscoverySpec;

export const make = Effect.fn("makeGitHubSourceControlProvider")(function* () {
  const github = yield* GitHubCli.GitHubCli;

  const listChangeRequests: SourceControlProvider.SourceControlProviderShape["listChangeRequests"] =
    (input) => {
      const repository = repositoryFromContext(input.context);
      if (input.state === "open") {
        return github
          .listOpenPullRequests({
            cwd: input.cwd,
            ...(repository !== undefined ? { repository } : {}),
            headSelector: input.headSelector,
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          })
          .pipe(
            Effect.map((items) => items.map(toChangeRequest)),
            Effect.mapError((error) => providerError("listChangeRequests", error)),
          );
      }

      const stateArg: ChangeRequestState | "all" = input.state;
      return github
        .execute({
          cwd: input.cwd,
          args: [
            "pr",
            "list",
            ...repositoryFlagArgs(repository),
            "--head",
            input.headSelector,
            "--state",
            stateArg,
            "--limit",
            String(input.limit ?? 20),
            "--json",
            "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
          ],
        })
        .pipe(
          Effect.flatMap((result) => {
            const raw = result.stdout.trim();
            if (raw.length === 0) {
              return Effect.succeed([]);
            }
            return Effect.sync(() => GitHubPullRequests.decodeGitHubPullRequestListJson(raw)).pipe(
              Effect.flatMap((decoded) =>
                Result.isSuccess(decoded)
                  ? Effect.succeed(
                      decoded.success.map((item) => ({
                        ...toChangeRequest(item),
                        updatedAt: item.updatedAt,
                      })),
                    )
                  : Effect.fail(
                      new SourceControlProviderError({
                        provider: "github",
                        operation: "listChangeRequests",
                        detail: "GitHub CLI returned invalid change request JSON.",
                        cause: decoded.failure,
                      }),
                    ),
              ),
            );
          }),
          Effect.mapError((error) =>
            isSourceControlProviderError(error)
              ? error
              : providerError("listChangeRequests", error),
          ),
        );
    };

  return SourceControlProvider.SourceControlProvider.of({
    kind: "github",
    listChangeRequests,
    getChangeRequest: (input) =>
      github
        .getPullRequest({
          cwd: input.cwd,
          ...repositoryOptionFromContext(input.context),
          reference: input.reference,
        })
        .pipe(
          Effect.map(toChangeRequest),
          Effect.mapError((error) => providerError("getChangeRequest", error)),
        ),
    createChangeRequest: (input) =>
      github
        .createPullRequest({
          cwd: input.cwd,
          ...repositoryOptionFromContext(input.context),
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(Effect.mapError((error) => providerError("createChangeRequest", error))),
    getRepositoryCloneUrls: (input) =>
      github
        .getRepositoryCloneUrls(input)
        .pipe(Effect.mapError((error) => providerError("getRepositoryCloneUrls", error))),
    listRepositories: (input) =>
      github.listRepositories(input).pipe(
        Effect.map((repositories) => repositories.map(toRepositoryInfo)),
        Effect.mapError((error) => providerError("listRepositories", error)),
      ),
    createRepository: (input) =>
      github
        .createRepository(input)
        .pipe(Effect.mapError((error) => providerError("createRepository", error))),
    getDefaultBranch: (input) =>
      github
        .getDefaultBranch({
          cwd: input.cwd,
          ...repositoryOptionFromContext(input.context),
        })
        .pipe(Effect.mapError((error) => providerError("getDefaultBranch", error))),
    checkoutChangeRequest: (input) =>
      github
        .checkoutPullRequest({
          cwd: input.cwd,
          ...repositoryOptionFromContext(input.context),
          reference: input.reference,
          ...(input.force !== undefined ? { force: input.force } : {}),
        })
        .pipe(Effect.mapError((error) => providerError("checkoutChangeRequest", error))),
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make());
