// The 0.6.0 promo story, "Slow checkout" (planned in
// ../storyboard-child-threads.html): checkout got slow this week. Opus 5.5
// asks to start three threads, one per suspect; the user clicks Start; the
// camera peeks into one of them; the answers come back to Opus one by one and
// the last names the cause, which Opus fixes.
//
// Everything an agent does here is a command the real server would have
// produced. That includes the server's own background work for child threads
// (setting each one up, carrying its answer back, sending it to Opus), replayed
// with the command shapes and ids of ChildThreadReactor and ThreadBootstrap.
// The user's clicks come from the take (or are synthesized in a dry run).
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { createEngine } from "./engine.ts";

type Json = Record<string, any>;
type Engine = ReturnType<typeof createEngine>;

export interface ChildThreadsUi {
  /**
   * Called before any event about `threadId` reaches the app, so its commands
   * and detail subscriptions are answered by the engine, never the server.
   */
  registerThread(threadId: string): Promise<void>;
  /** Clicks Start in the request box above the message box. */
  clickStart(): Promise<void>;
  /** Opens the parent's "3 threads" line in the sidebar. */
  openFamily(parentId: string): Promise<void>;
  /** Opens a thread from its row in the sidebar. */
  openThread(threadId: string, kind: "child" | "parent"): Promise<void>;
  mark(name: string): void;
  /** As in story.ts: a message's row, its text (`body`) or its last line (`end`). */
  track(name: string, messageId: string, part?: "row" | "body" | "end"): void;
  /**
   * Records where the last element matching `selector` is on screen, or with
   * `closest`, its nearest ancestor matching that.
   */
  trackSelector(name: string, selector: string, closest?: string): void;
  sleep(ms: number): Promise<void>;
}

const effort = (selectId: string, value: string) => [{ id: selectId, value }];
export const OPUS = {
  instanceId: "claudeAgent",
  model: "claude-opus-5-5",
  options: effort("effort", "high"),
};
export const THREAD_TITLE = "Checkout got slow";
export const STUDIO = "/Users/Shared/Threadlines Marketing Studio/";
const ORBIT = "/Users/Shared/Threadlines Marketing Studio/Orbit";

export const EARLIER_PROMPT = "Add a Buy again button to past orders.";
export const FIRST_PROMPT = "Checkout got slow this week. Find out why.";
export const OPUS_PLAN = "Three suspects. I'll check each one in its own thread.";
export const OPUS_AFTER_PAYMENTS = "Not payments. Waiting on the other two.";
export const OPUS_AFTER_PAGE = "Not the page either.";
export const OPUS_FOUND = "That's it. I'll load the whole cart in one query.";
export const OPUS_DONE = "Checkout takes 0.3 s again, down from 2.4 s.";

export type ChildKey = "payments" | "queries" | "page";
export interface ChildSpec {
  readonly key: ChildKey;
  readonly title: string;
  readonly prompt: string;
  readonly modelSelection: Json;
  /** The model's short name, as the picker and the tool's answer give it. */
  readonly modelName: string;
  /** What its own chat shows while it works. */
  readonly work: string;
  readonly answer: string;
}

export const CHILDREN: ReadonlyArray<ChildSpec> = [
  {
    key: "payments",
    title: "Time the payment service",
    prompt: "Time how long the payment service takes to answer at checkout. Report the number.",
    modelSelection: {
      instanceId: "claudeAgent",
      model: "claude-sonnet-5-5",
      options: effort("effort", "high"),
    },
    modelName: "Sonnet 5.5",
    work: "node scripts/time-payments.mjs",
    answer: "Payments answer in 40 ms. They're not the cause.",
  },
  {
    key: "queries",
    title: "Count the database queries",
    prompt: "Count the queries one checkout runs, and say where they come from.",
    modelSelection: {
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: effort("reasoningEffort", "xhigh"),
    },
    modelName: "GPT-6.1-Sol",
    work: "QUERY_LOG=1 node scripts/checkout-once.mjs",
    answer: "One checkout runs 120 queries: one for each item in the cart.",
  },
  {
    key: "page",
    title: "Measure the page size",
    prompt: "Measure the checkout page's size and compare it with last week's build.",
    modelSelection: {
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: effort("effort", "xhigh"),
    },
    modelName: "Opus 5.5",
    work: "npm run build && du -sh dist/checkout",
    answer: "The page is 180 KB, same as last week.",
  },
];

