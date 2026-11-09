/**
 * A theme's content hash (docs/design/custom-themes.md, "What a theme is"):
 * what names a theme in a library, on every computer. Apart from the file
 * checks (manifest.ts) so an app that only hashes loads none of them.
 */
import type { ThemeManifest } from "@threadlines/contracts";

/** JSON with object keys sorted at every level, so equal content is equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The part of a theme its hash covers: everything but its name, prompt,
 * origin and date. Embedded font bytes and the still are content too, so two
 * files that differ only there never share a hash (and one never silently
 * replaces the other in a library). So are its credits: a library stores
 * content once per hash, and a license belongs with the content it covers, so
 * a credited copy is never folded into an uncredited one (or the other way).
 */
export function themeContentForHash(manifest: ThemeManifest): unknown {
  const {
    name: _name,
    prompt: _prompt,
    createdBy: _createdBy,
    createdAt: _createdAt,
    ...content
  } = manifest;
  return content;
}

/** SHA-256 of a theme's canonical content, lowercase hex. */
export async function themeContentHash(manifest: ThemeManifest): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(themeContentForHash(manifest)));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
