// The 0.8.0 promo story, "Screenshots on Windows", from a real thread: on the
// Windows PC an agent couldn't take screenshots of its browser page and
// guessed the browser panel had to be open. You ask Opus 5.5, on the MacBook
// Pro. Background screenshots work on the Mac, so it could be a Windows
// problem, which Opus can't test from there: it asks to start a thread on the
// PC; you click Start; the PC's thread runs a small Electron probe there and
// its answer comes back; Opus changes its plan from it.
//
// Two computers: the studio's own server is the MacBook Pro, and a second
// Threadlines server (added to the studio app and linked to it) is the
// Windows PC. Each has its own engine: the Mac's thread is decided by
// `engine`, the PC's by `pcEngine`, and each one's events reach the app under
// its own computer. Everything either server would do is replayed with its
// command shapes and ids: the Mac's RemoteChildReactor (the start going out,
// the PC's statuses, the report settling), the PC's LinkRequests and
// ThreadBootstrap (its thread and worktree), and ProviderCommandReactor
// sending the report to Opus.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { root, type createEngine } from "./engine.ts";

type Json = Record<string, any>;
type Engine = ReturnType<typeof createEngine>;

const load = (relative: string) => import(pathToFileURL(path.join(root, relative)).href);
const { linkThreadId, linkMessageId, linkBootstrapKey } = await load(
  "apps/server/src/links/linkIds.ts",
);
const { childWorktreeBranch, derivedUuid } = await load(
  "apps/server/src/orchestration/childRequestIds.ts",
);
const { normalizeGitRemoteUrl, worktreeFolderNameForBranch } = await load(
  "packages/shared/src/git.ts",
);

export interface FleetUi {
  /** Types `text` into the message box and sends it; resolves with the message the app sent. */
  send(text: string): Promise<{ messageId: string }>;
  /** As in story-child-threads.ts: caught before any event about it reaches the app. */
  registerThread(threadId: string, on: "mac" | "pc"): Promise<void>;
  clickStart(): Promise<void>;
  /** Opens the parent's "1 thread" line in the sidebar. */
  openFamily(parentId: string): Promise<void>;
  /** Opens a thread from its row in the sidebar. */
  openThread(threadId: string, kind: "child" | "parent"): Promise<void>;
  /** Fleet in the left bar, then the map. */
  openFleet(): Promise<void>;
  /** Opens the newest folded message from another thread (it lands folded to one line). */
  unfoldReport(): Promise<void>;
  /** From Fleet back to a thread: its row in Fleet's list. */
  openFromFleet(threadId: string): Promise<void>;
  mark(name: string): void;
  track(name: string, messageId: string, part?: "row" | "body" | "end"): void;
  trackSelector(name: string, selector: string, closest?: string): void;
  sleep(ms: number): Promise<void>;
}

/** The second computer, as the take finds it in the studio app. */
export interface FleetPc {
  readonly environmentId: string;
  /** Its name, as both computers show it. */
  readonly label: string;
  /** The Mac's own name, as the PC's thread shows it ("Started by ... on MacBook Pro"). */
  readonly macLabel: string;
  readonly macEnvironmentId: string;
  /** The Mac's device id on its link to the PC: the child's ids derive from it. */
  readonly linkDeviceId: string;
  readonly projectId: string;
  readonly projectCwd: string;
  /** The PC server's worktrees folder (its THREADLINES_HOME/worktrees). */
  readonly worktreesDir: string;
}

const effort = (selectId: string, value: string) => [{ id: selectId, value }];
export const OPUS = {
  instanceId: "claudeAgent",
  model: "claude-opus-5-5",
  options: effort("effort", "xhigh"),
};
/** The PC's own Codex, as the Mac names it (its instance id there). */
export const SOL = {
  instanceId: "codex",
  model: "gpt-6.1-sol",
  options: effort("reasoningEffort", "medium"),
};
/**
 * The PC's link caps what the Mac's agents start there at "Up to Auto" (its
 * default), and the start is narrowed to it (clampLaunchToCeiling).
 */
export const PC_RUNTIME_MODE = "auto";
export const THREAD_TITLE = "Enable Background Browser Screenshots";
export const PROJECT_NAME = "Threadlines";
export const STUDIO = "/Users/Shared/Threadlines Marketing Studio/";
const MAC_PROJECT = `${STUDIO}threadlines`;
const REMOTE_URL = "git@github.com:Threadlines/threadlines.git";

