import { describe, expect, it } from "vite-plus/test";

import {
  type OpenCodeRule,
  openCodeBrowserServerName,
  openCodePagesServerName,
  openCodeSessionGrantRules,
  openCodeSessionRules,
  openCodeThreadToolKey,
} from "./OpenCodeRules.ts";

/** OpenCode's evaluation: agent rules then session rules, last match wins, default ask. */
function effect(rules: ReadonlyArray<OpenCodeRule>, action: string, resource: string) {
  const match = (input: string, pattern: string) =>
    new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
      "s",
    ).test(input);
  return (
    rules.findLast((rule) => match(action, rule.action) && match(resource, rule.resource))
      ?.effect ?? "ask"
  );
}

const BUILD_AGENT: ReadonlyArray<OpenCodeRule> = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "shell", resource: "rm *", effect: "deny" },
];
const PLAN_AGENT: ReadonlyArray<OpenCodeRule> = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "deny" },
  { action: "edit", resource: ".opencode/plans/*", effect: "allow" },
];

describe("openCodeSessionRules", () => {
  const ownKey = openCodeThreadToolKey("thread-a");
  const otherKey = openCodeThreadToolKey("thread-b");

  it("asks in Supervised mode without softening the user's own denies", () => {
    const rules = [
      ...BUILD_AGENT,
      ...openCodeSessionRules({
        runtimeMode: "approval-required",
        agentRules: BUILD_AGENT,
        toolKey: ownKey,
        roomTools: false,
      }),
    ];
    expect(effect(rules, "shell", "ls")).toBe("ask");
    expect(effect(rules, "edit", "src/a.ts")).toBe("ask");
    expect(effect(rules, "shell", "rm -rf build")).toBe("deny");
    expect(effect(rules, "read", "src/a.ts")).toBe("allow");
  });

  it("keeps a deny's exceptions, never looser than the mode", () => {
    const supervised = [
      ...PLAN_AGENT,
      ...openCodeSessionRules({
        runtimeMode: "approval-required",
        agentRules: PLAN_AGENT,
        toolKey: ownKey,
        roomTools: false,
      }),
    ];
    expect(effect(supervised, "edit", "src/a.ts")).toBe("deny");
    expect(effect(supervised, "edit", ".opencode/plans/plan.md")).toBe("ask");

    const fullAccess = [
      ...PLAN_AGENT,
      ...openCodeSessionRules({
        runtimeMode: "full-access",
        agentRules: PLAN_AGENT,
        toolKey: ownKey,
        roomTools: false,
      }),
    ];
    expect(effect(fullAccess, "edit", ".opencode/plans/plan.md")).toBe("allow");
    expect(effect(fullAccess, "edit", "src/a.ts")).toBe("deny");
  });

  it("lets a session reach only its own thread's tools", () => {
    const rules = [
      ...BUILD_AGENT,
      ...openCodeSessionRules({
        runtimeMode: "full-access",
        agentRules: BUILD_AGENT,
        toolKey: ownKey,
        roomTools: false,
      }),
    ];
    const own = `${openCodeBrowserServerName(ownKey)}_browser_snapshot`;
    const other = `${openCodeBrowserServerName(otherKey)}_browser_snapshot`;
    expect(effect(rules, own, "*")).toBe("allow");
    // A last-matching deny on resource `*` is also what hides the tool.
    expect(effect(rules, other, "*")).toBe("deny");
    expect(effect(rules, `threadlines_r_${ownKey}_room_agents`, "*")).toBe("deny");
  });

  it("lets a session with pages show them without asking, on its own thread only", () => {
    const rules = [
      ...BUILD_AGENT,
      ...openCodeSessionRules({
        runtimeMode: "approval-required",
        agentRules: BUILD_AGENT,
        toolKey: ownKey,
        roomTools: false,
        agentPages: true,
      }),
    ];
    expect(effect(rules, `${openCodePagesServerName(ownKey)}_show_page`, "*")).toBe("allow");
    expect(effect(rules, `${openCodePagesServerName(otherKey)}_show_page`, "*")).toBe("deny");
  });

  it("honours a user's deny of Threadlines' own tools", () => {
    const agent: ReadonlyArray<OpenCodeRule> = [
      ...BUILD_AGENT,
      { action: "threadlines_b_*", resource: "*", effect: "deny" },
    ];
    const rules = [
      ...agent,
      ...openCodeSessionRules({
        runtimeMode: "full-access",
        agentRules: agent,
        toolKey: ownKey,
        roomTools: false,
      }),
    ];
    expect(effect(rules, `${openCodeBrowserServerName(ownKey)}_browser_snapshot`, "*")).toBe(
      "deny",
    );
  });

  it("grants a session-only allow from the request's save patterns", () => {
    const grant = openCodeSessionGrantRules({
      action: "shell",
      resources: ["npm test"],
      save: ["npm *"],
    });
    expect(effect(grant, "shell", "npm run build")).toBe("allow");
    expect(effect(grant, "shell", "yarn test")).toBe("ask");
  });
});
