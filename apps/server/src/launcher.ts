/**
 * Entry for the published `threadlines` command (packed as `dist/bin.mjs`).
 *
 * The server bundle imports Node APIs that older versions lack, and those
 * versions fail while loading it, before any of our code can explain why. So
 * this entry checks the version first and only then loads the server. Keep its
 * own imports small and free of newer Node APIs.
 */
import packageJson from "../package.json" with { type: "json" };
import { unsupportedNodeMessage } from "./nodeVersionCheck.ts";

// The desktop app runs this entry on the Node inside Electron, which ships
// with the app; the check is for Node installed by the user.
const problem = process.versions.electron
  ? null
  : unsupportedNodeMessage(process.versions.node, packageJson.engines.node);

if (problem) {
  process.stderr.write(`${problem}\n`);
  process.exitCode = 1;
} else {
  // A promise chain, not top-level await: the server chunk can import shared
  // code from this entry chunk, and awaiting it here would deadlock that cycle.
  void import("./bin.ts").then(({ runCli }) => runCli());
}
