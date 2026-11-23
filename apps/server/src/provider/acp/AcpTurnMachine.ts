/**
 * AcpTurnMachine — the life of a turn for an agent whose turns outlive their
 * prompt (`AcpProviderDescriptor.turnMachine`: Antigravity), as one pure
 * reducer.
 *
 * Such an agent answers its prompt while work it started goes on (a command
 * it awaits, a timer, a subagent) and replies by itself when that work ends;
 * a message sent mid-turn goes as another prompt that steers the turn; Stop
 * must end the turn whatever it is doing. Every source of change (a send, a
 * steer, a prompt's answer, the agent's output, Stop, a timer, the process
 * exiting, the session stopping) is an event, and `step` alone decides what
 * the turn is and what the adapter does next. It reads no clock and does no
 * I/O: the adapter runs it in one place, in order with the agent's updates
 * (on the session's event reader), and carries out the commands.
 *
 * Timers are a function of the state (`desiredTimers`), re-derived after
 * every step, so a state that needs a deadline always has one armed. Quiet
 * timers ("after so long without a word from the agent") restart on the
 * agent's activity in the adapter; the machine only arms, disarms and hears
 * them fire.
 *
 * @module provider/acp/AcpTurnMachine
 */

/** Work the agent goes on with after its prompt answers. A timer holds the turn with no limit. */
export type AcpWorkKind = "command" | "timer";

export type AcpTurnTimer =
  /** Stop was asked for: past it the agent is recycled and the turn ends cancelled. */
  | "cancelDeadline"
  /** A held turn with nothing left to wait for ends after a short quiet. */
  | "settle"
  /**
   * A reply the agent started by itself whose closing update never comes,
   * or a wake a finished command owes that never comes, ends after a quiet.
   */
  | "replyQuiet"
  /** A turn held only by commands and subagents ends after a long silence. */
  | "silent"
  /** A cancel's notice that hasn't come by now never will: it is no longer dropped. */
  | "noticeExpiry";

export const ACP_TURN_TIMERS: ReadonlyArray<AcpTurnTimer> = [
  "cancelDeadline",
  "settle",
  "replyQuiet",
  "silent",
  "noticeExpiry",
];

/** How a prompt's answer reads, once the adapter has checked it. `answer` is the adapter's own. */
export interface AcpPromptOutcomeRead<Answer> {
  readonly state: "completed" | "failed" | "cancelled";
  readonly answer: Answer;
  /** The agent can't continue the session: it stops, and the next message starts fresh. */
  readonly sessionLost: boolean;
}

/** Why a turn ended. */
export type AcpTurnEnd<Answer> =
  /** Its last prompt's answer, as read (completed, failed or cancelled). */
  | { readonly kind: "answered"; readonly outcome: AcpPromptOutcomeRead<Answer> }
  /** A turn the agent started by itself, done. */
  | { readonly kind: "agentDone" }
  /** Stopped: with no prompt left to answer, or when the cancel deadline passed. */
  | { readonly kind: "stopped" }
  /** The agent process exited. */
  | { readonly kind: "exited" }
  /** The session stopped under it. */
  | { readonly kind: "aborted" };

export interface AcpMachineTurn<Answer> {
  readonly id: string;
  /** Every prompt the turn sent, oldest first. */
  readonly prompts: ReadonlyArray<number>;
  /** The prompt that carries the turn; none for a turn the agent started that took no steer. */
  readonly newest: number | undefined;
  readonly phase:
    | { readonly tag: "prompting" }
    | { readonly tag: "settling" }
    | { readonly tag: "waiting"; readonly end: AcpTurnEnd<Answer> };
  readonly stopRequested: boolean;
}

