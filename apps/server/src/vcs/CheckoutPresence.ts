/**
 * The single answer to "is this checkout still on disk?".
 *
 * A thread's checkout can vanish underneath it: the agent removes the worktree
 * after merging its own PR, or the user deletes the folder in a terminal. Three
 * separate places have to react to that — the turn pre-flight that refuses to
 * start a session in a directory that is gone, the VCS status path that must
 * say "the folder is missing" instead of "this is not a git repository", and
 * the status watcher that surfaces an out-of-band deletion before the next turn
 * crashes on it. They all ask here so they cannot disagree.
 *
 * The third state matters as much as the other two. A stat that fails for any
 * reason other than "not found" (a permission problem, an unresponsive network
 * mount, an fs flake) is reported as `unknown`, never as `missing`: callers
 * treat `unknown` exactly like `present` and let normal operation proceed. Only
 * a confirmed absence opens the recovery paths.
 *
 * @module CheckoutPresence
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/**
 * - `present`: the path exists and is a directory.
 * - `missing`: the path is confirmed absent, or exists but is not a directory.
 * - `unknown`: the check itself failed; the caller must assume the checkout is fine.
 */
export type CheckoutPresence = "present" | "missing" | "unknown";

/**
 * Stat `cwd` and classify it. Never fails: a check error is `unknown`, which
 * every caller treats as "carry on".
 */
export const checkoutPresence = (
  cwd: string,
): Effect.Effect<CheckoutPresence, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const trimmed = cwd.trim();
    if (trimmed.length === 0) {
      return "unknown" as const;
    }
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.stat(trimmed).pipe(
      Effect.map((info): CheckoutPresence => (info.type === "Directory" ? "present" : "missing")),
      Effect.catch((error): Effect.Effect<CheckoutPresence> => {
        // Effect's platform errors carry the underlying errno in `describe`
        // rather than as a discriminated reason on every implementation, so
        // classify off the raw code and default to `unknown`.
        const code = systemErrorCode(error);
        return Effect.succeed(code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown");
      }),
    );
  });

/** True only for a checkout confirmed to be gone. */
export const isCheckoutMissing = (
  cwd: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  checkoutPresence(cwd).pipe(Effect.map((presence) => presence === "missing"));

/**
 * Dig the OS errno out of whatever the platform layer wrapped it in. Effect's
 * `SystemError` exposes it on `.cause`/`.description` depending on the backing
 * call, and a raw Node error carries it directly.
 */
export function systemErrorCode(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "object") {
      const code = (current as { readonly code?: unknown }).code;
      if (typeof code === "string" && code.length > 0) {
        return code;
      }
      const reason = (current as { readonly reason?: unknown }).reason;
      if (reason === "NotFound") {
        return "ENOENT";
      }
      const description = (current as { readonly description?: unknown }).description;
      if (typeof description === "string") {
        const matched = /\b(E[A-Z]{2,})\b/u.exec(description);
        if (matched?.[1]) {
          return matched[1];
        }
      }
      current = (current as { readonly cause?: unknown }).cause;
      continue;
    }
    if (typeof current === "string") {
      const matched = /\b(E[A-Z]{2,})\b/u.exec(current);
      return matched?.[1] ?? null;
    }
    return null;
  }
  return null;
}

/**
 * Classify a failed process spawn.
 *
 * A spawn whose `cwd` does not exist fails with the same `ENOENT` a missing
 * executable produces. The provider SDKs see that errno, check whether their
 * own binary is where they expect, and report "Claude Code native binary not
 * found at claude" — sending the user to reinstall a CLI that was never the
 * problem. That is how a deleted worktree presented itself during the incident
 * this guards against.
 *
 * A confirmed-missing working directory is decisive on its own, without
 * requiring the errno to have survived: no process can be spawned in a
 * directory that is not there, so it is always the better explanation than
 * whatever the SDK guessed. The errno is only consulted to avoid a stat on
 * failures that plainly have nothing to do with paths.
 */
export const classifySpawnFailure = (input: {
  readonly cwd: string | undefined;
  readonly error: unknown;
  /**
   * Skip the errno pre-filter and decide purely on whether the directory is
   * there. Used for provider SDK failures, which wrap the original error and
   * drop its `code`.
   */
  readonly errorHidesErrno?: boolean;
}): Effect.Effect<"missing-working-directory" | "other", never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (input.cwd === undefined) {
      return "other" as const;
    }
    if (input.errorHidesErrno !== true && systemErrorCode(input.error) !== "ENOENT") {
      return "other" as const;
    }
    const presence = yield* checkoutPresence(input.cwd);
    return presence === "missing" ? ("missing-working-directory" as const) : ("other" as const);
  });

/**
 * True when `cwd` is a linked git worktree rather than a primary checkout.
 *
 * Git marks a linked worktree by making `.git` a *file* holding a `gitdir:`
 * pointer, where a normal clone has a `.git` directory. Threads only ever get a
 * worktree checkout from Threadlines' own creation flow, so a linked worktree
 * here is by definition one the app manages.
 *
 * Answers false on any error: telling an agent its directory is managed when we
 * are not sure is worse than staying quiet.
 */
export const isLinkedWorktreeCheckout = (
  cwd: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const trimmed = cwd.trim();
    if (trimmed.length === 0) {
      return false;
    }
    const fs = yield* FileSystem.FileSystem;
    const separator = trimmed.includes("\\") && !trimmed.includes("/") ? "\\" : "/";
    const dotGit = `${trimmed.replace(/[/\\]+$/u, "")}${separator}.git`;
    return yield* fs.stat(dotGit).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );
  });

/** User-facing explanation for a spawn that failed because its folder is gone. */
export function missingWorkingDirectoryDetail(cwd: string): string {
  return `This thread's folder no longer exists: ${cwd}`;
}
