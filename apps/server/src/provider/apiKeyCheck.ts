/**
 * apiKeyCheck — asks a vendor whether it accepts an API key, with one
 * model-list request, which is free. It proves the key, not access to a given
 * model or quota. Antigravity checks Gemini keys with it, Grok xAI keys.
 *
 * @module provider/apiKeyCheck
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest } from "effect/http";

const KEY_CHECK_TIMEOUT_MS = 15_000;

export type ApiKeyCheck =
  | { readonly verdict: "accepted" }
  | { readonly verdict: "rejected"; readonly message: string }
  | { readonly verdict: "unreachable"; readonly message: string };

export const checkApiKeyWithModelList = (input: {
  /** The vendor as messages name it ("Google", "xAI"). */
  readonly vendor: string;
  readonly url: string;
  /** The headers carrying the key: never the address, which logs keep. */
  readonly headers: Readonly<Record<string, string>>;
  /** The vendor's own words for a refused key, from its error body. */
  readonly errorMessage: (body: unknown) => string | undefined;
}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.get(input.url).pipe(
          HttpClientRequest.setHeaders({ ...input.headers, accept: "application/json" }),
        ),
      )
      .pipe(
        Effect.timeoutOption(KEY_CHECK_TIMEOUT_MS),
        Effect.catch(() => Effect.succeed(Option.none())),
      );
    if (Option.isNone(response)) {
      return {
        verdict: "unreachable",
        message: `Couldn't reach ${input.vendor} to check the key. Check the connection and try again.`,
      } satisfies ApiKeyCheck;
    }
    const status = response.value.status;
    // Over quota still means the vendor knows the key.
    if ((status >= 200 && status < 300) || status === 429) {
      return { verdict: "accepted" } satisfies ApiKeyCheck;
    }
    const body = yield* response.value.json.pipe(Effect.orElseSucceed(() => undefined));
    if (status === 400 || status === 401 || status === 403) {
      return {
        verdict: "rejected",
        message: input.errorMessage(body) ?? `${input.vendor} didn't accept this key.`,
      } satisfies ApiKeyCheck;
    }
    return {
      verdict: "unreachable",
      message: `${input.vendor} couldn't check the key right now (HTTP ${status}). Try again in a moment.`,
    } satisfies ApiKeyCheck;
  });
