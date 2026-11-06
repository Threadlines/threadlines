import {
  type EnvironmentApi,
  EnvironmentId,
  type ProjectReadMediaChunkInput,
} from "@threadlines/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as environmentApi from "../environmentApi";
import { loadMediaFile, resetMediaPlaybackForTests } from "./mediaPlayback";

const ENVIRONMENT_ID = EnvironmentId.make("environment-media-playback");

/** A file of `size` bytes whose every byte says where it sits. */
function serveFile(
  size: number,
  options: {
    /** A piece read after this many reads sees a newer version of the file. */
    readonly changeAfter?: number;
    /** This read (by count) fails. */
    readonly failRead?: number;
  } = {},
) {
  const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
  let version = "v1";
  let calls = 0;
  const readMediaChunk = vi.fn(async (input: ProjectReadMediaChunkInput) => {
    calls += 1;
    if (options.failRead === calls) {
      throw new Error("connection dropped");
    }
    if (options.changeAfter !== undefined && calls > options.changeAfter) {
      version = "v2";
    }
    const piece = bytes.subarray(input.offset, input.offset + input.length);
    return {
      kind: "chunk" as const,
      relativePath: input.relativePath,
      mimeType: "video/mp4",
      size,
      version,
      offset: input.offset,
      base64: Buffer.from(piece).toString("base64"),
    };
  });
  vi.spyOn(environmentApi, "ensureEnvironmentApi").mockReturnValue({
    projects: { readMediaChunk },
  } as unknown as EnvironmentApi);
  return {
    bytes,
    readMediaChunk,
    rewrite: () => {
      version = "v2";
    },
  };
}

// Small pieces keep the test quick; the server's own cap is 4 MB.
const PIECE = 1000;
const load = (overrides: Partial<Parameters<typeof loadMediaFile>[0]> = {}) =>
  loadMediaFile({
    environmentId: ENVIRONMENT_ID,
    cwd: "/repo",
    relativePath: "clip.mp4",
    pieceBytes: PIECE,
    ...overrides,
  });

describe("loadMediaFile", () => {
  afterEach(() => {
    resetMediaPlaybackForTests();
    vi.restoreAllMocks();
  });

  it("puts a file of several pieces back together in order, reporting progress", async () => {
    const size = PIECE * 2 + 234;
    const { bytes, readMediaChunk } = serveFile(size);
    const progress: number[] = [];

    const result = await load({ onProgress: (loaded) => progress.push(loaded) });

    expect(result.kind).toBe("loaded");
    const blob = result.kind === "loaded" ? result.blob : null;
    expect(blob?.type).toBe("video/mp4");
    expect(new Uint8Array((await blob?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(bytes);
    expect(
      readMediaChunk.mock.calls.map(([input]) => input.offset).toSorted((a, b) => a - b),
    ).toEqual([0, PIECE, PIECE * 2]);
    expect(progress.at(-1)).toBe(size);
  });

  it("plays a kept copy again after one tiny check, until the file is rewritten", async () => {
    const { readMediaChunk, rewrite } = serveFile(10);
    await load();
    expect(readMediaChunk).toHaveBeenCalledTimes(1);

    expect((await load()).kind).toBe("loaded");
    // Only a zero-length read, to compare versions.
    expect(readMediaChunk).toHaveBeenCalledTimes(2);
    expect(readMediaChunk.mock.calls[1]?.[0]).toMatchObject({ offset: 0, length: 0 });

    // Rewritten with the same size: a new version, so it loads again.
    rewrite();
    const reloaded = await load();
    expect(reloaded.kind === "loaded" ? reloaded.version : null).toBe("v2");
    expect(readMediaChunk).toHaveBeenCalledTimes(4);
  });

  it("gives up on a file that changes while it loads", async () => {
    serveFile(PIECE + 10, { changeAfter: 1 });
    await expect(load()).rejects.toThrow("changed while it was loading");
  });

  it("stops every read and all progress at the first failure", async () => {
    const { readMediaChunk } = serveFile(PIECE * 6, { failRead: 2 });
    const progress: number[] = [];
    await expect(load({ onProgress: (loaded) => progress.push(loaded) })).rejects.toThrow(
      "connection dropped",
    );
    const readsAtFailure = readMediaChunk.mock.calls.length;
    const progressAtFailure = progress.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The other worker's read already in flight may land, but nothing new starts.
    expect(readMediaChunk.mock.calls.length).toBeLessThanOrEqual(readsAtFailure);
    expect(progress.length).toBe(progressAtFailure);
    expect(readsAtFailure).toBeLessThan(6);
  });
});
