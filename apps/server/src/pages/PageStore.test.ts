// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { ensurePageAssetsDir, inlinePageImages, readPublishedPage } from "./PageStore.ts";

// A 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("inlinePageImages", () => {
  let tmp: string;
  let assetsRoot: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tl-page-store-"));
    assetsRoot = await Effect.runPromise(ensurePageAssetsDir("thread-1", tmp));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const inline = (content: string) =>
    Effect.runPromise(Effect.result(inlinePageImages({ content, assetsRoot })));

  it("inlines an image saved in the thread's assets folder, wherever the page names it", async () => {
    const image = path.join(assetsRoot, "chart.png");
    fs.writeFileSync(image, PNG);
    const result = await inline(
      `<img src="${image}"><div style="background:url(${image})"></div>\n![chart](${image})`,
    );
    expect(result._tag).toBe("Success");
    const html = result._tag === "Success" ? result.success : "";
    expect(html).not.toContain(image);
    expect(html.match(/data:image\/png;base64,/g)).toHaveLength(3);
  });

  it("refuses an image outside the assets folder, naming the folder to use", async () => {
    const outside = path.join(tmp, "secret.png");
    fs.writeFileSync(outside, PNG);
    const result = await inline(`<img src="${outside}">`);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("outside the page assets folder");
      expect(result.failure.message).toContain(assetsRoot);
    }
  });

  it("refuses a link inside the folder that points at a file elsewhere", async () => {
    const outside = path.join(tmp, "secret.png");
    fs.writeFileSync(outside, PNG);
    const symlink = path.join(assetsRoot, "linked.png");
    fs.symlinkSync(outside, symlink);
    const hardlink = path.join(assetsRoot, "hard.png");
    fs.linkSync(outside, hardlink);
    for (const reference of [symlink, hardlink]) {
      const result = await inline(`<img src="${reference}">`);
      expect(result._tag).toBe("Failure");
    }
  });

  it("refuses a file that is not really an image, whatever it is named", async () => {
    const fake = path.join(assetsRoot, "token.png");
    fs.writeFileSync(fake, "sk-live-not-an-image");
    const result = await inline(`<img src="${fake}">`);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("is not an image");
    }
  });

  it("leaves URLs and data URIs alone", async () => {
    const page = `<img src="https://example.com/a.png"><img src="data:image/png;base64,AAAA">`;
    const result = await inline(page);
    expect(result._tag === "Success" ? result.success : null).toBe(page);
  });
});

describe("readPublishedPage", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tl-published-page-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const read = (file: string) => Effect.runPromise(Effect.result(readPublishedPage(file)));

  it("reads a published page file", async () => {
    const page = path.join(tmp, "report.html");
    fs.writeFileSync(page, "<h1>Report</h1>");
    const result = await read(page);
    expect(result._tag === "Success" ? result.success : null).toEqual({
      kind: "html",
      content: "<h1>Report</h1>",
    });
  });

  it("refuses a link, or a second name, put where the published file was", async () => {
    const secret = path.join(tmp, "secret.txt");
    fs.writeFileSync(secret, "TOKEN=1");
    const linked = path.join(tmp, "linked.html");
    fs.symlinkSync(secret, linked);
    const renamed = path.join(tmp, "renamed.md");
    fs.linkSync(secret, renamed);
    expect((await read(linked))._tag).toBe("Failure");
    expect((await read(renamed))._tag).toBe("Failure");
  });
});
