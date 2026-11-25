import { describe, expect, it } from "vite-plus/test";

import { agentJoins, agentThreadColor, AGENTS, isInStableRelease } from "./agents";

describe("isInStableRelease", () => {
  it("compares versions numerically, so a 0.7.0 agent waits for 0.7.0 and stays after 0.10.0", () => {
    const agent = { since: "0.7.0" };
    expect(isInStableRelease(agent, "0.6.1")).toBe(false);
    expect(isInStableRelease(agent, "0.7.0")).toBe(true);
    expect(isInStableRelease(agent, "0.10.0")).toBe(true);
    expect(isInStableRelease({}, "0.2.4")).toBe(true);
  });
});

describe("agentThreadColor", () => {
  it("keeps each agent on its homepage color when others are left out", () => {
    const claude = AGENTS.find((agent) => agent.slug === "claude-code")!;
    const opencode = AGENTS.find((agent) => agent.slug === "opencode")!;
    // "Other agents" on Claude Code's page leaves Claude out; OpenCode keeps its own color.
    const others = AGENTS.filter((agent) => agent !== claude);
    expect(agentThreadColor(claude)).toBe("var(--t1)");
    expect(agentThreadColor(others[1]!)).toBe("var(--t2)");
    expect(agentThreadColor(opencode)).toBe("var(--t2)");
    expect(AGENTS.map(agentThreadColor)).toEqual(AGENTS.map((_, index) => `var(--t${index})`));
  });
});

describe("agentJoins", () => {
  const agent = (slug: string, since?: string) =>
    ({ ...AGENTS[0]!, slug, since }) as (typeof AGENTS)[number];

  it("joins each agent at the release named by its version, and the rest at the roots", () => {
    const { joins, roots } = agentJoins(
      [agent("codex"), agent("cursor", "0.5.0"), agent("fx", "0.5.0"), agent("grok", "0.7.0")],
      ["0.7.0", "0.6.0", "0.5.0", "0.2.4"],
    );
    expect([...joins.keys()]).toEqual(["0.5.0", "0.7.0"]);
    expect(joins.get("0.5.0")!.map((a) => a.slug)).toEqual(["cursor", "fx"]);
    expect(roots.map((a) => a.slug)).toEqual(["codex"]);
  });

  it("draws nothing for a version with no published notes, or one past the release cutoff", () => {
    // The notes jump from 0.3.1 to 0.3.3, and a 0.6.1 cutoff leaves 0.7.0 unbuilt.
    const { joins, roots } = agentJoins(
      [agent("muse-code", "0.3.2"), agent("pi", "0.7.0")],
      ["0.6.1", "0.6.0", "0.3.3", "0.3.1"],
    );
    expect(joins.size).toBe(0);
    expect(roots).toEqual([]);
  });

  it("matches the real agents against bare versions, not entry ids", () => {
    const { joins, roots } = agentJoins(AGENTS, ["0.7.0", "0.6.0", "0.5.0"]);
    expect(roots.map((a) => a.slug)).toEqual(["codex", "claude-code"]);
    expect(joins.get("0.7.0")!.map((a) => a.slug)).toEqual(["grok", "muse-code", "pi"]);
    expect(joins.has("v0.7.0")).toBe(false);
  });
});
