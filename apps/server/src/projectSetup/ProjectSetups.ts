// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CommandId,
  PROJECT_SETUP_MAX_FILE_BYTES,
  PROJECT_SETUP_MAX_FILES,
  PROJECT_SETUP_MAX_TOTAL_BYTES,
  ProjectId,
  type ProjectSetupDestination,
  type ProjectSetupDestinationState,
  ProjectSetupError,
  type ProjectSetupFile,
  type ProjectSetupId,
  type ProjectSetupInspectDestinationInput,
  type ProjectSetupJob,
  type ProjectSetupProgress,
  type ProjectSetupRemote,
  type ProjectSetupStage,
  type ProjectSetupStartInput,
  type ProjectSetupsSnapshot,
} from "@threadlines/contracts";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";
import {
  classifyGitRemoteAuthFailure,
  convertGitRemoteUrl,
  describeGitRemoteAuthFailure,
  normalizeGitRemoteUrl,
  stripGitRemoteCredentials,
} from "@threadlines/shared/git";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { receivedPathRefusal, writeReceivedFile } from "../fs/receivedFiles.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { ProcessRunner } from "../processRunner.ts";
import {
  parseRemoteFetchUrls,
  pickPrimaryRemote,
} from "../project/Layers/RepositoryIdentityResolver.ts";
import { findProjectByPlace } from "../project/projectPlace.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";
import { parseCloneProgress } from "./cloneProgress.ts";
import {
  ProjectSetupRepository,
  type ProjectSetupRow,
  type ProjectSetupStoredRequest,
} from "./ProjectSetupRepository.ts";

/**
 * The computer a project is set up on (docs/design/fleet.md, Part 8). One
 * start call carries everything, files included; the job then runs here on
 * its own: clone into a staging folder only it made, add the extra remotes
 * and submodules, write the files, move the copy into place (the point of no
 * return), and add the project. Until that move it deletes only its staging
 * folder; after it, nothing.
 */
export interface ProjectSetupsShape {
  readonly inspectDestination: (
    input: ProjectSetupInspectDestinationInput,
  ) => Effect.Effect<ProjectSetupDestination, ProjectSetupError>;
  readonly start: (
    input: ProjectSetupStartInput,
  ) => Effect.Effect<ProjectSetupJob, ProjectSetupError>;
  readonly cancel: (setupId: ProjectSetupId) => Effect.Effect<void, ProjectSetupError>;
  readonly dismiss: (setupId: ProjectSetupId) => Effect.Effect<void, ProjectSetupError>;
  readonly changes: Stream.Stream<ProjectSetupsSnapshot, ProjectSetupError>;
}

export class ProjectSetups extends Context.Service<ProjectSetups, ProjectSetupsShape>()(
  "threadlines/projectSetup/ProjectSetups",
) {}

/** Git said nothing for this long: the job says "stalled". */
const STALLED_AFTER = Duration.seconds(20);
/** Git said nothing for this long: the job fails. */
const GIVE_UP_AFTER = Duration.minutes(15);
/** Finished jobs stay listed this long unless dismissed. */
const KEEP_FINISHED = Duration.hours(24);
/** Git's last words kept for an error. */
const STDERR_TAIL_CHARS = 16 * 1024;

const FINISHED: ReadonlySet<ProjectSetupStage> = new Set(["done", "failed", "cancelled"]);
/** From `adding` on, the copy is in place and nothing of it is ever deleted. */
const PUBLISHED: ReadonlySet<ProjectSetupStage> = new Set(["adding", "done"]);

const failure = (detail: string) => new ProjectSetupError({ detail });

const IDLE_PROGRESS: ProjectSetupProgress = {
  phase: null,
  percent: null,
  detail: null,
  stalled: false,
};

/** A step that can't go on: the job ends failed with this sentence. */
class SetupStop extends Data.TaggedError("SetupStop")<{ readonly reason: string }> {}

/** The staging folder beside the destination; its name says which job made it. */
export const stagingPathFor = (destination: string, setupId: string) =>
  NodePath.join(
    NodePath.dirname(destination),
    `.${NodePath.basename(destination)}.setup-${setupId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`,
  );

