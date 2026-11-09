import {
  EnvironmentId,
  THEME_FILE_FORMAT,
  type ThemeEntrySummary,
  type ThemeLibrarySnapshot,
  type ThemeManifest,
} from "@threadlines/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { themeTileByName } from "./themeCatalog";
import { keptCopyOfOffer, libraryThemesOf, reconcileFollowedLibraries } from "./themeLibraryState";

const mac = EnvironmentId.make("env-mac");
const pc = EnvironmentId.make("env-pc");

const entry = (patch: Partial<ThemeEntrySummary>): ThemeEntrySummary => ({
  entryId: "e1",
  name: "Night",
  hash: "a".repeat(64),
  revision: 1,
  revisedBy: "env-mac",
  deleted: false,
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
  base: "dark",
  background: "#0a1029",
  foreground: "#e7ecff",
  accent: "#2fd6b0",
  backdropMode: null,
  thumbnail: null,
  ...patch,
});

const snapshot = (...entries: ThemeEntrySummary[]): ThemeLibrarySnapshot => ({ entries });

const manifest: ThemeManifest = {
  format: THEME_FILE_FORMAT,
  name: "Night",
  base: "dark",
  colors: {
    background: "#0a1029",
    foreground: "#e7ecff",
    mutedForeground: "#a3aed2",
    accent: "#2fd6b0",
    accentForeground: "#03231c",
  },
};

describe("theme library across computers", () => {
  it("shows each entry once, as its winning copy, without tombstones", () => {
    const themes = libraryThemesOf(
      {
        [mac]: snapshot(entry({}), entry({ entryId: "e2", name: "Dunes", hash: "b".repeat(64) })),
        [pc]: snapshot(
          entry({ name: "Night sky", revision: 2, revisedBy: "env-pc" }),
          entry({ entryId: "e2", name: "Dunes", hash: "b".repeat(64), deleted: true, revision: 3 }),
        ),
      },
      [{ environmentId: mac }, { environmentId: pc }],
    );
    expect(themes.map((theme) => [theme.entry.name, theme.holders])).toEqual([["Night sky", [pc]]]);
  });

  it("brings the computer with the older copy the newer one, content only when it lacks it", async () => {
    const merges: Array<{ target: string; entryId: string; withContent: boolean }> = [];
    const read = vi.fn(async () => ({ hash: "c".repeat(64), manifest }));
    const clients = (environmentId: EnvironmentId) => ({
      read,
      merge: async (input: { entry: { entryId: string }; manifest?: ThemeManifest }) => {
        merges.push({
          target: environmentId,
          entryId: input.entry.entryId,
          withContent: input.manifest !== undefined,
        });
        return entry({});
      },
    });
    reconcileFollowedLibraries(
      {
        [mac]: snapshot(
          entry({ name: "Renamed", revision: 2 }),
          entry({ entryId: "new", hash: "c".repeat(64) }),
        ),
        [pc]: snapshot(entry({})),
      },
      [mac, pc],
      clients as never,
    );
    await vi.waitFor(() => expect(merges).toHaveLength(2));
    expect(merges).toEqual(
      expect.arrayContaining([
        { target: pc, entryId: "e1", withContent: false },
        { target: pc, entryId: "new", withContent: true },
      ]),
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("tries a failed merge again later, with no new snapshot to prompt it", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const clients = () => ({
        read: async () => ({ hash: "a".repeat(64), manifest }),
        merge: async () => {
          calls += 1;
          if (calls === 1) throw new Error("connection dropped");
          return entry({});
        },
      });
      reconcileFollowedLibraries(
        { [mac]: snapshot(entry({ entryId: "retry", revision: 5 })), [pc]: snapshot() },
        [mac, pc],
        clients as never,
      );
      await vi.waitFor(() => expect(calls).toBe(1));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finds the theme an agent names: built-ins, starters by name or id, library names in any case", () => {
    const library = libraryThemesOf({ [mac]: snapshot(entry({ name: "Night Sky" })) }, [
      { environmentId: mac },
    ]);
    expect(themeTileByName("dark", library)?.key).toBe("builtin:dark");
    expect(themeTileByName("Aurora", library)?.key).toBe("starter:aurora");
    expect(themeTileByName("aurora", library)?.key).toBe("starter:aurora");
    expect(themeTileByName("night sky", library)?.key).toBe("library:e1");
    expect(themeTileByName("Nope", library)).toBeNull();
  });
});

describe("a later version of an agent's offer", () => {
  const offered = (pageId: string): ThemeManifest => ({
    ...manifest,
    createdBy: { kind: "agent", threadId: "t1", offer: { threadId: "t1", pageId } },
  });
  const kept = (
    entryId: string,
    hash: string,
    offerKey: string | null,
    revision: number,
    updatedAt = "2026-11-09T10:00:00.000Z",
  ) => ({ entry: entry({ entryId, hash, offerKey, revision, updatedAt }), holders: [mac] });

  it("updates the copy of the same offer changed last, and nothing else", () => {
    const library = [
      kept("v1", "1".repeat(64), "t1/p1", 3),
      // Changed last on a computer whose clock runs behind: revision order, not the clock.
      kept("v2", "2".repeat(64), "t1/p1", 4, "2026-11-01T00:00:00.000Z"),
      kept("other", "3".repeat(64), "t1/p2", 9),
      kept("file", "4".repeat(64), null, 9),
    ];
    expect(keptCopyOfOffer(library, offered("p1"), "5".repeat(64))?.entry.entryId).toBe("v2");
    // A first version, a theme no agent offered, or one kept exactly as it is: no update.
    expect(keptCopyOfOffer(library, offered("p9"), "5".repeat(64))).toBeNull();
    expect(keptCopyOfOffer(library, manifest, "5".repeat(64))).toBeNull();
    expect(keptCopyOfOffer(library, offered("p1"), "1".repeat(64))).toBeNull();
  });

  it("knows a kept copy's offer when only some computers do (an older build left it out)", () => {
    const knows = entry({ entryId: "v1", offerKey: "t1/p1", revision: 3 });
    const forgot = entry({ entryId: "v1", offerKey: null, revision: 3 });
    const library = libraryThemesOf({ [mac]: snapshot(forgot), [pc]: snapshot(knows) }, [
      { environmentId: mac },
      { environmentId: pc },
    ]);
    expect(library[0]?.holders).toEqual([mac, pc]);
    expect(keptCopyOfOffer(library, offered("p1"), "5".repeat(64))?.entry.entryId).toBe("v1");
  });
});
