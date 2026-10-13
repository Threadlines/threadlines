// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { sweepPageFiles } from "./PageFileSweep.ts";

const PAGE = "11111111-1111-4111-8111-111111111111";
const KEPT = "22222222-2222-4222-8222-222222222222";
const ORPHAN = "33333333-3333-4333-8333-333333333333";
const PENDING = "44444444-4444-4444-8444-444444444444";
const YOUNG = "55555555-5555-4555-8555-555555555555";

describe("sweepPageFiles", () => {
  let pagesDir: string;

  beforeEach(() => {
    pagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-page-sweep-"));
  });
  afterEach(() => {
    fs.rmSync(pagesDir, { recursive: true, force: true });
  });

  const write = (thread: string, versionId: string, ageMs: number) => {
    const file = path.join(pagesDir, thread, PAGE, `${versionId}.html`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "<p>page</p>");
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(file, at, at);
    return file;
  };

  it("removes old files no live row names, and keeps live, pending and young ones", async () => {
    const hour = 60 * 60_000;
    const kept = write("thread-a", KEPT, 2 * hour);
    const orphan = write("thread-a", ORPHAN, 2 * hour);
    const pending = write("thread-a", PENDING, 2 * hour);
    const young = write("thread-a", YOUNG, 60_000);
    const deletedThread = write("thread-gone", KEPT, 2 * hour);

    const removed = await sweepPageFiles({
      pagesDir,
      keep: new Set([`thread-a/${PAGE}/${KEPT}`]),
      pending: new Set([PENDING]),
      now: Date.now(),
    });

    expect(removed).toBe(2);
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(pending)).toBe(true);
    expect(fs.existsSync(young)).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);
    // A deleted thread's rows are gone, so its folder goes too.
    expect(fs.existsSync(deletedThread)).toBe(false);
    expect(fs.existsSync(path.join(pagesDir, "thread-gone"))).toBe(false);
  });
});