export interface AcpTurnMachineState<Answer> {
  /** The session is over (stopped, exited, recycled): nothing more starts. */
  readonly ended: boolean;
  readonly turn: AcpMachineTurn<Answer> | undefined;
  readonly nextPrompt: number;
  /** Prompts sent and not answered yet, of any turn. */
  readonly unanswered: ReadonlyArray<number>;
  /** Prompts whose fiber hasn't reported sending them yet. */
  readonly undispatched: ReadonlyArray<number>;
  /** Sends waiting for the running turn to end, oldest first. */
  readonly queue: ReadonlyArray<{ readonly sendId: string; readonly turnId: string }>;
  /** Work running past its prompt, by tool call id. */
  readonly running: ReadonlyArray<readonly [id: string, kind: AcpWorkKind]>;
  /** Subagent launches already counted, by tool call id. */
  readonly launches: ReadonlyArray<string>;
  /** Subagents launched and not yet heard back from (protocol counting). */
  readonly subagents: number;
  /** Every subagent the session's launches started. */
  readonly launchedTotal: number;
  /**
   * The children still at work by the agent's own records, and how many
   * children those records knew of, once a reading covered every launch:
   * then the hold follows the records, not the protocol count.
   */
  readonly children: { readonly running: number; readonly known: number } | undefined;
  /** A reply the agent started by itself has output and no closing update yet. */
  readonly replyOpen: boolean;
  /** Commands and timers that ended outside a prompt: each wakes the agent to reply once. */
  readonly wakesOwed: number;
  /** Approvals and questions waiting on the user: no quiet limit runs meanwhile. */
  readonly requestsOpen: number;
  /** Cancels whose notice the agent hasn't sent yet: that many notices are dropped. */
  readonly noticesExpected: number;
  readonly timers: ReadonlyArray<readonly [timer: AcpTurnTimer, generation: number]>;
  readonly timerGeneration: number;
}

export type AcpTurnEvent<Answer> =
  /** The user sent a message: a turn of its own, after the running one. */
  | { readonly type: "send"; readonly sendId: string; readonly turnId: string }
  /** The user sent a message into the running turn. */
  | { readonly type: "steer"; readonly steerId: string; readonly expectedTurnId: string }
  /** A prompt's fiber is sending it now. */
  | { readonly type: "promptDispatched"; readonly prompt: number }
  /** A prompt answered or failed. Placed after every update it produced. */
  | { readonly type: "promptAnswered"; readonly prompt: number }
  /** The adapter read how a prompt really ended (`readOutcome`). */
  | {
      readonly type: "outcomeRead";
      readonly prompt: number;
      readonly outcome: AcpPromptOutcomeRead<Answer>;
    }
  | { readonly type: "workStarted"; readonly id: string; readonly kind: AcpWorkKind }
  | { readonly type: "workEnded"; readonly id: string }
  /** A tool call taken for work turns out to be something else (an MCP call): it holds nothing. */
  | { readonly type: "workDropped"; readonly id: string }
  | { readonly type: "subagentsLaunched"; readonly id: string; readonly count: number }
  /**
   * The agent's own records say `running` children are still at work, of
   * `known` children they know of (`readChildren`).
   */
  | { readonly type: "childrenAtWork"; readonly running: number; readonly known: number }
  /** The agent sent something. `newTurnId` names the turn it opens if none runs. */
  | { readonly type: "agentOutput"; readonly newTurnId: string }
  /** The `usage_update` that closes each model call. */
  | { readonly type: "replyEnded" }
  /** The agent asked the user something (an approval, a question). */
  | { readonly type: "requestOpened"; readonly newTurnId: string }
  | { readonly type: "requestClosed" }
  /** The agent's cancellation notice arrived. */
  | { readonly type: "cancellationNotice"; readonly newTurnId: string }
  | { readonly type: "stopRequested" }
  | { readonly type: "timerFired"; readonly timer: AcpTurnTimer; readonly generation: number }
  | { readonly type: "processExited" }
  | { readonly type: "sessionStopping" };

