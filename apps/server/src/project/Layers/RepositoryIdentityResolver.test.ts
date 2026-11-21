// @effect-diagnostics nodeBuiltinImport:off
import { statSync } from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";

import * as ProcessRunner from "../../processRunner.ts";
import { RepositoryIdentityResolver } from "../Services/RepositoryIdentityResolver.ts";
import {
  makeRepositoryIdentityResolver,
  RepositoryIdentityResolverLive,
} from "./RepositoryIdentityResolver.ts";

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");
const normalizeResolvedPath = (value: string) =>
  process.platform === "win32"
    ? normalizePathSeparators(value).toLowerCase()
    : normalizePathSeparators(value);

function expectSameDirectory(received: string, expected: string): void {
  if (normalizeResolvedPath(received) === normalizeResolvedPath(expected)) {
    return;
  }

  const receivedStat = statSync(received);
  const expectedStat = statSync(expected);
  expect({ dev: receivedStat.dev, ino: receivedStat.ino }).toEqual({
    dev: expectedStat.dev,
    ino: expectedStat.ino,
  });
}

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
      shell: process.platform === "win32",
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

const makeRepositoryIdentityResolverTestLayer = (options: {
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}) =>
  Layer.effect(
    RepositoryIdentityResolver,
    makeRepositoryIdentityResolver({
      cacheCapacity: 16,
      ...options,
    }),
  ).pipe(Layer.provide(ProcessRunner.layer));

/**
 * A resolver whose git runs are recorded in `runs`, oldest first, so a test
 * can count how many processes a sequence of resolves started.
 */
const makeCountingResolverLayer = (
  runs: Array<ReadonlyArray<string>>,
  options: {
    readonly positiveCacheTtl?: Duration.Input;
    readonly negativeCacheTtl?: Duration.Input;
    readonly rootRecheckInterval?: Duration.Input;
  } = {},
) =>
  Layer.effect(
    RepositoryIdentityResolver,
    makeRepositoryIdentityResolver({ cacheCapacity: 16, ...options }),
  ).pipe(
    Layer.provide(
      Layer.effect(
        ProcessRunner.ProcessRunner,
        Effect.map(ProcessRunner.make(), (real) =>
          ProcessRunner.ProcessRunner.of({
            run: (input) => {
              runs.push(input.args);
              return real.run(input);
            },
          }),
        ),
      ),
    ),
  );

const countGit = (runs: ReadonlyArray<ReadonlyArray<string>>, subcommand: "rev-parse" | "remote") =>
  runs.filter((args) => args.includes(subcommand)).length;

