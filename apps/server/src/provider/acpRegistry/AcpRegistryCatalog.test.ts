// @effect-diagnostics nodeBuiltinImport:off - a temp folder for the catalog's saved copies
import * as NodeFS from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AcpRegistryCatalog } from "@threadlines/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";

import type { DownloadFetch } from "../managedRuntime/VerifiedDownload.ts";
import {
  ACP_REGISTRY_ICON_HOST,
  ACP_REGISTRY_INDEX_URL,
  ACP_REGISTRY_QUARANTINE_URL,
  type AcpRegistryCatalogSnapshot,
  isReservedAcpRegistryEnvName,
  makeAcpRegistryCatalog,
  reduceAcpRegistryIndex,
  toAcpRegistryCatalog,
} from "./AcpRegistryCatalog.ts";
import { acpRegistryRecipeDigest } from "./AcpRegistryRecipe.ts";

const iconUrl = (agentId: string) =>
  `https://${ACP_REGISTRY_ICON_HOST}/registry/v1/latest/${agentId}.svg`;

/**
 * Entries copied from the registry as published on 2026-10-05, with fewer
 * platforms each. `claude-acp` is one Threadlines supports itself.
 */
const REGISTRY = {
  version: "1.0.0",
  agents: [
    {
      id: "auggie",
      name: "Auggie CLI",
      version: "0.36.0",
      description:
        "Augment Code's powerful software agent, backed by industry-leading context engine",
      repository: "https://github.com/augmentcode/auggie",
      website: "https://www.augmentcode.com/",
      authors: ["Augment Code <support@augmentcode.com>"],
      license: "proprietary",
      license_url: "https://github.com/augmentcode/auggie/blob/main/LICENSE.md",
      icon: iconUrl("auggie"),
      distribution: {
        npx: {
          package: "@augmentcode/auggie@0.36.0",
          args: ["--acp"],
          env: { AUGMENT_DISABLE_AUTO_UPDATE: "1" },
        },
      },
    },
    {
      id: "claude-acp",
      name: "Claude Agent",
      version: "0.86.0",
      description: "ACP wrapper for Anthropic's Claude",
      authors: ["Anthropic", "Zed Industries", "JetBrains"],
      license: "proprietary",
      distribution: { npx: { package: "@agentclientprotocol/claude-agent-acp@0.86.0" } },
      icon: iconUrl("claude-acp"),
    },
    {
      id: "cortex-code",
      name: "Cortex Code",
      version: "1.0.73",
      description: "Snowflake's Cortex Code coding agent",
      repository: "https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code",
      authors: ["Snowflake"],
      license: "proprietary",
      distribution: {
        binary: {
          "darwin-aarch64": {
            archive:
              "https://sfc-repo.snowflakecomputing.com/cortex-code-cli/a4643c4278/1.0.73%2B180523.e6179a031de9/coco-1.0.73%2B180523.e6179a031de9-darwin-arm64.tar.gz",
            cmd: "./coco-1.0.73+180523.e6179a031de9-darwin-arm64/cortex",
            args: ["acp", "serve"],
          },
        },
      },
      icon: iconUrl("cortex-code"),
    },
    {
      id: "crow-cli",
      name: "crow-cli",
      version: "0.1.24",
      description: "Minimal ACP Native Coding Agent",
      authors: ["Thomas Wood"],
      license: "Apache-2.0",
      distribution: {
        binary: {
          "darwin-aarch64": {
            archive:
              "https://github.com/crow-cli/crow-cli/releases/download/v0.1.24/crow-cli-darwin-aarch64.tar.gz",
            cmd: "./crow-cli",
            args: ["acp"],
          },
        },
      },
      icon: iconUrl("crow-cli"),
    },
    {
      id: "fast-agent",
      name: "fast-agent",
      version: "0.10.1",
      description: "Code and build agents with comprehensive multi-provider support",
      authors: ["enquiries@fast-agent.ai"],
      license: "Apache 2.0",
      distribution: {
        uvx: {
          package: "fast-agent-acp==0.10.1",
          args: ["-x"],
          env: { FAST_AGENT_MODEL: "codexplan" },
        },
      },
      icon: iconUrl("fast-agent"),
    },
    {
      id: "goose",
      name: "goose",
      version: "1.53.0",
      description: "A local, extensible, open source AI agent that automates engineering tasks",
      repository: "https://github.com/block/goose",
      website: "https://block.github.io/goose/",
      authors: ["Block"],
      license: "Apache-2.0",
      license_url: "https://github.com/block/goose/blob/main/LICENSE",
      distribution: {
        binary: {
          "darwin-aarch64": {
            archive:
              "https://github.com/block/goose/releases/download/v1.53.0/goose-aarch64-apple-darwin.tar.bz2",
            cmd: "./goose",
            args: ["acp"],
            sha256: "49cf9cfd6195f558d0d9f39ccd691213004bccb2c626e2b40b244059ff9dbdba",
          },
          "linux-x86_64": {
            archive:
              "https://github.com/block/goose/releases/download/v1.53.0/goose-x86_64-unknown-linux-gnu.tar.bz2",
            cmd: "./goose",
            args: ["acp"],
            sha256: "2d010c66dfd4348bb437b3a94001882468a5db1aa556858920481522f57752d7",
          },
          "windows-x86_64": {
            archive:
              "https://github.com/block/goose/releases/download/v1.53.0/goose-x86_64-pc-windows-msvc.zip",
            cmd: "./goose-package\\goose.exe",
            args: ["acp"],
            sha256: "3a951c661f12415f7947daac2bb4651af1a7b41532f34d7c2f05ea6636eadaa9",
          },
        },
      },
      icon: iconUrl("goose"),
    },
    {
      id: "kilo",
      name: "Kilo",
      version: "7.8.3",
      description: "The open source coding agent",
      repository: "https://github.com/Kilo-Org/kilocode",
      website: "https://kilo.ai/",
      authors: ["Kilo Code"],
      license: "MIT",
      icon: iconUrl("kilo"),
      distribution: {
        binary: {
          "darwin-aarch64": {
            archive:
              "https://github.com/Kilo-Org/kilocode/releases/download/v7.8.3/kilo-darwin-arm64.zip",
            cmd: "./kilo",
            args: ["acp"],
            sha256: "768dc9961a210628afc8d8db3a6ec5efe963c8588c3b7a8dc083339c2cf82116",
          },
          "linux-x86_64": {
            archive:
              "https://github.com/Kilo-Org/kilocode/releases/download/v7.8.3/kilo-linux-x64.tar.gz",
            cmd: "./kilo",
            args: ["acp"],
            sha256: "43c32cc25e09f2c8ae82faf480f482fb7de1f34ec5047edfde86158681ccb6bc",
          },
        },
        npx: { package: "@kilocode/cli@7.8.3", args: ["acp"] },
      },
    },
    {
      id: "sigit",
      name: "siGit Code",
      version: "1.6.1",
      description:
        "Local-first coding agent. Runs entirely on your machine with optional on-device LLM inference via Onde.",
      repository: "https://github.com/getsigit/sigit",
      website: "https://github.com/getsigit/sigit",
      authors: ["smbCloud"],
      license: "Apache-2.0",
      distribution: {
        binary: {
          "darwin-aarch64": {
            archive:
              "https://github.com/getsigit/sigit/releases/download/v1.6.1/sigit-macos-arm64.tar.gz",
            cmd: "./sigit",
            sha256: "e7a811b0d66475845687193518befd38beaa0b1d1dfb2c5de2ba36913b456b2c",
          },
          "linux-x86_64": {
            archive: "https://github.com/getsigit/sigit/releases/download/v1.6.1/sigit-linux-amd64",
            cmd: "./sigit-linux-amd64",
            sha256: "b674940aeee6d3840150d098df2e12dfc71e69ef3c55f2ecbe8bd01eb978f342",
          },
          "windows-x86_64": {
            archive:
              "https://github.com/getsigit/sigit/releases/download/v1.6.1/sigit-win-amd64.exe",
            cmd: "./sigit-win-amd64.exe",
            sha256: "49517f5fa8e70a0ecd06693137625470d43e7d0595e605690e6bf8f8af055e5a",
          },
        },
        npx: { package: "@smbcloud/sigit@1.6.1" },
      },
      icon: iconUrl("sigit"),
    },
  ],
  // The registry's own schema has no such key; the published file does.
  extensions: [],
};
const QUARANTINE = {
  "crow-cli": "ACP initialize fails in crow-cli 0.1.25",
  "fast-agent": "Timeout after 120s waiting for initialize response",
};

