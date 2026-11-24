// @effect-diagnostics nodeBuiltinImport:off
/**
 * A Claude session carried with a moved thread (docs/design/fleet.md, Part
 * 3d): its transcript `projects/<slug>/<sessionId>.jsonl` and its subagents'
 * transcripts under `<sessionId>/subagents/` (and `workflows/<runId>/` in
 * there), from the instance's config folder. Not `file-history`, `todos`,
 * `plans` or `shell-snapshots`: checkpoints don't cross a move, and the rest
 * is this machine's own state.
 *
 * On the other computer the files go under the project folder of the moved
 * thread's new checkout, named from the cursor's session id. The transcript
 * still names the old worktree, so the first start resumes it as a fork in
 * the new place (ClaudeAdapter's `forkResumeOutOfWorktree`); no file is
 * rewritten.
 *
 * @module provider/Drivers/ClaudeNativeSession
 */
import { ProviderDriverKind } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as path from "node:path";

import {
  isSessionUuid,
  listFolder,
  type NativeSessionExport,
  type NativeSessionFile,
  type NativeSessionImportInput,
  type NativeSessionImportResult,
  type NativeSessionPlacement,
  placeSessionFiles,
  statSessionFile,
} from "../nativeSession.ts";
import { claudeProjectDirectoryName } from "./ClaudeSessionTranscripts.ts";

const DRIVER = ProviderDriverKind.make("claudeAgent");

/** An agent's or a workflow run's id, as Claude names its files. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,128})\.(jsonl|meta\.json)$/;

interface ClaudeCarriedCursor {
  readonly resume: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
}

/** The parts of a Claude resume cursor that travel: the session and where to resume in it. */
function readCarriedCursor(cursor: unknown): ClaudeCarriedCursor | null {
  if (cursor === null || typeof cursor !== "object") return null;
  const record = cursor as Record<string, unknown>;
  const resume = record.resume ?? record.sessionId;
  if (!isSessionUuid(resume)) return null;
  const resumeSessionAt =
    typeof record.resumeSessionAt === "string" && isSessionUuid(record.resumeSessionAt)
      ? record.resumeSessionAt
      : undefined;
  const turnCount =
    typeof record.turnCount === "number" && Number.isInteger(record.turnCount)
      ? Math.max(0, record.turnCount)
      : undefined;
  return {
    resume,
    ...(resumeSessionAt !== undefined ? { resumeSessionAt } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
  };
}

/**
 * The session's files in `configDir`, or null when it has none here. The
 * transcript Claude wrote last wins when an older copy sits under another
 * project folder (a resume from another checkout copies it).
 */
export const exportClaudeNativeSession = Effect.fn("exportClaudeNativeSession")(function* (input: {
  readonly configDir: string;
  readonly resumeCursor: unknown;
}): Effect.fn.Return<NativeSessionExport | null, never, never> {
  const cursor = readCarriedCursor(input.resumeCursor);
  if (cursor === null) return null;
  const projectsDir = path.join(input.configDir, "projects");
  let found: { slug: string; size: number; mtimeMs: number } | null = null;
  for (const entry of yield* listFolder(projectsDir)) {
    if (!entry.isDirectory()) continue;
    const stat = yield* statSessionFile(
      path.join(projectsDir, entry.name, `${cursor.resume}.jsonl`),
    );
    if (stat !== null && (found === null || stat.mtimeMs > found.mtimeMs)) {
      found = { slug: entry.name, ...stat };
    }
  }
  if (found === null) return null;
  const slugDir = path.join(projectsDir, found.slug);
  const files: Array<NativeSessionFile> = [
    {
      relPath: `projects/${found.slug}/${cursor.resume}.jsonl`,
      absolutePath: path.join(slugDir, `${cursor.resume}.jsonl`),
      size: found.size,
    },
  ];
  const subagentsDir = path.join(slugDir, cursor.resume, "subagents");
  const takeAgentFiles = (dir: string, relDir: string) =>
    Effect.gen(function* () {
      for (const entry of yield* listFolder(dir)) {
        if (!entry.isFile() || !AGENT_FILE.test(entry.name)) continue;
        const absolutePath = path.join(dir, entry.name);
        const stat = yield* statSessionFile(absolutePath);
        if (stat !== null) {
          files.push({ relPath: `${relDir}/${entry.name}`, absolutePath, size: stat.size });
        }
      }
    });
  const subagentsRel = `projects/${found.slug}/${cursor.resume}/subagents`;
  yield* takeAgentFiles(subagentsDir, subagentsRel);
  for (const entry of yield* listFolder(path.join(subagentsDir, "workflows"))) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    yield* takeAgentFiles(
      path.join(subagentsDir, "workflows", entry.name),
      `${subagentsRel}/workflows/${entry.name}`,
    );
  }
  return { driver: DRIVER, cursor, files };
});