// The server derives a child's ids from its request (childRequestIds.ts);
// these have the same shapes.
const digest = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex");
const derivedUuid = (...parts: string[]) => {
  const hex = digest(...parts);
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
};
const childCommandId = (requestId: string, step: string) =>
  `server:child-request:${requestId}:${step}`;
export const childBranch = (requestId: string) =>
  `threadlines/${digest("child-worktree", requestId).slice(0, 8)}`;
export const childReportMessageId = (requestId: string) => `child-report:${requestId}`;

export interface ChildIds {
  readonly spec: ChildSpec;
  readonly requestId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly branch: string;
  readonly worktreePath: string;
}

/**
 * Every child's ids, fixed for one take from `seed` (the parent's thread id),
 * so the take can register them and make their worktrees before it starts.
 */
export function childIds(seed: string): ReadonlyArray<ChildIds> {
  return CHILDREN.map((spec) => {
    const requestId = derivedUuid("promo-child-request", seed, spec.key);
    const branch = childBranch(requestId);
    return {
      spec,
      requestId,
      threadId: derivedUuid("promo-child-thread", seed, spec.key),
      messageId: derivedUuid("promo-child-message", seed, spec.key),
      branch,
      worktreePath: `${STUDIO}.worktrees/Orbit/${branch.slice("threadlines/".length)}`,
    };
  });
}

// The worktrees a take made in the studio's Orbit repo, so cleanup removes
// exactly those (a take's children are new each time).
const WORKTREE_LEDGER = "/tmp/rooms-promo/child-worktrees.json";
const PROMO_WORKTREES = `${STUDIO}.worktrees/Orbit/`;
const PROMO_BRANCH = /^threadlines\/[0-9a-f]{8}$/;
const git = (...args: string[]) =>
  execFileSync("git", ["-C", ORBIT, ...args], { encoding: "utf8", stdio: "pipe" });

type LedgerEntry = { path: string; branch: string };
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

/** A promo worktree's folder: directly inside the studio's Orbit worktrees, nowhere else. */
const isPromoWorktreePath = (candidate: string) =>
  path.resolve(candidate) === candidate &&
  path.dirname(candidate) === path.resolve(PROMO_WORKTREES) &&
  /^[0-9a-f]{8}$/.test(path.basename(candidate));

/** Orbit's worktrees as git lists them: folder to branch. */
const registeredWorktrees = (): Map<string, string | null> => {
  const listed = new Map<string, string | null>();
  let current: string | null = null;
  for (const line of git("worktree", "list", "--porcelain").split("\n")) {
    if (line.startsWith("worktree ")) {
      current = line.slice("worktree ".length);
      listed.set(current, null);
    } else if (line.startsWith("branch refs/heads/") && current !== null) {
      listed.set(current, line.slice("branch refs/heads/".length));
    }
  }
  return listed;
};

/**
 * The commit the children branch from: the checkout Opus works in, as the
 * real tool resolves it (threadToolHandlers' resolveWorkspace). A dry run on
 * a machine without the studio gets a placeholder.
 */
export const orbitHead = (): string => {
  try {
    return git("rev-parse", "--verify", "HEAD^{commit}").trim();
  } catch {
    return "0".repeat(40);
  }
};

/**
 * Before a take: a real worktree and branch for each child, made the way the
 * server's bootstrap makes them, so the app's folder checks and branch labels
 * see real ones. Studio data only. Each one is written to the ledger before
 * it is made, so a failure halfway still leaves cleanup knowing about it.
 */
export async function prepareStudio(seed: string) {
  const base = orbitHead();
  const planned = childIds(seed).map((entry) => ({
    path: entry.worktreePath,
    branch: entry.branch,
  }));
  for (const entry of planned) {
    if (!isPromoWorktreePath(entry.path) || !PROMO_BRANCH.test(entry.branch)) {
      throw new Error(`Refusing a worktree outside the studio: ${entry.path} (${entry.branch})`);
    }
  }
  writeLedger([...readLedger(), ...planned]);
  for (const entry of planned) {
    git("worktree", "add", "-b", entry.branch, entry.path, base);
  }
}

/**
 * After a take (and before the next): removes the worktrees the ledger
 * lists. Only a folder git lists as an Orbit worktree on its promo branch is
 * removed. What could not be removed stays in the ledger and fails the cleanup.
 */
