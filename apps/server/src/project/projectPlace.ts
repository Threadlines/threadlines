// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import type { OrchestrationProjectCatalogEntry } from "@threadlines/contracts";
import * as Effect from "effect/Effect";

import type { RepositoryIdentityResolverShape } from "./Services/RepositoryIdentityResolver.ts";

/**
 * Where a project sits in its repository, the same on every computer: the
 * repository's key (RepositoryIdentity.canonicalKey) and the project's
 * folder from the repository root (`/`-separated, "" at the root). Two
 * computers have "the same project" when both match, so a monorepo's apps
 * stay apart (docs/design/fleet.md, Part 8).
 */
export interface ProjectPlace {
  readonly canonicalKey: string;
  readonly subdirectory: string;
  readonly rootPath: string;
}

const realOrSame = (path: string) =>
  Effect.promise(() => NodeFs.realpath(path).catch(() => NodePath.resolve(path)));

/** `workspaceRoot`'s place, or null when it isn't in a repository with a remote. */
export const resolveProjectPlace = (
  identities: RepositoryIdentityResolverShape,
  workspaceRoot: string,
) =>
  Effect.gen(function* () {
    const identity = yield* identities.resolve(workspaceRoot);
    if (identity === null || !identity.canonicalKey) return null;
    const rootPath = identity.rootPath ?? workspaceRoot;
    const relative = NodePath.relative(
      yield* realOrSame(rootPath),
      yield* realOrSame(workspaceRoot),
    );
    // Outside the root (a symlinked folder git resolved elsewhere): the root itself.
    const subdirectory =
      relative.startsWith("..") || NodePath.isAbsolute(relative)
        ? ""
        : relative
            .split(NodePath.sep)
            .filter((part) => part.length > 0)
            .join("/");
    return { canonicalKey: identity.canonicalKey, subdirectory, rootPath } satisfies ProjectPlace;
  });

/**
 * This computer's live project at `canonicalKey` and `subdirectory`, or
 * undefined. Without a `subdirectory` (an older computer asking) the key
 * alone decides, the repository's root project first.
 */
export const findProjectByPlace = (
  identities: RepositoryIdentityResolverShape,
  projects: ReadonlyArray<OrchestrationProjectCatalogEntry>,
  canonicalKey: string,
  subdirectory: string | undefined,
) =>
  Effect.gen(function* () {
    let keyOnly: { project: OrchestrationProjectCatalogEntry; subdirectory: string } | undefined;
    for (const project of projects) {
      if (project.deletedAt !== null || project.kind === "general-chat") continue;
      const place = yield* resolveProjectPlace(identities, project.workspaceRoot);
      if (place === null || place.canonicalKey !== canonicalKey) continue;
      if (subdirectory !== undefined) {
        if (place.subdirectory === subdirectory) return project;
        continue;
      }
      if (keyOnly === undefined || (keyOnly.subdirectory !== "" && place.subdirectory === "")) {
        keyOnly = { project, subdirectory: place.subdirectory };
      }
    }
    return keyOnly?.project;
  });
