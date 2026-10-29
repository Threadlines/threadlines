import { advanceVersionHistory, VersionHistoryRecord } from "@threadlines/shared/releaseNotes";
import { fromLenientJson } from "@threadlines/shared/schemaJson";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as DesktopDataMigration from "./DesktopDataMigration.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";

/**
 * Which Threadlines version ran on this computer before this one, for the
 * app's "What's new": the nightly list starts after that build, and the first
 * launch of a newer version shows its notice once. It lives in the state
 * folder, not the window's localStorage, because the page's origin (and with
 * it localStorage) moves whenever the backend lands on another port.
 */
export interface DesktopVersionHistoryShape {
  /** The version that ran before this one; null on a first run, or after an older build that kept no record. */
  readonly previousVersion: string | null;
  /**
   * True for the first window that asks, once per launch, when this launch
   * is the first of a version newer than any this computer ran before.
   */
  readonly claimUpdateNotice: Effect.Effect<boolean>;
}

export class DesktopVersionHistory extends Context.Service<
  DesktopVersionHistory,
  DesktopVersionHistoryShape
>()("threadlines/desktop/VersionHistory") {}

const VersionHistoryJson = fromLenientJson(VersionHistoryRecord);
const decodeVersionHistoryJson = Schema.decodeEffect(VersionHistoryJson);
const encodeVersionHistoryJson = Schema.encodeEffect(VersionHistoryJson);

const { logWarning } = DesktopObservability.makeComponentLogger("desktop-version-history");

export const layer = Layer.effect(
  DesktopVersionHistory,
  Effect.gen(function* () {
    // The legacy data move must run first: it skips a Threadlines folder that
    // already has entries, and this writes one.
    yield* DesktopDataMigration.DesktopDataMigration;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // A dev build reports the Electron binary's version and shares no
    // history with real installs.
    if (environment.isDevelopment) {
      return DesktopVersionHistory.of({
        previousVersion: null,
        claimUpdateNotice: Effect.succeed(false),
      });
    }

    const recordPath = path.join(environment.stateDir, "version-history.json");
    const record = yield* fileSystem
      .readFileString(recordPath)
      .pipe(Effect.flatMap(decodeVersionHistoryJson), Effect.option, Effect.map(Option.getOrNull));
    // Built before the backend starts, so a fresh install has no database yet.
    const hasEarlierData =
      record === null &&
      (yield* fileSystem
        .exists(path.join(environment.stateDir, "state.sqlite"))
        .pipe(Effect.orElseSucceed(() => false)));
    const next = advanceVersionHistory({
      record,
      appVersion: environment.appVersion,
      hasEarlierData,
    });

    if (next.record !== record) {
      yield* Effect.gen(function* () {
        const suffix = (yield* randomUUIDv4).replace(/-/g, "");
        const tempPath = `${recordPath}.${process.pid}.${suffix}.tmp`;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          tempPath,
          `${yield* encodeVersionHistoryJson(next.record)}\n`,
        );
        yield* fileSystem.rename(tempPath, recordPath);
      }).pipe(
        // Without the record the next launch looks like a first run: the
        // nightly list starts at its own build and no notice repeats.
        Effect.catch((cause) =>
          logWarning("couldn't keep the version history", { cause: String(cause) }),
        ),
      );
    }

    const unclaimed = yield* Ref.make(next.newerThanAnyBefore);
    return DesktopVersionHistory.of({
      previousVersion: next.previousVersion,
      claimUpdateNotice: Ref.getAndSet(unclaimed, false),
    });
  }),
);
