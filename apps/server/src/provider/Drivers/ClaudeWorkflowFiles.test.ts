// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  ClaudeWorkflowFileError,
  readClaudeWorkflowRunFile,
  saveClaudeWorkflowCommand,
} from "./ClaudeWorkflowFiles.ts";

type RunFiles = Parameters<typeof readClaudeWorkflowRunFile>[0]["run"];

const RUN_ID = "wf_abc123";
const SCRIPT = [
  "export const meta = {",
  '  name: "provider-research",',
  '  description: "Research a provider",',
  '  phases: [{ title: "Research" }],',
  "};",
  "export default async function run() {}",
  "",
].join("\n");

let tmp: string;
let configDir: string;
let session: string;
let run: RunFiles;

beforeEach(() => {
  // Real path, so paths the code builds compare equal on macOS (/var -> /private/var).
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-claude-workflow-files-")));
  configDir = path.join(tmp, "claude");
  session = path.join(configDir, "projects", "-repo", "session-1");
  const scriptPath = path.join(session, "workflows", "scripts", `provider-research-${RUN_ID}.js`);
  const transcriptDir = path.join(session, "subagents", "workflows", RUN_ID);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(scriptPath, SCRIPT);
  run = {
    runId: RUN_ID,
    transcriptDir,
    scriptPath,
    status: "completed",
    hiddenScript: false,
    agents: [],
  };
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const resultPath = () => path.join(session, "workflows", `${RUN_ID}.json`);

describe("readClaudeWorkflowRunFile", () => {
  it("reads the run's script unless Claude withholds it", async () => {
    expect(await readClaudeWorkflowRunFile({ configDir, run, file: "script" })).toEqual({
      text: SCRIPT,
      format: "javascript",
      truncated: false,
    });
    expect(
      await readClaudeWorkflowRunFile({
        configDir,
        run: { ...run, hiddenScript: true },
        file: "script",
      }),
    ).toEqual({ text: null, format: "javascript", truncated: false, unavailableReason: "hidden" });
    // A script path outside Claude's projects folder is never read.
    const elsewhere = path.join(tmp, "elsewhere.js");
    fs.writeFileSync(elsewhere, SCRIPT);
    expect(
      (
        await readClaudeWorkflowRunFile({
          configDir,
          run: { ...run, scriptPath: elsewhere },
          file: "script",
        })
      ).unavailableReason,
    ).toBe("missing");
  });

  it("reads the result once the run ended, within its size limit", async () => {
    fs.writeFileSync(
      resultPath(),
      JSON.stringify({ result: "## Findings\n\nThree gaps.", logs: ["phase 1 done", 7, "end"] }),
    );
    expect(
      await readClaudeWorkflowRunFile({
        configDir,
        run: { ...run, status: "running" },
        file: "result",
      }),
    ).toEqual({ text: null, format: "text", truncated: false, unavailableReason: "not-ended" });
    expect(await readClaudeWorkflowRunFile({ configDir, run, file: "result" })).toEqual({
      text: "## Findings\n\nThree gaps.",
      format: "markdown",
      truncated: false,
      logs: ["phase 1 done", "end"],
    });

    // Past the 16 MiB limit (sparse, so the test writes nothing that big).
    fs.truncateSync(resultPath(), 16 * 1024 * 1024 + 1);
    expect(
      (await readClaudeWorkflowRunFile({ configDir, run, file: "result" })).unavailableReason,
    ).toBe("too-large");

    fs.rmSync(resultPath());
    expect(
      (await readClaudeWorkflowRunFile({ configDir, run, file: "result" })).unavailableReason,
    ).toBe("missing");
  });

  it("says a stopped run has no result, with its error's message and not its stack", async () => {
    // As CLI 2.1.296 saved a run stopped mid-way.
    fs.writeFileSync(
      resultPath(),
      JSON.stringify({
        result: null,
        status: "killed",
        logs: [],
        error: "Error: Workflow aborted\n    at y (/$bunfs/root/chunk-mhnsvpzs.js:95:5511)",
      }),
    );
    expect(
      await readClaudeWorkflowRunFile({
        configDir,
        run: { ...run, status: "stopped" },
        file: "result",
      }),
    ).toEqual({
      text: null,
      format: "text",
      truncated: false,
      unavailableReason: "no-result",
      error: "Workflow aborted",
    });
  });
});

describe("saveClaudeWorkflowCommand", () => {
  let repo: string;
  beforeEach(() => {
    repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  });

  const save = (input: {
    readonly location: "project" | "personal";
    readonly cwd?: string;
    readonly overwrite?: boolean;
    readonly dryRun?: boolean;
  }) =>
    saveClaudeWorkflowCommand({
      configDir,
      run,
      location: input.location,
      cwd: input.cwd ?? repo,
      overwrite: input.overwrite ?? false,
      dryRun: input.dryRun ?? false,
    });

  it("saves a project command in the closest workflows folder, else the repository root's", async () => {
    const app = path.join(repo, "packages", "app");
    fs.mkdirSync(path.join(app, "src"), { recursive: true });
    fs.mkdirSync(path.join(app, ".claude", "workflows"), { recursive: true });
    fs.mkdirSync(path.join(repo, "packages", "lib", ".claude"), { recursive: true });

    const nested = await save({ location: "project", cwd: path.join(app, "src") });
    expect(nested).toEqual({
      name: "provider-research",
      path: path.join(app, ".claude", "workflows", "provider-research.js"),
      outcome: "saved",
    });
    expect(fs.readFileSync(nested.path, "utf8")).toBe(SCRIPT);

    // A `.claude` folder without `workflows` does not count; the root's is made.
    const root = await save({ location: "project", cwd: path.join(repo, "packages", "lib") });
    expect(root).toEqual({
      name: "provider-research",
      path: path.join(repo, ".claude", "workflows", "provider-research.js"),
      outcome: "saved",
    });
    expect(fs.readFileSync(root.path, "utf8")).toBe(SCRIPT);
  });

  it("refuses a project workflows folder that is a link", async () => {
    const elsewhere = path.join(tmp, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.join(repo, ".claude"));
    fs.symlinkSync(elsewhere, path.join(repo, ".claude", "workflows"));

    await expect(save({ location: "project" })).rejects.toBeInstanceOf(ClaudeWorkflowFileError);
    await expect(save({ location: "project", dryRun: true })).rejects.toBeInstanceOf(
      ClaudeWorkflowFileError,
    );
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("saves a personal command; a dry run writes nothing and an existing one needs overwrite", async () => {
    const target = path.join(configDir, "workflows", "provider-research.js");

    expect(await save({ location: "personal", dryRun: true })).toEqual({
      name: "provider-research",
      path: target,
      outcome: "would-save",
    });
    expect(fs.existsSync(path.dirname(target))).toBe(false);

    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, "// an older command\n");
    expect((await save({ location: "personal", dryRun: true })).outcome).toBe("exists");
    expect((await save({ location: "personal" })).outcome).toBe("exists");
    expect(fs.readFileSync(target, "utf8")).toBe("// an older command\n");

    expect(await save({ location: "personal", overwrite: true })).toEqual({
      name: "provider-research",
      path: target,
      outcome: "saved",
    });
    expect(fs.readFileSync(target, "utf8")).toBe(SCRIPT);
  });

  it("refuses to save a script Claude withholds", async () => {
    run = { ...run, hiddenScript: true };
    await expect(save({ location: "personal" })).rejects.toBeInstanceOf(ClaudeWorkflowFileError);
    expect(fs.existsSync(path.join(configDir, "workflows"))).toBe(false);
  });
});
