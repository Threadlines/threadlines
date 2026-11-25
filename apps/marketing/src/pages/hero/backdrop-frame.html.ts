import { buildBackdropFrameDocument } from "@threadlines/shared/themeBackdropFrame";
import type { APIRoute } from "astro";

/**
 * The app's backdrop frame document, as one static file. The hero window
 * loads it into a sandboxed iframe (scripts only, so an opaque origin) and
 * drives it with the same messages the app sends.
 */
export const GET: APIRoute = () =>
  new Response(buildBackdropFrameDocument(), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
