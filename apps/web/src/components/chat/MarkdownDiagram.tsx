/**
 * A ```mermaid block in a reply, drawn as a diagram once its fence has closed.
 * While the reply is still writing it, and until the renderer loads, it is the
 * code block it always was. Code and diagram share one frame: "Show code"
 * swaps them, Copy copies the source, and the full-size view opens the diagram
 * at its natural size. A diagram the renderer can't read stays code, with the
 * reason under it.
 */
import { CodeIcon, Maximize2Icon, WorkflowIcon } from "lucide-react";
import { memo, type ReactNode, useState } from "react";

import { useCachedRender } from "../../hooks/useCachedRender";
import { fnv1a32 } from "../../lib/diffRendering";
import { LRUCache } from "../../lib/lruCache";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import type { DrawnDiagram } from "./markdownDiagramRuntime";

type DiagramRuntime = typeof import("./markdownDiagramRuntime");
type DiagramResult =
  | { readonly kind: "drawn"; readonly diagram: DrawnDiagram }
  | { readonly kind: "unreadable"; readonly reason: string };

let diagramRuntimeLoading: Promise<DiagramRuntime> | null = null;

function loadDiagramRuntime(): Promise<DiagramRuntime> {
  diagramRuntimeLoading ??= import("./markdownDiagramRuntime").catch((error: unknown) => {
    diagramRuntimeLoading = null;
    throw error;
  });
  return diagramRuntimeLoading;
}

const drawnDiagramCache = new LRUCache<DiagramResult>(200, 16 * 1024 * 1024);

function appSansFont(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const font = getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim();
  return font.length > 0 ? font : undefined;
}

async function drawDiagram(source: string): Promise<DiagramResult> {
  const runtime = await loadDiagramRuntime();
  try {
    const diagram = await runtime.renderDiagram(source, {
      // Ids inside one diagram's SVG (arrowheads, clips) must not collide with
      // another diagram's on the same page.
      idPrefix: `d${fnv1a32(source).toString(36)}`,
      fontFamily: appSansFont(),
    });
    return { kind: "drawn", diagram };
  } catch (error) {
    const reason = error instanceof Error && error.message.trim() ? error.message.trim() : "";
    return { kind: "unreadable", reason };
  }
}

const DIAGRAM_ACTION_CLASS_NAME = "chat-markdown-copy-button";

export const MarkdownDiagram = memo(function MarkdownDiagram({
  code,
  pending,
  codeView,
}: {
  code: string;
  /** The reply is still writing this block. */
  pending: boolean;
  /** The block as code, highlighted like any other. */
  codeView: ReactNode;
}) {
  const [showCode, setShowCode] = useState(false);
  const [fullSize, setFullSize] = useState(false);
  const source = code.trimEnd();
  const result = useCachedRender({
    cache: drawnDiagramCache,
    key: pending || source.length === 0 ? null : source,
    draw: () => drawDiagram(source),
    sizeOf: (value) => (value.kind === "drawn" ? value.diagram.svg.length * 2 : 64),
  });
  const diagram = result?.kind === "drawn" ? result.diagram : null;

  if (!diagram || showCode) {
    return (
      <>
        <MarkdownCodeBlock
          code={code}
          language="mermaid"
          findIgnored
          actions={
            diagram ? (
              <Button
                variant="ghost"
                size="icon-xs"
                className={DIAGRAM_ACTION_CLASS_NAME}
                aria-label="Show diagram"
                tooltip="Show diagram"
                onClick={() => setShowCode(false)}
              >
                <WorkflowIcon />
              </Button>
            ) : null
          }
        >
          {codeView}
        </MarkdownCodeBlock>
        {result?.kind === "unreadable" ? (
          <p
            className="-mt-1 mb-2 text-[12.5px] text-muted-foreground"
            data-chat-find-ignore=""
            data-chat-markdown-diagram-error=""
          >
            {result.reason
              ? `Couldn't draw this diagram: ${result.reason}`
              : "Couldn't draw this diagram."}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <>
      <MarkdownCodeBlock
        code={code}
        language="mermaid"
        findIgnored
        actions={
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              className={DIAGRAM_ACTION_CLASS_NAME}
              aria-label="View full size"
              tooltip="View full size"
              onClick={() => setFullSize(true)}
            >
              <Maximize2Icon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className={DIAGRAM_ACTION_CLASS_NAME}
              aria-label="Show code"
              tooltip="Show code"
              onClick={() => setShowCode(true)}
            >
              <CodeIcon />
            </Button>
          </>
        }
      >
        <div
          className="chat-markdown-diagram"
          data-chat-markdown-diagram=""
          // A group, not an image: pele names the SVG itself from the diagram's
          // own accTitle and accDescr, which an image role would hide.
          role="group"
          aria-label="Diagram"
          // pele escapes the diagram's text and the SVG went through DOMPurify.
          dangerouslySetInnerHTML={{ __html: diagram.svg }}
        />
      </MarkdownCodeBlock>
      <Dialog open={fullSize} onOpenChange={setFullSize}>
        <DialogPopup className="max-w-[min(96vw,1600px)]" bottomStickOnMobile={false}>
          <DialogTitle className="sr-only">Diagram</DialogTitle>
          <div className="max-h-[85vh] overflow-auto p-6 pt-12">
            <div
              className="chat-markdown-diagram chat-markdown-diagram-full"
              style={{ width: diagram.width }}
              dangerouslySetInnerHTML={{ __html: diagram.svg }}
            />
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
});
