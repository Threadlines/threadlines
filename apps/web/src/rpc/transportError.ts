const TRANSPORT_ERROR_PATTERNS = [
  /\bSocketCloseError\b/i,
  /\bSocketOpenError\b/i,
  /Unable to connect to the Threadlines server WebSocket\./i,
  /\bping timeout\b/i,
] as const;

// Failure shapes that only occur on the client side of a request (socket
// write/read errors, protocol teardown, fiber interruption from a session
// swap). They never describe a server-side rejection, so re-sending an
// idempotent request on them is safe. Kept separate from
// TRANSPORT_ERROR_PATTERNS, which also feeds subscription retry
// classification and thread-error sanitizing.
const RETRYABLE_REQUEST_ERROR_PATTERNS = [
  /\bSocketGenericError\b/i,
  /\bRpcClientError\b/i,
  /\bClientProtocolError\b/i,
  /\bInterruptedException\b/,
  /\bAll fibers interrupted\b/i,
  /^\s*Interrupted\s*$/i,
] as const;

export function isTransportConnectionErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }

  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
}

export function sanitizeThreadErrorMessage(message: string | null | undefined): string | null {
  return isTransportConnectionErrorMessage(message) ? null : (message ?? null);
}

export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    const message = (error as { readonly message?: unknown }).message;
    // "[object Object]" describes nothing; let callers use their fallback.
    return typeof message === "string" ? message : "";
  }
  return String(error);
}

/** A single request attempt got no response inside its timeout window. */
export class TransportRequestTimeoutError extends Error {
  override readonly name = "TransportRequestTimeoutError";

  constructor(label: string, timeoutMs: number) {
    super(
      `The Threadlines server did not acknowledge '${label}' within ${Math.round(timeoutMs / 1_000)}s.`,
    );
  }
}

/** Every retry attempt failed on transport-level errors within the budget. */
export class TransportRequestRetriesExhaustedError extends Error {
  override readonly name = "TransportRequestRetriesExhaustedError";
  readonly lastFailureMessage: string;

  constructor(label: string, elapsedMs: number, lastFailure: unknown) {
    super(
      `Could not reach the Threadlines server after ${Math.round(elapsedMs / 1_000)}s of reconnect attempts ('${label}'). The request was not delivered — try again once connected.`,
      { cause: lastFailure },
    );
    this.lastFailureMessage = describeUnknownError(lastFailure);
  }
}

/**
 * Whether a failed request may be re-sent: true only for failures that
 * happened on this side of the wire (dead socket, protocol teardown, session
 * swap interruption, attempt timeout). Server rejections — invariant errors,
 * schema errors, previously-rejected receipts — must surface, not retry.
 */
export function isRetryableRequestFailure(error: unknown): boolean {
  if (error instanceof TransportRequestTimeoutError) {
    return true;
  }
  if (error instanceof TransportRequestRetriesExhaustedError) {
    return false;
  }
  const message = describeUnknownError(error);
  return (
    isTransportConnectionErrorMessage(message) ||
    RETRYABLE_REQUEST_ERROR_PATTERNS.some((pattern) => pattern.test(message))
  );
}

/**
 * Human-facing text for a failed command dispatch. Server rejections pass
 * through verbatim; transport-level failures are rewritten to a stable,
 * actionable message (and never to raw socket text, which
 * sanitizeThreadErrorMessage would drop from thread surfaces entirely).
 */
export function describeDispatchFailure(error: unknown, fallback: string): string {
  if (
    error instanceof TransportRequestRetriesExhaustedError ||
    error instanceof TransportRequestTimeoutError
  ) {
    return error.message;
  }
  const message = describeUnknownError(error).trim();
  if (message.length === 0) {
    return fallback;
  }
  if (isRetryableRequestFailure(error)) {
    return "Lost the connection to the Threadlines server before the request was delivered. Try again once connected.";
  }
  return message;
}
