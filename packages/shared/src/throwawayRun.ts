import { isFilesystemPathWithin } from "./path.ts";

/**
 * Whether a Threadlines data folder sits inside a temp folder, which is how
 * smoke tests and agent test runs start fresh. Real installs never keep
 * their data there.
 *
 * Pass every spelling of each folder you know, such as both the configured
 * path and its real path (macOS temp folders live behind `/private`).
 */
export function isThrowawayDataFolder(input: {
  readonly baseDirs: ReadonlyArray<string>;
  readonly tempDirs: ReadonlyArray<string>;
}): boolean {
  return input.baseDirs.some((baseDir) =>
    input.tempDirs.some(
      (tempDir) => tempDir.trim() !== "" && isFilesystemPathWithin(baseDir, tempDir),
    ),
  );
}
