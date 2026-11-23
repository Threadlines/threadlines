// @effect-diagnostics nodeBuiltinImport:off - builds a fake home and profile on disk
import * as NodeFS from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  ANTIGRAVITY_SHARED_DIRS,
  ANTIGRAVITY_SHARED_FILES,
  antigravityUserHome,
  shareAntigravityUserConfigNow,
} from "./AntigravityUserConfig.ts";

const roots: Array<string> = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFS.rm(root, { recursive: true })));
});

async function makeSetup() {
  const root = await NodeFS.realpath(await NodeFS.mkdtemp(path.join(os.tmpdir(), "agy-share-")));
  roots.push(root);
  const userHome = path.join(root, "home");
  const gemini = path.join(userHome, ".gemini");
  const profileDir = path.join(root, "profile");
  await NodeFS.mkdir(profileDir, { recursive: true });
  const write = async (rel: string, content: string) => {
    const file = path.join(gemini, ...rel.split("/"));
    await NodeFS.mkdir(path.dirname(file), { recursive: true });
    await NodeFS.writeFile(file, content);
    return file;
  };
  return { root, userHome, gemini, profileDir, write };
}

const inProfile = (profileDir: string, rel: string) => path.join(profileDir, ...rel.split("/"));
const linkOf = (file: string) => NodeFS.readlink(file).catch(() => undefined);
const exists = (file: string) =>
  NodeFS.lstat(file).then(
    () => true,
    () => false,
  );

/** Everything in the profile except the record Threadlines keeps. */
async function profileEntries(profileDir: string): Promise<Array<string>> {
  const found: Array<string> = [];
  const walk = async (dir: string) => {
    for (const entry of await NodeFS.readdir(dir, { withFileTypes: true })) {
      const rel = path.relative(profileDir, path.join(dir, entry.name)).split(path.sep).join("/");
      if (rel === "threadlines-shared-config.json") continue;
      found.push(rel);
      if (entry.isDirectory()) await walk(path.join(dir, entry.name));
    }
  };
  await walk(profileDir);
  return found.toSorted();
}

describe("shareAntigravityUserConfigNow on macOS and Linux", () => {
  it("links the rules and skills that exist, and nothing else from ~/.gemini", async () => {
    const setup = await makeSetup();
    for (const rel of ANTIGRAVITY_SHARED_FILES) await setup.write(rel, `rule ${rel}`);
    for (const rel of ANTIGRAVITY_SHARED_DIRS) await setup.write(`${rel}/one/SKILL.md`, "x");
    // Never shared: sign-in, hooks, MCP, plugins, settings.
    for (const rel of [
      "antigravity-cli/antigravity-oauth-token",
      "config/hooks.json",
      "config/mcp_config.json",
      "config/plugins/p/plugin.json",
      "config/config.json",
      "antigravity-cli/settings.json",
    ]) {
      await setup.write(rel, "secret");
    }

    const problems = await shareAntigravityUserConfigNow({ ...setup, platform: "darwin" });

    expect(problems).toEqual([]);
    for (const rel of [...ANTIGRAVITY_SHARED_FILES, ...ANTIGRAVITY_SHARED_DIRS]) {
      expect(await linkOf(inProfile(setup.profileDir, rel))).toBe(path.join(setup.gemini, rel));
    }
    expect(await profileEntries(setup.profileDir)).toEqual(
      [
        "antigravity-cli",
        "config",
        ...ANTIGRAVITY_SHARED_FILES,
        ...ANTIGRAVITY_SHARED_DIRS,
      ].toSorted(),
    );
  });

  it("does nothing without ~/.gemini, and picks up a source that appears later", async () => {
    const setup = await makeSetup();
    expect(await shareAntigravityUserConfigNow({ ...setup, platform: "linux" })).toEqual([]);
    expect(await profileEntries(setup.profileDir)).toEqual([]);

    // The agent creates an empty skills folder of its own meanwhile.
    await NodeFS.mkdir(inProfile(setup.profileDir, "config/skills"), { recursive: true });
    await setup.write("GEMINI.md", "rule");
    await setup.write("config/skills/review/SKILL.md", "x");
    await shareAntigravityUserConfigNow({ ...setup, platform: "linux" });

    expect(await linkOf(inProfile(setup.profileDir, "GEMINI.md"))).toBe(
      path.join(setup.gemini, "GEMINI.md"),
    );
    expect(await linkOf(inProfile(setup.profileDir, "config/skills"))).toBe(
      path.join(setup.gemini, "config/skills"),
    );
  });

  it("removes its own link once the source is gone, so the agent can make the folder", async () => {
    const setup = await makeSetup();
    await setup.write("antigravity-cli/skills/a/SKILL.md", "x");
    await shareAntigravityUserConfigNow({ ...setup, platform: "linux" });
    await NodeFS.rm(path.join(setup.gemini, "antigravity-cli"), { recursive: true });

    await shareAntigravityUserConfigNow({ ...setup, platform: "linux" });

    expect(await exists(inProfile(setup.profileDir, "antigravity-cli/skills"))).toBe(false);
  });

  it("replaces a link it made for an old home, and leaves what it didn't make", async () => {
    const setup = await makeSetup();
    const oldHome = path.join(setup.root, "old-home");
    await NodeFS.mkdir(path.join(oldHome, ".gemini"), { recursive: true });
    await NodeFS.writeFile(path.join(oldHome, ".gemini", "AGENTS.md"), "old");
    await shareAntigravityUserConfigNow({ ...setup, userHome: oldHome, platform: "linux" });
    expect(await linkOf(inProfile(setup.profileDir, "AGENTS.md"))).toBe(
      path.join(oldHome, ".gemini", "AGENTS.md"),
    );

    await setup.write("AGENTS.md", "new");
    await setup.write("GEMINI.md", "rule");
    await setup.write("config/rules/always.md", "rule");
    await setup.write("config/skills/a/SKILL.md", "x");
    // Not Threadlines': a link someone else made, a file the agent wrote,
    // and a skills folder with the agent's own skill in it.
    const elsewhere = path.join(setup.root, "elsewhere.md");
    await NodeFS.writeFile(elsewhere, "theirs");
    await NodeFS.symlink(elsewhere, inProfile(setup.profileDir, "GEMINI.md"));
    await NodeFS.mkdir(inProfile(setup.profileDir, "config"), { recursive: true });
    await NodeFS.writeFile(inProfile(setup.profileDir, "config/rules"), "agent's file");
    await NodeFS.mkdir(inProfile(setup.profileDir, "config/skills/own"), { recursive: true });

    await shareAntigravityUserConfigNow({ ...setup, platform: "linux" });

    expect(await linkOf(inProfile(setup.profileDir, "AGENTS.md"))).toBe(
      path.join(setup.gemini, "AGENTS.md"),
    );
    expect(await linkOf(inProfile(setup.profileDir, "GEMINI.md"))).toBe(elsewhere);
    expect(await NodeFS.readFile(inProfile(setup.profileDir, "config/rules"), "utf8")).toBe(
      "agent's file",
    );
    expect(await exists(inProfile(setup.profileDir, "config/skills/own"))).toBe(true);
  });
});