export const FIRST_PROMPT =
  "On my Windows PC, an agent couldn't take browser screenshots. It said the panel wasn't on screen. Do agents need the browser panel open?";
export const OPUS_MAC_TEST = "Testing background screenshots on this Mac first.";
// Tentative on purpose: the PC's thread is what finds out.
export const OPUS_PLAN =
  "Not on this Mac: screenshots work with the window covered, minimized or hidden. So it could be a Windows problem, and I can't test Windows from here. I'll run the probe on your Windows PC.";
export const CHILD_TITLE = "Windows probe: background browser screenshots";
export const CHILD_PROMPT =
  "Run the screenshot probe in a new temp folder with Electron 43.8.1. Capture a hidden webview page with the window covered, minimized and closed to the tray, then again with background throttling off. Report each result.";
export const SOL_WORKING =
  "Installing Electron 43.8.1 in a temp folder, then running the probe in each window state.";
export const SOL_ANSWER =
  "It is Windows. Covered and minimized work, but closed to the tray, Windows stops drawing the page and the screenshot hangs. With background throttling off, it works in 26 ms.";
export const OPUS_CHANGE =
  "The Windows results are back, and they change the plan. Windows stops drawing a window closed to the tray, so I'll keep a page drawing while an agent works in it.";
export const OPUS_DONE =
  "Done. Agents can screenshot their pages on Windows, even with the app closed to the tray.";

/** The child's ids, the way the Mac's thread_start and the PC's link setup derive them. */
export function childIds(seed: string, pc: Pick<FleetPc, "linkDeviceId" | "worktreesDir">) {
  const requestId = derivedUuid("promo-fleet-request", seed);
  const bootstrapKey = linkBootstrapKey(pc.linkDeviceId, requestId);
  const branch = childWorktreeBranch(bootstrapKey);
  return {
    requestId,
    batchId: derivedUuid("promo-fleet-batch", seed),
    threadId: linkThreadId(pc.linkDeviceId, requestId) as string,
    messageId: linkMessageId(pc.linkDeviceId, requestId) as string,
    bootstrapKey,
    branch: branch as string,
    worktreePath: path.join(pc.worktreesDir, "threadlines", worktreeFolderNameForBranch(branch)),
  };
}

// The PC's worktree for the take's child, made the way its bootstrap would,
// and removed after. Only folders inside the PC server's worktrees folder.
const WORKTREE_LEDGER = "/tmp/rooms-promo/fleet-worktrees.json";
type LedgerEntry = { repo: string; path: string; branch: string };
const readLedger = (): LedgerEntry[] =>
  fs.existsSync(WORKTREE_LEDGER) ? JSON.parse(fs.readFileSync(WORKTREE_LEDGER, "utf8")) : [];
