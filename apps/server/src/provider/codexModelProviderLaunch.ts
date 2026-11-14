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
 * A home of its own has no sign-in. A provider that signs in through Codex's
 * stored sign-in (`requires_openai_auth`, or a gateway's OAuth) therefore
 * gets no launch, and its runs go to OpenAI as they did before.
 *
 * @module codexModelProviderLaunch
 */

/** What a `codex exec` run needs to use the provider. */
export interface CodexModelProviderLaunch {
  readonly providerId: string;
  /** The model Codex's config names: the one known to work on this provider. */
  readonly model?: string;
  /**
   * The text of the run's own `config.toml`. It can hold the provider's
   * secrets: keep it out of logs, arguments and anything sent to a client.
   */
  readonly config: string;
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
 * a ChatGPT or API-key sign-in, or a gateway's OAuth tokens. A home made for
 * one run holds neither.
 */
function needsStoredSignIn(definition: JsonRecord): boolean {
  const oauth = definition.gateway_oauth;
  return definition.requires_openai_auth === true || (oauth !== undefined && oauth !== null);
}

/**
 * What a `codex exec` run on provider `providerId` needs. `definition` is the
 * provider's entry in `config/read`'s `model_providers`; leave it out for a
 * provider Codex has built in, which needs only its id. Undefined when the
 * provider needs the sign-in stored in the user's own Codex home.
 */
export function codexModelProviderLaunch(input: {
  readonly providerId: string;
  readonly model?: string | undefined;
  readonly definition?: unknown;
}): CodexModelProviderLaunch | undefined {
  const selectProvider = `model_provider = ${tomlString(input.providerId)}\n`;
  const base = {
    providerId: input.providerId,
    ...(input.model ? { model: input.model } : {}),
  };
  if (!isRecord(input.definition)) {
    return { ...base, config: selectProvider };
  }
  if (needsStoredSignIn(input.definition)) {
    return undefined;
  }
  // The whole table on one line, keyed by the quoted id: a `[model_providers.id]`
  // header would split an id that has a dot in it.
  const table = `{${tomlString(input.providerId)} = ${tomlValue(input.definition) ?? "{}"}}`;
  return { ...base, config: `${selectProvider}model_providers = ${table}\n` };
}