describe("shareAntigravityUserConfigNow on Windows", () => {
  it("copies rule files, refreshes them, and never overwrites one the agent changed", async () => {
    const setup = await makeSetup();
    await setup.write("AGENTS.md", "first");
    await setup.write("config/GEMINI.md", "rule");
    await setup.write("config/skills/a/SKILL.md", "x");

    await shareAntigravityUserConfigNow({ ...setup, platform: "win32" });

    const agents = inProfile(setup.profileDir, "AGENTS.md");
    const gemini = inProfile(setup.profileDir, "config/GEMINI.md");
    expect(await linkOf(agents)).toBeUndefined();
    expect(await NodeFS.readFile(agents, "utf8")).toBe("first");
    // Folders become junctions, which need no privileges (a plain link off Windows).
    expect(await linkOf(inProfile(setup.profileDir, "config/skills"))).toBe(
      path.join(setup.gemini, "config/skills"),
    );

    await setup.write("AGENTS.md", "second");
    await NodeFS.writeFile(gemini, "edited in the profile");
    await shareAntigravityUserConfigNow({ ...setup, platform: "win32" });
    expect(await NodeFS.readFile(agents, "utf8")).toBe("second");
    expect(await NodeFS.readFile(gemini, "utf8")).toBe("edited in the profile");

    await NodeFS.rm(path.join(setup.gemini, "AGENTS.md"));
    await NodeFS.rm(path.join(setup.gemini, "config/GEMINI.md"));
    await shareAntigravityUserConfigNow({ ...setup, platform: "win32" });
    expect(await exists(agents)).toBe(false);
    expect(await NodeFS.readFile(gemini, "utf8")).toBe("edited in the profile");
  });

  it("leaves a rule file that was in the profile before Threadlines copied anything", async () => {
    const setup = await makeSetup();
    await setup.write("AGENTS.md", "user's");
    await NodeFS.writeFile(inProfile(setup.profileDir, "AGENTS.md"), "agent's");

    await shareAntigravityUserConfigNow({ ...setup, platform: "win32" });

    expect(await NodeFS.readFile(inProfile(setup.profileDir, "AGENTS.md"), "utf8")).toBe("agent's");
  });
});

describe("antigravityUserHome", () => {
  it("reads the home the agent will expand ~ to", () => {
    expect(antigravityUserHome("darwin", { HOME: "/Users/a" }, "/fallback")).toBe("/Users/a");
    expect(antigravityUserHome("linux", {}, "/fallback")).toBe("/fallback");
    expect(antigravityUserHome("win32", { USERPROFILE: "C:\\Users\\a", HOME: "/x" }, "C:\\f")).toBe(
      "C:\\Users\\a",
    );
    expect(antigravityUserHome("win32", { HOMEDRIVE: "D:", HOMEPATH: "\\u" }, "C:\\f")).toBe(
      "D:\\u",
    );
  });
});

