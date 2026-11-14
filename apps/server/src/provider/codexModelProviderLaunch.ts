/**
 * Points a one-shot `codex exec` at the model provider the user's Codex runs
 * on, when that is not OpenAI (a company gateway, say).
 *
 * Titles, commit messages and the like run `codex exec --ignore-user-config`,
 * so that the user's MCP servers, notify hooks and memories stay out of a
 * one-line answer. That also leaves out `model_provider`, and the run goes to
 * OpenAI whatever Codex's chats use. Loading the whole config back in brings
 * the MCP servers with it (overriding `mcp_servers` on the command line does
 * not stop them), so the provider alone is handed over as `-c` overrides: its
 * id, and its definition as Codex's own `config/read` reports it.
 *
 * A definition can hold secrets as plain values (`experimental_bearer_token`,
 * `http_headers`). Arguments show in the process list, so those never go
 * there: each is moved to an environment variable of the run, which Codex
 * reads through `env_key` and `env_http_headers` to the same effect. Where a
 * secret sits in a setting with no such variable form (a key in
 * `query_params` or in an address, a password in an address, a secret among
 * the `auth` command's arguments), there is no launch at all, and the run
 * goes to OpenAI as it did before.
 *
 * @module codexModelProviderLaunch
 */

/** What to add to a `codex exec` run so it uses the provider. */
export interface CodexModelProviderLaunch {
  readonly providerId: string;
  /** The model Codex's config names: the one known to work on this provider. */
  readonly model?: string;
  /** `-c` overrides, free of secret values. */
  readonly args: ReadonlyArray<string>;
  /** Secret values the overrides name, to set in the run's environment. */
  readonly environment: Readonly<Record<string, string>>;
}

const TOKEN_ENV = "THREADLINES_CODEX_PROVIDER_TOKEN";
const HEADER_ENV = "THREADLINES_CODEX_PROVIDER_HEADER";

/** A parameter, flag or variable whose name says it carries a credential. */
const CREDENTIAL_NAME = /key|token|secret|sig|password|passwd|auth|credential/iu;

type JsonRecord = { readonly [key: string]: unknown };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
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
 * Whether an address carries a credential: a user name or password, or a
 * query parameter named like one. Text that is not a URL carries none.
 */
function hasCredentialInAddress(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.username !== "" ||
    url.password !== "" ||
    [...url.searchParams.keys()].some((name) => CREDENTIAL_NAME.test(name))
  );
}

/**
 * Whether anything in the `auth` command reads like a credential: a flag such
 * as `--client-secret`, or a variable it sets. The command's own name and
 * plain arguments (an audience, a profile) do not.
 */
function hasCredentialInAuthCommand(auth: unknown): boolean {
  if (!isRecord(auth)) return false;
  return Object.entries(auth).some(([field, value]) => {
    if (field === "command" || field === "cwd") return false;
    if (Array.isArray(value)) {
      return value.some((entry) => typeof entry === "string" && CREDENTIAL_NAME.test(entry));
    }
    return isRecord(value) && Object.keys(value).some((name) => CREDENTIAL_NAME.test(name));
  });
}

/**
 * Whether the definition holds a secret that only the command line could
 * carry: Codex reads these settings as plain values only.
 */
function hasSecretOnlyArgumentsCanCarry(definition: JsonRecord): boolean {
  const queryParams = definition.query_params;
  return (
    (isRecord(queryParams) &&
      Object.keys(queryParams).some((name) => CREDENTIAL_NAME.test(name))) ||
    hasCredentialInAddress(definition.base_url) ||
    hasCredentialInAddress(definition.model_catalog_url) ||
    hasCredentialInAuthCommand(definition.auth)
  );
}

/** Every environment variable the definition names for Codex to read. */
function referencedVariables(definition: JsonRecord): ReadonlyArray<string> {
  const envHeaders = isRecord(definition.env_http_headers)
    ? Object.values(definition.env_http_headers)
    : [];
  return [definition.env_key, ...envHeaders].flatMap((name) => nonEmptyString(name) ?? []);
}

