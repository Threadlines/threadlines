import { describe, expect, it } from "vitest";

import {
  describeDispatchFailure,
  isRetryableRequestFailure,
  isTransportConnectionErrorMessage,
  sanitizeThreadErrorMessage,
  TransportRequestRetriesExhaustedError,
  TransportRequestTimeoutError,
} from "./transportError";

describe("transportError", () => {
  it("detects websocket transport failures", () => {
    expect(isTransportConnectionErrorMessage("SocketCloseError: 1006")).toBe(true);
    expect(
      isTransportConnectionErrorMessage("Unable to connect to the Threadlines server WebSocket."),
    ).toBe(true);
    expect(isTransportConnectionErrorMessage("SocketOpenError: Timeout")).toBe(true);
  });

  it("preserves non-transport thread errors", () => {
    expect(sanitizeThreadErrorMessage("Turn failed")).toBe("Turn failed");
    expect(sanitizeThreadErrorMessage("Select a base branch before sending.")).toBe(
      "Select a base branch before sending.",
    );
  });

  it("drops transport failures from thread surfaces", () => {
    expect(sanitizeThreadErrorMessage("SocketCloseError: 1006")).toBeNull();
  });
});

describe("isRetryableRequestFailure", () => {
  it("retries client-side transport failures", () => {
    expect(isRetryableRequestFailure(new Error("SocketCloseError: 1006"))).toBe(true);
    expect(isRetryableRequestFailure(new Error("SocketGenericError: write failed"))).toBe(true);
    expect(isRetryableRequestFailure(new Error("RpcClientError: connection lost"))).toBe(true);
    expect(isRetryableRequestFailure(new Error("All fibers interrupted without errors."))).toBe(
      true,
    );
    expect(isRetryableRequestFailure(new TransportRequestTimeoutError("dispatch", 25_000))).toBe(
      true,
    );
  });

  it("retries tagged failure objects that are not Error instances", () => {
    expect(
      isRetryableRequestFailure({
        _tag: "RpcClientError",
        message: "SocketCloseError: relay closed the socket (1013)",
      }),
    ).toBe(true);
  });

  it("never retries server rejections", () => {
    expect(
      isRetryableRequestFailure(
        new Error(
          "Orchestration command invariant failed (thread.turn.retry): Thread 'x' has no user message to retry.",
        ),
      ),
    ).toBe(false);
    // Contains the word "interrupt" via the command type, but is a server
    // rejection — must surface, not loop.
    expect(
      isRetryableRequestFailure(
        new Error(
          "Orchestration command invariant failed (thread.turn.interrupt): Thread 'x' has no running turn.",
        ),
      ),
    ).toBe(false);
    expect(isRetryableRequestFailure(new Error("Previously rejected."))).toBe(false);
  });

  it("never retries an already-exhausted retry error", () => {
    expect(
      isRetryableRequestFailure(
        new TransportRequestRetriesExhaustedError(
          "dispatch",
          90_000,
          new Error("SocketCloseError"),
        ),
      ),
    ).toBe(false);
  });
});

describe("describeDispatchFailure", () => {
  it("passes server rejection text through verbatim", () => {
    expect(
      describeDispatchFailure(new Error("Thread 'x' has no user message to retry."), "fallback"),
    ).toBe("Thread 'x' has no user message to retry.");
  });

  it("rewrites transport failures to stable, non-sanitized text", () => {
    const described = describeDispatchFailure(new Error("SocketCloseError: 1006"), "fallback");
    expect(described).toContain("Lost the connection");
    // Must survive sanitizeThreadErrorMessage so the user actually sees it.
    expect(sanitizeThreadErrorMessage(described)).toBe(described);
  });

  it("uses retry-error messages directly and keeps them visible", () => {
    const exhausted = new TransportRequestRetriesExhaustedError(
      "orchestration.dispatchCommand",
      91_234,
      new Error("SocketCloseError: 1006"),
    );
    expect(describeDispatchFailure(exhausted, "fallback")).toBe(exhausted.message);
    expect(sanitizeThreadErrorMessage(exhausted.message)).toBe(exhausted.message);
  });

  it("falls back for message-less values", () => {
    expect(describeDispatchFailure({ code: 500 }, "Failed to send message.")).toBe(
      "Failed to send message.",
    );
    expect(describeDispatchFailure("", "Failed to send message.")).toBe("Failed to send message.");
  });
});
