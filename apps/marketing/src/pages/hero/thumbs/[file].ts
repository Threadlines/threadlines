import type { APIRoute, GetStaticPaths } from "astro";

import { heroThemes, heroThumbnails } from "../../../lib/heroThemes";

/** A theme's tile picture for the hero window's theme strip (lib/heroThemes.ts heroThumbnails). */
export const getStaticPaths = (() =>
  heroThemes()
    .filter((theme) => theme.hasArt)
    .map((theme) => ({
      params: { file: `${theme.id}.webp` },
      props: { id: theme.id },
    }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ id: string }> = async ({ props }) => {
  const bytes = (await heroThumbnails()).get(props.id);
  if (!bytes) return new Response(null, { status: 404 });
  return new Response(bytes, { headers: { "Content-Type": "image/webp" } });
};
