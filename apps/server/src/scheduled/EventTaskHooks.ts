/**
 * Event tasks' addresses, signing secrets and GitHub webhooks
 * (docs/design/event-tasks.md: "Public address", "Directly, without the
 * relay", `webhook_secrets`, "GitHub one-click"). Made once by
 * ScheduledTasks, which calls it when a task becomes, stays or stops being
 * an event task.
 *
 * - An address is a relay hook (minted through RelayHooks; null while the
 *   relay can't be reached, minted later) plus a local token for this
 *   computer's own port. Every change to the hooks or their kept headers
 *   sends RelayHooks the whole wanted list.
 * - A new relay identity (`host-changed`) re-mints every task's hook and
 *   marks its address changed.
 * - Secrets come in generations: a new one starts a generation; the older
 *   ones retire once the sender has the new one (at once for a sender set up
 *   by hand, once GitHub took it for one Threadlines set up). An event
 *   verifies against every generation not retired more than 24 hours before
 *   it arrived.
 * - A webhook Threadlines added on GitHub is kept in step with the task: its
 *   address, events and secret are sent again (one PATCH, whole config)
 *   whenever they differ from what GitHub was last given.
 */
import * as Crypto from "node:crypto";

import type {
  ProjectId,
  ScheduledTaskGitHubContext,
  ScheduledTaskId,
  ScheduledTaskWebhookAddress,
  ScheduledTaskWebhookCadence,
} from "@threadlines/contracts";
import { compileGitHubTrigger, webhookKeptHeaders } from "@threadlines/shared/webhookTasks";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { RelayHooks } from "../relay/RelayHooks.ts";
import { GitHubCli, type GitHubCliError } from "../sourceControl/GitHubCli.ts";
import {
  findAuthenticatedGitHubAccount,
  parseGitHubAuthStatus,
} from "../sourceControl/gitHubAuthStatus.ts";
import { formatHostForUrl, isWildcardHost } from "../startupAccess.ts";
import { ScheduledTaskRepository } from "./ScheduledTaskRepository.ts";
import {
  NO_GITHUB_CONNECTION,
  type TaskWebhookRow,
  type WebhookSecretRow,
  WebhookTaskRepository,
} from "./WebhookTaskRepository.ts";

/** A retired secret still verifies events that arrived up to this long before it retired. */
export const WEBHOOK_SECRET_GRACE_MS = 24 * 60 * 60_000;
/** Where events reach a task on this computer's own port. */
export const LOCAL_HOOK_ROUTE_PREFIX = "/api/hooks";

const GITHUB_TIMEOUT_MS = 30_000;

/** Why an event-task change couldn't be made, in one plain sentence. */
export class EventTaskHookRefusal extends Data.TaggedError("EventTaskHookRefusal")<{
  readonly detail: string;
}> {}

const refuse = (detail: string) => Effect.fail(new EventTaskHookRefusal({ detail }));

/** 32 random bytes, base64url: a local token or a generated signing secret. */
export const randomToken = () => Crypto.randomBytes(32).toString("base64url");
const randomSecret = () => Crypto.randomBytes(32).toString("hex");

const secretName = (taskId: ScheduledTaskId, generation: number) =>
  `webhook-secret-${taskId}-${generation}`;

const sameList = (left: ReadonlyArray<string> | null, right: ReadonlyArray<string>) =>
  left !== null &&
  left.length === right.length &&
  [...left].toSorted().every((entry, index) => entry === [...right].toSorted()[index]);

/** "owner/name" from a GitHub remote's URL (https, ssh or scp form), its case kept. */
export const githubRepositoryOf = (remoteUrl: string): string | null => {
  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/|git:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
      remoteUrl.trim(),
    );
  return match?.[1] ?? null;
};

/**
 * A GitHub CLI failure in plain words, for the repository `repository`, when
 * adding a webhook there or changing one.
 */
const githubProblem = (
  error: GitHubCliError,
  repository: string,
  action: "add" | "change" = "add",
): string => {
  const detail = error.detail;
  if (/not available on PATH/i.test(detail)) {
    return "GitHub CLI (gh) isn't installed on this computer.";
  }
  if (/not authenticated/i.test(detail)) {
    return "GitHub CLI isn't signed in on this computer.";
  }
  if (/HTTP 40[34]/.test(detail)) {
    return action === "add"
      ? `Your GitHub account can't add webhooks to ${repository}. Ask an admin, or add it by hand.`
      : `Your GitHub account can't change webhooks on ${repository}.`;
  }
  if (/HTTP 422/.test(detail) && /already exists/i.test(detail)) {
    return `${repository} already has a webhook with this address.`;
  }
  const line = detail
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !entry.startsWith("GitHub") && !entry.endsWith("Error"));
  return line ? `GitHub didn't take it: ${line}` : "GitHub couldn't be reached. Try again.";
};

