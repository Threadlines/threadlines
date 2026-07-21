import { describe, expect, it } from "vite-plus/test";
import {
  base64ToPcm16,
  pcm16ToBase64,
  pcmChunkFrameCount,
  StreamingPcm16Downsampler,
} from "./realtimeAudioLogic";
import { DEFAULT_REALTIME_VOICE_STATE, reduceRealtimeVoiceState } from "./realtimeVoiceState";

describe("realtime voice state", () => {
  it("only becomes active after the projected state confirms the start", () => {
    const starting = reduceRealtimeVoiceState(DEFAULT_REALTIME_VOICE_STATE, {
      type: "start-requested",
    });
    expect(starting).toMatchObject({ status: "starting", muted: false, error: null });

    const active = reduceRealtimeVoiceState(starting, { type: "projection-activated" });
    expect(active.status).toBe("active");

    const idle = reduceRealtimeVoiceState(active, { type: "projection-deactivated" });
    expect(idle).toMatchObject({ status: "idle", muted: false, modality: "audio" });
  });

  it("preserves the selected reply modality through failures and reset", () => {
    const textMode = reduceRealtimeVoiceState(DEFAULT_REALTIME_VOICE_STATE, {
      type: "modality-changed",
      modality: "text",
    });
    const failed = reduceRealtimeVoiceState(textMode, {
      type: "failed",
      message: "permission denied",
    });
    expect(failed).toMatchObject({ status: "error", muted: true, modality: "text" });
    expect(reduceRealtimeVoiceState(failed, { type: "reset" }).modality).toBe("text");
  });
});

describe("realtime PCM processing", () => {
  it("emits one 40ms 24kHz chunk from 40ms of 48kHz input", () => {
    const chunkFrames = pcmChunkFrameCount();
    const downsampler = new StreamingPcm16Downsampler(48_000, 24_000, chunkFrames);
    const input = Float32Array.from({ length: 1_920 }, (_, index) =>
      Math.sin((index / 48_000) * Math.PI * 2 * 440),
    );

    const chunks = downsampler.push(input);

    expect(chunkFrames).toBe(960);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(960);
  });

  it("retains resampling phase across worklet-sized input blocks", () => {
    const downsampler = new StreamingPcm16Downsampler(44_100, 24_000, pcmChunkFrameCount());
    const chunks = Array.from({ length: 14 }, () => downsampler.push(new Float32Array(126))).flat();

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(960);
  });

  it("round-trips signed PCM16 samples through little-endian base64", () => {
    const samples = Int16Array.from([-32_768, -1, 0, 1, 32_767]);

    expect(base64ToPcm16(pcm16ToBase64(samples))).toEqual(samples);
  });
});