export type AcpTurnCommand<Answer> =
  /** Open the turn: a user's (`sendId`) or the agent's own. */
  | { readonly type: "startTurn"; readonly turnId: string; readonly sendId?: string }
  | {
      readonly type: "sendPrompt";
      readonly prompt: number;
      readonly turnId: string;
      readonly source: { readonly sendId: string } | { readonly steerId: string };
    }
  | { readonly type: "acceptSend"; readonly sendId: string; readonly turnId: string }
  | { readonly type: "rejectSend"; readonly sendId: string }
  | { readonly type: "acceptSteer"; readonly steerId: string; readonly turnId: string }
  | {
      readonly type: "rejectSteer";
      readonly steerId: string;
      readonly reason: "no-active-turn" | "turn-finishing";
    }
  /** Read how the prompt really ended, then report `outcomeRead`. */
  | { readonly type: "readOutcome"; readonly prompt: number }
  /** An older prompt answered after this one went out: its outcome reads only from here on. */
  | { readonly type: "rebaseOutcome"; readonly prompt: number }
  /** Read which children are still at work, then report `childrenAtWork` (if the records say). */
  | { readonly type: "readChildren" }
  | { readonly type: "recordUsage"; readonly prompt: number }
  | { readonly type: "sendCancel" }
  /** The turn's one terminal event. */
  | { readonly type: "endTurn"; readonly turnId: string; readonly end: AcpTurnEnd<Answer> }
  | { readonly type: "armTimer"; readonly timer: AcpTurnTimer; readonly generation: number }
  | { readonly type: "disarmTimer"; readonly timer: AcpTurnTimer }
  /** The cancel deadline passed: stop the agent process. */
  | { readonly type: "recycleAgent" }
  | { readonly type: "stopSession"; readonly reason: "exited" | "sessionLost" }
  | { readonly type: "markSessionLost" }
  /** The notice just seen is the one a cancel owed: show nothing. */
  | { readonly type: "dropNotice" };

export interface AcpTurnStep<Answer> {
  readonly state: AcpTurnMachineState<Answer>;
  readonly commands: ReadonlyArray<AcpTurnCommand<Answer>>;
}

export function initialTurnMachineState<Answer>(): AcpTurnMachineState<Answer> {
  return {
    ended: false,
    turn: undefined,
    nextPrompt: 1,
    unanswered: [],
    undispatched: [],
    queue: [],
    running: [],
    launches: [],
    subagents: 0,
    launchedTotal: 0,
    children: undefined,
    replyOpen: false,
    wakesOwed: 0,
    requestsOpen: 0,
    noticesExpected: 0,
    timers: [],
    timerGeneration: 0,
  };
}

/**
 * Subagents still out: by the agent's own records when a reading covered
 * every launch (plus any launched since), else the protocol count.
 */
export function subagentsOut(state: AcpTurnMachineState<unknown>): number {
  const children = state.children;
  if (children === undefined) return state.subagents;
  return children.running + Math.max(0, state.launchedTotal - children.known);
}

/** Something the agent still owes the turn: work, a subagent, a wake, an open reply. */
export function workPending(state: AcpTurnMachineState<unknown>): boolean {
  return (
    state.running.length > 0 || subagentsOut(state) > 0 || state.replyOpen || state.wakesOwed > 0
  );
}