export async function cleanupStudio() {
  const entries = readLedger();
  if (entries.length === 0) return;
  const left: LedgerEntry[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    if (!isPromoWorktreePath(entry.path) || !PROMO_BRANCH.test(entry.branch)) {
      throw new Error(`Refusing to remove ${entry.path} (${entry.branch}): not a promo worktree.`);
    }
    try {
      const registered = registeredWorktrees();
      const real = fs.existsSync(entry.path) ? fs.realpathSync(entry.path) : entry.path;
      const branch = registered.get(entry.path) ?? registered.get(real);
      if (branch === entry.branch) {
        git("worktree", "remove", "--force", entry.path);
      } else if (branch !== undefined) {
        throw new Error(`it is on ${branch ?? "no branch"}, not ${entry.branch}`);
      }
      if (git("branch", "--list", entry.branch).trim() !== "") {
        git("branch", "-D", entry.branch);
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

export function createStory(input: { engine: Engine; threadId: string; ui: ChildThreadsUi }) {
  const { engine, threadId, ui } = input;
  const children = childIds(threadId);
  const child = (key: ChildKey) => children.find((entry) => entry.spec.key === key)!;
  // The story's clock. The prologue runs it minutes behind, so the thread's
  // history reads as earlier work; the take runs on real time.
  let clockOffsetMs = 0;
  const iso = () => new Date(Date.now() + clockOffsetMs).toISOString();
  const run = (forThread: string, type: string, fields: Json, commandId = id("promo")) =>
    engine.run({ type, commandId, threadId: forThread, createdAt: iso(), ...fields });

  const providerOf = (selection: Json) => selection.instanceId as "claudeAgent" | "codex";
  const session = (forThread: string, status: string, turnId: string | null, selection: Json) => {
    const provider = providerOf(selection);
    return run(forThread, "thread.session.set", {
      session: {
        threadId: forThread,
        status,
        providerName: provider,
        providerInstanceId: provider,
        providerSessionId: `promo-${provider}-${forThread.slice(0, 8)}`,
        providerThreadId: `promo-${provider}-thread-${forThread.slice(0, 8)}`,
        runtimeMode: "full-access",
        activeTurnId: turnId,
        pendingBackgroundTaskCount: 0,
        lastError: null,
        updatedAt: iso(),
      },
    });
  };

  /** Streams text into one assistant message at roughly `cps` characters a second. */
  const stream = async (forThread: string, messageId: string, text: string, turnId: string) => {
    const cps = 75;
    let at = 0;
    while (at < text.length) {
      const size = 2 + Math.floor(Math.random() * 3);
      const chunk = text.slice(at, at + size);
      at += size;
      await run(forThread, "thread.message.assistant.delta", { messageId, delta: chunk, turnId });
      await ui.sleep((chunk.length / cps) * 1000);
    }
    await run(forThread, "thread.message.assistant.complete", {
      messageId,
      turnId,
      completesTurn: false,
    });
  };

  type Tool =
    | { kind: "read"; path: string }
    // A command; `codex` gives it the shape Codex reports one in.
    | { kind: "run"; command: string; codex?: true }
    | { kind: "edit"; path: string; oldString: string; newString: string }
    | { kind: "thread_start"; input: Json; answer: Json };

  /**
   * One tool call: started, then completed `ms` later, the way ingestion
   * appends them. `during` runs while the call is open (a room tool's own
   * command is decided before the call returns).
   */
  const tool = async (
    forThread: string,
    turnId: string,
    call: Tool,
    options: { ms?: number; root?: string; during?: () => Promise<void> } = {},
  ) => {
    const root = options.root ?? ORBIT;
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
            data: { toolName: "Read", input: { file_path: `${root}/${call.path}` } },
          };
        case "run":
          if (call.codex) {
            // Codex's item lifecycle (CodexAdapter's mapItemLifecycle): the
            // notification itself is the data, the command wrapped in a shell.
            const command = `/bin/zsh -lc ${JSON.stringify(call.command)}`;
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
                  cwd: root,
                  commandActions: [],
                  status,
                  aggregatedOutput: status === "completed" ? "queries: 120\n" : null,
                  exitCode: status === "completed" ? 0 : null,
                },
              },
            };
          }
          return {
            itemType: "command_execution",
            toolCallId,
            status,
            title: "Command run",
            detail: call.command,
            data: { toolName: "Bash", input: { command: call.command } },
          };
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
                file_path: `${root}/${call.path}`,
                old_string: call.oldString,
                new_string: call.newString,
              },
            },
          };
        case "thread_start":
          // Claude's shape for a call to the room MCP server (see the
          // thread_start fixture in apps/web/src/session-logic.test.ts).
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

  /**
   * The server setting up one child after the user's Start (ThreadBootstrap):
   * the thread, its worktree, setup skipped, then its first turn, which
   * answers the request. The child's session starts as its provider would.
   */
  const bootstrap = async (entry: ChildIds, parentTurnId: string) => {
    const { spec } = entry;
    await ui.registerThread(entry.threadId);
    await engine.run({
      type: "thread.create",
      commandId: childCommandId(entry.requestId, "create"),
      threadId: entry.threadId,
      projectId: engine.thread(threadId).projectId,
      title: spec.title,
      modelSelection: spec.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      parentThreadId: threadId,
      parentTurnId,
      attachedToParent: true,
      createdAt: iso(),
    });
    await engine.run({
      type: "thread.meta.update",
      commandId: childCommandId(entry.requestId, "meta"),
      threadId: entry.threadId,
      branch: entry.branch,
      worktreePath: entry.worktreePath,
    });
    await engine.run({
      type: "thread.activity.append",
      commandId: childCommandId(entry.requestId, "setup-script.skipped"),
      threadId: entry.threadId,
      activity: {
        id: derivedUuid("child-setup-activity", entry.requestId, "setup-script.skipped"),
        tone: "info",
        kind: "setup-script.skipped",
        summary: "Setup script skipped",
        payload: { reason: "not-requested" },
        turnId: null,
        createdAt: iso(),
      },
      createdAt: iso(),
    });
    await engine.run({
      type: "thread.turn.start",
      commandId: childCommandId(entry.requestId, "turn"),
      threadId: entry.threadId,
      message: { messageId: entry.messageId, role: "user", text: spec.prompt, attachments: [] },
      modelSelection: spec.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      fromThread: { threadId, requestId: entry.requestId, kind: "request" },
      createdAt: iso(),
    });
    const turnId = id("turn");
    await session(entry.threadId, "running", turnId, spec.modelSelection);
    return turnId;
  };

  /**
   * A child finishes: its answer streams in its own chat and its turn ends.
   * The server carries the answer back to Opus (ChildThreadReactor's settle),
   * and since Opus is idle the queued answer goes out at once
   * (ProviderCommandReactor's processFollowUpQueued), starting Opus's next
   * turn. Those are separate server steps a moment apart; the take applies
   * them as one burst, so the in-between "queued" line is not on screen.
   */
  const finishChild = async (entry: ChildIds, turnId: string) => {
    const answerId = id("assistant");
    await stream(entry.threadId, answerId, entry.spec.answer, turnId);
    const reportId = childReportMessageId(entry.requestId);
    const opusTurn = id("turn");
    await engine.batch(async () => {
      await completeTurn(entry.threadId, turnId, answerId, entry.spec.modelSelection);
      await engine.run({
        type: "thread.child-request.settle",
        commandId: childCommandId(entry.requestId, "settle"),
        threadId,
        requestId: entry.requestId,
        outcome: "answered",
        reply: { messageId: reportId, text: entry.spec.answer, turnId },
        createdAt: iso(),
      });
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
    children,
    /**
     * Before the take: an earlier finished exchange (so the thread fills the
     * screen), then the user's question and Opus's first reads.
     */
    async prologue() {
      clockOffsetMs = -12 * 60_000;
      await run(threadId, "thread.turn.start", {
        message: { messageId: id("message"), role: "user", text: EARLIER_PROMPT, attachments: [] },
        modelSelection: OPUS,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const earlierTurn = id("turn");
      await session(threadId, "running", earlierTurn, OPUS);
      clockOffsetMs += 15_000;
      await tool(
        threadId,
        earlierTurn,
        { kind: "read", path: "src/orders/PastOrders.tsx" },
        { ms: 0 },
      );
      await tool(
        threadId,
        earlierTurn,
        {
          kind: "edit",
          path: "src/orders/PastOrders.tsx",
          oldString: "<OrderTotal order={order} />",
          newString: "<OrderTotal order={order} />\n<BuyAgainButton order={order} />",
        },
        { ms: 0 },
      );
      clockOffsetMs += 50_000;
      await tool(threadId, earlierTurn, { kind: "run", command: "npm test -- orders" }, { ms: 0 });
      clockOffsetMs += 15_000;
      const earlierDone = id("assistant");
      await run(threadId, "thread.message.assistant.delta", {
        messageId: earlierDone,
        turnId: earlierTurn,
        delta: "Past orders now have a Buy again button that refills the cart. Tests pass.",
      });
      await completeTurn(threadId, earlierTurn, earlierDone, OPUS, [
        { path: "src/orders/PastOrders.tsx", kind: "modified", additions: 12, deletions: 1 },
        { path: "src/orders/BuyAgainButton.tsx", kind: "added", additions: 31, deletions: 0 },
      ]);

      clockOffsetMs = -40_000;
      const promptId = id("message");
      await run(threadId, "thread.turn.start", {
        message: { messageId: promptId, role: "user", text: FIRST_PROMPT, attachments: [] },
        modelSelection: OPUS,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const turnId = id("turn");
      await session(threadId, "running", turnId, OPUS);
      clockOffsetMs = -30_000;
      await tool(threadId, turnId, { kind: "read", path: "src/checkout/checkout.ts" }, { ms: 0 });
      await tool(threadId, turnId, { kind: "read", path: "src/cart/load.ts" }, { ms: 0 });
      clockOffsetMs = 0;
      return { turnId, promptId };
    },

    /**
     * The take. Marks name the moments the edit cuts to; the pauses are
     * reading time, so the edit can mostly play at real speed.
     */
    async take(prologue: { turnId: string; promptId: string }) {
      const opusTurn = prologue.turnId;
      ui.track("prompt", prologue.promptId);
      ui.mark("open");

      // 1. Opus names three suspects and asks to start a thread for each.
      await tool(threadId, opusTurn, { kind: "read", path: "src/payments/client.ts" }, { ms: 900 });
      const plan = id("assistant");
      ui.track("opus-plan", plan);
      ui.track("plan-end", plan, "end");
      await stream(threadId, plan, OPUS_PLAN, opusTurn);
      await ui.sleep(900);
      const batchId = randomUUID();
      const baseRef = orbitHead();
      const launches = children.map((entry) => ({
        requestId: entry.requestId,
        childThreadId: entry.threadId,
        childMessageId: entry.messageId,
        launch: {
          title: entry.spec.title,
          prompt: entry.spec.prompt,
          modelSelection: entry.spec.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          reportBack: true,
          runSetup: false,
          workspace: { kind: "worktree", projectCwd: ORBIT, baseRef },
        },
      }));
      await tool(
        threadId,
        opusTurn,
        {
          kind: "thread_start",
          input: {
            threads: children.map((entry) => ({
              title: entry.spec.title,
              prompt: entry.spec.prompt,
              agent: entry.spec.modelSelection,
              runSetup: false,
            })),
          },
          // What thread_start answers in "Ask me first" (threadToolHandlers'
          // startedDetail and the result it builds), word for word.
          answer: {
            outcome: "asked_user",
            detail:
              "The user decides whether to start 3 threads. If they agree, each one's final reply comes back to you as a message; if they say no, you'll hear at your next turn. Don't ask again, and end your turn if you have nothing else to do.",
            threads: children.map((entry) => ({
              threadId: entry.threadId,
              title: entry.spec.title,
              model: entry.spec.modelName,
              workspace: "worktree",
            })),
          },
        },
        {
          ms: 600,
          during: () =>
            engine
              .run({
                type: "thread.child.start",
                commandId: `server:child-request:${batchId}:start`,
                threadId,
                batchId,
                from: { participantId: null },
                callerTurnId: opusTurn,
                mode: "ask",
                children: launches,
                createdAt: iso(),
              })
              .then(() => undefined),
        },
      );
      await engine.batch(() => completeTurn(threadId, opusTurn, plan, OPUS));
      ui.mark("asked");
      ui.trackSelector("request-box", '[data-testid="child-threads-panel"]');
      await ui.sleep(3600);

      ui.mark("start");
      await ui.clickStart();
      ui.mark("started");
      const childTurns = new Map<ChildKey, string>();
      for (const entry of children) {
        childTurns.set(entry.spec.key, await bootstrap(entry, opusTurn));
      }
      ui.trackSelector("started-record", "[data-started-threads]");
      // The family in the sidebar, for the camera: Opus's row, its summary
      // line and each thread's row.
      ui.trackSelector("sidebar", '[data-slot="sidebar"]');
      ui.trackSelector("parent-row", `[data-testid="thread-row-${threadId}"]`);
      ui.trackSelector("family", `[data-testid="thread-family-${threadId}"]`);
      for (const entry of children) {
        ui.trackSelector(
          `child-row-${entry.spec.key}`,
          `[data-testid="child-row-${entry.threadId}"]`,
        );
      }
      await ui.sleep(2200);

      // 2. The family in the sidebar, and a look inside one thread.
      ui.mark("family");
      await ui.openFamily(threadId);
      ui.mark("family-open");
      await ui.sleep(1600);
      const queries = child("queries");
      const payments = child("payments");
      const page = child("page");
      // Work lands in each child while the camera is elsewhere.
      const background = [
        tool(
          payments.threadId,
          childTurns.get("payments")!,
          { kind: "read", path: "src/payments/client.ts" },
          { ms: 400, root: payments.worktreePath },
        ),
        tool(
          page.threadId,
          childTurns.get("page")!,
          { kind: "run", command: page.spec.work },
          { ms: 2600, root: page.worktreePath },
        ),
      ];
      ui.mark("peek");
      await ui.openThread(queries.threadId, "child");
      ui.trackSelector("started-by", '[data-testid="chat-header-started-by"]');
      // The thread's title with that tag beside it.
      ui.trackSelector("child-heading", '[data-testid="chat-header-started-by"]', "div");
      ui.track("child-request", queries.messageId);
      ui.mark("peek-open");
      await ui.sleep(700);
      await tool(
        queries.threadId,
        childTurns.get("queries")!,
        { kind: "run", command: queries.spec.work, codex: true },
        { ms: 2600, root: queries.worktreePath },
      );
      await ui.sleep(600);
      ui.mark("peek-done");
      await Promise.all(background);
      await tool(
        payments.threadId,
        childTurns.get("payments")!,
        { kind: "run", command: payments.spec.work },
        { ms: 300, root: payments.worktreePath },
      );
      await ui.openThread(threadId, "parent");
      ui.mark("back");
      await ui.sleep(600);

      // 3. The answers come back. Each one starts a turn for Opus, which reads
      // it (the pause) and answers.
      /** Opus answers a report in a single short line, ending the turn it started. */
      const opusAnswers = async (turnId: string, line: string, marks: string) => {
        const message = id("assistant");
        ui.track(marks, message);
        ui.mark(marks);
        await stream(threadId, message, line, turnId);
        await engine.batch(() => completeTurn(threadId, turnId, message, OPUS));
      };
      const paymentsReport = await finishChild(payments, childTurns.get("payments")!);
      ui.track("report-payments", paymentsReport.reportId);
      ui.mark("report-payments");
      await ui.sleep(2400);
      await opusAnswers(paymentsReport.opusTurn, OPUS_AFTER_PAYMENTS, "ack-payments");
      await ui.sleep(1500);

      const pageReport = await finishChild(page, childTurns.get("page")!);
      ui.track("report-page", pageReport.reportId);
      ui.mark("report-page");
      await ui.sleep(2400);
      await opusAnswers(pageReport.opusTurn, OPUS_AFTER_PAGE, "ack-page");
      await ui.sleep(1500);

      const queriesReport = await finishChild(queries, childTurns.get("queries")!);
      ui.track("report-queries", queriesReport.reportId);
      ui.track("report-queries-end", queriesReport.reportId, "end");
      ui.mark("report-queries");
      await ui.sleep(4000);

      const found = queriesReport.opusTurn;
      const foundLine = id("assistant");
      ui.track("opus-found", foundLine);
      ui.mark("found");
      await stream(threadId, foundLine, OPUS_FOUND, found);
      await ui.sleep(500);
      await tool(
        threadId,
        found,
        {
          kind: "edit",
          path: "src/cart/load.ts",
          oldString: "return Promise.all(items.map((item) => db.product(item.productId)));",
          newString: "return db.products(items.map((item) => item.productId));",
        },
        { ms: 1000 },
      );
      await tool(threadId, found, { kind: "run", command: "npm test -- checkout" }, { ms: 1100 });
      const done = id("assistant");
      ui.track("opus-done", done);
      ui.track("opus-done-text", done, "body");
      ui.mark("fixed");
      await stream(threadId, done, OPUS_DONE, found);
      await engine.batch(() =>
        completeTurn(threadId, found, done, OPUS, [
          { path: "src/cart/load.ts", kind: "modified", additions: 6, deletions: 9 },
          { path: "tests/cart.test.ts", kind: "modified", additions: 14, deletions: 0 },
        ]),
      );
      ui.mark("opus-done");
      await ui.sleep(3600);
      ui.mark("end");
    },
  };
}
