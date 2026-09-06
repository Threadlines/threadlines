import type { SourceControlSetupState, SourceControlToolUpdateInput } from "@threadlines/contracts";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

export const EMPTY_SOURCE_CONTROL_SETUP: SourceControlSetupState = {
  tools: [],
  githubAuth: { status: "idle", verificationUrl: null, userCode: null, message: null },
};

export const sourceControlSetupStateAtom = Atom.family((key: string) =>
  Atom.make(EMPTY_SOURCE_CONTROL_SETUP).pipe(
    Atom.keepAlive,
    Atom.withLabel(`source-control-setup:${key}`),
  ),
);

export function isSourceControlToolBusy(
  status: SourceControlSetupState["tools"][number]["status"],
): boolean {
  return status === "queued" || status === "running" || status === "checking";
}

/** One poll per environment, shared by setup rows and settings while either is visible. */
export function createSourceControlSetupManager(config: {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  readonly getClient: (
    key: string,
  ) => { getSourceControlSetup: () => Promise<SourceControlSetupState> } | null;
  readonly onSettled: (key: string) => void;
}) {
  const watchers = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const requests = new Map<string, Promise<SourceControlSetupState | null>>();
  const knownKeys = new Set<string>();
  const revisions = new Map<string, number>();
  let generation = 0;

  function applySnapshot(key: string, next: SourceControlSetupState): void {
    knownKeys.add(key);
    const previous = config.getRegistry().get(sourceControlSetupStateAtom(key));
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    config.getRegistry().set(sourceControlSetupStateAtom(key), next);
    if (
      (next.githubAuth.status === "succeeded" && previous.githubAuth.status !== "succeeded") ||
      next.tools.some(
        (tool) =>
          !isSourceControlToolBusy(tool.status) &&
          previous.tools.find((candidate) => candidate.target === tool.target)?.status !==
            tool.status,
      )
    )
      config.onSettled(key);
  }

  function store(key: string, next: SourceControlSetupState): void {
    revisions.set(key, (revisions.get(key) ?? 0) + 1);
    applySnapshot(key, next);
    clearTimeout(timers.get(key));
    timers.delete(key);
    schedule(key);
  }

  function schedule(key: string): void {
    if (!watchers.has(key) || timers.has(key)) return;
    const state = config.getRegistry().get(sourceControlSetupStateAtom(key));
    const active =
      state.githubAuth.status === "running" ||
      state.tools.some((tool) => isSourceControlToolBusy(tool.status));
    timers.set(
      key,
      setTimeout(
        () => {
          timers.delete(key);
          void refresh(key);
        },
        active ? 1_000 : 5_000,
      ),
    );
  }

  function refresh(key: string): Promise<SourceControlSetupState | null> {
    const pending = requests.get(key);
    if (pending) return pending;
    const client = config.getClient(key);
    if (!client) {
      schedule(key);
      return Promise.resolve(null);
    }
    const currentGeneration = generation;
    const currentRevision = revisions.get(key) ?? 0;
    const request = Promise.resolve()
      .then(() => client.getSourceControlSetup())
      .then((state) => {
        if (currentGeneration === generation && currentRevision === (revisions.get(key) ?? 0))
          applySnapshot(key, state);
        return state;
      })
      .catch(() => null)
      .finally(() => {
        if (requests.get(key) === request) requests.delete(key);
        if (currentGeneration === generation) schedule(key);
      });
    requests.set(key, request);
    return request;
  }

  function watch(key: string): () => void {
    watchers.set(key, (watchers.get(key) ?? 0) + 1);
    void refresh(key);
    return () => {
      const count = (watchers.get(key) ?? 1) - 1;
      if (count > 0) {
        watchers.set(key, count);
        return;
      }
      watchers.delete(key);
      clearTimeout(timers.get(key));
      timers.delete(key);
    };
  }

  function markToolPending(key: string, input: SourceControlToolUpdateInput): void {
    const current = config.getRegistry().get(sourceControlSetupStateAtom(key));
    store(key, {
      ...current,
      tools: [
        ...current.tools.filter((tool) => tool.target !== input.target),
        {
          target: input.target,
          operation: input.operation ?? "update",
          status: "queued",
          message: "Waiting to start…",
        },
      ],
    });
  }

  return {
    refresh,
    watch,
    store,
    markToolPending,
    reset: () => {
      generation += 1;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      watchers.clear();
      requests.clear();
      revisions.clear();
      for (const key of knownKeys)
        config.getRegistry().set(sourceControlSetupStateAtom(key), EMPTY_SOURCE_CONTROL_SETUP);
      knownKeys.clear();
    },
  };
}
