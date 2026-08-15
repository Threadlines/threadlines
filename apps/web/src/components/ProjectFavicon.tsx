import type { EnvironmentId } from "@threadlines/contracts";
import { FolderIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "../lib/utils";
import { projectFaviconQueryOptions } from "../lib/projectReactQuery";

/**
 * A stable hue for a project, derived from its identity string (the cwd). The
 * same checkout keeps the same tint on every surface and across reloads, and
 * neighbouring paths land far apart because the multiplier spreads them.
 */
function projectMonogramHue(identity: string): number {
  let hash = 0;
  for (let index = 0; index < identity.length; index += 1) {
    hash = (hash * 31 + identity.charCodeAt(index)) % 360_000;
  }
  return hash % 360;
}

function projectMonogramGlyph(name: string): string | null {
  const first = name.trim().at(0);
  return first ? first.toUpperCase() : null;
}

/**
 * The stand-in for a project with no icon of its own: one tinted letter.
 *
 * Quiet by design — low chroma against the sidebar, no border and no shadow —
 * so a column of them reads as texture that distinguishes rows, not as a row
 * of colourful avatars.
 */
function ProjectMonogram(props: { glyph: string; hue: number; className: string | undefined }) {
  return (
    <span
      aria-hidden="true"
      style={
        {
          "--project-monogram-bg": `oklch(0.65 0.08 ${props.hue} / 0.22)`,
          "--project-monogram-fg": `oklch(0.55 0.10 ${props.hue})`,
          "--project-monogram-fg-dark": `oklch(0.78 0.08 ${props.hue})`,
        } as CSSProperties
      }
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm bg-[var(--project-monogram-bg)] text-[9px] leading-none font-semibold text-[var(--project-monogram-fg)] dark:text-[var(--project-monogram-fg-dark)]",
        props.className,
      )}
    >
      {props.glyph}
    </span>
  );
}

/**
 * The project's own icon, fetched over the environment's WebSocket RPC.
 *
 * One transport for every environment, primary or saved. A saved environment's
 * `/api/project-favicon` route is cross-origin and authenticated over the
 * WebSocket, so the browser cannot fetch it from an `<img>` at all; and even
 * locally the HTTP route answers a missing icon with a fallback SVG the client
 * can't tell apart from a real one, which is what the monogram needs to know.
 * Icons are a few KB and the query holds them for an hour, so this costs one
 * round trip per checkout.
 */
export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  /** Enables the monogram fallback for projects with no icon of their own. */
  name?: string;
  className?: string;
}) {
  const faviconQuery = useQuery(
    projectFaviconQueryOptions({
      environmentId: input.environmentId,
      cwd: input.cwd,
      enabled: input.cwd.length > 0,
    }),
  );

  const src = faviconQuery.data ?? null;
  if (src) {
    return (
      <img
        src={src}
        alt=""
        className={cn("size-3.5 shrink-0 rounded-sm object-contain", input.className)}
      />
    );
  }

  // While the fetch is still out, the project may yet have a real icon, and a
  // monogram that gets replaced by it reads as wrong-then-right. Hold the
  // neutral folder until "no icon" is an answer, not a guess.
  if (faviconQuery.isLoading) {
    return (
      <FolderIcon className={cn("size-3.5 shrink-0 text-muted-foreground/50", input.className)} />
    );
  }

  const glyph = input.name ? projectMonogramGlyph(input.name) : null;
  if (glyph) {
    return (
      <ProjectMonogram
        glyph={glyph}
        hue={projectMonogramHue(input.cwd)}
        className={input.className}
      />
    );
  }

  return (
    <FolderIcon className={cn("size-3.5 shrink-0 text-muted-foreground/50", input.className)} />
  );
}