/** Whether a table already names `header`, as HTTP does: whatever its letter case. */
function findHeader(table: JsonRecord, header: string): string | undefined {
  const wanted = header.toLowerCase();
  return Object.keys(table).find((name) => name.toLowerCase() === wanted);
}

/**
 * The provider's definition with its plain secrets taken out and named by
 * environment variables instead, as Codex itself would resolve them:
 *
 * - `env_key` wins over `experimental_bearer_token` (and a missing variable
 *   is an error, not a fallback), so the token only matters without one.
 * - A header set both ways takes its `env_http_headers` value when that
 *   variable is set, its plain one otherwise.
 */
function withSecretsInEnvironment(
  definition: JsonRecord,
  runEnvironment: NodeJS.ProcessEnv,
): { readonly definition: JsonRecord; readonly environment: Record<string, string> } {
  const {
    experimental_bearer_token: bearerToken,
    http_headers: plainHeaders,
    ...rest
  } = definition;
  const next: Record<string, unknown> = { ...rest };
  const environment: Record<string, string> = {};
  // A name of ours must not be one the run already has, or one the definition
  // reads: it would hand Codex the wrong value under that name. Compared
  // without letter case, as Windows compares variable names.
  const taken = new Set(
    [...Object.keys(runEnvironment), ...referencedVariables(definition)].map((name) =>
      name.toUpperCase(),
    ),
  );
  const allocate = (base: string): string => {
    let name = base;
    for (let suffix = 1; taken.has(name.toUpperCase()); suffix += 1) {
      name = `${base}_${suffix}`;
    }
    taken.add(name.toUpperCase());
    return name;
  };

  const token = nonEmptyString(bearerToken);
  if (token !== undefined && nonEmptyString(rest.env_key) === undefined) {
    const variable = allocate(TOKEN_ENV);
    next.env_key = variable;
    environment[variable] = token;
  }

  if (isRecord(plainHeaders)) {
    const envHeaders: Record<string, unknown> = isRecord(rest.env_http_headers)
      ? { ...rest.env_http_headers }
      : {};
    for (const [header, value] of Object.entries(plainHeaders)) {
      if (typeof value !== "string") continue;
      const existing = findHeader(envHeaders, header);
      if (existing !== undefined) {
        const variable = nonEmptyString(envHeaders[existing]);
        if (variable !== undefined && nonEmptyString(runEnvironment[variable]) !== undefined) {
          continue;
        }
        delete envHeaders[existing];
      }
      const variable = allocate(HEADER_ENV);
      envHeaders[header] = variable;
      environment[variable] = value;
    }
    if (Object.keys(envHeaders).length > 0) {
      next.env_http_headers = envHeaders;
    }
  }

  return { definition: next, environment };
}

/**
 * The overrides for a `codex exec` run on provider `providerId`.
 * `definition` is the provider's entry in `config/read`'s `model_providers`;
 * leave it out for a provider Codex has built in, which needs only its id.
 * `environment` is the one the run starts with, to tell which of the
 * definition's variables are set. Undefined when the definition holds a
 * secret that could only travel on the command line.
 */
export function codexModelProviderLaunch(input: {
  readonly providerId: string;
  readonly model?: string | undefined;
  readonly definition?: unknown;
  readonly environment: NodeJS.ProcessEnv;
}): CodexModelProviderLaunch | undefined {
  const base = {
    providerId: input.providerId,
    ...(input.model ? { model: input.model } : {}),
  };
  const selectProvider = ["-c", `model_provider=${tomlString(input.providerId)}`];
  if (!isRecord(input.definition)) {
    return { ...base, args: selectProvider, environment: {} };
  }
  if (hasSecretOnlyArgumentsCanCarry(input.definition)) {
    return undefined;
  }
  const { definition, environment } = withSecretsInEnvironment(input.definition, input.environment);
  // The whole table, keyed by the quoted id: a dotted path would split an id
  // that has a dot in it.
  const table = `{${tomlString(input.providerId)} = ${tomlValue(definition) ?? "{}"}}`;
  return {
    ...base,
    args: [...selectProvider, "-c", `model_providers=${table}`],
    environment,
  };
}
