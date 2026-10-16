// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { readConfinedFile, writeConfinedFile } from "./confinedFiles.ts";

// Symlinks and hard links to a file inside the folder are covered through
// PageStore's image reads (PageStore.test.ts); these cover the rest.

let tmp: string;
let root: string;
let outside: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tl-confined-files-"));
  root = path.join(tmp, "root");
  outside = path.join(tmp, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("readConfinedFile", () => {
  it("refuses a path that leaves the folder through '..' or a linked folder", async () => {
    fs.writeFileSync(path.join(outside, "secret.txt"), "TOKEN=1");
    fs.symlinkSync(outside, path.join(root, "linked"));

    for (const escape of [
      [root, "..", "outside", "secret.txt"].join(path.sep),
      path.join(root, "linked", "secret.txt"),
    ]) {
      expect(await readConfinedFile({ root, path: escape, maxBytes: 1024 })).toEqual({
        refused: "outside",
      });
    }
  });

  it("reads a file up to maxBytes and refuses a longer one", async () => {
    const file = path.join(root, "notes", "plan.md");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "0123456789");

    const read = await readConfinedFile({ root, path: file, maxBytes: 10 });
    expect("bytes" in read ? new TextDecoder().decode(read.bytes) : read).toBe("0123456789");
    expect(await readConfinedFile({ root, path: file, maxBytes: 9 })).toEqual({
      refused: "too-large",
      size: 10,
    });
    expect(
      await readConfinedFile({ root, path: path.join(root, "absent.md"), maxBytes: 10 }),
    ).toEqual({ refused: "missing" });
  });
});

describe("writeConfinedFile", () => {
  const list = () => fs.readdirSync(root).toSorted();

  it("leaves an existing file alone unless asked to overwrite it", async () => {
    const write = (contents: string, overwrite: boolean) =>
      writeConfinedFile({ directory: root, name: "flow.js", contents, overwrite });

    expect(await write("first", false)).toBe("written");
    expect(await write("second", false)).toBe("exists");
    expect(fs.readFileSync(path.join(root, "flow.js"), "utf8")).toBe("first");

    expect(await write("third", true)).toBe("written");
    expect(fs.readFileSync(path.join(root, "flow.js"), "utf8")).toBe("third");
    // No temporary file is left behind.
    expect(list()).toEqual(["flow.js"]);
  });

  it("never writes through a link at the target name", async () => {
    const target = path.join(outside, "victim.txt");
    fs.writeFileSync(target, "original");
    fs.symlinkSync(target, path.join(root, "flow.js"));
    // A dangling link counts too: following it would create a file elsewhere.
    fs.symlinkSync(path.join(outside, "created.txt"), path.join(root, "dangling.js"));

    expect(
      await writeConfinedFile({
        directory: root,
        name: "flow.js",
        contents: "x",
        overwrite: false,
      }),
    ).toBe("exists");
    await expect(
      writeConfinedFile({ directory: root, name: "flow.js", contents: "x", overwrite: true }),
    ).rejects.toThrow("not a regular file");
    await expect(
      writeConfinedFile({ directory: root, name: "dangling.js", contents: "x", overwrite: true }),
    ).rejects.toThrow("not a regular file");

    expect(fs.readFileSync(target, "utf8")).toBe("original");
    expect(fs.existsSync(path.join(outside, "created.txt"))).toBe(false);
    expect(fs.lstatSync(path.join(root, "flow.js")).isSymbolicLink()).toBe(true);
    expect(list()).toEqual(["dangling.js", "flow.js"]);
  });

  it("refuses a name that is a path", async () => {
    for (const name of ["../flow.js", "sub/flow.js", "..", ""]) {
      await expect(
        writeConfinedFile({ directory: root, name, contents: "x", overwrite: true }),
      ).rejects.toThrow("Refusing to write");
    }
    expect(fs.readdirSync(tmp).toSorted()).toEqual(["outside", "root"]);
  });
});
