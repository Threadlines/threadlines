/**
 * The files of a Claude workflow run, read from the folders the run itself
 * named in its launch result, and saving a run's script as a command.
 *
 * Every path here came from Claude's report, stored on the run. They are only
 * trusted inside Claude's own `projects` folder, and every read goes through
 * `readConfinedFile`, so a path that moved, became a link or points elsewhere
 * reads nothing.
 *
 * Layout (Claude Code 2.1.2xx):
 *   <config>/projects/<project>/<session>/workflows/scripts/<name>-<runId>.js   script
 *   <config>/projects/<project>/<session>/workflows/<runId>.json                saved run (result, logs)
 *   <config>/projects/<project>/<session>/subagents/workflows/<runId>/agent-<id>.jsonl
 */
import * as NodeFs from "node:fs/promises";
import NodePath from "node:path";

import type {
  OrchestrationWorkflowRun,
  WorkflowCommandLocation,
  WorkflowReadRunFileResult,
  WorkflowSaveCommandResult,
} from "@threadlines/contracts";
import { parseWorkflowScriptMeta } from "@threadlines/shared/workflowScript";

import { readConfinedFile, writeConfinedFile } from "../../confinedFiles.ts";

const SCRIPT_MAX_BYTES = 1024 * 1024;
const RESULT_MAX_BYTES = 16 * 1024 * 1024;
const RESULT_TEXT_MAX_CHARS = 400_000;
const MAX_LOGS = 200;
/** What Claude accepts as a saved workflow's file name, kept conservative. */
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const RUN_ID = /^[A-Za-z0-9_-]{1,80}$/u;
const AGENT_ID = /^[A-Za-z0-9_-]{1,120}$/u;

type RunFiles = Pick<
  OrchestrationWorkflowRun,
  "runId" | "transcriptDir" | "scriptPath" | "status" | "hiddenScript" | "agents"
>;

export class ClaudeWorkflowFileError extends Error {}

function projectsRoot(configDir: string): string {
  return NodePath.join(configDir, "projects");
}

function within(root: string, candidate: string): boolean {
  const resolved = NodePath.resolve(candidate);
  return resolved.startsWith(NodePath.resolve(root) + NodePath.sep);
}

/** The session folder holding the run, from its transcript folder. */
function sessionDirectory(run: RunFiles, configDir: string): string | undefined {
  if (!run.transcriptDir || !within(projectsRoot(configDir), run.transcriptDir)) return undefined;
  // <session>/subagents/workflows/<runId>
  const workflows = NodePath.dirname(NodePath.resolve(run.transcriptDir));
  const subagents = NodePath.dirname(workflows);
  if (NodePath.basename(workflows) !== "workflows" || NodePath.basename(subagents) !== "subagents") {
    return undefined;
  }
  return NodePath.dirname(subagents);
}

const decoder = new TextDecoder();

async function readScript(run: RunFiles, configDir: string): Promise<string | undefined> {
  if (!run.scriptPath || !within(projectsRoot(configDir), run.scriptPath)) return undefined;
  const read = await readConfinedFile({
    root: projectsRoot(configDir),
    path: run.scriptPath,
    maxBytes: SCRIPT_MAX_BYTES,
  });
  return "bytes" in read ? decoder.decode(read.bytes) : undefined;
}

