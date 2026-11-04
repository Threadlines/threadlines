/**
 * Reads the database file through once, so a migration that then reads a
 * whole table finds its pages in the system's file cache. Without it, right
 * after an update the file is out of the cache, and SQLite fetches the table
 * from disk one 4 KB page at a time in the scattered order the pages were
 * written.
 *
 * Timed on an uncached copy of a 3.2 GB install whose activity table holds
 * 1.1 GB (migration 099's index build): 15.5 s, 3.3 s of it CPU. Reading the
 * file first took 0.8 s, and the build then took 1.7 s. SQLite's own settings
 * (a bigger cache, temp files in memory, sorter threads) changed nothing, and
 * memory-mapped reads brought it to 9.7 s. A copy made just before timing sits
 * in the cache, so it shows the 1.7 s and hides the problem.
 *
 * The runner calls it before the first pending migration that reads whole
 * tables (`Migrations.ts`). The read is asynchronous, so the server still
 * answers "starting" meanwhile. It is skipped when the file is more than half
 * of this computer's memory: the cache could not hold all of it, and the end
 * of the read would push out the start before the migration got there. It
 * never fails: a read that goes wrong only costs the speedup.
 */
import os from "node:os";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/** Each read's size. Large reads go at the disk's sequential speed. */
const READ_CHUNK_BYTES = 8 * 1024 * 1024;
/** The file may take at most this share of the computer's memory. */
const MAX_SHARE_OF_MEMORY = 0.5;

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return gib >= 1 ? `${gib.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export const readDatabaseFileAhead = (
  fs: FileSystem.FileSystem,
  filename: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const size = Number((yield* fs.stat(filename)).size);
    const memory = os.totalmem();
    if (size > memory * MAX_SHARE_OF_MEMORY) {
      yield* Effect.log(
        `Not reading the database file ahead: at ${formatBytes(size)} it is more than half of this computer's ${formatBytes(memory)} of memory`,
      );
      return;
    }
    const [duration, bytesRead] = yield* Effect.timed(
      Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(filename, { flag: "r" });
          const buffer = new Uint8Array(READ_CHUNK_BYTES);
          let total = 0;
          while (true) {
            const read = yield* file.read(buffer);
            if (read === 0) return total;
            total += read;
          }
        }),
      ),
    );
    yield* Effect.log(
      `Read the database file ahead (${formatBytes(bytesRead)} in ${Duration.format(Duration.millis(Math.round(Duration.toMillis(duration))))})`,
    );
  }).pipe(
    // A failed close surfaces as a defect, so both kinds are caught.
    Effect.catch((cause) => Effect.logWarning("Could not read the database file ahead", { cause })),
    Effect.catchDefect((defect) =>
      Effect.logWarning("Could not read the database file ahead", { cause: defect }),
    ),
  );
