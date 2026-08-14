import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import type { SourceControlProviderDiscoveryItem, VcsDiscoveryItem } from "@threadlines/contracts";

import {
  clearSourceControlToolVersionAdvisoryCacheForTests,
  compareToolVersions,
  parseGitHubCliVersion,
  parseGitVersion,
  resolveLatestToolVersion,
  withSourceControlToolVersionAdvisory,
} from "./SourceControlToolVersionAdvisory.ts";

it("parses common Git and GitHub CLI version output", () => {
  assert.strictEqual(parseGitVersion("git version 2.55.0.windows.4"), "2.55.0.windows.4");
  assert.strictEqual(parseGitHubCliVersion("gh version 2.92.0 (2026-08-01)"), "2.92.0");
  assert.strictEqual(parseGitVersion("unexpected output"), null);
  assert.strictEqual(parseGitHubCliVersion("unexpected output"), null);
});

it("compares multi-digit and Git for Windows version segments", () => {
  assert.ok(compareToolVersions("2.10.0", "2.9.9") > 0);
  assert.ok(compareToolVersions("2.55.0.windows.3", "2.55.0.windows.4") < 0);
  assert.ok(compareToolVersions("2.55.0.windows.10", "2.55.0.windows.4") > 0);
  assert.ok(compareToolVersions("v2.56.0.windows.1", "2.55.0.windows.4") > 0);
});

it.effect("recommends GitHub CLI updates for the Windows terminal flash range", () =>
  Effect.gen(function* () {
    const item: SourceControlProviderDiscoveryItem = {
      kind: "github",
      label: "GitHub",
      executable: "gh",
      status: "available",
      version: Option.some("gh version 2.92.0"),
      installHint: "Install GitHub CLI.",
      detail: Option.none(),
      auth: {
        status: "authenticated",
        account: Option.some("octocat"),
        host: Option.some("github.com"),
        detail: Option.none(),
      },
    };
    const enriched = yield* withSourceControlToolVersionAdvisory({
      platform: "win32",
      canRunUpdate: true,
      latestVersionResolver: () => Effect.succeed("2.98.0"),
      winGetVersionResolver: () => Effect.succeed("2.98.0"),
      item,
    });

    assert.strictEqual(enriched.versionAdvisory?.status, "recommended_update");
    assert.strictEqual(enriched.versionAdvisory?.recommendedVersion, "2.97.0");
    assert.match(enriched.versionAdvisory?.message ?? "", /terminal windows/i);
    assert.ok(enriched.versionAdvisory?.actions.some((action) => action.kind === "copyCommand"));
    assert.deepStrictEqual(
      enriched.versionAdvisory?.actions.find((action) => action.kind === "runUpdate"),
      { label: "Update now", kind: "runUpdate", target: "github-cli" },
    );
  }),
);

it.effect("recommends GitHub CLI security floor across platforms", () =>
  Effect.gen(function* () {
    const item: SourceControlProviderDiscoveryItem = {
      kind: "github",
      label: "GitHub",
      executable: "gh",
      status: "available",
      version: Option.some("gh version 2.96.0"),
      installHint: "Install GitHub CLI.",
      detail: Option.none(),
      auth: {
        status: "authenticated",
        account: Option.some("octocat"),
        host: Option.some("github.com"),
        detail: Option.none(),
      },
    };
    const enriched = yield* withSourceControlToolVersionAdvisory({
      platform: "linux",
      latestVersionResolver: () => Effect.succeed("2.98.0"),
      item,
    });

    assert.strictEqual(enriched.versionAdvisory?.status, "recommended_update");
    assert.strictEqual(enriched.versionAdvisory?.recommendedVersion, "2.97.0");
    assert.match(enriched.versionAdvisory?.message ?? "", /security/i);
  }),
);

it.effect("recommends the Git for Windows security baseline without executing updates", () =>
  Effect.gen(function* () {
    const item: VcsDiscoveryItem = {
      kind: "git",
      label: "Git",
      executable: "git",
      implemented: true,
      status: "available",
      version: Option.some("git version 2.54.0.windows.1"),
      installHint: "Install Git.",
      detail: Option.none(),
    };
    const enriched = yield* withSourceControlToolVersionAdvisory({
      platform: "win32",
      canRunUpdate: true,
      latestVersionResolver: () => Effect.succeed("2.55.0.windows.4"),
      winGetVersionResolver: () => Effect.succeed("2.55.0.windows.4"),
      item,
    });

    assert.strictEqual(enriched.versionAdvisory?.status, "recommended_update");
    assert.strictEqual(enriched.versionAdvisory?.recommendedVersion, "2.55.0.windows.4");
    assert.ok(enriched.versionAdvisory?.actions.some((action) => action.kind === "copyCommand"));
    assert.deepStrictEqual(
      enriched.versionAdvisory?.actions.find((action) => action.kind === "runUpdate"),
      { label: "Update now", kind: "runUpdate", target: "git" },
    );
  }),
);

