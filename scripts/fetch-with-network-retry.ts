export interface FetchWithNetworkRetryOptions {
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly timeoutMs?: number;
  readonly fetchImplementation?: typeof fetch;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly onRetry?: (input: {
    readonly attempt: number;
    readonly delayMs: number;
    readonly error: unknown;
    readonly maxAttempts: number;
  }) => void;
}

const defaultSleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const TRANSIENT_NETWORK_ERROR_PATTERNS = [
  "eai_again",
  "econnreset",
  "etimedout",
  "fetch failed",
  "other side closed",
  "socket hang up",
  "status code 502",
  "status code 503",
  "status code 504",
  "und_err_socket",
] as const;

export function isTransientNetworkFailure(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const normalizedMessage = message.toLowerCase();
  return TRANSIENT_NETWORK_ERROR_PATTERNS.some((pattern) => normalizedMessage.includes(pattern));
}

export async function fetchWithNetworkRetry(
  url: string,
  options: FetchWithNetworkRetryOptions = {},
): Promise<Response> {
  const {
    maxAttempts = 3,
    retryDelayMs = 1_000,
    timeoutMs = 300_000,
    fetchImplementation = fetch,
    sleep = defaultSleep,
    onRetry,
  } = options;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`maxAttempts must be a positive integer, got ${maxAttempts}`);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchImplementation(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }

      const delayMs = retryDelayMs * attempt;
      onRetry?.({ attempt, delayMs, error, maxAttempts });
      await sleep(delayMs);
    }
  }

  throw new Error("Electron artifact download exhausted its retry attempts");
}
