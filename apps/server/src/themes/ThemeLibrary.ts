/**
 * This computer's theme library (docs/design/custom-themes.md, "Storage and
 * devices"): the entries the user names, keeps and deletes, and the content
 * they name, stored once per hash.
 *
 * Every change to an entry sets its revision to one more than the highest
 * this computer has seen and stamps this computer's environment id, so the
 * higher `(revision, revisedBy)` wins everywhere (packages/shared
 * themes/library.ts). A delete is a tombstone, kept so computers converge.
 * `merge` takes an entry from another computer and keeps whichever copy
 * wins. Changes run one at a time.
 *
 * Content stays while any entry names it, tombstones included; nothing here
 * deletes content yet (a device may still use a theme deleted elsewhere).
 *
 * An entry kept from an agent's chat offer remembers it (`offerKey`, set on
 * save, never changed, kept through merges, filled in by a replace when an
 * older build left it out), and `replace` gives it a later version of that
 * offer. Like a rename, a replace made on a computer that
 * hasn't heard of a delete made elsewhere is a later revision, so it wins and
 * brings the entry back; the app only offers it for an entry that its
 * connected computers show as kept.
 *
 * A save, an update (`replace`, a later version kept over an earlier one) and
 * a delete made here are counted (`theme.saved`, `theme.deleted`,
 * docs/telemetry.md), a save of a theme from the Showcase as its origin; an
 * entry merged from another computer is not, since that computer counted it.
 */
import { randomUUID } from "node:crypto";

import {
  type ThemeContent,
  type ThemeEntry,
  type ThemeEntryIdInput,
  type ThemeEntrySummary,
  ThemeError,
  type ThemeLibrarySnapshot,
  type ThemeManifest,
  type ThemeMergeInput,
  type ThemeMergePickInput,
  type ThemePick,
  type ThemePickInput,
  type ThemeReadInput,
  type ThemeRenameInput,
  type ThemeReplaceInput,
  type ThemeSaveInput,
} from "@threadlines/contracts";
import {
  compareThemeRevisions,
  nextThemeRevision,
  sameThemePickTheme,
  themeOfferKey,
} from "@threadlines/shared/themeLibrary";
import { checkThemeManifest, themeContentHash } from "@threadlines/shared/themeManifest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { themeAnalyticsProperties } from "../telemetry/AnalyticsProperties.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import { ThemeLibraryRepository } from "./ThemeLibraryRepository.ts";
import { ThemeShowcase } from "./ThemeShowcase.ts";
import { themeProblems, ThemeWorkshop } from "./ThemeWorkshop.ts";

export interface ThemeLibraryShape {
  readonly snapshot: Effect.Effect<ThemeLibrarySnapshot, ThemeError>;
  /** The snapshot now, then again after every change. */
  readonly changes: Stream.Stream<ThemeLibrarySnapshot, ThemeError>;
  readonly read: (input: ThemeReadInput) => Effect.Effect<ThemeContent, ThemeError>;
  /** A new entry for a theme: checked, fonts embedded, a fresh entry id. */
  readonly save: (input: ThemeSaveInput) => Effect.Effect<ThemeEntrySummary, ThemeError>;
  readonly rename: (input: ThemeRenameInput) => Effect.Effect<ThemeEntrySummary, ThemeError>;
  /**
   * A later version of the theme an entry holds (an agent's new version of an
   * offer kept before): checked, fonts embedded, the same entry and name with
   * the new content, at a new revision.
   */
  readonly replace: (input: ThemeReplaceInput) => Effect.Effect<ThemeEntrySummary, ThemeError>;
  /** Tombstones an entry; deleting a tombstone changes nothing. */
  readonly delete: (input: ThemeEntryIdInput) => Effect.Effect<ThemeEntrySummary, ThemeError>;
  /** Brings a tombstoned entry back; restoring a live one changes nothing. */
  readonly restore: (input: ThemeEntryIdInput) => Effect.Effect<ThemeEntrySummary, ThemeError>;
  /** Keeps whichever of this computer's copy and the given one wins the revision order. */
  readonly merge: (input: ThemeMergeInput) => Effect.Effect<ThemeEntrySummary, ThemeError>;
  /**
   * Makes a theme the shared pick ("Same theme on all my devices") at a
   * revision above any the device has seen; the same theme, already picked
   * above that, changes nothing, and with `onlyIfNone` (a device joining)
   * neither does any pick already there.
   */
  readonly pick: (input: ThemePickInput) => Effect.Effect<ThemePick, ThemeError>;
  /** Keeps whichever shared pick wins the revision order, storing the theme's content if sent. */
  readonly mergePick: (input: ThemeMergePickInput) => Effect.Effect<ThemePick, ThemeError>;
}

