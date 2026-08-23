import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import * as DesktopStartupFailurePrompt from "./DesktopStartupFailurePrompt.ts";

describe("DesktopStartupFailurePrompt", () => {
  it("shows the deepest backend cause and exit code", () => {
    const description = DesktopStartupFailurePrompt.describeStartupFailure({
      displayName: "Threadlines",
      logDir: "C:\\Users\\alice\\.threadlines\\userdata\\logs",
      homeDirectory: "C:\\Users\\alice",
      report: {
        failureKind: "process-exit",
        attempts: 3,
        lastExitCode: Option.some(1),
        lastReason: "code=1",
        outputTail:
          "effect/sql/SqlError: Failed to prepare statement\n[cause]: Error: file is not a database\n    at startServer",
      },
    });

    assert.include(description.detail, "Last error: file is not a database (exit code 1)");
    assert.notInclude(description.detail, "Last error: code=1");
  });

  it("scrubs paths and secrets before putting diagnostics in a shareable dialog", () => {
    const description = DesktopStartupFailurePrompt.describeStartupFailure({
      displayName: "Threadlines",
      logDir: "C:\\Users\\alice\\.threadlines\\userdata\\logs",
      homeDirectory: "C:\\Users\\alice",
      report: {
        failureKind: "process-exit",
        attempts: 3,
        lastExitCode: Option.some(1),
        lastReason: "code=1",
        outputTail:
          "[cause]: Error: token=abc123 at C:\\Users\\alice\\.threadlines\\userdata\\state.sqlite",
      },
    });

    assert.include(description.detail, "token=[redacted]");
    assert.include(
      description.detail,
      "Last error: token=[redacted] at ~\\.threadlines\\userdata\\state.sqlite",
    );
    assert.notInclude(description.detail, "abc123");
  });

  it("shows an automatic recovery failure instead of hiding it behind code 1", () => {
    const description = DesktopStartupFailurePrompt.describeStartupFailure({
      displayName: "Threadlines",
      logDir: "C:\\logs",
      homeDirectory: "C:\\Users\\alice",
      report: {
        failureKind: "process-exit",
        attempts: 3,
        lastExitCode: Option.some(1),
        lastReason: "code=1",
        outputTail:
          "[cause]: Error: file is not a database\n[cause]: DesktopDatabaseRecoveryError: EACCES while preserving state.sqlite",
      },
    });

    assert.include(
      description.detail,
      "Last error: EACCES while preserving state.sqlite (exit code 1)",
    );
  });
});
