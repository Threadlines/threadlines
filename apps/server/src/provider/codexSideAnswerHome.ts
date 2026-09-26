/**
 * The home a Codex side-answer runtime runs in, and the sign-in it borrows.
 *
 * A room's side answer runs in its own locked-down Codex app server (see
 * docs/design/rooms-slice-2.md). Loading the user's own Codex home would load
 * their MCP servers, plugins, hooks and trusted projects, and turning those
 * off one by one is never complete. So the runtime gets a temporary home of
 * its own, holding only a generated config and, when it answers from an
 * agent's conversation, a copy of that conversation's rollout. Resuming a
 * copy is a fork that can never touch the original.
 *
 * The sign-in is never copied: a copied refresh token can be rotated by the
 * copy and invalidate the user's real login. A ChatGPT sign-in is handed over
 * through Codex's external-auth mode instead (an access token Codex never
 * refreshes itself), re-read from the user's home whenever Codex asks.
 */
import * as Effect from "effect/Effect";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SIDE_HOME_PREFIX = "threadlines-side-";

export type CodexBorrowedSignIn =
  | {
      readonly kind: "chatgpt";
      readonly accessToken: string;
      readonly chatgptAccountId: string;
      readonly chatgptPlanType?: string;
    }
  | { readonly kind: "apiKey"; readonly apiKey: string };

export class CodexSideAnswerHomeError extends Error {
  override readonly name = "CodexSideAnswerHomeError";
}

/** The user's own Codex home: the configured one, else `~/.codex`. */
export function codexSignInHome(configuredHome: string | undefined): string {
  if (configuredHome === undefined || configuredHome.trim() === "") {
    return path.join(os.homedir(), ".codex");
  }
  return configuredHome.startsWith("~/")
    ? path.join(os.homedir(), configuredHome.slice(2))
    : configuredHome;
}

const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return decoded !== null && typeof decoded === "object"
      ? (decoded as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** Read, never write, the sign-in in the user's Codex home. */
export const readCodexSignIn = (signInHome: string) =>
  Effect.tryPromise({
    try: async (): Promise<CodexBorrowedSignIn> => {
      const raw: unknown = JSON.parse(
        await fs.readFile(path.join(signInHome, "auth.json"), "utf8"),
      );
      const auth = (raw ?? {}) as {
        readonly OPENAI_API_KEY?: unknown;
        readonly tokens?: {
          readonly access_token?: unknown;
          readonly account_id?: unknown;
          readonly id_token?: unknown;
        };
      };
      const accessToken = auth.tokens?.access_token;
      const accountId = auth.tokens?.account_id;
      if (typeof accessToken === "string" && typeof accountId === "string") {
        const claims =
          typeof auth.tokens?.id_token === "string" ? decodeJwtPayload(auth.tokens.id_token) : null;
        const openaiAuth = claims?.["https://api.openai.com/auth"] as
          | { readonly chatgpt_plan_type?: unknown }
          | undefined;
        const plan = openaiAuth?.chatgpt_plan_type;
        return {
          kind: "chatgpt",
          accessToken,
          chatgptAccountId: accountId,
          ...(typeof plan === "string" ? { chatgptPlanType: plan } : {}),
        };
      }
      if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.length > 0) {
        return { kind: "apiKey", apiKey: auth.OPENAI_API_KEY };
      }
      throw new CodexSideAnswerHomeError("Codex is not signed in.");
    },
    catch: (cause) =>
      cause instanceof CodexSideAnswerHomeError
        ? cause
        : new CodexSideAnswerHomeError(
            `Could not read the Codex sign-in: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
  });

/** The rollout file of one Codex conversation in a home, if it is there. */
export const findCodexRollout = (home: string, providerThreadId: string) =>
  Effect.promise(async () => {
    const wanted = `${providerThreadId}.jsonl`;
    const walk = async (dir: string): Promise<string | undefined> => {
      let entries: Array<import("node:fs").Dirent>;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return undefined;
      }
      for (const entry of entries) {
        const next = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = await walk(next);
          if (found !== undefined) return found;
        } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(wanted)) {
          return next;
        }
      }
      return undefined;
    };
    return walk(path.join(home, "sessions"));
  });

/**
 * Config for a side-answer runtime. The same values are also passed as `-c`
 * flags at spawn (see `codexSideAnswerAppServerArgs`), so neither alone has to
 * be trusted.
 */
export const CODEX_SIDE_ANSWER_CONFIG = [
  `approval_policy = "never"`,
  `sandbox_mode = "read-only"`,
  "",
  "[features]",
  "hooks = false",
  "apps = false",
  "default_mode_request_user_input = false",
  "",
].join("\n");

export interface CodexSideAnswerHome {
  readonly homePath: string;
  /** The copied conversation, when the side answer continues one. */
  readonly rolloutPath?: string;
}

/**
 * Make a fresh home for one side answer. With a source conversation, its
 * rollout is copied in, keeping its path under `sessions/`, so resuming it
 * inside this home forks it. A source that cannot be found fails the start:
 * the caller seeds from the transcript instead of pretending to fork.
 */
export const prepareCodexSideAnswerHome = (input: {
  readonly signInHome: string;
  readonly sourceProviderThreadId?: string;
}) =>
  Effect.gen(function* () {
    const homePath = yield* Effect.tryPromise({
      try: () => fs.mkdtemp(path.join(os.tmpdir(), `${SIDE_HOME_PREFIX}${randomUUID()}-`)),
      catch: (cause) =>
        new CodexSideAnswerHomeError(`Could not make a Codex side-answer home: ${String(cause)}`),
    });
    yield* Effect.tryPromise({
      try: () => fs.writeFile(path.join(homePath, "config.toml"), CODEX_SIDE_ANSWER_CONFIG),
      catch: (cause) =>
        new CodexSideAnswerHomeError(`Could not write the side-answer config: ${String(cause)}`),
    });
    if (input.sourceProviderThreadId === undefined) {
      return { homePath } satisfies CodexSideAnswerHome;
    }
    const sourceRollout = yield* findCodexRollout(input.signInHome, input.sourceProviderThreadId);
    if (sourceRollout === undefined) {
      yield* removeCodexSideAnswerHome(homePath);
      return yield* Effect.fail(
        new CodexSideAnswerHomeError(
          `Codex conversation ${input.sourceProviderThreadId} was not found to answer from.`,
        ),
      );
    }
    const rolloutPath = path.join(homePath, path.relative(input.signInHome, sourceRollout));
    yield* Effect.tryPromise({
      try: async () => {
        await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
        await fs.copyFile(sourceRollout, rolloutPath);
      },
      catch: (cause) =>
        new CodexSideAnswerHomeError(`Could not copy the conversation: ${String(cause)}`),
    }).pipe(Effect.tapError(() => removeCodexSideAnswerHome(homePath)));
    return { homePath, rolloutPath } satisfies CodexSideAnswerHome;
  });

/**
 * Delete a side-answer home. Refuses anything that is not one of ours in the
 * temp directory, so a misrouted path can never reach a real Codex home.
 */
export const removeCodexSideAnswerHome = (homePath: string) =>
  Effect.promise(async () => {
    const tmp = await fs.realpath(os.tmpdir()).catch(() => os.tmpdir());
    const resolved = await fs.realpath(homePath).catch(() => null);
    if (
      resolved === null ||
      path.dirname(resolved) !== tmp ||
      !path.basename(resolved).startsWith(SIDE_HOME_PREFIX)
    ) {
      return false;
    }
    await fs.rm(resolved, { recursive: true, force: true });
    return true;
  });
