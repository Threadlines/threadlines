/**
 * A file's version as a client can compare it: its size and when it was last
 * written. Two reads with the same version saw the same file, so a client can
 * keep what it made from one (a thumbnail, a loaded video) until the version
 * changes, even when an edit keeps the size.
 */
import * as Option from "effect/Option";
import type * as FileSystem from "effect/FileSystem";

export function fileVersionOf(info: Pick<FileSystem.File.Info, "size" | "mtime">): string {
  const modified = Option.match(info.mtime, {
    onNone: () => "unknown",
    onSome: (date) => String(date.getTime()),
  });
  return `${Number(info.size)}-${modified}`;
}
