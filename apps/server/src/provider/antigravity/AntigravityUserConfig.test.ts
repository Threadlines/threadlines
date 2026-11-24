// @effect-diagnostics nodeBuiltinImport:off - builds a fake home and profile on disk
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { AntigravitySettings } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { checkAcpProviderStatus } from "../acp/AcpProvider.ts";
import { makeAntigravityDescriptor } from "../acp/AntigravityAcpSupport.ts";
import { antigravityInstancePaths } from "./AntigravityProfile.ts";
import { antigravitySignInConfig } from "./AntigravitySignInMethod.ts";
import {
  antigravitySharedConfigRecordPath,
  ANTIGRAVITY_SHARED_DIRS,
  ANTIGRAVITY_SHARED_FILES,
  antigravityUserHome,
  readAntigravityDisabledSkills,
  setAntigravitySkillDisabled,
  shareAntigravityUserConfigNow,
} from "./AntigravityUserConfig.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);
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

describe("shareAntigravityUserConfigNow keeps to the profile and the allowlist", () => {
  it("never writes through a profile folder that links to the user's real config", async () => {
    const setup = await makeSetup();
    // The agent (or anyone) made the profile's config a link to the real one.
    const realConfig = path.join(setup.gemini, "config");
    await NodeFS.mkdir(path.join(realConfig, "skills"), { recursive: true });
    await setup.write("config/GEMINI.md", "the user's own");
    await NodeFS.symlink(realConfig, inProfile(setup.profileDir, "config"));

    const problems = await shareAntigravityUserConfigNow({ ...setup, platform: "linux" });

    // The real, empty skills folder is still a real folder, not a link to itself.
    const skills = await NodeFS.lstat(path.join(realConfig, "skills"));
    expect(skills.isDirectory()).toBe(true);
    expect(await NodeFS.readFile(path.join(realConfig, "GEMINI.md"), "utf8")).toBe(
      "the user's own",
    );
    expect(problems.map((problem) => path.relative(setup.profileDir, problem.path))).toEqual(
      expect.arrayContaining([path.join("config", "skills"), path.join("config", "GEMINI.md")]),
    );
  });

  it("brings in linked sources from elsewhere, but never a keep-out file or Threadlines data", async () => {
    const setup = await makeSetup();
    const dotfiles = path.join(setup.root, "dotfiles");
    const threadlinesDir = path.join(setup.root, "threadlines");
    await NodeFS.mkdir(path.join(threadlinesDir, "secrets"), { recursive: true });
    await NodeFS.mkdir(dotfiles, { recursive: true });
    await NodeFS.writeFile(path.join(dotfiles, "AGENTS.md"), "from dotfiles");
    await NodeFS.writeFile(path.join(dotfiles, "mcp_config.json"), "{}");
    const token = await setup.write("antigravity-cli/antigravity-oauth-token", "TOKEN");
    await NodeFS.mkdir(path.join(setup.gemini, "config"), { recursive: true });
    const link = (target: string, rel: string) =>
      NodeFS.symlink(target, path.join(setup.gemini, ...rel.split("/")));
    await link(path.join(dotfiles, "AGENTS.md"), "AGENTS.md");
    await link(token, "GEMINI.md");
    await link(path.join(dotfiles, "mcp_config.json"), "config/rules.json");
    await link(path.join(threadlinesDir, "secrets"), "config/rules");
    await link(path.join(setup.gemini, "AGENTS.md"), "config/AGENTS.md");
    // Elsewhere in ~/.gemini, under any name: the CLI's own settings.
    await link(await setup.write("antigravity-cli/settings.json", "{}"), "config/skills.json");

    for (const platform of ["linux", "win32"] as const) {
      const profileDir = path.join(setup.root, `profile-${platform}`);
      await shareAntigravityUserConfigNow({ ...setup, profileDir, platform, threadlinesDir });
      const read = (rel: string) =>
        NodeFS.readFile(inProfile(profileDir, rel), "utf8").catch(() => undefined);
      expect(await read("AGENTS.md")).toBe("from dotfiles");
      // A shared entry linked to another shared entry is fine.
      expect(await read("config/AGENTS.md")).toBe("from dotfiles");
      expect(await exists(inProfile(profileDir, "GEMINI.md"))).toBe(false);
      expect(await exists(inProfile(profileDir, "config/rules.json"))).toBe(false);
      expect(await exists(inProfile(profileDir, "config/rules"))).toBe(false);
      expect(await exists(inProfile(profileDir, "config/skills.json"))).toBe(false);
    }
  });

  it.skipIf(process.platform === "win32")(
    "doesn't hang on a FIFO where the record or a source should be",
    async () => {
      const setup = await makeSetup();
      execFileSync("mkfifo", [antigravitySharedConfigRecordPath(setup.profileDir)]);
      await NodeFS.mkdir(setup.gemini, { recursive: true });
      execFileSync("mkfifo", [path.join(setup.gemini, "AGENTS.md")]);
      await setup.write("GEMINI.md", "rule");

      for (const platform of ["linux", "win32"] as const) {
        await shareAntigravityUserConfigNow({ ...setup, platform });
      }

      expect(await NodeFS.readFile(inProfile(setup.profileDir, "GEMINI.md"), "utf8")).toBe("rule");
      expect(await exists(inProfile(setup.profileDir, "AGENTS.md"))).toBe(false);
    },
    5_000,
  );
});

