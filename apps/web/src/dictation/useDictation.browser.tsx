import "../index.css";

import { DictationError, EnvironmentId, type EnvironmentApi } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import { useDictation } from "./useDictation";

const ENVIRONMENT_ID = EnvironmentId.make("environment-dictation");

/**
 * The capture is the only browser API the hook cannot exercise for real here:
 * headless Chromium has no microphone, so the fake hands the hook the samples
 * a clip of a given length would have produced.
 */
const captureHarness = vi.hoisted(() => {
  let onChunk: ((samples: Int16Array) => void) | null = null;
  let startRejection: unknown = null;
  return {
    reset() {
      onChunk = null;
      startRejection = null;
    },
    failNextStart(error: unknown) {
      startRejection = error;
    },
    /** Feeds the hook one chunk worth `durationMs` of 16 kHz audio. */
    emit(durationMs: number) {
      onChunk?.(new Int16Array(Math.round((durationMs / 1_000) * 16_000)));
    },
    start: vi.fn(async (listener: (samples: Int16Array) => void) => {
      if (startRejection !== null) {
        const error = startRejection;
        startRejection = null;
        throw error;
      }
      onChunk = listener;
      return {
        setEnabled: () => undefined,
        stop: () => {
          onChunk = null;
        },
      };
    }),
  };
});

vi.mock("../realtimeAudio", async () => {
  const actual = await vi.importActual<typeof import("../realtimeAudio")>("../realtimeAudio");
  return {
    ...actual,
    RealtimeMicCapture: { start: captureHarness.start },
  };
});

const transcribe = vi.fn<EnvironmentApi["dictation"]["transcribe"]>();
const warmUp = vi.fn<EnvironmentApi["dictation"]["warmUp"]>(async () => undefined);

function installEnvironmentApi() {
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
    dictation: {
      subscribeStatus: () => () => undefined,
      downloadModel: async () => undefined,
      cancelDownload: async () => undefined,
      removeModel: async () => undefined,
      warmUp,
      transcribe,
    },
  } as unknown as EnvironmentApi);
}

function DictationHarness({ onText }: { onText: (text: string) => void }) {
  const dictation = useDictation({ environmentId: ENVIRONMENT_ID, onText });
  return (
    <div>
      <output data-testid="status">{dictation.status}</output>
      <output data-testid="error">{dictation.error ?? ""}</output>
      <button type="button" onClick={dictation.start}>
        start
      </button>
      <button type="button" onClick={dictation.stop}>
        stop
      </button>
      <button type="button" onClick={dictation.cancel}>
        cancel
      </button>
    </div>
  );
}

describe("useDictation", () => {
  beforeEach(() => {
    captureHarness.reset();
    transcribe.mockReset();
    transcribe.mockResolvedValue({ text: "" });
    warmUp.mockClear();
    installEnvironmentApi();
  });

  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    document.body.innerHTML = "";
  });

  it("sends a long enough clip and hands the text back", async () => {
    transcribe.mockResolvedValue({ text: "  add a dictation button  " });
    const onText = vi.fn();
    const mounted = await render(<DictationHarness onText={onText} />);

    await page.getByRole("button", { name: "start" }).click();
    await expect
      .element(page.getByTestId("status"), { timeout: 5_000 })
      .toHaveTextContent("recording");
    captureHarness.emit(1_000);
    await page.getByRole("button", { name: "stop" }).click();

    await vi.waitFor(
      () => {
        expect(transcribe).toHaveBeenCalledWith(
          expect.objectContaining({ sampleRate: 16_000, durationMs: 1_000 }),
        );
      },
      { timeout: 5_000 },
    );
    await vi.waitFor(() => expect(onText).toHaveBeenCalledWith("add a dictation button"), {
      timeout: 5_000,
    });
    await expect.element(page.getByTestId("status"), { timeout: 5_000 }).toHaveTextContent("idle");
    await mounted.unmount();
  });

  it("refuses a clip too short to be speech without calling the server", async () => {
    const onText = vi.fn();
    const mounted = await render(<DictationHarness onText={onText} />);

    await page.getByRole("button", { name: "start" }).click();
    await expect
      .element(page.getByTestId("status"), { timeout: 5_000 })
      .toHaveTextContent("recording");
    captureHarness.emit(100);
    await page.getByRole("button", { name: "stop" }).click();

    await expect
      .element(page.getByTestId("error"), { timeout: 5_000 })
      .toHaveTextContent("Nothing was heard. Try again closer to the mic.");
    expect(transcribe).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
    await mounted.unmount();
  });

  it("turns a server failure into its own sentence and returns to idle", async () => {
    transcribe.mockRejectedValue(
      new DictationError({ code: "busy", message: "already transcribing" }),
    );
    const onText = vi.fn();
    const mounted = await render(<DictationHarness onText={onText} />);

    await page.getByRole("button", { name: "start" }).click();
    await expect
      .element(page.getByTestId("status"), { timeout: 5_000 })
      .toHaveTextContent("recording");
    captureHarness.emit(1_000);
    await page.getByRole("button", { name: "stop" }).click();

    await expect
      .element(page.getByTestId("error"), { timeout: 5_000 })
      .toHaveTextContent("Another recording is still being transcribed.");
    await expect.element(page.getByTestId("status"), { timeout: 5_000 }).toHaveTextContent("idle");
    expect(onText).not.toHaveBeenCalled();
    await mounted.unmount();
  });

  it("discards the clip on cancel", async () => {
    const onText = vi.fn();
    const mounted = await render(<DictationHarness onText={onText} />);

    await page.getByRole("button", { name: "start" }).click();
    await expect
      .element(page.getByTestId("status"), { timeout: 5_000 })
      .toHaveTextContent("recording");
    captureHarness.emit(1_000);
    await page.getByRole("button", { name: "cancel" }).click();

    await expect.element(page.getByTestId("status"), { timeout: 5_000 }).toHaveTextContent("idle");
    expect(transcribe).not.toHaveBeenCalled();

    // The next clip starts empty rather than replaying the discarded audio.
    await page.getByRole("button", { name: "start" }).click();
    captureHarness.emit(1_000);
    await page.getByRole("button", { name: "stop" }).click();
    await vi.waitFor(
      () => {
        expect(transcribe).toHaveBeenCalledWith(
          expect.objectContaining({ sampleRate: 16_000, durationMs: 1_000 }),
        );
      },
      { timeout: 5_000 },
    );
    await mounted.unmount();
  });
});
