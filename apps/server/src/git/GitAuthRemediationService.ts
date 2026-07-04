import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  type GitApplyAuthRemediationInput,
  type GitApplyAuthRemediationResult,
  type GitAuthRemediationAction,
  type GitAuthRemediationPlan,
  type GitAuthRemediationPlanInput,
  type GitCommandError,
  GitManagerError,
} from "@threadlines/contracts";
import {
  buildSshRemoteUrl,
  type GitRemoteEndpoint,
  parseGitRemoteEndpoint,
} from "@threadlines/shared/git";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export interface GitAuthRemediationServiceShape {
  readonly plan: (
    input: GitAuthRemediationPlanInput,
  ) => Effect.Effect<GitAuthRemediationPlan, GitCommandError | GitManagerError>;
  readonly apply: (
    input: GitApplyAuthRemediationInput,
  ) => Effect.Effect<GitApplyAuthRemediationResult, GitCommandError | GitManagerError>;
}

export class GitAuthRemediationService extends Context.Service<
  GitAuthRemediationService,
  GitAuthRemediationServiceShape
>()("threadlines/git/GitAuthRemediationService") {}

const GIT_QUERY_TIMEOUT_MS = 10_000;
const GH_PROBE_TIMEOUT_MS = 5_000;
const SSH_PROBE_TIMEOUT_MS = 12_000;
const APPLY_TIMEOUT_MS = 20_000;
// Never let the ssh probe fall back to interactive prompts (passphrases,
// unknown host keys); a failure means "not usable non-interactively".
const SSH_BATCH_MODE_ENV = { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=5" };

interface RemediationProbe {
  readonly applicable: boolean;
  readonly reason: string | null;
}

interface RemoteTarget {
  readonly remoteName: string | null;
  readonly remoteUrl: string | null;
  readonly endpoint: GitRemoteEndpoint | null;
}

function ghSetupGitCommand(host: string): string {
  return `gh auth setup-git --hostname ${host}`;
}

function switchRemoteCommand(remoteName: string, sshUrl: string): string {
  return `git remote set-url ${remoteName} ${sshUrl}`;
}

export const make = Effect.fn("makeGitAuthRemediationService")(function* () {
  const git = yield* GitVcsDriver;
  const vcsProcess = yield* VcsProcess.VcsProcess;

  const gitStdoutOrNull = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation, cwd, args, allowNonZeroExit: true, timeoutMs: GIT_QUERY_TIMEOUT_MS })
      .pipe(
        Effect.map((result) => {
          if (result.exitCode !== 0) {
            return null;
          }
          const stdout = result.stdout.trim();
          return stdout.length > 0 ? stdout : null;
        }),
      );

  const resolveRemoteTarget = Effect.fn("GitAuthRemediationService.resolveRemoteTarget")(function* (
    cwd: string,
  ) {
    const branch = yield* gitStdoutOrNull("GitAuthRemediationService.currentBranch", cwd, [
      "symbolic-ref",
      "--short",
      "-q",
      "HEAD",
    ]);
    const upstreamRemote =
      branch === null
        ? null
        : yield* gitStdoutOrNull("GitAuthRemediationService.upstreamRemote", cwd, [
            "config",
            "--get",
            `branch.${branch}.remote`,
          ]);
    const remoteName =
      upstreamRemote ??
      (yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.catch(() => Effect.succeed(null))));
    const remoteUrl =
      remoteName === null
        ? null
        : yield* gitStdoutOrNull("GitAuthRemediationService.remoteUrl", cwd, [
            "remote",
            "get-url",
            remoteName,
          ]);
    return {
      remoteName: remoteUrl === null ? null : remoteName,
      remoteUrl,
      endpoint: remoteUrl === null ? null : parseGitRemoteEndpoint(remoteUrl),
    } satisfies RemoteTarget;
  });

  const probeGhCredentialHelper = (cwd: string, host: string) =>
    vcsProcess
      .run({
        operation: "GitAuthRemediationService.ghAuthStatus",
        command: "gh",
        args: ["auth", "status", "--hostname", host],
        cwd,
        allowNonZeroExit: true,
        timeoutMs: GH_PROBE_TIMEOUT_MS,
      })
      .pipe(
        Effect.map(
          (result): RemediationProbe =>
            result.exitCode === 0
              ? { applicable: true, reason: null }
              : {
                  applicable: false,
                  reason: `GitHub CLI is installed but not logged in to ${host}. Run "gh auth login" in a terminal first.`,
                },
        ),
        Effect.catch(() =>
          Effect.succeed<RemediationProbe>({
            applicable: false,
            reason: "GitHub CLI (gh) is not installed or did not respond.",
          }),
        ),
      );

  const probeSshAccess = (cwd: string, sshUrl: string, host: string) =>
    git
      .execute({
        operation: "GitAuthRemediationService.sshProbe",
        cwd,
        args: ["ls-remote", sshUrl, "HEAD"],
        env: SSH_BATCH_MODE_ENV,
        allowNonZeroExit: true,
        timeoutMs: SSH_PROBE_TIMEOUT_MS,
      })
      .pipe(
        Effect.map(
          (result): RemediationProbe =>
            result.exitCode === 0
              ? { applicable: true, reason: null }
              : {
                  applicable: false,
                  reason: `SSH access to ${host} is not set up on this machine (no usable key).`,
                },
        ),
        Effect.catch(() =>
          Effect.succeed<RemediationProbe>({
            applicable: false,
            reason: `SSH probe to ${host} timed out.`,
          }),
        ),
      );

  const plan: GitAuthRemediationServiceShape["plan"] = Effect.fn("GitAuthRemediationService.plan")(
    function* (input) {
      const target = yield* resolveRemoteTarget(input.cwd);
      const endpoint = target.endpoint;
      if (endpoint === null || target.remoteName === null) {
        return {
          remoteName: target.remoteName,
          remoteUrl: target.remoteUrl,
          host: null,
          scheme: null,
          actions: [],
        } satisfies GitAuthRemediationPlan;
      }

      const sshUrl = buildSshRemoteUrl(endpoint);
      const actions: GitAuthRemediationAction[] = [];

      if (endpoint.scheme === "https") {
        const [ghProbe, sshProbe] = yield* Effect.all(
          [
            probeGhCredentialHelper(input.cwd, endpoint.host),
            probeSshAccess(input.cwd, sshUrl, endpoint.host),
          ],
          { concurrency: 2 },
        );
        actions.push(
          {
            id: "gh_setup_git",
            title: "Use your GitHub CLI login",
            description: `You are already signed into ${endpoint.host} with the GitHub CLI; this tells git to use that login for HTTPS. One-time fix for every repository on this machine — this repository is not modified.`,
            command: ghSetupGitCommand(endpoint.host),
            applicable: ghProbe.applicable,
            inapplicableReason: ghProbe.reason,
            recommended: ghProbe.applicable,
          },
          {
            id: "switch_remote_to_ssh",
            title: "Switch this repository to SSH",
            description: `Rewrites the "${target.remoteName}" remote address to ${sshUrl} so git authenticates with your SSH key instead. Only affects this repository; other HTTPS repositories would still need fixing.`,
            command: switchRemoteCommand(target.remoteName, sshUrl),
            applicable: sshProbe.applicable,
            inapplicableReason: sshProbe.reason,
            recommended: !ghProbe.applicable && sshProbe.applicable,
          },
        );
      } else {
        actions.push(
          {
            id: "gh_setup_git",
            title: "Use your GitHub CLI login",
            description: `Tells git to authenticate HTTPS remotes on ${endpoint.host} with your GitHub CLI login.`,
            command: ghSetupGitCommand(endpoint.host),
            applicable: false,
            inapplicableReason:
              "This remote already uses SSH; GitHub CLI credentials only apply to HTTPS remotes.",
            recommended: false,
          },
          {
            id: "switch_remote_to_ssh",
            title: "Switch this repository to SSH",
            description: `Rewrites the "${target.remoteName}" remote address to ${sshUrl}.`,
            command: switchRemoteCommand(target.remoteName, sshUrl),
            applicable: false,
            inapplicableReason: "This remote already uses SSH.",
            recommended: false,
          },
        );
      }

      return {
        remoteName: target.remoteName,
        remoteUrl: target.remoteUrl,
        host: endpoint.host,
        scheme: endpoint.scheme,
        actions,
      } satisfies GitAuthRemediationPlan;
    },
  );

  const applyGhSetupGit = Effect.fn("GitAuthRemediationService.applyGhSetupGit")(function* (
    cwd: string,
    host: string,
  ) {
    const result = yield* vcsProcess
      .run({
        operation: "GitAuthRemediationService.ghSetupGit",
        command: "gh",
        args: ["auth", "setup-git", "--hostname", host],
        cwd,
        allowNonZeroExit: true,
        timeoutMs: APPLY_TIMEOUT_MS,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new GitManagerError({
              operation: "GitAuthRemediationService.ghSetupGit",
              detail: `Could not run the GitHub CLI: ${error.message}`,
              cause: error,
            }),
        ),
      );
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      return yield* new GitManagerError({
        operation: "GitAuthRemediationService.ghSetupGit",
        detail:
          stderr.length > 0
            ? `gh auth setup-git failed: ${stderr}`
            : `gh auth setup-git exited with code ${result.exitCode}.`,
      });
    }
    return `Git now authenticates ${host} HTTPS remotes with your GitHub CLI login.`;
  });

  const applySwitchRemoteToSsh = Effect.fn("GitAuthRemediationService.applySwitchRemoteToSsh")(
    function* (cwd: string, target: RemoteTarget) {
      const endpoint = target.endpoint;
      if (endpoint === null || target.remoteName === null) {
        return yield* new GitManagerError({
          operation: "GitAuthRemediationService.applySwitchRemoteToSsh",
          detail: "No supported remote URL to rewrite.",
        });
      }
      if (endpoint.scheme !== "https") {
        return yield* new GitManagerError({
          operation: "GitAuthRemediationService.applySwitchRemoteToSsh",
          detail: `Remote "${target.remoteName}" already uses SSH.`,
        });
      }
      const sshUrl = buildSshRemoteUrl(endpoint);
      const probe = yield* probeSshAccess(cwd, sshUrl, endpoint.host);
      if (!probe.applicable) {
        return yield* new GitManagerError({
          operation: "GitAuthRemediationService.applySwitchRemoteToSsh",
          detail: probe.reason ?? `SSH access to ${endpoint.host} is not set up on this machine.`,
        });
      }
      yield* git.execute({
        operation: "GitAuthRemediationService.setRemoteUrl",
        cwd,
        args: ["remote", "set-url", target.remoteName, sshUrl],
        timeoutMs: GIT_QUERY_TIMEOUT_MS,
      });
      return `Remote "${target.remoteName}" now uses ${sshUrl}.`;
    },
  );

  const apply: GitAuthRemediationServiceShape["apply"] = Effect.fn(
    "GitAuthRemediationService.apply",
  )(function* (input) {
    const target = yield* resolveRemoteTarget(input.cwd);
    switch (input.actionId) {
      case "gh_setup_git": {
        if (target.endpoint === null) {
          return yield* new GitManagerError({
            operation: "GitAuthRemediationService.apply",
            detail: "No supported remote URL to remediate.",
          });
        }
        const detail = yield* applyGhSetupGit(input.cwd, target.endpoint.host);
        return { actionId: input.actionId, detail } satisfies GitApplyAuthRemediationResult;
      }
      case "switch_remote_to_ssh": {
        const detail = yield* applySwitchRemoteToSsh(input.cwd, target);
        return { actionId: input.actionId, detail } satisfies GitApplyAuthRemediationResult;
      }
    }
  });

  return GitAuthRemediationService.of({ plan, apply });
});

export const layer = Layer.effect(GitAuthRemediationService, make());
