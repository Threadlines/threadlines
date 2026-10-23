// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * Files another computer sent here, written into a checkout: a moved
 * thread's new files (docs/design/fleet.md, Part 3) and a set-up project's
 * ignored files (Part 8). The sender is trusted to name only paths it
 * means, never to escape the checkout.
 */

const isWindows = process.platform === "win32";

/** Names Windows refuses as a file or folder, whatever the extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Why `path` (from the checkout's root, `/`-separated, as the other computer
 * sent it) can't be written here, or null. Relative, no `.` or `..` parts,
 * nothing under `.git` in any case, no drive, UNC or stream syntax, and on
 * Windows nothing it would read as another file.
 */
export function receivedPathRefusal(path: string): string | null {
  if (path.length === 0 || path.length > 4096) return "an empty or overlong path";
  if (path.includes("\\") || path.includes("\0")) return `"${path}" has a character paths can't`;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return `"${path}" isn't relative`;
  if (path.includes(":")) return `"${path}" has a ":"`;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return `"${path}" has an empty, "." or ".." part`;
    }
    if (segment.toLowerCase() === ".git") return `"${path}" is inside .git`;
    if (isWindows && /[<>"|?*]/.test(segment)) return `"${path}" has a character Windows can't`;
    if (isWindows && /[. ]$/.test(segment)) return `"${path}" ends a part with a dot or space`;
    if (isWindows && WINDOWS_RESERVED.test(segment)) return `"${path}" uses a name Windows keeps`;
  }
  return null;
}

/**
 * Writes one new file under `root` (a `receivedPathRefusal`-checked path):
 * parents are made one at a time, any parent that is a symbolic link or not
 * a folder is refused, and the file must not exist yet (nothing here is
 * overwritten). `symlinkTarget` writes a symbolic link instead of bytes.
 * Rejects with `"exists"` when the file is already there.
 */
export async function writeReceivedFile(
  root: string,
  path: string,
  content:
    | { readonly bytes: Uint8Array; readonly mode: number }
    | { readonly symlinkTarget: string },
): Promise<void> {
  // The root itself must be a real folder: a link there would carry every file elsewhere.
  const rootStat = await NodeFs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("root");
  const segments = path.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = NodePath.join(current, segment);
    const stat = await NodeFs.lstat(current).catch(() => null);
    if (stat === null) {
      await NodeFs.mkdir(current);
    } else if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("parent");
    }
  }
  const target = NodePath.join(root, ...segments);
  try {
    if ("symlinkTarget" in content) {
      await NodeFs.symlink(content.symlinkTarget, target);
    } else {
      await NodeFs.writeFile(target, content.bytes, { flag: "wx", mode: content.mode });
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new Error("exists", { cause });
    throw cause;
  }
}
