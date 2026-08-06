import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

function readVersion(packageJsonPath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Fails fast, before the Effect runtime spins up, when the install contains two
 * copies of `effect` (e.g. an npm peer-range resolving to a newer release than
 * our exact pin). A mixed install poisons Effect's own error reporting: each
 * copy misclassifies the other's Cause objects, so the process exits 1 with no
 * output at all instead of surfacing the underlying failure. This guard turns
 * that silent death into an actionable message. Runs plain sync Node on
 * purpose; it must not depend on the runtime it is validating.
 */
export function assertSingleEffectRuntime(): void {
  let serverEffectPath: string;
  let platformEffectPath: string;
  try {
    const requireFromServer = createRequire(import.meta.url);
    serverEffectPath = realpathSync(requireFromServer.resolve("effect/package.json"));
    const requireFromPlatform = createRequire(
      requireFromServer.resolve("@effect/platform-node/package.json"),
    );
    platformEffectPath = realpathSync(requireFromPlatform.resolve("effect/package.json"));
  } catch {
    // Never block startup because the check itself could not resolve modules.
    return;
  }
  if (serverEffectPath === platformEffectPath) return;

  const serverDir = path.dirname(serverEffectPath);
  const platformDir = path.dirname(platformEffectPath);
  process.stderr.write(
    [
      'Threadlines failed to start: this install contains two conflicting copies of the "effect" runtime.',
      "",
      `  server resolves:   ${serverDir} (${readVersion(serverEffectPath)})`,
      `  platform resolves: ${platformDir} (${readVersion(platformEffectPath)})`,
      "",
      "This is a broken package installation, not a problem with your setup.",
      "Reinstalling the latest version usually fixes it:",
      "",
      "  npx -y @threadlines/server@latest",
      "",
      "If it persists, please report it: https://github.com/Threadlines/threadlines/issues",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
