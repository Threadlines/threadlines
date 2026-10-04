// @effect-diagnostics nodeBuiltinImport:off
/**
 * Account overlays: a private account folder whose chosen entries link back to
 * a shared folder, so a second account keeps its own login while sharing
 * config and history with the main one. Codex shadow homes and Claude account
 * folders are both built from these primitives; each decides which entries
 * are shared and what a conflicting real entry means.
 *
 * Links are symlinks. On Windows without symlink rights, directories fall back
 * to junctions and files to hard links. A hard link splits when an editor
 * saves by replacing the file; `relinkSplitHardLink` restores it from the
 * shared copy.
 *
 * @module provider/accountOverlay
 */
import * as NodeFS from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class AccountOverlayError extends Schema.TaggedError<AccountOverlayError>()(
  "AccountOverlayError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const isAccountOverlayError = Schema.is(AccountOverlayError);

function toOverlayError(cause: unknown, detail: string): AccountOverlayError {
  return isAccountOverlayError(cause) ? cause : new AccountOverlayError({ detail, cause });
}

export type LinkState =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "NotSymlink" }
  | { readonly _tag: "Symlink"; readonly target: string };

export const readLinkState = Effect.fn("accountOverlay.readLinkState")(function* (
  fileSystem: FileSystem.FileSystem,
  linkPath: string,
): Effect.fn.Return<LinkState, AccountOverlayError> {
  return yield* fileSystem.readLink(linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catch((error) => {
      if (error.reason._tag === "NotFound") {
        return Effect.succeed<LinkState>({ _tag: "Missing" });
      }
      return fileSystem.exists(linkPath).pipe(
        Effect.map((exists): LinkState => (exists ? { _tag: "NotSymlink" } : { _tag: "Missing" })),
        Effect.mapError((cause) => toOverlayError(cause, `Could not inspect '${linkPath}'.`)),
      );
    }),
  );
});

/** Removes `entryName` from the account folder when it is a link; real entries stay. */
export const removeLinkIfPresent = Effect.fn("accountOverlay.removeLinkIfPresent")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly accountPath: string;
    readonly entryName: string;
  }): Effect.fn.Return<void, AccountOverlayError, Path.Path> {
    const path = yield* Path.Path;
    const entryPath = path.join(input.accountPath, input.entryName);
    const state = yield* readLinkState(input.fileSystem, entryPath);
    if (state._tag === "Symlink") {
      yield* input.fileSystem
        .remove(entryPath)
        .pipe(
          Effect.mapError((cause) => toOverlayError(cause, `Could not remove '${entryPath}'.`)),
        );
    }
  },
);

/** True when `link` is a Windows hard link of `target` (same file on disk). */
export const isSharedHardLink = (input: {
  readonly target: string;
  readonly link: string;
  readonly platform: NodeJS.Platform;
}): Effect.Effect<boolean> => {
  if (input.platform !== "win32") return Effect.succeed(false);
  return Effect.promise(async () => {
    try {
      const [targetStats, linkStats] = await Promise.all([
        NodeFS.stat(input.target),
        NodeFS.stat(input.link),
      ]);
      return (
        targetStats.isFile() &&
        linkStats.isFile() &&
        targetStats.dev === linkStats.dev &&
        targetStats.ino === linkStats.ino
      );
    } catch {
      return false;
    }
  });
};

const createWindowsFallbackLink = (input: {
  readonly target: string;
  readonly link: string;
}): Effect.Effect<"junction" | "hardLink", AccountOverlayError> =>
  Effect.tryPromise({
    try: async () => {
      const stats = await NodeFS.stat(input.target);
      if (stats.isDirectory()) {
        await NodeFS.symlink(input.target, input.link, "junction");
        return "junction" as const;
      }
      await NodeFS.link(input.target, input.link);
      return "hardLink" as const;
    },
    catch: (cause) => toOverlayError(cause, `Could not link '${input.link}' to '${input.target}'.`),
  });

/** How a shared entry ended up in the account folder. */
export type SharedLinkResult =
  /** A link to the shared entry is in place (made now or already there). */
  | { readonly _tag: "Linked"; readonly kind: "symlink" | "junction" | "hardLink" }
  /** A real entry of the account's own is in the way; nothing was changed. */
  | { readonly _tag: "Conflict" };

/**
 * Makes `<accountPath>/<entryName>` a link to `<sharedPath>/<entryName>`.
 * A real entry is reported as a conflict for the caller to resolve, never
 * overwritten. A link pointing elsewhere is replaced only when the caller
 * says the link is its own (`foreignLink: "replace"`); otherwise it is a
 * conflict too, so a link the user made survives.
 */
export const linkSharedEntry = Effect.fn("accountOverlay.linkSharedEntry")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedPath: string;
  readonly accountPath: string;
  readonly entryName: string;
  readonly platform: NodeJS.Platform;
  readonly foreignLink: "replace" | "keep";
}): Effect.fn.Return<SharedLinkResult, AccountOverlayError, Path.Path> {
  const path = yield* Path.Path;
  const target = path.join(input.sharedPath, input.entryName);
  const link = path.join(input.accountPath, input.entryName);
  const state = yield* readLinkState(input.fileSystem, link);

  if (state._tag === "NotSymlink") {
    if (yield* isSharedHardLink({ target, link, platform: input.platform })) {
      return { _tag: "Linked", kind: "hardLink" };
    }
    return { _tag: "Conflict" };
  }

  if (state._tag === "Symlink") {
    if (path.resolve(path.dirname(link), state.target) === target) {
      return { _tag: "Linked", kind: "symlink" };
    }
    if (input.foreignLink === "keep") return { _tag: "Conflict" };
    yield* input.fileSystem
      .remove(link)
      .pipe(Effect.mapError((cause) => toOverlayError(cause, `Could not replace '${link}'.`)));
  }

  return yield* input.fileSystem.symlink(target, link).pipe(
    Effect.as<SharedLinkResult>({ _tag: "Linked", kind: "symlink" }),
    Effect.catch((cause) =>
      input.platform === "win32"
        ? createWindowsFallbackLink({ target, link }).pipe(
            Effect.map((kind): SharedLinkResult => ({ _tag: "Linked", kind })),
          )
        : Effect.fail(toOverlayError(cause, `Could not link '${link}' to '${target}'.`)),
    ),
  );
});

/**
 * Restores a Windows hard link that an atomic save split: the account's copy
 * is replaced by a fresh hard link to the shared file (the shared copy wins).
 * Only for entries this overlay hard-linked itself; a real file the account
 * created is never touched.
 */
export const relinkSplitHardLink = Effect.fn("accountOverlay.relinkSplitHardLink")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedPath: string;
    readonly accountPath: string;
    readonly entryName: string;
  }): Effect.fn.Return<void, AccountOverlayError, Path.Path> {
    const path = yield* Path.Path;
    const target = path.join(input.sharedPath, input.entryName);
    const link = path.join(input.accountPath, input.entryName);
    if (yield* isSharedHardLink({ target, link, platform: "win32" })) return;
    const targetExists = yield* input.fileSystem
      .exists(target)
      .pipe(Effect.mapError((cause) => toOverlayError(cause, `Could not inspect '${target}'.`)));
    if (!targetExists) return;
    yield* input.fileSystem
      .remove(link, { force: true })
      .pipe(Effect.mapError((cause) => toOverlayError(cause, `Could not replace '${link}'.`)));
    yield* Effect.tryPromise({
      try: () => NodeFS.link(target, link),
      catch: (cause) => toOverlayError(cause, `Could not link '${link}' to '${target}'.`),
    });
  },
);
