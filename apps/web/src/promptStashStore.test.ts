import { ThreadId } from "@threadlines/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  MAX_STASH_ENTRIES,
  MAX_STASH_ENTRY_ATTACHMENT_CHARS,
  partitionStashAttachments,
  setPromptStashStorageForTest,
  stashEntryChipCount,
  usePromptStashStore,
  writePromptStashStorageForTest,
  type PromptStashEntry,
} from "./promptStashStore";

function makeEntry(input: {
  id: string;
  prompt?: string;
  attachmentChars?: number;
}): PromptStashEntry {
  return {
    id: input.id,
    createdAt: "2026-07-24T12:00:00.000Z",
    prompt: input.prompt ?? `prompt ${input.id}`,
    attachments:
      input.attachmentChars !== undefined
        ? [
            {
              id: `${input.id}-file`,
              name: "shot.png",
              mimeType: "image/png",
              sizeBytes: input.attachmentChars,
              dataUrl: "x".repeat(input.attachmentChars),
            },
          ]
        : [],
    droppedAttachmentNames: [],
  };
}

function resetPromptStashStore() {
  usePromptStashStore.setState({ entries: [] });
  writePromptStashStorageForTest("");
}

describe("partitionStashAttachments", () => {
  it("keeps attachments within the budget and reports dropped names in order", () => {
    const small = {
      id: "a",
      name: "small.png",
      mimeType: "image/png",
      sizeBytes: 10,
      dataUrl: "x".repeat(10),
    };
    const huge = {
      id: "b",
      name: "huge.pdf",
      mimeType: "application/pdf",
      sizeBytes: MAX_STASH_ENTRY_ATTACHMENT_CHARS,
      dataUrl: "x".repeat(MAX_STASH_ENTRY_ATTACHMENT_CHARS),
    };
    const alsoSmall = {
      id: "c",
      name: "also-small.png",
      mimeType: "image/png",
      sizeBytes: 10,
      dataUrl: "x".repeat(10),
    };
    const { kept, droppedNames } = partitionStashAttachments([small, huge, alsoSmall]);
    expect(kept.map((attachment) => attachment.id)).toEqual(["a", "c"]);
    expect(droppedNames).toEqual(["huge.pdf"]);
  });

  it("admits a single attachment that exactly fits the budget", () => {
    const exact = {
      id: "a",
      name: "exact.png",
      mimeType: "image/png",
      sizeBytes: MAX_STASH_ENTRY_ATTACHMENT_CHARS,
      dataUrl: "x".repeat(MAX_STASH_ENTRY_ATTACHMENT_CHARS),
    };
    const { kept, droppedNames } = partitionStashAttachments([exact]);
    expect(kept).toHaveLength(1);
    expect(droppedNames).toEqual([]);
  });
});

