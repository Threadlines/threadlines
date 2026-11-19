import { ProviderInstanceId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scrubExternalThreadList, scrubWorkflowRunFile } from "./readBackScrubbing.ts";
import { makeSecretScrubber } from "./SecretScrubber.ts";

describe("read-back scrubbing", () => {
  it("hides a key in what a person reads, never in ids or status words that equal it", () => {
    const scrubber = makeSecretScrubber();
    scrubber.watch("API_KEY", "not-ended");
    scrubber.watch("SESSION_KEY", "native-thread-7");

    expect(
      scrubWorkflowRunFile(scrubber, {
        text: "export KEY=not-ended",
        format: "text",
        truncated: false,
        unavailableReason: "not-ended",
        logs: ["using not-ended"],
      }),
    ).toEqual({
      text: "export KEY=[API_KEY hidden]",
      format: "text",
      truncated: false,
      unavailableReason: "not-ended",
      logs: ["using [API_KEY hidden]"],
    });

    const [candidate] = scrubExternalThreadList(scrubber, {
      data: [
        {
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerThreadId: "native-thread-7",
          sessionId: "session-1",
          source: "cli",
          name: "Rotate native-thread-7",
          preview: "native-thread-7 leaked",
          cwd: "/workspace",
          cliVersion: "0.145.0",
          createdAt: "2026-07-19T10:00:00.000Z",
          updatedAt: "2026-07-19T10:05:00.000Z",
          status: "idle",
          canImport: true,
        },
      ],
    }).data;
    // The id goes back as it is: an import sends it back to find the session.
    expect(candidate?.providerThreadId).toBe("native-thread-7");
    expect(candidate?.name).toBe("Rotate [SESSION_KEY hidden]");
    expect(candidate?.preview).toBe("[SESSION_KEY hidden] leaked");
  });
});
