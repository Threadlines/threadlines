// @effect-diagnostics nodeBuiltinImport:off -- the explorer hashes its seen states.
/**
 * The turn machine's tests: an exhaustive explorer over every event
 * sequence up to a depth, with steering on and off, then the named races.
 *
 * Every run explores to the default depths (`DEFAULT_STEER_DEPTH`,
 * `DEFAULT_QUEUE_DEPTH`). `ACP_EXPLORER_FULL=1` explores to the full depths
 * instead (about two and a half minutes and 2.5 GB); run it after changing
 * the machine.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import {
  type AcpPromptOutcomeRead,
  type AcpTurnCommand,
  type AcpTurnEvent,
  type AcpTurnMachineState,
  type AcpTurnTimer,
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
  /** How often each call started as work (a call can start again after it was dropped). */
  readonly workStarts: number;
  readonly launches: number;
  /** `readChildren` commands not answered yet, any of which may answer next (the newest two). */
  readonly childReads: ReadonlyArray<{
    readonly generation: number;
    readonly launches: ReadonlyArray<readonly [string, number]>;
  }>;
  /** The driver stops the session: a recycle or a stop was asked for and not yet delivered. */
  readonly stopAsked: boolean;
  /** Prompts the machine sent, those written to the agent, and those whose delivery was reported. */
  readonly prompts: ReadonlyArray<number>;
  readonly written: ReadonlyArray<number>;
  readonly reported: ReadonlyArray<number>;
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
    workStarts: 0,
    launches: 0,
    childReads: [],
    stopAsked: false,
    prompts: [],
    written: [],
    reported: [],
  },
};

/** The launches the explorer makes: one that records can cover, then a batch that they can't. */
const LAUNCHES: ReadonlyArray<readonly [string, number]> = [
  ["l1", 1],
  ["l2", 2],
];

/**
 * Every event the adapter could produce next, with small bounded domains.
 * `steer` off is an agent whose messages mid-turn wait (`turnMachine.steer`).
 */
