/**
 * Push-to-talk recording for the composer.
 *
 * Owns one clip at a time: microphone capture while the user holds or toggles
 * the mic, then a single transcribe call against the environment's server. The
 * hook lives in `ChatComposer` rather than in the control, because the failure
 * message belongs in the composer's notice dock.
 *
 * @module useDictation
 */
import type {
  DictationErrorCode,
  DictationTranscribeResult,
  EnvironmentId,
} from "@threadlines/contracts";
import { DICTATION_MAX_CLIP_MS, DICTATION_SAMPLE_RATE } from "@threadlines/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { getClientSettings } from "../hooks/useSettings";
import { describeMicrophoneError, RealtimeMicCapture } from "../realtimeAudio";
import { pcm16ToBase64 } from "../realtimeAudioLogic";

/** Below this, a clip is a mis-click rather than speech. */
export const DICTATION_MIN_CLIP_MS = 300;

const NOTHING_HEARD_MESSAGE = "Nothing was heard. Try again closer to the mic.";

export type DictationRecordingStatus = "idle" | "recording" | "transcribing";

export interface DictationControl {
  readonly status: DictationRecordingStatus;
  /** Whole seconds of the current recording, refreshed once a second. */
  readonly elapsedMs: number;
  readonly error: string | null;
  readonly start: () => void;
  readonly stop: () => void;
  readonly cancel: () => void;
  readonly clearError: () => void;
}

/** The user-facing sentence for a failure the server reported. */
export function describeDictationErrorCode(code: DictationErrorCode | null): string {
  switch (code) {
    case "unsupported_platform":
      return "Dictation isn't available on this server's platform.";
    case "busy":
      return "Another recording is still being transcribed.";
    case "runtime_missing":
    case "model_missing":
      return "The speech model isn't downloaded yet.";
    default:
      return "Transcription failed. Try again.";
  }
}

function readDictationErrorCode(error: unknown): DictationErrorCode | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const candidate = error as { readonly _tag?: unknown; readonly code?: unknown };
  return candidate._tag === "DictationError" && typeof candidate.code === "string"
    ? (candidate.code as DictationErrorCode)
    : null;
}

function concatSamples(chunks: ReadonlyArray<Int16Array>, maxSamples: number): Int16Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const samples = new Int16Array(Math.min(total, maxSamples));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= samples.length) {
      break;
    }
    const room = samples.length - offset;
    samples.set(room >= chunk.length ? chunk : chunk.subarray(0, room), offset);
    offset += chunk.length;
  }
  return samples;
}

export function useDictation(input: {
  readonly environmentId: EnvironmentId | null | undefined;
  readonly onText: (text: string) => void;
}): DictationControl {
  const [status, setStatus] = useState<DictationRecordingStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const captureRef = useRef<RealtimeMicCapture | null>(null);
  const chunksRef = useRef<Int16Array[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Bumped by every start/stop/cancel so a capture that finishes opening after
  // the user let go is thrown away instead of recording into the next clip.
  const generationRef = useRef(0);
  const onText = input.onText;

  const releaseCapture = useCallback(() => {
    generationRef.current += 1;
    captureRef.current?.stop();
    captureRef.current = null;
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const start = useCallback(() => {
    if (status !== "idle" || !input.environmentId) {
      return;
    }
    const api = readEnvironmentApi(input.environmentId);
    if (!api) {
      setError("This environment is not connected.");
      return;
    }

    releaseCapture();
    const generation = generationRef.current;
    chunksRef.current = [];
    setError(null);
    setElapsedMs(0);
    setStatus("recording");
    // Loading the model takes a second or two the first time; asking for it
    // now means the transcribe after a short clip is not the one that waits.
    void api.dictation.warmUp().catch(() => undefined);

    const startedAt = Date.now();
    tickRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 1_000);

    void RealtimeMicCapture.start(
      (samples) => {
        if (generationRef.current === generation) {
          chunksRef.current.push(Int16Array.from(samples));
        }
      },
      {
        targetSampleRate: DICTATION_SAMPLE_RATE,
        deviceId: getClientSettings().dictationMicrophoneDeviceId,
      },
    )
      .then((capture) => {
        if (generationRef.current !== generation) {
          capture.stop();
          return;
        }
        captureRef.current = capture;
        capture.setEnabled(true);
      })
      .catch((cause: unknown) => {
        if (generationRef.current !== generation) {
          return;
        }
        releaseCapture();
        chunksRef.current = [];
        setStatus("idle");
        setElapsedMs(0);
        setError(describeMicrophoneError(cause));
      });
  }, [input.environmentId, releaseCapture, status]);

  const cancel = useCallback(() => {
    releaseCapture();
    chunksRef.current = [];
    setStatus("idle");
    setElapsedMs(0);
  }, [releaseCapture]);

  const stop = useCallback(() => {
    if (status !== "recording") {
      return;
    }
    releaseCapture();
    const chunks = chunksRef.current;
    chunksRef.current = [];
    const maxSamples = Math.round((DICTATION_MAX_CLIP_MS / 1_000) * DICTATION_SAMPLE_RATE);
    const samples = concatSamples(chunks, maxSamples);
    const durationMs = Math.round((samples.length / DICTATION_SAMPLE_RATE) * 1_000);
    setElapsedMs(0);

    if (durationMs < DICTATION_MIN_CLIP_MS) {
      setStatus("idle");
      setError(NOTHING_HEARD_MESSAGE);
      return;
    }

    const api = input.environmentId ? readEnvironmentApi(input.environmentId) : undefined;
    if (!api) {
      setStatus("idle");
      setError("This environment is not connected.");
      return;
    }

    const generation = generationRef.current;
    setStatus("transcribing");
    void api.dictation
      .transcribe({
        audioBase64: pcm16ToBase64(samples),
        sampleRate: DICTATION_SAMPLE_RATE,
        durationMs,
      })
      .then((result: DictationTranscribeResult) => {
        if (generationRef.current !== generation) {
          return;
        }
        setStatus("idle");
        const text = result.text.trim();
        if (text.length === 0) {
          setError(NOTHING_HEARD_MESSAGE);
          return;
        }
        onText(text);
      })
      .catch((cause: unknown) => {
        if (generationRef.current !== generation) {
          return;
        }
        setStatus("idle");
        setError(describeDictationErrorCode(readDictationErrorCode(cause)));
      });
  }, [input.environmentId, onText, releaseCapture, status]);

  useEffect(() => releaseCapture, [releaseCapture]);

  return { status, elapsedMs, error, start, stop, cancel, clearError };
}
