/**
 * Keeping theme libraries in step across computers
 * (docs/design/custom-themes.md, "Storage and devices"). Every change to an
 * entry (save, rename, delete, restore) sets its revision to one more than the
 * highest the computer has seen; between two copies of an entry the higher
 * `(revision, revisedBy)` wins, compared the same way everywhere, so any order
 * of merges ends in the same library.
 */
import type { ThemeEntry, ThemeManifest } from "@threadlines/contracts";

type Revisioned = Pick<ThemeEntry, "revision" | "revisedBy">;

/** Positive when `first` wins, negative when `second` does, 0 for the same revision. */
export function compareThemeRevisions(first: Revisioned, second: Revisioned): number {
  if (first.revision !== second.revision) return first.revision - second.revision;
  if (first.revisedBy === second.revisedBy) return 0;
  return first.revisedBy > second.revisedBy ? 1 : -1;
}

/** The copy of one entry both computers must end up with. */
export function winningThemeEntry<T extends Revisioned>(first: T, second: T): T {
  return compareThemeRevisions(first, second) >= 0 ? first : second;
}

/** The revision the next change on this computer gets. */
export function nextThemeRevision(entries: ReadonlyArray<Revisioned>): number {
  let highest = 0;
  for (const entry of entries) if (entry.revision > highest) highest = entry.revision;
  return highest + 1;
}

export interface ThemeLibraryReconciliation<T extends ThemeEntry> {
  /** Entries the other computer lacks or holds an older copy of. */
  readonly sendToOther: ReadonlyArray<T>;
  /** Entries this computer lacks or holds an older copy of. */
  readonly takeFromOther: ReadonlyArray<T>;
}

/** What two computers' libraries must exchange to end up the same, entry by entry. */
export function reconcileThemeLibraries<T extends ThemeEntry>(
  local: ReadonlyArray<T>,
  other: ReadonlyArray<T>,
): ThemeLibraryReconciliation<T> {
  const otherById = new Map(other.map((entry) => [entry.entryId, entry]));
  const localById = new Map(local.map((entry) => [entry.entryId, entry]));
  const sendToOther: T[] = [];
  const takeFromOther: T[] = [];
  for (const entry of local) {
    const theirs = otherById.get(entry.entryId);
    if (!theirs || compareThemeRevisions(entry, theirs) > 0) sendToOther.push(entry);
  }
  for (const entry of other) {
    const ours = localById.get(entry.entryId);
    if (!ours || compareThemeRevisions(entry, ours) > 0) takeFromOther.push(entry);
  }
  return { sendToOther, takeFromOther };
}

/**
 * The chat offer a theme came from, as one key ("<thread>/<page>"): every
 * version an agent shows of one theme shares it. Null for a theme no agent
 * offered (a file, a starter, one made by hand) or from a build before offers
 * were recorded.
 */
export function themeOfferKey(manifest: ThemeManifest): string | null {
  const offer = manifest.createdBy?.offer;
  return offer === undefined ? null : `${offer.threadId}/${offer.pageId}`;
}

/**
 * The theme without the offer it came from, for a copy the user makes of it.
 * Its content hash is the same (the hash leaves createdBy out).
 */
export function themeWithoutOffer(manifest: ThemeManifest): ThemeManifest {
  if (manifest.createdBy?.offer === undefined) return manifest;
  const { offer: _offer, ...createdBy } = manifest.createdBy;
  return { ...manifest, createdBy };
}