const removedOnGitHub = (repository: string) =>
  `The webhook on ${repository} was removed on GitHub. Add it again.`;

/** Why a webhook couldn't be removed from `repository`, in plain words. */
const githubRemovalProblem = (error: GitHubCliError, repository: string): string =>
  /HTTP 403/.test(error.detail)
    ? `Your GitHub account can't remove webhooks from ${repository}. Remove it in the repository's settings.`
    : githubProblem(error, repository);

const isGone = (error: GitHubCliError) => /HTTP 404/.test(error.detail);

/** How often a failed GitHub update is tried again, and a task's webhook looked at. */
export const GITHUB_RECHECK_MS = 5 * 60_000;

/**
 * What GitHub says about a webhook (`gh api repos/{o}/{r}/hooks/{id}`), as a
 * problem in plain words; null when it is on and its last delivery (if any)
 * went through.
 */
export const githubHookHealth = (stdout: string, repository: string): string | null => {
  let hook: unknown;
  try {
    hook = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof hook !== "object" || hook === null) return null;
  if ("active" in hook && hook.active === false) {
    return `The webhook on ${repository} is turned off on GitHub. Turn it on in the repository's webhook settings.`;
  }
  const last = "last_response" in hook ? hook.last_response : null;
  if (typeof last !== "object" || last === null || !("code" in last)) return null;
  const code = last.code;
  if (typeof code !== "number" || (code >= 200 && code < 300)) return null;
  const message =
    "message" in last && typeof last.message === "string" && last.message.trim().length > 0
      ? last.message.trim()
      : "no answer";
  return `GitHub's last delivery to this task failed: ${message} (${code}).`;
};

/**
 * `onChange` tells clients the tasks changed: addresses and connections also
 * change in the background (a mint once the relay answers, a new relay
 * identity, GitHub catching up).
 */
