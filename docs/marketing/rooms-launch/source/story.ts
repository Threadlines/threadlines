// The Rooms promo story, "Charged twice": some customers are charged twice at
// checkout. Opus 5.5 can't reproduce it; the user adds GPT-6.1-Sol and asks
// the two to work together; Opus asks Sol, Sol names the cause, Opus
// proves and fixes it; then the user asks Sol directly to check the fix.
// Everything an agent does here is a command the real server would have
// produced; the user's clicks and typing come from the take (or are
// synthesized in a dry run).
import { randomUUID } from "node:crypto";
import type { createEngine } from "./engine.ts";

type Json = Record<string, any>;
type Engine = ReturnType<typeof createEngine>;

export interface StoryUi {
  /** Opens the model picker and adds GPT-6.1-Sol. Resolves with its participant id. */
  addSol(): Promise<string>;
  /**
   * Points the message box at an agent the way a user does (typing "@" and
   * its name, then picking it), types `text` and sends it. Marks
   * `<marks>-mention`, `-recipient`, `-typing` and `-sent`. Resolves with the
   * sent message's id.
   */
  sendTo(agent: "opus" | "sol", text: string, marks: string): Promise<string>;
  mark(name: string): void;
  /**
   * Starts recording where a message is on screen, as `name`: its whole row
   * (with the agent's name when it opens a turn), with `"body"` just its text,
   * or with `"end"` the last line of its text (where the edit pins a label).
   */
  track(name: string, messageId: string, part?: "row" | "body" | "end"): void;
  sleep(ms: number): Promise<void>;
}

export const OPUS = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
export const THREAD_TITLE = "Double charges at checkout";
export const EARLIER_PROMPT =
  "Make the pay button ignore extra clicks while a payment is in progress.";
export const FIRST_PROMPT = "Some customers get charged twice at checkout. Find out why.";
export const OPUS_REPORT =
  "Double clicks are blocked and the checkout tests pass. I can't reproduce it yet.";
export const TEAM_UP = "I added Sol. Work together to find the cause.";
/**
 * Sol's reasoning. An added agent starts on its model's default (Low for
 * GPT-6.1-Sol); the take raises it right after the add with the command the
 * message box's reasoning control sends.
 */
export const SOL_OPTIONS = [{ id: "reasoningEffort", value: "high" }];
export const OPUS_QUESTION = "Checkout tests pass. What could still cause two charges?";
export const SOL_ANSWER = "The payment succeeds, but its reply times out. The retry charges again.";
export const OPUS_REPRO =
  "Reproduced it: two charges. I'll make retries reuse the original payment.";
export const OPUS_DONE = "The lost-reply test passes. One payment, one charge.";
export const CHECK = "Check the fix. Does it cover a lost reply?";
export const SOL_CHECK =
  "Yes. The test loses the first reply, and the retry still makes one charge.";

const id = (prefix: string) => `${prefix}:${randomUUID()}`;
const ORBIT = "/Users/Shared/Threadlines Marketing Studio/Orbit";

