/**
 * The React side of the server-run provider sign-in.
 *
 * `ProviderAuthSessions` runs the provider's own login command in an ephemeral
 * server-side PTY and streams command/output/status back over
 * `providerAuth.subscribe`. This hook owns that subscription, folds the events
 * into `ProviderConnectFlowState`, and decides when a run has stalled long
 * enough to deserve the interactive terminal.
 *
 * It exists so every "Sign in" in the app drives the same flow: the settings
 * panel, the first-run setup card, and the composer notices all mount this and
 * differ only in how much of the state they draw.
 *
 * @module useProviderConnectFlow
 */
import type {
  ProviderAuthEvent,
  ProviderAuthFlow,
  ProviderInstanceId,
} from "@threadlines/contracts";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import { getPrimaryEnvironmentConnection } from "../../environments/runtime";
import {
  applyProviderAuthEvent,
  initialProviderConnectFlowState,
  isProviderConnectFlowActive,
  shouldAutoExpandTerminal,
  type ProviderConnectFlowState,
} from "./providerConnectFlow.logic";

type ProviderAuthClient = ReturnType<
  typeof getPrimaryEnvironmentConnection
>["client"]["providerAuth"];

/**
 * The primary environment throws before the app has one (a hosted browser tab
 * that has not paired yet, or a test harness that mounts a surface on its
 * own). Sign-in is not available there, and a surface must not crash for
 * asking.
 */
function readProviderAuthClient(): ProviderAuthClient | null {
  try {
    return getPrimaryEnvironmentConnection().client.providerAuth;
  } catch {
    return null;
  }
}

/** Default PTY geometry for a flow started from a surface with no terminal. */
export const PROVIDER_CONNECT_TERMINAL_COLS = 100;
export const PROVIDER_CONNECT_TERMINAL_ROWS = 20;
const AUTO_EXPAND_TICK_MS = 1_000;
/** Cap on replayed scrollback held for a terminal that mounts mid-flow. */
const OUTPUT_BUFFER_CHARS = 64_000;

export interface ProviderConnectFlowController {
  readonly state: ProviderConnectFlowState;
  /** True between the start click and the server's first status event. */
  readonly isStarting: boolean;
  /** True while the server reports the flow starting or running. */
  readonly isActive: boolean;
  /**
   * True once this consumer has seen a run of its own begin. Attaching to a
   * finished session replays its terminal status, so surfaces that only want
   * to report runs the user just triggered gate on this rather than on
   * `state.status`.
   */
  readonly hasRun: boolean;
  /**
   * True once a still-running flow has passed the auto-expand threshold, or as
   * soon as one fails: both mean the raw transcript is now the useful thing.
   */
  readonly needsTerminal: boolean;
  /** Why the start RPC itself failed, as opposed to the login command failing. */
  readonly startError: string | null;
  readonly outputBufferRef: RefObject<string>;
  readonly terminalWriteRef: RefObject<((data: string) => void) | null>;
  readonly start: () => void;
  /** Cancels the server session and clears everything this hook is showing. */
  readonly reset: () => void;
}