/**
 * Where each received file goes under `configDir`, named from the cursor's
 * session id and the new checkout's project folder; null for a file that
 * isn't one of the session's (refusing the session).
 */
export function claudeSessionDestination(input: {
  readonly configDir: string;
  readonly worktreePath: string;
  readonly sessionId: string;
  readonly relPath: string;
}): { readonly destination: string; readonly transcript: boolean } | null {
  const { sessionId } = input;
  const parts = input.relPath.split("/");
  if (parts.length < 3 || parts[0] !== "projects" || parts.some((part) => part.length === 0)) {
    return null;
  }
  const projectDir = path.join(
    input.configDir,
    "projects",
    claudeProjectDirectoryName(input.worktreePath),
  );
  const rest = parts.slice(2);
  if (rest.length === 1 && rest[0] === `${sessionId}.jsonl`) {
    return { destination: path.join(projectDir, `${sessionId}.jsonl`), transcript: true };
  }
  if (rest[0] !== sessionId || rest[1] !== "subagents") return null;
  if (rest.length === 3 && AGENT_FILE.test(rest[2]!)) {
    return {
      destination: path.join(projectDir, sessionId, "subagents", rest[2]!),
      transcript: false,
    };
  }
  if (
    rest.length === 5 &&
    rest[2] === "workflows" &&
    SAFE_ID.test(rest[3]!) &&
    AGENT_FILE.test(rest[4]!)
  ) {
    return {
      destination: path.join(projectDir, sessionId, "subagents", "workflows", rest[3]!, rest[4]!),
      transcript: false,
    };
  }
  return null;
}

/** Writes a carried session into `configDir` and returns the cursor that resumes it here. */
export const importClaudeNativeSession = Effect.fn("importClaudeNativeSession")(function* (
  input: NativeSessionImportInput & { readonly configDir: string },
): Effect.fn.Return<NativeSessionImportResult, never, never> {
  const cursor = readCarriedCursor(input.cursor);
  if (cursor === null) return { refused: "its Claude session id isn't one" };
  const placements: Array<NativeSessionPlacement> = [];
  let transcripts = 0;
  for (const file of input.files) {
    const placed = claudeSessionDestination({
      configDir: input.configDir,
      worktreePath: input.worktreePath,
      sessionId: cursor.resume,
      relPath: file.relPath,
    });
    if (placed === null) return { refused: `"${file.relPath}" isn't part of the session` };
    if (placements.some((entry) => entry.destination === placed.destination)) {
      return { refused: `"${file.relPath}" is there twice` };
    }
    if (placed.transcript) transcripts += 1;
    placements.push({ destination: placed.destination, bytes: file.bytes });
  }
  if (transcripts !== 1) return { refused: "it doesn't hold the session's transcript once" };
  const placed = yield* placeSessionFiles(placements, input.transferKey, input.journal);
  return "refused" in placed ? placed : { cursor, written: placed.written };
});
