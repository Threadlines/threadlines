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

it.effect("offers the official Git for Windows updater for the security baseline", () =>
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
      item,
    });

    assert.strictEqual(enriched.versionAdvisory?.status, "recommended_update");
    assert.strictEqual(enriched.versionAdvisory?.recommendedVersion, "2.55.0.windows.4");
    assert.deepStrictEqual(
      enriched.versionAdvisory?.actions.find((action) => action.kind === "copyCommand"),
      {
        label: "Copy Git for Windows update command",
        kind: "copyCommand",
        value: "git update-git-for-windows --yes",
      },
    );
    assert.deepStrictEqual(
      enriched.versionAdvisory?.actions.find((action) => action.kind === "runUpdate"),
      { label: "Update now", kind: "runUpdate", target: "git" },
    );
  }),
);

it.effect("does not wait for WinGet when the official Git updater is available", () =>
  Effect.gen(function* () {
    let winGetResolverCalls = 0;
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
      winGetVersionResolver: () => {
        winGetResolverCalls += 1;
        return Effect.succeed("2.55.0.windows.3");
      },
      item,
    });

    assert.strictEqual(enriched.versionAdvisory?.status, "recommended_update");
    assert.strictEqual(enriched.versionAdvisory?.latestVersion, "2.55.0.windows.4");
    assert.notMatch(enriched.versionAdvisory?.message ?? "", /WinGet/i);
    assert.ok(enriched.versionAdvisory?.actions.some((action) => action.kind === "openUrl"));
    assert.ok(enriched.versionAdvisory?.actions.some((action) => action.kind === "runUpdate"));
    assert.ok(enriched.versionAdvisory?.actions.some((action) => action.kind === "copyCommand"));
    assert.strictEqual(winGetResolverCalls, 0);
  }),
);

it.effect("does not offer the Git for Windows updater to another Windows Git build", () =>
  Effect.gen(function* () {
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
      platform: "win32",
      canRunUpdate: true,
      latestVersionResolver: () => Effect.succeed("2.55.0.windows.4"),
      item,
    });

    assert.strictEqual(enriched.versionAdvisory, undefined);
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

it.effect("offers one-click Homebrew updates for an outdated GitHub CLI on macOS", () =>
  Effect.gen(function* () {
    const item: SourceControlProviderDiscoveryItem = {
      kind: "github",
      label: "GitHub",
      executable: "gh",
      status: "available",
      version: Option.some("gh version 2.93.0 (2026-05-27)"),
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
      platform: "darwin",
      packageManager: "homebrew",
      canRunUpdate: true,
      latestVersionResolver: () => Effect.succeed("2.98.0"),
      item,
    });

    assert.strictEqual(enriched.versionAdvisory?.status, "recommended_update");
    assert.deepStrictEqual(
      enriched.versionAdvisory?.actions.find((action) => action.kind === "runUpdate"),
      { label: "Update now", kind: "runUpdate", target: "github-cli", operation: "update" },
    );
    assert.deepStrictEqual(
      enriched.versionAdvisory?.actions.find((action) => action.kind === "copyCommand"),
      { label: "Copy Homebrew command", kind: "copyCommand", value: "brew upgrade gh" },
    );
  }),
);

it.effect("withholds Homebrew update actions from a gh that Homebrew does not manage", () =>
  Effect.gen(function* () {
    const item: SourceControlProviderDiscoveryItem = {
      kind: "github",
      label: "GitHub",
      executable: "gh",
      status: "available",
      version: Option.some("gh version 2.93.0 (2026-05-27)"),
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
      platform: "darwin",
      packageManager: "homebrew",
      canRunUpdate: false,
      latestVersionResolver: () => Effect.succeed("2.98.0"),
      item,
    });

    assert.strictEqual(enriched.versionAdvisory?.status, "recommended_update");
    // `brew upgrade gh` fails on a gh Homebrew never installed, so neither the
    // one-click run nor the copyable command is offered — only the release
    // link, with the message explaining why.
    assert.ok(!enriched.versionAdvisory?.actions.some((action) => action.kind === "runUpdate"));
    assert.ok(!enriched.versionAdvisory?.actions.some((action) => action.kind === "copyCommand"));
    assert.ok(enriched.versionAdvisory?.actions.some((action) => action.kind === "openUrl"));
    assert.match(enriched.versionAdvisory?.message ?? "", /not installed with Homebrew/i);
  }),
);

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
