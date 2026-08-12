import "../../index.css";

import { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { setActiveFileViewerContext, useFileViewerStore } from "../../fileViewerStore";
import { SubagentTranscript } from "./SubagentTranscript";

const transcriptRpcMock = vi.hoisted(() => vi.fn());

vi.mock("./subagentTranscriptClient", () => ({
  readSubagentTranscriptPage: transcriptRpcMock,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-transcript");

/** Long enough to wrap at the panel's real width, which is the whole point of
 *  the case: the first line has to stop short of the timestamp on its own. */
const LONG_PROSE =
  "The router registers every panel destination before the sidebar mounts, which is why the agents tab renders empty on a cold load.";

const ENTRIES = [
  { id: "e1", role: "user", text: "Count the direct TypeScript files.", toolUses: [] },
  {
    id: "e2",
    role: "assistant",
    text: "Walked the route files.",
    toolUses: [],
    at: "2026-08-11T10:00:00.000Z",
  },
  {
    id: "e3",
    role: "assistant",
    text: "",
    toolUses: [{ name: "Read", summary: "Read: src/router.tsx" }],
    at: "2026-08-11T10:00:05.000Z",
  },
  { id: "e4", role: "user", text: "", toolUses: [], outputPreview: "export const routes = []" },
  {
    id: "e5",
    role: "assistant",
    text: LONG_PROSE,
    toolUses: [],
    at: "2026-08-11T10:00:20.000Z",
  },
];

/** The drill-in's real width: the panel is 330px and the transcript keeps the
 *  panel's 12px gutter inside it. */
function renderTranscript() {
  return render(
    <div style={{ boxSizing: "border-box", display: "flex", height: 520, width: 330 }}>
      <SubagentTranscript
        environmentId={ENVIRONMENT_ID}
        threadId={THREAD_ID}
        agentIds={["agent-1"]}
        scrollable
      />
    </div>,
  );
}

/** The rect of an element's first rendered line, which is what the spine's node
 *  has to line up with -- not the element's box, whose top is the top of a
 *  possibly multi-line paragraph. */
function firstLineRect(element: Element): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(element);
  const [first] = [...range.getClientRects()];
  if (first === undefined) {
    throw new Error("element rendered no line boxes");
  }
  return first;
}

function lineRectCount(element: Element): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  return range.getClientRects().length;
}

function centerY(rect: DOMRect): number {
  return (rect.top + rect.bottom) / 2;
}

describe("SubagentTranscript drill-in", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    transcriptRpcMock.mockReset();
    transcriptRpcMock.mockResolvedValue({
      entries: ENTRIES,
      truncated: false,
      offset: 0,
      totalEntries: ENTRIES.length,
    });
  });

  it("puts every spine dot on the first line of the step's text", async () => {
    renderTranscript();
    await expect.element(page.getByText("Walked the route files.")).toBeVisible();

    const nodes = [
      ...document.querySelectorAll("[data-subagent-transcript-node='true']"),
    ] as HTMLElement[];
    // Prose, the folded receipt for the run between the two, then prose again.
    expect(nodes).toHaveLength(3);

    // The spawn prompt sits above the thread and has no node, so only the
    // agent's own entries are matched here.
    const proseEntries = [
      ...document.querySelectorAll("[data-subagent-transcript-entry='assistant'] .chat-markdown p"),
    ];
    const [firstProse, secondProse] = proseEntries as [Element, Element];
    const receiptLabel = document.querySelector(
      "[data-subagent-transcript-tool-run-toggle='true'] span",
    )!;

    const targets = [
      firstLineRect(firstProse),
      receiptLabel.getBoundingClientRect(),
      firstLineRect(secondProse),
    ];
    const offsets = nodes.map((node, index) =>
      Math.abs(centerY(node.getBoundingClientRect()) - centerY(targets[index]!)),
    );
    expect(offsets.map((offset) => offset <= 2)).toEqual([true, true, true]);
  });

  it("reads a one-call run as a receipt and opens it in place", async () => {
    renderTranscript();
    await expect.element(page.getByText("1 action")).toBeVisible();
    await expect.element(page.getByText("Read ×1")).toBeVisible();

    // Collapsed: the receipt is the only thing the run puts on the thread.
    expect(document.querySelector("[data-subagent-transcript-entry='tool']")).toBeNull();
    const toggle = document.querySelector(
      "[data-subagent-transcript-tool-run-toggle='true']",
    ) as HTMLElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    // Expanding shows the call it folded, in place, with its result behind the
    // same disclosure the rest of the panel uses.
    await page.getByRole("button", { name: /1 action/u }).click();
    await expect.element(page.getByText("src/router.tsx")).toBeVisible();
    expect(document.querySelector("[data-subagent-transcript-entry='tool']")).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await page.getByRole("button", { name: "Output" }).click();
    await expect.element(page.getByText("export const routes = []")).toBeVisible();
  });

  it("opens a file reference in the agent's prose in the file viewer", async () => {
    transcriptRpcMock.mockResolvedValue({
      entries: [
        {
          id: "f1",
          role: "assistant",
          text: "The gutter is set in `apps/web/src/components/chat/AgentsPanel.tsx:300`.",
          toolUses: [],
          at: "2026-08-11T10:00:00.000Z",
        },
      ],
      truncated: false,
      offset: 0,
      totalEntries: 1,
    });
    setActiveFileViewerContext({ environmentId: ENVIRONMENT_ID, cwd: "C:/repo", threadRef: null });

    try {
      renderTranscript();
      const reference = page.getByRole("button", {
        name: "apps/web/src/components/chat/AgentsPanel.tsx:300",
      });
      await expect.element(reference).toBeVisible();

      await reference.click();
      await vi.waitFor(() => {
        const state = useFileViewerStore.getState();
        expect(state.isOpen).toBe(true);
        expect(state.activePath).toBe("apps/web/src/components/chat/AgentsPanel.tsx");
        expect(state.revealLine).toBe(300);
      });
    } finally {
      setActiveFileViewerContext(null);
      useFileViewerStore.getState().close();
    }
  });

  it("wraps a long first line under the timestamp instead of into it", async () => {
    renderTranscript();
    await expect.element(page.getByText(LONG_PROSE)).toBeVisible();

    const entry = [...document.querySelectorAll("[data-subagent-transcript-entry='assistant']")].at(
      -1,
    )!;
    const prose = entry.querySelector(".chat-markdown p")!;
    const time = entry.querySelector("[data-subagent-transcript-time='true']")!;
    const timeRect = time.getBoundingClientRect();
    const line = firstLineRect(prose);

    // The case is only real if the prose wrapped.
    expect(lineRectCount(prose)).toBeGreaterThan(1);
    // The time shares the prose's first line, and the line stops short of it.
    expect(Math.abs(centerY(timeRect) - centerY(line))).toBeLessThanOrEqual(2);
    expect(line.right).toBeLessThanOrEqual(timeRect.left + 0.5);
  });
});
