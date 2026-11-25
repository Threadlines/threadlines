// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export interface RotatingFileSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly throwOnError?: boolean;
  /**
   * Skips synchronous directory creation, backup pruning, and initial `statSync`
   * in the constructor for callers that already created the log directory and
   * write exclusively via `writeAsync`.
   */
  readonly asyncInit?: boolean;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

interface SharedPathState {
  pendingWrite: Promise<void>;
  activeOps: number;
  currentSize: number | null;
}

const MAX_IDLE_SHARED_PATH_STATES = 256;
const sharedPathStates = new Map<string, SharedPathState>();

function getOrCreateSharedPathState(resolvedPath: string): SharedPathState {
  let state = sharedPathStates.get(resolvedPath);
  if (state === undefined) {
    state = { pendingWrite: Promise.resolve(), activeOps: 0, currentSize: null };
    sharedPathStates.set(resolvedPath, state);
  } else {
    // Refresh insertion order for LRU eviction of idle path states.
    sharedPathStates.delete(resolvedPath);
    sharedPathStates.set(resolvedPath, state);
  }
  return state;
}

function evictIdleSharedPathStates(): void {
  if (sharedPathStates.size <= MAX_IDLE_SHARED_PATH_STATES) return;
  for (const [key, entry] of sharedPathStates) {
    if (sharedPathStates.size <= MAX_IDLE_SHARED_PATH_STATES) break;
    if (entry.activeOps === 0) {
      sharedPathStates.delete(key);
    }
  }
}

export class RotatingFileSink {
  private readonly filePath: string;
  private readonly resolvedPath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly throwOnError: boolean;
  private currentSize = 0;

  constructor(options: RotatingFileSinkOptions) {
    if (options.maxBytes < 1) {
      throw new Error(`maxBytes must be >= 1 (received ${options.maxBytes})`);
    }
    if (options.maxFiles < 1) {
      throw new Error(`maxFiles must be >= 1 (received ${options.maxFiles})`);
    }

    this.filePath = options.filePath;
    this.resolvedPath = path.resolve(options.filePath);
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    this.throwOnError = options.throwOnError ?? false;

    if (!options.asyncInit) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.pruneOverflowBackups();
      this.currentSize = this.readCurrentSize();
    }

    const existingShared = sharedPathStates.get(this.resolvedPath);
    if (existingShared !== undefined && existingShared.activeOps === 0) {
      existingShared.currentSize = options.asyncInit ? null : this.currentSize;
    }
  }

  write(chunk: string | Buffer): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) return;

    const shared = sharedPathStates.get(this.resolvedPath);
    if (shared !== undefined && shared.currentSize !== null) {
      this.currentSize = shared.currentSize;
    }

    try {
      if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) {
        this.rotate();
      }

      fs.appendFileSync(this.filePath, buffer);
      this.currentSize += buffer.length;

      if (this.currentSize > this.maxBytes) {
        this.rotate();
      }
      if (shared !== undefined) {
        shared.currentSize = this.currentSize;
      }
    } catch {
      this.currentSize = this.readCurrentSize();
      if (shared !== undefined) {
        shared.currentSize = this.currentSize;
      }
      if (this.throwOnError) {
        throw new Error(`Failed to write log chunk to ${this.filePath}`);
      }
    }
  }

  /**
   * Appends a chunk without blocking the event loop, serialized per resolved
   * destination path so multiple sinks writing to the same log file (such as
   * native and canonical provider logs) never interleave appends or rotations.
   */
  writeAsync(chunk: string | Buffer): Promise<void> {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const shared = getOrCreateSharedPathState(this.resolvedPath);
    if (buffer.length === 0) return shared.pendingWrite;

    shared.activeOps += 1;
    const next = shared.pendingWrite.then(() => this.writeAsyncUnserialized(shared, buffer));
    shared.pendingWrite = next
      .catch(() => undefined)
      .finally(() => {
        shared.activeOps -= 1;
        if (shared.activeOps === 0 && sharedPathStates.get(this.resolvedPath) === shared) {
          evictIdleSharedPathStates();
        }
      });
    return next;
  }

  /** Waits for any in-flight async writes to settle for this path. */
  drain(): Promise<void> {
    return sharedPathStates.get(this.resolvedPath)?.pendingWrite ?? Promise.resolve();
  }

  private async writeAsyncUnserialized(shared: SharedPathState, buffer: Buffer): Promise<void> {
    if (shared.currentSize === null) {
      this.currentSize = await this.readCurrentSizeAsync();
      shared.currentSize = this.currentSize;
    } else {
      this.currentSize = shared.currentSize;
    }
    try {
      if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) {
        await this.rotateAsync();
      }

      await fsp.appendFile(this.filePath, buffer);
      this.currentSize += buffer.length;

      if (this.currentSize > this.maxBytes) {
        await this.rotateAsync();
      }
      shared.currentSize = this.currentSize;
    } catch {
      this.currentSize = await this.readCurrentSizeAsync();
      shared.currentSize = this.currentSize;
      if (this.throwOnError) {
        throw new Error(`Failed to write log chunk to ${this.filePath}`);
      }
    }
  }

  private async rotateAsync(): Promise<void> {
    try {
      await fsp.rm(this.withSuffix(this.maxFiles), { force: true });

      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        const source = this.withSuffix(index);
        const target = this.withSuffix(index + 1);
        try {
          await fsp.rename(source, target);
        } catch (error) {
          if (!isFileNotFoundError(error)) {
            throw error;
          }
        }
      }

      try {
        await fsp.rename(this.filePath, this.withSuffix(1));
      } catch (error) {
        if (!isFileNotFoundError(error)) {
          throw error;
        }
      }

      this.currentSize = 0;
    } catch {
      this.currentSize = await this.readCurrentSizeAsync();
      if (this.throwOnError) {
        throw new Error(`Failed to rotate log file ${this.filePath}`);
      }
    }
  }

  private async readCurrentSizeAsync(): Promise<number> {
    try {
      return (await fsp.stat(this.filePath)).size;
    } catch {
      return 0;
    }
  }

  private rotate(): void {
    try {
      const oldest = this.withSuffix(this.maxFiles);
      if (fs.existsSync(oldest)) {
        fs.rmSync(oldest, { force: true });
      }

      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        const source = this.withSuffix(index);
        const target = this.withSuffix(index + 1);
        if (fs.existsSync(source)) {
          fs.renameSync(source, target);
        }
      }

      if (fs.existsSync(this.filePath)) {
        fs.renameSync(this.filePath, this.withSuffix(1));
      }

      this.currentSize = 0;
    } catch {
      this.currentSize = this.readCurrentSize();
      if (this.throwOnError) {
        throw new Error(`Failed to rotate log file ${this.filePath}`);
      }
    }
  }

  private pruneOverflowBackups(): void {
    try {
      const dir = path.dirname(this.filePath);
      const baseName = path.basename(this.filePath);
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.startsWith(`${baseName}.`)) continue;
        const suffix = Number(entry.slice(baseName.length + 1));
        if (!Number.isInteger(suffix) || suffix <= this.maxFiles) continue;
        fs.rmSync(path.join(dir, entry), { force: true });
      }
    } catch {
      if (this.throwOnError) {
        throw new Error(`Failed to prune log backups for ${this.filePath}`);
      }
    }
  }

  private readCurrentSize(): number {
    try {
      return fs.statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  private withSuffix(index: number): string {
    return `${this.filePath}.${index}`;
  }
}
