import { ThreadId, TurnId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildMediaGroups, type MediaEntry } from "./mediaPanel.logic";

function entry(
  overrides: Partial<MediaEntry> & Pick<MediaEntry, "relativePath" | "changedAt">,
): MediaEntry {
  return {
    threadId: ThreadId.make("thread-a"),
    threadTitle: "Make the art",
    cwd: "/repo",
    repositoryPath: overrides.relativePath,
    mediaKind: "picture",
    change: "added",
    turnId: TurnId.make("turn-1"),
    checkpointTurnCount: 1,
    assistantMessageId: null,
    size: 10,
    version: "10-1",
    ...overrides,
  } as MediaEntry;
}

const ENTRIES: ReadonlyArray<MediaEntry> = [
  entry({ relativePath: "art/hero.png", changedAt: "2026-03-01T00:03:00.000Z" }),
  entry({
    relativePath: "docs/brief.pdf",
    mediaKind: "document",
    changedAt: "2026-03-01T00:02:00.000Z",
  }),
  entry({
    relativePath: "docs/notes.docx",
    mediaKind: "document",
    changedAt: "2026-03-01T00:02:30.000Z",
  }),
  entry({
    relativePath: "media/demo.mp4",
    mediaKind: "video",
    changedAt: "2026-03-01T00:00:30.000Z",
  }),
  entry({
    relativePath: "media/theme.mp3",
    mediaKind: "audio",
    changedAt: "2026-03-01T00:00:20.000Z",
  }),
  entry({
    relativePath: "art/Logo 10.png",
    changedAt: "2026-03-01T00:01:00.000Z",
    threadId: ThreadId.make("thread-b"),
    threadTitle: "Checkout recovery",
  }),
  entry({ relativePath: "art/Logo 9.png", changedAt: "2026-03-01T00:04:00.000Z" }),
];

const view = (input: Partial<Parameters<typeof buildMediaGroups>[0]>) =>
  buildMediaGroups({ entries: ENTRIES, query: "", sort: "newest", groupBy: "type", ...input }).map(
    (group) => ({
      label: group.label,
      tiles: group.tiles.map((item) => item.relativePath),
      rows: group.rows.map((item) => item.relativePath),
    }),
  );

describe("buildMediaGroups", () => {
  it("groups by type in a fixed order, tiles for what has a picture and rows for the rest", () => {
    expect(view({})).toEqual([
      { label: "Pictures", tiles: ["art/Logo 9.png", "art/hero.png", "art/Logo 10.png"], rows: [] },
      { label: "Videos", tiles: ["media/demo.mp4"], rows: [] },
      { label: "Audio", tiles: [], rows: ["media/theme.mp3"] },
      // A PDF shows its first page; a Word file has nothing to show.
      { label: "Documents", tiles: ["docs/brief.pdf"], rows: ["docs/notes.docx"] },
    ]);
  });

  it("sorts by name the way people count, and finds files by name, folder or thread", () => {
    expect(view({ sort: "name" })[0]?.tiles).toEqual([
      "art/hero.png",
      "art/Logo 9.png",
      "art/Logo 10.png",
    ]);
    expect(view({ query: "logo 9" })).toEqual([
      { label: "Pictures", tiles: ["art/Logo 9.png"], rows: [] },
    ]);
    expect(view({ query: "checkout" })[0]?.tiles).toEqual(["art/Logo 10.png"]);
    expect(view({ query: "nothing like this" })).toEqual([]);
  });

  it("groups by thread with the newest thread first, each with its tiles and rows", () => {
    expect(view({ groupBy: "thread" })).toEqual([
      {
        label: "Make the art",
        tiles: ["art/Logo 9.png", "art/hero.png", "docs/brief.pdf", "media/demo.mp4"],
        rows: ["docs/notes.docx", "media/theme.mp3"],
      },
      { label: "Checkout recovery", tiles: ["art/Logo 10.png"], rows: [] },
    ]);
  });
});
