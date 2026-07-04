import { execFileSync } from "node:child_process";

function stripVersionTagPrefix(version: string): string {
  return version.trim().replace(/^v(?=\d+\.\d+\.\d+(?:[-+]|$))/, "");
}

function readGitOutput(args: ReadonlyArray<string>, cwd?: string): string | undefined {
  try {
    const output = execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      ...(cwd ? { cwd } : {}),
    }).trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Version of the checked-out release: the exact tag on HEAD, else the nearest
 * tag, with the leading "v" stripped. Every dev surface (web dev bundle, dev
 * Electron shell, dev server) versions itself from this so client and server
 * agree; packaged builds carry real versions and never need it. Returns
 * undefined outside a repo or on tag-less checkouts (e.g. CI).
 */
export function resolveGitReleaseVersion(options?: { readonly cwd?: string }): string | undefined {
  const tag =
    readGitOutput(["describe", "--tags", "--exact-match", "HEAD"], options?.cwd) ??
    readGitOutput(["describe", "--tags", "--abbrev=0"], options?.cwd);
  return tag ? stripVersionTagPrefix(tag) : undefined;
}