export async function readClaudeWorkflowRunFile(input: {
  readonly configDir: string;
  readonly run: RunFiles;
  readonly file: "script" | "result";
}): Promise<WorkflowReadRunFileResult> {
  const { run, configDir } = input;
  if (input.file === "script") {
    if (run.hiddenScript) {
      return { text: null, format: "javascript", truncated: false, unavailableReason: "hidden" };
    }
    const script = await readScript(run, configDir);
    return script === undefined
      ? { text: null, format: "javascript", truncated: false, unavailableReason: "missing" }
      : { text: script, format: "javascript", truncated: false };
  }

  if (run.status === "running") {
    return { text: null, format: "text", truncated: false, unavailableReason: "not-ended" };
  }
  const session = sessionDirectory(run, configDir);
  if (!session || !run.runId || !RUN_ID.test(run.runId)) {
    return { text: null, format: "text", truncated: false, unavailableReason: "missing" };
  }
  const read = await readConfinedFile({
    root: projectsRoot(configDir),
    path: NodePath.join(session, "workflows", `${run.runId}.json`),
    maxBytes: RESULT_MAX_BYTES,
  });
  if ("refused" in read) {
    return {
      text: null,
      format: "text",
      truncated: false,
      unavailableReason:
        read.refused === "missing"
          ? "missing"
          : read.refused === "too-large"
            ? "too-large"
            : "unreadable",
    };
  }
  let saved: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(decoder.decode(read.bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    saved = parsed as Record<string, unknown>;
  } catch {
    return { text: null, format: "text", truncated: false, unavailableReason: "unreadable" };
  }
  const logs = Array.isArray(saved.logs)
    ? saved.logs.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_LOGS)
    : [];
  const result = saved.result ?? (typeof saved.error === "string" ? saved.error : null);
  const format = typeof result === "string" ? "markdown" : "json";
  const full = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  const truncated = full.length > RESULT_TEXT_MAX_CHARS;
  return {
    text: truncated ? full.slice(0, RESULT_TEXT_MAX_CHARS) : full,
    format,
    truncated,
    ...(logs.length > 0 ? { logs } : {}),
  };
}

/**
 * The transcript of one of the run's agents, or undefined when the agent is
 * not the run's or its transcript is not where the run said. Checked the way
 * a read is, before the (cached, incremental) transcript reader opens it.
 */
export async function claudeWorkflowAgentTranscriptPath(input: {
  readonly configDir: string;
  readonly run: RunFiles;
  readonly agentId: string;
}): Promise<string | undefined> {
  const { run } = input;
  if (!AGENT_ID.test(input.agentId)) return undefined;
  if (!run.agents.some((agent) => agent.agentId === input.agentId)) return undefined;
  if (!run.transcriptDir || !within(projectsRoot(input.configDir), run.transcriptDir)) {
    return undefined;
  }
  const candidate = NodePath.join(run.transcriptDir, `agent-${input.agentId}.jsonl`);
  const root = await NodeFs.realpath(projectsRoot(input.configDir)).catch(() => null);
  const real = await NodeFs.realpath(candidate).catch(() => null);
  const info = await NodeFs.lstat(candidate).catch(() => null);
  if (root === null || real === null || info === null) return undefined;
  if (!real.startsWith(root + NodePath.sep) || !info.isFile()) return undefined;
  return candidate;
}

async function isRealDirectory(candidate: string): Promise<boolean | null> {
  const info = await NodeFs.lstat(candidate).catch(() => null);
  if (info === null) return null;
  return info.isDirectory() && !info.isSymbolicLink();
}

async function findRepositoryRoot(cwd: string): Promise<string> {
  let current = NodePath.resolve(cwd);
  for (;;) {
    if ((await NodeFs.lstat(NodePath.join(current, ".git")).catch(() => null)) !== null) {
      return current;
    }
    const parent = NodePath.dirname(current);
    if (parent === current) return NodePath.resolve(cwd);
    current = parent;
  }
}

/**
 * Where a project command goes: the closest `.claude/workflows` folder that
 * already exists between the checkout and the repository root, else the
 * root's. A `.claude` or `workflows` folder that is a link is refused (Claude
 * Code refuses them too), so a save never lands outside the repository.
 */
