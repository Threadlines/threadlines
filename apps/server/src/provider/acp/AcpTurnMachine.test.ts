import { describe, expect, it } from "vite-plus/test";

import {
  type AcpPromptOutcomeRead,
  type AcpTurnCommand,
  type AcpTurnEvent,
  type AcpTurnMachineState,
  desiredTimers,
  initialTurnMachineState,
  stepTurnMachine,
  workPending,
} from "./AcpTurnMachine.ts";

type Answer = "answer";
type State = AcpTurnMachineState<Answer>;
type Event = AcpTurnEvent<Answer>;
type Command = AcpTurnCommand<Answer>;

const outcome = (
  state: AcpPromptOutcomeRead<Answer>["state"],
  sessionLost = false,
): AcpPromptOutcomeRead<Answer> => ({ state, answer: "answer", sessionLost });

/** What the explorer remembers beside the state: what was promised and what was kept. */
interface Monitor {
  readonly sends: number;
  readonly steers: number;
  readonly agentTurns: number;
  /** Turns started and not ended. */
  readonly open: ReadonlyArray<string>;
  readonly closed: ReadonlyArray<string>;
  /** Sends and steers not yet accepted or turned down. */
  readonly unansweredCallers: ReadonlyArray<string>;
  /** `readOutcome` commands whose `outcomeRead` hasn't come back. */
  readonly reads: ReadonlyArray<number>;
  readonly workUsed: ReadonlyArray<string>;
  readonly launched: boolean;
  readonly childrenReported: boolean;
}

interface World {
  readonly state: State;
  readonly monitor: Monitor;
}

const initialWorld: World = {
  state: initialTurnMachineState<Answer>(),
  monitor: {
    sends: 0,
    steers: 0,
    agentTurns: 0,
    open: [],
    closed: [],
    unansweredCallers: [],
    reads: [],
    workUsed: [],
    launched: false,
    childrenReported: false,
  },
};

/** Every event the adapter could produce next, with small bounded domains. */
function possibleEvents(world: World): ReadonlyArray<Event> {
  const { state, monitor } = world;
  const events: Array<Event> = [];
  if (monitor.sends < 2) {
    events.push({ type: "send", sendId: `s${monitor.sends + 1}`, turnId: `u${monitor.sends + 1}` });
  }
  if (monitor.steers < 2) {
    const steerId = `t${monitor.steers + 1}`;
    if (state.turn !== undefined) {
      events.push({ type: "steer", steerId, expectedTurnId: state.turn.id });
    }
    if (monitor.steers === 0) events.push({ type: "steer", steerId, expectedTurnId: "stale" });
  }
  for (const prompt of state.undispatched) events.push({ type: "promptDispatched", prompt });
  for (const prompt of state.unanswered) events.push({ type: "promptAnswered", prompt });
  for (const prompt of monitor.reads) {
    events.push(
      { type: "outcomeRead", prompt, outcome: outcome("completed") },
      { type: "outcomeRead", prompt, outcome: outcome("failed") },
      { type: "outcomeRead", prompt, outcome: outcome("cancelled") },
      { type: "outcomeRead", prompt, outcome: outcome("failed", true) },
    );
  }
  if (!monitor.workUsed.includes("c1"))
    events.push({ type: "workStarted", id: "c1", kind: "command" });
  if (!monitor.workUsed.includes("w1"))
    events.push({ type: "workStarted", id: "w1", kind: "timer" });
  for (const [id] of state.running) events.push({ type: "workEnded", id });
  if (!monitor.launched) events.push({ type: "subagentsLaunched", id: "l1", count: 2 });
  if (monitor.launched && !monitor.childrenReported) {
    events.push({ type: "childrenAtWork", count: 0 });
  }
  const newTurnId = `a${monitor.agentTurns + 1}`;
  if (monitor.agentTurns < 2) {
    events.push(
      { type: "agentOutput", newTurnId },
      { type: "cancellationNotice", newTurnId },
      ...(state.requestsOpen === 0 ? [{ type: "requestOpened" as const, newTurnId }] : []),
    );
  } else if (state.turn !== undefined) {
    events.push({ type: "agentOutput", newTurnId }, { type: "cancellationNotice", newTurnId });
  }
  events.push({ type: "replyEnded" });
  if (state.requestsOpen > 0) events.push({ type: "requestClosed" });
  events.push({ type: "stopRequested" });
  for (const [timer, generation] of state.timers) {
    events.push({ type: "timerFired", timer, generation });
  }
  events.push({ type: "processExited" }, { type: "sessionStopping" });
  return events;
}

