import type {
  EnvironmentId,
  TerminalStreamEvent,
  TerminalSubscribeInput,
} from "@threadlines/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  acquireTerminalThreadStream,
  connectTerminalStreams,
  noteTerminalServerCapabilities,
  readTerminalBuffer,
  readTerminalProtocol,
  readTerminalThreadStreamState,
  resetTerminalStreamsForTests,
  subscribeTerminalBuffer,
} from "./terminalStreams";

const ENVIRONMENT_ID = "environment-1" as EnvironmentId;

function fakeClient() {
  const subscriptions: Array<{
    input: TerminalSubscribeInput;
    listener: (event: TerminalStreamEvent) => void;
    onResubscribe: (() => void) | undefined;
    active: boolean;
  }> = [];
  return {
    subscriptions,
    client: {
      terminal: {
        onEvent: (
          input: TerminalSubscribeInput,
          listener: (event: TerminalStreamEvent) => void,
          options?: { readonly onResubscribe?: () => void },
        ) => {
          const subscription = {
            input,
            listener,
            onResubscribe: options?.onResubscribe,
            active: true,
          };
          subscriptions.push(subscription);
          return () => {
            subscription.active = false;
          };
        },
      },
    },
    /** The connection came back (to the same server or a replaced one). */
    reconnect: () => {
      for (const subscription of subscriptions) {
        if (subscription.active) subscription.onResubscribe?.();
      }
    },
    emit: (mode: "metadata" | "thread", event: TerminalStreamEvent) => {
      for (const subscription of subscriptions) {
        if (subscription.active && (subscription.input.mode ?? "metadata") === mode) {
          subscription.listener(event);
        }
      }
    },
  };
}

const output = (threadId: string, data: string, terminalId = "default"): TerminalStreamEvent => ({
  type: "output",
  threadId,
  terminalId,
  createdAt: "2026-10-22T00:00:00.000Z",
  data,
});

const tab = (terminalId: string, number: number) => ({
  terminalId,
  number,
  cwd: null,
  status: "running" as const,
  exitCode: null,
  exitSignal: null,
  createdAt: "",
});

