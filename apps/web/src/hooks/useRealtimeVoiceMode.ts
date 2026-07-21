import type {
  EnvironmentApi,
  ProviderRealtimeAudioChunk,
  ProviderRealtimeOutputModality,
  ThreadId,
} from "@threadlines/contracts";
import { useCallback, useEffect, useRef } from "react";
import { readEnvironmentApi } from "../environmentApi";
import { newCommandId } from "../lib/utils";
import {
  describeMicrophoneError,
  RealtimeAudioPlayback,
  RealtimeMicCapture,
} from "../realtimeAudio";
import { pcm16ToBase64, REALTIME_AUDIO_SAMPLE_RATE } from "../realtimeAudioLogic";
import {
  DEFAULT_REALTIME_VOICE_STATE,
  readRealtimeVoiceState,
  useRealtimeVoiceStore,
} from "../realtimeVoiceState";

const VOICE_START_TIMEOUT_MS = 15_000;

type RealtimeAudioSubscription = (
  input: { readonly threadId: ThreadId },
  listener: (chunk: ProviderRealtimeAudioChunk) => void,
  options?: { readonly onComplete?: () => void },
) => () => void;

interface UseRealtimeVoiceModeInput {
  readonly threadId: ThreadId | null;
  readonly environmentId: Parameters<typeof readEnvironmentApi>[0];
  readonly supported: boolean;
  readonly canStart: boolean;
  readonly connectionAvailable: boolean;
  readonly projectedActive: boolean;
}

export interface RealtimeVoiceModeControl {
  readonly state: typeof DEFAULT_REALTIME_VOICE_STATE;
  readonly projectedActive: boolean;
  readonly start: () => void;
  readonly toggleMute: () => void;
  readonly stop: () => void;
  readonly setModality: (modality: ProviderRealtimeOutputModality) => void;
}

function dispatchRealtimeStop(api: EnvironmentApi, threadId: ThreadId): void {
  void api.orchestration
    .dispatchCommand({
      type: "thread.realtime.stop",
      commandId: newCommandId(),
      threadId,
      createdAt: new Date().toISOString(),
    })
    .catch(() => undefined);
}

