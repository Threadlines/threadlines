import type * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { decodeJsonResult } from "@threadlines/shared/schemaJson";

import { nonEmptyText } from "./gitHubPullRequestList.ts";

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

/**
 * A GitHub account name as the web host will serve a picture for: letters,
 * digits and dashes, up to the 39 characters a login may have. An app account
 * (`dependabot[bot]`) fails it, and so does anything else that would make
 * `<host>/<name>.png` mean a different account than the one asked about.
 */
const PLAIN_LOGIN = /^[a-z0-9][a-z0-9-]{0,38}$/i;

/** Big enough for a retina 16px avatar, small enough to stay cheap. */
const AVATAR_SIZE = 80;

/**
 * The web host a pull request lives on, read from its own URL so a GitHub
 * Enterprise install serves its own pictures. Null when the host gave a URL
 * nothing can be read from.
 */
export function gitHubHostFromUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.host : null;
  } catch {
    return null;
  }
}

/**
 * The picture a plain login's account is served at, which costs no request at
 * all. Null for an app account and for anything else that has to be looked up:
 * a bot's login is not a name the web host resolves, and guessing would show
 * somebody else's face.
 */
export function derivedGitHubAvatarUrl(input: {
  readonly host: string | null;
  readonly login: string;
  readonly isBot: boolean;
}): string | null {
  if (input.host === null || input.isBot || !PLAIN_LOGIN.test(input.login.trim())) {
    return null;
  }
  return `https://${input.host}/${input.login.trim()}.png?size=${AVATAR_SIZE}`;
}

/**
 * The pictures of the accounts a listing could not derive one for, asked about
 * together. `nodes(ids:)` takes every id in one request, and both kinds of
 * account that can open a pull request answer with a login and a picture.
 */
export const AVATAR_NODES_GRAPHQL_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on User { login avatarUrl }
    ... on Bot { login avatarUrl }
  }
}`;

const RawAvatarNodesSchema = Schema.Struct({
  data: Schema.Struct({
    nodes: Schema.optional(
      Schema.NullOr(
        Schema.Array(
          Schema.NullOr(
            Schema.Struct({
              login: Schema.optional(Schema.NullOr(Schema.String)),
              avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      ),
    ),
  }),
});

const decodeAvatarNodes = decodeJsonResult(RawAvatarNodesSchema);

/**
 * The looked-up pictures, keyed by lowercased login: an id is only ever asked
 * about on behalf of the login that carried it, and a node the host would not
 * name is simply left out.
 */
export function decodeGitHubAvatarNodesJson(
  raw: string,
): Result.Result<ReadonlyMap<string, string>, DecodeFailure> {
  const decoded = decodeAvatarNodes(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }

  const byLogin = new Map<string, string>();
  for (const node of decoded.success.data.nodes ?? []) {
    const login = nonEmptyText(node?.login);
    const avatarUrl = nonEmptyText(node?.avatarUrl);
    if (login !== null && avatarUrl !== null) {
      byLogin.set(login.toLowerCase(), avatarUrl);
    }
  }
  return Result.succeed(byLogin);
}
