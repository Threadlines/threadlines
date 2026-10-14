import type {
  AuthBearerBootstrapResult,
  AuthSessionState,
  AuthWebSocketTokenResult,
  ExecutionEnvironmentDescriptor,
} from "@threadlines/contracts";

import { describeUnknownError, TransportUrlUnavailableError } from "../../rpc/transportError";

class RemoteEnvironmentAuthHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RemoteEnvironmentAuthHttpError";
    this.status = status;
  }
}

export function isRemoteEnvironmentAuthHttpError(
  error: unknown,
): error is RemoteEnvironmentAuthHttpError {
  return error instanceof RemoteEnvironmentAuthHttpError;
}

/** A request to a computer that got no answer at all: asleep, off, or offline. */
class RemoteEnvironmentUnreachableError extends Error {
  override readonly name = "RemoteEnvironmentUnreachableError";
}

/**
 * Whether a request to a computer failed in a way that can clear up on its
 * own: it got no answer, or the answer was "not now" (5xx, 408, 429). Any
 * other failure is a refusal or a fault that needs the user.
 */
export function isRemoteEnvironmentUnreachableError(error: unknown): boolean {
  if (error instanceof RemoteEnvironmentUnreachableError) {
    return true;
  }
  return (
    isRemoteEnvironmentAuthHttpError(error) &&
    (error.status >= 500 || error.status === 408 || error.status === 429)
  );
}

function remoteEndpointUrl(httpBaseUrl: string, pathname: string): string {
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function readRemoteAuthErrorMessage(
  response: Response,
  fallbackMessage: string,
): Promise<string> {
  // The status already says what happened; a body cut off midway is no reason
  // to lose it.
  const text = await response.text().catch(() => "");
  if (!text) {
    return fallbackMessage;
  }

  try {
    const parsed = JSON.parse(text) as { readonly error?: string };
    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      return parsed.error;
    }
  } catch {
    // Fall back to raw text below.
  }

  return text;
}

/**
 * Pairing runs over whatever network is between the phone and the computer, and
 * a stalled socket there used to hang adding a computer forever. Every
 * auth call is small, so cap it and surface a real error instead.
 */
const REMOTE_AUTH_REQUEST_TIMEOUT_MS = 20_000;

async function fetchRemoteJson<T>(input: {
  readonly httpBaseUrl: string;
  readonly pathname: string;
  readonly method?: "GET" | "POST";
  readonly bearerToken?: string;
  readonly body?: unknown;
}): Promise<T> {
  const requestUrl = remoteEndpointUrl(input.httpBaseUrl, input.pathname);
  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: input.method ?? "GET",
      headers: {
        ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}),
      },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      ...(typeof AbortSignal.timeout === "function"
        ? { signal: AbortSignal.timeout(REMOTE_AUTH_REQUEST_TIMEOUT_MS) }
        : {}),
    });
  } catch (error) {
    throw new RemoteEnvironmentUnreachableError(
      `Failed to fetch remote auth endpoint ${requestUrl} (${(error as Error).message}).`,
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new RemoteEnvironmentAuthHttpError(
      await readRemoteAuthErrorMessage(
        response,
        `Remote auth request failed (${response.status}).`,
      ),
      response.status,
    );
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    // An answer that is not JSON is a fault; one cut off midway is no answer.
    if (error instanceof SyntaxError) {
      throw error;
    }
    throw new RemoteEnvironmentUnreachableError(
      `Lost the answer from remote auth endpoint ${requestUrl} (${(error as Error).message}).`,
      { cause: error },
    );
  }
}

export async function bootstrapRemoteBearerSession(input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
}): Promise<AuthBearerBootstrapResult> {
  return fetchRemoteJson<AuthBearerBootstrapResult>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/bootstrap/bearer",
    method: "POST",
    body: {
      credential: input.credential,
    },
  });
}

export async function fetchRemoteSessionState(input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}): Promise<AuthSessionState> {
  return fetchRemoteJson<AuthSessionState>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/session",
    bearerToken: input.bearerToken,
  });
}

export async function fetchRemoteEnvironmentDescriptor(input: {
  readonly httpBaseUrl: string;
}): Promise<ExecutionEnvironmentDescriptor> {
  return fetchRemoteJson<ExecutionEnvironmentDescriptor>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/.well-known/threadlines/environment",
  });
}

export async function issueRemoteWebSocketToken(input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}): Promise<AuthWebSocketTokenResult> {
  return fetchRemoteJson<AuthWebSocketTokenResult>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/ws-token",
    method: "POST",
    bearerToken: input.bearerToken,
  });
}

/**
 * The address for one connection attempt; the transport asks again before
 * every attempt. A computer that is asleep, restarting or busy cannot issue a
 * token, which is worth another attempt (`TransportUrlUnavailableError`). A
 * request it answers and refuses is not.
 */
export async function resolveRemoteWebSocketConnectionUrl(input: {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}): Promise<string> {
  const issued = await issueRemoteWebSocketToken({
    httpBaseUrl: input.httpBaseUrl,
    bearerToken: input.bearerToken,
  }).catch((error: unknown) => {
    throw isRemoteEnvironmentUnreachableError(error)
      ? new TransportUrlUnavailableError(describeUnknownError(error), { cause: error })
      : error;
  });
  const url = new URL(input.wsBaseUrl, window.location.origin);
  url.searchParams.set("wsToken", issued.token);
  return url.toString();
}