/** A remote URL's host, for a sentence; "the remote" when it has none. */
const hostOf = (url: string) => {
  const scp = /^[^@\s/:]+@([^:/\s]+):/.exec(url);
  if (scp?.[1]) return scp[1];
  try {
    return new URL(url).hostname || "the remote";
  } catch {
    return "the remote";
  }
};

/** The same remote URL, protocol and credentials aside, for "is this the same repository". */
const remoteForms = (url: string) => {
  const clean = stripGitRemoteCredentials(url);
  return [clean, convertGitRemoteUrl(clean, "ssh"), convertGitRemoteUrl(clean, "https")]
    .filter((form): form is string => form !== null)
    .map((form) =>
      form
        .toLowerCase()
        .replace(/\/+$/, "")
        .replace(/\.git$/, ""),
    );
};

/** B's copy points at one of A's remotes (protocol aside): a key alone drops ports. */
const sameRemote = (url: string, remotes: ReadonlyArray<ProjectSetupRemote>) => {
  const forms = new Set(remoteForms(url));
  return remotes.some((remote) => remoteForms(remote.url).some((form) => forms.has(form)));
};

/** The primary remote's URL over `protocol`, and the other protocol's as a fallback. */
export const cloneUrls = (request: ProjectSetupStoredRequest): ReadonlyArray<string> => {
  const primary = request.remotes.find((remote) => remote.name === request.primaryRemoteName);
  if (primary === undefined) return [];
  const chosen =
    request.protocol === "other"
      ? primary.url
      : (convertGitRemoteUrl(primary.url, request.protocol) ?? primary.url);
  const other =
    request.protocol === "ssh"
      ? convertGitRemoteUrl(primary.url, "https")
      : request.protocol === "https"
        ? convertGitRemoteUrl(primary.url, "ssh")
        : null;
  return other !== null && other !== chosen ? [chosen, other] : [chosen];
};

/** Why the start's files can't be taken, or null. B checks on its own, before anything starts. */
export const filesRefusal = (files: ReadonlyArray<ProjectSetupFile>): string | null => {
  if (files.length > PROJECT_SETUP_MAX_FILES) return `more than ${PROJECT_SETUP_MAX_FILES} files`;
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    const refusal = receivedPathRefusal(file.path);
    if (refusal !== null) return refusal;
    const folded = file.path.toLowerCase();
    if (seen.has(folded)) return `"${file.path}" is there twice`;
    seen.add(folded);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.contentBase64) || file.contentBase64.length % 4 !== 0) {
      return `"${file.path}" isn't readable`;
    }
    const size = Buffer.byteLength(file.contentBase64, "base64");
    if (size > PROJECT_SETUP_MAX_FILE_BYTES) return `"${file.path}" is over 1 MB`;
    total += size;
  }
  if (total > PROJECT_SETUP_MAX_TOTAL_BYTES) return "the files come to more than 8 MB together";
  return null;
};

interface LiveJob {
  progress: ProjectSetupProgress;
  fiber: Fiber.Fiber<void, unknown> | null;
  /** Cancel asked: the interrupt ends the job "cancelled" instead of leaving it for a restart. */
  cancelling: boolean;
}

