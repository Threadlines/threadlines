/**
 * ProviderAccounts — one-click extra accounts.
 *
 * Adding one allocates a permanent instance id, makes the account's private
 * folder on this machine (the client may be a phone or another computer),
 * writes the instance into settings against the latest settings, and waits
 * until the provider registry has built it, so the client can start sign-in
 * straight away.
 *
 * Removing one stops it first (sign-in run, then the instance itself, which
 * ends its sessions and servers), then signs the account out with its own
 * CLI and deletes its folder. Only a folder Threadlines made is ever signed
 * out or deleted: it sits at exactly `<stateDir>/accounts/<instanceId>` and
 * holds a marker naming that instance. A cleanup record written before the
 * work and removed after it lets the next server start finish a sign-out or
 * delete that failed or hung.
 *
 * @module provider/accounts/ProviderAccounts
 */
import { randomBytes } from "node:crypto";
import * as NodeOS from "node:os";

import {
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderAccountError,
  type ProviderAccountAddInput,
  type ProviderAccountRemoveInput,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ServerSettings,
} from "@threadlines/contracts";
import {
  providerAccountFolderField,
  supportsProviderAccounts,
} from "@threadlines/shared/providerAccounts";
import { buildProviderSignOutCommand } from "@threadlines/shared/providerAuthCommands";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { removeLinkIfPresent } from "../accountOverlay.ts";
import { antigravityInstancePaths } from "../antigravity/AntigravityProfile.ts";
import { ProviderAuthSessions } from "../auth/ProviderAuthSessions.ts";
import { claudeInstanceBaseEnvironment, resolveClaudeConfigDir } from "../Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";

const ACCOUNTS_DIRECTORY = "accounts";
const CLEANUP_DIRECTORY = ".cleanup";
const RETIRED_DIRECTORY = ".retired";
const MARKER_FILE = ".threadlines-account";
const INSTANCE_READY_TIMEOUT = Duration.seconds(20);
const SIGN_OUT_TIMEOUT = Duration.seconds(20);

const AccountMarker = Schema.Struct({ instanceId: Schema.String, driver: Schema.String });
const decodeAccountMarker = Schema.decodeUnknownOption(Schema.fromJsonString(AccountMarker));
const decodeCodexSettingsOption = Schema.decodeUnknownOption(CodexSettings);

/** What removal still has to do, persisted until it is done. */
const CleanupRecord = Schema.Struct({
  instanceId: Schema.String,
  driver: Schema.String,
  /** Folders to delete; every one was made by Threadlines. */
  folders: Schema.Array(Schema.String),
  /** The account folder the CLI signs out of, when the driver has a sign-out. */
  signOutFolder: Schema.optional(Schema.String),
  binaryPath: Schema.String,
  homePath: Schema.String,
});
type CleanupRecord = typeof CleanupRecord.Type;
const decodeCleanupRecord = Schema.decodeUnknownOption(Schema.fromJsonString(CleanupRecord));

export interface ProviderAccountsShape {
  readonly add: (
    input: ProviderAccountAddInput,
  ) => Effect.Effect<{ readonly instanceId: ProviderInstanceId }, ProviderAccountError>;
  readonly remove: (input: ProviderAccountRemoveInput) => Effect.Effect<void, ProviderAccountError>;
}

export class ProviderAccounts extends Context.Service<ProviderAccounts, ProviderAccountsShape>()(
  "threadlines/provider/accounts/ProviderAccounts",
) {}

const fail = (reason: ProviderAccountError["reason"], detail: string) =>
  Effect.fail(new ProviderAccountError({ reason, detail }));

function readConfigString(config: unknown, key: string): string {
  if (config === null || typeof config !== "object") return "";
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

/** `work` from "Work", `my_team` from "My team!"; empty for names with no latin letters. */
export function slugifyAccountName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
}

/**
 * A new, never-used instance id: old threads keep pointing at a removed id,
 * so reusing one would hand them to a different account.
 */
