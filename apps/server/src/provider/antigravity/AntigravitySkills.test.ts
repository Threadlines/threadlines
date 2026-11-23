// @effect-diagnostics nodeBuiltinImport:off - builds fake homes and projects on disk
import * as NodeFS from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { listAntigravitySkillsNow } from "./AntigravitySkills.ts";

const roots: Array<string> = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFS.rm(root, { recursive: true })));
});

async function makeWorkspace() {
  const root = await NodeFS.realpath(await NodeFS.mkdtemp(path.join(os.tmpdir(), "agy-skills-")));
  roots.push(root);
  const userHome = path.join(root, "home");
  const cwd = path.join(root, "repo", "app");
  await NodeFS.mkdir(path.join(root, "repo", ".git"), { recursive: true });
  await NodeFS.mkdir(cwd, { recursive: true });
  return {
    root,
    userHome,
    cwd,
    repo: path.join(root, "repo"),
    gemini: path.join(userHome, ".gemini"),
    profileDir: path.join(root, "profile"),
  };
}

async function writeFile(file: string, content: string) {
  await NodeFS.mkdir(path.dirname(file), { recursive: true });
  await NodeFS.writeFile(file, content);
  return file;
}

const writeSkill = (dir: string, name: string | undefined, description?: string) =>
  writeFile(
    path.join(dir, "SKILL.md"),
    `---\n${name === undefined ? "" : `name: ${name}\n`}${description ? `description: ${description}\n` : ""}---\n# Body\n`,
  );

const writeJson = (file: string, value: unknown) => writeFile(file, JSON.stringify(value));

const names = (skills: ReadonlyArray<{ readonly name: string }>) => skills.map((s) => s.name);