describe("shareAntigravityUserConfigNow only removes what it made", () => {
  it("uses a matching link it didn't make, and leaves it when the source goes", async () => {
    const setup = await makeSetup();
    const source = await setup.write("GEMINI.md", "rule");
    const skills = path.join(setup.gemini, "config", "skills");
    await NodeFS.mkdir(path.join(setup.profileDir, "config"), { recursive: true });
    // Someone else's links, one of them already dangling.
    await NodeFS.symlink(source, inProfile(setup.profileDir, "GEMINI.md"));
    await NodeFS.symlink(skills, inProfile(setup.profileDir, "config/skills"));

    await shareAntigravityUserConfigNow({ ...setup, platform: "linux" });
    expect(await linkOf(inProfile(setup.profileDir, "config/skills"))).toBe(skills);
    await NodeFS.rm(source);
    await shareAntigravityUserConfigNow({ ...setup, platform: "linux" });

    expect(await linkOf(inProfile(setup.profileDir, "GEMINI.md"))).toBe(source);
    expect(await linkOf(inProfile(setup.profileDir, "config/skills"))).toBe(skills);
  });

  it("keeps its record out of the profile, so a record written there authorizes nothing", async () => {
    const setup = await makeSetup();
    await setup.write("AGENTS.md", "the user's rule");
    const agentRule = "the agent's own rule";
    await NodeFS.writeFile(inProfile(setup.profileDir, "AGENTS.md"), agentRule);
    const digest = createHash("sha256").update(agentRule).digest("hex");
    // What the record looked like when it lived in the profile.
    await NodeFS.writeFile(
      path.join(setup.profileDir, "threadlines-shared-config.json"),
      JSON.stringify({ links: {}, copies: { "AGENTS.md": digest } }),
    );

    await shareAntigravityUserConfigNow({ ...setup, platform: "win32" });

    expect(await NodeFS.readFile(inProfile(setup.profileDir, "AGENTS.md"), "utf8")).toBe(agentRule);
  });

  it("still knows a copy as its own after a refresh cut short before the record caught up", async () => {
    const setup = await makeSetup();
    await setup.write("AGENTS.md", "v1");
    await shareAntigravityUserConfigNow({ ...setup, platform: "win32" });
    // A refresh to v2 that stopped after the copy landed: the record then
    // names both versions (it is written before the copy moves).
    await NodeFS.writeFile(inProfile(setup.profileDir, "AGENTS.md"), "v2");
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    await NodeFS.writeFile(
      antigravitySharedConfigRecordPath(setup.profileDir),
      JSON.stringify({ links: {}, copies: { "AGENTS.md": [sha("v1"), sha("v2")] } }),
    );
    await setup.write("AGENTS.md", "v3");

    await shareAntigravityUserConfigNow({ ...setup, platform: "win32" });

    expect(await NodeFS.readFile(inProfile(setup.profileDir, "AGENTS.md"), "utf8")).toBe("v3");
  });

  it("lets starts that overlap take turns", async () => {
    const setup = await makeSetup();
    for (const rel of ANTIGRAVITY_SHARED_FILES) await setup.write(rel, `rule ${rel}`);
    const runs = await Promise.all(
      Array.from({ length: 8 }, () =>
        shareAntigravityUserConfigNow({ ...setup, platform: "win32" }),
      ),
    );
    expect(runs.flat()).toEqual([]);
    for (const rel of ANTIGRAVITY_SHARED_FILES) {
      expect(await NodeFS.readFile(inProfile(setup.profileDir, rel), "utf8")).toBe(`rule ${rel}`);
    }
    // Every copy is still known as Threadlines', so it goes with its source.
    await NodeFS.rm(setup.gemini, { recursive: true });
    await shareAntigravityUserConfigNow({ ...setup, platform: "win32" });
    for (const rel of ANTIGRAVITY_SHARED_FILES) {
      expect(await exists(inProfile(setup.profileDir, rel))).toBe(false);
    }
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

describe("an Antigravity instance and the user's own setup", () => {
  it("brings the user's rules in at launch and lists their skills in the status", async () => {
    const setup = await makeSetup();
    await setup.write("GEMINI.md", "rule");
    const skill = await setup.write(
      "config/skills/review/SKILL.md",
      "---\nname: review\ndescription: Review changes.\n---\n",
    );
    const agy = path.join(setup.root, "agy");
    await NodeFS.writeFile(agy, "#!/bin/sh\n", { mode: 0o755 });
    const settings = {
      ...decodeAntigravitySettings({}),
      enabled: true,
      binaryPath: agy,
    };
    const paths = antigravityInstancePaths(path.join(setup.root, "state"), "antigravity-test");
    const descriptor = makeAntigravityDescriptor({
      paths,
      runtime: undefined,
      releases: undefined,
      signIn: antigravitySignInConfig(settings, undefined),
      skillsCwd: path.join(setup.root, "project"),
    });
    const environment = { HOME: setup.userHome, USERPROFILE: setup.userHome };

    const status = await Effect.runPromise(
      Effect.gen(function* () {
        // Builds the launch without starting anything.
        const launch = descriptor.spawn(settings, setup.root, environment);
        if (Effect.isEffect(launch)) yield* Effect.scoped(launch);
        return yield* checkAcpProviderStatus(descriptor, settings, environment);
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("The status check must not start the agent")),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("The status check must not reach the network")),
        ),
        Effect.provide(NodeServices.layer),
      ),
    );

    const rules = path.join(paths.profileDir, "GEMINI.md");
    if (process.platform === "win32") {
      expect(await NodeFS.readFile(rules, "utf8")).toBe("rule");
    } else {
      expect(await linkOf(rules)).toBe(path.join(setup.gemini, "GEMINI.md"));
    }
    expect(status.skills).toEqual([
      { name: "review", description: "Review changes.", path: skill, scope: "user", enabled: true },
    ]);
  });

  it("splits config/skills into per-skill links when a skill is disabled and collapses safely on re-enable", async () => {
    const setup = await makeSetup();
    await setup.write("config/skills/alpha/SKILL.md", "---\nname: alpha\n---\n");
    await setup.write("config/skills/beta/SKILL.md", "---\nname: beta\n---\n");

    await shareAntigravityUserConfigNow({ ...setup, platform: "linux" });
    expect(await linkOf(inProfile(setup.profileDir, "config/skills"))).toBe(
      path.join(setup.gemini, "config/skills"),
    );

    const disableProblems = await setAntigravitySkillDisabled({
      ...setup,
      platform: "linux",
      sharedDir: "config/skills",
      entryName: "beta",
      disabled: true,
    });
    expect(disableProblems).toEqual([]);
    expect(await linkOf(inProfile(setup.profileDir, "config/skills"))).toBeUndefined();
    expect(await linkOf(inProfile(setup.profileDir, "config/skills/alpha"))).toBe(
      path.join(setup.gemini, "config/skills/alpha"),
    );
    expect(await exists(inProfile(setup.profileDir, "config/skills/beta"))).toBe(false);
    expect(await readAntigravityDisabledSkills(setup.profileDir)).toEqual({
      "config/skills": ["beta"],
      "antigravity-cli/skills": [],
    });

    // Re-enabling restores the whole-directory symlink when no agent-owned folder is inside.
    const enableProblems = await setAntigravitySkillDisabled({
      ...setup,
      platform: "linux",
      sharedDir: "config/skills",
      entryName: "beta",
      disabled: false,
    });
    expect(enableProblems).toEqual([]);
    expect(await linkOf(inProfile(setup.profileDir, "config/skills"))).toBe(
      path.join(setup.gemini, "config/skills"),
    );

    // If the agent created its own skill while split, re-enabling must keep enabled links intact.
    await setAntigravitySkillDisabled({
      ...setup,
      platform: "linux",
      sharedDir: "config/skills",
      entryName: "beta",
      disabled: true,
    });
    await NodeFS.mkdir(inProfile(setup.profileDir, "config/skills/agent-own"), { recursive: true });
    await NodeFS.writeFile(
      inProfile(setup.profileDir, "config/skills/agent-own/SKILL.md"),
      "agent",
    );
    await setAntigravitySkillDisabled({
      ...setup,
      platform: "linux",
      sharedDir: "config/skills",
      entryName: "beta",
      disabled: false,
    });
    expect(await exists(inProfile(setup.profileDir, "config/skills/agent-own/SKILL.md"))).toBe(
      true,
    );
    expect(await linkOf(inProfile(setup.profileDir, "config/skills/alpha"))).toBe(
      path.join(setup.gemini, "config/skills/alpha"),
    );
    expect(await linkOf(inProfile(setup.profileDir, "config/skills/beta"))).toBe(
      path.join(setup.gemini, "config/skills/beta"),
    );
  });
});