it.effect("does not offer a stale WinGet update after its catalog version is installed", () =>
  Effect.gen(function* () {
    const item: VcsDiscoveryItem = {
      kind: "git",
      label: "Git",
      executable: "git",
      implemented: true,
      status: "available",
      version: Option.some("git version 2.55.0.windows.3"),
      installHint: "Install Git.",
      detail: Option.none(),
    };
    const enriched = yield* withSourceControlToolVersionAdvisory({
      platform: "win32",
      canRunUpdate: true,
      latestVersionResolver: () => Effect.succeed("2.55.0.windows.4"),
      winGetVersionResolver: () => Effect.succeed("2.55.0.windows.3"),
      item,
    });

    assert.strictEqual(enriched.versionAdvisory?.status, "recommended_update");
    assert.strictEqual(enriched.versionAdvisory?.latestVersion, "2.55.0.windows.4");
    assert.match(enriched.versionAdvisory?.message ?? "", /has not reached WinGet yet/i);
    assert.ok(enriched.versionAdvisory?.actions.some((action) => action.kind === "openUrl"));
    assert.ok(!enriched.versionAdvisory?.actions.some((action) => action.kind === "runUpdate"));
    assert.ok(!enriched.versionAdvisory?.actions.some((action) => action.kind === "copyCommand"));
  }),
);

it.effect("offers the newer WinGet package while explaining when it trails upstream", () =>
  Effect.gen(function* () {
    const item: VcsDiscoveryItem = {
      kind: "git",
      label: "Git",
      executable: "git",
      implemented: true,
      status: "available",
      version: Option.some("git version 2.54.0.windows.1"),
      installHint: "Install Git.",
      detail: Option.none(),
    };
    const enriched = yield* withSourceControlToolVersionAdvisory({
      platform: "win32",
      canRunUpdate: true,
      latestVersionResolver: () => Effect.succeed("2.55.0.windows.4"),
      winGetVersionResolver: () => Effect.succeed("2.55.0.windows.3"),
      item,
    });

    assert.match(enriched.versionAdvisory?.message ?? "", /currently offers 2\.55\.0\.windows\.3/i);
    assert.ok(enriched.versionAdvisory?.actions.some((action) => action.kind === "runUpdate"));
    assert.ok(enriched.versionAdvisory?.actions.some((action) => action.kind === "copyCommand"));
  }),
);

it.effect("does not check Git for Windows latest releases off Windows", () => {
  let resolverCalls = 0;
  return Effect.gen(function* () {
    const item: VcsDiscoveryItem = {
      kind: "git",
      label: "Git",
      executable: "git",
      implemented: true,
      status: "available",
      version: Option.some("git version 2.54.0"),
      installHint: "Install Git.",
      detail: Option.none(),
    };
    const enriched = yield* withSourceControlToolVersionAdvisory({
      platform: "linux",
      latestVersionResolver: () => {
        resolverCalls += 1;
        return Effect.succeed("2.55.0.windows.4");
      },
      item,
    });

    assert.strictEqual(enriched.versionAdvisory, undefined);
    assert.strictEqual(resolverCalls, 0);
  });
});

it.effect("offers one-click Homebrew installs for missing macOS source control tools", () =>
  Effect.gen(function* () {
    const item: SourceControlProviderDiscoveryItem = {
      kind: "github",
      label: "GitHub",
      executable: "gh",
      status: "missing",
      version: Option.none(),
      installHint: "Install GitHub CLI.",
      detail: Option.some("gh was not found on the server PATH."),
      auth: {
        status: "unknown",
        account: Option.none(),
        host: Option.none(),
        detail: Option.none(),
      },
    };
    const enriched = yield* withSourceControlToolVersionAdvisory({
      platform: "darwin",
      packageManager: "homebrew",
      canRunInstall: true,
      latestVersionResolver: () => Effect.succeed(null),
      item,
    });

    assert.strictEqual(enriched.versionAdvisory?.status, "install_available");
    assert.strictEqual(enriched.versionAdvisory?.currentVersion, null);
    assert.deepStrictEqual(enriched.versionAdvisory?.actions.slice(0, 2), [
      {
        label: "Install now",
        kind: "runUpdate",
        target: "github-cli",
        operation: "install",
      },
      { label: "Copy Homebrew command", kind: "copyCommand", value: "brew install gh" },
    ]);
  }),
);

it.effect("caches successful latest-release lookups", () => {
  clearSourceControlToolVersionAdvisoryCacheForTests();
  let requestCount = 0;
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requestCount += 1;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            { tag_name: "v2.99.0" },
            { headers: { "content-type": "application/json" } },
          ),
        ),
      );
    }),
  );

  return Effect.gen(function* () {
    const first = yield* resolveLatestToolVersion("github-cli");
    const second = yield* resolveLatestToolVersion("github-cli");

    assert.strictEqual(first, "2.99.0");
    assert.strictEqual(second, "2.99.0");
    assert.strictEqual(requestCount, 1);
  }).pipe(Effect.provide(httpLayer));
});

it.effect("turns latest-release fetch failures into a null version", () => {
  clearSourceControlToolVersionAdvisoryCacheForTests();
  let requestCount = 0;
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requestCount += 1;
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 503 })));
    }),
  );

  return Effect.gen(function* () {
    const first = yield* resolveLatestToolVersion("github-cli");
    const second = yield* resolveLatestToolVersion("github-cli");

    assert.strictEqual(first, null);
    assert.strictEqual(second, null);
    assert.strictEqual(requestCount, 1);
  }).pipe(Effect.provide(httpLayer));
});