export function useProviderConnectFlow(input: {
  readonly instanceId: ProviderInstanceId | null;
  readonly flow: ProviderAuthFlow;
  /** Fired once per run that ends in `succeeded`. */
  readonly onSucceeded?: (() => void) | undefined;
  /** Fired when the start RPC rejects, for surfaces that toast instead of inlining. */
  readonly onStartError?: ((error: unknown) => void) | undefined;
}): ProviderConnectFlowController {
  const { flow, instanceId, onStartError, onSucceeded } = input;
  const [state, setState] = useState<ProviderConnectFlowState>(initialProviderConnectFlowState);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [runningForMs, setRunningForMs] = useState(0);
  const [hasRun, setHasRun] = useState(false);
  // Whether the success we are about to see belongs to a run we watched begin.
  // Without it, attaching to a session that already succeeded would replay that
  // status and fire `onSucceeded` for something the user did minutes ago.
  const runObservedRef = useRef(false);
  const outputBufferRef = useRef("");
  const terminalWriteRef = useRef<((data: string) => void) | null>(null);
  // An instance has one auth session but can back two panels (sign-in and
  // token setup). Sessions announce their flow in the "command" event; a
  // consumer ignores sessions that belong to the other flow.
  const sessionFlowRef = useRef<ProviderAuthFlow | null>(null);

  const handleEvent = useEffectEvent((event: ProviderAuthEvent) => {
    if (event.type === "command") {
      sessionFlowRef.current = event.flow;
      if (event.flow !== flow) {
        outputBufferRef.current = "";
        setState(initialProviderConnectFlowState);
        return;
      }
    } else if (sessionFlowRef.current !== flow) {
      // The server announces a session's command (and flow) before any output
      // or status, so anything arriving unclaimed belongs to the other flow.
      return;
    }
    if (event.type === "output") {
      outputBufferRef.current = `${outputBufferRef.current}${event.data}`.slice(
        -OUTPUT_BUFFER_CHARS,
      );
      terminalWriteRef.current?.(event.data);
    }
    if (event.type === "status") {
      if (event.status === "starting" || event.status === "running") {
        runObservedRef.current = true;
        setHasRun(true);
      } else if (event.status === "succeeded") {
        if (runObservedRef.current) {
          runObservedRef.current = false;
          onSucceeded?.();
        }
      } else if (event.status === "failed") {
        runObservedRef.current = false;
      }
    }
    setState((previous) => applyProviderAuthEvent(previous, event));
  });

  // Subscribed for the consumer's whole lifetime, not just after a click: the
  // server replays the command, buffered output, and status on attach, so a
  // flow started on another surface (or before a remount) lands here too. That
  // replay is also what keeps two surfaces from racing a second sign-in — both
  // see the same live session and disable their action.
  useEffect(() => {
    if (instanceId === null) {
      return;
    }
    const providerAuth = readProviderAuthClient();
    if (providerAuth === null) {
      return;
    }
    let cancelled = false;
    const unsubscribe = providerAuth.subscribe({ instanceId }, (event) => {
      if (cancelled) return;
      handleEvent(event);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [instanceId]);

  const isActive = isProviderConnectFlowActive(state.status);

  useEffect(() => {
    if (!isActive) {
      setRunningForMs(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setRunningForMs(Date.now() - startedAt),
      AUTO_EXPAND_TICK_MS,
    );
    return () => window.clearInterval(timer);
  }, [isActive]);

  const start = useCallback(() => {
    const providerAuth = readProviderAuthClient();
    if (instanceId === null || providerAuth === null) {
      return;
    }
    outputBufferRef.current = "";
    sessionFlowRef.current = null;
    setState(initialProviderConnectFlowState);
    setStartError(null);
    setHasRun(true);
    setIsStarting(true);
    void providerAuth
      .start({
        instanceId,
        flow,
        cols: PROVIDER_CONNECT_TERMINAL_COLS,
        rows: PROVIDER_CONNECT_TERMINAL_ROWS,
      })
      .catch((error: unknown) => {
        setStartError(
          error instanceof Error ? error.message : "The sign-in command could not be started.",
        );
        onStartError?.(error);
      })
      .finally(() => {
        setIsStarting(false);
      });
  }, [flow, instanceId, onStartError]);

  const reset = useCallback(() => {
    if (instanceId !== null) {
      void readProviderAuthClient()
        ?.stop({ instanceId })
        .catch(() => {});
    }
    outputBufferRef.current = "";
    sessionFlowRef.current = null;
    runObservedRef.current = false;
    setState(initialProviderConnectFlowState);
    setStartError(null);
    setHasRun(false);
  }, [instanceId]);

  const needsTerminal = shouldAutoExpandTerminal({ status: state.status, runningForMs });

  // Stable identity: consumers feed this straight into notice `useMemo`s that
  // sit on the composer's render path.
  return useMemo(
    () => ({
      state,
      isStarting,
      isActive,
      hasRun,
      needsTerminal,
      startError,
      outputBufferRef,
      terminalWriteRef,
      start,
      reset,
    }),
    [hasRun, isActive, isStarting, needsTerminal, reset, start, startError, state],
  );
}