it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect("normalizes equivalent GitHub remotes into a stable repository identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expectSameDirectory(identity?.rootPath ?? "", cwd);
      expect(identity?.displayName).toBe("t3tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.owner).toBe("t3tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("returns the git top-level root path when resolving from a nested workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-root-test-",
      });
      const nestedWorkspace = path.join(repoRoot, "packages", "web");

      yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
      yield* git(repoRoot, ["init"]);
      yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(nestedWorkspace);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expectSameDirectory(identity?.rootPath ?? "", repoRoot);
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("returns null for non-git folders and repos without remotes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nonGitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-non-git-",
      });
      const gitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-no-remote-",
      });

      yield* git(gitDir, ["init"]);

      const resolver = yield* RepositoryIdentityResolver;
      const nonGitIdentity = yield* resolver.resolve(nonGitDir);
      const noRemoteIdentity = yield* resolver.resolve(gitDir);

      expect(nonGitIdentity).toBeNull();
      expect(noRemoteIdentity).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("prefers origin over upstream when both remotes are configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-upstream-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:badcuban/badcode.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:pingdotgg/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.locator.remoteName).toBe("origin");
      expect(identity?.canonicalKey).toBe("github.com/badcuban/badcode");
      expect(identity?.displayName).toBe("badcuban/badcode");
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect("uses the last remote path segment as the repository name for nested groups", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-group-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@gitlab.com:T3Tools/platform/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("gitlab.com/t3tools/platform/t3code");
      expect(identity?.displayName).toBe("t3tools/platform/t3code");
      expect(identity?.owner).toBe("t3tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
  );

  it.effect(
    "keeps null identities cached across repeated resolves until the negative TTL expires",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-late-remote-test-",
        });

        yield* git(cwd, ["init"]);

        const resolver = yield* RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity).toBeNull();

        yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

        for (const _attempt of [1, 2, 3]) {
          const cachedIdentity = yield* resolver.resolve(cwd);
          expect(cachedIdentity).toBeNull();
        }

        yield* TestClock.adjust(Duration.millis(120));

        const refreshedIdentity = yield* resolver.resolve(cwd);
        expect(refreshedIdentity).not.toBeNull();
        expect(refreshedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(refreshedIdentity?.name).toBe("t3code");
      }).pipe(
        Effect.provide(
          Layer.merge(
            TestClock.layer(),
            makeRepositoryIdentityResolverTestLayer({
              negativeCacheTtl: Duration.millis(50),
              positiveCacheTtl: Duration.seconds(1),
            }),
          ),
        ),
      ),
  );

  it.effect("refreshes cached identities after the positive TTL when a remote changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-remote-change-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const initialIdentity = yield* resolver.resolve(cwd);
      expect(initialIdentity).not.toBeNull();
      expect(initialIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");

      yield* git(cwd, ["remote", "set-url", "origin", "git@github.com:T3Tools/t3code-next.git"]);

      const cachedIdentity = yield* resolver.resolve(cwd);
      expect(cachedIdentity).not.toBeNull();
      expect(cachedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");

      yield* TestClock.adjust(Duration.millis(180));

      const refreshedIdentity = yield* resolver.resolve(cwd);
      expect(refreshedIdentity).not.toBeNull();
      expect(refreshedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code-next");
      expect(refreshedIdentity?.displayName).toBe("t3tools/t3code-next");
      expect(refreshedIdentity?.name).toBe("t3code-next");
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          makeRepositoryIdentityResolverTestLayer({
            negativeCacheTtl: Duration.millis(50),
            positiveCacheTtl: Duration.millis(100),
          }),
        ),
      ),
    ),
  );

  it.effect("asks git for a folder's root once, however often and concurrently it resolves", () => {
    const runs: Array<ReadonlyArray<string>> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-repeat-test-",
      });
      const nestedWorkspace = path.join(repoRoot, "packages", "web");
      yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
      yield* git(repoRoot, ["init"]);
      yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      const identities = yield* Effect.all(
        [repoRoot, repoRoot, nestedWorkspace, nestedWorkspace, repoRoot, nestedWorkspace].map(
          (cwd) => resolver.resolve(cwd),
        ),
        { concurrency: "unbounded" },
      );
      for (const _sweep of [1, 2, 3]) {
        identities.push(
          yield* resolver.resolve(repoRoot),
          yield* resolver.resolve(nestedWorkspace),
        );
      }

      expect(identities.map((identity) => identity?.canonicalKey)).toEqual(
        identities.map(() => "github.com/t3tools/t3code"),
      );
      expect(countGit(runs, "rev-parse")).toBe(2);
      expect(countGit(runs, "remote")).toBe(1);

      // A remembered root is still re-asked once the recheck interval passes.
      yield* TestClock.adjust(Duration.minutes(5));
      yield* resolver.resolve(repoRoot);
      expect(countGit(runs, "rev-parse")).toBe(3);
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          makeCountingResolverLayer(runs, {
            positiveCacheTtl: Duration.minutes(10),
            rootRecheckInterval: Duration.minutes(5),
          }),
        ),
      ),
    );
  });

  it.effect("finds a repository created inside a remembered root on the next resolve", () => {
    const runs: Array<ReadonlyArray<string>> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-repo-test-",
      });
      const nestedWorkspace = path.join(repoRoot, "vendor", "lib");
      yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
      yield* git(repoRoot, ["init"]);
      yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      expect((yield* resolver.resolve(nestedWorkspace))?.canonicalKey).toBe(
        "github.com/t3tools/t3code",
      );

      yield* git(nestedWorkspace, ["init"]);
      yield* git(nestedWorkspace, ["remote", "add", "origin", "git@github.com:T3Tools/lib.git"]);

      const nestedIdentity = yield* resolver.resolve(nestedWorkspace);
      expect(nestedIdentity?.canonicalKey).toBe("github.com/t3tools/lib");
      expectSameDirectory(nestedIdentity?.rootPath ?? "", nestedWorkspace);
      expect(countGit(runs, "rev-parse")).toBe(2);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), makeCountingResolverLayer(runs))));
  });

  it.effect("finds a bare repository created inside a remembered root on the next resolve", () => {
    const runs: Array<ReadonlyArray<string>> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-bare-test-",
      });
      const nestedWorkspace = path.join(repoRoot, "vendor");
      yield* fileSystem.makeDirectory(nestedWorkspace);
      yield* git(repoRoot, ["init"]);
      yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      expect((yield* resolver.resolve(nestedWorkspace))?.canonicalKey).toBe(
        "github.com/t3tools/t3code",
      );

      yield* git(nestedWorkspace, ["init", "--bare"]);
      yield* git(nestedWorkspace, ["remote", "add", "origin", "git@github.com:T3Tools/lib.git"]);

      expect((yield* resolver.resolve(nestedWorkspace))?.canonicalKey).toBe(
        "github.com/t3tools/lib",
      );
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), makeCountingResolverLayer(runs))));
  });

  it.effect("asks git again once a folder that had no repository gets one", () => {
    const runs: Array<ReadonlyArray<string>> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-git-init-test-",
      });

      const resolver = yield* RepositoryIdentityResolver;
      expect(yield* resolver.resolve(cwd)).toBeNull();
      expect(yield* resolver.resolve(cwd)).toBeNull();
      expect(countGit(runs, "rev-parse")).toBe(1);

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);
      yield* resolver.resolve(cwd);
      expect(countGit(runs, "rev-parse")).toBe(2);

      // Where git spells the new root the same as the folder, the cached
      // "no identity" answer holds until the negative TTL, as before.
      yield* TestClock.adjust(Duration.millis(120));
      expect((yield* resolver.resolve(cwd))?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(countGit(runs, "rev-parse")).toBe(2);
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          makeCountingResolverLayer(runs, { negativeCacheTtl: Duration.millis(100) }),
        ),
      ),
    );
  });

  it.effect("picks up a folder re-created as another repository once the identity TTL ends", () => {
    const runs: Array<ReadonlyArray<string>> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-recreated-test-",
      });
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver;
      expect((yield* resolver.resolve(cwd))?.canonicalKey).toBe("github.com/t3tools/t3code");

      yield* fileSystem.remove(cwd, { recursive: true });
      yield* fileSystem.makeDirectory(cwd);
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/other.git"]);

      expect((yield* resolver.resolve(cwd))?.canonicalKey).toBe("github.com/t3tools/t3code");
      yield* TestClock.adjust(Duration.millis(120));
      expect((yield* resolver.resolve(cwd))?.canonicalKey).toBe("github.com/t3tools/other");
      // The root never changed, so git was asked for it only once.
      expect(countGit(runs, "rev-parse")).toBe(1);
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          makeCountingResolverLayer(runs, { positiveCacheTtl: Duration.millis(100) }),
        ),
      ),
    );
  });
});
