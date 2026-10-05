import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  ISOLATED_CLAUDE_CONFIG_DIR_ENV,
  resolveThrowawayClaudeConfigDir,
  throwawayClaudeSpawnViolation,
} from "./claudeThrowawayIsolation.ts";

describe("throwaway runs keep Claude in their own folder", () => {
  const resolve = (baseDir: string, environment: NodeJS.ProcessEnv = {}) =>
    resolveThrowawayClaudeConfigDir({
      baseDir,
      baseDirs: [baseDir],
      tempDirs: ["/var/folders/x/T", "/tmp"],
      environment,
      join: NodePath.posix.join,
    });

  it("gives a run inside a temp folder its own Claude folder, and nothing else", () => {
    expect(resolve("/tmp/tl-verify")).toBe("/tmp/tl-verify/claude-config");
    expect(resolve("/var/folders/x/T/tl-smoke")).toBe("/var/folders/x/T/tl-smoke/claude-config");
    // A real install, a folder someone already chose, and a run that asked to share.
    expect(resolve("/Users/me/.threadlines")).toBeUndefined();
    expect(
      resolve("/tmp/tl-verify", { CLAUDE_CONFIG_DIR: "/Users/me/claude-work" }),
    ).toBeUndefined();
    expect(resolve("/tmp/tl-verify", { THREADLINES_SHARE_CLAUDE_SIGN_IN: "true" })).toBeUndefined();
  });

  it("refuses to start Claude on a sign-in outside an isolated run", () => {
    const isolated = { [ISOLATED_CLAUDE_CONFIG_DIR_ENV]: "/tmp/tl-verify/claude-config" };
    const violation = (spawnEnvironment: NodeJS.ProcessEnv, run: NodeJS.ProcessEnv = isolated) =>
      throwawayClaudeSpawnViolation(spawnEnvironment, run);
    const realAccount = { CLAUDE_CONFIG_DIR: "/Users/me/.threadlines/userdata/accounts/work" };

    expect(violation({ CLAUDE_CONFIG_DIR: "/tmp/tl-verify/claude-config" })).toBeUndefined();
    expect(violation({ CLAUDE_CONFIG_DIR: "/tmp/tl-verify/dev/accounts/work" })).toBeUndefined();
    // Settings copied from a real install point at a real account's folder.
    expect(violation(realAccount)).toContain("THREADLINES_SHARE_CLAUDE_SIGN_IN");
    expect(violation({})).toContain("outside it");
    // The right folder, but the keychain item is named by something else.
    expect(
      violation({
        CLAUDE_CONFIG_DIR: "/tmp/tl-verify/claude-config",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
      }),
    ).toContain("CLAUDE_SECURESTORAGE_CONFIG_DIR");
    // Not isolated: every folder is the user's to use.
    expect(violation(realAccount, {})).toBeUndefined();
  });
});