export function allocateAccountInstanceId(input: {
  readonly driver: string;
  readonly displayName: string;
  readonly taken: (id: string) => boolean;
  readonly random?: () => string;
}): ProviderInstanceId {
  const random = input.random ?? (() => randomBytes(3).toString("hex"));
  const slug = slugifyAccountName(input.displayName) || "account";
  for (;;) {
    const id = `${input.driver}_${slug}_${random()}`;
    if (!input.taken(id)) return ProviderInstanceId.make(id);
  }
}

/** True when `child` is `parent` or inside it (both canonical). */
function isWithin(path: Path.Path, parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export const makeProviderAccounts = Effect.fn("makeProviderAccounts")(function* () {
  const settingsService = yield* ServerSettingsService;
  const registry = yield* ProviderInstanceRegistry;
  const authSessions = yield* ProviderAuthSessions;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const accountsRoot = path.join(serverConfig.stateDir, ACCOUNTS_DIRECTORY);
  const cleanupRoot = path.join(accountsRoot, CLEANUP_DIRECTORY);
  const managedFolderFor = (instanceId: string) => path.join(accountsRoot, instanceId);

  /** `realpath` of the nearest existing ancestor, with the rest appended. */
  const canonicalize = (target: string): Effect.Effect<string> =>
    Effect.gen(function* () {
      let existing = path.resolve(target);
      const rest: string[] = [];
      for (;;) {
        const real = yield* fileSystem.realPath(existing).pipe(Effect.option);
        if (Option.isSome(real)) return path.join(real.value, ...rest.toReversed());
        const parent = path.dirname(existing);
        if (parent === existing) return path.resolve(target);
        rest.push(path.basename(existing));
        existing = parent;
      }
    });

  const retiredRoot = path.join(accountsRoot, RETIRED_DIRECTORY);

  /** Ids of removed accounts: never handed out again, so old threads can't point at a new account. */
  const readRetiredIds = fileSystem.readDirectory(retiredRoot).pipe(
    Effect.map((names) => new Set(names)),
    Effect.orElseSucceed(() => new Set<string>()),
  );

  const retireInstanceId = (instanceId: string) =>
    fileSystem
      .makeDirectory(retiredRoot, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.andThen(fileSystem.writeFileString(path.join(retiredRoot, instanceId), "")),
        Effect.ignore,
      );

  /**
   * Every folder an instance keeps a login in, resolved the way its driver
   * resolves it (its own environment included), so an account can't be
   * pointed at another instance's sign-in.
   */
  const credentialFoldersOf = (instanceId: string, instance: ProviderInstanceConfig) =>
    Effect.gen(function* () {
      const environment = mergeProviderInstanceEnvironment(instance.environment ?? []);
      switch (String(instance.driver)) {
        case "claudeAgent":
          return [
            yield* resolveClaudeConfigDir(
              {
                homePath: readConfigString(instance.config, "homePath"),
                accountFolder: readConfigString(instance.config, "accountFolder"),
              },
              environment,
            ),
          ];
        case "codex": {
          const decoded = decodeCodexSettingsOption(instance.config ?? {});
          if (Option.isNone(decoded)) return [];
          const layout = yield* resolveCodexHomeLayout(decoded.value);
          const environmentHome = environment.CODEX_HOME?.trim();
          return [
            layout.sharedHomePath,
            ...(layout.effectiveHomePath ? [layout.effectiveHomePath] : []),
            ...(environmentHome ? [path.resolve(environmentHome)] : []),
          ];
        }
        case "opencode": {
          const accountFolder = readConfigString(instance.config, "accountFolder");
          if (accountFolder) return [path.resolve(expandHomePath(accountFolder))];
          const dataHome =
            environment.XDG_DATA_HOME?.trim() || path.join(NodeOS.homedir(), ".local", "share");
          return [path.join(dataHome, "opencode")];
        }
        case "antigravity":
          return [antigravityInstancePaths(serverConfig.stateDir, instanceId).profileDir];
        default:
          return [];
      }
    });

  /**
   * Validates a folder the user chose against the given settings; returns its
   * canonical form. Run again inside the settings write, so two adds can't
   * both claim one folder.
   */
  const validateChosenFolder = (input: {
    readonly folder: string;
    readonly settings: ServerSettings;
  }) =>
    Effect.gen(function* () {
      const chosen = yield* canonicalize(expandHomePath(input.folder));
      if (isWithin(path, yield* canonicalize(accountsRoot), chosen)) {
        return yield* fail(
          "invalidFolder",
          "That folder belongs to Threadlines. Pick another one.",
        );
      }
      for (const [instanceId, instance] of Object.entries(
        deriveProviderInstanceConfigMap(input.settings),
      )) {
        for (const folder of yield* credentialFoldersOf(instanceId, instance)) {
          const other = yield* canonicalize(folder);
          if (isWithin(path, chosen, other) || isWithin(path, other, chosen)) {
            return yield* fail(
              "invalidFolder",
              `That folder overlaps the one ${instance.displayName ?? instanceId} signs in with. Pick an empty folder or a new one.`,
            );
          }
        }
      }
      return chosen;
    });

  /** Polls the registry; `false` when it didn't get there in time. */
  const waitForInstance = (instanceId: ProviderInstanceId, present: boolean) =>
    Effect.gen(function* () {
      for (;;) {
        if (((yield* registry.getInstance(instanceId)) !== undefined) === present) return true;
        if (present) {
          const unavailable = yield* registry.listUnavailable;
          if (unavailable.some((provider) => provider.instanceId === instanceId)) return false;
        }
        yield* Effect.sleep(Duration.millis(100));
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: INSTANCE_READY_TIMEOUT,
        orElse: () => Effect.succeed(false),
      }),
    );

  const writeFileAtomically = (target: string, contents: string) =>
    Effect.gen(function* () {
      const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
      yield* fileSystem.writeFileString(temp, contents);
      yield* fileSystem.rename(temp, target);
    });

  /** Exactly `<accounts>/<instanceId>`, not redirected anywhere, and marked as this account's. */
  const isManagedFolder = (instanceId: string, folder: string) =>
    Effect.gen(function* () {
      if (!folder) return false;
      const expected = path.resolve(managedFolderFor(instanceId));
      if (
        (yield* canonicalize(expected)) !==
        (yield* canonicalize(accountsRoot)) + path.sep + instanceId
      ) {
        return false;
      }
      if ((yield* canonicalize(expandHomePath(folder))) !== (yield* canonicalize(expected))) {
        return false;
      }
      const marker = yield* fileSystem
        .readFileString(path.join(expected, MARKER_FILE))
        .pipe(Effect.option);
      if (Option.isNone(marker)) return false;
      const decoded = decodeAccountMarker(marker.value);
      return Option.isSome(decoded) && decoded.value.instanceId === instanceId;
    });

  /** Antigravity's profile and temp root, exactly where Threadlines puts them. */
  const isOwnedAntigravityFolder = (instanceId: string, folder: string) =>
    Effect.gen(function* () {
      const paths = antigravityInstancePaths(serverConfig.stateDir, instanceId);
      if (folder !== paths.profileDir && folder !== paths.tempRoot) return false;
      return (
        (yield* canonicalize(folder)) ===
        (yield* canonicalize(path.dirname(folder))) + path.sep + path.basename(folder)
      );
    });

  const isOwnedFolder = (record: CleanupRecord, folder: string) =>
    record.driver === "antigravity"
      ? isOwnedAntigravityFolder(record.instanceId, folder)
      : isManagedFolder(record.instanceId, folder);

  /** Fails unless the agent's own CLI confirmed the sign-out. */
  const signOut = (record: CleanupRecord) =>
    Effect.gen(function* () {
      const folder = record.signOutFolder;
      if (!folder) return;
      const isClaude = record.driver === "claudeAgent";
      // Never let a sign-out follow a link into another folder's login; if a
      // link can't be removed, the sign-out doesn't run.
      for (const entryName of isClaude
        ? [".credentials.json", ".claude.json"]
        : ["auth.json", "secrets"]) {
        yield* removeLinkIfPresent({ fileSystem, accountPath: folder, entryName });
      }
      const command = buildProviderSignOutCommand({
        driver: record.driver,
        binaryPath: record.binaryPath,
        homePath: record.homePath,
        ...(isClaude ? { accountFolder: folder } : { shadowHomePath: folder }),
      });
      if (!command) return;
      const baseEnv = isClaude
        ? claudeInstanceBaseEnvironment({ accountFolder: folder })
        : process.env;
      const env: NodeJS.ProcessEnv = { ...baseEnv, ...command.env };
      if (isClaude) delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
      const result = yield* spawnAndCollect(
        command.file,
        ChildProcess.make(command.file, [...command.args], { shell: false, env }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.timeoutOption(SIGN_OUT_TIMEOUT),
      );
      if (Option.isNone(result)) {
        return yield* Effect.fail(new Error(`${command.file} sign-out timed out`));
      }
      // Both CLIs exit 0 when there was nothing to sign out of.
      if (result.value.code !== 0) {
        return yield* Effect.fail(
          new Error(`${command.file} sign-out exited ${result.value.code}`),
        );
      }
    });

  /**
   * Checks ownership, then signs out, then deletes. A folder that is no longer
   * Threadlines' own is neither signed out nor deleted, and its record is
   * dropped. Any failure keeps the record for the next start.
   */
  const runCleanup = (record: CleanupRecord, recordPath: string) =>
    Effect.gen(function* () {
      const owned: string[] = [];
      for (const folder of record.folders) {
        if (yield* isOwnedFolder(record, folder)) owned.push(folder);
      }
      if (owned.length === 0) {
        yield* Effect.logWarning("provider account cleanup skipped: folder is not Threadlines'", {
          instanceId: record.instanceId,
        });
        yield* fileSystem.remove(recordPath, { force: true });
        return;
      }
      if (record.signOutFolder && owned.includes(record.signOutFolder)) {
        yield* signOut(record);
      }
      for (const folder of owned) {
        yield* fileSystem.remove(folder, { recursive: true, force: true });
      }
      yield* fileSystem.remove(recordPath, { force: true });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider account cleanup will be retried at next start", {
          instanceId: record.instanceId,
          cause,
        }),
      ),
    );

  const resumePendingCleanups = Effect.gen(function* () {
    const names = yield* fileSystem.readDirectory(cleanupRoot).pipe(Effect.orElseSucceed(() => []));
    if (names.length === 0) return;
    const settings = yield* settingsService.getSettings;
    const configured = deriveProviderInstanceConfigMap(settings);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const recordPath = path.join(cleanupRoot, name);
      const raw = yield* fileSystem.readFileString(recordPath).pipe(Effect.option);
      const record = Option.isSome(raw) ? decodeCleanupRecord(raw.value) : Option.none();
      if (Option.isNone(record)) continue;
      // Still in settings (a removal whose settings write failed): not ours to clean.
      if (record.value.instanceId in configured) continue;
      yield* runCleanup(record.value, recordPath);
    }
  });

  const add: ProviderAccountsShape["add"] = (input) =>
    Effect.gen(function* () {
      const driver = String(input.driver);
      const driverKind = ProviderDriverKind.make(driver);
      if (!supportsProviderAccounts(driver)) {
        return yield* fail("unsupportedDriver", "This agent can't hold more than one account yet.");
      }
      const folderField = providerAccountFolderField(driver);
      if (input.folder !== undefined && folderField === null) {
        return yield* fail(
          "invalidFolder",
          "This agent keeps each account in a folder of its own.",
        );
      }

      const current = yield* settingsService.getSettings.pipe(
        Effect.mapError(
          () =>
            new ProviderAccountError({
              reason: "settingsFailed",
              detail: "Settings could not be read.",
            }),
        ),
      );
      const chosenFolder =
        input.folder !== undefined
          ? yield* validateChosenFolder({ folder: input.folder, settings: current })
          : undefined;

      const retired = yield* readRetiredIds;
      const taken = (id: string) =>
        retired.has(id) ||
        id in deriveProviderInstanceConfigMap(current) ||
        id in (current.providerInstances ?? {});
      let instanceId = allocateAccountInstanceId({ driver, displayName: input.displayName, taken });
      let createdFolder: string | undefined;
      if (folderField !== null && chosenFolder === undefined) {
        yield* fileSystem.makeDirectory(accountsRoot, { recursive: true, mode: 0o700 }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAccountError({
                reason: "folderFailed",
                detail: `Could not create '${accountsRoot}': ${String(cause)}`,
              }),
          ),
        );
        // Exclusive create: a leftover folder from an earlier account means a new id.
        for (;;) {
          const folder = managedFolderFor(instanceId);
          const made = yield* fileSystem.makeDirectory(folder, { mode: 0o700 }).pipe(Effect.result);
          if (made._tag === "Success") {
            createdFolder = folder;
            break;
          }
          if (!(yield* fileSystem.exists(folder).pipe(Effect.orElseSucceed(() => false)))) {
            return yield* fail("folderFailed", `Could not create the account folder '${folder}'.`);
          }
          const previous = instanceId;
          instanceId = allocateAccountInstanceId({
            driver,
            displayName: input.displayName,
            taken: (id) => taken(id) || id === previous,
          });
        }
        yield* writeFileAtomically(
          path.join(createdFolder, MARKER_FILE),
          JSON.stringify({ instanceId, driver }),
        ).pipe(
          Effect.mapError(
            () =>
              new ProviderAccountError({
                reason: "folderFailed",
                detail: "Could not mark the account folder.",
              }),
          ),
        );
      } else if (chosenFolder !== undefined) {
        yield* fileSystem.makeDirectory(chosenFolder, { recursive: true, mode: 0o700 }).pipe(
          Effect.mapError(
            () =>
              new ProviderAccountError({
                reason: "invalidFolder",
                detail: `Could not create '${chosenFolder}'.`,
              }),
          ),
        );
      }
      const accountFolder = createdFolder ?? chosenFolder;

      const write = settingsService.updateSettingsWith((latest) =>
        Effect.gen(function* () {
          const instances = deriveProviderInstanceConfigMap(latest);
          if (instanceId in instances) {
            return yield* fail("settingsFailed", "That account id is already in use. Try again.");
          }
          // Against the settings being written, so a concurrent add can't
          // take the same folder between the first check and this write.
          if (chosenFolder !== undefined) {
            yield* validateChosenFolder({ folder: chosenFolder, settings: latest });
          }
          const defaults = instances[defaultInstanceIdForDriver(driverKind)]?.config;
          // Same CLI, and for Claude and Codex the same main folder, as the
          // agent's own row, so the account shares its settings and history.
          const inherited = Object.fromEntries(
            ["binaryPath", ...(driver === "claudeAgent" || driver === "codex" ? ["homePath"] : [])]
              .map((key) => [key, readConfigString(defaults, key)] as const)
              .filter(([, value]) => value.length > 0),
          );
          const instance: ProviderInstanceConfig = {
            driver: driverKind,
            displayName: input.displayName,
            ...(input.accentColor ? { accentColor: input.accentColor } : {}),
            enabled: true,
            config: {
              ...inherited,
              ...(folderField !== null && accountFolder ? { [folderField]: accountFolder } : {}),
            },
          };
          return { providerInstances: { ...latest.providerInstances, [instanceId]: instance } };
        }).pipe(Effect.provideService(Path.Path, path)),
      );
      yield* write.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (createdFolder) {
              yield* fileSystem
                .remove(createdFolder, { recursive: true, force: true })
                .pipe(Effect.ignore);
            }
            const failure = Cause.squash(cause);
            if (failure instanceof ProviderAccountError) return yield* Effect.fail(failure);
            yield* Effect.logWarning("adding a provider account failed", { cause });
            return yield* fail("settingsFailed", "The account could not be saved.");
          }),
        ),
      );

      // The account is saved either way; a slow or failed start shows on its
      // own row, where signing in can be retried, rather than as a failed add
      // that a retry would turn into a second account.
      if (!(yield* waitForInstance(instanceId, true))) {
        yield* Effect.logWarning("provider account added but not running yet", { instanceId });
      }
      return { instanceId };
    }).pipe(Effect.provideService(Path.Path, path));

  const remove: ProviderAccountsShape["remove"] = (input) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make(String(input.instanceId));
      const current = yield* settingsService.getSettings.pipe(
        Effect.mapError(
          () =>
            new ProviderAccountError({
              reason: "settingsFailed",
              detail: "Settings could not be read.",
            }),
        ),
      );
      const instance = deriveProviderInstanceConfigMap(current)[instanceId];
      if (!instance) return yield* fail("unknownInstance", "That account no longer exists.");
      const driver = String(instance.driver);
      if (
        instanceId === defaultInstanceIdForDriver(instance.driver) ||
        !(instanceId in (current.providerInstances ?? {}))
      ) {
        return yield* fail("notAnAccount", "An agent's own row can be turned off, not removed.");
      }

      const folderField = providerAccountFolderField(driver);
      const folder = folderField ? readConfigString(instance.config, folderField) : "";
      const managed = folder ? yield* isManagedFolder(instanceId, folder) : false;
      const antigravity =
        driver === "antigravity"
          ? antigravityInstancePaths(serverConfig.stateDir, instanceId)
          : undefined;
      const record: CleanupRecord | undefined = antigravity
        ? {
            instanceId,
            driver,
            folders: [antigravity.profileDir, antigravity.tempRoot],
            binaryPath: "",
            homePath: "",
          }
        : managed
          ? {
              instanceId,
              driver,
              folders: [path.resolve(expandHomePath(folder))],
              // OpenCode's login lives in the folder's database: deleting it is the sign-out.
              ...(driver === "opencode"
                ? {}
                : { signOutFolder: path.resolve(expandHomePath(folder)) }),
              binaryPath: readConfigString(instance.config, "binaryPath"),
              homePath: readConfigString(instance.config, "homePath"),
            }
          : undefined;
      const recordPath = path.join(cleanupRoot, `${instanceId}.json`);
      if (record) {
        yield* fileSystem.makeDirectory(cleanupRoot, { recursive: true, mode: 0o700 }).pipe(
          Effect.andThen(writeFileAtomically(recordPath, JSON.stringify(record))),
          Effect.mapError(
            () =>
              new ProviderAccountError({
                reason: "folderFailed",
                detail: "Could not prepare the account's cleanup.",
              }),
          ),
        );
      }

      // Stop everything that could still use (or recreate) the folder: the
      // sign-in run, then the instance itself. Once the instance is out of
      // settings no new sign-in can start, so a second stop catches one that
      // started in between.
      yield* authSessions.stop({ instanceId }).pipe(Effect.ignore);
      yield* settingsService
        .updateSettingsWith((latest) => {
          const { [instanceId]: _removed, ...rest } = latest.providerInstances ?? {};
          return Effect.succeed({
            providerInstances: rest,
            ...(latest.textGenerationBackupModelSelection?.instanceId === instanceId
              ? { textGenerationBackupModelSelection: null }
              : {}),
          });
        })
        .pipe(
          Effect.mapError(
            () =>
              new ProviderAccountError({
                reason: "settingsFailed",
                detail: "The account could not be removed from settings.",
              }),
          ),
        );
      yield* retireInstanceId(instanceId);
      yield* authSessions.stop({ instanceId }).pipe(Effect.ignore);
      if (!(yield* waitForInstance(instanceId, false))) {
        // The record stays; the next start finishes the job.
        yield* Effect.logWarning("provider account still running after removal", { instanceId });
        return;
      }
      if (record) yield* runCleanup(record, recordPath);
    }).pipe(Effect.provideService(Path.Path, path));

  yield* resumePendingCleanups.pipe(Effect.ignore, Effect.forkDetach);

  return { add, remove } satisfies ProviderAccountsShape;
});

export const ProviderAccountsLive = Layer.effect(ProviderAccounts, makeProviderAccounts());
