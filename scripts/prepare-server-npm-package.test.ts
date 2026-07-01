import { assert, it } from "@effect/vitest";

import { createServerNpmPackageJson } from "./prepare-server-npm-package.ts";

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