export const makeProjectSetups = Effect.gen(function* () {
  const repo = yield* ProjectSetupRepository;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const identities = yield* RepositoryIdentityResolver;
  const processes = yield* ProcessRunner;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* ServerEnvironment;
  const scope = yield* Effect.scope;
  const ownLabel = (yield* environment.getDescriptor).label;

  const live = new Map<string, LiveJob>();
  const admission = yield* Semaphore.make(1);
  const changed = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(changed, undefined).pipe(Effect.asVoid);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const stored = (what: string) => () => failure(`${ownLabel} couldn't ${what}.`);

  const toJob = (row: ProjectSetupRow): ProjectSetupJob => ({
    setupId: row.setupId,
    source: row.request.source,
    title: row.request.title,
    repositoryKey: row.request.repositoryKey,
    subdirectory: row.request.subdirectory,
    protocol: row.request.protocol,
    destinationPath: row.destinationPath,
    filePaths: row.request.filePaths,
    stage: row.stage,
    progress: FINISHED.has(row.stage)
      ? IDLE_PROGRESS
      : (live.get(row.setupId)?.progress ?? IDLE_PROGRESS),
    projectId: PUBLISHED.has(row.stage) ? row.projectId : null,
    error: row.error,
    warnings: row.warnings,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const snapshot = Effect.gen(function* () {
    const rows = yield* repo.list;
    const cutoff = DateTime.formatIso(
      DateTime.subtractDuration(yield* DateTime.now, KEEP_FINISHED),
    );
    const kept: ProjectSetupRow[] = [];
    for (const row of rows) {
      if (FINISHED.has(row.stage) && row.updatedAt < cutoff) {
        yield* repo.remove(row.setupId);
        continue;
      }
      kept.push(row);
    }
    return { jobs: kept.map(toJob) } satisfies ProjectSetupsSnapshot;
  }).pipe(Effect.mapError(stored("read its project setups")));

  const changes: ProjectSetupsShape["changes"] = Stream.concat(
    Stream.make(undefined),
    Stream.fromPubSub(changed),
  ).pipe(
    Stream.debounce(Duration.millis(150)),
    Stream.mapEffect(() => snapshot),
  );

  const setStage = (row: ProjectSetupRow, stage: ProjectSetupStage, extra = {}) =>
    Effect.gen(function* () {
      yield* repo.update({ setupId: row.setupId, patch: { stage, ...extra }, now: yield* nowIso });
      yield* notify;
    }).pipe(Effect.mapError(stored("record its project setup")));

  const setProgress = (setupId: string, progress: Partial<ProjectSetupProgress>) =>
    Effect.gen(function* () {
      const job = live.get(setupId);
      if (job === undefined) return;
      job.progress = { ...job.progress, ...progress };
      yield* notify;
    });

  // ---------------------------------------------------------------------------
  // The disk
  // ---------------------------------------------------------------------------

  const statOf = (path: string) => Effect.promise(() => NodeFs.lstat(path).catch(() => null));

  const git = (cwd: string, args: ReadonlyArray<string>, timeout: Duration.Input = "30 seconds") =>
    processes
      .run({
        command: "git",
        args: ["-C", cwd, ...args],
        timeout,
        maxOutputBytes: 256 * 1024,
        outputMode: "truncate",
        env: { GIT_TERMINAL_PROMPT: "0" },
      })
      .pipe(
        Effect.map((out) => ({ ok: out.code === 0, out: out.stdout.trim(), err: out.stderr })),
        Effect.orElseSucceed(() => ({ ok: false, out: "", err: "" })),
      );

  /** The repository whose root is exactly `path`, by its primary remote's URL; null otherwise. */
  const repositoryAt = (path: string) =>
    Effect.gen(function* () {
      const top = yield* git(path, ["rev-parse", "--show-toplevel"]);
      if (!top.ok) return null;
      const [real, realTop] = yield* Effect.all([
        Effect.promise(() => NodeFs.realpath(path).catch(() => path)),
        Effect.promise(() => NodeFs.realpath(top.out).catch(() => top.out)),
      ]);
      if (real !== realTop) return null;
      const remotes = yield* git(path, ["remote", "-v"]);
      const primary = pickPrimaryRemote(parseRemoteFetchUrls(remotes.out));
      return primary === null ? null : primary.remoteUrl;
    });

  const destinationState = (
    resolvedPath: string,
    repositoryKey: string,
    remotes: ReadonlyArray<ProjectSetupRemote>,
  ) =>
    Effect.gen(function* (): Effect.fn.Return<ProjectSetupDestinationState> {
      const stat = yield* statOf(resolvedPath);
      if (stat === null) return "missing";
      if (!stat.isDirectory() || stat.isSymbolicLink()) return "not-a-folder";
      const entries = yield* Effect.promise(() => NodeFs.readdir(resolvedPath).catch(() => [""]));
      if (entries.length === 0) return "empty";
      const url = yield* repositoryAt(resolvedPath);
      if (url === null) return "not-empty";
      return normalizeGitRemoteUrl(url) === repositoryKey && sameRemote(url, remotes)
        ? "same-repository"
        : "other-repository";
    });

  const resolveDestination = (path: string) => {
    const expanded = expandHomePath(path.trim());
    return NodePath.isAbsolute(expanded) ? NodePath.resolve(expanded) : null;
  };

  const inspectDestination: ProjectSetupsShape["inspectDestination"] = (input) =>
    Effect.gen(function* () {
      const resolvedPath = resolveDestination(input.path);
      if (resolvedPath === null) {
        return yield* failure("Give a full folder path, or one that starts with ~.");
      }
      const state = yield* destinationState(resolvedPath, input.repositoryKey, input.remotes);
      return { resolvedPath, state };
    });

  /** Deletes the staging folder this job made, and nothing else. */
  const removeStaging = (row: ProjectSetupRow) =>
    Effect.promise(async () => {
      const staging = row.stagingPath;
      if (staging === null || staging !== stagingPathFor(row.destinationPath, row.setupId)) return;
      await NodeFs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    });

  // ---------------------------------------------------------------------------
  // The clone
  // ---------------------------------------------------------------------------

  /** One `git clone` into the (empty) staging folder, its progress fed to the job. */
  const cloneOnce = (row: ProjectSetupRow, url: string) =>
    Effect.gen(function* () {
      const staging = row.stagingPath!;
      const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PROGRESS_DELAY: "0" };
      const child = yield* spawner.spawn(
        ChildProcess.make(
          "git",
          ["clone", "--progress", "--origin", "origin", "--", url, staging],
          hideWindowsConsole({
            cwd: NodePath.dirname(staging),
            env,
            extendEnv: false,
            stdin: "ignore",
            forceKillAfter: "5 seconds",
          }),
        ),
      );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
      let tail = "";
      let lastHeard = Date.now();
      const tick = Effect.gen(function* () {
        const quiet = Date.now() - lastHeard;
        if (quiet > Duration.toMillis(GIVE_UP_AFTER)) {
          return yield* Effect.fail(
            new SetupStop({
              reason: `Stopped receiving anything from ${hostOf(url)} for 15 minutes.`,
            }),
          );
        }
        const stalled = quiet > Duration.toMillis(STALLED_AFTER);
        if (live.get(row.setupId)?.progress.stalled !== stalled) {
          yield* setProgress(row.setupId, { stalled });
        }
      });
      const watch = Effect.forever(Effect.sleep("2 seconds").pipe(Effect.andThen(tick)));
      const read = Effect.all(
        [
          Stream.runDrain(child.stdout),
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                lastHeard = Date.now();
                tail = `${tail}${chunk}`.slice(-STDERR_TAIL_CHARS);
                const parsed = parseCloneProgress(chunk);
                yield* setProgress(row.setupId, { ...parsed, stalled: false });
              }),
            ),
          ),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      const [, , code] = yield* Effect.raceFirst(read, watch);
      return { ok: Number(code) === 0, stderr: tail };
    }).pipe(Effect.scoped);

  /** Clones over the chosen protocol, then once over the other when the first is refused for sign-in. */
  const clone = (row: ProjectSetupRow) =>
    Effect.gen(function* () {
      const urls = cloneUrls(row.request);
      if (urls.length === 0)
        return yield* Effect.fail(new SetupStop({ reason: "It has no remote to clone." }));
      let lastError = "";
      for (const [index, url] of urls.entries()) {
        if (normalizeGitRemoteUrl(url) !== row.request.repositoryKey) {
          return yield* Effect.fail(
            new SetupStop({
              reason: "Its remote wouldn't be recognized here as the same project.",
            }),
          );
        }
        if (index > 0) {
          // A failed clone leaves the staging folder part-filled: start it over, still ours.
          yield* removeStaging(row);
          yield* Effect.promise(() => NodeFs.mkdir(row.stagingPath!));
          yield* setProgress(row.setupId, IDLE_PROGRESS);
        }
        const result = yield* cloneOnce(row, url);
        if (result.ok) {
          if (index > 0) {
            const first = classifyGitRemoteAuthFailure(lastError);
            yield* addWarning(
              row,
              `Cloned over ${url.startsWith("https") ? "HTTPS" : "SSH"}: ${
                first !== null ? describeGitRemoteAuthFailure(first) : "the first try was refused."
              }`,
            );
          }
          return url;
        }
        lastError = result.stderr;
        const auth = classifyGitRemoteAuthFailure(result.stderr);
        // A host key that doesn't match is a trust failure, never retried another way.
        if (auth === null || auth.kind === "ssh_host_key_verification_failed") break;
      }
      const auth = classifyGitRemoteAuthFailure(lastError);
      const reason =
        auth !== null
          ? `${describeGitRemoteAuthFailure(auth)} Sign in to ${auth.host ?? "it"} on ${ownLabel}, then Retry.`
          : (lastError
              .split(/[\r\n]+/)
              .map((line) => line.trim())
              .findLast((line) => /^(fatal|error):/i.test(line)) ?? "Git couldn't clone it.");
      return yield* Effect.fail(new SetupStop({ reason }));
    });

  const warningsOf = new Map<string, string[]>();
  const addWarning = (row: ProjectSetupRow, warning: string) =>
    Effect.gen(function* () {
      const warnings = [...(warningsOf.get(row.setupId) ?? row.warnings), warning];
      warningsOf.set(row.setupId, warnings);
      yield* repo.update({ setupId: row.setupId, patch: { warnings }, now: yield* nowIso });
      yield* notify;
    }).pipe(Effect.ignore);

  // ---------------------------------------------------------------------------
  // The job
  // ---------------------------------------------------------------------------

  const writeFiles = (row: ProjectSetupRow, root: string, files: ReadonlyArray<ProjectSetupFile>) =>
    Effect.forEach(
      files,
      (file) =>
        Effect.tryPromise({
          try: () =>
            writeReceivedFile(root, file.path, {
              bytes: Buffer.from(file.contentBase64, "base64"),
              mode: file.mode,
            }),
          catch: (cause) =>
            cause instanceof Error && cause.message === "exists" ? "exists" : "failed",
        }).pipe(
          Effect.catch((why) =>
            addWarning(
              row,
              why === "exists"
                ? `Kept ${ownLabel}'s own ${file.path}.`
                : `Couldn't write ${file.path}.`,
            ),
          ),
        ),
      { discard: true },
    );

  /** Adds the project (its recorded id: a replay is the same command) and its scripts. */
  const addProject = (row: ProjectSetupRow) =>
    Effect.gen(function* () {
      const workspaceRoot =
        row.request.subdirectory === ""
          ? row.destinationPath
          : NodePath.join(row.destinationPath, ...row.request.subdirectory.split("/"));
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "project.create",
        commandId: row.createCommandId,
        projectId: row.projectId,
        kind: "workspace",
        title: row.request.title,
        workspaceRoot,
        createdAt,
      });
      if (row.request.scripts.length > 0) {
        yield* engine.dispatch({
          type: "project.meta.update",
          commandId: row.scriptsCommandId,
          projectId: row.projectId,
          scripts: row.request.scripts,
        });
      }
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SetupStop({
            reason: `The copy is in place, but ${ownLabel} couldn't add it as a project: ${cause.message}`,
          }),
      ),
    );

  /** The project's folder must be in the copy before it's added. */
  const requireSubdirectory = (row: ProjectSetupRow, root: string, missing: string) =>
    Effect.gen(function* () {
      if (row.request.subdirectory === "") return;
      const folder = yield* statOf(NodePath.join(root, ...row.request.subdirectory.split("/")));
      if (folder === null || !folder.isDirectory()) {
        return yield* Effect.fail(new SetupStop({ reason: missing }));
      }
    });

  const publish = (row: ProjectSetupRow) =>
    Effect.tryPromise({
      try: async () => {
        const existing = await NodeFs.lstat(row.destinationPath).catch(() => null);
        // An empty folder there is replaced; anything else stops the move (a race since Start).
        if (existing !== null) await NodeFs.rmdir(row.destinationPath);
        await NodeFs.rename(row.stagingPath!, row.destinationPath);
      },
      catch: () =>
        new SetupStop({
          reason: `Something else is in ${row.destinationPath} now, so the copy couldn't move there.`,
        }),
    });

  const runJob = (row: ProjectSetupRow, files: ReadonlyArray<ProjectSetupFile>) =>
    Effect.gen(function* () {
      if (!row.adopted) {
        const url = yield* clone(row);
        yield* setStage(row, "cloning", { cloneUrl: url });
        const staging = row.stagingPath!;
        for (const remote of row.request.remotes) {
          if (remote.name === row.request.primaryRemoteName || remote.name === "origin") continue;
          yield* git(staging, ["remote", "add", remote.name, remote.url]);
        }
        if ((yield* statOf(NodePath.join(staging, ".gitmodules"))) !== null) {
          yield* setStage(row, "submodules");
          const submodules = yield* git(
            staging,
            ["submodule", "update", "--init", "--recursive"],
            "10 minutes",
          );
          if (!submodules.ok) yield* addWarning(row, "Its submodules couldn't be fetched.");
        }
        yield* requireSubdirectory(
          row,
          staging,
          `${row.request.subdirectory} isn't on the default branch of ${row.request.repositoryKey} yet.`,
        );
        if (files.length > 0) {
          yield* setStage(row, "copying");
          yield* writeFiles(row, staging, files);
        }
        yield* setStage(row, "publishing");
        yield* publish(row);
      } else {
        yield* requireSubdirectory(
          row,
          row.destinationPath,
          `${row.request.subdirectory} isn't in ${row.destinationPath}.`,
        );
        if (files.length > 0) yield* writeFiles(row, row.destinationPath, files);
      }
      yield* setStage(row, "adding");
      yield* addProject(row);
      yield* setStage(row, "done");
    });

  /** Runs a job to its end: failed or cancelled jobs lose their staging folder, never more. */
  const launch = (row: ProjectSetupRow, files: ReadonlyArray<ProjectSetupFile>) =>
    Effect.gen(function* () {
      const job: LiveJob = { progress: IDLE_PROGRESS, fiber: null, cancelling: false };
      live.set(row.setupId, job);
      const fiber = yield* runJob(row, files).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const current = Option.getOrUndefined(
              yield* repo.get(row.setupId).pipe(Effect.orElseSucceed(() => Option.none())),
            );
            const published = current !== undefined && PUBLISHED.has(current.stage);
            if (Exit.isSuccess(exit)) {
              live.delete(row.setupId);
              return;
            }
            if (Exit.hasInterrupts(exit) && !job.cancelling) {
              // The server is stopping: the row stays as it is for the restart to finish or undo.
              return;
            }
            const stop = Exit.findErrorOption(exit);
            const reason =
              Option.isSome(stop) && stop.value._tag === "SetupStop"
                ? stop.value.reason
                : Option.isSome(stop) && stop.value._tag === "ProjectSetupError"
                  ? stop.value.detail
                  : `${ownLabel} couldn't finish setting it up.`;
            if (!published) yield* removeStaging(row);
            yield* setStage(
              row,
              job.cancelling && !published ? "cancelled" : "failed",
              job.cancelling && !published ? { error: null } : { error: reason },
            ).pipe(Effect.ignore);
            live.delete(row.setupId);
          }),
        ),
        Effect.forkIn(scope),
      );
      job.fiber = fiber;
    });

  // ---------------------------------------------------------------------------
  // Asking
  // ---------------------------------------------------------------------------

  const start: ProjectSetupsShape["start"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* repo.get(input.setupId).pipe(Effect.mapError(stored("read it")));
      if (Option.isSome(existing)) return toJob(existing.value);
      const refusal = filesRefusal(input.files);
      if (refusal !== null) return yield* failure(`Can't take the files: ${refusal}.`);
      if (input.subdirectory.split("/").some((part) => part === ".." || part === ".")) {
        return yield* failure("The project's folder in the repository isn't valid.");
      }
      const destination = resolveDestination(input.destinationPath);
      if (destination === null) {
        return yield* failure("Give a full folder path, or one that starts with ~.");
      }
      if (input.remotes.every((remote) => remote.name !== input.primaryRemoteName)) {
        return yield* failure("It has no remote to clone.");
      }
      const row = yield* admission.withPermits(1)(
        Effect.gen(function* () {
          const catalog = yield* snapshots
            .getProjectCatalog()
            .pipe(Effect.mapError(stored("read its projects")));
          const have = yield* findProjectByPlace(
            identities,
            catalog.projects,
            input.repositoryKey,
            input.subdirectory,
          );
          if (have !== undefined) {
            return yield* failure(`${ownLabel} already has ${have.title}.`);
          }
          const rows = yield* repo.list.pipe(Effect.mapError(stored("read its project setups")));
          const busy = rows.find(
            (other) =>
              !FINISHED.has(other.stage) &&
              (other.destinationPath === destination ||
                other.request.repositoryKey === input.repositoryKey),
          );
          if (busy !== undefined) {
            return yield* failure(`${ownLabel} is already setting up ${busy.request.title}.`);
          }
          const state = yield* destinationState(destination, input.repositoryKey, input.remotes);
          if (state === "not-empty") return yield* failure(`${destination} isn't empty.`);
          if (state === "not-a-folder") return yield* failure(`${destination} is a file.`);
          if (state === "other-repository") {
            return yield* failure(`${destination} holds a different repository.`);
          }
          const adopted = state === "same-repository";
          const stagingPath = adopted ? null : stagingPathFor(destination, input.setupId);
          if (stagingPath !== null) {
            const made = yield* Effect.tryPromise(async () => {
              await NodeFs.mkdir(NodePath.dirname(destination), { recursive: true });
              // Exclusive: if anything is there, it isn't ours, and nothing here deletes it.
              await NodeFs.mkdir(stagingPath);
            }).pipe(Effect.result);
            if (made._tag === "Failure") {
              return yield* failure(`${ownLabel} couldn't make a folder next to ${destination}.`);
            }
          }
          const { files, ...rest } = input;
          return yield* repo
            .insert({
              setupId: input.setupId,
              request: { ...rest, filePaths: files.map((file) => file.path) },
              destinationPath: destination,
              stagingPath,
              adopted,
              stage: adopted ? "copying" : "cloning",
              projectId: ProjectId.make(randomUUID()),
              createCommandId: CommandId.make(randomUUID()),
              scriptsCommandId: CommandId.make(randomUUID()),
              createdAt: yield* nowIso,
            })
            .pipe(Effect.mapError(stored("record the setup")));
        }),
      );
      yield* launch(row, input.files);
      yield* notify;
      return toJob(row);
    });

  const cancel: ProjectSetupsShape["cancel"] = (setupId) =>
    Effect.gen(function* () {
      const row = yield* repo.get(setupId).pipe(Effect.mapError(stored("read it")));
      if (Option.isNone(row) || FINISHED.has(row.value.stage)) return;
      if (PUBLISHED.has(row.value.stage) || row.value.stage === "publishing") {
        return yield* failure("It's already in place; it can't be cancelled now.");
      }
      const job = live.get(setupId);
      if (job?.fiber == null) return;
      job.cancelling = true;
      yield* Fiber.interrupt(job.fiber);
    });

  const dismiss: ProjectSetupsShape["dismiss"] = (setupId) =>
    Effect.gen(function* () {
      const row = yield* repo.get(setupId).pipe(Effect.mapError(stored("read it")));
      if (Option.isNone(row)) return;
      if (!FINISHED.has(row.value.stage)) {
        return yield* failure("It's still running. Cancel it first.");
      }
      yield* repo.remove(setupId).pipe(Effect.mapError(stored("forget it")));
      yield* notify;
    });

  // ---------------------------------------------------------------------------
  // After a restart
  // ---------------------------------------------------------------------------

  /** Finishes a job whose copy is in place; undoes one whose copy isn't. */
  const recover = (row: ProjectSetupRow) =>
    Effect.gen(function* () {
      const staging = row.stagingPath === null ? null : yield* statOf(row.stagingPath);
      const placed = yield* statOf(NodePath.join(row.destinationPath, ".git"));
      const published =
        PUBLISHED.has(row.stage) ||
        row.adopted ||
        (row.stage === "publishing" && staging === null && placed !== null);
      if (!published) {
        yield* removeStaging(row);
        yield* setStage(row, "failed", {
          error: `Stopped when ${ownLabel} restarted. Retry starts it again.`,
        });
        return;
      }
      if (row.stage === "copying") {
        yield* addWarning(row, `${ownLabel} restarted while copying files; some may be missing.`);
      }
      yield* setStage(row, "adding");
      const added = yield* addProject(row).pipe(Effect.result);
      if (added._tag === "Failure") {
        yield* setStage(row, "failed", { error: added.failure.reason });
        return;
      }
      yield* setStage(row, "done");
    }).pipe(Effect.ignore);

  yield* Effect.gen(function* () {
    const rows = yield* repo.list.pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      rows.filter((row) => !FINISHED.has(row.stage)),
      recover,
      { discard: true },
    );
  }).pipe(Effect.forkIn(scope));

  return { inspectDestination, start, cancel, dismiss, changes } satisfies ProjectSetupsShape;
});

export const ProjectSetupsLive = Layer.effect(ProjectSetups, makeProjectSetups);
