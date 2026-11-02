/**
 * The in-app browser's profiles, remembered: one per environment when
 * sign-ins are shared, one per (environment, project) when they are not.
 *
 * A partition is just a directory Electron keeps under the app's data, and it
 * stays there after the project it belonged to is gone. The inventory is how
 * the desktop knows which partitions exist, so "clear all browser data" can
 * reach every one and a deleted project's profile can be forgotten. A shared
 * profile is recorded without a project, so no project's deletion forgets it.
 * Written when a partition is handed out; the file lives in the desktop state
 * dir next to the window and client settings.
 */

import {
  DesktopPreviewProfileSchema,
  type DesktopPreviewProfile,
  type DesktopPreviewProfileAssignment,
  type DesktopPreviewProfileInput,
} from "@threadlines/contracts";
import { fromJsonStringPretty } from "@threadlines/shared/schemaJson";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as PreviewSession from "./PreviewSession.ts";
import {
  isPreviewPartition,
  LEGACY_PREVIEW_PARTITION,
  previewProfilePartition,
  previewSharedPartition,
} from "./previewPartitions.ts";

export const PREVIEW_PROFILES_FILE_NAME = "preview-profiles.json";

// Entries are decoded one at a time, so one damaged entry costs that entry
// rather than the whole inventory.
const PreviewProfilesDocumentJson = fromJsonStringPretty(
  Schema.Struct({ profiles: Schema.Array(Schema.Unknown) }),
);
const decodeDocument = Schema.decodeEffect(PreviewProfilesDocumentJson);
const encodeDocument = Schema.encodeEffect(PreviewProfilesDocumentJson);
const decodeProfile = Schema.decodeUnknownOption(DesktopPreviewProfileSchema);
const encodeProfile = Schema.encodeSync(DesktopPreviewProfileSchema);

const { logWarning } = DesktopObservability.makeComponentLogger("preview-profiles");

export class PreviewProfilesWriteError extends Schema.TaggedError<PreviewProfilesWriteError>()(
  "PreviewProfilesWriteError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to save the browser profile list.";
  }
}

export class PreviewProfilesClearError extends Schema.TaggedError<PreviewProfilesClearError>()(
  "PreviewProfilesClearError",
  { partitions: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Failed to clear browser data for ${this.partitions.length} profile(s).`;
  }
}

export interface PreviewProfilesShape {
  /**
   * Where a project's tabs run (the partition, and the scope its pages carry),
   * recorded with the time it was asked for. Never fails: a profile that
   * could not be written down still works, it just cannot be reached by
   * "clear all" until the next successful write.
   */
  readonly profileFor: (
    input: DesktopPreviewProfileInput,
  ) => Effect.Effect<DesktopPreviewProfileAssignment>;
  readonly list: Effect.Effect<ReadonlyArray<DesktopPreviewProfile>>;
  /**
   * Clears everything the partition holds, then stops remembering it. The
   * entry stays when clearing fails, so the profile can still be found later.
   */
  readonly forget: (
    partition: string,
  ) => Effect.Effect<void, PreviewSession.PreviewSessionError | PreviewProfilesWriteError>;
  /** Clears every remembered profile and the legacy shared one. Keeps the entries. */
  readonly clearAll: Effect.Effect<void, PreviewProfilesClearError>;
}

export class PreviewProfiles extends Context.Service<PreviewProfiles, PreviewProfilesShape>()(
  "@threadlines/desktop/preview/PreviewProfiles",
) {}

const readProfiles = (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<ReadonlyArray<DesktopPreviewProfile>> =>
  fileSystem.readFileString(filePath, "utf-8").pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed([]),
        onSome: (raw) =>
          decodeDocument(raw).pipe(
            Effect.map((document) => {
              const byPartition = new Map<string, DesktopPreviewProfile>();
              for (const entry of document.profiles) {
                const profile = Option.getOrUndefined(decodeProfile(entry));
                if (profile !== undefined && isPreviewPartition(profile.partition)) {
                  byPartition.set(profile.partition, profile);
                }
              }
              return [...byPartition.values()];
            }),
            Effect.catch((error) =>
              logWarning("ignoring unreadable browser profile list", {
                path: filePath,
                error: String(error),
              }).pipe(Effect.as([])),
            ),
          ),
      }),
    ),
  );

const writeProfiles = Effect.fnUntraced(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly filePath: string;
  readonly profiles: ReadonlyArray<DesktopPreviewProfile>;
}): Effect.fn.Return<void, PlatformError.PlatformError | Schema.SchemaError> {
  const encoded = yield* encodeDocument({
    profiles: input.profiles.map((profile) => encodeProfile(profile)),
  });
  // Written beside the target and renamed over it, so a crash mid-write leaves
  // the previous list rather than half of one.
  const tempPath = `${input.filePath}.${process.pid}.tmp`;
  yield* input.fileSystem.makeDirectory(input.path.dirname(input.filePath), { recursive: true });
  yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`);
  yield* input.fileSystem.rename(tempPath, input.filePath);
});

