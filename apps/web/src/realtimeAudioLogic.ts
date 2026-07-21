export const REALTIME_AUDIO_SAMPLE_RATE = 24_000;
export const REALTIME_AUDIO_CHUNK_DURATION_MS = 40;
export const REALTIME_AUDIO_JITTER_BUFFER_SECONDS = 0.15;

export function pcmChunkFrameCount(
  sampleRate = REALTIME_AUDIO_SAMPLE_RATE,
  durationMs = REALTIME_AUDIO_CHUNK_DURATION_MS,
): number {
  return Math.max(1, Math.round((sampleRate * durationMs) / 1_000));
}

function floatToPcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

/**
 * Streaming linear resampler used by the AudioWorklet. It retains the source
 * phase and partial output chunk between render quanta, so no samples are
 * duplicated or silently dropped at 128-frame worklet boundaries.
 */
export class StreamingPcm16Downsampler {
  readonly #sourceFramesPerOutputFrame: number;
  readonly #chunkFrames: number;
  #previousSample: number | null = null;
  #sourceFrameIndex = 0;
  #nextOutputSourcePosition = 0;
  #chunk: Int16Array;
  #chunkOffset = 0;

  constructor(sourceSampleRate: number, targetSampleRate: number, chunkFrames: number) {
    if (sourceSampleRate <= 0 || targetSampleRate <= 0 || chunkFrames <= 0) {
      throw new Error("Audio sample rates and chunk size must be positive.");
    }
    this.#sourceFramesPerOutputFrame = sourceSampleRate / targetSampleRate;
    this.#chunkFrames = Math.round(chunkFrames);
    this.#chunk = new Int16Array(this.#chunkFrames);
  }

  push(samples: Float32Array): Int16Array[] {
    const chunks: Int16Array[] = [];
    for (const sample of samples) {
      if (this.#previousSample === null) {
        this.#previousSample = sample;
      }

      while (this.#nextOutputSourcePosition <= this.#sourceFrameIndex) {
        const previousPosition = Math.max(0, this.#sourceFrameIndex - 1);
        const interpolation = Math.max(
          0,
          Math.min(1, this.#nextOutputSourcePosition - previousPosition),
        );
        const outputSample = this.#previousSample + (sample - this.#previousSample) * interpolation;
        this.#chunk[this.#chunkOffset] = floatToPcm16(outputSample);
        this.#chunkOffset += 1;
        this.#nextOutputSourcePosition += this.#sourceFramesPerOutputFrame;

        if (this.#chunkOffset === this.#chunkFrames) {
          chunks.push(this.#chunk);
          this.#chunk = new Int16Array(this.#chunkFrames);
          this.#chunkOffset = 0;
        }
      }

      this.#previousSample = sample;
      this.#sourceFrameIndex += 1;
    }
    return chunks;
  }
}

export function pcm16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index] ?? 0, true);
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64ToPcm16(data: string): Int16Array {
  const binary = atob(data);
  if (binary.length % 2 !== 0) {
    throw new Error("PCM16 audio payload has an odd byte length.");
  }
  const samples = new Int16Array(binary.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    const low = binary.charCodeAt(index * 2);
    const high = binary.charCodeAt(index * 2 + 1);
    const unsigned = low | (high << 8);
    samples[index] = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
  }
  return samples;
}