function possibleEvents(world: World, steer: boolean): ReadonlyArray<Event> {
  const { state, monitor } = world;
  const events: Array<Event> = [];
  if (monitor.sends < 2) {
    events.push({ type: "send", sendId: `s${monitor.sends + 1}`, turnId: `u${monitor.sends + 1}` });
  }
  if (steer && monitor.steers < 2) {
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
  // A command and a timer, each of which may start again after it was dropped.
  if (monitor.workStarts < 3) {
    for (const [id, kind] of [
      ["c1", "command"],
      ["w1", "timer"],
    ] as const) {
      if (!state.running.some(([running]) => running === id)) {
        events.push({ type: "workStarted", id, kind });
      }
    }
  }
  const ending = new Set([...state.running.map(([id]) => id), ...(state.stopping?.commands ?? [])]);
  for (const id of ending) events.push({ type: "workEnded", id }, { type: "workDropped", id });
  const launch = LAUNCHES[monitor.launches];
  if (launch !== undefined) {
    events.push({ type: "subagentsLaunched", id: launch[0], count: launch[1] });
  }
  // Any outstanding reading may answer next, older ones included: none at
  // work, every child at work, or one that missed the newest launch.
  for (const read of monitor.childReads) {
    const covered = read.launches.filter(([, count]) => count === 1);
    events.push(
      {
        type: "childrenAtWork",
        generation: read.generation,
        launches: covered.map(([id]) => [id, 0] as const),
      },
      {
        type: "childrenAtWork",
        generation: read.generation,
        launches: covered.map(([id, count]) => [id, count] as const),
      },
    );
    if (covered.length > 0) {
      events.push({
        type: "childrenAtWork",
        generation: read.generation,
        launches: covered.slice(0, -1).map(([id]) => [id, 0] as const),
      });
    }
  }
  const newTurnId = `a${monitor.agentTurns + 1}`;
  if (monitor.agentTurns < 2) {
    events.push(
      { type: "agentOutput", newTurnId },
      { type: "cancellationNotice", newTurnId },
      ...(state.requestsOpen < 2 ? [{ type: "requestOpened" as const, newTurnId }] : []),
    );
  } else if (state.turn !== undefined) {
    events.push({ type: "agentOutput", newTurnId }, { type: "cancellationNotice", newTurnId });
  }
  events.push({ type: "replyEnded" });
  if (state.requestsOpen > 0) events.push({ type: "requestClosed" });
  events.push({ type: "stopRequested" });
  // The armed timer, and a callback of the one it replaced still queued.
  for (const [timer, generation] of state.timers) {
    events.push({ type: "timerFired", timer, generation });
    if (generation > 1) events.push({ type: "timerFired", timer, generation: generation - 1 });
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

const ENDS_THE_READER: ReadonlySet<Command["type"]> = new Set(["recycleAgent", "stopSession"]);

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
  if (event.type === "workStarted") monitor = { ...monitor, workStarts: monitor.workStarts + 1 };
  if (event.type === "subagentsLaunched") monitor = { ...monitor, launches: monitor.launches + 1 };
  if (event.type === "childrenAtWork") {
    monitor = {
      ...monitor,
      childReads: monitor.childReads.filter((read) => read.generation !== event.generation),
    };
    // An older reading changes nothing.
    if (event.generation !== before.childRead.generation) {
      check(
        JSON.stringify(state) === JSON.stringify(before),
        "an older reading of the records changed the state",
        trail,
      );
    }
  }
  if (event.type === "outcomeRead") {
    monitor = { ...monitor, reads: monitor.reads.filter((prompt) => prompt !== event.prompt) };
  }
  if (event.type === "sessionStopping") monitor = { ...monitor, stopAsked: false };
  if (event.type === "promptDispatched" && before.undispatched.includes(event.prompt)) {
    monitor = { ...monitor, written: [...monitor.written, event.prompt] };
  }
  // A prompt whose setup failed (answered before it was written) is reported undelivered.
  if (event.type === "promptAnswered" && before.undispatched.includes(event.prompt)) {
    check(
      commands.some(
        (command) =>
          command.type === "reportDelivery" &&
          command.prompt === event.prompt &&
          !command.delivered,
      ),
      "a send whose setup failed was not reported undispatched",
      trail,
    );
  }

  // What can end the reader comes after the turn's end it goes with.
  const lastEnd = types.lastIndexOf("endTurn");
  const firstStop = types.findIndex((type) => ENDS_THE_READER.has(type));
  check(
    lastEnd < 0 || firstStop < 0 || lastEnd < firstStop,
    "a command that ends the reader came before the turn's end",
    trail,
  );

  for (const command of commands) {
    switch (command.type) {
      case "startTurn":
        check(!monitor.open.includes(command.turnId), "a turn started twice", trail);
        check(!monitor.closed.includes(command.turnId), "an ended turn started again", trail);
        check(monitor.open.length === 0, "a turn started while another was open", trail);
        check(
          command.sendId === undefined || state.stopping === undefined,
          "a turn of a send started while a stop waits",
          trail,
        );
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
      case "reportDelivery":
        check(!monitor.reported.includes(command.prompt), "a delivery reported twice", trail);
        check(
          command.delivered === monitor.written.includes(command.prompt),
          command.delivered
            ? "a prompt never written was reported dispatched"
            : "a written prompt was reported undispatched",
          trail,
        );
        monitor = { ...monitor, reported: [...monitor.reported, command.prompt] };
        break;
      case "readChildren":
        check(command.launches.length > 0, "the records were read for no launch", trail);
        monitor = {
          ...monitor,
          childReads: [
            ...monitor.childReads.slice(-1),
            { generation: command.generation, launches: command.launches },
          ],
        };
        break;
      case "recycleAgent":
      case "stopSession":
        monitor = { ...monitor, stopAsked: true };
        break;
      case "sendPrompt":
        monitor = { ...monitor, prompts: [...monitor.prompts, command.prompt] };
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
  // Stop always has a deadline armed until the turn ends and the work it stopped is over.
  if (!state.ended && (state.turn?.stopRequested === true || state.stopping !== undefined)) {
    check(
      state.timers.some(([timer]) => timer === "cancelDeadline"),
      "Stop is pending with no deadline armed",
      trail,
    );
  }
  check(
    state.stopping === undefined ||
      state.stopping.commands.length > 0 ||
      state.stopping.launches.length > 0,
    "a stop waits on nothing",
    trail,
  );
  // A queued send waits only on a turn or a stop, both of which end.
  check(
    state.queue.length === 0 || state.turn !== undefined || state.stopping !== undefined,
    "a send is queued with nothing ahead of it",
    trail,
  );
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
  // A notice owed by a cancel is expected only until its expiry fires.
  if (
    event.type === "timerFired" &&
    event.timer === "noticeExpiry" &&
    before.timers.some(
      ([timer, generation]) => timer === "noticeExpiry" && generation === event.generation,
    )
  ) {
    check(state.noticesExpected === 0, "a notice is still expected after it expired", trail);
  }
  if (state.noticesExpected > 0 && !state.ended) {
    check(
      state.timers.some(([timer]) => timer === "noticeExpiry"),
      "a notice is expected with no expiry armed",
      trail,
    );
  }
  // The session's end ends every turn and answers every caller.
  if (state.ended) {
    check(
      state.turn === undefined && monitor.open.length === 0,
      "a turn outlived the session",
      trail,
    );
    check(state.queue.length === 0, "a send outlived the session", trail);
    check(state.stopping === undefined, "a stop outlived the session", trail);
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

/**
 * A fair schedule from here: the agent answers every prompt, every read
 * comes back, every request is answered, its work and replies end, and
 * every armed timer fires. Under it every send and steer hears back.
 */
function drain(world: World, steer: boolean): World {
  let current = world;
  const trail: Array<Event> = [];
  for (let step = 0; step < 80; step += 1) {
    const { state, monitor } = current;
    if (monitor.unansweredCallers.length === 0 && state.queue.length === 0) return current;
    const next: Event | undefined =
      (state.undispatched[0] !== undefined
        ? { type: "promptDispatched", prompt: state.undispatched[0] }
        : undefined) ??
      (state.unanswered[0] !== undefined
        ? { type: "promptAnswered", prompt: state.unanswered[0] }
        : undefined) ??
      (monitor.reads[0] !== undefined
        ? { type: "outcomeRead", prompt: monitor.reads[0], outcome: outcome("completed") }
        : undefined) ??
      (state.requestsOpen > 0 ? { type: "requestClosed" } : undefined) ??
      (state.running[0] !== undefined
        ? { type: "workEnded", id: state.running[0][0] }
        : undefined) ??
      (state.stopping?.commands[0] !== undefined
        ? { type: "workEnded", id: state.stopping.commands[0] }
        : undefined) ??
      (state.replyOpen ? { type: "replyEnded" } : undefined) ??
      (state.timers[0] !== undefined
        ? { type: "timerFired", timer: state.timers[0][0], generation: state.timers[0][1] }
        : undefined);
    if (next === undefined) break;
    trail.push(next);
    current = advance(current, next, trail);
  }
  check(
    current.monitor.unansweredCallers.length === 0 && current.state.queue.length === 0,
    `a send or steer never heard back under a fair schedule (steer ${steer ? "on" : "off"})`,
    trail,
  );
  // And every prompt sent says whether it was delivered.
  check(
    current.monitor.prompts.every(
      (prompt) =>
        current.monitor.reported.includes(prompt) || current.state.undispatched.includes(prompt),
    ),
    "a prompt's delivery was never reported",
    trail,
  );
  return current;
}

/**
 * Breadth-first over every event sequence up to `depth`, skipping states
 * already seen; `visit` sees each new world once.
 */
function explore(depth: number, steer: boolean, visit: (world: World) => void): number {
  const seen = new Set<string>();
  let frontier: Array<{ world: World; trail: ReadonlyArray<Event> }> = [
    { world: initialWorld, trail: [] },
  ];
  visit(initialWorld);
  for (let level = 0; level < depth; level += 1) {
    const next: Array<{ world: World; trail: ReadonlyArray<Event> }> = [];
    for (const { world, trail } of frontier) {
      for (const event of possibleEvents(world, steer)) {
        const nextTrail = [...trail, event];
        const advanced = advance(world, event, nextTrail);
        check(callersSettled(advanced), "a send or steer was left without an answer", nextTrail);
        // A digest, not the text: millions of states fit in memory.
        const key = createHash("sha1").update(JSON.stringify(advanced)).digest("base64");
        if (seen.has(key)) continue;
        seen.add(key);
        visit(advanced);
        if (level < depth - 1) next.push({ world: advanced, trail: nextTrail });
      }
    }
    frontier = next;
  }
  return seen.size;
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

const fire = (state: State, timer: AcpTurnTimer): Event => {
  const armed = state.timers.find(([name]) => name === timer);
  if (armed === undefined) throw new Error(`${timer} is not armed`);
  return { type: "timerFired", timer, generation: armed[1] };
};

const ends = (commands: ReadonlyArray<Command>) =>
  commands.flatMap((command) => (command.type === "endTurn" ? [command] : []));

/** What must hold from every reachable world, checked as each is first reached. */
function checkWorld(world: World, steer: boolean): void {
  const state = world.state;
  // Stop, from any state, ends the turn the user sees or arms the deadline;
  // the deadline alone then ends everything, the turn's end before the recycle.
  const stopped = stepTurnMachine(state, { type: "stopRequested" });
  if (!state.ended && (state.turn !== undefined || workPending(state))) {
    const after = stopped.state;
    const pending = after.turn?.stopRequested === true || after.stopping !== undefined;
    if (pending) {
      expect(after.timers.some(([timer]) => timer === "cancelDeadline")).toBe(true);
      const deadline = stepTurnMachine(after, fire(after, "cancelDeadline"));
      expect(deadline.state.turn).toBeUndefined();
      expect(deadline.state.stopping).toBeUndefined();
      const types = deadline.commands
        .map((command) => command.type)
        .filter((type) => type !== "armTimer" && type !== "disarmTimer");
      expect(types.at(-1)).toBe("recycleAgent");
      if (after.turn !== undefined) {
        expect(ends(deadline.commands).map((end) => end.turnId)).toEqual([after.turn.id]);
      }
    } else if (state.turn !== undefined) {
      // Ended; a queued message may have started the next turn.
      expect(after.turn?.id).not.toBe(state.turn.id);
    }
    // Held work Stop cancelled is kept, not forgotten.
    const commandsHeld = state.running.some(([, kind]) => kind === "command");
    if (
      commandsHeld &&
      state.turn?.phase.tag !== "prompting" &&
      state.turn?.phase.tag !== "settling"
    ) {
      expect(after.stopping).toBeDefined();
    }
  }
  // The session stopping or the agent exiting ends the open turn exactly once.
  for (const type of ["sessionStopping", "processExited"] as const) {
    if (type === "processExited" && state.ended) continue;
    const step = stepTurnMachine(state, { type });
    const ended = ends(step.commands).map((end) => end.turnId);
    expect(ended).toEqual(state.turn === undefined ? [] : [state.turn.id]);
    expect(step.state.turn).toBeUndefined();
    expect(step.commands.some((command) => command.type === "startTurn")).toBe(false);
  }
  // A hold ends through timers (and its final outcome check, when the agent
  // spoke during the hold) once the agent's work is done.
  if (state.turn?.phase.tag === "waiting" && state.requestsOpen === 0) {
    const heldId = state.turn.id;
    let current = state;
    for (let round = 0; round < 8 && current.turn?.id === heldId; round += 1) {
      if (current.turn.phase.tag === "settling" && current.turn.newest !== undefined) {
        current = stepTurnMachine(current, {
          type: "outcomeRead",
          prompt: current.turn.newest,
          outcome: outcome("completed"),
        }).state;
        continue;
      }
      const armed = current.timers.find(
        ([timer]) => timer !== "cancelDeadline" && timer !== "stopCheck",
      );
      if (armed === undefined) break;
      current = stepTurnMachine(current, fire(current, armed[0])).state;
    }
    const timerRunning = current.running.some(([, kind]) => kind === "timer");
    // A queued message may have started the next turn: the held one is over.
    if (!timerRunning) expect(current.turn?.id).not.toBe(heldId);
  }
  // Every send and steer hears back under a fair schedule.
  if (world.monitor.unansweredCallers.length > 0) drain(world, steer);
}

const FULL_DEPTH = process.env.ACP_EXPLORER_FULL === "1";
/**
 * The default run: the deepest that stays under about 30 seconds and 1 GB
 * (8 and 8: about 720,000 states with steering and 290,000 without, 22
 * seconds and 0.55 GB on an M-series Mac).
 */
const DEFAULT_STEER_DEPTH = 8;
const DEFAULT_STEER_STATES = 700_000;
const DEFAULT_QUEUE_DEPTH = 8;
const DEFAULT_QUEUE_STATES = 280_000;

describe.each(
  FULL_DEPTH
    ? [
        { steer: true, depth: 9, atLeast: 2_000_000 },
        { steer: false, depth: 10, atLeast: 2_000_000 },
      ]
    : [
        { steer: true, depth: DEFAULT_STEER_DEPTH, atLeast: DEFAULT_STEER_STATES },
        { steer: false, depth: DEFAULT_QUEUE_DEPTH, atLeast: DEFAULT_QUEUE_STATES },
      ],
)("AcpTurnMachine, every reachable state (steering $steer)", ({ steer, depth, atLeast }) => {
  // The alphabet is bounded to two sends, two steers (none with steering
  // off), a command and a timer that can each start again after a drop
  // (three starts in all), a launch the records can cover and a batch they
  // can't, every outstanding reading of the records answering in any order
  // (none at work, all at work, or one that missed a launch), up to two
  // open requests, a stale timer callback beside each armed one, and two
  // turns of the agent's own. The full depths, 9 with steering (about 2.6
  // million states) and 10 without (about 2.8 million), take over two
  // minutes; every named race below is shorter.
  let checked = 0;
  const states = explore(depth, steer, (world) => {
    checkWorld(world, steer);
    checked += 1;
  });

  it("explores a state space large enough to mean something", () => {
    expect(states).toBeGreaterThan(atLeast);
    expect(checked).toBe(states + 1);
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
    // The deadline was armed once, at Stop, and stayed armed until the turn ended.
    const deadline = commands.filter(
      (command) =>
        (command.type === "armTimer" || command.type === "disarmTimer") &&
        command.timer === "cancelDeadline",
    );
    expect(deadline.map((command) => command.type)).toEqual(["armTimer", "disarmTimer"]);
    expect(commands.findIndex((command) => command.type === "disarmTimer")).toBeGreaterThan(
      commands.findIndex((command) => command.type === "endTurn"),
    );
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
    expect(settled.commands).toContainEqual({ type: "readOutcome", prompt: 1 });
    const rechecked = stepTurnMachine(settled.state, {
      type: "outcomeRead",
      prompt: 1,
      outcome: outcome("completed"),
    });
    expect(ends(rechecked.commands).map((end) => end.turnId)).toEqual(["u1"]);
  });

  /** A turn holding two subagents, its answer read. */
  const holdingTwo: ReadonlyArray<Event> = [
    { type: "send", sendId: "s1", turnId: "u1" },
    { type: "subagentsLaunched", id: "l1", count: 2 },
    { type: "promptAnswered", prompt: 1 },
    { type: "outcomeRead", prompt: 1, outcome: outcome("completed") },
  ];

  /** The records' answer to the newest reading. */
  const records = (state: State, launches: ReadonlyArray<readonly [string, number]>): Event => ({
    type: "childrenAtWork",
    generation: state.childRead.generation,
    launches,
  });

  it("several reports in one reply end the hold once the records say so (child records)", () => {
    const { state, commands } = run([
      ...holdingTwo,
      { type: "agentOutput", newTurnId: "a1" },
      { type: "replyEnded" },
    ]);
    // One reply: the protocol count alone would still hold one subagent.
    expect(state.subagents).toBe(1);
    expect(commands).toContainEqual({
      type: "readChildren",
      generation: state.childRead.generation,
      launches: [["l1", 2]],
    });
    const read = stepTurnMachine(state, records(state, [["l1", 0]]));
    expect(read.state.timers.map(([timer]) => timer)).toEqual(["settle"]);
  });

  it("a killed child stops holding the turn (child records)", () => {
    // The records list one child reported, one killed: none running.
    const held = run(holdingTwo).state;
    const { state } = run([...holdingTwo, records(held, [["l1", 0]])]);
    expect(state.timers.map(([timer]) => timer)).toEqual(["settle"]);
  });

  it("with no records, or a reading that misses a launch, the protocol count stands (child records)", () => {
    const held = run(holdingTwo).state;
    const missed = run([...holdingTwo, records(held, [])]);
    expect(missed.state.children).toBeUndefined();
    expect(missed.state.timers.map(([timer]) => timer)).toEqual(["silent"]);
    // Each report frees one subagent.
    let state = missed.state;
    for (let report = 0; report < 2; report += 1) {
      state = stepTurnMachine(state, { type: "agentOutput", newTurnId: "a1" }).state;
      state = stepTurnMachine(state, { type: "replyEnded" }).state;
    }
    expect(state.timers.map(([timer]) => timer)).toEqual(["settle"]);
  });

  it("records of an earlier launch don't cover a new one (finding 4)", () => {
    // After a resume the records cover the whole conversation; the machine
    // knows only this session's launch, whose record isn't written yet.
    const held = run([
      { type: "send", sendId: "s1", turnId: "u1" },
      { type: "subagentsLaunched", id: "l-new", count: 1 },
      { type: "promptAnswered", prompt: 1 },
      { type: "outcomeRead", prompt: 1, outcome: outcome("completed") },
    ]).state;
    // An old child, reported long ago, is no launch of this machine's.
    const read = stepTurnMachine(held, records(held, [["l-old", 0]]));
    expect(read.state.children).toBeUndefined();
    expect(read.state.turn?.phase.tag).toBe("waiting");
    expect(read.state.timers.map(([timer]) => timer)).toEqual(["silent"]);
  });

  it("an older reading of the records that lands last is dropped (finding 4)", () => {
    const { state } = run([
      ...holdingTwo,
      { type: "agentOutput", newTurnId: "a1" },
      { type: "replyEnded" },
    ]);
    const newest = state.childRead.generation;
    expect(newest).toBeGreaterThan(1);
    // The newer reading says one is still at work; the older, slower one says none.
    const current = stepTurnMachine(state, records(state, [["l1", 1]])).state;
    const stale = stepTurnMachine(current, {
      type: "childrenAtWork",
      generation: newest - 1,
      launches: [["l1", 0]],
    });
    expect(stale.state).toEqual(current);
    expect(stale.state.turn?.phase.tag).toBe("waiting");
  });

  it("Stop on held work ends the turn at once and keeps the work until it ends (finding 3)", () => {
    const held = run([
      { type: "send", sendId: "s1", turnId: "u1" },
      { type: "workStarted", id: "c1", kind: "command" },
      { type: "promptAnswered", prompt: 1 },
      { type: "outcomeRead", prompt: 1, outcome: outcome("completed") },
    ]).state;
    const stopped = stepTurnMachine(held, { type: "stopRequested" });
    expect(ends(stopped.commands)).toEqual([
      { type: "endTurn", turnId: "u1", end: { kind: "stopped" } },
    ]);
    expect(stopped.state.stopping).toEqual({ commands: ["c1"], launches: [] });
    expect(stopped.state.timers.map(([timer]) => timer)).toContain("cancelDeadline");
    // A message sent meanwhile waits for the stop.
    const sent = stepTurnMachine(stopped.state, { type: "send", sendId: "s2", turnId: "u2" });
    expect(sent.commands.map((command) => command.type)).not.toContain("startTurn");
    // The agent shows the command ended: the stop is over and the message goes.
    const ended = stepTurnMachine(sent.state, { type: "workEnded", id: "c1" });
    expect(ended.state.stopping).toBeUndefined();
    expect(ended.state.wakesOwed).toBe(0);
    expect(ended.commands).toContainEqual({ type: "startTurn", turnId: "u2", sendId: "s2" });
    expect(ended.commands).toContainEqual({ type: "disarmTimer", timer: "cancelDeadline" });
  });

  it("a cancel the agent ignores recycles it at the deadline, the turn's end first (findings 1 and 3)", () => {
    const stopping = run([
      { type: "send", sendId: "s1", turnId: "u1" },
      { type: "workStarted", id: "c1", kind: "command" },
      { type: "promptAnswered", prompt: 1 },
      { type: "outcomeRead", prompt: 1, outcome: outcome("completed") },
      { type: "stopRequested" },
      { type: "send", sendId: "s2", turnId: "u2" },
    ]).state;
    const deadline = stepTurnMachine(stopping, fire(stopping, "cancelDeadline"));
    expect(deadline.commands.map((command) => command.type)).toEqual(
      expect.arrayContaining(["rejectSend", "recycleAgent"]),
    );
    expect(deadline.commands.findLast((command) => command.type !== "disarmTimer")).toEqual({
      type: "recycleAgent",
    });
    expect(deadline.state.ended).toBe(true);
    // Stop during a prompt: the turn's end goes out before the recycle.
    const prompting = run([
      { type: "send", sendId: "s1", turnId: "u1" },
      { type: "stopRequested" },
    ]);
    const types = stepTurnMachine(
      prompting.state,
      fire(prompting.state, "cancelDeadline"),
    ).commands.map((command) => command.type);
    expect(types.indexOf("endTurn")).toBeLessThan(types.indexOf("recycleAgent"));
  });

  it("a stop waiting on a subagent ends once the records show it stopped", () => {
    const held = run([
      { type: "send", sendId: "s1", turnId: "u1" },
      { type: "subagentsLaunched", id: "l1", count: 1 },
      { type: "promptAnswered", prompt: 1 },
      { type: "outcomeRead", prompt: 1, outcome: outcome("completed") },
    ]).state;
    const stopped = stepTurnMachine(held, { type: "stopRequested" });
    expect(stopped.state.stopping).toEqual({ commands: [], launches: [["l1", 1]] });
    expect(stopped.commands.map((command) => command.type)).toContain("readChildren");
    // Still at work at first; the next check finds it killed.
    const working = stepTurnMachine(stopped.state, records(stopped.state, [["l1", 1]])).state;
    expect(working.stopping).toBeDefined();
    const check = stepTurnMachine(working, fire(working, "stopCheck"));
    const killed = stepTurnMachine(check.state, records(check.state, [["l1", 0]]));
    expect(killed.state.stopping).toBeUndefined();
    expect(killed.state.timers.map(([timer]) => timer)).toEqual(["noticeExpiry"]);
  });

  it("a call taken for a command and then shown to be an MCP call holds nothing", () => {
    const { state } = run([
      { type: "send", sendId: "s1", turnId: "u1" },
      { type: "workStarted", id: "c1", kind: "command" },
      { type: "workDropped", id: "c1" },
      { type: "promptAnswered", prompt: 1 },
      { type: "outcomeRead", prompt: 1, outcome: outcome("completed") },
    ]);
    expect(state.turn).toBeUndefined();
  });

  it("a cancel's notice that never comes is no longer expected after a while", () => {
    const { state } = run([
      { type: "send", sendId: "s1", turnId: "u1" },
      { type: "stopRequested" },
      { type: "promptAnswered", prompt: 1 },
      { type: "outcomeRead", prompt: 1, outcome: outcome("cancelled") },
    ]);
    expect(state.noticesExpected).toBe(1);
    const expired = stepTurnMachine(state, fire(state, "noticeExpiry")).state;
    expect(expired.noticesExpected).toBe(0);
    // A later reply in those words is output, opening a turn.
    const late = stepTurnMachine(expired, { type: "cancellationNotice", newTurnId: "a1" });
    expect(late.commands.map((command) => command.type)).toContain("startTurn");
  });

  it("a revert's Stop with no turn cancels the work still running", () => {
    // A command still running after its turn ended (a message ended the hold).
    const { state } = run([{ type: "workStarted", id: "c1", kind: "command" }]);
    expect(state.turn).toBeUndefined();
    const stopped = stepTurnMachine(state, { type: "stopRequested" });
    expect(stopped.commands).toContainEqual({ type: "sendCancel" });
    expect(stopped.state.running).toEqual([]);
    expect(stopped.state.stopping).toEqual({ commands: ["c1"], launches: [] });
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
    expect(commands.slice(-3)).toContainEqual({ type: "dropNotice" });
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

  it("re-checks the outcome before settling when the agent spoke after its prompt answered", () => {
    const held = run([
      { type: "send", sendId: "s1", turnId: "u1" },
      { type: "workStarted", id: "c1", kind: "command" },
      { type: "promptAnswered", prompt: 1 },
      { type: "outcomeRead", prompt: 1, outcome: outcome("completed") },
      { type: "workEnded", id: "c1" },
      { type: "agentOutput", newTurnId: "a1" },
      { type: "replyEnded" },
    ]).state;
    const settling = stepTurnMachine(held, fire(held, "settle"));
    expect(settling.commands).toContainEqual({ type: "readOutcome", prompt: 1 });
    expect(ends(settling.commands)).toEqual([]);
    const failed = stepTurnMachine(settling.state, {
      type: "outcomeRead",
      prompt: 1,
      outcome: outcome("failed", true),
    });
    expect(ends(failed.commands)).toEqual([
      {
        type: "endTurn",
        turnId: "u1",
        end: { kind: "answered", outcome: outcome("failed", true) },
      },
    ]);
    expect(failed.commands).toContainEqual({ type: "markSessionLost" });
    expect(failed.commands).toContainEqual({ type: "stopSession", reason: "sessionLost" });
  });
});
