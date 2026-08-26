# Streaming renderer benchmark reply

This is a **long assistant reply** used to measure how the chat renders text while it streams. It mixes paragraphs, inline `code`, lists, tables, and fenced code blocks so every renderer path gets exercised. The exact words do not matter; the shape of the document does.

## What the change does

The streaming path in `ChatMarkdown.tsx` splits the reply into blocks and only re-parses the block that is still growing. That keeps the settled part of the reply cheap. The remaining cost sits in three places: the final full-document re-parse, the settle swap for each block, and long blocks such as lists that never hit a blank line.

Here is a list of the files that were touched, in the order they were changed:

- `apps/web/src/components/ChatMarkdown.tsx` splits blocks and memoizes settled ones
- `apps/web/src/components/chat/MessagesTimeline.tsx` renders each assistant row
- `apps/web/src/components/chat/MessagesTimeline.logic.ts` derives timeline rows from thread state
- `apps/web/src/store.ts` appends each streaming delta to the message text
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` batches deltas every 50 ms
- `packages/contracts/src/rpc.ts` types the wire events
- `apps/web/src/hooks/useMarkdownFileLinkKinds.ts` resolves file chips
- `apps/web/src/lib/diffRendering.ts` picks the Shiki theme
- `apps/web/src/lib/lruCache.ts` bounds the highlight cache
- `apps/web/src/index.css` styles the markdown body
- `apps/web/src/components/chat/MessageCopyButton.tsx` copies code blocks
- `apps/web/src/components/chat/SkillInlineText.tsx` renders skill mentions
- `apps/web/src/components/chat/ChatWebLink.tsx` opens links in the browser panel
- `apps/web/src/markdown-links.ts` resolves file links
- `apps/web/src/fileViewerStore.ts` opens files in the viewer
- `apps/web/src/components/chat/CodexInlineVisualization.tsx` renders inline charts
- `apps/web/src/lib/codexInlineVisualization.ts` parses inline chart fences
- `apps/web/src/hooks/useTheme.ts` reads the current theme
- `apps/web/src/components/ui/tooltip.tsx` wraps tooltips
- `apps/web/src/components/ui/toast.tsx` shows toasts
- `apps/web/src/editorPreferences.ts` picks the editor to open files in
- `apps/web/src/localApi.ts` talks to the desktop shell
- `apps/web/src/environmentApi.ts` talks to the environment
- `apps/web/src/components/browser/openInBrowserPanel.ts` routes browser links
- `apps/web/src/components/chat/copyTextWithToast.ts` copies with feedback
- `apps/web/src/lib/utils.ts` joins class names
- `apps/web/src/components/chat/VscodeEntryIcon.tsx` shows file icons
- `apps/web/src/session-logic.ts` tracks session state
- `apps/web/src/types.ts` shared client types
- `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` mounts the chat view

## Measurements

| Scenario                 | Device         | Stalls per reply | Worst freeze | Frames held |
| ------------------------ | -------------- | ---------------- | ------------ | ----------- |
| Baseline                 | Slow laptop    | 27               | 410 ms       | 31 fps      |
| Baseline                 | 120 Hz MacBook | 9                | 120 ms       | 84 fps      |
| Block memo only          | Slow laptop    | 12               | 260 ms       | 48 fps      |
| Block memo only          | 120 Hz MacBook | 4                | 70 ms        | 108 fps     |
| Full rebuild             | Slow laptop    | 3                | 90 ms        | 58 fps      |
| Full rebuild             | 120 Hz MacBook | 1                | 14 ms        | 120 fps     |
| Full rebuild + smoothing | Slow laptop    | 3                | 88 ms        | 60 fps      |
| Full rebuild + smoothing | 120 Hz MacBook | 0                | 9 ms         | 120 fps     |
| Cold cache               | Slow laptop    | 5                | 140 ms       | 52 fps      |
| Cold cache               | 120 Hz MacBook | 2                | 30 ms        | 118 fps     |
| Long code block          | Slow laptop    | 4                | 110 ms       | 55 fps      |
| Long code block          | 120 Hz MacBook | 1                | 18 ms        | 120 fps     |

The numbers above are illustrative. The benchmark page prints real numbers for this machine at the end of the run.

## The block splitter

```ts
export function splitMarkdownBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let openFence: { char: string; length: number } | null = null;

  for (const line of lines) {
    const fenceMatch = BLOCK_FENCE_MARKER_REGEX.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      const rest = fenceMatch[2] ?? "";
      if (openFence === null) {
        openFence = { char: marker[0]!, length: marker.length };
      } else if (
        marker[0] === openFence.char &&
        marker.length >= openFence.length &&
        rest.trim() === ""
      ) {
        openFence = null;
      }
      current.push(line);
      continue;
    }

    if (openFence === null && line.trim() === "") {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }

    current.push(line);
  }

  if (current.length > 0) {
    blocks.push(current.join("\n"));
  }
  return blocks;
}
```

> Note: a fenced block that is still open is part of the growing tail. It is colored as it streams by an incremental tokenizer in the worker, so each delta costs only the new text.

## Server flush cadence

The server batches deltas and flushes every 50 ms. That is the rate the client sees, no matter how fast the model writes:

```json
{
  "commandTag": "assistant-delta-stream-batch",
  "flushIntervalMs": 50,
  "maxBufferedChars": 65536,
  "sources": ["flush", "message-completed", "user-input-requested"],
  "notes": [
    "A flush with no pending text is a no-op.",
    "Completion flushes the remaining buffer before the final message event.",
    "The safety valve flushes the whole buffer when it grows past the cap."
  ]
}
```

## Nested details

1. Settled blocks
   - parsed once
   - keyed by index, which is stable because streaming only appends
   - highlighted through the shared Shiki cache
2. The growing tail
   - parsed on every flush
   - deferred with `useDeferredValue` so a slow parse can be dropped
   - colored incrementally while the fence is open
3. The final render
   - keeps the same blocks, so nothing remounts
   - the settled code block swaps to cached HTML with no visible change

## Closing paragraph

If the renderer is working the way it should, the text above arrived at a steady pace, the table filled in row by row, the code blocks turned colored without a visible jump, and the page never froze long enough to notice. If any of that was not true, the benchmark numbers below will say so.
