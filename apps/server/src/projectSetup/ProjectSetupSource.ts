// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs/promises";
import { constants as FsConstants } from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import {
  PROJECT_SETUP_MAX_FILE_BYTES,
  PROJECT_SETUP_MAX_FILES,
  PROJECT_SETUP_MAX_TOTAL_BYTES,
  type ProjectId,
  type ProjectSetupFile,
  type ProjectSetupFileCandidate,
  type ProjectSetupFileMode,
  ProjectSetupError,
  type ProjectSetupReadFilesInput,
  type ProjectSetupReadFilesResult,
  type ProjectSetupSource as ProjectSetupSourceResult,
} from "@threadlines/contracts";
import { gitRemoteProtocol, stripGitRemoteCredentials } from "@threadlines/shared/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { receivedPathRefusal } from "../fs/receivedFiles.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProcessRunner } from "../processRunner.ts";
import {
  parseRemoteFetchUrls,
  pickPrimaryRemote,
} from "../project/Layers/RepositoryIdentityResolver.ts";
import { resolveProjectPlace } from "../project/projectPlace.ts";
import { RepositoryIdentityResolver } from "../project/Services/RepositoryIdentityResolver.ts";

/**
 * The computer that has a project, answering what another computer needs to
 * make its own copy (docs/design/fleet.md, Part 8): what to clone, the
 * project's scripts, and the ignored files the user may send along. The app
 * carries the answer to the other computer.
 */
export interface ProjectSetupSourceShape {
  readonly source: (
    projectId: ProjectId,
  ) => Effect.Effect<ProjectSetupSourceResult, ProjectSetupError>;
  readonly readFiles: (
    input: ProjectSetupReadFilesInput,
  ) => Effect.Effect<ProjectSetupReadFilesResult, ProjectSetupError>;
}

export class ProjectSetupSource extends Context.Service<
  ProjectSetupSource,
  ProjectSetupSourceShape
>()("threadlines/projectSetup/ProjectSetupSource") {}

/** Files sent along unless the user unticks them: where secrets and local settings live. */
export const isSuggestedSetupFile = (path: string) => {
  const name = path.split("/").at(-1) ?? path;
  return /^\.env(\..+)?$/i.test(name) || name === ".envrc" || name === ".dev.vars";
};

/** How many ignored entries are looked at before the list is cut. */
const MAX_SCANNED_ENTRIES = 5_000;

const failure = (detail: string) => new ProjectSetupError({ detail });

/** The mode bits a file keeps elsewhere: private stays private, executable stays executable. */
const sentMode = (mode: number): ProjectSetupFileMode =>
  (mode & 0o077) === 0 ? 0o600 : (mode & 0o111) !== 0 ? 0o755 : 0o644;

