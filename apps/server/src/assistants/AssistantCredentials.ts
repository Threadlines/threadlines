/**
 * The computer's half of assistants' credentials (docs/design/assistants.md,
 * "Token" and "Keys"). The formats are shared with the relay
 * (`@threadlines/shared/assistantCredentials`); everything secret is here:
 *
 * - **Access and refresh tokens** end in a MAC: HMAC-SHA256 under a key
 *   derived from the server signing key for this purpose only, over
 *   `threadlines-assistant-v1|<everything before the MAC>|<resource>`. Same
 *   key family as the local door's tokens (outsideAgents/credentials.ts),
 *   with its own label, so neither can stand in for the other.
 * - **Keys** are random; the connection row keeps only their hash, an HMAC
 *   under a key with its own label.
 * - **Refresh rotation** (`decideRefresh`) is the design's rules table: the
 *   current generation rotates; the previous one gets the same successor
 *   again while that successor is unused or rotated under 10 minutes ago;
 *   anything older is a theft signal.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as Crypto from "node:crypto";

import {
  type AssistantCredential,
  type AssistantRoute,
  assistantCredentialSigningInput,
  formatAssistantCredential,
} from "@threadlines/shared/assistantCredentials";

import { signPayload } from "../auth/utils.ts";
import { secretsMatch } from "../outsideAgents/credentials.ts";

const MAC_KEY_LABEL = "threadlines-assistant-mac-key-v1";
const KEY_HASH_LABEL = "threadlines-assistant-key-hash-v1";
const MAC_CONTEXT = "threadlines-assistant-v1";

/** How long after a rotation the previous generation still gets the same successor, used or not. */
export const REFRESH_REPEAT_WINDOW_MS = 10 * 60_000;

type Signed = Extract<AssistantCredential, { kind: "access" | "refresh" }>;
type Unsigned<C extends Signed> = Omit<C, "mac">;

export interface AssistantSigner {
  readonly mintAccess: (input: {
    readonly route: AssistantRoute;
    readonly generation: number;
    readonly expiresAtSeconds: number;
    readonly resource: string;
  }) => string;
  readonly mintRefresh: (input: {
    readonly route: AssistantRoute;
    readonly generation: number;
    readonly resource: string;
  }) => string;
  /** Whether a parsed access or refresh token's MAC is the one this computer makes for `resource`. */
  readonly verify: (credential: Signed, resource: string) => boolean;
  /** What a connection row keeps of a key's secret. */
  readonly keyHash: (secret: string) => string;
  /** Whether a key's secret hashes to the row's hash. Constant time. */
  readonly keyMatches: (secret: string, hash: string) => boolean;
}

export const makeAssistantSigner = (serverSigningKey: Uint8Array): AssistantSigner => {
  const derive = (label: string) =>
    Crypto.createHmac("sha256", Buffer.from(serverSigningKey)).update(label).digest();
  const macKey = derive(MAC_KEY_LABEL);
  const hashKey = derive(KEY_HASH_LABEL);
  const macOf = (credential: Unsigned<Signed>, resource: string) =>
    signPayload(
      `${MAC_CONTEXT}|${assistantCredentialSigningInput({ ...credential, mac: "" } as Signed)}|${resource}`,
      macKey,
    );
  const keyHash = (secret: string) => signPayload(secret, hashKey);

  return {
    mintAccess: ({ route, generation, expiresAtSeconds, resource }) => {
      const unsigned = { kind: "access" as const, route, generation, expiresAtSeconds };
      return formatAssistantCredential({ ...unsigned, mac: macOf(unsigned, resource) });
    },
    mintRefresh: ({ route, generation, resource }) => {
      const unsigned = { kind: "refresh" as const, route, generation };
      return formatAssistantCredential({ ...unsigned, mac: macOf(unsigned, resource) });
    },
    verify: (credential, resource) => secretsMatch(credential.mac, macOf(credential, resource)),
    keyHash,
    keyMatches: (secret, hash) => secretsMatch(keyHash(secret), hash),
  };
};

/** What the token endpoint does with a refresh token of `presented` generation. */
export type RefreshDecision =
  /** The newest: issue the next generation. */
  | { readonly kind: "rotate"; readonly generation: number }
  /** The previous one, within the rules: the same successor again, nothing bumped. */
  | { readonly kind: "repeat"; readonly generation: number }
  /** Older, or the previous one past both limits: remove the connection. */
  | { readonly kind: "reuse" }
  /** Newer than any issued (state lost or rolled back): refuse, remove nothing. */
  | { readonly kind: "unknown" };

/**
 * The design's refresh rules (docs/design/assistants.md, "Token"). `generation`
 * is the newest issued, `rotatedAtMs` when, `seenGeneration` the newest seen
 * in use.
 */
export const decideRefresh = (
  state: {
    readonly generation: number;
    readonly rotatedAtMs: number;
    readonly seenGeneration: number;
  },
  presented: number,
  nowMs: number,
): RefreshDecision => {
  if (presented === state.generation) return { kind: "rotate", generation: state.generation + 1 };
  if (presented > state.generation) return { kind: "unknown" };
  if (
    presented === state.generation - 1 &&
    (state.seenGeneration < state.generation ||
      nowMs - state.rotatedAtMs < REFRESH_REPEAT_WINDOW_MS)
  ) {
    return { kind: "repeat", generation: state.generation };
  }
  return { kind: "reuse" };
};