function check(condition: boolean, message: string, trail: ReadonlyArray<Event>): void {
  if (!condition) {
    throw new Error(
      `${message}\nafter: ${trail.map((event) => JSON.stringify(event)).join("\n  ")}`,
    );
  }
}

/** Applies one event, checking every invariant on the way; returns the next world. */
function advance(world: World, event: Event, trail: ReadonlyArray<Event>): World {
  const before = world.state;
  const { state, commands } = stepTurnMachine(before, event);
  let monitor = world.monitor;
  const types = commands.map((command) => command.type);

  // Bookkeeping of the event's own counters.
  if (event.type === "send") monitor = { ...monitor, sends: monitor.sends + 1 };
  if (event.type === "steer") monitor = { ...monitor, steers: monitor.steers + 1 };
  if (event.type === "send" || event.type === "steer") {
    const caller = event.type === "send" ? event.sendId : event.steerId;
    monitor = { ...monitor, unansweredCallers: [...monitor.unansweredCallers, caller] };
  }
  if (event.type === "workStarted")
    monitor = { ...monitor, workUsed: [...monitor.workUsed, event.id] };
  if (event.type === "subagentsLaunched") monitor = { ...monitor, launched: true };
  if (event.type === "childrenAtWork") monitor = { ...monitor, childrenReported: true };
  if (event.type === "outcomeRead") {
    monitor = { ...monitor, reads: monitor.reads.filter((prompt) => prompt !== event.prompt) };
  }

  for (const command of commands) {
    switch (command.type) {
      case "startTurn":
        check(!monitor.open.includes(command.turnId), "a turn started twice", trail);
        check(!monitor.closed.includes(command.turnId), "an ended turn started again", trail);
        check(monitor.open.length === 0, "a turn started while another was open", trail);
        monitor = { ...monitor, open: [...monitor.open, command.turnId] };
        if (command.sendId === undefined)
          monitor = { ...monitor, agentTurns: monitor.agentTurns + 1 };
        break;
      case "endTurn": {
        check(monitor.open.includes(command.turnId), "a turn ended that was not open", trail);
        monitor = {
          ...monitor,
          open: monitor.open.filter((id) => id !== command.turnId),
          closed: [...monitor.closed, command.turnId],
        };
        // Never completed while a newer prompt of the turn is unanswered.
        const turn = before.turn;
        const succeeded =
          command.end.kind === "agentDone" ||
          (command.end.kind === "answered" && command.end.outcome.state === "completed");
        if (succeeded && turn !== undefined && turn.newest !== undefined) {
          check(
            !turn.prompts.some(
              (prompt) => prompt >= turn.newest! && state.unanswered.includes(prompt),
            ),
            "a turn completed while a newer prompt was unanswered",
            trail,
          );
        }
        break;
      }
      case "acceptSend":
      case "rejectSend":
      case "acceptSteer":
      case "rejectSteer": {
        const caller = "sendId" in command ? command.sendId : command.steerId;
        check(monitor.unansweredCallers.includes(caller), `${caller} answered twice`, trail);
        monitor = {
          ...monitor,
          unansweredCallers: monitor.unansweredCallers.filter((id) => id !== caller),
        };
        break;
      }
      case "readOutcome":
        monitor = { ...monitor, reads: [...monitor.reads, command.prompt] };
        break;
      case "sendPrompt":
        // A new turn's prompt never lands inside another turn's.
        if ("sendId" in command.source && before.turn !== undefined) {
          const previous = before.turn;
          check(
            previous.id === command.turnId ||
              previous.newest === undefined ||
              !state.unanswered.includes(previous.newest),
            "a turn's prompt was sent while another turn's prompt was open",
            trail,
          );
        }
        break;
      default:
        break;
    }
  }

  // The machine's view of the open turn matches what it announced.
  check(
    state.turn === undefined
      ? monitor.open.length === 0
      : monitor.open.length === 1 && monitor.open[0] === state.turn.id,
    "the open turn and the announced turns disagree",
    trail,
  );
  check(
    state.subagents >= 0 &&
      state.wakesOwed >= 0 &&
      state.requestsOpen >= 0 &&
      state.noticesExpected >= 0,
    "a count went negative",
    trail,
  );
  // Timers armed are exactly the ones the state needs.
  check(
    JSON.stringify(state.timers.map(([timer]) => timer).toSorted()) ===
      JSON.stringify([...desiredTimers(state)].toSorted()),
    "the armed timers are not the ones the state needs",
    trail,
  );
  // Stop always has a deadline armed until the turn ends.
  if (state.turn?.stopRequested === true) {
    check(
      state.timers.some(([timer]) => timer === "cancelDeadline"),
      "Stop is pending with no deadline armed",
      trail,
    );
  }
  // A hold with nothing left to wait for ends by itself.
  if (state.turn?.phase.tag === "waiting" && !workPending(state) && state.requestsOpen === 0) {
    check(
      state.timers.some(([timer]) => timer === "settle"),
      "a hold with nothing left has no settle timer",
      trail,
    );
  }
  // After Stop for a prompt not yet sent, its sending re-sends the cancel.
  if (event.type === "promptDispatched" && before.turn?.stopRequested === true) {
    if (before.turn.prompts.includes(event.prompt)) {
      check(types.includes("sendCancel"), "a prompt went out after Stop with no cancel", trail);
    }
  }
  // The session's end ends every turn and answers every caller.
  if (state.ended) {
    check(
      state.turn === undefined && monitor.open.length === 0,
      "a turn outlived the session",
      trail,
    );
    check(state.queue.length === 0, "a send outlived the session", trail);
  }
  if (event.type === "processExited" || event.type === "sessionStopping") {
    check(state.ended && state.turn === undefined, "the session ended with a turn open", trail);
  }
  return { state, monitor };
}

