import type { ProviderRealtimeAudioChunk } from "@threadlines/contracts";
import captureWorkletUrl from "./realtimeCapture.worklet.ts?worker&url";
import {
  base64ToPcm16,
  pcmChunkFrameCount,
  REALTIME_AUDIO_JITTER_BUFFER_SECONDS,
  REALTIME_AUDIO_SAMPLE_RATE,
} from "./realtimeAudioLogic";

export type RealtimeMicChunkListener = (samples: Int16Array) => void;

function getAudioContextConstructor(): typeof AudioContext {
  const AudioContextConstructor = globalThis.AudioContext;
  if (!AudioContextConstructor) {
    throw new Error("This browser does not support realtime audio.");
  }
  return AudioContextConstructor;
}

export function describeMicrophoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Microphone permission was denied. Allow microphone access and try again.";
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return "No microphone was found. Connect one and try again.";
    }
    if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      return "The microphone is in use by another app or could not be opened.";
    }
  }
  return error instanceof Error && error.message
    ? error.message
    : "The microphone could not be started.";
}

export class RealtimeMicCapture {
  readonly #stream: MediaStream;
  readonly #context: AudioContext;
  readonly #source: MediaStreamAudioSourceNode;
  readonly #worklet: AudioWorkletNode;
  #messageListener: ((event: MessageEvent<unknown>) => void) | null = null;
  #enabled = false;
  #stopped = false;

  private constructor(
    stream: MediaStream,
    context: AudioContext,
    source: MediaStreamAudioSourceNode,
    worklet: AudioWorkletNode,
  ) {
    this.#stream = stream;
    this.#context = context;
    this.#source = source;
    this.#worklet = worklet;
  }

  static async start(onChunk: RealtimeMicChunkListener): Promise<RealtimeMicCapture> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support microphone capture.");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const AudioContextConstructor = getAudioContextConstructor();
    const context = new AudioContextConstructor();
    try {
      await context.audioWorklet.addModule(captureWorkletUrl);
      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, "threadlines-realtime-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: "explicit",
        processorOptions: {
          targetSampleRate: REALTIME_AUDIO_SAMPLE_RATE,
          chunkFrames: pcmChunkFrameCount(),
        },
      });
      const capture = new RealtimeMicCapture(stream, context, source, worklet);
      capture.#messageListener = (event: MessageEvent<unknown>) => {
        if (!capture.#enabled || capture.#stopped) {
          return;
        }
        if (event.data instanceof Int16Array) {
          onChunk(event.data);
        }
      };
      worklet.port.addEventListener("message", capture.#messageListener);
      worklet.port.start();
      source.connect(worklet);
      await context.resume();
      return capture;
    } catch (error) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      void context.close();
      throw error;
    }
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled && !this.#stopped;
  }

  stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#enabled = false;
    if (this.#messageListener) {
      this.#worklet.port.removeEventListener("message", this.#messageListener);
      this.#messageListener = null;
    }
    this.#source.disconnect();
    this.#worklet.disconnect();
    for (const track of this.#stream.getTracks()) {
      track.stop();
    }
    void this.#context.close();
  }
}

export class RealtimeAudioPlayback {
  readonly #context: AudioContext;
  readonly #sources = new Set<AudioBufferSourceNode>();
  #nextStartTime: number | null = null;
  #stopped = false;

  private constructor(context: AudioContext) {
    this.#context = context;
  }

  static async start(): Promise<RealtimeAudioPlayback> {
    const AudioContextConstructor = getAudioContextConstructor();
    const context = new AudioContextConstructor({ sampleRate: REALTIME_AUDIO_SAMPLE_RATE });
    await context.resume();
    return new RealtimeAudioPlayback(context);
  }

  append(chunk: ProviderRealtimeAudioChunk): void {
    if (this.#stopped) {
      return;
    }
    const channels = Math.max(1, chunk.numChannels);
    const samples = base64ToPcm16(chunk.data);
    const availableFrames = Math.floor(samples.length / channels);
    const frameCount = Math.min(chunk.samplesPerChannel ?? availableFrames, availableFrames);
    if (frameCount === 0) {
      return;
    }

    const buffer = this.#context.createBuffer(channels, frameCount, chunk.sampleRate);
    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      const output = buffer.getChannelData(channelIndex);
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        output[frameIndex] = (samples[frameIndex * channels + channelIndex] ?? 0) / 0x8000;
      }
    }

    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#context.destination);
    const bufferedStart = this.#context.currentTime + REALTIME_AUDIO_JITTER_BUFFER_SECONDS;
    const startTime =
      this.#nextStartTime === null || this.#nextStartTime < this.#context.currentTime
        ? bufferedStart
        : this.#nextStartTime;
    this.#nextStartTime = startTime + buffer.duration;
    this.#sources.add(source);
    source.addEventListener(
      "ended",
      () => {
        this.#sources.delete(source);
        source.disconnect();
      },
      { once: true },
    );
    source.start(startTime);
  }

  stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    for (const source of this.#sources) {
      try {
        source.stop();
      } catch {
        // A source that has already ended is safe to ignore during teardown.
      }
      source.disconnect();
    }
    this.#sources.clear();
    void this.#context.close();
  }
}