/** A well-formed entry that installs from npm. */
const entry = (overrides: Record<string, unknown> = {}) => ({
  id: "sample",
  name: "Sample",
  version: "1.0.0",
  description: "A sample agent",
  authors: ["Someone"],
  license: "MIT",
  distribution: { npx: { package: "sample-agent@1.0.0" } },
  ...overrides,
});
const npmEntry = (npx: Record<string, unknown>) =>
  entry({ distribution: { npx: { package: "sample-agent@1.0.0", ...npx } } });
/** A well-formed entry that installs from a download, on an Apple Silicon Mac. */
const downloadEntry = (build: Record<string, unknown> = {}) =>
  entry({
    distribution: {
      binary: {
        "darwin-aarch64": {
          archive: "https://downloads.example.com/sample-1.0.0.tar.gz",
          cmd: "./sample",
          ...build,
        },
      },
    },
  });

const reduce = (
  agents: ReadonlyArray<unknown>,
  options: {
    readonly quarantined?: ReadonlyArray<string>;
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
  } = {},
) =>
  reduceAcpRegistryIndex({
    index: { agents },
    quarantined: new Set(options.quarantined),
    platform: options.platform ?? "darwin",
    arch: options.arch ?? "arm64",
  });
/** The recipe one entry reduces to on an Apple Silicon Mac, or undefined when it is left out. */
const recipeOf = (agent: unknown) => reduce([agent]).entries[0]?.recipe;
const digestOf = (agent: unknown) => reduce([agent]).entries[0]?.agent.recipeDigest;