export class ThemeLibrary extends Context.Service<ThemeLibrary, ThemeLibraryShape>()(
  "threadlines/themes/ThemeLibrary",
) {}

const STORAGE_DETAIL = "Threadlines couldn't read or save the theme library. Try again.";
const storageError = () => new ThemeError({ detail: STORAGE_DETAIL });
const missingEntry = () =>
  new ThemeError({ detail: "That theme isn't in this computer's library." });

const make = Effect.gen(function* () {
  const repo = yield* ThemeLibraryRepository;
  const workshop = yield* ThemeWorkshop;
  const environment = yield* ServerEnvironment;
  const analytics = yield* AnalyticsService;
  // Optional, so a library without the Showcase (tests) still runs: it only says which saves came from it.
  const showcase = yield* Effect.serviceOption(ThemeShowcase);
  const scope = yield* Effect.scope;
  const writes = yield* Semaphore.make(1);
  const changed = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(changed, undefined).pipe(Effect.asVoid);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const stored = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.mapError(storageError));

  const snapshot: ThemeLibraryShape["snapshot"] = Effect.gen(function* () {
    const entries = yield* repo.listSummaries;
    const pick = Option.getOrNull(yield* repo.getPick);
    // A library pick that arrived without its content says so, for a client to send it again.
    const hash = pick?.theme.kind === "library" ? pick.theme.hash : undefined;
    if (hash === undefined) return { entries, pick };
    return { entries, pick, pickHasContent: yield* repo.hasContent(hash) };
  }).pipe(stored);

  const changes: ThemeLibraryShape["changes"] = Stream.concat(
    Stream.make(undefined),
    Stream.fromPubSub(changed),
  ).pipe(
    Stream.debounce(Duration.millis(100)),
    Stream.mapEffect(() => snapshot),
  );

  const summaryOf = (entryId: string) =>
    repo
      .getSummary(entryId)
      .pipe(
        stored,
        Effect.flatMap(
          Option.match({ onNone: () => Effect.fail(missingEntry()), onSome: Effect.succeed }),
        ),
      );

  /**
   * Stores content that isn't here yet. A theme with art and no thumbnail
   * (new, or one an earlier save couldn't make) then gets its thumbnail in the
   * background, and the library changes again once it has.
   */
  const storeContent = (hash: string, manifest: ThemeManifest) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      yield* repo.insertContent({ hash, manifest, createdAt }).pipe(stored);
      if (manifest.backdrop !== undefined && (yield* repo.lacksThumbnail(hash).pipe(stored))) {
        yield* workshop.thumbnail(manifest).pipe(
          Effect.flatMap((thumbnail) =>
            thumbnail === null
              ? Effect.void
              : repo.setThumbnail({ hash, thumbnail }).pipe(Effect.andThen(notify)),
          ),
          Effect.ignore({ log: true }),
          Effect.forkIn(scope),
        );
      }
    });

  /** The next revision this computer gives a change (entries and the pick count alike), stamped as its own. */
  const nextRevision = Effect.gen(function* () {
    const entries = yield* repo.listEntries.pipe(stored);
    const pick = yield* repo.getPick.pipe(stored);
    const revisedBy = yield* environment.getEnvironmentId;
    return { revision: nextThemeRevision([...entries, ...Option.toArray(pick)]), revisedBy };
  });

  /** Runs one change to the library, then tells subscribers. */
  const write = <A>(effect: Effect.Effect<A, ThemeError>) =>
    writes
      .withPermits(1)(effect)
      .pipe(Effect.tap(() => notify));

  const hashOf = (manifest: ThemeManifest) => Effect.promise(() => themeContentHash(manifest));

  const read: ThemeLibraryShape["read"] = (input) =>
    repo.getContent(input.hash).pipe(
      stored,
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new ThemeError({ detail: "That theme isn't stored on this computer." })),
          onSome: (row) => Effect.succeed({ hash: row.hash, manifest: row.manifest }),
        }),
      ),
    );

  const save: ThemeLibraryShape["save"] = (input) =>
    Effect.gen(function* () {
      const manifest = yield* workshop.prepare(input.manifest);
      const hash = yield* hashOf(manifest);
      const { summary, copy } = yield* write(
        Effect.gen(function* () {
          // Another entry in use names the same content: a Duplicate, or a theme kept twice.
          const copy = (yield* repo.listEntries.pipe(stored)).some(
            (entry) => entry.hash === hash && !entry.deleted,
          );
          yield* storeContent(hash, manifest);
          const now = yield* nowIso;
          const entry: ThemeEntry = {
            entryId: randomUUID(),
            name: input.name ?? manifest.name,
            hash,
            ...(yield* nextRevision),
            deleted: false,
            createdAt: now,
            updatedAt: now,
            offerKey: themeOfferKey(manifest),
          };
          yield* repo.putEntry(entry).pipe(stored);
          return { summary: yield* summaryOf(entry.entryId), copy };
        }),
      );
      const fromShowcase = Option.isSome(showcase) && (yield* showcase.value.listed(hash));
      yield* analytics.record("theme.saved", {
        ...themeAnalyticsProperties(manifest),
        ...(fromShowcase ? { origin: "showcase" } : {}),
        copy,
      });
      return summary;
    });

  /** Changes one entry at a new revision; `change` returns null to leave it as it is. */
  const revise = (
    entryId: string,
    change: (entry: ThemeEntry) => Effect.Effect<Partial<ThemeEntry> | null, ThemeError>,
  ) =>
    write(
      Effect.gen(function* () {
        const entry = yield* repo
          .getEntry(entryId)
          .pipe(
            stored,
            Effect.flatMap(
              Option.match({ onNone: () => Effect.fail(missingEntry()), onSome: Effect.succeed }),
            ),
          );
        const fields = yield* change(entry);
        if (fields !== null) {
          yield* repo
            .putEntry({
              ...entry,
              ...fields,
              ...(yield* nextRevision),
              updatedAt: yield* nowIso,
            })
            .pipe(stored);
        }
        return yield* summaryOf(entryId);
      }),
    );

  const rename: ThemeLibraryShape["rename"] = (input) =>
    revise(input.entryId, (entry) =>
      entry.deleted
        ? Effect.fail(
            new ThemeError({ detail: "That theme was deleted. Restore it to rename it." }),
          )
        : Effect.succeed(entry.name === input.name ? null : { name: input.name }),
    );

  const replace: ThemeLibraryShape["replace"] = (input) =>
    Effect.gen(function* () {
      const manifest = yield* workshop.prepare(input.manifest);
      const hash = yield* hashOf(manifest);
      const changed = { yes: false };
      const summary = yield* revise(input.entryId, (entry) =>
        Effect.gen(function* () {
          if (entry.deleted) {
            return yield* new ThemeError({
              detail: "That theme was deleted. Restore it to update it.",
            });
          }
          if (entry.hash === hash) return null;
          yield* storeContent(hash, manifest);
          changed.yes = true;
          // An entry an older build saved or merged doesn't know its offer yet: this version says it.
          return { hash, offerKey: entry.offerKey ?? themeOfferKey(manifest) };
        }),
      );
      // Counted as a keep, saying it updated a copy rather than adding one.
      if (changed.yes) {
        yield* analytics.record("theme.saved", {
          ...themeAnalyticsProperties(manifest),
          copy: false,
          updated: true,
        });
      }
      return summary;
    });

  const remove: ThemeLibraryShape["delete"] = (input) =>
    Effect.gen(function* () {
      const removed: { hash: string | null } = { hash: null };
      const summary = yield* revise(input.entryId, (entry) => {
        if (entry.deleted) return Effect.succeed(null);
        removed.hash = entry.hash;
        return Effect.succeed({ deleted: true });
      });
      if (removed.hash !== null) {
        const content = yield* repo
          .getContent(removed.hash)
          .pipe(Effect.catch(() => Effect.succeed(Option.none())));
        yield* analytics.record(
          "theme.deleted",
          Option.isSome(content) ? themeAnalyticsProperties(content.value.manifest) : {},
        );
      }
      return summary;
    });

  const restore: ThemeLibraryShape["restore"] = (input) =>
    revise(input.entryId, (entry) => Effect.succeed(entry.deleted ? { deleted: false } : null));

  const merge: ThemeLibraryShape["merge"] = (input) =>
    Effect.gen(function* () {
      const incoming = input.entry;
      const local = yield* repo.getEntry(incoming.entryId).pipe(stored);
      if (Option.isSome(local) && compareThemeRevisions(local.value, incoming) >= 0) {
        return yield* summaryOf(incoming.entryId);
      }
      // The incoming copy wins: it needs its content here.
      const held = yield* repo.getContent(incoming.hash).pipe(stored);
      let content: ThemeManifest | undefined;
      if (Option.isNone(held)) {
        if (input.manifest === undefined) {
          return yield* new ThemeError({
            detail: "This computer doesn't have that theme's content. Send the theme with it.",
          });
        }
        const check = checkThemeManifest(input.manifest);
        if (!check.ok) return yield* themeProblems(check.errors);
        if ((yield* hashOf(check.manifest)) !== incoming.hash) {
          return yield* new ThemeError({
            detail: "The theme sent with that entry isn't the content the entry names.",
          });
        }
        // Stored as sent: its hash names these exact bytes (fonts included),
        // and another computer's library already embedded them.
        content = check.manifest;
      }
      return yield* write(
        Effect.gen(function* () {
          // Re-read under the lock: a change here may have landed meanwhile.
          const current = yield* repo.getEntry(incoming.entryId).pipe(stored);
          if (Option.isSome(current) && compareThemeRevisions(current.value, incoming) >= 0) {
            return yield* summaryOf(incoming.entryId);
          }
          if (content !== undefined) yield* storeContent(incoming.hash, content);
          // An entry's offer never changes, so one a computer didn't send (an older build) stays.
          const offerKey = incoming.offerKey ?? Option.getOrUndefined(current)?.offerKey ?? null;
          yield* repo.putEntry({ ...incoming, offerKey }).pipe(stored);
          return yield* summaryOf(incoming.entryId);
        }),
      );
    });

  const pick: ThemeLibraryShape["pick"] = (input) =>
    write(
      Effect.gen(function* () {
        const current = Option.getOrNull(yield* repo.getPick.pipe(stored));
        // A device joining the others takes the pick there is, whatever it shows itself.
        if (current !== null && input.onlyIfNone === true) return current;
        if (
          current !== null &&
          sameThemePickTheme(current.theme, input.theme) &&
          current.revision > input.atLeast
        ) {
          return current;
        }
        const next = yield* nextRevision;
        const picked: ThemePick = {
          theme: input.theme,
          revision: Math.max(next.revision, input.atLeast + 1),
          revisedBy: next.revisedBy,
          updatedAt: yield* nowIso,
        };
        yield* repo.putPick(picked).pipe(stored);
        return picked;
      }),
    );

  const mergePick: ThemeLibraryShape["mergePick"] = (input) =>
    Effect.gen(function* () {
      const incoming = input.pick;
      const hash = incoming.theme.kind === "library" ? incoming.theme.hash : undefined;
      // A library pick's content, for a computer that lacks it: checked like a merged entry's.
      let content: ThemeManifest | undefined;
      if (input.manifest !== undefined && hash !== undefined) {
        const held = yield* repo.getContent(hash).pipe(stored);
        if (Option.isNone(held)) {
          const check = checkThemeManifest(input.manifest);
          if (!check.ok) return yield* themeProblems(check.errors);
          if ((yield* hashOf(check.manifest)) !== hash) {
            return yield* new ThemeError({
              detail: "The theme sent with that pick isn't the content the pick names.",
            });
          }
          content = check.manifest;
        }
      }
      return yield* write(
        Effect.gen(function* () {
          // Content sent is kept whichever pick wins: a pick already here may be missing it.
          if (content !== undefined && hash !== undefined) yield* storeContent(hash, content);
          const current = Option.getOrNull(yield* repo.getPick.pipe(stored));
          if (current !== null && compareThemeRevisions(current, incoming) >= 0) return current;
          yield* repo.putPick(incoming).pipe(stored);
          return incoming;
        }),
      );
    });

  return ThemeLibrary.of({
    snapshot,
    changes,
    read,
    save,
    rename,
    replace,
    delete: remove,
    restore,
    merge,
    pick,
    mergePick,
  });
});

export const ThemeLibraryLive = Layer.effect(ThemeLibrary, make);
