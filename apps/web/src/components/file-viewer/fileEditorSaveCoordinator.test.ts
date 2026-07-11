import { QueryClient } from "@tanstack/react-query";
import type { EnvironmentId, ProjectReadFileResult } from "@threadlines/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  writeFile: vi.fn<(input: unknown) => Promise<unknown>>(),
  toastAdd: vi.fn(),
}));

vi.mock("../../environmentApi", () => ({
  ensureEnvironmentApi: () => ({ projects: { writeFile: harness.writeFile } }),
}));

vi.mock("../ui/toast", () => ({
  toastManager: { add: harness.toastAdd },
}));

import { useFileViewerStore } from "../../fileViewerStore";
import { projectQueryKeys } from "../../lib/projectReactQuery";
import {
  FILE_SAVE_DEBOUNCE_MS,
  flushFileEdits,
  hasPendingFileEdits,
  queueFileEdit,
  resolveFileConflict,
} from "./fileEditorSaveCoordinator";

const environmentId = "env-1" as EnvironmentId;
const target = { environmentId, cwd: "/repo", path: "src/main.ts" };

function written(contentHash: string) {
  return { kind: "written", relativePath: target.path, contentHash };
}

function conflict(content: string, contentHash: string) {
  return {
    kind: "conflict",
    relativePath: target.path,
    content,
    contentHash,
    size: content.length,
  };
}

function queue(contents: string, queryClient: QueryClient, baselineHash = "base-0") {
  queueFileEdit({ ...target, contents, baselineHash, queryClient });
}