/** Every caller answered, as the queue and open turns allow. */
function callersSettled(world: World): boolean {
  const waiting = new Set(world.state.queue.map((send) => send.sendId));
  return world.monitor.unansweredCallers.every((caller) => waiting.has(caller));
}

/** Breadth-first over every event sequence up to `depth`, skipping states already seen. */
function explore(depth: number): {
  readonly states: number;
  readonly worlds: ReadonlyArray<World>;
} {
  const seen = new Set<string>();
  let frontier: Array<{ world: World; trail: ReadonlyArray<Event> }> = [
    { world: initialWorld, trail: [] },
  ];
  const all: Array<World> = [initialWorld];
  for (let level = 0; level < depth; level += 1) {
    const next: Array<{ world: World; trail: ReadonlyArray<Event> }> = [];
    for (const { world, trail } of frontier) {
      for (const event of possibleEvents(world)) {
        const nextTrail = [...trail, event];
        const advanced = advance(world, event, nextTrail);
        check(callersSettled(advanced), "a send or steer was left without an answer", nextTrail);
        const key = JSON.stringify(advanced);
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(advanced);
        next.push({ world: advanced, trail: nextTrail });
      }
    }
    frontier = next;
  }
  return { states: seen.size, worlds: all };
}

/** Runs events from a fresh machine, returning every command in order and the last state. */
function run(events: ReadonlyArray<Event>): { state: State; commands: Array<Command> } {
  let state = initialTurnMachineState<Answer>();
  const commands: Array<Command> = [];
  for (const event of events) {
    const step = stepTurnMachine(state, event);
    state = step.state;
    commands.push(...step.commands);
  }
  return { state, commands };
}

const fire = (
  state: State,
  timer: "cancelDeadline" | "settle" | "replyQuiet" | "silent",
): Event => {
  const armed = state.timers.find(([name]) => name === timer);
  if (armed === undefined) throw new Error(`${timer} is not armed`);
  return { type: "timerFired", timer, generation: armed[1] };
};

const ends = (commands: ReadonlyArray<Command>) =>
  commands.flatMap((command) => (command.type === "endTurn" ? [command] : []));

