import { describe, expect, it } from "vite-plus/test";
import {
  buildSubagentTranscriptView,
  shouldShowSubagentLiveTail,
  splitSubagentTranscriptLead,
  type SubagentTranscriptEntryLike,
} from "./SubagentTranscript.logic";

const entry = (
  overrides: Partial<SubagentTranscriptEntryLike> & Pick<SubagentTranscriptEntryLike, "role">,
): SubagentTranscriptEntryLike => ({
  text: "",
  toolUses: [],
  ...overrides,
});

describe("buildSubagentTranscriptView", () => {
  it("pairs a tool call with the result record that follows it", () => {
    const view = buildSubagentTranscriptView([
      entry({ role: "assistant", text: "Looking for the handler.", toolUses: [] }),
      entry({
        role: "assistant",
        toolUses: [{ name: "Bash", summary: "rg -n centerOf" }],
        at: "2026-07-27T03:37:37.216Z",
      }),
      entry({ role: "user", outputPreview: "src/preview.ts:42" }),
    ]);

    expect(view).toEqual([
      {
        kind: "message",
        id: "0:message",
        role: "assistant",
        text: "Looking for the handler.",
        at: null,
      },
      {
        kind: "tools",
        id: "1:tools",
        tools: [{ id: "1:Bash\u0000rg -n centerOf:0", name: "Bash", summary: "rg -n centerOf" }],
        output: "src/preview.ts:42",
        at: "2026-07-27T03:37:37.216Z",
      },
    ]);
  });

  it("keeps batched results together and does not attach them to a later call", () => {
    const view = buildSubagentTranscriptView([
      entry({
        role: "assistant",
        toolUses: [
          { name: "Read", summary: "a.ts" },
          { name: "Read", summary: "b.ts" },
        ],
      }),
      entry({ role: "user", outputPreview: "contents of a\ncontents of b" }),
      entry({ role: "assistant", toolUses: [{ name: "Bash", summary: "ls" }] }),
    ]);

    expect(view.map((item) => item.kind)).toEqual(["tools", "tools"]);
    expect(view[0]).toMatchObject({ output: "contents of a\ncontents of b" });
    expect(view[1]).toMatchObject({ output: null, tools: [{ name: "Bash", summary: "ls" }] });
    // Identical calls in one batch keep distinct keys.
    expect(view[0]).toMatchObject({
      tools: [{ id: "0:Read\u0000a.ts:0" }, { id: "0:Read\u0000b.ts:0" }],
    });
  });

  it("renders an unpaired result on its own instead of dropping it", () => {
    const view = buildSubagentTranscriptView(
      [entry({ role: "user", outputPreview: "orphaned output" })],
      12,
    );

    expect(view).toEqual([
      { kind: "tools", id: "12:output", tools: [], output: "orphaned output", at: null },
    ]);
  });

  it("closes an open tool group when the agent speaks again", () => {
    const view = buildSubagentTranscriptView([
      entry({ role: "assistant", toolUses: [{ name: "Bash", summary: "ls" }] }),
      entry({ role: "assistant", text: "Found it." }),
      entry({ role: "user", outputPreview: "late result" }),
    ]);

    expect(view.map((item) => item.kind)).toEqual(["tools", "message", "tools"]);
    expect(view[0]).toMatchObject({ output: null });
    expect(view[2]).toMatchObject({ tools: [], output: "late result" });
  });

  it("offsets ids by the page position so paging keeps keys stable", () => {
    const view = buildSubagentTranscriptView(
      [entry({ role: "thinking", text: "Considering options." })],
      80,
    );

    expect(view).toEqual([
      { kind: "thinking", id: "80:thinking", text: "Considering options.", at: null },
    ]);
  });

  it("prefers provider item ids across cursor-paginated pages", () => {
    const view = buildSubagentTranscriptView([
      entry({ id: "provider-item-7", role: "assistant", text: "Stable item." }),
    ]);

    expect(view).toEqual([
      {
        kind: "message",
        id: "provider-item-7:message",
        role: "assistant",
        text: "Stable item.",
        at: null,
      },
    ]);
  });
});

describe("shouldShowSubagentLiveTail", () => {
  const message = (text: string) =>
    buildSubagentTranscriptView([entry({ role: "assistant", text })]);

  it("shows streamed text the written transcript has not caught up to", () => {
    expect(shouldShowSubagentLiveTail(message("Earlier step."), "Now checking migrations")).toBe(
      true,
    );
  });

  it("drops the tail once the transcript records the same message", () => {
    expect(shouldShowSubagentLiveTail(message("Now checking migrations"), "Now checking")).toBe(
      false,
    );
    expect(shouldShowSubagentLiveTail(message("Now checking"), "Now checking migrations")).toBe(
      false,
    );
  });

  it("has nothing to show without streamed text", () => {
    expect(shouldShowSubagentLiveTail(message("Earlier step."), null)).toBe(false);
    expect(shouldShowSubagentLiveTail([], "  ")).toBe(false);
  });
});

describe("splitSubagentTranscriptLead", () => {
  const instruction = entry({ role: "user", text: "Survey the repo." });
  const step = entry({ role: "assistant", text: "Working on it." });

  it("lifts the spawn prompt out of the thread", () => {
    const view = buildSubagentTranscriptView([instruction, step]);
    const { lead, steps } = splitSubagentTranscriptLead(view, true);

    expect(lead).toMatchObject({ role: "user", text: "Survey the repo." });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ text: "Working on it." });
  });

  it("keeps a mid-run message on the thread", () => {
    const view = buildSubagentTranscriptView([step, instruction]);

    expect(splitSubagentTranscriptLead(view, true).lead).toBeNull();
    expect(splitSubagentTranscriptLead(view, true).steps).toHaveLength(2);
  });

  it("leaves a page that starts mid-transcript alone", () => {
    const view = buildSubagentTranscriptView([instruction, step], 40);

    expect(splitSubagentTranscriptLead(view, false).lead).toBeNull();
    expect(splitSubagentTranscriptLead(view, false).steps).toHaveLength(2);
  });
});