async function drainMicrotasks() {
  // Fake timers do not flush promise continuations; interleave a few turns.
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe("fileEditorSaveCoordinator", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    queryClient = new QueryClient();
    harness.writeFile.mockReset();
    harness.toastAdd.mockReset();
    harness.writeFile.mockResolvedValue(written("hash-1"));
    useFileViewerStore.setState({ editSaveState: {}, editReloadNonce: 0 });
  });

  afterEach(async () => {
    await flushFileEdits(target);
    await resolveFileConflict(target, "reload");
    await drainMicrotasks();
    vi.useRealTimers();
  });

  it("debounces rapid edits into one write asserting the baseline hash", async () => {
    queue("draft 1", queryClient);
    queue("draft 2", queryClient);
    expect(useFileViewerStore.getState().editSaveState[target.path]).toBe("pending");
    expect(harness.writeFile).not.toHaveBeenCalled();

    vi.advanceTimersByTime(FILE_SAVE_DEBOUNCE_MS);
    await drainMicrotasks();

    expect(harness.writeFile).toHaveBeenCalledTimes(1);
    expect(harness.writeFile).toHaveBeenCalledWith({
      cwd: target.cwd,
      relativePath: target.path,
      contents: "draft 2",
      expectedContentHash: "base-0",
    });
    expect(useFileViewerStore.getState().editSaveState[target.path]).toBeUndefined();
    expect(hasPendingFileEdits(target)).toBe(false);
  });

  it("keeps the read cache in sync with the latest buffer", () => {
    queue("optimistic contents", queryClient);
    const cached = queryClient.getQueryData<ProjectReadFileResult>(
      projectQueryKeys.readFile(environmentId, target.cwd, target.path),
    );
    expect(cached).toMatchObject({
      kind: "text",
      relativePath: target.path,
      content: "optimistic contents",
      truncated: false,
      contentHash: "base-0",
    });
  });

  it("flushes immediately on demand without waiting for the debounce", async () => {
    queue("flush me", queryClient);
    await flushFileEdits(target);
    await drainMicrotasks();

    expect(harness.writeFile).toHaveBeenCalledTimes(1);
    expect(harness.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ contents: "flush me" }),
    );
    expect(useFileViewerStore.getState().editSaveState[target.path]).toBeUndefined();
  });

  it("marks failed writes as errors, toasts, and retries on the next edit", async () => {
    harness.writeFile.mockRejectedValueOnce(new Error("disk full"));

    queue("will fail", queryClient);
    await flushFileEdits(target);
    await drainMicrotasks();

    expect(useFileViewerStore.getState().editSaveState[target.path]).toBe("error");
    expect(harness.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: expect.stringContaining("main.ts") }),
    );

    queue("second try", queryClient);
    vi.advanceTimersByTime(FILE_SAVE_DEBOUNCE_MS);
    await drainMicrotasks();

    expect(harness.writeFile).toHaveBeenCalledTimes(2);
    expect(harness.writeFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ contents: "second try" }),
    );
    expect(useFileViewerStore.getState().editSaveState[target.path]).toBeUndefined();
  });

  it("advances the baseline hash across successive writes", async () => {
    let resolveWrite: (value: unknown) => void = () => undefined;
    harness.writeFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWrite = resolve;
        }),
    );

    queue("first", queryClient);
    vi.advanceTimersByTime(FILE_SAVE_DEBOUNCE_MS);
    await drainMicrotasks();
    expect(harness.writeFile).toHaveBeenCalledTimes(1);

    // The buffer moves on while the first write is still in flight.
    queue("second", queryClient);
    resolveWrite(written("hash-1"));
    await drainMicrotasks();

    vi.advanceTimersByTime(FILE_SAVE_DEBOUNCE_MS);
    await drainMicrotasks();

    expect(harness.writeFile).toHaveBeenCalledTimes(2);
    // The follow-up write asserts against the hash the first write produced.
    expect(harness.writeFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ contents: "second", expectedContentHash: "hash-1" }),
    );
    expect(useFileViewerStore.getState().editSaveState[target.path]).toBeUndefined();
  });

  it("writes unguarded when the baseline hash is unknown (legacy server)", async () => {
    queue("skew edit", queryClient, "");
    await flushFileEdits(target);
    await drainMicrotasks();

    expect(harness.writeFile).toHaveBeenCalledTimes(1);
    expect(harness.writeFile).toHaveBeenCalledWith({
      cwd: target.cwd,
      relativePath: target.path,
      contents: "skew edit",
    });
    expect(useFileViewerStore.getState().editSaveState[target.path]).toBeUndefined();
  });

  it("latches on conflict: no further autosaves until resolved", async () => {
    harness.writeFile.mockResolvedValueOnce(conflict("external contents", "disk-hash"));

    queue("my edit", queryClient);
    await flushFileEdits(target);
    await drainMicrotasks();

    expect(useFileViewerStore.getState().editSaveState[target.path]).toBe("conflict");

    // Further typing keeps buffering but never writes over the conflict.
    queue("my edit continued", queryClient);
    vi.advanceTimersByTime(FILE_SAVE_DEBOUNCE_MS * 3);
    await flushFileEdits(target);
    await drainMicrotasks();

    expect(harness.writeFile).toHaveBeenCalledTimes(1);
    expect(useFileViewerStore.getState().editSaveState[target.path]).toBe("conflict");
  });

  it("overwrite resolution writes the buffer asserting the conflict's hash", async () => {
    harness.writeFile.mockResolvedValueOnce(conflict("external contents", "disk-hash"));

    queue("my edit", queryClient);
    await flushFileEdits(target);
    await drainMicrotasks();
    queue("my final edit", queryClient);

    await resolveFileConflict(target, "overwrite");
    await drainMicrotasks();

    expect(harness.writeFile).toHaveBeenCalledTimes(2);
    expect(harness.writeFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ contents: "my final edit", expectedContentHash: "disk-hash" }),
    );
    expect(useFileViewerStore.getState().editSaveState[target.path]).toBeUndefined();
    expect(hasPendingFileEdits(target)).toBe(false);
  });

  it("reload resolution adopts disk state, drops the buffer, and remounts", async () => {
    harness.writeFile.mockResolvedValueOnce(conflict("external contents", "disk-hash"));

    queue("my edit", queryClient);
    await flushFileEdits(target);
    await drainMicrotasks();

    await resolveFileConflict(target, "reload");

    expect(harness.writeFile).toHaveBeenCalledTimes(1);
    expect(hasPendingFileEdits(target)).toBe(false);
    expect(useFileViewerStore.getState().editSaveState[target.path]).toBeUndefined();
    expect(useFileViewerStore.getState().editReloadNonce).toBe(1);
    const cached = queryClient.getQueryData<ProjectReadFileResult>(
      projectQueryKeys.readFile(environmentId, target.cwd, target.path),
    );
    expect(cached).toMatchObject({
      kind: "text",
      content: "external contents",
      contentHash: "disk-hash",
    });
  });
});
