import type { APIRoute, GetStaticPaths } from "astro";

import { heroArtPayload, heroThemes } from "../../../lib/heroThemes";

/** One theme's art for the homepage's hero window, fetched only when the art starts. */
export const getStaticPaths = (() =>
  heroThemes()
    .filter((theme) => theme.hasArt)
    .map((theme) => ({ params: { id: theme.id } }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ params }) => {
  const theme = heroThemes().find((candidate) => candidate.id === params.id);
  if (!theme) return new Response(null, { status: 404 });
  return new Response(JSON.stringify(heroArtPayload(theme)), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
