import type { APIRoute, GetStaticPaths } from "astro";

import { heroFontFiles } from "../../../lib/heroThemes";

/**
 * The hero themes' embedded fonts, each one file named by its content, served
 * as the unmodified WOFF2 bytes (the font's name table carries its license notice).
 */
export const getStaticPaths = (() =>
  [...heroFontFiles().keys()].map((path) => ({
    params: { file: path.slice(path.lastIndexOf("/") + 1) },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ params }) => {
  const bytes = heroFontFiles().get(`/hero/fonts/${params.file}`);
  if (!bytes) return new Response(null, { status: 404 });
  return new Response(bytes, { headers: { "Content-Type": "font/woff2" } });
};