describe("AcpTurnMachine, every reachable state", () => {
  // Depth 10 reaches every race below (the longest takes 10 events): about a
  // million distinct states, 20 seconds; depth 11 (2.2 million) passes too.
  // The alphabet is bounded to two sends, two steers, one command, one timer,
  // one batch of two subagents and two turns of the agent's own.
  const { states, worlds } = explore(10);

  it("explores a state space large enough to mean something", () => {
    expect(states).toBeGreaterThan(1_000_000);
  });

  it("reaches a terminal event from every Stop through the deadline alone", () => {
    for (const world of worlds) {
      const turn = world.state.turn;
      if (turn?.stopRequested !== true) continue;
      const step = stepTurnMachine(world.state, fire(world.state, "cancelDeadline"));
      expect(ends(step.commands).map((end) => end.turnId)).toEqual([turn.id]);
      expect(step.commands.some((command) => command.type === "recycleAgent")).toBe(true);
    }
  });

  it("ends every open turn exactly once when the session stops or the agent exits", () => {
    for (const world of worlds) {
      for (const type of ["sessionStopping", "processExited"] as const) {
        if (type === "processExited" && world.state.ended) continue;
        const step = stepTurnMachine(world.state, { type });
        const ended = ends(step.commands).map((end) => end.turnId);
        expect(ended).toEqual(world.state.turn === undefined ? [] : [world.state.turn.id]);
        expect(step.state.turn).toBeUndefined();
        expect(step.commands.some((command) => command.type === "startTurn")).toBe(false);
      }
    }
  });

  it("ends a hold through timers alone once the agent's work is done", () => {
    for (const world of worlds) {
      const state = world.state;
      if (state.turn?.phase.tag !== "waiting" || state.requestsOpen > 0) continue;
      // Each quiet limit that can run, run in turn, ends the hold unless a timer the agent set still runs.
      const heldId = state.turn.id;
      let current = state;
      for (let round = 0; round < 6 && current.turn?.id === heldId; round += 1) {
        const armed = current.timers.find(([timer]) => timer !== "cancelDeadline");
        if (armed === undefined) break;
        current = stepTurnMachine(current, fire(current, armed[0])).state;
      }
      const timerRunning = current.running.some(([, kind]) => kind === "timer");
      // A queued message may have started the next turn: the held one is over.
      if (!timerRunning) expect(current.turn?.id).not.toBe(heldId);
    }
  });
});

