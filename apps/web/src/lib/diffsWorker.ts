/**
 * Entry for the diff panel's highlight workers (DiffWorkerPoolProvider).
 *
 * Pierre's worker loads its highlighter chunks, and those import `./worker.js`
 * back. Pointing `?worker` straight at pierre's file serves it in dev under a
 * query URL (`worker.js?worker_file&type=module`), so that import evaluates a
 * second copy of the worker with its own message handler: every request runs
 * twice, and the uninitialized copy fails on themes it was never sent.
 * Importing it from here keeps one URL, and one copy, in dev and in builds.
 */
import "@pierre/diffs/worker/worker.js";
