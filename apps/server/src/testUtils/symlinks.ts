/**
 * Whether this machine lets tests make symbolic links.
 *
 * Windows lets an ordinary user make one only with Developer Mode turned on
 * (or from an elevated process), and fails with EPERM otherwise. Tests that
 * build a link fixture skip with `it.skipIf(!canMakeSymlinks)` instead of
 * failing there. Don't skip them on all of Windows: with Developer Mode the
 * links work and the checks behind them (never read or write through a link)
 * matter there too.
 *
 * Linux and macOS always answer true without probing, so the tests stay as
 * strict there as before. The probe runs once per test file that imports it.
 *
 * A directory fixture can often run anyway: `fs.symlinkSync(target, link,
 * "junction")` makes a junction on Windows, which needs no privilege and which
 * Node's lstat reports as a symbolic link. The type is ignored elsewhere.
 */
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

function probeSymlinks(): boolean {
  if (process.platform !== "win32") return true;
  const folder = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "tl-symlink-probe-"));
  try {
    const target = NodePath.join(folder, "target");
    NodeFs.writeFileSync(target, "");
    NodeFs.symlinkSync(target, NodePath.join(folder, "link"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  } finally {
    NodeFs.rmSync(folder, { recursive: true, force: true });
  }
}

export const canMakeSymlinks: boolean = probeSymlinks();