const writeLedger = (entries: ReadonlyArray<LedgerEntry>) => {
  if (entries.length === 0) {
    fs.rmSync(WORKTREE_LEDGER, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(WORKTREE_LEDGER), { recursive: true });
  fs.writeFileSync(WORKTREE_LEDGER, JSON.stringify(entries, null, 2));
};
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" });
const isPromoBranch = (branch: string) => /^threadlines\/[0-9a-f]{16}$/.test(branch);
/** A promo worktree's folder: `<worktrees>/threadlines/<16 hex>` and nothing else. */
const isPromoWorktreePath = (candidate: string) =>
  path.resolve(candidate) === candidate &&
  /^[0-9a-f]{16}$/.test(path.basename(candidate)) &&
  path.basename(path.dirname(candidate)) === "threadlines" &&
  path.basename(path.dirname(path.dirname(candidate))) === "worktrees";
/** The repo's worktrees as git lists them: folder to branch. */
const registeredWorktrees = (repo: string): Map<string, string | null> => {
  const listed = new Map<string, string | null>();
  let current: string | null = null;
  for (const line of git(repo, "worktree", "list", "--porcelain").split("\n")) {
    if (line.startsWith("worktree ")) {
      current = line.slice("worktree ".length);
      listed.set(current, null);
    } else if (line.startsWith("branch refs/heads/") && current !== null) {
      listed.set(current, line.slice("branch refs/heads/".length));
    }
  }
  return listed;
};

export async function prepareStudio(seed: string, pc?: FleetPc) {
  if (pc === undefined) return;
  const ids = childIds(seed, pc);
  if (
    !isPromoBranch(ids.branch) ||
    !isPromoWorktreePath(ids.worktreePath) ||
    !ids.worktreePath.startsWith(`${pc.worktreesDir}/`)
  ) {
    throw new Error(`Refusing a worktree outside the PC's: ${ids.worktreePath}`);
  }
  writeLedger([
    ...readLedger(),
    { repo: pc.projectCwd, path: ids.worktreePath, branch: ids.branch },
  ]);
  fs.mkdirSync(path.dirname(ids.worktreePath), { recursive: true });
  const base = git(pc.projectCwd, "rev-parse", "--verify", "HEAD^{commit}").trim();
  git(pc.projectCwd, "worktree", "add", "-b", ids.branch, ids.worktreePath, base);
}

/**
 * After a take (and before the next): removes the worktrees the ledger lists.
 * Only a folder git lists as a worktree of its repo on its promo branch is
 * removed; anything else stays in the ledger and fails the cleanup.
 */
export async function cleanupStudio() {
  const left: LedgerEntry[] = [];
  const problems: string[] = [];
  for (const entry of readLedger()) {
    if (!isPromoBranch(entry.branch) || !isPromoWorktreePath(entry.path)) {
      throw new Error(`Refusing to remove ${entry.path} (${entry.branch}): not a promo worktree.`);
    }
    try {
      const registered = registeredWorktrees(entry.repo);
      const real = fs.existsSync(entry.path) ? fs.realpathSync(entry.path) : entry.path;
      const branch = registered.get(entry.path) ?? registered.get(real);
      if (branch === entry.branch) {
        git(entry.repo, "worktree", "remove", "--force", entry.path);
      } else if (branch !== undefined) {
        throw new Error(`it is on ${branch ?? "no branch"}, not ${entry.branch}`);
      }
      if (git(entry.repo, "branch", "--list", entry.branch).trim() !== "") {
        git(entry.repo, "branch", "-D", entry.branch);
      }
      if (fs.existsSync(entry.path)) throw new Error("its folder is still there");
    } catch (error) {
      left.push(entry);
      problems.push(`${entry.path}: ${String((error as Error).message ?? error)}`);
    }
  }
  writeLedger(left);
  if (problems.length > 0) {
    throw new Error(`Could not remove promo worktrees:\n${problems.join("\n")}`);
  }
}

const id = (prefix: string) => `${prefix}:${randomUUID()}`;

export function createStory(input: {
  engine: Engine;
  pcEngine: Engine;
  threadId: string;
  pc: FleetPc;
  ui: FleetUi;
}) {
  const { engine, pcEngine, threadId, pc, ui } = input;
  const child = childIds(threadId, pc);
  const engineFor = (forThread: string) => (forThread === child.threadId ? pcEngine : engine);
  // The story's clock: the prologue runs minutes behind, the take on real time.
  let clockOffsetMs = 0;
  const iso = () => new Date(Date.now() + clockOffsetMs).toISOString();
  const run = (forThread: string, type: string, fields: Json, commandId = id("promo")) =>
    engineFor(forThread).run({ type, commandId, threadId: forThread, createdAt: iso(), ...fields });

  const session = (forThread: string, status: string, turnId: string | null, selection: Json) => {
    const provider = selection.instanceId as "claudeAgent" | "codex";
    return run(forThread, "thread.session.set", {
      session: {
        threadId: forThread,
        status,
        providerName: provider,
        providerInstanceId: provider,
        providerSessionId: `promo-${provider}-${forThread.slice(0, 8)}`,
        providerThreadId: `promo-${provider}-thread-${forThread.slice(0, 8)}`,
        runtimeMode: forThread === child.threadId ? PC_RUNTIME_MODE : "full-access",
        activeTurnId: turnId,
        pendingBackgroundTaskCount: 0,
        lastError: null,
        updatedAt: iso(),
      },
    });
  };

  /** Streams text into one assistant message at roughly 75 characters a second. */
  const stream = async (forThread: string, messageId: string, text: string, turnId: string) => {
    let at = 0;
    while (at < text.length) {
      const size = 2 + Math.floor(Math.random() * 3);
      const chunk = text.slice(at, at + size);
      at += size;
      await run(forThread, "thread.message.assistant.delta", { messageId, delta: chunk, turnId });
      await ui.sleep((chunk.length / 75) * 1000);
    }
    await run(forThread, "thread.message.assistant.complete", {
      messageId,
      turnId,
      completesTurn: false,
    });
  };

  type Tool =
    | { kind: "read"; path: string }
    | { kind: "run"; command: string; output?: string }
    // A command on the PC, in the shape Codex on Windows reports one.
    | { kind: "pc-run"; command: string; output: string }
    | { kind: "edit"; path: string; oldString: string; newString: string }
    | { kind: "thread_start"; input: Json; answer: Json };

  /** One tool call: started, then completed `ms` later. `during` runs while it is open. */
  const tool = async (
    forThread: string,
    turnId: string,
    call: Tool,
    options: { ms?: number; during?: () => Promise<void> } = {},
  ) => {
    const toolCallId = id("toolu");
    const payload = (status: string): Json => {
      switch (call.kind) {
        case "read":
          return {
            itemType: "dynamic_tool_call",
            toolCallId,
            status,
            title: "Read file",
            detail: call.path,
            data: {
              toolName: "Read",
              input: {
                file_path: call.path.startsWith("/") ? call.path : `${MAC_PROJECT}/${call.path}`,
              },
            },
          };
        case "run":
          return {
            itemType: "command_execution",
            toolCallId,
            status,
            title: "Command run",
            detail: call.command,
            data: { toolName: "Bash", input: { command: call.command } },
          };
        case "pc-run": {
          // Codex's item lifecycle (CodexAdapter's mapItemLifecycle) on
          // Windows: the command wrapped in PowerShell.
          const command = `powershell.exe -Command ${JSON.stringify(call.command)}`;
          return {
            itemType: "command_execution",
            status,
            title: "Ran command",
            detail: command,
            data: {
              threadId: `promo-codex-thread-${forThread.slice(0, 8)}`,
              turnId,
              item: {
                type: "commandExecution",
                id: toolCallId,
                command,
                cwd: `C:\\Users\\dev\\.threadlines\\worktrees\\threadlines\\${child.branch.slice("threadlines/".length)}`,
                commandActions: [],
                status,
                aggregatedOutput: status === "completed" ? call.output : null,
                exitCode: status === "completed" ? 0 : null,
              },
            },
          };
        }
        case "edit":
          return {
            itemType: "file_change",
            toolCallId,
            status,
            title: "File change",
            detail: call.path,
            data: {
              toolName: "Edit",
              input: {
                file_path: `${MAC_PROJECT}/${call.path}`,
                old_string: call.oldString,
                new_string: call.newString,
              },
            },
          };
        case "thread_start":
          return {
            itemType: "mcp_tool_call",
            toolCallId,
            status,
            title: "MCP tool call",
            detail: "threadlines_room · thread_start",
            data: {
              toolName: "mcp__threadlines_room__thread_start",
              input: call.input,
              ...(status === "completed"
                ? {
                    result: {
                      type: "tool_result",
                      tool_use_id: toolCallId,
                      content: [{ type: "text", text: JSON.stringify(call.answer) }],
                    },
                  }
                : {}),
            },
          };
      }
    };
    const append = (kind: string, status: string, summary: string) =>
      run(forThread, "thread.activity.append", {
        activity: {
          id: id("activity"),
          tone: "tool",
          kind,
          summary,
          payload: payload(status),
          turnId,
          createdAt: iso(),
        },
      });
    const title = payload("inProgress").title as string;
    await append("tool.started", "inProgress", `${title} started`);
    await options.during?.();
    await ui.sleep(options.ms ?? 700);
    await append("tool.completed", "completed", title);
  };

  const checkpointCounts = new Map<string, number>();
  /** Ends a turn the way ingestion does: final words, checkpoint, session ready. */
  const completeTurn = async (
    forThread: string,
    turnId: string,
    lastMessageId: string,
    selection: Json,
    files: ReadonlyArray<Json> = [],
  ) => {
    await run(forThread, "thread.message.assistant.complete", {
      messageId: lastMessageId,
      turnId,
      completesTurn: true,
    });
    const count = (checkpointCounts.get(forThread) ?? 0) + 1;
    checkpointCounts.set(forThread, count);
    await run(forThread, "thread.turn.diff.complete", {
      turnId,
      completedAt: iso(),
      checkpointRef: `refs/threadlines/promo/${forThread.slice(0, 8)}/${count}`,
      status: "ready",
      files,
      assistantMessageId: lastMessageId,
      checkpointTurnCount: count,
      completesTurn: true,
    });
    await session(forThread, "ready", null, selection);
  };

  const remote = (status: string, threadId: string | null) => ({
    environmentId: pc.environmentId,
    label: pc.label,
    threadId,
    status,
  });
  /** The Mac's record of the child (RemoteChildReactor's childRecord). */
  const childRecord = (cachedStatus: string) => ({
    environmentId: pc.environmentId,
    label: pc.label,
    threadId: child.threadId,
    handle: "Agent",
    title: CHILD_TITLE,
    attachmentEpoch: 0,
    cachedStatus,
    updatedAt: iso(),
  });

  /**
   * After Start. The Mac sends the start (peer.request.start); the PC's link
   * allows the Mac's agents, so it sets the thread up at once
   * (LinkRequests' start, then ThreadBootstrap.startChild with a remote
   * lineage: one thread.start that makes the thread in its worktree and
   * starts its first turn) and answers "started"; the Mac records it.
   */
  const startOnPc = async () => {
    await ui.registerThread(child.threadId, "pc");
    const at = iso();
    await pcEngine.run({
      type: "thread.start",
      commandId: `server:child-request:${child.bootstrapKey}:turn`,
      threadId: child.threadId,
      create: {
        projectId: pc.projectId,
        title: CHILD_TITLE,
        modelSelection: SOL,
        runtimeMode: PC_RUNTIME_MODE,
        interactionMode: "default",
        branch: child.branch,
        worktreePath: child.worktreePath,
        remoteOrigin: {
          linkDeviceId: pc.linkDeviceId,
          environmentId: pc.macEnvironmentId,
          environmentPinned: true,
          environmentLabel: pc.macLabel,
          threadId,
          threadTitle: THREAD_TITLE,
        },
        createdAt: at,
      },
      first: {
        type: "thread.turn.start",
        commandId: `server:child-request:${child.bootstrapKey}:turn`,
        threadId: child.threadId,
        message: { messageId: child.messageId, role: "user", text: CHILD_PROMPT, attachments: [] },
        modelSelection: SOL,
        runtimeMode: PC_RUNTIME_MODE,
        interactionMode: "default",
        fromThread: {
          threadId,
          requestId: child.requestId,
          kind: "request",
          environmentId: pc.macEnvironmentId,
        },
        createdAt: at,
      },
    });
    const turnId = id("turn");
    await session(child.threadId, "running", turnId, SOL);
    await engine.batch(async () => {
      await run(
        threadId,
        "thread.child-request.update",
        {
          requestId: child.requestId,
          status: "queued",
          remote: remote("accepted", child.threadId),
        },
        `server:child-request:${child.requestId}:remote:queued:accepted:${child.threadId}`,
      );
      await run(
        threadId,
        "thread.remote-child.update",
        { child: childRecord("working") },
        `server:remote-child:${pc.environmentId}:${child.threadId}:${child.requestId}:working`,
      );
    });
    // The PC's watch: its turn is running.
    await run(
      threadId,
      "thread.child-request.update",
      { requestId: child.requestId, status: "running", remote: remote("accepted", child.threadId) },
      `server:child-request:${child.requestId}:remote:running:accepted:${child.threadId}`,
    );
    return turnId;
  };

  /**
   * The PC's thread finishes; its report comes back over the link and settles
   * the Mac's request (RemoteChildReactor's report case), and since Opus is
   * idle the queued report goes out at once (ProviderCommandReactor). One
   * burst, as the app sees it.
   */
  const reportBack = async (pcTurn: string) => {
    const answerId = id("assistant");
    await stream(child.threadId, answerId, SOL_ANSWER, pcTurn);
    await completeTurn(child.threadId, pcTurn, answerId, SOL);
    const reportId = `child-report:${child.requestId}`;
    const opusTurn = id("turn");
    await engine.batch(async () => {
      await run(
        threadId,
        "thread.child-request.settle",
        {
          requestId: child.requestId,
          outcome: "answered",
          reply: { messageId: reportId, text: SOL_ANSWER, turnId: pcTurn },
          remoteChild: childRecord("idle"),
        },
        `server:child-request:${child.requestId}:settle`,
      );
      await run(
        threadId,
        "thread.follow-up.send-queued",
        { messageId: reportId },
        `server:follow-up-send-queued:${reportId}`,
      );
      await session(threadId, "running", opusTurn, OPUS);
    });
    return { reportId, opusTurn };
  };

  return {
    child,
    /** Before the take: the user's question and Opus's work on the Mac so far. */
    /** Before the take: nothing. The thread is empty until you ask. */
    async prologue() {
      return {};
    },

    async take() {
      ui.mark("open");
      // 1. You ask; Opus tests on the Mac, then asks to start a thread on the PC.
      const sent = await ui.send(FIRST_PROMPT);
      ui.track("prompt", sent.messageId);
      const opusTurn = id("turn");
      await session(threadId, "running", opusTurn, OPUS);
      await ui.sleep(900);
      await tool(
        threadId,
        opusTurn,
        { kind: "read", path: "apps/desktop/src/preview/PreviewAutomation.ts" },
        { ms: 500 },
      );
      await tool(
        threadId,
        opusTurn,
        { kind: "read", path: "apps/web/src/components/browser/browserLifecycle.ts" },
        { ms: 500 },
      );
      const macTest = id("assistant");
      ui.track("mac-test", macTest);
      await stream(threadId, macTest, OPUS_MAC_TEST, opusTurn);
      ui.mark("mac-test");
      await tool(
        threadId,
        opusTurn,
        { kind: "run", command: "node /tmp/shotprobe/run.mjs" },
        { ms: 1600 },
      );
      await tool(
        threadId,
        opusTurn,
        { kind: "read", path: "/tmp/shotprobe/results.ndjson" },
        { ms: 900 },
      );
      const plan = id("assistant");
      ui.track("opus-plan", plan);
      ui.track("plan-end", plan, "end");
      await stream(threadId, plan, OPUS_PLAN, opusTurn);
      await ui.sleep(700);
      const projectKey = normalizeGitRemoteUrl(REMOTE_URL);
      const launch = {
        title: CHILD_TITLE,
        prompt: CHILD_PROMPT,
        modelSelection: SOL,
        runtimeMode: "full-access",
        interactionMode: "default",
        reportBack: true,
        runSetup: false,
        workspace: { kind: "remote", projectKey, projectSubdirectory: "", checkout: "worktree" },
        target: { environmentId: pc.environmentId, label: pc.label },
      };
      await tool(
        threadId,
        opusTurn,
        {
          kind: "thread_start",
          input: {
            computer: pc.label,
            threads: [{ title: CHILD_TITLE, agent: SOL, runSetup: false, prompt: CHILD_PROMPT }],
          },
          // remoteStart's "Ask me first" answer (threadToolHandlers.ts), word
          // for word: no "asks its user" sentence, the PC allows the Mac.
          answer: {
            outcome: "asked_user",
            detail: `The user decides whether to start 1 thread. If they agree, its final reply comes back to you as a message; if they say no, you'll hear at your next turn. Don't ask again, and end your turn if you have nothing else to do. On ${pc.label} it starts from its default branch: your unpushed changes are not there.`,
            threads: [
              {
                threadId: child.threadId,
                title: CHILD_TITLE,
                model: SOL.model,
                workspace: "remote",
                computer: pc.label,
              },
            ],
          },
        },
        {
          ms: 600,
          during: () =>
            engine
              .run({
                type: "thread.child.start",
                commandId: `server:child-request:${child.batchId}:start`,
                threadId,
                batchId: child.batchId,
                from: { participantId: null },
                callerTurnId: opusTurn,
                mode: "ask",
                children: [
                  {
                    requestId: child.requestId,
                    childThreadId: child.threadId,
                    childMessageId: child.messageId,
                    launch,
                  },
                ],
                createdAt: iso(),
              })
              .then(() => undefined),
        },
      );
      await engine.batch(() => completeTurn(threadId, opusTurn, plan, OPUS));
      ui.mark("asked");
      ui.trackSelector("request-box", '[data-testid="child-threads-panel"]');
      await ui.sleep(3200);

      ui.mark("start");
      await ui.clickStart();
      ui.mark("started");
      // The start goes out over the link ("Sending to Windows PC") and the
      // PC answers once its thread is set up.
      await ui.sleep(700);
      const pcTurn = await startOnPc();
      ui.trackSelector("sidebar", '[data-slot="sidebar"]');
      ui.trackSelector("parent-row", `[data-testid="thread-row-${threadId}"]`);
      ui.trackSelector("family", `[data-testid="thread-family-${threadId}"]`);
      ui.trackSelector("child-row", `[data-testid="child-row-${child.threadId}"]`);
      await ui.sleep(2600);

      // 2. It runs on the PC: its row under Opus's, a look inside, then Fleet.
      ui.mark("family");
      await ui.openFamily(threadId);
      ui.mark("family-open");
      await ui.sleep(1800);
      ui.mark("peek");
      await ui.openThread(child.threadId, "child");
      ui.trackSelector("started-by", '[data-testid="chat-header-started-by"]');
      ui.trackSelector("child-heading", '[data-testid="chat-header-started-by"]', "div");
      ui.track("child-request", child.messageId);
      ui.mark("peek-open");
      const working = id("assistant");
      await stream(child.threadId, working, SOL_WORKING, pcTurn);
      await tool(
        child.threadId,
        pcTurn,
        {
          kind: "pc-run",
          command: "npm install --prefix $env:TEMP\\shotprobe electron@43.8.1",
          output: "added 72 packages in 9s\n",
        },
        { ms: 1500 },
      );
      await tool(
        child.threadId,
        pcTurn,
        {
          kind: "pc-run",
          command: "npx electron $env:TEMP\\shotprobe\\probe.js",
          output:
            '{"label":"covered","cdp":"ok 28ms"}\n{"label":"minimized","cdp":"ok 2937ms"}\n{"label":"tray","cdp":"TIMEOUT 4011ms"}\n{"label":"tray","throttling":"off","cdp":"ok 26ms"}\n',
        },
        { ms: 2200 },
      );
      ui.mark("peek-done");
      await ui.sleep(400);
      await ui.openFleet();
      ui.trackSelector("fleet", '[data-testid="fleet-view"]');
      ui.mark("fleet");
      await ui.sleep(3000);
      ui.mark("fleet-done");
      await ui.openFromFleet(threadId);
      ui.mark("back");
      await ui.sleep(700);

      // 3. The answer comes back, and Opus changes its plan.
      const report = await reportBack(pcTurn);
      ui.track("report", report.reportId);
      ui.track("report-end", report.reportId, "end");
      ui.mark("report");
      await ui.sleep(1400);
      await ui.unfoldReport();
      ui.mark("report-open");
      await ui.sleep(3200);
      const change = id("assistant");
      ui.track("opus-change", change);
      ui.track("change-end", change, "end");
      ui.mark("change");
      await stream(threadId, change, OPUS_CHANGE, report.opusTurn);
      await ui.sleep(500);
      await tool(
        threadId,
        report.opusTurn,
        {
          kind: "edit",
          path: "apps/desktop/src/preview/PreviewAutomation.ts",
          oldString: "guest.setBackgroundThrottling(true);",
          newString:
            "// Windows stops drawing a hidden window: keep an agent's page drawing.\nguest.setBackgroundThrottling(!working);",
        },
        { ms: 1000 },
      );
      await tool(
        threadId,
        report.opusTurn,
        { kind: "run", command: "vp run --cache '@threadlines/desktop#test' preview" },
        { ms: 1100 },
      );
      const done = id("assistant");
      ui.track("opus-done", done);
      ui.track("opus-done-text", done, "body");
      ui.mark("fixed");
      await stream(threadId, done, OPUS_DONE, report.opusTurn);
      await engine.batch(() =>
        completeTurn(threadId, report.opusTurn, done, OPUS, [
          {
            path: "apps/desktop/src/preview/PreviewAutomation.ts",
            kind: "modified",
            additions: 18,
            deletions: 3,
          },
          {
            path: "apps/web/src/components/browser/browserLifecycle.ts",
            kind: "modified",
            additions: 41,
            deletions: 6,
          },
        ]),
      );
      ui.mark("opus-done");
      await ui.sleep(3600);
      ui.mark("end");
    },
  };
}