/** The timers a state needs armed. */
export function desiredTimers(state: AcpTurnMachineState<unknown>): ReadonlyArray<AcpTurnTimer> {
  if (state.ended) return [];
  const timers: Array<AcpTurnTimer> = [];
  if (state.noticesExpected > 0) timers.push("noticeExpiry");
  const turn = state.turn;
  if (turn === undefined) return timers;
  if (turn.stopRequested) timers.push("cancelDeadline");
  const quietAllowed = state.requestsOpen === 0 && !turn.stopRequested;
  // A reply under way, or one a finished command owes, that never ends.
  if (quietAllowed && turn.phase.tag !== "prompting" && (state.replyOpen || state.wakesOwed > 0)) {
    timers.push("replyQuiet");
  }
  if (quietAllowed && turn.phase.tag === "waiting") {
    if (!workPending(state)) timers.push("settle");
    else if (
      !state.replyOpen &&
      state.wakesOwed === 0 &&
      !state.running.some(([, kind]) => kind === "timer")
    ) {
      timers.push("silent");
    }
  }
  return timers;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Applies one event: the next state and what the adapter does, in order. */
export function stepTurnMachine<Answer>(
  previous: AcpTurnMachineState<Answer>,
  event: AcpTurnEvent<Answer>,
): AcpTurnStep<Answer> {
  const state: Mutable<AcpTurnMachineState<Answer>> = { ...previous };
  const commands: Array<AcpTurnCommand<Answer>> = [];

  const clearWork = () => {
    state.running = [];
    state.subagents = 0;
    // Back to counting by protocol until the records are read again.
    state.children = undefined;
    state.replyOpen = false;
    state.wakesOwed = 0;
  };

  const startPromptTurn = (send: { readonly sendId: string; readonly turnId: string }) => {
    const prompt = state.nextPrompt;
    state.nextPrompt += 1;
    state.turn = {
      id: send.turnId,
      prompts: [prompt],
      newest: prompt,
      phase: { tag: "prompting" },
      stopRequested: false,
    };
    state.unanswered = [...state.unanswered, prompt];
    state.undispatched = [...state.undispatched, prompt];
    state.replyOpen = false;
    state.wakesOwed = 0;
    commands.push(
      { type: "startTurn", turnId: send.turnId, sendId: send.sendId },
      { type: "sendPrompt", prompt, turnId: send.turnId, source: { sendId: send.sendId } },
      { type: "acceptSend", sendId: send.sendId, turnId: send.turnId },
    );
  };

  /**
   * The next queued send starts once no turn runs. A turn ends only once
   * its newest prompt has answered (or the session ends), so the new prompt
   * never lands inside another turn's; an older prompt a steer replaced is
   * the agent's to answer and holds nothing up.
   */
  const startQueued = () => {
    if (state.ended || state.turn !== undefined) return;
    const [next, ...rest] = state.queue;
    if (next === undefined) return;
    state.queue = rest;
    startPromptTurn(next);
  };

  const rejectQueue = () => {
    for (const send of state.queue) commands.push({ type: "rejectSend", sendId: send.sendId });
    state.queue = [];
  };

  const endTurn = (end: AcpTurnEnd<Answer>) => {
    const turn = state.turn;
    if (turn === undefined) return;
    commands.push({ type: "endTurn", turnId: turn.id, end });
    state.turn = undefined;
    state.replyOpen = false;
    state.wakesOwed = 0;
    startQueued();
  };

  /** Called before the turn's end, so the end starts no queued send. */
  const endSession = () => {
    state.ended = true;
    clearWork();
    rejectQueue();
  };

  /** Output outside a prompt opens a reply; with no turn, a turn of the agent's own. */
  const agentSpoke = (newTurnId: string) => {
    if (state.ended) return;
    const turn = state.turn;
    if (turn === undefined) {
      state.turn = {
        id: newTurnId,
        prompts: [],
        newest: undefined,
        phase: { tag: "waiting", end: { kind: "agentDone" } },
        stopRequested: false,
      };
      state.replyOpen = true;
      commands.push({ type: "startTurn", turnId: newTurnId });
      return;
    }
    if (turn.phase.tag !== "prompting") state.replyOpen = true;
  };

  /**
   * A reply the agent started by itself is over: it answered a wake, else a
   * subagent's report. With subagents out, the records are read again: they
   * say exactly which are done (several reports in one reply, a kill).
   */
  const endReply = () => {
    state.replyOpen = false;
    if (state.wakesOwed > 0) state.wakesOwed -= 1;
    else if (state.subagents > 0) state.subagents -= 1;
    readChildren();
  };

  /** Asks for the records' count of children at work, when any were launched. */
  const readChildren = () => {
    if (!state.ended && state.launchedTotal > 0 && subagentsOut(state) > 0) {
      commands.push({ type: "readChildren" });
    }
  };

  /** A held turn whose work is all done and quiet, or that went silent, ends. */
  const endWaiting = () => {
    const turn = state.turn;
    if (turn?.phase.tag === "waiting") endTurn(turn.phase.end);
  };

  switch (event.type) {
    case "send": {
      if (state.ended) {
        commands.push({ type: "rejectSend", sendId: event.sendId });
        break;
      }
      state.queue = [...state.queue, { sendId: event.sendId, turnId: event.turnId }];
      // A message sent while a turn waits on the agent's work, or runs as
      // the agent's own, ends that turn; the agent takes the message after it.
      if (state.turn?.phase.tag === "waiting") endWaiting();
      else startQueued();
      break;
    }
    case "steer": {
      const turn = state.turn;
      if (state.ended || turn === undefined || turn.id !== event.expectedTurnId) {
        commands.push({ type: "rejectSteer", steerId: event.steerId, reason: "no-active-turn" });
        break;
      }
      if (turn.stopRequested) {
        commands.push({ type: "rejectSteer", steerId: event.steerId, reason: "turn-finishing" });
        break;
      }
      const prompt = state.nextPrompt;
      state.nextPrompt += 1;
      state.turn = {
        ...turn,
        prompts: [...turn.prompts, prompt],
        newest: prompt,
        phase: { tag: "prompting" },
      };
      state.unanswered = [...state.unanswered, prompt];
      state.undispatched = [...state.undispatched, prompt];
      // What the agent did by itself is over: this prompt carries the turn on.
      state.replyOpen = false;
      state.wakesOwed = 0;
      commands.push(
        { type: "sendPrompt", prompt, turnId: turn.id, source: { steerId: event.steerId } },
        { type: "acceptSteer", steerId: event.steerId, turnId: turn.id },
      );
      break;
    }
    case "promptDispatched": {
      if (!state.undispatched.includes(event.prompt)) break;
      state.undispatched = state.undispatched.filter((prompt) => prompt !== event.prompt);
      // A cancel sent before this prompt went out may have reached the agent first.
      const turn = state.turn;
      if (turn?.stopRequested === true && turn.prompts.includes(event.prompt)) {
        commands.push({ type: "sendCancel" });
      }
      break;
    }
    case "promptAnswered": {
      if (!state.unanswered.includes(event.prompt)) break;
      state.unanswered = state.unanswered.filter((prompt) => prompt !== event.prompt);
      state.undispatched = state.undispatched.filter((prompt) => prompt !== event.prompt);
      commands.push({ type: "recordUsage", prompt: event.prompt });
      const turn = state.turn;
      if (turn !== undefined && !state.ended) {
        if (turn.newest === event.prompt && turn.phase.tag === "prompting") {
          state.turn = { ...turn, phase: { tag: "settling" } };
          commands.push({ type: "readOutcome", prompt: event.prompt });
          readChildren();
        } else if (
          turn.prompts.includes(event.prompt) &&
          turn.newest !== undefined &&
          state.unanswered.includes(turn.newest)
        ) {
          // What the older prompt left in the agent's records is its own.
          commands.push({ type: "rebaseOutcome", prompt: turn.newest });
        }
      }
      break;
    }
    case "outcomeRead": {
      const turn = state.turn;
      if (
        turn === undefined ||
        state.ended ||
        turn.newest !== event.prompt ||
        turn.phase.tag !== "settling"
      ) {
        break;
      }
      const end: AcpTurnEnd<Answer> = { kind: "answered", outcome: event.outcome };
      if (event.outcome.sessionLost) {
        endSession();
        endTurn(end);
        commands.push({ type: "markSessionLost" }, { type: "stopSession", reason: "sessionLost" });
        break;
      }
      if (turn.stopRequested) {
        clearWork();
        endTurn(end);
        break;
      }
      if (event.outcome.state === "completed" && workPending(state)) {
        state.turn = { ...turn, phase: { tag: "waiting", end } };
        break;
      }
      if (event.outcome.state !== "completed") clearWork();
      endTurn(end);
      break;
    }
    case "workStarted": {
      state.running = [
        ...state.running.filter(([id]) => id !== event.id),
        [event.id, event.kind] as const,
      ];
      break;
    }
    case "workEnded": {
      if (!state.running.some(([id]) => id === event.id)) break;
      state.running = state.running.filter(([id]) => id !== event.id);
      // Outside a prompt, its wake (not a subagent's report) is the reply that follows.
      if (state.turn?.phase.tag !== "prompting") state.wakesOwed += 1;
      break;
    }
    case "workDropped": {
      state.running = state.running.filter(([id]) => id !== event.id);
      break;
    }
    case "subagentsLaunched": {
      if (state.launches.includes(event.id) || event.count <= 0) break;
      state.launches = [...state.launches, event.id];
      state.subagents += event.count;
      state.launchedTotal += event.count;
      break;
    }
    case "childrenAtWork": {
      // A reading that misses a launch (its record not written yet) proves
      // nothing about it: the count stands as it was.
      if (event.known >= state.launchedTotal) {
        state.children = { running: Math.max(0, event.running), known: event.known };
      }
      break;
    }
    case "agentOutput": {
      agentSpoke(event.newTurnId);
      break;
    }
    case "replyEnded": {
      if (state.replyOpen) endReply();
      break;
    }
    case "requestOpened": {
      agentSpoke(event.newTurnId);
      if (!state.ended) state.requestsOpen += 1;
      break;
    }
    case "requestClosed": {
      state.requestsOpen = Math.max(0, state.requestsOpen - 1);
      break;
    }
    case "cancellationNotice": {
      if (state.noticesExpected > 0) {
        state.noticesExpected -= 1;
        commands.push({ type: "dropNotice" });
      } else {
        agentSpoke(event.newTurnId);
      }
      break;
    }
    case "stopRequested": {
      const turn = state.turn;
      // No turn, but work the agent still runs (a revert stops it): cancel it.
      if (!state.ended && turn === undefined && workPending(state)) {
        commands.push({ type: "sendCancel" });
        state.noticesExpected += 1;
        clearWork();
        break;
      }
      if (state.ended || turn === undefined || turn.stopRequested) break;
      commands.push({ type: "sendCancel" });
      // Each cancel may be followed by the agent's notice; that one is dropped.
      state.noticesExpected += 1;
      if (turn.phase.tag === "waiting") {
        // Nothing to answer: the cancel stops the agent's work, and the turn ends now.
        clearWork();
        endTurn({ kind: "stopped" });
        break;
      }
      state.turn = { ...turn, stopRequested: true };
      break;
    }
    case "timerFired": {
      const armed = state.timers.find(([timer]) => timer === event.timer);
      if (armed === undefined || armed[1] !== event.generation) break;
      state.timers = state.timers.filter(([timer]) => timer !== event.timer);
      switch (event.timer) {
        case "cancelDeadline":
          if (state.turn?.stopRequested === true) {
            commands.push({ type: "recycleAgent" });
            endSession();
            endTurn({ kind: "stopped" });
          }
          break;
        case "replyQuiet":
          if (state.replyOpen) endReply();
          // A wake that never came.
          else if (state.wakesOwed > 0) state.wakesOwed -= 1;
          break;
        case "settle":
          if (!workPending(state)) endWaiting();
          break;
        case "silent":
          clearWork();
          endWaiting();
          break;
        case "noticeExpiry":
          state.noticesExpected = 0;
          break;
      }
      break;
    }
    case "processExited": {
      if (state.ended) break;
      endSession();
      endTurn({ kind: "exited" });
      commands.push({ type: "stopSession", reason: "exited" });
      break;
    }
    case "sessionStopping": {
      endSession();
      endTurn({ kind: "aborted" });
      break;
    }
  }

  // Timers follow the state: arm what it needs, disarm what it no longer does.
  const wanted = desiredTimers(state);
  const timers: Array<readonly [AcpTurnTimer, number]> = [];
  for (const [timer, generation] of state.timers) {
    if (wanted.includes(timer)) timers.push([timer, generation]);
    else commands.push({ type: "disarmTimer", timer });
  }
  for (const timer of wanted) {
    if (timers.some(([armed]) => armed === timer)) continue;
    state.timerGeneration += 1;
    timers.push([timer, state.timerGeneration]);
    commands.push({ type: "armTimer", timer, generation: state.timerGeneration });
  }
  state.timers = timers;
  return { state, commands };
}