export function createStory(input: { engine: Engine; threadId: string; ui: StoryUi }) {
  const { engine, threadId, ui } = input;
  // The story's clock. The prologue runs it minutes behind, so the thread's
  // history reads as earlier work; the take runs on real time.
  let clockOffsetMs = 0;
  const iso = (offsetMs = 0) => new Date(Date.now() + clockOffsetMs + offsetMs).toISOString();
  const command = (type: string, fields: Json) =>
    engine.run({ type, commandId: id("promo"), threadId, createdAt: iso(), ...fields });

  const session = (fields: {
    status: string;
    turnId: string | null;
    participantId?: string | null;
    provider?: "claudeAgent" | "codex";
  }) => {
    const provider = fields.provider ?? "claudeAgent";
    return command("thread.session.set", {
      session: {
        threadId,
        status: fields.status,
        providerName: provider,
        providerInstanceId: provider,
        providerSessionId: `promo-${provider}`,
        providerThreadId: `promo-${provider}-thread`,
        runtimeMode: "full-access",
        activeTurnId: fields.turnId,
        ...(fields.participantId !== undefined ? { participantId: fields.participantId } : {}),
        pendingBackgroundTaskCount: 0,
        lastError: null,
        updatedAt: iso(),
      },
    });
  };

  /** Streams text into one assistant message at roughly `cps` characters a second. */
  const stream = async (
    messageId: string,
    text: string,
    fields: Json,
    options: { cps?: number; complete?: boolean } = {},
  ) => {
    const cps = options.cps ?? 75;
    let at = 0;
    while (at < text.length) {
      // Small, steady chunks: a line fills in smoothly instead of in bursts.
      const size = 2 + Math.floor(Math.random() * 3);
      const chunk = text.slice(at, at + size);
      at += size;
      await command("thread.message.assistant.delta", { messageId, delta: chunk, ...fields });
      await ui.sleep((chunk.length / cps) * 1000);
    }
    if (options.complete !== false) {
      await command("thread.message.assistant.complete", {
        messageId,
        completesTurn: false,
        ...fields,
      });
    }
  };

  type Tool =
    | { kind: "read"; path: string }
    | { kind: "run"; command: string }
    | { kind: "edit"; path: string; oldString: string; newString: string };

  /**
   * One tool call: started, then completed `ms` later. An added agent's
   * steps name it, as ingestion does.
   */
  const tool = async (turnId: string, call: Tool, ms = 700, participantId?: string) => {
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
            data: { toolName: "Read", input: { file_path: `${ORBIT}/${call.path}` } },
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
                file_path: `${ORBIT}/${call.path}`,
                old_string: call.oldString,
                new_string: call.newString,
              },
            },
          };
      }
    };
    const append = (kind: string, status: string, summary: string) =>
      command("thread.activity.append", {
        activity: {
          id: id("activity"),
          tone: "tool",
          kind,
          summary,
          payload: payload(status),
          turnId,
          ...(participantId !== undefined ? { participantId } : {}),
          createdAt: iso(),
        },
      });
    const title = payload("inProgress").title as string;
    await append("tool.started", "inProgress", `${title} started`);
    await ui.sleep(ms);
    await append("tool.completed", "completed", title);
  };

  let checkpointTurnCount = 0;
  /** Ends a turn the way ingestion does: final words, checkpoint, session ready. */
  const completeTurn = async (
    turnId: string,
    lastMessageId: string,
    files: ReadonlyArray<Json>,
    holder: { participantId?: string | null; provider?: "claudeAgent" | "codex" } = {},
  ) => {
    await command("thread.message.assistant.complete", {
      messageId: lastMessageId,
      turnId,
      completesTurn: true,
    });
    checkpointTurnCount += 1;
    await command("thread.turn.diff.complete", {
      turnId,
      completedAt: iso(),
      checkpointRef: `refs/threadlines/promo/${checkpointTurnCount}`,
      status: "ready",
      files,
      assistantMessageId: lastMessageId,
      checkpointTurnCount,
      completesTurn: true,
    });
    await session({ status: "ready", turnId: null, ...holder });
  };

  return {
    /**
     * Before the take: an earlier finished exchange (so the thread fills the
     * screen), then the user's report of the bug and Opus's first look.
     */
    async prologue() {
      clockOffsetMs = -9 * 60_000;
      await engine.run({
        type: "thread.turn.start",
        commandId: id("promo"),
        threadId,
        message: { messageId: id("message"), role: "user", text: EARLIER_PROMPT, attachments: [] },
        modelSelection: OPUS,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: iso(),
      });
      const earlierTurn = id("turn");
      await session({ status: "running", turnId: earlierTurn, participantId: null });
      const plan = id("assistant");
      await command("thread.message.assistant.delta", {
        messageId: plan,
        turnId: earlierTurn,
        delta: "I'll disable the button while the payment request is open.",
      });
      await command("thread.message.assistant.complete", {
        messageId: plan,
        turnId: earlierTurn,
        completesTurn: false,
      });
      clockOffsetMs += 20_000;
      await tool(earlierTurn, { kind: "read", path: "src/checkout/PayButton.tsx" }, 0);
      await tool(
        earlierTurn,
        {
          kind: "edit",
          path: "src/checkout/PayButton.tsx",
          oldString: "<Button onClick={pay}>Pay</Button>",
          newString: "<Button onClick={pay} disabled={paying}>Pay</Button>",
        },
        0,
      );
      clockOffsetMs += 60_000;
      await tool(earlierTurn, { kind: "run", command: "npm test -- checkout" }, 0);
      clockOffsetMs += 20_000;
      const earlierDone = id("assistant");
      await command("thread.message.assistant.delta", {
        messageId: earlierDone,
        turnId: earlierTurn,
        delta:
          "The pay button now shows a spinner and ignores clicks until the payment finishes. Tests pass.",
      });
      await completeTurn(earlierTurn, earlierDone, [
        { path: "src/checkout/PayButton.tsx", kind: "modified", additions: 14, deletions: 3 },
        { path: "tests/checkout.test.ts", kind: "modified", additions: 22, deletions: 0 },
      ]);

      clockOffsetMs = -70_000;
      const promptId = id("message");
      await engine.run({
        type: "thread.turn.start",
        commandId: id("promo"),
        threadId,
        message: { messageId: promptId, role: "user", text: FIRST_PROMPT, attachments: [] },
        modelSelection: OPUS,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: iso(),
      });
      const turnId = id("turn");
      await session({ status: "running", turnId, participantId: null });
      // No opening line: the report is the only thing Opus says before
      // Sol joins, so the setup reads at a glance.
      clockOffsetMs = -50_000;
      await tool(turnId, { kind: "read", path: "src/checkout/PayButton.tsx" }, 0);
      await tool(turnId, { kind: "read", path: "src/checkout/checkout.ts" }, 0);
      await tool(turnId, { kind: "read", path: "src/payments/client.ts" }, 0);
      clockOffsetMs = 0;
      return { turnId, promptId };
    },

    /**
     * The take. Marks name the moments the edit cuts to; the pauses are
     * reading time, so the edit can mostly play at real speed.
     */
    async take(prologue: { turnId: string; promptId: string }) {
      const firstTurn = prologue.turnId;
      ui.track("prompt", prologue.promptId);
      ui.mark("open");
      await tool(firstTurn, { kind: "run", command: "npm test -- checkout" }, 1500);
      const report = id("assistant");
      ui.track("opus-report", report);
      ui.track("report-end", report, "end");
      await stream(report, OPUS_REPORT, { turnId: firstTurn });
      await engine.batch(() => completeTurn(firstTurn, report, []));
      ui.mark("reported");
      await ui.sleep(3200);

      // 1. Add Sol, point the message box back at Opus, and ask the two of
      // them to work together. Opus's turn has ended, so this starts a new one.
      ui.mark("add");
      const solId = await ui.addSol();
      await ui.sleep(500);
      const teamId = await ui.sendTo("opus", TEAM_UP, "team");
      ui.track("team-msg", teamId);
      const turn = id("turn");
      await session({ status: "running", turnId: turn, participantId: null });
      await ui.sleep(900);
      await tool(turn, { kind: "read", path: "src/payments/client.ts" }, 900);

      // 2. Opus asks Sol an open question, the way room_ask does, and keeps
      // reading while Sol answers on the side.
      ui.mark("ask");
      const sideTurnId = randomUUID();
      const askId = id("request");
      ui.track("opus-ask", askId);
      ui.track("ask-end", askId, "end");
      await command("thread.agent-request.submit", {
        requestId: randomUUID(),
        kind: "ask",
        from: { participantId: null },
        to: { participantId: solId },
        callerTurnId: turn,
        chainEpoch: engine.thread(threadId).agentRequests.chainEpoch,
        message: { messageId: askId, text: OPUS_QUESTION },
        sideTurnId,
      });
      ui.mark("asked");
      const answerId = `side-answer:${sideTurnId}`;
      ui.track("sol-answer", answerId);
      ui.track("answer-end", answerId, "end");
      await ui.sleep(1500);
      await command("thread.side-turn.mark-running", { sideTurnId });
      await tool(turn, { kind: "read", path: "src/payments/retry.ts" }, 1300);
      await stream(answerId, SOL_ANSWER, { participantId: solId, sideTurnId }, { cps: 120 });
      await command("thread.side-turn.settle", {
        sideTurnId,
        outcome: "completed",
        answerMessageId: answerId,
      });
      ui.mark("answer-published");
      await ui.sleep(4400);

      // Opus proves the cause by simulating a lost reply, then fixes it. (A
      // script, not a failing test: the turn's summary counts failed tests.)
      ui.mark("repro");
      await tool(turn, { kind: "run", command: "node scripts/simulate-lost-reply.mjs" }, 1300);
      const repro = id("assistant");
      ui.track("opus-repro", repro);
      ui.track("repro-end", repro, "end");
      await stream(repro, OPUS_REPRO, { turnId: turn });
      await ui.sleep(600);
      await tool(
        turn,
        {
          kind: "edit",
          path: "src/payments/client.ts",
          oldString: "  return retry(() => bank.charge(order));",
          newString: [
            "  const paymentId = order.paymentId ?? newPaymentId();",
            "  return retry(() => bank.charge(order, { paymentId }));",
          ].join("\n"),
        },
        1200,
      );
      await tool(turn, { kind: "run", command: "npm test -- checkout lost-reply" }, 1300);
      ui.mark("fixed");
      const done = id("assistant");
      ui.track("opus-done", done);
      ui.track("opus-done-text", done, "body");
      await stream(done, OPUS_DONE, { turnId: turn });
      await engine.batch(() =>
        completeTurn(turn, done, [
          { path: "src/payments/client.ts", kind: "modified", additions: 9, deletions: 2 },
          { path: "tests/checkout.test.ts", kind: "modified", additions: 18, deletions: 0 },
        ]),
      );
      ui.mark("opus-done");
      await ui.sleep(3400);

      // 3. The user asks Sol directly. Nobody is working, so this is
      // Sol's own turn; it only reads.
      ui.mark("check");
      const checkId = await ui.sendTo("sol", CHECK, "check");
      ui.track("check-msg", checkId);
      const solTurn = id("turn");
      await session({
        status: "running",
        turnId: solTurn,
        participantId: solId,
        provider: "codex",
      });
      await ui.sleep(700);
      await tool(solTurn, { kind: "read", path: "src/payments/client.ts" }, 800, solId);
      await tool(solTurn, { kind: "read", path: "tests/checkout.test.ts" }, 900, solId);
      const reply = id("assistant");
      ui.track("sol-reply", reply);
      ui.track("sol-reply-text", reply, "body");
      ui.track("reply-end", reply, "end");
      await stream(reply, SOL_CHECK, { turnId: solTurn, participantId: solId });
      await engine.batch(() =>
        completeTurn(solTurn, reply, [], { participantId: solId, provider: "codex" }),
      );
      ui.mark("sol-done");
      await ui.sleep(4400);
      ui.mark("end");
    },
  };
}