export const makeEventTaskHooks = (onChange: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const relay = yield* RelayHooks;
    const secretStore = yield* ServerSecretStore;
    const github = yield* GitHubCli;
    const webhooks = yield* WebhookTaskRepository;
    const tasks = yield* ScheduledTaskRepository;
    const config = yield* ServerConfig;
    const identities = yield* RepositoryIdentityResolver;
    const snapshots = yield* ProjectionSnapshotQuery;

    /** One hook change at a time, so the wanted list sent is never an older one. */
    const hookLock = yield* Semaphore.make(1);
    /** Why the last update of a task's GitHub webhook failed, until one works. */
    const updateProblems = new Map<ScheduledTaskId, string>();
    /** What the last look at a task's GitHub webhook found wrong, until one finds it well. */
    const healthProblems = new Map<ScheduledTaskId, string>();
    const lastHealthChecks = new Map<ScheduledTaskId, number>();
    let lastUpdateRetry = 0;

    /** Records (or, with null, clears) a task's problem; clients hear when it changed. */
    const setProblem = (
      problems: Map<ScheduledTaskId, string>,
      taskId: ScheduledTaskId,
      problem: string | null,
    ) =>
      Effect.suspend(() => {
        if ((problems.get(taskId) ?? null) === problem) return Effect.void;
        if (problem === null) problems.delete(taskId);
        else problems.set(taskId, problem);
        return onChange;
      });

    /** The task's GitHub connection ended: what was wrong with it no longer applies. */
    const forgetProblems = (taskId: ScheduledTaskId) =>
      Effect.all([
        setProblem(updateProblems, taskId, null),
        setProblem(healthProblems, taskId, null),
      ]).pipe(Effect.asVoid);

    /** One GitHub update at a time. */
    const githubLock = yield* Semaphore.make(1);

    const nowIso = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

    const localOrigin = () => {
      const host =
        config.host && !isWildcardHost(config.host) ? formatHostForUrl(config.host) : "127.0.0.1";
      return `http://${host}:${config.port}`;
    };

    /** The task's address on this computer's own port. */
    const localUrl = (row: Pick<TaskWebhookRow, "taskId" | "localToken">) =>
      `${localOrigin()}${LOCAL_HOOK_ROUTE_PREFIX}/${row.taskId}/${row.localToken}`;

    const readProjectRoot = (projectId: ProjectId) =>
      snapshots.getProjectShellById(projectId).pipe(
        Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot ?? null),
        Effect.orElseSucceed(() => null),
      );

    /** A new hook on the relay, or null while it can't be reached. */
    const mint = (keptHeaders: ReadonlyArray<string>) =>
      relay.mint({ keptHeaders }).pipe(
        Effect.map(Option.some),
        Effect.catch((error) =>
          Effect.logInfo("event tasks: the relay couldn't give an address yet", {
            detail: error.detail,
          }).pipe(Effect.as(Option.none())),
        ),
      );

    /** Sends the relay the whole wanted list: every event task's current hook. */
    const syncActiveLocked = Effect.gen(function* () {
      const rows = yield* webhooks.listTaskWebhooks;
      yield* relay.setActive(
        rows.flatMap((row) =>
          row.hookId === null ? [] : [{ hookId: row.hookId, keptHeaders: row.keptHeaders }],
        ),
      );
    });

    const syncActive = hookLock
      .withPermits(1)(syncActiveLocked)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("event tasks: couldn't update the relay's hooks", {
            cause: Cause.pretty(cause),
          }),
        ),
      );

    /**
     * A task's first address, not saved: a local token, and a relay hook when
     * the relay answers. Saved with `storeAddress` in the task's own save.
     */
    const newAddress = (task: {
      readonly id: ScheduledTaskId;
      readonly cadence: ScheduledTaskWebhookCadence;
      readonly prompt: string;
    }) =>
      Effect.gen(function* () {
        const keptHeaders = webhookKeptHeaders(task.cadence, task.prompt);
        const minted = yield* mint(keptHeaders);
        const now = yield* nowIso;
        return {
          taskId: task.id,
          hookId: Option.isSome(minted) ? minted.value.hookId : null,
          relayUrl: Option.isSome(minted) ? minted.value.url : null,
          mintedHostId: Option.isSome(minted) ? minted.value.hostId : null,
          localToken: randomToken(),
          keptHeaders,
          githubHookId: null,
          githubRepository: null,
          githubHookUrl: null,
          githubEvents: null,
          githubSecretGeneration: null,
          addressChanged: false,
          lastEventAt: null,
          createdAt: now,
          updatedAt: now,
        } satisfies TaskWebhookRow;
      });

    /** Writes an address `newAddress` made; inside the task's save. */
    const storeAddress = (row: TaskWebhookRow) =>
      Effect.gen(function* () {
        yield* webhooks.insertTaskWebhook(row);
        if (row.hookId !== null) {
          yield* webhooks.insertHook({
            hookId: row.hookId,
            taskId: row.taskId,
            now: row.createdAt,
          });
        }
      });

    /** The headers an edited task's hook keeps; inside the task's save. True when they changed. */
    const updateKeptHeaders = (
      taskId: ScheduledTaskId,
      cadence: ScheduledTaskWebhookCadence,
      prompt: string,
    ) =>
      Effect.gen(function* () {
        const found = yield* webhooks.getTaskWebhook(taskId);
        if (Option.isNone(found)) return false;
        const keptHeaders = webhookKeptHeaders(cadence, prompt);
        if (sameList(found.value.keptHeaders, keptHeaders)) return false;
        return yield* webhooks.updateTaskWebhook({
          taskId,
          set: { keptHeaders },
          now: yield* nowIso,
        });
      });

    // ---------------------------------------------------------------------------
    // Secrets
    // ---------------------------------------------------------------------------

    const readSecret = (taskId: ScheduledTaskId, generation: number) =>
      secretStore.get(secretName(taskId, generation)).pipe(
        Effect.map((bytes) => (bytes === null ? null : new TextDecoder().decode(bytes))),
        Effect.orElseSucceed(() => null),
      );

    /** The newest generation not retired, if any. */
    const currentSecret = (taskId: ScheduledTaskId) =>
      Effect.gen(function* () {
        const generations = yield* webhooks.listSecrets(taskId);
        const live = generations.findLast((entry) => entry.retiredAt === null);
        if (live === undefined) return null;
        const secret = yield* readSecret(taskId, live.generation);
        return secret === null ? null : { generation: live.generation, secret };
      });

    /** Every secret an event that arrived at `receivedAt` may be signed with. */
    const secretsFor = (taskId: ScheduledTaskId, receivedAt: string) =>
      Effect.gen(function* () {
        const cutoff = Date.parse(receivedAt) - WEBHOOK_SECRET_GRACE_MS;
        const generations = yield* webhooks.listSecrets(taskId);
        const secrets: Array<string> = [];
        for (const entry of generations.toReversed()) {
          if (entry.retiredAt !== null && Date.parse(entry.retiredAt) <= cutoff) continue;
          const secret = yield* readSecret(taskId, entry.generation);
          if (secret !== null) secrets.push(secret);
        }
        return secrets;
      });

    /** Stores a new generation; returns its number. */
    const addSecret = (taskId: ScheduledTaskId, secret: string) =>
      Effect.gen(function* () {
        const generation = yield* webhooks.insertSecret({ taskId, now: yield* nowIso });
        yield* secretStore.set(secretName(taskId, generation), new TextEncoder().encode(secret));
        return generation;
      });

    /** A GitHub task's first secret, made when it has none. */
    const ensureSecret = (taskId: ScheduledTaskId) =>
      Effect.gen(function* () {
        if ((yield* currentSecret(taskId)) !== null) return;
        yield* addSecret(taskId, randomSecret());
      });

    /** Removes stored secrets of generations that were forgotten. */
    const dropSecrets = (rows: ReadonlyArray<WebhookSecretRow>) =>
      Effect.forEach(
        rows,
        (row) => secretStore.remove(secretName(row.taskId, row.generation)).pipe(Effect.ignore),
        { discard: true },
      );

    // ---------------------------------------------------------------------------
    // GitHub
    // ---------------------------------------------------------------------------

    const gh = (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly stdin?: string;
    }) =>
      github.execute({
        cwd: input.cwd,
        args: input.args,
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        timeoutMs: GITHUB_TIMEOUT_MS,
      });

    /** Who `gh` is signed in as on github.com; null when it isn't (or isn't installed). */
    const githubLogin = (cwd: string) =>
      gh({ cwd, args: ["auth", "status", "--json", "hosts"] }).pipe(
        Effect.map((output) => {
          const status = parseGitHubAuthStatus(output.stdout);
          return (
            findAuthenticatedGitHubAccount(
              status.accounts.filter((entry) => entry.host === "github.com"),
            )?.account ?? null
          );
        }),
        Effect.orElseSucceed(() => null),
      );

    const gitHubContext = (projectId: ProjectId) =>
      Effect.gen(function* () {
        const root = yield* readProjectRoot(projectId);
        if (root === null) return yield* refuse("That project isn't on this computer.");
        const identity = yield* identities.resolve(root);
        const remoteUrl = identity?.locator.remoteUrl ?? null;
        const repository = remoteUrl === null ? null : githubRepositoryOf(remoteUrl);
        const login = yield* githubLogin(root);
        return {
          repository,
          login,
          canConnect: repository !== null && login !== null,
        } satisfies ScheduledTaskGitHubContext;
      });

    /** The webhook's settings as GitHub takes them: the whole config, secret included. */
    const hookBody = (input: {
      readonly url: string;
      readonly events: ReadonlyArray<string>;
      readonly secret: string;
    }) =>
      JSON.stringify({
        name: "web",
        active: true,
        events: input.events,
        config: { url: input.url, content_type: "json", secret: input.secret, insecure_ssl: "0" },
      });

    const githubCwd = (taskId: ScheduledTaskId) =>
      Effect.gen(function* () {
        const task = yield* tasks.getTask(taskId).pipe(Effect.orElseSucceed(() => Option.none()));
        const root = Option.isSome(task) ? yield* readProjectRoot(task.value.projectId) : null;
        return root ?? process.cwd();
      });

    /** The GitHub trigger of an event task, as stored now. */
    const githubTrigger = (taskId: ScheduledTaskId) =>
      tasks.getTask(taskId).pipe(
        Effect.map((found) => {
          if (Option.isNone(found)) return null;
          const cadence = found.value.cadence;
          return cadence.kind === "webhook" && cadence.source === "github" && cadence.github
            ? cadence.github
            : null;
        }),
        Effect.orElseSucceed(() => null),
      );

    /**
     * Forgets the task's GitHub connection (the webhook is gone, removed, or
     * waits for removal elsewhere); only while it is still that webhook.
     */
    const clearGitHub = (taskId: ScheduledTaskId, githubHookId: string) =>
      Effect.gen(function* () {
        yield* webhooks.updateTaskWebhook({
          taskId,
          set: NO_GITHUB_CONNECTION,
          where: { githubHookId },
          now: yield* nowIso,
        });
        yield* onChange;
      });

    /**
     * Removes one webhook from GitHub. One already gone counts as removed. One
     * that can't be removed is recorded with why, and tried again at reconcile
     * and before the next GitHub action. Call holding the GitHub lock.
     */
    const removeHookLocked = (input: {
      readonly taskId: ScheduledTaskId;
      readonly repository: string;
      readonly hookId: string;
    }) =>
      Effect.gen(function* () {
        const removed = yield* gh({
          cwd: process.cwd(),
          args: ["api", "-X", "DELETE", `repos/${input.repository}/hooks/${input.hookId}`],
        }).pipe(Effect.result);
        const now = yield* nowIso;
        if (removed._tag === "Success" || isGone(removed.failure)) {
          yield* webhooks.deleteGitHubRemoval({
            repository: input.repository,
            hookId: input.hookId,
          });
          return true;
        }
        const reason = githubRemovalProblem(removed.failure, input.repository);
        yield* Effect.logWarning("event tasks: couldn't remove a GitHub webhook", {
          taskId: input.taskId,
          detail: reason,
        });
        yield* webhooks.putGitHubRemoval({ ...input, reason, now });
        return false;
      });

    /** Tries again to remove the webhooks that couldn't be removed. Call holding the GitHub lock. */
    const retryRemovalsLocked = Effect.gen(function* () {
      const pending = yield* webhooks.listGitHubRemovals;
      let removedAny = false;
      for (const removal of pending) {
        removedAny = (yield* removeHookLocked(removal)) || removedAny;
      }
      if (removedAny) yield* onChange;
    });

    /** Runs one GitHub action, after another try at the webhooks waiting for removal. */
    const withGitHub = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      githubLock.withPermits(1)(
        Effect.gen(function* () {
          yield* retryRemovalsLocked.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("event tasks: couldn't retry removing GitHub webhooks", {
                cause: Cause.pretty(cause),
              }),
            ),
          );
          return yield* effect;
        }),
      );

    /**
     * Sends GitHub the task's address, events and newest secret when they
     * differ from what it was last given; once it took a new secret, the older
     * generations retire. A webhook for a task that is no longer a GitHub task,
     * or is for another repository now, is removed. A webhook deleted on GitHub
     * ends the connection. Other failures are logged and retried at the next
     * change or reconnect. Writes only the GitHub columns (and clears "address
     * changed" only while the address it sent is still the task's).
     */
    const syncGitHub = (taskId: ScheduledTaskId) =>
      withGitHub(
        Effect.gen(function* () {
          const found = yield* webhooks.getTaskWebhook(taskId);
          if (Option.isNone(found)) return;
          const row = found.value;
          const githubHookId = row.githubHookId;
          const repository = row.githubRepository;
          if (githubHookId === null || repository === null) return;
          const trigger = yield* githubTrigger(taskId);
          if (trigger === null || trigger.repository !== repository) {
            // No longer a GitHub task, or for another repository: its webhook goes.
            yield* removeHookLocked({ taskId, repository, hookId: githubHookId });
            yield* forgetProblems(taskId);
            return yield* clearGitHub(taskId, githubHookId);
          }
          const relayUrl = row.relayUrl;
          if (relayUrl === null) return;
          const events = compileGitHubTrigger(trigger).events;
          const secret = yield* currentSecret(taskId);
          if (secret === null) return;
          if (
            row.githubHookUrl === relayUrl &&
            sameList(row.githubEvents, events) &&
            row.githubSecretGeneration === secret.generation &&
            !row.addressChanged
          ) {
            return yield* setProblem(updateProblems, taskId, null);
          }
          const patched = yield* gh({
            cwd: yield* githubCwd(taskId),
            args: [
              "api",
              "-X",
              "PATCH",
              `repos/${repository}/hooks/${githubHookId}`,
              "--input",
              "-",
            ],
            stdin: hookBody({ url: relayUrl, events, secret: secret.secret }),
          }).pipe(Effect.result);
          if (patched._tag === "Failure") {
            if (isGone(patched.failure)) {
              yield* Effect.logInfo("event tasks: a GitHub webhook was removed on GitHub", {
                taskId,
              });
              yield* setProblem(updateProblems, taskId, null);
              yield* setProblem(healthProblems, taskId, removedOnGitHub(repository));
              return yield* clearGitHub(taskId, githubHookId);
            }
            // GitHub still has the old settings: said on the task, and tried
            // again on the scheduler's tick and at reconcile.
            const why = githubProblem(patched.failure, repository, "change");
            // The next try comes 5 minutes on.
            lastUpdateRetry = yield* Clock.currentTimeMillis;
            yield* Effect.logWarning("event tasks: couldn't update a GitHub webhook", {
              taskId,
              detail: why,
            });
            return yield* setProblem(
              updateProblems,
              taskId,
              `Threadlines couldn't update the webhook on ${repository}. ${why}`,
            );
          }
          const now = yield* nowIso;
          // What GitHub has now, whatever changed here meanwhile.
          yield* webhooks.updateTaskWebhook({
            taskId,
            set: {
              githubHookUrl: relayUrl,
              githubEvents: events,
              githubSecretGeneration: secret.generation,
            },
            where: { githubHookId },
            now,
          });
          // The sender has the address only if it is still the task's.
          yield* webhooks.updateTaskWebhook({
            taskId,
            set: { addressChanged: false },
            where: { githubHookId, relayUrl },
            now,
          });
          yield* webhooks.retireSecrets({ taskId, below: secret.generation, now });
          yield* setProblem(updateProblems, taskId, null);
          yield* onChange;
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("event tasks: couldn't bring a GitHub webhook up to date", {
            taskId,
            cause: Cause.pretty(cause),
          }),
        ),
      );

    /** "Add to GitHub": a webhook on the task's repository, sending to its relay address. */
    const connectGitHub = (taskId: ScheduledTaskId) =>
      withGitHub(
        Effect.gen(function* () {
          const trigger = yield* githubTrigger(taskId);
          if (trigger === null) {
            return yield* refuse("Only a GitHub event task can be added to GitHub.");
          }
          const found = yield* webhooks.getTaskWebhook(taskId);
          if (Option.isNone(found)) return yield* refuse("This task has no address yet.");
          const row = found.value;
          if (row.githubHookId !== null && row.githubRepository === trigger.repository) return;
          const relayUrl = row.relayUrl;
          if (relayUrl === null) {
            return yield* refuse(
              "This task has no public address yet. Try again once the relay can be reached.",
            );
          }
          yield* ensureSecret(taskId);
          const secret = yield* currentSecret(taskId);
          if (secret === null) return yield* refuse("This task's signing secret couldn't be read.");
          const events = compileGitHubTrigger(trigger).events;
          const output = yield* gh({
            cwd: yield* githubCwd(taskId),
            args: ["api", "-X", "POST", `repos/${trigger.repository}/hooks`, "--input", "-"],
            stdin: hookBody({ url: relayUrl, events, secret: secret.secret }),
          }).pipe(
            Effect.mapError(
              (error) =>
                new EventTaskHookRefusal({ detail: githubProblem(error, trigger.repository) }),
            ),
          );
          let hookId: string | null = null;
          try {
            const parsed: unknown = JSON.parse(output.stdout);
            if (typeof parsed === "object" && parsed !== null && "id" in parsed) {
              const id = (parsed as { readonly id: unknown }).id;
              if (typeof id === "number" || typeof id === "string") hookId = String(id);
            }
          } catch {
            // Not JSON: handled below.
          }
          if (hookId === null) return yield* refuse("GitHub didn't say which webhook it added.");
          if (row.githubHookId !== null && row.githubRepository !== null) {
            // Connected to another repository before: that webhook goes.
            yield* removeHookLocked({
              taskId,
              repository: row.githubRepository,
              hookId: row.githubHookId,
            });
          }
          const now = yield* nowIso;
          const recorded = yield* webhooks.updateTaskWebhook({
            taskId,
            set: {
              githubHookId: hookId,
              githubRepository: trigger.repository,
              githubHookUrl: relayUrl,
              githubEvents: events,
              githubSecretGeneration: secret.generation,
            },
            where: { githubHookId: row.githubHookId },
            now,
          });
          if (!recorded) {
            // The task was deleted (or stopped being an event task) while
            // GitHub added it: the new webhook goes, or waits to.
            yield* removeHookLocked({ taskId, repository: trigger.repository, hookId });
            return;
          }
          yield* webhooks.updateTaskWebhook({
            taskId,
            set: { addressChanged: false },
            where: { relayUrl },
            now,
          });
          yield* webhooks.retireSecrets({ taskId, below: secret.generation, now });
          yield* forgetProblems(taskId);
        }),
      );

    /** Removes the webhook Threadlines added on GitHub; the task keeps its address. */
    const disconnectGitHub = (taskId: ScheduledTaskId) =>
      withGitHub(
        Effect.gen(function* () {
          const found = yield* webhooks.getTaskWebhook(taskId);
          if (Option.isNone(found)) return;
          const row = found.value;
          const githubHookId = row.githubHookId;
          const repository = row.githubRepository;
          if (githubHookId === null || repository === null) return;
          yield* gh({
            cwd: yield* githubCwd(taskId),
            args: ["api", "-X", "DELETE", `repos/${repository}/hooks/${githubHookId}`],
          }).pipe(
            Effect.catch((error) =>
              isGone(error)
                ? Effect.void
                : Effect.fail(
                    new EventTaskHookRefusal({ detail: githubRemovalProblem(error, repository) }),
                  ),
            ),
          );
          yield* forgetProblems(taskId);
          yield* clearGitHub(taskId, githubHookId);
        }),
      );

    /**
     * The GitHub webhook of a task that was deleted or stopped being an event
     * task, removed; one that can't be removed yet is recorded and tried again.
     */
    const removeGitHubHook = (row: TaskWebhookRow) => {
      const githubHookId = row.githubHookId;
      const repository = row.githubRepository;
      return githubHookId === null || repository === null
        ? forgetProblems(row.taskId)
        : withGitHub(
            Effect.andThen(
              forgetProblems(row.taskId),
              removeHookLocked({ taskId: row.taskId, repository, hookId: githubHookId }),
            ),
          ).pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning("event tasks: couldn't remove a GitHub webhook", {
                taskId: row.taskId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
    };

    /**
     * What is wrong with each task's GitHub webhook, in plain words: an old
     * one that couldn't be removed, an update GitHub didn't take, or what the
     * last look at it found. One each, the first of those.
     */
    const githubProblems = webhooks.listGitHubRemovals.pipe(
      Effect.map((removals) => {
        const byTask = new Map<ScheduledTaskId, string>();
        for (const removal of removals) {
          if (byTask.has(removal.taskId)) continue;
          byTask.set(
            removal.taskId,
            `Threadlines couldn't remove its old webhook from ${removal.repository}. ${removal.reason}`,
          );
        }
        for (const problems of [updateProblems, healthProblems]) {
          for (const [taskId, problem] of problems) {
            if (!byTask.has(taskId)) byTask.set(taskId, problem);
          }
        }
        return byTask;
      }),
    );

    /**
     * Looks at a connected task's webhook on GitHub: removed there (the
     * connection ends), turned off, or its last delivery failing is said on
     * the task; a healthy one clears that. A look `gh` can't make changes
     * nothing.
     */
    const checkGitHubHook = (taskId: ScheduledTaskId) =>
      withGitHub(
        Effect.gen(function* () {
          const found = yield* webhooks.getTaskWebhook(taskId);
          if (Option.isNone(found)) return;
          const githubHookId = found.value.githubHookId;
          const repository = found.value.githubRepository;
          if (githubHookId === null || repository === null) return;
          const looked = yield* gh({
            cwd: yield* githubCwd(taskId),
            args: ["api", `repos/${repository}/hooks/${githubHookId}`],
          }).pipe(Effect.result);
          if (looked._tag === "Failure") {
            if (!isGone(looked.failure)) {
              return yield* Effect.logInfo("event tasks: couldn't look at a GitHub webhook", {
                taskId,
                detail: githubProblem(looked.failure, repository, "change"),
              });
            }
            yield* setProblem(updateProblems, taskId, null);
            yield* setProblem(healthProblems, taskId, removedOnGitHub(repository));
            return yield* clearGitHub(taskId, githubHookId);
          }
          yield* setProblem(
            healthProblems,
            taskId,
            githubHookHealth(looked.success.stdout, repository),
          );
        }),
      );

    /**
     * Looks at a task's webhook on GitHub in the background (when its detail
     * opens), at most every 5 minutes per task.
     */
    const checkGitHubHookSoon = (taskId: ScheduledTaskId) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const last = lastHealthChecks.get(taskId);
        if (last !== undefined && now - last < GITHUB_RECHECK_MS) return;
        lastHealthChecks.set(taskId, now);
        yield* checkGitHubHook(taskId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("event tasks: couldn't look at a GitHub webhook", {
              taskId,
              cause: Cause.pretty(cause),
            }),
          ),
          Effect.forkDetach,
        );
      });

    /** GitHub updates that failed, tried again at most every 5 minutes (the scheduler's tick). */
    const retryGitHubUpdates = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (updateProblems.size === 0 || now - lastUpdateRetry < GITHUB_RECHECK_MS) return;
      lastUpdateRetry = now;
      // A copy: each sync may clear its own entry.
      for (const taskId of Array.from(updateProblems.keys())) yield* syncGitHub(taskId);
    });

    // ---------------------------------------------------------------------------
    // Addresses over time
    // ---------------------------------------------------------------------------

    /**
     * Gives every task without a hook one, and every task minted under another
     * relay identity a new one (its address changed). Then the relay gets the
     * whole list, GitHub webhooks follow their tasks' addresses, and webhooks
     * waiting for removal are tried again. Clients hear of any change.
     */
    const reconcile = Effect.gen(function* () {
      yield* hookLock.withPermits(1)(
        Effect.gen(function* () {
          const hostId = yield* relay.hostId;
          const rows = yield* webhooks.listTaskWebhooks;
          let changedAny = false;
          for (const row of rows) {
            const moved =
              hostId !== null && row.mintedHostId !== null && row.mintedHostId !== hostId;
            if (row.hookId !== null && !moved) continue;
            const minted = yield* mint(row.keptHeaders);
            const now = yield* nowIso;
            if (Option.isNone(minted)) {
              if (moved) {
                // Its address went with the old identity: it waits for a new one.
                yield* webhooks.transact(
                  Effect.gen(function* () {
                    const wrote = yield* webhooks.updateTaskWebhook({
                      taskId: row.taskId,
                      set: {
                        hookId: null,
                        relayUrl: null,
                        mintedHostId: null,
                        addressChanged: true,
                      },
                      where: { hookId: row.hookId },
                      now,
                    });
                    if (wrote) yield* webhooks.retireHooks({ taskId: row.taskId, keep: null, now });
                  }),
                );
                changedAny = true;
              }
              continue;
            }
            const hookId = minted.value.hookId;
            yield* webhooks.transact(
              Effect.gen(function* () {
                const wrote = yield* webhooks.updateTaskWebhook({
                  taskId: row.taskId,
                  set: {
                    hookId,
                    relayUrl: minted.value.url,
                    mintedHostId: minted.value.hostId,
                    // A task that had an address has a new one; its sender needs telling.
                    addressChanged: row.addressChanged || moved || row.relayUrl !== null,
                  },
                  where: { hookId: row.hookId },
                  now,
                });
                if (!wrote) return;
                yield* webhooks.insertHook({ hookId, taskId: row.taskId, now });
                yield* webhooks.retireHooks({ taskId: row.taskId, keep: hookId, now });
              }),
            );
            changedAny = true;
          }
          yield* syncActiveLocked;
          if (changedAny) yield* onChange;
        }),
      );
      yield* withGitHub(Effect.void);
      const rows = yield* webhooks.listTaskWebhooks;
      for (const row of rows) {
        if (row.githubHookId !== null) yield* syncGitHub(row.taskId);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("event tasks: couldn't bring addresses up to date", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

    /** The user has given the sender the changed address: stop saying so. */
    const dismissAddressChange = (taskId: ScheduledTaskId) =>
      hookLock.withPermits(1)(
        Effect.gen(function* () {
          const found = yield* webhooks.getTaskWebhook(taskId);
          if (Option.isNone(found)) return yield* refuse("This task doesn't start on events.");
          if (!found.value.addressChanged) return;
          yield* webhooks.updateTaskWebhook({
            taskId,
            set: { addressChanged: false },
            now: yield* nowIso,
          });
        }),
      );

    /** A new address: a new relay hook (or none until the relay answers) and a new local token. */
    const rotate = (taskId: ScheduledTaskId) =>
      Effect.gen(function* () {
        yield* hookLock.withPermits(1)(
          Effect.gen(function* () {
            const found = yield* webhooks.getTaskWebhook(taskId);
            if (Option.isNone(found)) return yield* refuse("This task doesn't start on events.");
            const row = found.value;
            const minted = yield* mint(row.keptHeaders);
            const now = yield* nowIso;
            const hookId = Option.isSome(minted) ? minted.value.hookId : null;
            yield* webhooks.transact(
              Effect.gen(function* () {
                if (hookId !== null) yield* webhooks.insertHook({ hookId, taskId, now });
                yield* webhooks.retireHooks({ taskId, keep: hookId, now });
                yield* webhooks.updateTaskWebhook({
                  taskId,
                  set: {
                    hookId,
                    relayUrl: Option.isSome(minted) ? minted.value.url : null,
                    mintedHostId: Option.isSome(minted) ? minted.value.hostId : null,
                    localToken: randomToken(),
                    addressChanged: false,
                  },
                  now,
                });
              }),
            );
            yield* syncActiveLocked;
          }),
        );
        yield* syncGitHub(taskId);
        return yield* address(taskId);
      });

    const address = (taskId: ScheduledTaskId) =>
      Effect.gen(function* () {
        const found = yield* webhooks.getTaskWebhook(taskId);
        if (Option.isNone(found)) return yield* refuse("This task doesn't start on events.");
        return {
          relayUrl: found.value.relayUrl,
          localUrl: localUrl(found.value),
        } satisfies ScheduledTaskWebhookAddress;
      });

    /**
     * A new signing secret: the one given, or a generated one (returned, once).
     * The older generations retire at once for a sender set up by hand, and
     * once GitHub took the new one for a webhook Threadlines added.
     */
    const setSecret = (taskId: ScheduledTaskId, given: string | "generate") =>
      Effect.gen(function* () {
        const found = yield* webhooks.getTaskWebhook(taskId);
        if (Option.isNone(found)) return yield* refuse("This task doesn't start on events.");
        const secret = given === "generate" ? randomSecret() : given;
        if (secret.length > 500) return yield* refuse("That secret is too long.");
        const generation = yield* addSecret(taskId, secret);
        if (found.value.githubHookId === null) {
          yield* webhooks.retireSecrets({ taskId, below: generation, now: yield* nowIso });
        } else {
          yield* syncGitHub(taskId);
        }
        return { secret: given === "generate" ? secret : null };
      });

    const revealSecret = (taskId: ScheduledTaskId) =>
      currentSecret(taskId).pipe(Effect.map((current) => ({ secret: current?.secret ?? null })));

    /** Address work that waits on the relay: at start, when it is reachable, when its identity changes. */
    const start = (): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(reconcile);
        yield* Effect.forkScoped(
          Stream.runForEach(relay.changes, (change) =>
            Effect.logInfo("event tasks: relay change", { kind: change.kind }).pipe(
              Effect.andThen(reconcile),
            ),
          ),
        );
      });

    return {
      newAddress,
      storeAddress,
      updateKeptHeaders,
      syncActive,
      reconcile,
      rotate,
      dismissAddressChange,
      address,
      localUrl,
      ensureSecret,
      secretsFor,
      currentSecret,
      setSecret,
      revealSecret,
      dropSecrets,
      gitHubContext,
      githubLogin,
      connectGitHub,
      disconnectGitHub,
      removeGitHubHook,
      githubProblems,
      checkGitHubHookSoon,
      retryGitHubUpdates,
      syncGitHub,
      githubCwd,
      start,
    };
  });

export type EventTaskHooks = Effect.Success<ReturnType<typeof makeEventTaskHooks>>;
