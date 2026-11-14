/**
 * Points a one-shot `codex exec` at the model provider the user's Codex runs
 * on, when that is not OpenAI (a company gateway, say).
 *
 * Titles, commit messages and the like run `codex exec --ignore-user-config`,
 * so that the user's MCP servers, notify hooks and memories stay out of a
 * one-line answer. That also leaves out `model_provider`, and the run goes to
 * OpenAI whatever Codex's chats use. Loading the whole config back in brings
 * the MCP servers with it (overriding `mcp_servers` on the command line does
 * not stop them).
 *
 * So the run gets a Codex home of its own, holding one file: a config with
 * the provider alone, its id and its definition as Codex's own `config/read`
 * reports it. A definition can hold secrets (a token, headers, a key in its
 * address), which is why it travels in a file only its owner can read and
 * never as `-c` arguments, which show in the process list.
 *
 * A home of its own has no sign-in. A provider that signs in with what
 * Codex's home stores (`requires_openai_auth`, a gateway's OAuth, Amazon
 * Bedrock, Google Cloud) therefore gets no launch, and its runs go to OpenAI
 * as they did before. A provider Codex has built in has no definition to
 * hand over: it runs in the user's home, named by its id alone.
 *
 * @module codexModelProviderLaunch
 */

/** What a `codex exec` run needs to use the provider: `config` or `args`, never both. */
export interface CodexModelProviderLaunch {
  readonly providerId: string;
  /** The model Codex's config names: the one known to work on this provider. */
  readonly model?: string;
  /**
   * The text of the `config.toml` for a home of the run's own. It can hold
   * the provider's secrets: keep it out of logs, arguments and anything sent
   * to a client.
   */
  readonly config?: string;
  /**
   * For a provider Codex has built in: arguments beside `--ignore-user-config`
   * in the user's own home. Only the provider's id, never a secret.
   */
  readonly args?: ReadonlyArray<string>;
  /**
   * The definition's values that may be secret (its token, headers, query
   * parameters, a password in its address). Codex's error output can repeat
   * them, in a request's address say: strike them from anything shown or
   * logged with `redactCodexProviderSecrets`.
   */
  readonly secrets: ReadonlyArray<string>;
}

type JsonRecord = { readonly [key: string]: unknown };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A TOML basic string. JSON's escapes are all TOML's; DEL is the one control
 * character JSON leaves bare and TOML refuses.
 */
function tomlString(value: string): string {
  return JSON.stringify(value).replaceAll("\u007f", "\\u007F");
}

/**
 * A JSON value as inline TOML, or undefined for what TOML cannot hold (null,
 * a number that is not finite). Tables and arrays leave such entries out.
 */
function tomlValue(value: unknown): string | undefined {
  switch (typeof value) {
    case "string":
      return tomlString(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) ? String(value) : undefined;
    case "object": {
      if (value === null) return undefined;
      if (Array.isArray(value)) {
        const items = value.flatMap((item) => tomlValue(item) ?? []);
        return `[${items.join(", ")}]`;
      }
      const entries = Object.entries(value).flatMap(([key, entry]) => {
        const encoded = tomlValue(entry);
        return encoded === undefined ? [] : [`${tomlString(key)} = ${encoded}`];
      });
      return `{${entries.join(", ")}}`;
    }
    default:
      return undefined;
  }
}

/**
 * Whether the provider signs in with what the user's own Codex home stores:
 * a ChatGPT or API-key sign-in, a gateway's OAuth tokens, or the Amazon
 * Bedrock or Google Cloud credentials Codex keeps there. A home made for one
 * run holds none of them.
 */
function needsStoredSignIn(definition: JsonRecord): boolean {
  const set = (value: unknown) => value !== undefined && value !== null;
  return (
    definition.requires_openai_auth === true ||
    set(definition.gateway_oauth) ||
    set(definition.aws) ||
    set(definition.project_id) ||
    set(definition.location) ||
    set(definition.credential_file)
  );
}

/** Shorter than this, a value is not a secret worth striking, and striking it would mangle text. */
const MIN_SECRET_LENGTH = 6;

function stringValues(table: unknown): ReadonlyArray<string> {
  return isRecord(table)
    ? Object.values(table).filter((value): value is string => typeof value === "string")
    : [];
}

/** A password, user name or query values carried in an address. */
function addressSecrets(value: unknown): ReadonlyArray<string> {
  if (typeof value !== "string") return [];
  try {
    const url = new URL(value);
    return [
      decodeURIComponent(url.username),
      decodeURIComponent(url.password),
      ...url.searchParams.values(),
    ];
  } catch {
    return [];
  }
}

/** The definition's values that may be secret, longest first so one never hides inside another. */
function definitionSecrets(definition: JsonRecord): ReadonlyArray<string> {
  const candidates = [
    ...(typeof definition.experimental_bearer_token === "string"
      ? [definition.experimental_bearer_token]
      : []),
    ...stringValues(definition.http_headers),
    ...stringValues(definition.query_params),
    ...addressSecrets(definition.base_url),
    ...addressSecrets(definition.model_catalog_url),
  ];
  return [...new Set(candidates.filter((value) => value.length >= MIN_SECRET_LENGTH))].toSorted(
    (left, right) => right.length - left.length,
  );
}

/**
 * Text with the provider's secrets struck out, also where they appear
 * percent-encoded, as in the address of a failed request.
 */
export function redactCodexProviderSecrets(
  text: string,
  launch: Pick<CodexModelProviderLaunch, "secrets"> | undefined,
): string {
  let redacted = text;
  for (const secret of launch?.secrets ?? []) {
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      redacted = redacted.replaceAll(form, "[redacted]");
    }
  }
  return redacted;
}

/** A built-in provider's id, made of plain characters: safe as an argument on any platform. */
const PLAIN_PROVIDER_ID = /^[A-Za-z0-9_-]+$/u;

/**
 * What a `codex exec` run on provider `providerId` needs. `definition` is the
 * provider's entry in `config/read`'s `model_providers`; leave it out for a
 * provider Codex has built in. Undefined when the provider needs the sign-in
 * stored in the user's own Codex home.
 */
export function codexModelProviderLaunch(input: {
  readonly providerId: string;
  readonly model?: string | undefined;
  readonly definition?: unknown;
}): CodexModelProviderLaunch | undefined {
  const base = {
    providerId: input.providerId,
    ...(input.model ? { model: input.model } : {}),
  };
  if (!isRecord(input.definition)) {
    return PLAIN_PROVIDER_ID.test(input.providerId)
      ? { ...base, args: ["-c", `model_provider=${tomlString(input.providerId)}`], secrets: [] }
      : undefined;
  }
  if (needsStoredSignIn(input.definition)) {
    return undefined;
  }
  // The whole table on one line, keyed by the quoted id: a `[model_providers.id]`
  // header would split an id that has a dot in it.
  const table = `{${tomlString(input.providerId)} = ${tomlValue(input.definition) ?? "{}"}}`;
  return {
    ...base,
    config: `model_provider = ${tomlString(input.providerId)}\nmodel_providers = ${table}\n`,
    secrets: definitionSecrets(input.definition),
  };
}