describe("reduceAcpRegistryIndex", () => {
  it("lists what each computer would install, by name", () => {
    const mac = reduce(REGISTRY.agents, { quarantined: Object.keys(QUARANTINE) });
    assert.deepStrictEqual(
      mac.entries.map(({ agent }) => [agent.name, agent.source, agent.integrity]),
      [
        ["Auggie CLI", "npm", "package"],
        ["Cortex Code", "download", "none"],
        ["goose", "download", "checksum"],
        ["Kilo", "download", "checksum"],
        ["siGit Code", "download", "checksum"],
      ],
    );
    assert.equal(mac.unsupportedCount, 0);
    assert.deepStrictEqual(mac.dropped, []);

    const goose = mac.entries.find(({ agent }) => agent.agentId === "goose");
    assert.deepStrictEqual(goose, {
      agent: {
        agentId: "goose",
        name: "goose",
        version: "1.53.0",
        recipeDigest: acpRegistryRecipeDigest(goose!.recipe),
        description: "A local, extensible, open source AI agent that automates engineering tasks",
        authors: ["Block"],
        license: "Apache-2.0",
        website: "https://block.github.io/goose/",
        repository: "https://github.com/block/goose",
        iconSvg: null,
        source: "download",
        packageSpec: null,
        host: "github.com",
        integrity: "checksum",
      },
      recipe: {
        kind: "download",
        agentId: "goose",
        version: "1.53.0",
        args: ["acp"],
        env: {},
        url: "https://github.com/block/goose/releases/download/v1.53.0/goose-aarch64-apple-darwin.tar.bz2",
        sha256: "49cf9cfd6195f558d0d9f39ccd691213004bccb2c626e2b40b244059ff9dbdba",
        format: "tar.bz2",
        cmd: "goose",
      },
      iconUrl: iconUrl("goose"),
    });
    const auggie = mac.entries.find(({ agent }) => agent.agentId === "auggie");
    assert.equal(auggie?.agent.packageSpec, "@augmentcode/auggie@0.36.0");
    assert.deepStrictEqual(auggie?.recipe, {
      kind: "npm",
      agentId: "auggie",
      version: "0.36.0",
      args: ["--acp"],
      env: { AUGMENT_DISABLE_AUTO_UPDATE: "1" },
      packageName: "@augmentcode/auggie",
      packageVersion: "0.36.0",
    });

    // Windows on x64: Kilo has builds for other computers only, so its npm
    // package is used; Cortex Code has nothing to fall back on.
    const windows = reduce(REGISTRY.agents, {
      quarantined: Object.keys(QUARANTINE),
      platform: "win32",
      arch: "x64",
    });
    assert.deepStrictEqual(
      windows.entries.map(({ recipe }) =>
        recipe.kind === "npm"
          ? [recipe.agentId, recipe.packageName]
          : [recipe.agentId, recipe.format, recipe.cmd],
      ),
      [
        ["auggie", "@augmentcode/auggie"],
        ["goose", "zip", "goose-package/goose.exe"],
        ["kilo", "@kilocode/cli"],
        ["sigit", "raw", "sigit-win-amd64.exe"],
      ],
    );
    assert.equal(windows.unsupportedCount, 1);

    // A computer the registry has no name for can still run npm packages.
    const freebsd = reduce(REGISTRY.agents, { platform: "freebsd", arch: "x64" });
    assert.deepStrictEqual(
      freebsd.entries.map(({ recipe }) => [recipe.agentId, recipe.kind]),
      [
        ["auggie", "npm"],
        ["kilo", "npm"],
        ["sigit", "npm"],
      ],
    );
  });

  it("hides built-in and quarantined agents without counting them as unsupported", () => {
    const ids = (quarantined: ReadonlyArray<string>) => {
      const { entries, unsupportedCount } = reduce(REGISTRY.agents, { quarantined });
      return { listed: entries.map(({ agent }) => agent.agentId), unsupportedCount };
    };
    // Nothing quarantined: crow-cli shows, and fast-agent (Python only) is counted.
    assert.deepStrictEqual(ids([]), {
      listed: ["auggie", "cortex-code", "crow-cli", "goose", "kilo", "sigit"],
      unsupportedCount: 1,
    });
    assert.deepStrictEqual(ids(["crow-cli", "fast-agent", "goose"]), {
      listed: ["auggie", "cortex-code", "kilo", "sigit"],
      unsupportedCount: 0,
    });
  });

  it("drops an agent that breaks a bound, and only that agent", () => {
    const neighbour = entry({ id: "neighbour", name: "Neighbour" });
    const broken: ReadonlyArray<readonly [what: string, agent: unknown]> = [
      ["not an object", "sample"],
      ["no id", entry({ id: undefined })],
      ["capitals in the id", entry({ id: "Sample" })],
      ["an id that starts with a digit", entry({ id: "1sample" })],
      ["an id of 60 characters", entry({ id: "a".repeat(60) })],
      ["no version", entry({ version: undefined })],
      ["a version of 65 characters", entry({ version: "1".repeat(65) })],
      ["a version with a space", entry({ version: "1.0 beta" })],
      ["a blank name", entry({ name: "  " })],
      ["no distribution", entry({ distribution: undefined })],
      ["an npx entry that is not an object", entry({ distribution: { npx: "sample@1.0.0" } })],
      [
        "a build that is not an object",
        entry({ distribution: { binary: { "darwin-aarch64": "https://example.com/a.zip" } } }),
      ],
      ["65 args", npmEntry({ args: Array.from({ length: 65 }, () => "x") })],
      ["an arg of 1025 characters", npmEntry({ args: ["x".repeat(1025)] })],
      ["an arg that is not text", npmEntry({ args: ["acp", 5] })],
      ["args that are not a list", npmEntry({ args: "acp" })],
      [
        "65 env entries",
        npmEntry({ env: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`V${i}`, "1"])) }),
      ],
      ["an env name with a dash", npmEntry({ env: { "MY-VAR": "1" } })],
      ["an env name that starts with a digit", npmEntry({ env: { "1VAR": "1" } })],
      ["an env value of 4097 characters", npmEntry({ env: { VAR: "x".repeat(4097) } })],
      ["an env value that is not text", npmEntry({ env: { VAR: 1 } })],
      ["an env that is not an object", npmEntry({ env: ["VAR=1"] })],
    ];
    for (const [what, agent] of broken) {
      const result = reduce([agent, neighbour]);
      assert.deepStrictEqual(
        result.entries.map((listed) => listed.agent.agentId),
        ["neighbour"],
        what,
      );
      assert.equal(result.dropped.length, 1, what);
      assert.equal(result.unsupportedCount, 0, what);
    }

    // Right at each bound, an agent is kept.
    const atTheBounds = npmEntry({
      args: Array.from({ length: 64 }, () => "x".repeat(1024)),
      env: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`V${i}`, "x".repeat(4096)])),
    });
    const kept = reduce([{ ...atTheBounds, id: "a".repeat(59), version: "1".repeat(64) }]);
    assert.equal(kept.entries[0]?.recipe.args.length, 64);
    assert.deepStrictEqual(kept.dropped, []);

    // Two entries with one id: the first stands.
    const twice = reduce([entry({ version: "1.0.0" }), entry({ version: "2.0.0" })]);
    assert.deepStrictEqual(
      twice.entries.map(({ agent }) => agent.version),
      ["1.0.0"],
    );
    assert.equal(twice.dropped.length, 1);
  });

  it("reads at most 512 agents", () => {
    const many = Array.from({ length: 600 }, (_, i) => entry({ id: `agent-${i}` }));
    const result = reduce(many);
    assert.equal(result.entries.length, 512);
    assert.equal(result.dropped.length, 1);
  });

  it("cuts free text to its bound, and keeps only plain https links", () => {
    const [long] = reduce([
      entry({
        // The 160th unit is the first half of an emoji.
        name: `${"n".repeat(159)}\u{1f600}tail`,
        description: "d".repeat(2000),
        authors: [...Array.from({ length: 20 }, (_, i) => `${i}${"a".repeat(300)}`), 7],
        license: "l".repeat(200),
        website: "https://example.com/agent",
        repository: "https://github.com/example/agent",
      }),
    ]).entries;
    assert.equal(long?.agent.name, "n".repeat(159));
    assert.equal(long?.agent.description.length, 1024);
    assert.equal(long?.agent.authors.length, 16);
    assert.isTrue(long?.agent.authors.every((author) => author.length === 256));
    assert.equal(long?.agent.license?.length, 128);
    assert.equal(long?.agent.website, "https://example.com/agent");
    assert.equal(long?.agent.repository, "https://github.com/example/agent");

    for (const link of [
      "http://example.com/agent",
      "https://user:secret@example.com/agent",
      "javascript:alert(1)",
      "example.com/agent",
      `https://example.com/${"p".repeat(2048)}`,
      42,
    ]) {
      const [listed] = reduce([entry({ website: link, repository: link })]).entries;
      assert.deepStrictEqual(
        [listed?.agent.agentId, listed?.agent.website, listed?.agent.repository],
        ["sample", null, null],
        String(link),
      );
    }
  });

  it("takes an npm package only as a name and one exact version", () => {
    const recipeFor = (spec: unknown) =>
      recipeOf(entry({ distribution: { npx: { package: spec } } }));
    for (const [spec, packageName, packageVersion] of [
      ["sample-agent@1.2.3", "sample-agent", "1.2.3"],
      ["@scope/sample.agent@1.2.3-beta.1", "@scope/sample.agent", "1.2.3-beta.1"],
      ["sample@0.0.34+build.5", "sample", "0.0.34+build.5"],
    ] as const) {
      const recipe = recipeFor(spec);
      assert.deepStrictEqual(
        recipe?.kind === "npm" && [recipe.packageName, recipe.packageVersion],
        [packageName, packageVersion],
        spec,
      );
    }
    for (const spec of [
      "sample-agent",
      "@scope/sample-agent",
      "sample-agent@",
      "@1.2.3",
      "sample-agent@latest",
      "sample-agent@next",
      "sample-agent@1",
      "sample-agent@1.2",
      "sample-agent@1.x",
      "sample-agent@^1.2.3",
      "sample-agent@~1.2.3",
      "sample-agent@>=1.2.3",
      "sample-agent@1.2.3 || 2.0.0",
      "sample-agent@1.2.3 - 2.0.0",
      "sample-agent@v1.2.3",
      "sample-agent@=1.2.3",
      "sample-agent@01.2.3",
      "sample-agent@*",
      "alias@npm:sample-agent@1.2.3",
      "sample-agent@https://example.com/sample-agent-1.2.3.tgz",
      "https://example.com/sample-agent-1.2.3.tgz",
      "sample-agent@git+https://github.com/example/agent.git#v1.2.3",
      "github:example/agent",
      "example/agent@1.2.3",
      "sample-agent@file:../agent",
      "../agent@1.2.3",
      "Sample-Agent@1.2.3",
      "sample agent@1.2.3",
      "@scope@1.2.3",
      `${"a".repeat(215)}@1.2.3`,
      42,
    ]) {
      assert.isUndefined(recipeFor(spec), String(spec));
    }
  });

  it("takes a download only from a named https host, in a format it can unpack", () => {
    const formatOf = (archive: string, cmd = "./sample") => {
      const recipe = recipeOf(downloadEntry({ archive, cmd }));
      return recipe?.kind === "download" ? recipe.format : undefined;
    };
    for (const [file, format] of [
      ["sample.zip", "zip"],
      ["SAMPLE.ZIP", "zip"],
      ["sample.tar.gz", "tar.gz"],
      ["sample.tgz", "tar.gz"],
      ["sample.tar.bz2", "tar.bz2"],
      ["sample.tbz2", "tar.bz2"],
      ["sample.zip?token=abc#top", "zip"],
      // The program itself.
      ["sample-linux-amd64", "raw"],
      ["sample.exe", "raw"],
      ["sample.bin", "raw"],
      ["sample-1.2.3", "raw"],
      ["sample-v1.2.3-linux-x64", "raw"],
    ] as const) {
      assert.equal(formatOf(`https://downloads.example.com/v1/${file}`), format, file);
    }
    for (const file of [
      "sample.tar.xz",
      "sample.txz",
      "sample.tar.zst",
      "sample.7z",
      "sample.gz",
      "sample.tar",
      "sample.dmg",
      "sample.msi",
      "sample.pkg",
      "sample.deb",
      "sample.AppImage",
      "sample.sh",
    ]) {
      assert.isUndefined(formatOf(`https://downloads.example.com/v1/${file}`), file);
    }
    for (const archive of [
      "http://downloads.example.com/sample.zip",
      "https://user:secret@downloads.example.com/sample.zip",
      "https://93.184.216.34/sample.zip",
      "https://2130706433/sample.zip",
      "https://[2606:4700:4700::1111]/sample.zip",
      "ftp://downloads.example.com/sample.zip",
      "downloads.example.com/sample.zip",
      "",
    ]) {
      assert.isUndefined(formatOf(archive), archive);
    }
    assert.isUndefined(recipeOf(downloadEntry({ archive: undefined })));
  });

  it("takes a command only as a path inside the download, and a checksum only whole", () => {
    const cmdOf = (cmd: unknown, archive = "https://downloads.example.com/sample.zip") => {
      const recipe = recipeOf(downloadEntry({ archive, cmd }));
      return recipe?.kind === "download" ? recipe.cmd : undefined;
    };
    assert.equal(cmdOf("./sample"), "sample");
    assert.equal(cmdOf("sample.exe"), "sample.exe");
    assert.equal(cmdOf("./bin\\sample.exe"), "bin/sample.exe");
    assert.equal(cmdOf(".\\bin\\sample.exe"), "bin/sample.exe");
    assert.equal(
      cmdOf("./Applications/Sample App.app/Contents/MacOS/sample"),
      "Applications/Sample App.app/Contents/MacOS/sample",
    );
    assert.equal(cmdOf(`./${"c".repeat(1024)}`)?.length, 1024);
    for (const cmd of [
      "",
      "./",
      ".",
      "..",
      "../sample",
      "./bin/../../sample",
      "bin\\..\\..\\sample",
      "/usr/bin/sample",
      "\\\\server\\share\\sample.exe",
      "C:\\Windows\\System32\\cmd.exe",
      "C:/Windows/System32/cmd.exe",
      "bin//sample",
      "bin/./sample",
      "bin/sample/",
      "sample\u0000",
      "sample\n",
      ".\u200d./sample",
      `./${"c".repeat(1025)}`,
      undefined,
      7,
    ]) {
      assert.isUndefined(cmdOf(cmd), JSON.stringify(cmd));
    }
    // A download that is the program itself is saved under one name.
    const raw = "https://downloads.example.com/sample-linux-amd64";
    assert.equal(cmdOf("./sample-linux-amd64", raw), "sample-linux-amd64");
    assert.isUndefined(cmdOf("./bin/sample", raw));

    const sha256Of = (sha256: unknown) => {
      const [listed] = reduce([downloadEntry(sha256 === undefined ? {} : { sha256 })]).entries;
      return listed?.recipe.kind === "download"
        ? [listed.recipe.sha256, listed.agent.integrity]
        : undefined;
    };
    assert.deepStrictEqual(sha256Of(undefined), [null, "none"]);
    assert.deepStrictEqual(sha256Of("ABCDEF0123456789".repeat(4)), [
      "abcdef0123456789".repeat(4),
      "checksum",
    ]);
    for (const sha256 of ["a".repeat(63), "a".repeat(65), "g".repeat(64), "", null, 7]) {
      assert.isUndefined(sha256Of(sha256), JSON.stringify(sha256));
    }
  });

  it("names a recipe by everything that would be installed and run, and nothing else", () => {
    const build = {
      archive: "https://downloads.example.com/sample-1.0.0.tar.gz",
      sha256: "a".repeat(64),
      cmd: "./sample",
      args: ["acp"],
      env: { SAMPLE_MODE: "acp", SAMPLE_UPDATES: "off" },
    };
    const digest = digestOf(downloadEntry(build));
    assert.match(digest ?? "", /^[0-9a-f]{64}$/u);

    for (const [what, changed] of [
      ["address", { archive: "https://downloads.example.com/sample-1.0.1.tar.gz" }],
      ["checksum", { sha256: "b".repeat(64) }],
      ["no checksum", { sha256: undefined }],
      ["command", { cmd: "./bin/sample" }],
      ["args", { args: ["acp", "--verbose"] }],
      ["env", { env: { SAMPLE_MODE: "acp", SAMPLE_UPDATES: "on" } }],
    ] as const) {
      const { sha256, ...rest } = { ...build, ...changed };
      const other = digestOf(downloadEntry(sha256 === undefined ? rest : { ...rest, sha256 }));
      assert.match(other ?? "", /^[0-9a-f]{64}$/u, what);
      assert.notEqual(other, digest, what);
    }
    assert.notEqual(digestOf({ ...downloadEntry(build), version: "1.0.1" }), digest);

    // What a client only shows is not part of it. Nor is the order of the
    // registry's env, nor an env name that is filtered out.
    assert.equal(
      digestOf({
        ...downloadEntry({
          ...build,
          env: { PATH: "/tmp/bin", SAMPLE_UPDATES: "off", SAMPLE_MODE: "acp" },
        }),
        name: "Renamed",
        description: "Another description",
        authors: ["Somebody else"],
        license: "Apache-2.0",
        website: "https://example.com/",
        icon: iconUrl("sample"),
      }),
      digest,
    );
  });

  it("filters reserved names out of the registry's env, whatever their case", () => {
    for (const name of [
      "PATH",
      "Path",
      "home",
      "UserProfile",
      "APPDATA",
      "LocalAppData",
      "TMPDIR",
      "temp",
      "TMP",
      "NODE_OPTIONS",
      "node_path",
      "NODE_EXTRA_CA_CERTS",
      "LD_PRELOAD",
      "ld_library_path",
      "DYLD_INSERT_LIBRARIES",
      "PYTHONPATH",
      "PythonHome",
      "npm_config_registry",
      "NPM_CONFIG_PREFIX",
      "THREADLINES_HOME",
      "threadlines_port",
      "HTTP_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "no_proxy",
    ]) {
      assert.isTrue(isReservedAcpRegistryEnvName(name), name);
    }
    for (const name of [
      "AUGMENT_DISABLE_AUTO_UPDATE",
      "PATHS",
      "MY_HOME",
      "NODE_ENV",
      "LDFLAGS",
      "PROXY",
      "TEMPLATE",
    ]) {
      assert.isFalse(isReservedAcpRegistryEnvName(name), name);
    }

    // The agent stays; only the names go.
    assert.deepStrictEqual(
      recipeOf(
        npmEntry({
          env: {
            Path: "/tmp/bin",
            node_options: "--require /tmp/x.js",
            HTTPS_PROXY: "http://proxy.example.com",
            SAMPLE_DISABLE_AUTO_UPDATE: "1",
          },
        }),
      )?.env,
      { SAMPLE_DISABLE_AUTO_UPDATE: "1" },
    );
  });
});