async function projectCommandDirectory(cwd: string): Promise<string> {
  const root = await findRepositoryRoot(cwd);
  let current = NodePath.resolve(cwd);
  for (;;) {
    const dotClaude = NodePath.join(current, ".claude");
    const workflows = NodePath.join(dotClaude, "workflows");
    const claudeReal = await isRealDirectory(dotClaude);
    const workflowsReal = claudeReal === true ? await isRealDirectory(workflows) : null;
    if (claudeReal === false || workflowsReal === false) {
      throw new ClaudeWorkflowFileError(
        `${workflows} is a link or not a folder, so nothing was saved there.`,
      );
    }
    if (workflowsReal === true) return workflows;
    if (current === root) break;
    const parent = NodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return NodePath.join(root, ".claude", "workflows");
}

/** Saves the run's script as `/<name>`, where `name` is the script's own. */
export async function saveClaudeWorkflowCommand(input: {
  readonly configDir: string;
  readonly run: RunFiles;
  readonly location: WorkflowCommandLocation;
  readonly cwd: string;
  readonly overwrite: boolean;
  readonly dryRun: boolean;
}): Promise<WorkflowSaveCommandResult> {
  if (input.run.hiddenScript) {
    throw new ClaudeWorkflowFileError("Claude keeps this workflow's script to itself.");
  }
  const script = await readScript(input.run, input.configDir);
  if (script === undefined) {
    throw new ClaudeWorkflowFileError("The run's script is no longer where Claude saved it.");
  }
  const name = parseWorkflowScriptMeta(script)?.name;
  if (!name || !COMMAND_NAME.test(name)) {
    throw new ClaudeWorkflowFileError(
      "The script's meta header has no name that can be a command (letters, numbers, - . _).",
    );
  }
  const directory =
    input.location === "project"
      ? await projectCommandDirectory(input.cwd)
      : NodePath.join(input.configDir, "workflows");
  const fileName = `${name}.js`;
  const path = NodePath.join(directory, fileName);
  const existing = await NodeFs.lstat(path).catch(() => null);
  if (input.dryRun) {
    return { name, path, outcome: existing !== null ? "exists" : "would-save" };
  }
  if (input.location === "project") {
    // Created one level at a time so a link swapped in is never followed.
    const dotClaude = NodePath.dirname(directory);
    await NodeFs.mkdir(dotClaude).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EEXIST") throw cause;
    });
    if ((await isRealDirectory(dotClaude)) !== true) {
      throw new ClaudeWorkflowFileError(`${dotClaude} is a link or not a folder.`);
    }
    await NodeFs.mkdir(directory).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EEXIST") throw cause;
    });
    if ((await isRealDirectory(directory)) !== true) {
      throw new ClaudeWorkflowFileError(`${directory} is a link or not a folder.`);
    }
  } else {
    await NodeFs.mkdir(directory, { recursive: true });
  }
  const outcome = await writeConfinedFile({
    directory,
    name: fileName,
    contents: script,
    overwrite: input.overwrite,
  });
  return { name, path, outcome: outcome === "exists" ? "exists" : "saved" };
}

const APPROVAL_SCRIPT_MAX_BYTES = 256 * 1024;

async function readScriptUnder(roots: ReadonlyArray<string>, path: string) {
  for (const root of roots) {
    if (!within(root, path)) continue;
    const read = await readConfinedFile({ root, path, maxBytes: APPROVAL_SCRIPT_MAX_BYTES });
    if ("bytes" in read) return decoder.decode(read.bytes);
  }
  return undefined;
}

/**
 * The script a `Workflow` call asks to run when it names a file or a saved
 * workflow instead of passing the script, so its approval can show the plan.
 * Only files under Claude's own folder or the session's checkout are read;
 * plugin and built-in workflows (whose scripts Claude keeps) come back empty.
 */
export async function resolveClaudeWorkflowApprovalScript(input: {
  readonly configDir: string;
  readonly cwd: string | undefined;
  readonly toolInput: Record<string, unknown>;
}): Promise<string | undefined> {
  const roots = [input.configDir, ...(input.cwd ? [await findRepositoryRoot(input.cwd)] : [])];
  const scriptPath = input.toolInput.scriptPath;
  if (typeof scriptPath === "string" && scriptPath.trim().length > 0) {
    const resolved = NodePath.resolve(input.cwd ?? input.configDir, scriptPath.trim());
    return readScriptUnder(roots, resolved);
  }
  const name = input.toolInput.name;
  if (typeof name !== "string" || !COMMAND_NAME.test(name)) return undefined;
  const candidates: Array<string> = [];
  if (input.cwd) {
    const repositoryRoot = await findRepositoryRoot(input.cwd);
    let current = NodePath.resolve(input.cwd);
    for (;;) {
      candidates.push(NodePath.join(current, ".claude", "workflows", `${name}.js`));
      if (current === repositoryRoot) break;
      const parent = NodePath.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  candidates.push(NodePath.join(input.configDir, "workflows", `${name}.js`));
  for (const candidate of candidates) {
    const script = await readScriptUnder(roots, candidate);
    if (script !== undefined) return script;
  }
  return undefined;
}
