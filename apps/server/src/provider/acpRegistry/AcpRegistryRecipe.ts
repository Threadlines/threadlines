// @effect-diagnostics nodeBuiltinImport:off - hashes a recipe
/**
 * AcpRegistryRecipe — exactly what Threadlines would fetch and run for one
 * registry agent on this computer, and nothing else from its listing.
 *
 * The catalog reduces a registry entry to a recipe; the installer installs
 * a recipe; `acpRegistryRecipeDigest` names it. A client confirms an install
 * or update by digest, so what is installed is what the user was shown even
 * if the registry changes in between.
 *
 * @module provider/acpRegistry/AcpRegistryRecipe
 */
import { createHash } from "node:crypto";

import * as Schema from "effect/Schema";

const RecipeBase = {
  agentId: Schema.String,
  /** The version the registry lists. */
  version: Schema.String,
  /** Arguments the registry launches the agent with. */
  args: Schema.Array(Schema.String),
  /** The registry's environment for the agent, already filtered of names an agent may not set. */
  env: Schema.Record(Schema.String, Schema.String),
};

/** An npm package, installed with Threadlines' own Node.js. */
export const AcpRegistryNpmRecipe = Schema.Struct({
  kind: Schema.Literal("npm"),
  ...RecipeBase,
  packageName: Schema.String,
  /** Exact, never a range or a tag. */
  packageVersion: Schema.String,
});
export type AcpRegistryNpmRecipe = typeof AcpRegistryNpmRecipe.Type;

/** A download from the agent's publisher. */
export const AcpRegistryDownloadRecipe = Schema.Struct({
  kind: Schema.Literal("download"),
  ...RecipeBase,
  /** https. */
  url: Schema.String,
  /** Lowercase hex, or null when the publisher lists no checksum. */
  sha256: Schema.NullOr(Schema.String),
  /** How the download is unpacked. `raw`: it is the program itself. */
  format: Schema.Literals(["zip", "tar.gz", "tar.bz2", "raw"]),
  /**
   * The program to launch, relative to the unpacked folder: `/`-separated,
   * no leading `./`. For `raw`, the name the download is saved under.
   */
  cmd: Schema.String,
});
export type AcpRegistryDownloadRecipe = typeof AcpRegistryDownloadRecipe.Type;

export const AcpRegistryRecipe = Schema.Union([AcpRegistryNpmRecipe, AcpRegistryDownloadRecipe]);
export type AcpRegistryRecipe = typeof AcpRegistryRecipe.Type;

/** JSON with object keys in sorted order at every level, so equal values serialize equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 of the recipe's canonical JSON, lowercase hex. */
export function acpRegistryRecipeDigest(recipe: AcpRegistryRecipe): string {
  return createHash("sha256").update(canonicalJson(recipe)).digest("hex");
}
