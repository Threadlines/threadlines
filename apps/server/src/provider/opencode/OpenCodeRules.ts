/**
 * OpenCodeRules — the permission rules Threadlines puts on OpenCode sessions.
 *
 * OpenCode merges an agent's rules with the session's, and the last matching
 * rule wins. So the session ruleset is built in layers:
 *
 *   1. what the runtime mode asks about (Supervised asks for shell and edits);
 *   2. the Threadlines tool servers: every one denied, then this thread's own
 *      allowed. A deny whose resource is `*` also hides the tool, so each
 *      session sees only its own browser and room tools even though OpenCode
 *      registers tool servers per directory, not per session;
 *   3. the agent's restrictions again, last, so neither layer above softens a
 *      deny the user configured (`rm *: deny` stays a deny, and so does a
 *      deny of Threadlines' own tools). A deny's later exceptions come along
 *      (the plan agent denies edits but allows its plan files), never looser
 *      than the mode: an exception the mode would ask about still asks.
 *
 * Full access adds no rules: the adapter approves whatever OpenCode would
 * ask, which keeps the user's own denies intact. Nothing here ever saves an
 * "always" grant; OpenCode stores those for the whole project.
 *
 * @module provider/opencode/OpenCodeRules
 */
import { createHash } from "node:crypto";

import type { RuntimeMode } from "@threadlines/contracts";

export interface OpenCodeRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

const BROWSER_SERVER_PREFIX = "threadlines_b_";
const ROOM_SERVER_PREFIX = "threadlines_r_";
const PAGES_SERVER_PREFIX = "threadlines_p_";

/** Short, stable, tool-name-safe key for one thread's tool servers. */
export function openCodeThreadToolKey(threadKey: string): string {
  return createHash("sha256").update(threadKey).digest("hex").slice(0, 10);
}

export function openCodeBrowserServerName(toolKey: string): string {
  return `${BROWSER_SERVER_PREFIX}${toolKey}`;
}

export function openCodeRoomServerName(toolKey: string): string {
  return `${ROOM_SERVER_PREFIX}${toolKey}`;
}

export function openCodePagesServerName(toolKey: string): string {
  return `${PAGES_SERVER_PREFIX}${toolKey}`;
}

/** OpenCode's own wildcard: `*` is any run of characters, `?` any one. */
function wildcardMatch(input: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "s").test(input);
}

function actionsOverlap(left: string, right: string): boolean {
  return wildcardMatch(left, right) || wildcardMatch(right, left);
}

function modeRules(runtimeMode: RuntimeMode): ReadonlyArray<OpenCodeRule> {
  switch (runtimeMode) {
    case "approval-required":
      return [
        { action: "shell", resource: "*", effect: "ask" },
        { action: "edit", resource: "*", effect: "ask" },
        { action: "external_directory", resource: "*", effect: "ask" },
      ];
    case "auto-accept-edits":
    case "auto":
      return [
        { action: "shell", resource: "*", effect: "ask" },
        { action: "edit", resource: "*", effect: "allow" },
        { action: "external_directory", resource: "*", effect: "ask" },
      ];
    case "full-access":
      return [];
  }
}

/** The agent's denies, each followed by its own later exceptions. */
function agentRestrictions(
  agentRules: ReadonlyArray<OpenCodeRule>,
  mode: ReadonlyArray<OpenCodeRule>,
): ReadonlyArray<OpenCodeRule> {
  const deniedActions: Array<string> = [];
  const kept: Array<OpenCodeRule> = [];
  for (const rule of agentRules) {
    if (rule.effect === "deny") {
      deniedActions.push(rule.action);
      kept.push(rule);
      continue;
    }
    if (!deniedActions.some((action) => actionsOverlap(action, rule.action))) continue;
    const modeAsks = mode.some(
      (modeRule) => modeRule.effect === "ask" && actionsOverlap(modeRule.action, rule.action),
    );
    kept.push(rule.effect === "allow" && modeAsks ? { ...rule, effect: "ask" } : rule);
  }
  return kept;
}

export function openCodeSessionRules(input: {
  readonly runtimeMode: RuntimeMode;
  /** The session agent's rules, from `/api/agent`. */
  readonly agentRules: ReadonlyArray<OpenCodeRule>;
  readonly toolKey: string;
  readonly roomTools: boolean;
  /** The page tools: a page shows only in the caller's own thread, so they never ask. */
  readonly agentPages?: boolean;
}): ReadonlyArray<OpenCodeRule> {
  const mode = modeRules(input.runtimeMode);
  return [
    ...mode,
    { action: `${BROWSER_SERVER_PREFIX}*`, resource: "*", effect: "deny" },
    { action: `${ROOM_SERVER_PREFIX}*`, resource: "*", effect: "deny" },
    { action: `${PAGES_SERVER_PREFIX}*`, resource: "*", effect: "deny" },
    {
      action: `${openCodeBrowserServerName(input.toolKey)}_*`,
      resource: "*",
      effect: "allow",
    },
    ...(input.roomTools
      ? [
          {
            action: `${openCodeRoomServerName(input.toolKey)}_*`,
            resource: "*",
            effect: "allow",
          } satisfies OpenCodeRule,
        ]
      : []),
    ...(input.agentPages === true
      ? [
          {
            action: `${openCodePagesServerName(input.toolKey)}_*`,
            resource: "*",
            effect: "allow",
          } satisfies OpenCodeRule,
        ]
      : []),
    ...agentRestrictions(input.agentRules, mode),
  ];
}

/**
 * "Allow for this session" without OpenCode's project-wide save: the request's
 * own `save` patterns become allow rules on this session.
 */
export function openCodeSessionGrantRules(input: {
  readonly action: string;
  readonly save?: ReadonlyArray<string> | undefined;
  readonly resources: ReadonlyArray<string>;
}): ReadonlyArray<OpenCodeRule> {
  const patterns = input.save && input.save.length > 0 ? input.save : input.resources;
  return patterns.map((resource) => ({ action: input.action, resource, effect: "allow" }));
}

export function isOpenCodeRule(value: unknown): value is OpenCodeRule {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.action === "string" &&
    typeof record.resource === "string" &&
    (record.effect === "allow" || record.effect === "deny" || record.effect === "ask")
  );
}