export const make = Effect.gen(function* PreviewProfilesMake() {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const previewSession = yield* PreviewSession.PreviewSession;
  const filePath = path.join(environment.stateDir, PREVIEW_PROFILES_FILE_NAME);

  const profilesRef = yield* Ref.make(yield* readProfiles(fileSystem, filePath));
  // One writer at a time: each update reads the list, changes it and writes it
  // back, and two interleaved updates would drop one of them.
  const writeLock = yield* Semaphore.make(1);

  /**
   * Changes the list, inside the write lock. Memory first: a profile handed out
   * is one "clear all" must reach in this run whether or not it could be
   * written down.
   */
  const updateLocked = (
    change: (
      profiles: ReadonlyArray<DesktopPreviewProfile>,
    ) => ReadonlyArray<DesktopPreviewProfile>,
  ) =>
    Effect.gen(function* () {
      const next = change(yield* Ref.get(profilesRef));
      yield* Ref.set(profilesRef, next);
      yield* writeProfiles({ fileSystem, path, filePath, profiles: next }).pipe(
        Effect.mapError((cause) => new PreviewProfilesWriteError({ cause })),
      );
    });
  const update = (
    change: (
      profiles: ReadonlyArray<DesktopPreviewProfile>,
    ) => ReadonlyArray<DesktopPreviewProfile>,
  ) => writeLock.withPermits(1)(updateLocked(change));

  return PreviewProfiles.of({
    profileFor: Effect.fn("PreviewProfiles.profileFor")(function* (input) {
      // A page's scope is its project's own partition name, wherever it runs.
      const scope = previewProfilePartition(input.environmentId, input.projectId);
      const shared = input.shared === true;
      const partition = shared ? previewSharedPartition(input.environmentId) : scope;
      const lastUsedAt = DateTime.formatIso(yield* DateTime.now);
      yield* update((profiles) => [
        ...profiles.filter((profile) => profile.partition !== partition),
        {
          partition,
          environmentId: input.environmentId,
          ...(shared ? {} : { projectId: input.projectId }),
          lastUsedAt,
        },
      ]).pipe(
        Effect.catch((error) =>
          logWarning("failed to record browser profile", {
            partition,
            path: filePath,
            error: String(error.cause),
          }),
        ),
      );
      return { partition, scope };
    }),
    list: Ref.get(profilesRef),
    forget: Effect.fn("PreviewProfiles.forget")(function* (partition: string) {
      // Clearing and forgetting as one step under the lock, so the profile
      // cannot be handed out again in between and then dropped from the list.
      yield* writeLock.withPermits(1)(
        previewSession
          .clearAllData(partition)
          .pipe(
            Effect.andThen(
              updateLocked((profiles) =>
                profiles.filter((profile) => profile.partition !== partition),
              ),
            ),
          ),
      );
    }),
    clearAll: Effect.gen(function* () {
      const profiles = yield* Ref.get(profilesRef);
      // Remembered or not: a profile whose record was never written is still
      // on disk, signed in.
      const partitions = [
        ...new Set([
          LEGACY_PREVIEW_PARTITION,
          ...profiles.map((profile) => profile.partition),
          ...(yield* previewSession.storedPartitions),
        ]),
      ];
      // Every partition gets its turn even when one fails: stopping at the
      // first error would leave the rest signed in while reporting a failure.
      const failed: string[] = [];
      for (const partition of partitions) {
        const exit = yield* Effect.exit(previewSession.clearAllData(partition));
        if (Exit.isFailure(exit)) {
          failed.push(partition);
          yield* logWarning("failed to clear browser profile", {
            partition,
            error: String(exit.cause),
          });
        }
      }
      if (failed.length > 0) {
        return yield* new PreviewProfilesClearError({ partitions: failed });
      }
    }).pipe(Effect.withSpan("PreviewProfiles.clearAll")),
  });
}).pipe(Effect.withSpan("PreviewProfiles.make"));

export const layer = Layer.effect(PreviewProfiles, make);
