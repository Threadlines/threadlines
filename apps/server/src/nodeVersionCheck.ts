import { satisfiesSemverRange } from "@threadlines/shared/semver";

/**
 * What `threadlines` prints when this Node.js can't run the server, or null
 * when it can. `supportedRange` is the package's `engines.node`.
 */
export function unsupportedNodeMessage(nodeVersion: string, supportedRange: string): string | null {
  if (satisfiesSemverRange(nodeVersion, supportedRange)) {
    return null;
  }
  return [
    `Threadlines needs a newer Node.js. This is ${nodeVersion}, and the supported versions are ${supportedRange}.`,
    "Install the current Node.js LTS from https://nodejs.org, then run the command again.",
  ].join("\n");
}