describe("listAntigravitySkillsNow", () => {
  it("lists nothing when there is no ~/.gemini and no project skills", async () => {
    const workspace = await makeWorkspace();
    expect(await listAntigravitySkillsNow(workspace)).toEqual({ skills: [], truncated: false });
  });

  it("reads name, description, path and scope from each place the agent looks", async () => {
    const w = await makeWorkspace();
    const review = await writeSkill(
      path.join(w.gemini, "config", "skills", "review"),
      "review",
      "Review changes.",
    );
    await writeSkill(path.join(w.cwd, ".gemini", "skills", "a"), "gemini-project");
    await writeSkill(path.join(w.gemini, "antigravity-cli", "skills", "b"), "cli-global");
    await writeSkill(path.join(w.cwd, ".agents", "skills", "c"), "agents-project");
    await writeSkill(path.join(w.cwd, ".agent", "skills", "d"), "legacy-project");
    // The agent never reads ~/.agents/skills on its own.
    await writeSkill(path.join(w.userHome, ".agents", "skills", "e"), "home-agents");

    const { skills } = await listAntigravitySkillsNow(w);

    expect(names(skills)).toEqual([
      "agents-project",
      "cli-global",
      "gemini-project",
      "legacy-project",
      "review",
    ]);
    expect(skills.find((skill) => skill.name === "review")).toEqual({
      name: "review",
      description: "Review changes.",
      path: review,
      scope: "user",
      enabled: true,
    });
    expect(skills.find((skill) => skill.name === "agents-project")?.scope).toBe("project");
  });

  it("keeps the first copy of a name in the agent's own order", async () => {
    const w = await makeWorkspace();
    const order = [
      path.join(w.gemini, "config", "skills"),
      path.join(w.cwd, ".gemini", "skills"),
      path.join(w.gemini, "antigravity-cli", "skills"),
      path.join(w.cwd, ".agents", "skills"),
      path.join(w.cwd, ".agent", "skills"),
    ];
    for (const [index, root] of order.entries()) {
      await writeSkill(path.join(root, `copy-${index}`), "review", `Copy ${index}.`);
    }
    for (const root of order) {
      const { skills } = await listAntigravitySkillsNow(w);
      expect(skills).toHaveLength(1);
      expect(path.dirname(path.dirname(skills[0]!.path))).toBe(root);
      await NodeFS.rm(root, { recursive: true });
    }
  });

  it("treats a root with its own SKILL.md as one skill, names a nameless skill after its folder", async () => {
    const w = await makeWorkspace();
    const root = path.join(w.cwd, ".agents", "skills");
    await writeSkill(root, "root-skill");
    await writeSkill(path.join(root, "child"), "child-skill");
    await writeSkill(path.join(w.gemini, "config", "skills", "nameless"), undefined, "No name.");
    await writeFile(
      path.join(w.gemini, "config", "skills", "broken", "SKILL.md"),
      "---\nname: [x\n---\n",
    );
    await writeFile(
      path.join(w.gemini, "config", "skills", "plain", "SKILL.md"),
      "no front matter",
    );
    await writeSkill(path.join(w.gemini, "config", "skills", "deep", "nested"), "too-deep");

    expect(names((await listAntigravitySkillsNow(w)).skills)).toEqual(["nameless", "root-skill"]);
  });

  it("follows skills.json: inherits, literal include_only and exclude, null lists, no ~ expansion", async () => {
    const w = await makeWorkspace();
    const shared = path.join(w.userHome, ".agents", "skills");
    await writeSkill(path.join(shared, "yagni"), "yagni", "Keep it simple.");
    await writeSkill(path.join(shared, "experimental-draft"), "experimental-draft");
    await writeSkill(path.join(shared, "dropped"), "dropped");
    await writeSkill(path.join(shared, "category", "nested"), "nested");
    const inherited = path.join(w.userHome, "inherited-skills");
    await writeSkill(path.join(inherited, "linter"), "linter");
    await writeSkill(path.join(inherited, "lint-draft"), "lint-draft");
    await writeSkill(path.join(inherited, "skipped"), "skipped");
    await writeSkill(path.join(w.userHome, "tilde-skills", "tilde"), "tilde");

    const globalManifest = path.join(w.gemini, "config", "skills.json");
    const inheritedManifest = path.join(w.userHome, "shared-skills.json");
    await writeJson(inheritedManifest, {
      // A loop back to the first manifest is read once.
      inherits: [{ path: globalManifest }],
      entries: [{ path: inherited }],
    });
    await writeJson(globalManifest, {
      inherits: [{ path: inheritedManifest, include_only: ["linter", "lint-.*"] }],
      entries: [
        { path: shared, exclude: ["experimental-.*", "dropped"], include_only: null },
        { path: shared, include_only: ["category/nested"] },
        { path: "~/tilde-skills" },
      ],
    });

    expect(names((await listAntigravitySkillsNow(w)).skills)).toEqual([
      "experimental-draft",
      "linter",
      "nested",
      "yagni",
    ]);
  });

  it("reads project manifests up to the repository root, and only inside it", async () => {
    const w = await makeWorkspace();
    await writeSkill(path.join(w.repo, "tools", "skills", "deploy"), "deploy");
    await writeSkill(path.join(w.repo, "tools", "skills", "internal"), "internal");
    await writeSkill(path.join(w.cwd, "local", "here"), "here");
    const outside = path.join(w.root, "outside");
    await writeSkill(path.join(outside, "escape"), "escape");
    await NodeFS.symlink(outside, path.join(w.repo, "linked-out"));

    await writeJson(path.join(w.cwd, ".agents", "skills.json"), {
      entries: null,
      inherits: [{ path: "../workspace-skills.json", include_only: null }],
    });
    await writeJson(path.join(w.repo, "workspace-skills.json"), {
      inherits: null,
      entries: [
        { path: "tools/skills/deploy/SKILL.md", exclude: null },
        { path: "tools/skills/internal/SKILL.md", exclude: ["internal"] },
      ],
    });
    // A parent's manifest counts; paths resolve against its own folder.
    await writeJson(path.join(w.repo, ".agents", "skills.json"), {
      entries: [
        { path: "app/local" },
        { path: outside },
        { path: "linked-out" },
        { path: "../outside" },
      ],
    });
    // Above the repository root: not read.
    await writeJson(path.join(w.root, ".agents", "skills.json"), { entries: [{ path: outside }] });

    expect(names((await listAntigravitySkillsNow(w)).skills)).toEqual(["deploy", "here"]);
  });

  it("lists skills of plugins installed in the profile unless turned off", async () => {
    const w = await makeWorkspace();
    const plugins = path.join(w.profileDir, "config", "plugins");
    await writeSkill(path.join(plugins, "demo", "skills", "demo-skill"), "demo-skill");
    await writeSkill(path.join(plugins, "off", "skills", "off-skill"), "off-skill");
    await writeJson(path.join(w.profileDir, "config", "config.json"), {
      plugins: { off: { enabled: false } },
    });

    expect(names((await listAntigravitySkillsNow(w)).skills)).toEqual(["demo-skill"]);
  });

  it("reads only front matter, skips one oversized file, and stops at the entry budget", async () => {
    const w = await makeWorkspace();
    const skills = path.join(w.gemini, "config", "skills");
    // A long body costs nothing past the front matter.
    for (let index = 0; index < 20; index += 1) {
      await writeFile(
        path.join(skills, `big-${index}`, "SKILL.md"),
        `---\nname: big-${index}\n---\n${"x".repeat(900_000)}`,
      );
    }
    // Front matter that never closes within a skill's limit: that skill is skipped.
    await writeFile(path.join(skills, "endless", "SKILL.md"), `---\n${"y".repeat(1_100_000)}`);
    let listing = await listAntigravitySkillsNow(w);
    expect(listing.skills).toHaveLength(20);
    expect(listing.truncated).toBe(false);

    const crowded = path.join(w.cwd, ".agents", "skills");
    await NodeFS.mkdir(crowded, { recursive: true });
    await Promise.all(
      Array.from({ length: 10_001 }, (_, index) =>
        NodeFS.writeFile(path.join(crowded, `f${index}`), ""),
      ),
    );
    listing = await listAntigravitySkillsNow(w);
    expect(listing.truncated).toBe(true);
    expect(listing.skills).toHaveLength(20);
  });
});