const NOON = Date.parse("2026-10-05T12:00:00.000Z");
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16z"/></svg>';
const UNAVAILABLE =
  "Couldn't read the community agent list. Check your internet connection and try again.";

const decodeCatalog = Schema.decodeUnknownSync(AcpRegistryCatalog);

type Route = () => Response | Promise<Response>;
const json =
  (value: unknown): Route =>
  () =>
    new Response(JSON.stringify(value));
const body =
  (value: string | Uint8Array<ArrayBuffer>): Route =>
  () =>
    new Response(value);
const unreachable: Route = () => Promise.reject(new Error("getaddrinfo ENOTFOUND"));

/** A registry that answers by address from `routes` (404 otherwise) and records what it was asked. */
function fakeRegistry(routes: Record<string, Route>) {
  const requests: Array<string> = [];
  const fetch: DownloadFetch = async (url) => {
    requests.push(url);
    return (routes[url] ?? (() => new Response("not found", { status: 404 })))();
  };
  return {
    fetch,
    routes,
    asked: (url: string) => requests.filter((request) => request === url).length,
  };
}

/** The registry of `REGISTRY`, with an icon for each of its agents. */
const publishedRoutes = (): Record<string, Route> => ({
  [ACP_REGISTRY_INDEX_URL]: json(REGISTRY),
  [ACP_REGISTRY_QUARANTINE_URL]: json(QUARANTINE),
  ...Object.fromEntries(REGISTRY.agents.map((agent) => [iconUrl(agent.id), body(SVG)])),
});