describe("promptStashStore", () => {
  beforeEach(() => {
    resetPromptStashStore();
  });

  afterEach(() => {
    resetPromptStashStore();
  });

  it("prepends entries so the newest stash is first", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry(makeEntry({ id: "first" }));
    store.stashEntry(makeEntry({ id: "second" }));
    expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([
      "second",
      "first",
    ]);
  });

  it("evicts the oldest entry past the cap and returns it", () => {
    const store = usePromptStashStore.getState();
    for (let index = 0; index < MAX_STASH_ENTRIES; index += 1) {
      expect(store.stashEntry(makeEntry({ id: `entry-${index}` })).evicted).toBeNull();
    }
    const { evicted } = store.stashEntry(makeEntry({ id: "overflow" }));
    expect(evicted?.id).toBe("entry-0");
    const entries = usePromptStashStore.getState().entries;
    expect(entries).toHaveLength(MAX_STASH_ENTRIES);
    expect(entries[0]?.id).toBe("overflow");
  });

  // The unit test environment has no `localStorage`, so the store runs on its
  // in-memory fallback: the exact "kept for this session, gone on reload"
  // case the composer must distinguish from an outright write failure.
  it("distinguishes a memory-only write (written, not durable) from a failed one", () => {
    const result = usePromptStashStore.getState().stashEntry(makeEntry({ id: "memory-only" }));
    expect(result.written).toBe(true);
    expect(result.durable).toBe(false);
    expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([
      "memory-only",
    ]);
  });

  it("takeEntry removes and returns the entry; a second take returns null", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry(makeEntry({ id: "keep" }));
    store.stashEntry(makeEntry({ id: "take" }));
    expect(store.takeEntry("take").entry?.id).toBe("take");
    expect(store.takeEntry("take").entry).toBeNull();
    expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual(["keep"]);
  });

  it("finalizeEntryAttachments attaches files and clears the pending count", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry({ ...makeEntry({ id: "pending" }), pendingAttachmentCount: 2 });

    const { attached } = store.finalizeEntryAttachments("pending", {
      attachments: [
        {
          id: "file-1",
          name: "a.webp",
          mimeType: "image/webp",
          sizeBytes: 10,
          dataUrl: "data:image/webp;base64,AAAA",
        },
      ],
      droppedAttachmentNames: ["big.png"],
      unreadableAttachmentNames: [],
    });

    expect(attached).toBe(true);
    const entry = usePromptStashStore.getState().entries[0];
    expect(entry?.attachments).toHaveLength(1);
    expect(entry?.droppedAttachmentNames).toEqual(["big.png"]);
    expect(entry?.pendingAttachmentCount).toBe(0);
  });

  it("finalizeEntryAttachments reports false when the entry was already taken", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry({ ...makeEntry({ id: "racing" }), pendingAttachmentCount: 1 });
    // Restored (or deleted) while its attachments were still encoding.
    store.takeEntry("racing");

    const { attached } = store.finalizeEntryAttachments("racing", {
      attachments: [],
      droppedAttachmentNames: [],
      unreadableAttachmentNames: [],
    });

    expect(attached).toBe(false);
  });

  it("settles a pending count left behind by a crashed or closed session", () => {
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 1,
        state: {
          entries: [{ ...makeEntry({ id: "orphan" }), pendingAttachmentCount: 2 }],
        },
      }),
    );

    // Hydration must settle the stale count, or the entry would stay stuck
    // showing "saving" with attachments that no longer exist anywhere.
    const entry = usePromptStashStore.getState().entries[0];
    expect(entry?.pendingAttachmentCount).toBe(0);
    expect(entry?.unreadableAttachmentNames).toHaveLength(2);
  });

  it("round-trips context chips through storage", () => {
    const threadId = ThreadId.make("thread-1");
    const entry: PromptStashEntry = {
      ...makeEntry({ id: "chips", prompt: "look at this ￼" }),
      terminalContexts: [
        {
          id: "term-1",
          threadId,
          createdAt: "2026-07-24T12:00:00.000Z",
          terminalId: "t1",
          terminalLabel: "zsh",
          lineStart: 3,
          lineEnd: 9,
          text: "npm run build\nfailed",
        },
      ],
      fileSelectionContexts: [
        {
          id: "file-1",
          threadId: "thread-1",
          createdAt: "2026-07-24T12:00:00.000Z",
          relativePath: "src/app.ts",
          startLine: 1,
          endLine: 4,
          selectedText: "const a = 1;",
        },
      ],
    };
    usePromptStashStore.getState().stashEntry(entry);

    // Force a decode of the persisted payload rather than trusting the
    // in-memory copy: a chip schema that cannot round-trip would drop the
    // whole entry on the next reload.
    const raw = JSON.stringify({ version: 1, state: { entries: [entry] } });
    writePromptStashStorageForTest(raw);

    const hydrated = usePromptStashStore.getState().entries[0];
    expect(hydrated?.terminalContexts?.[0]?.text).toBe("npm run build\nfailed");
    expect(hydrated?.fileSelectionContexts?.[0]?.relativePath).toBe("src/app.ts");
    expect(stashEntryChipCount(hydrated as PromptStashEntry)).toBe(2);
  });

  it("rolls back a rejected write so the queue never shows an unsaved entry", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry(makeEntry({ id: "already-there" }));

    setPromptStashStorageForTest({
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => {},
    });
    const result = store.stashEntry(makeEntry({ id: "rejected" }));
    setPromptStashStorageForTest(null);

    expect(result.written).toBe(false);
    expect(result.durable).toBe(false);
    expect(result.evicted).toBeNull();
    // The composer keeps its content on a failed write, so a visible entry
    // here would duplicate the prompt the user still has typed.
    expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([
      "already-there",
    ]);
  });

  it("ignores an undecodable payload rather than throwing at hydrate", () => {
    writePromptStashStorageForTest(
      JSON.stringify({ version: 1, state: { entries: [{ id: "broken" }] } }),
    );
    expect(usePromptStashStore.getState().entries).toEqual([]);
  });
});
