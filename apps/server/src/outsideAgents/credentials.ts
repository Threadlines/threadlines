/**
 * The signed and random pieces of outside agents' sign-in
 * (docs/design/outside-agents.md).
 *
 * - **Client ids** (stateless DCR): the client's registration, signed. The
 *   server keeps nothing at registration; a client id that verifies is one
 *   this server issued, with exactly the callbacks it was issued for.
 * - **Access tokens:** `tlc1.<cid>.<gen>.<mac>`, the mac over the connection,
 *   its token generation and the resource. Nothing about a token is stored;
 *   the connection row decides whether it still works.
 *
 * Both are macs under a key derived from the server signing key for this
 * purpose only, each over a message that names what it is, so neither can
 * stand in for the other or for anything else that key signs.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as Crypto from "node:crypto";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";

const KEY_LABEL = "threadlines-outside-agents-key-v1";
const CLIENT_ID_PREFIX = "tlr1";
const CLIENT_ID_CONTEXT = "threadlines-client-v1";
const TOKEN_PREFIX = "tlc1";
const TOKEN_CONTEXT = "threadlines-connect-v1";

/** A client's registration, as its client id carries it. */
export interface ClientRegistration {
  readonly name: string;
  readonly redirectUris: ReadonlyArray<string>;
  readonly softwareId: string | null;
  /** Random per registration: "the same agent" is the same registration. */
  readonly registrationId: string;
}

const ClientIdPayload = Schema.fromJsonString(
  Schema.Struct({
    v: Schema.Literal(1),
    n: Schema.String,
    r: Schema.Array(Schema.String),
    s: Schema.NullOr(Schema.String),
    i: Schema.String,
  }),
);
const decodeClientIdPayload = Schema.decodeUnknownOption(ClientIdPayload);

const TOKEN_PATTERN = /^tlc1\.([A-Za-z0-9-]{1,64})\.([1-9][0-9]{0,8})\.([A-Za-z0-9_-]{43})$/u;

export interface OutsideAgentSigner {
  readonly signClientId: (registration: ClientRegistration) => string;
  /** The registration a client id carries, or null when this server didn't issue it. */
  readonly readClientId: (clientId: string) => ClientRegistration | null;
  readonly mintToken: (input: {
    readonly connectionId: string;
    readonly generation: number;
    readonly resource: string;
  }) => string;
  /**
   * The connection and generation a token names, or null when it isn't one
   * this server minted for `resource` (another resource, another server, a
   * forged or cut token).
   */
  readonly readToken: (
    token: string,
    resource: string,
  ) => { readonly connectionId: string; readonly generation: number } | null;
}

export const makeOutsideAgentSigner = (serverSigningKey: Uint8Array): OutsideAgentSigner => {
  const key = Crypto.createHmac("sha256", Buffer.from(serverSigningKey)).update(KEY_LABEL).digest();
  const tokenMac = (connectionId: string, generation: number, resource: string) =>
    signPayload(`${TOKEN_CONTEXT}|${connectionId}|${generation}|${resource}`, key);

  return {
    signClientId: (registration) => {
      const payload = base64UrlEncode(
        JSON.stringify({
          v: 1,
          n: registration.name,
          r: registration.redirectUris,
          s: registration.softwareId,
          i: registration.registrationId,
        }),
      );
      return `${CLIENT_ID_PREFIX}.${payload}.${signPayload(`${CLIENT_ID_CONTEXT}|${payload}`, key)}`;
    },
    readClientId: (clientId) => {
      const parts = clientId.split(".");
      if (parts.length !== 3 || parts[0] !== CLIENT_ID_PREFIX) return null;
      const [, payload = "", mac = ""] = parts;
      if (!timingSafeEqualBase64Url(mac, signPayload(`${CLIENT_ID_CONTEXT}|${payload}`, key))) {
        return null;
      }
      return Option.match(decodeClientIdPayload(base64UrlDecodeUtf8(payload)), {
        onNone: () => null,
        onSome: (decoded) => ({
          name: decoded.n,
          redirectUris: decoded.r,
          softwareId: decoded.s,
          registrationId: decoded.i,
        }),
      });
    },
    mintToken: ({ connectionId, generation, resource }) =>
      `${TOKEN_PREFIX}.${connectionId}.${generation}.${tokenMac(connectionId, generation, resource)}`,
    readToken: (token, resource) => {
      const match = TOKEN_PATTERN.exec(token);
      if (match === null) return null;
      const [, connectionId = "", generationText = "", mac = ""] = match;
      const generation = Number(generationText);
      if (!timingSafeEqualBase64Url(mac, tokenMac(connectionId, generation, resource))) {
        return null;
      }
      return { connectionId, generation };
    },
  };
};

/** sha256 of a client id: what a connection row keeps of the registration it came from. */
export const clientIdHash = (clientId: string): string =>
  Crypto.createHash("sha256").update(clientId).digest("base64url");

/** RFC 7636 S256: the verifier hashes to the challenge. */
export const pkceMatches = (verifier: string, challenge: string): boolean =>
  timingSafeEqualBase64Url(
    Crypto.createHash("sha256").update(verifier).digest("base64url"),
    challenge,
  );

/** An unguessable value for authorization codes, poll secrets and registration ids. */
export const randomSecret = (): string => Crypto.randomBytes(32).toString("base64url");

/** Letters and digits nobody mixes up when comparing two screens: no O, I, L, S, B, Z, G, Q, U, V, 0, 1 or 5. */
const CODE_ALPHABET = "ACDEFHJKMNPRTWXY2346789";

/**
 * The short code a waiting sign-in shows on the browser page and in the
 * approval dialog, so the user can tell they're the same: `K4D-82P`.
 */
export const randomMatchCode = (): string => {
  const pick = () => CODE_ALPHABET[Crypto.randomInt(CODE_ALPHABET.length)];
  return `${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}`;
};

/** Compares two secrets without leaking where they differ. */
export const secretsMatch = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length && Crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};
