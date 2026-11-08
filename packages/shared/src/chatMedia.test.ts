import { describe, expect, it } from "vitest";

import {
  extractMessagePictures,
  readToolImages,
  resolveMessagePicturePath,
  toolCallIdentity,
} from "./chatMedia.ts";

describe("extractMessagePictures", () => {
  it("finds every picture form the chat draws, once each, in order", () => {
    const text = [
      "Here is the before: ![before](/tmp/shots/before.png) and the remote ![logo](https://example.com/logo.png).",
      "Saved to `/Users/me/Desktop/after shot.png`, see also [the diff](./out/diff.webp).",
      "The file `docs/hero.png:3` changed; the old one sits at ~/Pictures/old.jpg.",
      "Again: /tmp/shots/before.png",
    ].join("\n\n");
    expect(extractMessagePictures(text)).toEqual([
      { kind: "path", path: "/tmp/shots/before.png" },
      { kind: "remote", url: "https://example.com/logo.png" },
      { kind: "path", path: "/Users/me/Desktop/after shot.png" },
      { kind: "path", path: "./out/diff.webp" },
      { kind: "citation", reference: "docs/hero.png:3" },
      { kind: "path", path: "~/Pictures/old.jpg" },
    ]);
  });

  it("leaves out what the chat shows as text, code or plain links", () => {
    const text = [
      "```bash",
      "cp /tmp/inside-a-fence.png ~/x.png",
      "```",
      "",
      "    /tmp/indented-code.png",
      "",
      "A [web picture link](https://example.com/a.png), a ![data image](data:image/png;base64,AAAA),",
      "a non-picture `/Users/me/notes.txt`, a bare name screenshot.png, a route `/api/a.png`,",
      "a dev server `localhost:5173/a.png`, and api/v1/thing.png in prose.",
    ].join("\n");
    expect(extractMessagePictures(text)).toEqual([]);
  });

  it("follows a reference to a definition in the same block, as the chat renders it", () => {
    // A definition can't break into a paragraph, so these open the block.
    const text = [
      "[pic]: https://example.com/shot.png",
      "[diff]: ./out/diff.webp",
      "Before: ![shot][pic] and [the diff][Diff].",
      "",
      "Elsewhere: ![far][far]",
      "",
      "[far]: /tmp/far-away.png",
      "[unused]: /tmp/never-shown.png",
    ].join("\n");
    expect(extractMessagePictures(text)).toEqual([
      { kind: "remote", url: "https://example.com/shot.png" },
      { kind: "path", path: "./out/diff.webp" },
    ]);
  });

  it("lists a thumbnail link as the picture it links to, as the chat shows it", () => {
    expect(
      extractMessagePictures("[![thumbnail](https://example.com/thumb.png)](/tmp/full.png)"),
    ).toEqual([{ kind: "path", path: "/tmp/full.png" }]);
    // A web link keeps the picture inside it.
    expect(
      extractMessagePictures("[![badge](https://example.com/badge.png)](https://example.com)"),
    ).toEqual([{ kind: "remote", url: "https://example.com/badge.png" }]);
  });

  it("decodes character references in a destination", () => {
    expect(extractMessagePictures("[pic]: /tmp/a&lowbar;b&#46;png\n![pic]")).toEqual([
      { kind: "path", path: "/tmp/a_b.png" },
    ]);
  });

  it("keeps an escaped character inside the path it belongs to", () => {
    expect(extractMessagePictures(String.raw`Saved to /tmp/my\_shot.png.`)).toEqual([
      { kind: "path", path: "/tmp/my_shot.png" },
    ]);
  });
});

describe("on long runs of one character", () => {
  it("stays linear, since the server runs this on any reply", () => {
    const started = performance.now();
    resolveMessagePicturePath("shot.png", `/repo${"/".repeat(100_000)}`);
    extractMessagePictures(`See /tmp/shot.png${")".repeat(100_000)}`);
    extractMessagePictures(`${"$$"}${" ".repeat(100_000)}x${"$$"}`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("resolveMessagePicturePath", () => {
  it("resolves the way the chat does, against the thread's folder", () => {
    // Joined as the chat joins it; the disk reads `./` as itself.
    expect(resolveMessagePicturePath("./out/diff.webp", "/repo/wt")).toBe(
      "/repo/wt/./out/diff.webp",
    );
    expect(resolveMessagePicturePath("~/Pictures/old.jpg", "/Users/me/repo")).toBe(
      "/Users/me/Pictures/old.jpg",
    );
    expect(resolveMessagePicturePath("file:///tmp/a%20b.png#L2", "/repo")).toBe("/tmp/a b.png");
    expect(resolveMessagePicturePath("/tmp/notes.txt", "/repo")).toBeNull();
  });
});

describe("tool pictures", () => {
  const pixel =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("names the call a screenshot belongs to, wherever the provider put it", () => {
    const payload = {
      toolCallId: "toolu_1",
      data: {
        toolName: "mcp__browser__screenshot",
        result: {
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: pixel } },
          ],
        },
      },
    };
    expect(toolCallIdentity(payload)).toBe("toolu_1");
    expect(readToolImages(payload)).toEqual([
      expect.objectContaining({ previewUrl: `data:image/png;base64,${pixel}` }),
    ]);
    expect(toolCallIdentity({ data: { item: { id: "item-7" } } })).toBe("item-7");
    expect(toolCallIdentity({ data: {} })).toBeNull();
  });
});