export const makeProjectSetupSource = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery;
  const identities = yield* RepositoryIdentityResolver;
  const processes = yield* ProcessRunner;

  const git = (cwd: string, args: ReadonlyArray<string>, stdin?: string) =>
    processes
      .run({
        command: "git",
        args: ["-C", cwd, ...args],
        timeout: "10 seconds",
        maxOutputBytes: 4 * 1024 * 1024,
        outputMode: "truncate",
        ...(stdin !== undefined ? { stdin } : {}),
      })
      .pipe(Effect.mapError(() => failure("Git didn't answer on this computer.")));

  /** The project, its repository root and its place there. */
  const where = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const model = yield* snapshots
        .getCommandReadModel()
        .pipe(Effect.mapError(() => failure("This computer's projects couldn't be read.")));
      const project = model.projects.find(
        (entry) => entry.id === projectId && entry.deletedAt === null,
      );
      if (project === undefined) return yield* failure("That project isn't on this computer.");
      if (project.kind === "general-chat") {
        return yield* failure("General chats don't belong to a project to copy.");
      }
      const place = yield* resolveProjectPlace(identities, project.workspaceRoot);
      if (place === null) {
        return yield* failure(
          "It has no git remote, so another computer has nothing to clone it from.",
        );
      }
      return { project, place, root: place.rootPath };
    });

  /**
   * Ignored files, without walking folders git ignores whole
   * (`node_modules/`). A folder that holds nothing but ignored files isn't
   * ignored itself, though git lists it as one entry: look inside it.
   */
  const ignoredEntries = (root: string) =>
    Effect.gen(function* () {
      const listing = yield* git(root, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "--no-empty-directory",
        "-z",
      ]);
      if (listing.code !== 0) return { entries: [], cut: false };
      const entries = listing.stdout.split("\0").filter((entry) => entry.length > 0);
      const folders = entries.filter((entry) => entry.endsWith("/"));
      const files = entries.filter((entry) => !entry.endsWith("/"));
      // Git folds a folder holding only ignored files into one line at every
      // depth, so walk those here, a bounded number of entries, asking git
      // which entries are ignored and never entering a folder ignored whole.
      const found = [...files];
      let queue = folders;
      let visited = 0;
      let cut = false;
      for (let depth = 0; queue.length > 0; depth += 1) {
        if (depth >= 8 || visited >= MAX_SCANNED_ENTRIES) {
          cut = true;
          break;
        }
        const ignored = yield* checkIgnored(root, queue);
        const next: string[] = [];
        const children: string[] = [];
        for (const folder of queue) {
          if (ignored.has(folder)) continue;
          const listing = yield* Effect.promise(() =>
            NodeFs.readdir(NodePath.join(root, ...folder.split("/")), {
              withFileTypes: true,
            }).catch(() => []),
          );
          for (const entry of listing) {
            if (visited >= MAX_SCANNED_ENTRIES) {
              cut = true;
              break;
            }
            visited += 1;
            if (entry.isDirectory()) next.push(`${folder}${entry.name}/`);
            else if (entry.isFile()) children.push(`${folder}${entry.name}`);
          }
        }
        const ignoredChildren = yield* checkIgnored(root, children);
        found.push(...children.filter((child) => ignoredChildren.has(child)));
        queue = next;
      }
      return { entries: found, cut };
    });

  /** Which of `paths` git ignores (a folder with its trailing `/`). */
  const checkIgnored = (root: string, paths: ReadonlyArray<string>) =>
    paths.length === 0
      ? Effect.succeed(new Set<string>())
      : git(
          root,
          ["check-ignore", "--stdin", "-z"],
          paths.map((path) => `${path}\0`).join(""),
        ).pipe(
          Effect.map(
            (result) => new Set(result.stdout.split("\0").filter((entry) => entry.length > 0)),
          ),
        );

  const listCandidates = (root: string) =>
    Effect.gen(function* () {
      const { entries, cut } = yield* ignoredEntries(root);
      const scanned = entries.slice(0, MAX_SCANNED_ENTRIES);
      const files: ProjectSetupFileCandidate[] = [];
      for (const path of scanned) {
        if (receivedPathRefusal(path) !== null) continue;
        const stat = yield* Effect.promise(() =>
          NodeFs.lstat(NodePath.join(root, ...path.split("/"))).catch(() => null),
        );
        if (stat === null || !stat.isFile()) continue;
        files.push({
          path,
          size: stat.size,
          suggested: isSuggestedSetupFile(path),
          tooLarge: stat.size > PROJECT_SETUP_MAX_FILE_BYTES,
        });
      }
      files.sort(
        (left, right) =>
          Number(right.suggested) - Number(left.suggested) || left.path.localeCompare(right.path),
      );
      return {
        files: files.slice(0, PROJECT_SETUP_MAX_FILES),
        truncated: cut || files.length > PROJECT_SETUP_MAX_FILES || entries.length > scanned.length,
      };
    });

  const source: ProjectSetupSourceShape["source"] = (projectId) =>
    Effect.gen(function* () {
      const { project, place, root } = yield* where(projectId);
      const head = yield* git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      if (head.code !== 0) {
        return yield* failure("It has no commits yet, so there's nothing to clone.");
      }
      const remoteList = yield* git(root, ["remote", "-v"]);
      const fetchUrls = parseRemoteFetchUrls(remoteList.stdout);
      const primary = pickPrimaryRemote(fetchUrls);
      if (primary === null) {
        return yield* failure(
          "It has no git remote, so another computer has nothing to clone it from.",
        );
      }
      const remotes = [...fetchUrls.entries()]
        .map(([name, url]) => {
          const clean = stripGitRemoteCredentials(url);
          return { name, url: clean, protocol: gitRemoteProtocol(clean) };
        })
        .toSorted(
          (left, right) =>
            Number(right.name === primary.remoteName) - Number(left.name === primary.remoteName) ||
            left.name.localeCompare(right.name),
        );
      // About what a clone downloads: this copy's packed objects, in KiB. Loose
      // objects stay out: they are mostly local work the remote doesn't have.
      const counted = yield* git(root, ["count-objects", "-v"]);
      const sizeBytes = Number(/^size-pack: (\d+)$/m.exec(counted.stdout)?.[1] ?? 0) * 1024;
      const home = NodeOs.homedir();
      const fromHome = NodePath.relative(home, root);
      const { files, truncated } = yield* listCandidates(root);
      return {
        projectId: project.id,
        title: project.title,
        repositoryKey: place.canonicalKey,
        subdirectory: place.subdirectory,
        remotes,
        primaryRemoteName: primary.remoteName,
        scripts: project.scripts,
        homeRelativePath:
          fromHome.length > 0 && !fromHome.startsWith("..") && !NodePath.isAbsolute(fromHome)
            ? fromHome.split(NodePath.sep).join("/")
            : null,
        folderName: NodePath.basename(root) || "project",
        files,
        filesTruncated: truncated,
        ...(counted.code === 0 && sizeBytes > 0 ? { sizeBytes } : {}),
      } satisfies ProjectSetupSourceResult;
    });

  /**
   * One file's bytes. It must resolve inside the project, and the file opened
   * (without following a final symlink) must be that same file, so a folder
   * swapped for a link between the check and the open reads nothing.
   */
  const readOne = (root: string, realRoot: string, path: string) =>
    Effect.tryPromise({
      try: async (): Promise<ProjectSetupFile> => {
        const absolute = NodePath.join(root, ...path.split("/"));
        const real = await NodeFs.realpath(absolute);
        if (!real.startsWith(realRoot + NodePath.sep)) throw new Error("outside");
        const checked = await NodeFs.stat(real);
        const handle = await NodeFs.open(
          absolute,
          FsConstants.O_RDONLY | (FsConstants.O_NOFOLLOW ?? 0),
        );
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error("not a file");
          if (stat.dev !== checked.dev || stat.ino !== checked.ino) throw new Error("moved");
          if (stat.size > PROJECT_SETUP_MAX_FILE_BYTES) throw new Error("too large");
          const bytes = await handle.readFile();
          return { path, contentBase64: bytes.toString("base64"), mode: sentMode(stat.mode) };
        } finally {
          await handle.close();
        }
      },
      catch: () => failure(`Couldn't read ${path} on this computer.`),
    });

  const readFiles: ProjectSetupSourceShape["readFiles"] = (input) =>
    Effect.gen(function* () {
      if (input.paths.length > PROJECT_SETUP_MAX_FILES) {
        return yield* failure(`That's more than ${PROJECT_SETUP_MAX_FILES} files.`);
      }
      const { root } = yield* where(input.projectId);
      const realRoot = yield* Effect.promise(() => NodeFs.realpath(root).catch(() => root));
      for (const path of input.paths) {
        const refusal = receivedPathRefusal(path);
        if (refusal !== null) return yield* failure(`Can't send ${refusal}.`);
        const real = yield* Effect.promise(() =>
          NodeFs.realpath(NodePath.join(root, ...path.split("/"))).catch(() => null),
        );
        if (real === null || !real.startsWith(realRoot + NodePath.sep)) {
          return yield* failure(`${path} isn't inside the project.`);
        }
      }
      // Only files git ignores: tracked files come with the clone.
      const ignored = yield* git(
        root,
        ["check-ignore", "--stdin", "-z"],
        input.paths.map((path) => `${path}\0`).join(""),
      );
      const ignoredPaths = new Set(ignored.stdout.split("\0").filter((entry) => entry.length > 0));
      const notIgnored = input.paths.find((path) => !ignoredPaths.has(path));
      if (notIgnored !== undefined) {
        return yield* failure(`${notIgnored} isn't an ignored file, so it comes with the clone.`);
      }
      const files: ProjectSetupFile[] = [];
      let total = 0;
      for (const path of input.paths) {
        const file = yield* readOne(root, realRoot, path);
        total += Buffer.byteLength(file.contentBase64, "base64");
        if (total > PROJECT_SETUP_MAX_TOTAL_BYTES) {
          return yield* failure("The files come to more than 8 MB together.");
        }
        files.push(file);
      }
      return { files };
    });

  return { source, readFiles } satisfies ProjectSetupSourceShape;
});

export const ProjectSetupSourceLive = Layer.effect(ProjectSetupSource, makeProjectSetupSource);
