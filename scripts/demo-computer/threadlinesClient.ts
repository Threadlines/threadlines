// @effect-diagnostics globalConsole:off globalDate:off globalTimers:off nodeBuiltinImport:off
/**
 * The smallest Threadlines client the demo computer's fixtures need, with no
 * dependencies: Node's own fetch and WebSocket. It signs in with an owner
 * bearer token (`threadlines auth session issue`), then speaks the app's
 * WebSocket RPC (Effect RPC, JSON) like the web client does:
 * `orchestration.dispatchCommand` (which, unlike the HTTP route, runs a first
 * send's bootstrap: the worktree and the thread) and
 * `orchestration.subscribeShell` (every project and thread, live).
 */

type JsonObject = { readonly [key: string]: unknown };

export interface ThreadShell {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly latestTurn: { readonly state: string } | null;
  readonly session: { readonly status: string; readonly activeTurnId: string | null } | null;
}

export interface ProjectShell {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

/** The parts of the shell this client follows: every project and thread by id. */
export interface ShellState {
  readonly projects: Map<string, ProjectShell>;
  readonly threads: Map<string, ThreadShell>;
}

export interface ThreadlinesClient {
  /** Dispatches an orchestration command, as the app does. */
  readonly dispatch: (command: JsonObject) => Promise<unknown>;
  /** Any other unary method of the WebSocket RPC table (packages/contracts/src/rpc.ts). */
  readonly request: (tag: string, payload: unknown) => Promise<unknown>;
  /** Live projects and threads; resolves once the first snapshot is in. */
  readonly shell: () => Promise<ShellState>;
  /** Resolves when `predicate` holds for the shell, or rejects after `timeoutMs`. */
  readonly waitFor: <T>(
    describe: string,
    predicate: (state: ShellState) => T | undefined,
    timeoutMs?: number,
  ) => Promise<T>;
  readonly close: () => void;
}

class RpcFailure extends Error {}

/** `threadStatus` (apps/server/src/threads/threadOperations.ts), the words the tools use. */
export function statusOf(thread: ThreadShell): string {
  if (thread.hasPendingApprovals) return "needs the user (approval)";
  if (thread.hasPendingUserInput) return "needs the user (question)";
  const session = thread.session;
  if (
    thread.latestTurn?.state === "running" ||
    (session !== null &&
      (session.activeTurnId !== null ||
        session.status === "running" ||
        session.status === "starting"))
  ) {
    return "working";
  }
  if (thread.latestTurn?.state === "error" || session?.status === "error") return "failed";
  return "idle";
}

export async function connectThreadlines(input: {
  readonly serverUrl: string;
  readonly token: string;
}): Promise<ThreadlinesClient> {
  const base = input.serverUrl.replace(/\/+$/u, "");
  const issued = await fetch(`${base}/api/auth/ws-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.token}` },
  }).catch((cause: unknown) => {
    throw new Error(`Couldn't reach Threadlines at ${base}: ${String(cause)}`);
  });
  if (!issued.ok) {
    throw new Error(
      `Threadlines refused the owner token (${issued.status} ${await issued.text()}).`,
    );
  }
  const { token: wsToken } = (await issued.json()) as { token: string };
  const socketUrl = `${base.replace(/^http/u, "ws")}/ws?wsToken=${encodeURIComponent(wsToken)}`;
  const socket = new WebSocket(socketUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`Couldn't open ${base}/ws.`)), {
      once: true,
    });
  });

  let nextId = 1;
  const exits = new Map<
    string,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >();
  const chunkHandlers = new Map<string, (value: unknown) => void>();
  const state: ShellState = { projects: new Map(), threads: new Map() };
  const watchers = new Set<() => void>();
  let snapshotIn: () => void = () => {};
  const firstSnapshot = new Promise<void>((resolve) => {
    snapshotIn = resolve;
  });

  const write = (message: JsonObject) => socket.send(JSON.stringify(message));

  socket.addEventListener("message", (event) => {
    const decoded = JSON.parse(String(event.data)) as unknown;
    for (const raw of Array.isArray(decoded) ? decoded : [decoded]) {
      const message = raw as JsonObject;
      const requestId = String(message.requestId ?? "");
      if (message._tag === "Chunk") {
        const handler = chunkHandlers.get(requestId);
        for (const value of (message.values as ReadonlyArray<unknown>) ?? []) handler?.(value);
        // The server sends the next chunk only after this.
        write({ _tag: "Ack", requestId });
      } else if (message._tag === "Exit") {
        const waiting = exits.get(requestId);
        exits.delete(requestId);
        chunkHandlers.delete(requestId);
        const exit = message.exit as JsonObject;
        if (exit._tag === "Success") waiting?.resolve(exit.value);
        else waiting?.reject(new RpcFailure(describeCause(exit.cause)));
      } else if (message._tag === "Defect") {
        for (const waiting of exits.values())
          waiting.reject(new RpcFailure(JSON.stringify(message)));
        exits.clear();
      }
    }
  });
  socket.addEventListener("close", () => {
    for (const waiting of exits.values()) waiting.reject(new Error("The connection closed."));
    exits.clear();
  });

  const call = (tag: string, payload: unknown, onChunk?: (value: unknown) => void) => {
    const id = String(nextId++);
    if (onChunk) chunkHandlers.set(id, onChunk);
    return new Promise<unknown>((resolve, reject) => {
      exits.set(id, { resolve, reject });
      write({ _tag: "Request", id, tag, payload, headers: [] });
    });
  };

  const applyShellItem = (item: JsonObject) => {
    switch (item.kind) {
      case "snapshot": {
        const snapshot = item.snapshot as {
          readonly projects: ReadonlyArray<ProjectShell>;
          readonly threads: ReadonlyArray<ThreadShell>;
        };
        state.projects.clear();
        state.threads.clear();
        for (const project of snapshot.projects) state.projects.set(project.id, project);
        for (const thread of snapshot.threads) state.threads.set(thread.id, thread);
        snapshotIn();
        break;
      }
      case "project-upserted": {
        const project = item.project as ProjectShell;
        state.projects.set(project.id, project);
        break;
      }
      case "project-removed":
        state.projects.delete(String(item.projectId));
        break;
      case "thread-upserted": {
        const thread = item.thread as ThreadShell;
        state.threads.set(thread.id, thread);
        break;
      }
      case "thread-removed":
        state.threads.delete(String(item.threadId));
        break;
    }
    for (const watcher of watchers) watcher();
  };
  // Runs for as long as the socket is open; its exit only comes on close.
  call("orchestration.subscribeShell", {}, (value) => applyShellItem(value as JsonObject)).catch(
    () => {},
  );

  return {
    dispatch: (command) => call("orchestration.dispatchCommand", command),
    request: (tag, payload) => call(tag, payload),
    shell: async () => {
      await firstSnapshot;
      return state;
    },
    waitFor: async (describe, predicate, timeoutMs = 60_000) => {
      await firstSnapshot;
      const now = predicate(state);
      if (now !== undefined) return now;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          watchers.delete(check);
          reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${describe}.`));
        }, timeoutMs);
        const check = () => {
          const value = predicate(state);
          if (value === undefined) return;
          clearTimeout(timer);
          watchers.delete(check);
          resolve(value);
        };
        watchers.add(check);
      });
    },
    close: () => socket.close(),
  };
}

function describeCause(cause: unknown): string {
  const first = (Array.isArray(cause) ? cause[0] : cause) as JsonObject | undefined;
  const error = (first?.error ?? first?.defect) as JsonObject | string | undefined;
  if (typeof error === "string") return error;
  return String(error?.message ?? JSON.stringify(cause));
}