export function useRealtimeVoiceMode(input: UseRealtimeVoiceModeInput): RealtimeVoiceModeControl {
  const state = useRealtimeVoiceStore((store) =>
    input.threadId
      ? (store.byThreadId[input.threadId] ?? DEFAULT_REALTIME_VOICE_STATE)
      : DEFAULT_REALTIME_VOICE_STATE,
  );
  const dispatch = useRealtimeVoiceStore((store) => store.dispatch);
  const captureRef = useRef<RealtimeMicCapture | null>(null);
  const playbackRef = useRef<RealtimeAudioPlayback | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const subscriptionThreadRef = useRef<ThreadId | null>(null);
  const startTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appendInFlightRef = useRef(false);
  const generationRef = useRef(0);
  const connectionAvailableRef = useRef(input.connectionAvailable);
  connectionAvailableRef.current = input.connectionAvailable;

  const stopResources = useCallback(() => {
    generationRef.current += 1;
    appendInFlightRef.current = false;
    if (startTimeoutRef.current !== null) {
      clearTimeout(startTimeoutRef.current);
      startTimeoutRef.current = null;
    }
    captureRef.current?.stop();
    captureRef.current = null;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    subscriptionThreadRef.current = null;
    playbackRef.current?.stop();
    playbackRef.current = null;
  }, []);

  const fail = useCallback(
    (threadId: ThreadId, api: EnvironmentApi, message: string) => {
      stopResources();
      dispatch(threadId, { type: "failed", message });
      dispatchRealtimeStop(api, threadId);
    },
    [dispatch, stopResources],
  );

  const createCapture = useCallback(
    async (threadId: ThreadId, api: EnvironmentApi, generation: number) => {
      // While one append is in flight, later chunks coalesce instead of
      // dropping — otherwise any transport slower than one chunk duration
      // (e.g. the phone relay) would lose most of the spoken audio. A stalled
      // connection discards the backlog rather than replaying stale speech.
      const maxPendingSamples = REALTIME_AUDIO_SAMPLE_RATE * 2;
      let pendingSamples: Int16Array | null = null;
      const capture = await RealtimeMicCapture.start((samples) => {
        const voiceState = readRealtimeVoiceState(threadId);
        if (
          generationRef.current !== generation ||
          voiceState.status !== "active" ||
          voiceState.muted ||
          !connectionAvailableRef.current
        ) {
          pendingSamples = null;
          return;
        }
        if (appendInFlightRef.current) {
          const pendingLength = pendingSamples?.length ?? 0;
          if (pendingLength + samples.length > maxPendingSamples) {
            pendingSamples = Int16Array.from(samples);
            return;
          }
          const merged = new Int16Array(pendingLength + samples.length);
          if (pendingSamples) {
            merged.set(pendingSamples, 0);
          }
          merged.set(samples, pendingLength);
          pendingSamples = merged;
          return;
        }

        let toSend = samples;
        if (pendingSamples) {
          const merged = new Int16Array(pendingSamples.length + samples.length);
          merged.set(pendingSamples, 0);
          merged.set(samples, pendingSamples.length);
          pendingSamples = null;
          toSend = merged;
        }
        appendInFlightRef.current = true;
        void api.realtime
          .appendAudio({
            threadId,
            audio: {
              data: pcm16ToBase64(toSend),
              sampleRate: REALTIME_AUDIO_SAMPLE_RATE,
              numChannels: 1,
              samplesPerChannel: toSend.length,
            },
          })
          .catch((error: unknown) => {
            if (generationRef.current === generation) {
              fail(
                threadId,
                api,
                error instanceof Error ? error.message : "Microphone audio could not be sent.",
              );
            }
          })
          .finally(() => {
            if (generationRef.current === generation) {
              appendInFlightRef.current = false;
            }
          });
      });

      if (generationRef.current !== generation) {
        capture.stop();
        return null;
      }
      return capture;
    },
    [fail],
  );

  const subscribeToPlayback = useCallback(
    (threadId: ThreadId, api: EnvironmentApi) => {
      if (subscriptionThreadRef.current === threadId) {
        return;
      }
      const subscribeAudio = api.realtime.subscribeAudio as RealtimeAudioSubscription;
      subscriptionThreadRef.current = threadId;
      unsubscribeRef.current = subscribeAudio(
        { threadId },
        (chunk) => {
          try {
            playbackRef.current?.append(chunk);
          } catch (error) {
            fail(
              threadId,
              api,
              error instanceof Error ? error.message : "Voice reply playback failed.",
            );
          }
        },
        {
          onComplete: () => {
            const voiceState = readRealtimeVoiceState(threadId);
            if (voiceState.status !== "starting" && voiceState.status !== "active") {
              return;
            }
            stopResources();
            dispatch(threadId, { type: "reset" });
            dispatchRealtimeStop(api, threadId);
          },
        },
      );
    },
    [dispatch, fail, stopResources],
  );

  const start = useCallback(() => {
    const threadId = input.threadId;
    if (!threadId || !input.supported || !input.canStart || !input.connectionAvailable) {
      return;
    }
    const api = readEnvironmentApi(input.environmentId);
    if (!api) {
      dispatch(threadId, { type: "failed", message: "Environment API unavailable." });
      return;
    }

    stopResources();
    dispatch(threadId, { type: "start-requested" });
    const generation = generationRef.current;
    const modality = readRealtimeVoiceState(threadId).modality;

    void (async () => {
      try {
        if (modality === "audio") {
          playbackRef.current = await RealtimeAudioPlayback.start();
          if (generationRef.current !== generation) {
            playbackRef.current?.stop();
            playbackRef.current = null;
            return;
          }
        }
        captureRef.current = await createCapture(threadId, api, generation);
        if (!captureRef.current || generationRef.current !== generation) {
          return;
        }
        subscribeToPlayback(threadId, api);
        await api.orchestration.dispatchCommand({
          type: "thread.realtime.start",
          commandId: newCommandId(),
          threadId,
          outputModality: modality,
          createdAt: new Date().toISOString(),
        });
        if (
          generationRef.current === generation &&
          readRealtimeVoiceState(threadId).status === "starting"
        ) {
          startTimeoutRef.current = setTimeout(() => {
            if (readRealtimeVoiceState(threadId).status === "starting") {
              fail(threadId, api, "Voice mode did not become active. Try again.");
            }
          }, VOICE_START_TIMEOUT_MS);
        }
      } catch (error) {
        if (generationRef.current === generation) {
          fail(threadId, api, describeMicrophoneError(error));
        }
      }
    })();
  }, [createCapture, dispatch, fail, input, stopResources, subscribeToPlayback]);

  const stop = useCallback(() => {
    const threadId = input.threadId;
    if (!threadId) {
      return;
    }
    const api = readEnvironmentApi(input.environmentId);
    stopResources();
    dispatch(threadId, { type: "reset" });
    if (api) {
      dispatchRealtimeStop(api, threadId);
    }
  }, [dispatch, input.environmentId, input.threadId, stopResources]);

  const toggleMute = useCallback(() => {
    const threadId = input.threadId;
    if (!threadId || state.status !== "active") {
      return;
    }
    if (!state.muted) {
      captureRef.current?.stop();
      captureRef.current = null;
      dispatch(threadId, { type: "mute-changed", muted: true });
      return;
    }

    const api = readEnvironmentApi(input.environmentId);
    if (!api) {
      return;
    }
    const generation = generationRef.current;
    void createCapture(threadId, api, generation)
      .then((capture) => {
        if (!capture || readRealtimeVoiceState(threadId).status !== "active") {
          capture?.stop();
          return;
        }
        captureRef.current = capture;
        capture.setEnabled(true);
        dispatch(threadId, { type: "mute-changed", muted: false });
      })
      .catch((error: unknown) => {
        fail(threadId, api, describeMicrophoneError(error));
      });
  }, [createCapture, dispatch, fail, input.environmentId, input.threadId, state]);

  const setModality = useCallback(
    (modality: ProviderRealtimeOutputModality) => {
      if (input.threadId) {
        dispatch(input.threadId, { type: "modality-changed", modality });
      }
    },
    [dispatch, input.threadId],
  );

  useEffect(() => {
    const threadId = input.threadId;
    if (!threadId) {
      return;
    }
    const api = readEnvironmentApi(input.environmentId);
    if (!api) {
      return;
    }
    const voiceState = readRealtimeVoiceState(threadId);
    if (input.projectedActive && voiceState.status === "starting") {
      if (startTimeoutRef.current !== null) {
        clearTimeout(startTimeoutRef.current);
        startTimeoutRef.current = null;
      }
      dispatch(threadId, { type: "projection-activated" });
      captureRef.current?.setEnabled(true);
      subscribeToPlayback(threadId, api);
      return;
    }
    if (input.projectedActive && voiceState.status !== "active") {
      // A projected session from before navigation/reconnect is intentionally
      // stopped instead of being adopted by this browser instance.
      dispatchRealtimeStop(api, threadId);
      return;
    }
    if (!input.projectedActive && voiceState.status === "active") {
      stopResources();
      dispatch(threadId, { type: "projection-deactivated" });
    }
  }, [
    dispatch,
    input.environmentId,
    input.projectedActive,
    input.threadId,
    stopResources,
    subscribeToPlayback,
  ]);

  useEffect(() => {
    if (input.connectionAvailable) {
      return;
    }
    const threadId = input.threadId;
    if (!threadId) {
      return;
    }
    const voiceState = readRealtimeVoiceState(threadId);
    if (voiceState.status === "starting" || voiceState.status === "active") {
      stopResources();
      dispatch(threadId, { type: "reset" });
    }
  }, [dispatch, input.connectionAvailable, input.threadId, stopResources]);

  useEffect(() => {
    if (input.supported) {
      return;
    }
    const threadId = input.threadId;
    if (!threadId) {
      return;
    }
    const voiceState = readRealtimeVoiceState(threadId);
    if (voiceState.status === "starting" || voiceState.status === "active") {
      stop();
    }
  }, [input.supported, input.threadId, stop]);

  useEffect(() => {
    const threadId = input.threadId;
    const environmentId = input.environmentId;
    if (!threadId) {
      return;
    }
    const leaveVoiceMode = () => {
      const voiceState = readRealtimeVoiceState(threadId);
      if (voiceState.status !== "starting" && voiceState.status !== "active") {
        return;
      }
      const api = readEnvironmentApi(environmentId);
      stopResources();
      dispatch(threadId, { type: "reset" });
      if (api) {
        dispatchRealtimeStop(api, threadId);
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        leaveVoiceMode();
      }
    };
    window.addEventListener("pagehide", leaveVoiceMode);
    window.addEventListener("beforeunload", leaveVoiceMode);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", leaveVoiceMode);
      window.removeEventListener("beforeunload", leaveVoiceMode);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      leaveVoiceMode();
    };
  }, [dispatch, input.environmentId, input.threadId, stopResources]);

  return {
    state,
    projectedActive: input.projectedActive,
    start,
    toggleMute,
    stop,
    setModality,
  };
}
