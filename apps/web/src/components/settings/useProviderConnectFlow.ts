/**
 * The React side of the server-run provider sign-in.
 *
 * `ProviderAuthSessions` runs the provider's own login command in an ephemeral
 * server-side PTY and streams command/output/status back over
 * `providerAuth.subscribe`. This hook owns that subscription, folds the events
 * into `ProviderConnectFlowState`, opens the run's sign-in page for the
 * surface that started it, and decides when a run has stalled long enough to
 * deserve the interactive terminal.
 *
 * It exists so every "Sign in" in the app drives the same flow: the settings
 * page, the setup screen, and the composer notices all mount this and differ
 * only in how much of the state they draw. The run happens on the computer
 * that runs the provider (`environmentId`, see `providerComputer`): a thread
 * on another computer signs in there, not on the one the app's settings
 * talk to.
 *
 * @module useProviderConnectFlow
 */
import type {
  EnvironmentId,
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

import {
  computerReplaysSignInAddresses,
  isProviderComputerThisOne,
  useProviderAuthClient,
} from "../../environments/providerComputer";
import { loopbackRedirectOfSignInPage } from "@threadlines/shared/signInRedirect";

import { randomUUID } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { useIsCommunityAgent } from "./communityAgents";
import {
  applyProviderAuthEvent,
  initialProviderConnectFlowState,
  isProviderConnectFlowActive,
  shouldAutoExpandTerminal,
  shouldOpenPrintedPage,
  type ProviderConnectFlowState,
} from "./providerConnectFlow.logic";

/** Why a sign-in can't start: this app has no connection to the computer that would run it. */
export const PROVIDER_COMPUTER_UNREACHABLE =
  "The computer this agent runs on isn't connected right now.";

/**
 * Sign-in pages this tab already opened, per run: two surfaces can own one
 * run (the one that started it and one that answered its question), while a
 * later run may print the same page (a fixed device page) and must open it.
 */
const openedSignInPages = new Set<string>();

/** Opens a run's sign-in page unless this tab already did for that run. */
export function openProviderSignInUrlOnce(flowId: string, url: string): void {
  const key = `${flowId}\n${url}`;
  if (openedSignInPages.has(key)) return;
  openedSignInPages.add(key);
  void ensureLocalApi()
    .shell.openExternal(url)
    .catch(() => {
      // Settings keeps a button to open it by hand.
    });
}

/**
 * A terminal run's page can be finished from this device: it ends on the
 * signing-in computer's loopback, and that computer replays a pasted address.
 */
function finishesByPastedAddress(environmentId: EnvironmentId | null, pageUrl: string): boolean {
  return (
    loopbackRedirectOfSignInPage(pageUrl) !== null && computerReplaysSignInAddresses(environmentId)
  );
}

/** Clears a terminal (RIS) before a replay redraws it. */
const TERMINAL_RESET = "\u001bc";

/** Default PTY geometry for a flow started from a surface with no terminal. */
export const PROVIDER_CONNECT_TERMINAL_COLS = 100;
export const PROVIDER_CONNECT_TERMINAL_ROWS = 20;
const AUTO_EXPAND_TICK_MS = 1_000;
/** Cap on replayed scrollback held for a terminal that mounts mid-flow. */
const OUTPUT_BUFFER_CHARS = 64_000;

export interface ProviderConnectFlowController {
  readonly state: ProviderConnectFlowState;
  /** Finishes a browser sign-in with the address the browser ended on. */
  readonly submitRedirect: (url: string) => Promise<void>;
  /**
   * Answers the page the agent asked to have opened (`state.pageRequest`):
   * `true` once the user chose to open it, `false` to refuse.
   */
  readonly answerPageRequest: (accept: boolean) => Promise<void>;
  /**
   * Answers what the agent asked (`state.question`): the chosen option's id
   * or the typed text, or null to cancel. Rejects with the server's reason.
   * The surface that answers opens the pages that follow, like one that
   * started the run.
   */
  readonly answerQuestion: (value: string | null) => Promise<void>;
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
  /** This app has a connection to the computer that runs the provider. */
  readonly canReachComputer: boolean;
  /**
   * The run's page ends on an address only the computer running it can reach
   * and this device isn't that computer: the user pastes the address the
   * browser ended on (`submitRedirect`). Browser sign-ins always take it.
   */
  readonly takesPastedAddress: boolean;
  readonly outputBufferRef: RefObject<string>;
  readonly terminalWriteRef: RefObject<((data: string) => void) | null>;
  /**
   * Starts the flow. `terminal` asks for the agent's own terminal sign-in
   * where the flow would otherwise ask its questions in the panel (Pi).
   */
  readonly start: (options?: { readonly terminal?: boolean }) => void;
  /** Cancels the server session and clears everything this hook is showing. */
  readonly reset: () => void;
  /** Ends any run on the instance, not only this hook's, and resolves once the server has. */
  readonly stopAnyRun: () => Promise<void>;
  /** Types into the run's terminal (the interactive one behind "Show details"). */
  readonly writeTerminal: (data: string) => void;
  /** Tells the run's terminal its size. */
  readonly resizeTerminal: (cols: number, rows: number) => void;
}

export function useProviderConnectFlow(input: {
  readonly instanceId: ProviderInstanceId | null;
  /** The computer that runs the provider; null (the default) is the app's own backend. */
  readonly environmentId?: EnvironmentId | null | undefined;
  readonly flow: ProviderAuthFlow;
  /** Fired once per run that ends in `succeeded`. */
  readonly onSucceeded?: (() => void) | undefined;
  /** Fired when the start RPC rejects, for surfaces that toast instead of inlining. */
  readonly onStartError?: ((error: unknown) => void) | undefined;
}): ProviderConnectFlowController {
  const { flow, instanceId, onStartError, onSucceeded } = input;
  const environmentId = input.environmentId ?? null;
  const providerAuth = useProviderAuthClient(environmentId);
  const [state, setState] = useState<ProviderConnectFlowState>(initialProviderConnectFlowState);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [runningForMs, setRunningForMs] = useState(0);
  const [hasRun, setHasRun] = useState(false);
  // Another instance, or the same one on another computer (the composer
  // following the user to a thread elsewhere), is another sign-in: nothing
  // shown for the last one carries over while the new one's replay arrives.
  const targetKey = `${environmentId ?? ""}\u0000${instanceId ?? ""}`;
  const [shownTargetKey, setShownTargetKey] = useState(targetKey);
  if (shownTargetKey !== targetKey) {
    setShownTargetKey(targetKey);
    setState(initialProviderConnectFlowState);
    setIsStarting(false);
    setStartError(null);
    setHasRun(false);
  }
  // Every attach replays the run from the start, and a computer that
  // reconnected is a new client: the replay redraws what the last attach
  // showed, a page from an older run included (refs clear in the effect).
  const [shownClient, setShownClient] = useState(providerAuth);
  if (shownClient !== providerAuth) {
    setShownClient(providerAuth);
    setState(initialProviderConnectFlowState);
  }
  // Whether the success we are about to see belongs to a run we watched begin.
  // Without it, attaching to a session that already succeeded would replay that
  // status and fire `onSucceeded` for something the user did minutes ago.
  const runObservedRef = useRef(false);
  // The run this consumer's own `start` began: the server echoes the start's
  // `requestId` on that run's command event. Every client watching the
  // instance sees every run; only the one the user clicked in opens pages for
  // it, and only for that run.
  const requestIdRef = useRef<string | null>(null);
  const ownedFlowIdRef = useRef<string | null>(null);
  const outputBufferRef = useRef("");
  const terminalWriteRef = useRef<((data: string) => void) | null>(null);
  // An instance has one auth session but can back two panels (sign-in and
  // token setup). Sessions announce their flow in the "command" event; a
  // consumer ignores sessions that belong to the other flow.
  const sessionFlowRef = useRef<ProviderAuthFlow | null>(null);

  const handleEvent = useEffectEvent((event: ProviderAuthEvent) => {
    if (event.type === "command") {
      if (requestIdRef.current !== null && event.requestId === requestIdRef.current) {
        ownedFlowIdRef.current = event.flowId ?? null;
      }
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
  const subscribedTargetKeyRef = useRef(targetKey);
  useEffect(() => {
    if (subscribedTargetKeyRef.current !== targetKey) {
      subscribedTargetKeyRef.current = targetKey;
      outputBufferRef.current = "";
      sessionFlowRef.current = null;
      runObservedRef.current = false;
      requestIdRef.current = null;
      ownedFlowIdRef.current = null;
    }
    if (instanceId === null || providerAuth === null) {
      return;
    }
    // The replay redraws the output and the terminal too.
    outputBufferRef.current = "";
    sessionFlowRef.current = null;
    terminalWriteRef.current?.(TERMINAL_RESET);
    let cancelled = false;
    const unsubscribe = providerAuth.subscribe({ instanceId }, (event) => {
      if (cancelled) return;
      handleEvent(event);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [instanceId, providerAuth, targetKey]);

  const isActive = isProviderConnectFlowActive(state.status);

  // A community agent's links are never opened for the user: Threadlines
  // hasn't tested the agent, and the address is the agent's own.
  const opensLinksItself = !useIsCommunityAgent(instanceId, environmentId);

  // The run's sign-in page opens on whichever surface the user started it
  // from: a browser sign-in has no CLI to open it, and a CLI that cannot
  // (fx inside WSL) prints a device-code page and waits. Where the command or
  // agent already opened it, a second tab would be a duplicate.
  useEffect(() => {
    if (!opensLinksItself || !isActive || state.signInUrl === null) return;
    if (state.flowId === null || state.flowId !== ownedFlowIdRef.current) return;
    const opens = shouldOpenPrintedPage({
      surface: state.surface,
      opensPageItself: state.opensPageItself,
      // Read here, not on every render: this hook sits on the composer's.
      onServerComputer: isProviderComputerThisOne(environmentId),
      finishesByPaste: finishesByPastedAddress(environmentId, state.signInUrl),
    });
    if (opens) openProviderSignInUrlOnce(state.flowId, state.signInUrl);
  }, [
    environmentId,
    isActive,
    opensLinksItself,
    state.flowId,
    state.opensPageItself,
    state.signInUrl,
    state.surface,
  ]);

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

  const start = useCallback(
    (options?: { readonly terminal?: boolean }) => {
      if (instanceId === null) {
        return;
      }
      if (providerAuth === null) {
        // Said where the user clicked, not dropped: a button that does
        // nothing reads as broken.
        setHasRun(true);
        setStartError(PROVIDER_COMPUTER_UNREACHABLE);
        onStartError?.(new Error(PROVIDER_COMPUTER_UNREACHABLE));
        return;
      }
      outputBufferRef.current = "";
      sessionFlowRef.current = null;
      const requestId = randomUUID();
      requestIdRef.current = requestId;
      ownedFlowIdRef.current = null;
      setState(initialProviderConnectFlowState);
      setStartError(null);
      setHasRun(true);
      setIsStarting(true);
      // A newer start, a reset, or another computer took the row since: this
      // answer is no longer the row's to report.
      const isCurrentStart = () => requestIdRef.current === requestId;
      void providerAuth
        .start({
          instanceId,
          flow,
          cols: PROVIDER_CONNECT_TERMINAL_COLS,
          rows: PROVIDER_CONNECT_TERMINAL_ROWS,
          requestId,
          questions: options?.terminal !== true,
        })
        .then(
          () => {
            if (isCurrentStart()) setIsStarting(false);
          },
          (error: unknown) => {
            if (!isCurrentStart()) return;
            requestIdRef.current = null;
            setIsStarting(false);
            setStartError(
              error instanceof Error ? error.message : "The sign-in command could not be started.",
            );
            onStartError?.(error);
          },
        );
    },
    [flow, instanceId, onStartError, providerAuth],
  );

  const flowId = state.flowId;
  const clearLocalState = useCallback(() => {
    outputBufferRef.current = "";
    sessionFlowRef.current = null;
    runObservedRef.current = false;
    requestIdRef.current = null;
    ownedFlowIdRef.current = null;
    setState(initialProviderConnectFlowState);
    setIsStarting(false);
    setStartError(null);
    setHasRun(false);
  }, []);
  const reset = useCallback(() => {
    if (instanceId !== null) {
      void providerAuth?.stop({ instanceId, ...(flowId ? { flowId } : {}) }).catch(() => {});
    }
    clearLocalState();
  }, [clearLocalState, flowId, instanceId, providerAuth]);

  /**
   * Ends whatever sign-in the instance is running, whoever started it, and
   * resolves once the server has: the caller is about to replace the
   * settings that run belongs to.
   */
  const stopAnyRun = useCallback(async () => {
    if (instanceId !== null && providerAuth !== null) {
      await providerAuth.stop({ instanceId }).catch(() => {});
    }
    clearLocalState();
  }, [clearLocalState, instanceId, providerAuth]);

  /**
   * Hands a browser sign-in the address the browser ended on (another
   * device's unreachable 127.0.0.1 page). Rejects with the server's reason.
   */
  const submitRedirect = useCallback(
    async (url: string) => {
      if (instanceId === null) return;
      if (providerAuth === null) throw new Error(PROVIDER_COMPUTER_UNREACHABLE);
      await providerAuth.write({
        instanceId,
        data: url,
        redirect: true,
        ...(flowId ? { flowId } : {}),
      });
    },
    [flowId, instanceId, providerAuth],
  );

  const pageRequestId = state.pageRequest?.requestId ?? null;
  const answerPageRequest = useCallback(
    async (accept: boolean) => {
      if (instanceId === null || flowId === null || pageRequestId === null) {
        return;
      }
      if (providerAuth === null) throw new Error(PROVIDER_COMPUTER_UNREACHABLE);
      await providerAuth.respond({ instanceId, flowId, requestId: pageRequestId, accept });
    },
    [flowId, instanceId, pageRequestId, providerAuth],
  );

  const questionId = state.question?.requestId ?? null;
  const answerQuestion = useCallback(
    async (value: string | null) => {
      if (instanceId === null || flowId === null || questionId === null) {
        return;
      }
      if (providerAuth === null) throw new Error(PROVIDER_COMPUTER_UNREACHABLE);
      // The page this answer leads to opens here, even for a run another
      // surface started (the composer hands a question off to Settings).
      // Claimed first: the page can arrive before the answer's reply.
      ownedFlowIdRef.current = flowId;
      await providerAuth.respond({
        instanceId,
        flowId,
        requestId: questionId,
        accept: value !== null,
        ...(value !== null ? { value } : {}),
      });
    },
    [flowId, instanceId, providerAuth, questionId],
  );

  const writeTerminal = useCallback(
    (data: string) => {
      if (instanceId === null || providerAuth === null) return;
      void providerAuth.write({ instanceId, data }).catch(() => {
        // The panel's status line already reports a dead session.
      });
    },
    [instanceId, providerAuth],
  );
  const resizeTerminal = useCallback(
    (cols: number, rows: number) => {
      if (instanceId === null || providerAuth === null) return;
      void providerAuth.resize({ instanceId, cols, rows }).catch(() => {});
    },
    [instanceId, providerAuth],
  );

  const needsTerminal = shouldAutoExpandTerminal({ status: state.status, runningForMs });
  const takesPastedAddress =
    isActive &&
    state.signInUrl !== null &&
    (state.surface === "browser" ||
      (!isProviderComputerThisOne(environmentId) &&
        finishesByPastedAddress(environmentId, state.signInUrl)));

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
      canReachComputer: providerAuth !== null,
      takesPastedAddress,
      outputBufferRef,
      terminalWriteRef,
      start,
      reset,
      stopAnyRun,
      submitRedirect,
      answerPageRequest,
      answerQuestion,
      writeTerminal,
      resizeTerminal,
    }),
    [
      answerPageRequest,
      answerQuestion,
      hasRun,
      isActive,
      isStarting,
      needsTerminal,
      providerAuth,
      reset,
      resizeTerminal,
      start,
      startError,
      state,
      stopAnyRun,
      submitRedirect,
      takesPastedAddress,
      writeTerminal,
    ],
  );
}
