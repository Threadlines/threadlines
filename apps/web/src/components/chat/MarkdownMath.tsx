/**
 * Math in a reply: `$$…$$` inside a sentence (InlineMath) and on lines of its
 * own (DisplayMath), drawn with KaTeX once it loads. Until then, and whenever
 * the TeX can't be read, the source shows as code, so nothing a model wrote is
 * ever hidden. Find in chat reads past formulas (they carry the find-ignore
 * mark, and chatFindText skips math), since their drawn glyphs aren't words.
 */
import { memo } from "react";

import { useCachedRender } from "../../hooks/useCachedRender";
import { LRUCache } from "../../lib/lruCache";

type MathRuntime = typeof import("./markdownMathRuntime");
/** A formula as KaTeX drew it, or null when its TeX couldn't be read. */
type DrawnMath = { readonly html: string } | null;

let mathRuntime: MathRuntime | null = null;
let mathRuntimeLoading: Promise<MathRuntime> | null = null;

function loadMathRuntime(): Promise<MathRuntime> {
  mathRuntimeLoading ??= import("./markdownMathRuntime").then(
    (runtime) => {
      mathRuntime = runtime;
      return runtime;
    },
    (error: unknown) => {
      mathRuntimeLoading = null;
      throw error;
    },
  );
  return mathRuntimeLoading;
}

const drawnMathCache = new LRUCache<{ drawn: DrawnMath }>(2000, 8 * 1024 * 1024);

function drawTex(runtime: MathRuntime, tex: string, displayMode: boolean): { drawn: DrawnMath } {
  try {
    return { drawn: { html: runtime.renderTex(tex, displayMode) } };
  } catch {
    return { drawn: null };
  }
}

/** The formula drawn, null for TeX KaTeX can't read, undefined until KaTeX is here. */
function useDrawnMath(tex: string, displayMode: boolean, pending: boolean): DrawnMath | undefined {
  const key = pending ? null : `${displayMode ? "display" : "inline"}:${tex}`;
  const entry = useCachedRender({
    cache: drawnMathCache,
    key,
    draw: () => loadMathRuntime().then((runtime) => drawTex(runtime, tex, displayMode)),
    drawNow: () => (mathRuntime ? drawTex(mathRuntime, tex, displayMode) : null),
    sizeOf: (value) => (value.drawn?.html.length ?? 0) * 2 + tex.length,
  });
  return entry?.drawn;
}

const UNREADABLE_FORMULA = "This formula couldn't be drawn, so it shows as written";

export const InlineMath = memo(function InlineMath({ tex }: { tex: string }) {
  const drawn = useDrawnMath(tex, false, false);
  if (drawn) {
    return (
      <span
        className="chat-markdown-math"
        data-chat-find-ignore=""
        // KaTeX escapes the TeX it is given, and trust is off.
        dangerouslySetInnerHTML={{ __html: drawn.html }}
      />
    );
  }
  return (
    <code
      className="chat-markdown-math-source"
      data-chat-find-ignore=""
      title={drawn === null ? UNREADABLE_FORMULA : undefined}
    >
      {tex}
    </code>
  );
});

/**
 * A display formula. `pending`: the reply is still writing it, so its TeX is
 * shown as it arrives instead of being drawn and redrawn half-finished.
 */
export const DisplayMath = memo(function DisplayMath({
  tex,
  pending,
}: {
  tex: string;
  pending: boolean;
}) {
  const drawn = useDrawnMath(tex, true, pending);
  if (drawn) {
    return (
      <div
        className="chat-markdown-math-display"
        data-chat-find-ignore=""
        dangerouslySetInnerHTML={{ __html: drawn.html }}
      />
    );
  }
  return (
    <pre
      className="chat-markdown-math-source"
      data-chat-find-ignore=""
      title={drawn === null ? UNREADABLE_FORMULA : undefined}
    >
      <code>{tex}</code>
    </pre>
  );
});
