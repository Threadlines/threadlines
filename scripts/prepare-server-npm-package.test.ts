import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, it } from "@effect/vitest";

import {
  createServerNpmPackageJson,
  prepareServerNpmPackage,
} from "./prepare-server-npm-package.ts";

it("creates publishable server package metadata", () => {
  const packageJson = createServerNpmPackageJson(
    {
      name: "@threadlines/server",
      version: "0.0.1",
      dependencies: {
        "@anthropic-ai/claude-agent-sdk": "^0.3.190",
        "@effect/platform-node": "catalog:",
        "@threadlines/shared": "workspace:*",
        "@opencode-ai/sdk": "^1.3.15",
        "@pierre/diffs": "catalog:",
        effect: "catalog:",
        "node-pty": "^1.1.0",
      },
      devDependencies: {
        typescript: "catalog:",
      },
      scripts: {
        build: "vp pack",
      },
    },
    {
      "@effect/platform-node": "4.0.0-beta.59",
      effect: "4.0.0-beta.59",
      typescript: "^5.7.3",
    },
  );

  assert.deepStrictEqual(packageJson, {
    name: "@threadlines/server",
    version: "0.0.1",
    dependencies: {
      "@anthropic-ai/claude-agent-sdk": "^0.3.190",
      "@effect/platform-node": "4.0.0-beta.59",
      effect: "4.0.0-beta.59",
      "node-pty": "^1.1.0",
    },
  });
});

function writeServerPackageFixture(rootDir: string) {
  const serverDir = path.join(rootDir, "apps/server");
  mkdirSync(path.join(serverDir, "dist/client/assets"), { recursive: true });
  writeFileSync(path.join(rootDir, "pnpm-workspace.yaml"), "catalog:\n  effect: 4.0.0\n");
  writeFileSync(
    path.join(serverDir, "package.json"),
    JSON.stringify({
      name: "@threadlines/server",
      version: "0.0.1",
      files: ["dist/**/*.mjs", "dist/client", "LICENSE", "README.md"],
      dependencies: { effect: "catalog:" },
    }),
  );
  writeFileSync(path.join(serverDir, "README.md"), "readme");
  writeFileSync(path.join(serverDir, "LICENSE"), "license");
  writeFileSync(path.join(serverDir, "dist/bin.mjs"), "export {};");
  writeFileSync(path.join(serverDir, "dist/client/index.html"), "<html></html>");
  writeFileSync(path.join(serverDir, "dist/client/assets/app.css"), "body{}");
  writeFileSync(path.join(serverDir, "dist/client/assets/app.js"), "export {};");
  return serverDir;
}

it("stages the bundled web client alongside runtime files", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "prepare-server-npm-package-"));
  try {
    writeServerPackageFixture(rootDir);

    const { outputDir } = prepareServerNpmPackage({ rootDir });

    assert.isTrue(existsSync(path.join(outputDir, "dist/bin.mjs")));
    assert.isTrue(existsSync(path.join(outputDir, "dist/client/index.html")));
    assert.isTrue(existsSync(path.join(outputDir, "dist/client/assets/app.css")));
    assert.isTrue(existsSync(path.join(outputDir, "dist/client/assets/app.js")));
    const staged = JSON.parse(readFileSync(path.join(outputDir, "package.json"), "utf8")) as {
      files?: ReadonlyArray<string>;
    };
    assert.include(staged.files ?? [], "dist/client");
  } finally {
    rmSync(rootDir, { force: true, recursive: true });
  }
});

it("fails when the bundled web client is missing", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "prepare-server-npm-package-"));
  try {
    const serverDir = writeServerPackageFixture(rootDir);
    rmSync(path.join(serverDir, "dist/client"), { force: true, recursive: true });

    assert.throws(() => prepareServerNpmPackage({ rootDir }), /Missing bundled web client/);
  } finally {
    rmSync(rootDir, { force: true, recursive: true });
  }
});