const tempCacheDir = Effect.acquireRelease(
  Effect.promise(() => NodeFS.mkdtemp(path.join(os.tmpdir(), "threadlines-acp-catalog-test-"))),
  (dir) => Effect.promise(() => NodeFS.rm(dir, { recursive: true, force: true })),
);

const makeCatalog = (cacheDir: string, fetch: DownloadFetch) =>
  makeAcpRegistryCatalog({ cacheDir, platform: "darwin", arch: "arm64", fetch });

/** A moment of real time, for fibers that are ready to run until each waits on something. */
const settle = TestClock.withLive(Effect.sleep(Duration.millis(5)));

const listedIds = (snapshot: AcpRegistryCatalogSnapshot) =>
  snapshot.entries.map(({ agent }) => agent.agentId);

describe("makeAcpRegistryCatalog", () => {
  it.effect("reads the registry, then serves it from memory for five minutes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOON);
      const cacheDir = yield* tempCacheDir;
      const registry = fakeRegistry(publishedRoutes());
      const catalog = makeCatalog(cacheDir, registry.fetch);
      assert.isUndefined(yield* catalog.peek);

      const first = yield* catalog.get();
      assert.deepStrictEqual(listedIds(first), ["auggie", "cortex-code", "goose", "kilo", "sigit"]);
      assert.deepStrictEqual(
        {
          fetchedAt: first.fetchedAt,
          stale: first.stale,
          quarantineKnown: first.quarantineKnown,
          unsupportedCount: first.unsupportedCount,
        },
        {
          fetchedAt: "2026-10-05T12:00:00.000Z",
          stale: false,
          quarantineKnown: true,
          unsupportedCount: 0,
        },
      );
      for (const { agent, recipe } of first.entries) {
        assert.equal(agent.recipeDigest, acpRegistryRecipeDigest(recipe));
      }
      // What a client is sent fits the wire's bounds, icons included.
      assert.deepStrictEqual(
        decodeCatalog(toAcpRegistryCatalog(first)).agents.map((agent) => agent.iconSvg),
        [SVG, SVG, SVG, SVG, SVG],
      );

      yield* TestClock.adjust(Duration.seconds(299));
      assert.strictEqual(yield* catalog.get(), first);
      assert.strictEqual(yield* catalog.peek, first);
      assert.equal(registry.asked(ACP_REGISTRY_INDEX_URL), 1);

      yield* catalog.get({ refresh: true });
      assert.equal(registry.asked(ACP_REGISTRY_INDEX_URL), 2);
      assert.equal(registry.asked(ACP_REGISTRY_QUARANTINE_URL), 2);

      yield* TestClock.adjust(Duration.minutes(5));
      const later = yield* catalog.get();
      assert.equal(later.fetchedAt, "2026-10-05T12:09:59.000Z");
      assert.equal(registry.asked(ACP_REGISTRY_INDEX_URL), 3);
      // Icons are saved by address: no later read asked for one again.
      assert.equal(registry.asked(iconUrl("goose")), 1);
    }),
  );

  it.effect("shares one read between calls that overlap", () =>
    Effect.gen(function* () {
      const cacheDir = yield* tempCacheDir;
      const published = publishedRoutes();
      const asked = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<void>();
      const registry = fakeRegistry({
        ...published,
        [ACP_REGISTRY_INDEX_URL]: async () => {
          asked.resolve();
          await answer.promise;
          return json(REGISTRY)();
        },
      });
      const catalog = makeCatalog(cacheDir, registry.fetch);

      const both = yield* Effect.all(
        [catalog.get({ refresh: true }), catalog.get({ refresh: true })],
        { concurrency: 2 },
      ).pipe(Effect.forkScoped);
      yield* Effect.promise(() => asked.promise);
      yield* settle;
      answer.resolve();

      const [first, second] = yield* Fiber.join(both);
      assert.strictEqual(first, second);
      assert.equal(registry.asked(ACP_REGISTRY_INDEX_URL), 1);
      assert.equal(registry.asked(ACP_REGISTRY_QUARANTINE_URL), 1);
    }),
  );

  it.effect("serves the saved copy, marked stale, when the registry can't be read", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOON);
      const cacheDir = yield* tempCacheDir;
      const registry = fakeRegistry(publishedRoutes());
      const catalog = makeCatalog(cacheDir, registry.fetch);
      const fresh = yield* catalog.get();

      registry.routes[ACP_REGISTRY_INDEX_URL] = unreachable;
      registry.routes[ACP_REGISTRY_QUARANTINE_URL] = unreachable;
      yield* TestClock.adjust(Duration.minutes(10));
      assert.deepStrictEqual(yield* catalog.get(), { ...fresh, stale: true });

      // A server that starts while the registry is unreachable has the copy
      // on disk, icons included, and knows when it was read.
      const offline = fakeRegistry({});
      const restarted = makeCatalog(cacheDir, offline.fetch);
      assert.deepStrictEqual(yield* restarted.peek, { ...fresh, stale: true });
      assert.equal(offline.asked(ACP_REGISTRY_INDEX_URL), 0);
      assert.deepStrictEqual(yield* restarted.get(), { ...fresh, stale: true });
      assert.equal(offline.asked(ACP_REGISTRY_INDEX_URL), 1);
    }),
  );

  it.effect("fails only when there is no copy at all, and saves nothing that isn't an index", () =>
    Effect.gen(function* () {
      const cacheDir = yield* tempCacheDir;
      const registry = fakeRegistry(publishedRoutes());
      const catalog = makeCatalog(cacheDir, registry.fetch);

      const notAnIndex: ReadonlyArray<readonly [what: string, route: Route]> = [
        ["unreachable", unreachable],
        ["an error", () => new Response("down for maintenance", { status: 503 })],
        ["a page", body("<!doctype html><title>Sign in</title>")],
        ["other JSON", json({ version: "1.0.0" })],
        // An index in every way but its size: over 1 MiB.
        ["too large", json({ ...REGISTRY, padding: "x".repeat(1024 * 1024) })],
      ];
      for (const [what, route] of notAnIndex) {
        registry.routes[ACP_REGISTRY_INDEX_URL] = route;
        const error = yield* Effect.flip(catalog.get());
        assert.deepStrictEqual(
          [error.reason, error.detail],
          ["catalogUnavailable", UNAVAILABLE],
          what,
        );
        assert.isUndefined(yield* catalog.peek, what);
      }

      // The failure isn't remembered.
      registry.routes[ACP_REGISTRY_INDEX_URL] = json(REGISTRY);
      assert.isFalse((yield* catalog.get()).stale);
    }),
  );

  it.effect("gives up on a registry that doesn't answer within 30 seconds", () =>
    Effect.gen(function* () {
      const cacheDir = yield* tempCacheDir;
      // Asked for the index and the quarantine list, it answers neither.
      let waiting = 0;
      const bothAsked = Promise.withResolvers<void>();
      const silent: DownloadFetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          waiting += 1;
          if (waiting === 2) bothAsked.resolve();
        });
      const catalog = makeCatalog(cacheDir, silent);

      const failed = yield* catalog.get().pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.promise(() => bothAsked.promise);
      yield* TestClock.adjust(Duration.seconds(29));
      yield* settle;
      assert.isUndefined(failed.pollUnsafe());
      yield* TestClock.adjust(Duration.seconds(1));
      assert.equal((yield* Fiber.join(failed)).reason, "catalogUnavailable");
    }),
  );

  it.effect("lists agents before the quarantine list has ever been read, and says so", () =>
    Effect.gen(function* () {
      const cacheDir = yield* tempCacheDir;
      const registry = fakeRegistry({
        ...publishedRoutes(),
        [ACP_REGISTRY_QUARANTINE_URL]: unreachable,
      });
      const catalog = makeCatalog(cacheDir, registry.fetch);

      const unchecked = yield* catalog.get();
      assert.isFalse(unchecked.quarantineKnown);
      assert.isFalse(unchecked.stale);
      assert.include(listedIds(unchecked), "crow-cli");

      // Not a quarantine list: an answer of another shape, or one over 64 KiB.
      for (const route of [
        json({ quarantined: ["crow-cli"] }),
        json({ ...QUARANTINE, padding: "x".repeat(64 * 1024) }),
      ]) {
        registry.routes[ACP_REGISTRY_QUARANTINE_URL] = route;
        assert.isFalse((yield* catalog.get({ refresh: true })).quarantineKnown);
      }

      registry.routes[ACP_REGISTRY_QUARANTINE_URL] = json(QUARANTINE);
      const checked = yield* catalog.get({ refresh: true });
      assert.isTrue(checked.quarantineKnown);
      assert.notInclude(listedIds(checked), "crow-cli");

      // Once read, the saved list keeps hiding what it names.
      registry.routes[ACP_REGISTRY_QUARANTINE_URL] = unreachable;
      const saved = yield* catalog.get({ refresh: true });
      assert.deepStrictEqual(
        [saved.quarantineKnown, saved.stale, listedIds(saved).includes("crow-cli")],
        [true, true, false],
      );
    }),
  );

  it.effect("keeps an icon only when it is an SVG from the registry's own host", () =>
    Effect.gen(function* () {
      const cacheDir = yield* tempCacheDir;
      const elsewhere = "https://icons.example.com/elsewhere.svg";
      const agents = [
        entry({ id: "good", icon: iconUrl("good") }),
        entry({ id: "elsewhere", icon: elsewhere }),
        entry({ id: "plain-http", icon: iconUrl("plain-http").replace("https:", "http:") }),
        entry({ id: "picture", icon: iconUrl("picture") }),
        entry({ id: "page", icon: iconUrl("page") }),
        entry({ id: "not-text", icon: iconUrl("not-text") }),
        entry({ id: "too-large", icon: iconUrl("too-large") }),
        entry({ id: "missing", icon: iconUrl("missing") }),
        entry({ id: "none" }),
      ];
      const registry = fakeRegistry({
        [ACP_REGISTRY_INDEX_URL]: json({ agents }),
        [ACP_REGISTRY_QUARANTINE_URL]: json({}),
        [iconUrl("good")]: body(SVG),
        [elsewhere]: body(SVG),
        [iconUrl("picture")]: body(
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        ),
        [iconUrl("page")]: body("<!doctype html><title>Not found</title>"),
        // "<svg" and then a byte that is not UTF-8.
        [iconUrl("not-text")]: body(new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0xff, 0x3e])),
        [iconUrl("too-large")]: body(`<svg>${" ".repeat(32 * 1024)}</svg>`),
      });
      const catalog = makeCatalog(cacheDir, registry.fetch);

      const icons = (snapshot: AcpRegistryCatalogSnapshot) =>
        Object.fromEntries(
          snapshot.entries
            .filter(({ agent }) => agent.iconSvg !== null)
            .map(({ agent }) => [agent.agentId, agent.iconSvg]),
        );
      const first = yield* catalog.get();
      assert.equal(first.entries.length, agents.length);
      assert.deepStrictEqual(icons(first), { good: SVG });
      assert.equal(registry.asked(elsewhere), 0);

      // A refresh asks again for what it didn't get, not for what it saved.
      registry.routes[iconUrl("missing")] = body(SVG);
      assert.deepStrictEqual(icons(yield* catalog.get({ refresh: true })), {
        good: SVG,
        missing: SVG,
      });
      assert.equal(registry.asked(iconUrl("good")), 1);
      assert.equal(registry.asked(iconUrl("missing")), 2);
    }),
  );
});