describe("AcpTurnMachine, the reviewed races", () => {
  it("Stop as the prompt turns into a hold ends the turn, never holds it (finding 1)", () => {
    const { state, commands } = run([
      { type: "send", sendId: "s1", turnId: "u1" },
      { type: "promptDispatched", prompt: 1 },
      { type: "workStarted", id: "w1", kind: "timer" },
      { type: "stopRequested" },
      { type: "promptAnswered", prompt: 1 },
      { type: "outcomeRead", prompt: 1, outcome: outcome("completed") },
    ]);
    expect(ends(commands)).toHaveLength(1);
    expect(state.turn).toBeUndefined();
    // The deadline stayed armed from Stop until the turn ended.
    expect(commands.filter((command) => command.type === "armTimer")).toEqual([
      { type: "armTimer", timer: "cancelDeadline", generation: 1 },
    ]);
  });

  it("Stop before the prompt went out cancels again when it does, and the deadline backs it (finding 2)", () => {
    const stopped = run([{ type: "send", sendId: "s1", turnId: "u1" }, { type: "stopRequested" }]);
    expect(stopped.commands.filter((command) => command.type === "sendCancel")).toHaveLength(1);
    const dispatched = stepTurnMachine(stopped.state, { type: "promptDispatched", prompt: 1 });
    expect(dispatched.commands).toContainEqual({ type: "sendCancel" });
    // The prompt hangs: the deadline recycles the agent and ends the turn.
    const deadline = stepTurnMachine(dispatched.state, fire(dispatched.state, "cancelDeadline"));
    expect(deadline.commands).toContainEqual({ type: "recycleAgent" });
    expect(ends(deadline.commands)).toEqual([
      { type: "endTurn", turnId: "u1", end: { kind: "stopped" } },
    ]);
  });

  it("a report that lands while the answer is read counts, and nothing holds the turn (finding 3)", () => {
    const { state, commands } = run([
      { type: "send", sendId: "s1", turnId: "u1" },
      { type: "promptDispatched", prompt: 1 },
      { type: "subagentsLaunched", id: "l1", count: 1 },
      { type: "promptAnswered", prompt: 1 },
      { type: "agentOutput", newTurnId: "a1" },
      { type: "replyEnded" },
      { type: "outcomeRead", prompt: 1, outcome: outcome("completed") },
    ]);
    expect(state.subagents).toBe(0);
    expect(ends(commands).map((end) => end.turnId)).toEqual(["u1"]);
  });

  it("a batched launch counts each subagent, and each finished command owes its own wake (finding 5)", () => {
    const launched = run([
      { type: "send", sendId: "s1", turnId: "u1" },
      { type: "subagentsLaunched", id: "l1", count: 2 },
      { type: "workStarted", id: "c1", kind: "command" },
      { type: "workStarted", id: "c2", kind: "command" },
      { type: "promptAnswered", prompt: 1 },
      { type: "outcomeRead", prompt: 1, outcome: outcome("completed") },
      { type: "workEnded", id: "c1" },
      { type: "workEnded", id: "c2" },
    ]);
    expect(launched.state.wakesOwed).toBe(2);
    let state = launched.state;
    // Two wakes, then two reports: the turn holds through all four replies.
    for (let reply = 0; reply < 4; reply += 1) {
      expect(state.turn?.phase.tag).toBe("waiting");
      state = stepTurnMachine(state, { type: "agentOutput", newTurnId: "a1" }).state;
      state = stepTurnMachine(state, { type: "replyEnded" }).state;
    }
    expect(state.subagents).toBe(0);
    expect(state.wakesOwed).toBe(0);
    const settled = stepTurnMachine(state, fire(state, "settle"));
    expect(ends(settled.commands).map((end) => end.turnId)).toEqual(["u1"]);
  });

  it("the agent's own count of children, once reported, decides (wiring for the child records)", () => {
    const { state } = run([
      { type: "send", sendId: "s1", turnId: "u1" },
      { type: "subagentsLaunched", id: "l1", count: 2 },
      { type: "promptAnswered", prompt: 1 },
      { type: "outcomeRead", prompt: 1, outcome: outcome("completed") },
      { type: "childrenAtWork", count: 0 },
    ]);
    expect(state.timers.map(([timer]) => timer)).toEqual(["settle"]);
  });

  it("stopping the session during a hold ends the held turn (finding 6)", () => {
    const held = run([
      { type: "send", sendId: "s1", turnId: "u1" },
      { type: "workStarted", id: "c1", kind: "command" },
      { type: "promptAnswered", prompt: 1 },
      { type: "outcomeRead", prompt: 1, outcome: outcome("completed") },
    ]);
    expect(held.state.turn?.phase.tag).toBe("waiting");
    const stopping = stepTurnMachine(held.state, { type: "sessionStopping" });
    expect(ends(stopping.commands)).toEqual([
      { type: "endTurn", turnId: "u1", end: { kind: "aborted" } },
    ]);
  });

  it("a cancellation notice after a quick follow-up is dropped, not shown (finding 8)", () => {
    const { state, commands } = run([
      { type: "send", sendId: "s1", turnId: "u1" },
      { type: "promptDispatched", prompt: 1 },
      { type: "stopRequested" },
      { type: "promptAnswered", prompt: 1 },
      { type: "outcomeRead", prompt: 1, outcome: outcome("cancelled") },
      { type: "send", sendId: "s2", turnId: "u2" },
      { type: "promptDispatched", prompt: 2 },
      { type: "promptAnswered", prompt: 2 },
      { type: "outcomeRead", prompt: 2, outcome: outcome("completed") },
      { type: "cancellationNotice", newTurnId: "a1" },
    ]);
    expect(commands.at(-1)).toEqual({ type: "dropNotice" });
    expect(commands.filter((command) => command.type === "startTurn")).toHaveLength(2);
    expect(state.turn).toBeUndefined();
  });

  it("a steer while the answer is read takes the turn on; the stale outcome is ignored", () => {
    const { state, commands } = run([
      { type: "send", sendId: "s1", turnId: "u1" },
      { type: "promptAnswered", prompt: 1 },
      { type: "steer", steerId: "t1", expectedTurnId: "u1" },
      { type: "outcomeRead", prompt: 1, outcome: outcome("completed") },
    ]);
    expect(ends(commands)).toEqual([]);
    expect(state.turn?.newest).toBe(2);
    expect(state.turn?.phase.tag).toBe("prompting");
  });

  it("an older prompt answering after a steer moves the newer one's outcome reading on", () => {
    const { commands } = run([
      { type: "send", sendId: "s1", turnId: "u1" },
      { type: "steer", steerId: "t1", expectedTurnId: "u1" },
      { type: "promptAnswered", prompt: 1 },
    ]);
    expect(commands).toContainEqual({ type: "rebaseOutcome", prompt: 2 });
  });
});