describe("terminalStreams", () => {
  afterEach(() => resetTerminalStreamsForTests());

  it("takes a thread's output from its own stream once the server says it is live", () => {
    const server = fakeClient();
    connectTerminalStreams(ENVIRONMENT_ID, server.client, () => undefined);
    server.emit("metadata", { type: "catalog", createdAt: "", threads: [] });
    const release = acquireTerminalThreadStream(ENVIRONMENT_ID, "thread-1");

    expect(readTerminalProtocol(ENVIRONMENT_ID)).toBe("catalog");
    expect(server.subscriptions.at(-1)?.input).toEqual({ mode: "thread", threadId: "thread-1" });
    expect(readTerminalThreadStreamState(ENVIRONMENT_ID, "thread-1").ready).toBe(false);

    server.emit("thread", { type: "subscribed", threadId: "thread-1", createdAt: "" });
    server.emit("thread", output("thread-1", "hello"));
    expect(readTerminalThreadStreamState(ENVIRONMENT_ID, "thread-1")).toEqual({
      ready: true,
      unsure: false,
      epoch: 1,
    });
    expect(
      readTerminalBuffer(ENVIRONMENT_ID, "thread-1", "default").entries.map(
        (entry) => entry.event.type === "output" && entry.event.data,
      ),
    ).toEqual(["hello"]);

    release();
    expect(server.subscriptions.at(-1)?.active).toBe(false);
    expect(readTerminalBuffer(ENVIRONMENT_ID, "thread-1", "default").entries).toEqual([]);
  });

  it("falls back to the one stream of a server from before tab lists", () => {
    const server = fakeClient();
    connectTerminalStreams(ENVIRONMENT_ID, server.client, () => undefined);
    const release = acquireTerminalThreadStream(ENVIRONMENT_ID, "thread-1");
    // An old server ignores the mode: the thread stream gets every thread and
    // no marker, and the first stream starts with whatever happens.
    server.emit("thread", output("thread-2", "not this thread"));
    server.emit("metadata", output("thread-1", "from the only stream"));

    expect(readTerminalProtocol(ENVIRONMENT_ID)).toBe("legacy");
    expect(readTerminalThreadStreamState(ENVIRONMENT_ID, "thread-1").ready).toBe(true);
    expect(
      readTerminalBuffer(ENVIRONMENT_ID, "thread-1", "default").entries.map(
        (entry) => entry.event.type === "output" && entry.event.data,
      ),
    ).toEqual(["from the only stream"]);
    expect(
      server.subscriptions.find((subscription) => subscription.input.mode === "thread")?.active,
    ).toBe(false);
    release();
  });

  it("opens a thread's tabs only once the server's tab lists are in", () => {
    const server = fakeClient();
    const applied: string[] = [];
    connectTerminalStreams(ENVIRONMENT_ID, server.client, (event) => applied.push(event.type));
    const release = acquireTerminalThreadStream(ENVIRONMENT_ID, "thread-1");

    server.emit("thread", { type: "subscribed", threadId: "thread-1", createdAt: "" });
    expect(readTerminalThreadStreamState(ENVIRONMENT_ID, "thread-1").ready).toBe(false);
    server.emit("metadata", { type: "catalog", createdAt: "", threads: [] });
    expect(readTerminalThreadStreamState(ENVIRONMENT_ID, "thread-1").ready).toBe(true);
    expect(applied).toEqual(["catalog"]);
    release();
  });

  it("goes by what the server says it is, and asks again when the connection comes back", () => {
    const server = fakeClient();
    noteTerminalServerCapabilities(ENVIRONMENT_ID, {
      repositoryIdentity: true,
      terminalTabLists: false,
    });
    connectTerminalStreams(ENVIRONMENT_ID, server.client, () => undefined);
    const release = acquireTerminalThreadStream(ENVIRONMENT_ID, "thread-1");
    // An older server: output from its one stream at once, no waiting.
    expect(readTerminalProtocol(ENVIRONMENT_ID)).toBe("legacy");
    expect(readTerminalThreadStreamState(ENVIRONMENT_ID, "thread-1").ready).toBe(true);
    expect(server.subscriptions.some((entry) => entry.input.mode === "thread")).toBe(false);

    // It was updated while the connection was down: until it says so, a tab
    // may open after a moment; once it has, only with its tab lists in.
    server.reconnect();
    expect(readTerminalThreadStreamState(ENVIRONMENT_ID, "thread-1")).toMatchObject({
      ready: false,
      unsure: true,
    });
    noteTerminalServerCapabilities(ENVIRONMENT_ID, {
      repositoryIdentity: true,
      terminalTabLists: true,
    });
    expect(readTerminalThreadStreamState(ENVIRONMENT_ID, "thread-1").unsure).toBe(false);
    server.emit("metadata", { type: "catalog", createdAt: "", threads: [] });
    expect(readTerminalProtocol(ENVIRONMENT_ID)).toBe("catalog");
    const threadStream = server.subscriptions.find((entry) => entry.input.mode === "thread");
    expect(threadStream?.active).toBe(true);
    expect(readTerminalThreadStreamState(ENVIRONMENT_ID, "thread-1").ready).toBe(false);
    server.emit("thread", { type: "subscribed", threadId: "thread-1", createdAt: "" });
    expect(readTerminalThreadStreamState(ENVIRONMENT_ID, "thread-1").ready).toBe(true);

    // And back to an older one.
    server.reconnect();
    noteTerminalServerCapabilities(ENVIRONMENT_ID, { repositoryIdentity: true });
    expect(readTerminalProtocol(ENVIRONMENT_ID)).toBe("legacy");
    expect(threadStream?.active).toBe(false);
    expect(readTerminalThreadStreamState(ENVIRONMENT_ID, "thread-1").ready).toBe(true);
    release();
  });

  it("forgets the output of a tab closed elsewhere once nothing shows it", () => {
    const server = fakeClient();
    connectTerminalStreams(ENVIRONMENT_ID, server.client, () => undefined);
    const release = acquireTerminalThreadStream(ENVIRONMENT_ID, "thread-1");
    server.emit("metadata", {
      type: "catalog",
      createdAt: "",
      threads: [{ threadId: "thread-1", tabs: [tab("default", 1), tab("terminal-2", 2)] }],
    });
    server.emit("thread", { type: "subscribed", threadId: "thread-1", createdAt: "" });
    const unsubscribe = subscribeTerminalBuffer(
      ENVIRONMENT_ID,
      "thread-1",
      "terminal-2",
      () => undefined,
    );
    server.emit("thread", output("thread-1", "bye", "terminal-2"));
    server.emit("metadata", {
      type: "tabs",
      threadId: "thread-1",
      createdAt: "",
      tabs: [tab("default", 1)],
    });
    // Still on screen until its view goes.
    expect(readTerminalBuffer(ENVIRONMENT_ID, "thread-1", "terminal-2").entries).toHaveLength(1);
    unsubscribe();
    expect(readTerminalBuffer(ENVIRONMENT_ID, "thread-1", "terminal-2").entries).toEqual([]);
    // Its last words, after the list said it closed, are not kept either.
    server.emit("thread", output("thread-1", "late", "terminal-2"));
    expect(readTerminalBuffer(ENVIRONMENT_ID, "thread-1", "terminal-2").entries).toEqual([]);
    release();
  });
});
