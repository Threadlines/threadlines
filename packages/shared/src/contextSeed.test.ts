import { ProviderDriverKind, type ThreadContextSeedEntry } from "@threadlines/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SEED_BUDGET,
  estimateSeedChars,
  renderSeedEntries,
  renderThreadContextSeed,
  splitSeedEntriesByBudget,
  withContextSeedPreamble,
} from "./contextSeed.ts";

const CODEX = ProviderDriverKind.make("codex");

function message(role: "user" | "assistant" | "system", text: string): ThreadContextSeedEntry {
  return { kind: "message", role, text };
}

function tool(text: string): ThreadContextSeedEntry {
  return { kind: "tool", text };
}

describe("splitSeedEntriesByBudget", () => {
  it("keeps everything in recent when under budget", () => {
    const entries = [message("user", "hi"), message("assistant", "hello")];
    const split = splitSeedEntriesByBudget(entries);
    expect(split.older).toHaveLength(0);
    expect(split.recent).toHaveLength(2);
  });

  it("moves older entries to the older prefix when the char budget is exceeded", () => {
    const big = "x".repeat(500);
    const entries = Array.from({ length: 40 }, (_, i) => message("user", `${big}-${i}`));
    const split = splitSeedEntriesByBudget(entries, { maxChars: 4_000, recencyWindow: 3 });
    expect(split.older.length).toBeGreaterThan(0);
    expect(split.recent.length).toBeGreaterThan(0);
    // older + recent reconstruct the original list, oldest-first.
    expect([...split.older, ...split.recent]).toEqual(entries);
    // the most recent entry is always retained verbatim.
    expect(split.recent.at(-1)).toEqual(entries.at(-1));
  });

  it("honors the recency floor even when those entries exceed the char budget", () => {
    const big = "y".repeat(5_000);
    const entries = Array.from({ length: 6 }, (_, i) => message("assistant", `${big}-${i}`));
    const split = splitSeedEntriesByBudget(entries, { maxChars: 1_000, recencyWindow: 4 });
    expect(split.recent).toHaveLength(4);
    expect(split.older).toHaveLength(2);
  });
});

describe("estimateSeedChars", () => {
  it("grows with entry text length", () => {
    const small = estimateSeedChars([message("user", "hi")]);
    const large = estimateSeedChars([message("user", "hi".repeat(100))]);
    expect(large).toBeGreaterThan(small);
  });
});

describe("renderSeedEntries", () => {
  it("labels messages by role and marks tool entries, skipping empties", () => {
    const rendered = renderSeedEntries([
      message("user", "Add a login form"),
      tool("Edited src/Login.tsx"),
      message("assistant", ""),
      message("assistant", "Done."),
    ]);
    expect(rendered).toContain("**User:** Add a login form");
    expect(rendered).toContain("- (tool) Edited src/Login.tsx");
    expect(rendered).toContain("**Assistant:** Done.");
    // the empty assistant message produced no line
    expect(rendered.split("\n")).toHaveLength(3);
  });
});

describe("renderThreadContextSeed", () => {
  it("renders handoff framing, summary, recent history, and workspace pointer", () => {
    const rendered = renderThreadContextSeed({
      version: 1,
      fromProvider: CODEX,
      olderSummary: "Scaffolded the auth module.",
      entries: [message("user", "now add logout"), tool("Edited src/Logout.tsx")],
      workspacePointer: "The repo at /tmp/ws reflects in-progress work.",
    });
    expect(rendered).toContain('<conversation-handoff from="codex">');
    expect(rendered).toContain("started with codex");
    expect(rendered).toContain("## Earlier in this thread (summarized)");
    expect(rendered).toContain("Scaffolded the auth module.");
    expect(rendered).toContain("## Recent conversation");
    expect(rendered).toContain("**User:** now add logout");
    expect(rendered).toContain("The repo at /tmp/ws reflects in-progress work.");
    expect(rendered.trimEnd().endsWith("</conversation-handoff>")).toBe(true);
  });

  it("omits summary and recent sections for a minimal seed", () => {
    const rendered = renderThreadContextSeed({
      version: 1,
      fromProvider: CODEX,
      entries: [],
    });
    expect(rendered).toContain('<conversation-handoff from="codex">');
    expect(rendered).not.toContain("## Earlier");
    expect(rendered).not.toContain("## Recent conversation");
  });
});

describe("withContextSeedPreamble", () => {
  it("prepends the seed before non-empty user text with a separator", () => {
    const combined = withContextSeedPreamble("SEED", "do the thing");
    expect(combined).toBe("SEED\n\n---\n\ndo the thing");
  });

  it("returns the seed alone when user text is empty or missing", () => {
    expect(withContextSeedPreamble("SEED", "   ")).toBe("SEED");
    expect(withContextSeedPreamble("SEED", undefined)).toBe("SEED");
  });
});

describe("DEFAULT_SEED_BUDGET", () => {
  it("exposes a recency floor and char budget", () => {
    expect(DEFAULT_SEED_BUDGET.recencyWindow).toBeGreaterThan(0);
    expect(DEFAULT_SEED_BUDGET.maxChars).toBeGreaterThan(0);
  });
});
