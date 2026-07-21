import { StreamingPcm16Downsampler } from "./realtimeAudioLogic";

declare const sampleRate: number;

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][]): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

interface CaptureProcessorOptions {
  readonly targetSampleRate: number;
  readonly chunkFrames: number;
}

class ThreadlinesRealtimeCaptureProcessor extends AudioWorkletProcessor {
  readonly #downsampler: StreamingPcm16Downsampler;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const processorOptions = options.processorOptions as CaptureProcessorOptions;
    this.#downsampler = new StreamingPcm16Downsampler(
      sampleRate,
      processorOptions.targetSampleRate,
      processorOptions.chunkFrames,
    );
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    if (!channels || channels.length === 0) {
      return true;
    }

    const firstChannel = channels[0];
    if (!firstChannel) {
      return true;
    }
    let mono = firstChannel;
    if (channels.length > 1) {
      mono = new Float32Array(firstChannel.length);
      for (const channel of channels) {
        for (let index = 0; index < mono.length; index += 1) {
          mono[index] = (mono[index] ?? 0) + (channel[index] ?? 0) / channels.length;
        }
      }
    }

    for (const chunk of this.#downsampler.push(mono)) {
      this.port.postMessage(chunk, [chunk.buffer]);
    }
    return true;
  }
}

registerProcessor("threadlines-realtime-capture", ThreadlinesRealtimeCaptureProcessor);
