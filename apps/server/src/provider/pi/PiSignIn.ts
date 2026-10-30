/**
 * PiSignIn — one Pi sign-in, asked in Threadlines' sign-in panel instead of
 * Pi's terminal app (docs/providers/pi.md, "Install, Update and Sign In").
 *
 * It starts a short-lived `pi --mode rpc --no-session` with the sign-in
 * extension (`PiSignInExtensionSource`) and runs `/threadlines-sign-in`. The
 * extension asks which provider to connect and then whatever that provider's
 * sign-in needs; each question becomes a question in the panel, and the
 * answer goes back as the dialog's response. The sign-in page opens like any
 * browser sign-in, and a device code stays in the panel until the run ends.
 *
 * Records are read without pause while questions wait: Pi can take a question
 * back (its browser callback won the race against a pasted address), and the
 * outcome arrives as a record. The command's ack resolves apart from the
 * record stream, so the outcome is read only once every record Pi wrote
 * before it has been handled.
 *
 * Closing the run's scope ends Pi, which also frees the port a browser
 * sign-in listens on, and releases Threadlines' copy of Pi.
 *
 * @module provider/pi/PiSignIn
 */
import * as NodePath from "node:path";

import type { ProviderInstanceEnvironment } from "@threadlines/contracts";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import type { ProviderAuthQuestion } from "../ProviderDriver.ts";
import { type PiLaunch, piProcessArgs, piProcessEnvironment } from "./PiLaunch.ts";
import {
  decodePi,
  PI_DIALOG_METHODS,
  PiCommands,
  PiExtensionError,
  PiExtensionUiRequest,
} from "./PiProtocol.ts";
import { type PiRpc, startPiRpc } from "./PiRpc.ts";
import { removePiSecretsFile, writePiSecretsFile } from "./PiSecrets.ts";
import {
  PI_SIGN_IN_COMMAND,
  PI_SIGN_IN_EXTENSION_SOURCE,
  PI_SIGN_IN_PREFIX,
  piSignInExtensionFileName,
} from "./PiSignInExtensionSource.ts";

/** How long Pi may take to end after the sign-in before it is killed. */
const EXIT_GRACE = Duration.seconds(3);
/** How long the records Pi wrote before its ack may take to be handled. */
const DRAIN_TIMEOUT = Duration.seconds(5);

export const PI_SIGN_IN_UNSUPPORTED_MESSAGE =
  "This Pi can't sign in from Threadlines. Use Pi's own sign-in below instead.";

const PiSignInQuestion = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["choice", "text", "secret"]),
  message: Schema.String,
  placeholder: Schema.optional(Schema.String),
  options: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        detail: Schema.optional(Schema.String),
        group: Schema.optional(Schema.String),
        configured: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});

/** What the extension tells Threadlines (see `PiSignInExtensionSource`). */
export const PiSignInNotice = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("auth_url"),
    url: Schema.String,
    instructions: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("device_code"), code: Schema.String, url: Schema.String }),
  Schema.Struct({ type: Schema.Literals(["info", "progress"]), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("withdrawn"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("done"), provider: Schema.String, method: Schema.String }),
  Schema.Struct({ type: Schema.Literal("failed"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literals(["cancelled", "unsupported"]) }),
]);
export type PiSignInNotice = typeof PiSignInNotice.Type;

/** The JSON after `<prefix><nonce>:` in a title or notification of this run, decoded. */
export function readPiSignInPayload<S extends Schema.Top>(
  schema: S,
  text: string | undefined,
  nonce: string,
): Option.Option<S["Type"]> {
  const prefix = `${PI_SIGN_IN_PREFIX}${nonce}:`;
  if (!text?.startsWith(prefix)) return Option.none();
  try {
    return decodePi(schema)(JSON.parse(text.slice(prefix.length)));
  } catch {
    return Option.none();
  }
}

/** The outcome a finished sign-in reports, as the panel's result. */
export function piSignInOutcome(
  notice: PiSignInNotice | undefined,
  extensionError: string | undefined,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  switch (notice?.type) {
    case "done":
      return { ok: true };
    case "failed":
      return { ok: false, message: notice.message };
    case "cancelled":
      return { ok: false, message: "Sign-in cancelled." };
    case "unsupported":
      return { ok: false, message: PI_SIGN_IN_UNSUPPORTED_MESSAGE };
    default:
      return {
        ok: false,
        message: extensionError
          ? `Pi's sign-in stopped: ${extensionError}`
          : "Pi's sign-in ended without signing in.",
      };
  }
}

export interface PiSignInOptions {
  readonly launch: PiLaunch;
  /** The instance's extra `pi` flags. */
  readonly launchArgs: ReadonlyArray<string>;
  readonly instanceEnvironment: ProviderInstanceEnvironment | undefined;
  readonly cwd: string;
  /** Threadlines' Pi folder: the extension and the nonce's private file go here. */
  readonly extensionDir: string;
  /** The server's environment; tests pass their own. */
  readonly baseEnvironment?: NodeJS.ProcessEnv | undefined;
  /** The sign-in panel (`ProviderInstanceAuthFlows.run`). */
  readonly report: (line: string) => Effect.Effect<void>;
  readonly ask: (question: ProviderAuthQuestion) => Effect.Effect<string | null>;
  readonly showCode: (request: {
    readonly url: string;
    readonly code: string;
    readonly message: string | null;
  }) => Effect.Effect<void>;
}

const failure = (message: string) => ({ message });

/** Runs one sign-in to its end; fails with a plain reason when it didn't sign in. */
export const runPiSignIn = (options: PiSignInOptions) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const scope = yield* Scope.Scope;

      const extensionPath = NodePath.join(options.extensionDir, piSignInExtensionFileName());
      if (!(yield* fileSystem.exists(extensionPath).pipe(Effect.orElseSucceed(() => false)))) {
        yield* fileSystem.makeDirectory(options.extensionDir, { recursive: true });
        const staging = `${extensionPath}.${yield* randomUUIDv4}.tmp`;
        yield* fileSystem.writeFileString(staging, PI_SIGN_IN_EXTENSION_SOURCE, { mode: 0o600 });
        yield* fileSystem.rename(staging, extensionPath);
      }

      const nonce = (yield* randomUUIDv4).replaceAll("-", "");
      const secretsFile = yield* Effect.tryPromise(() =>
        writePiSecretsFile(NodePath.join(options.extensionDir, "run"), { token: "", nonce }),
      );
      yield* Scope.addFinalizer(
        scope,
        Effect.promise(() => removePiSecretsFile(secretsFile)),
      );

      const launcher = yield* options.launch;
      const rpc = yield* startPiRpc({
        command: launcher.command,
        args: piProcessArgs(launcher, {
          purpose: "signIn",
          launchArgs: options.launchArgs,
          extensionPath,
        }),
        cwd: options.cwd,
        environment: piProcessEnvironment({
          instanceEnvironment: options.instanceEnvironment,
          ...(options.baseEnvironment ? { baseEnv: options.baseEnvironment } : {}),
          signInSecretsFile: secretsFile,
        }),
        exitGrace: EXIT_GRACE,
      });
      const commands = decodePi(PiCommands)(
        yield* rpc.request({ type: "get_commands" }).pipe(Effect.orElseSucceed(() => undefined)),
      );
      yield* Effect.promise(() => removePiSecretsFile(secretsFile));
      if (
        Option.isNone(commands) ||
        !commands.value.commands.some((command) => command.name === PI_SIGN_IN_COMMAND)
      ) {
        return yield* Effect.fail(failure("Threadlines' sign-in didn't load in Pi."));
      }

      const outcome = yield* readSignIn(rpc, nonce, options, scope);
      if (!outcome.ok) return yield* Effect.fail(failure(outcome.message));
    }),
  ).pipe(
    Effect.mapError((error): { readonly message: string } =>
      typeof error === "object" && error !== null && "message" in error
        ? { message: String(error.message) }
        : { message: String(error) },
    ),
  );

/** Sends the command, answers the extension's dialogs, and reads the outcome. */
const readSignIn = (rpc: PiRpc, nonce: string, options: PiSignInOptions, scope: Scope.Scope) =>
  Effect.gen(function* () {
    let processed = 0;
    let last: PiSignInNotice | undefined;
    let extensionError: string | undefined;
    // Questions waiting for the user, by the extension's question id.
    const waiting = new Map<string, Fiber.Fiber<void>>();

    const respond = (id: string, answer: string | null) =>
      rpc.send(
        answer === null
          ? { type: "extension_ui_response", id, cancelled: true }
          : { type: "extension_ui_response", id, value: answer },
      );

    const handleNotice = (notice: PiSignInNotice) =>
      Effect.gen(function* () {
        switch (notice.type) {
          case "auth_url":
            // The panel opens the first address it is given.
            yield* options.report(`Sign-in page: ${notice.url}`);
            return;
          case "device_code":
            yield* options.showCode({
              url: notice.url,
              code: notice.code,
              message: "Enter this code on the sign-in page.",
            });
            return;
          case "info":
          case "progress":
            yield* options.report(notice.message);
            return;
          case "withdrawn": {
            const fiber = waiting.get(notice.id);
            waiting.delete(notice.id);
            if (fiber) yield* Fiber.interrupt(fiber);
            return;
          }
          default:
            last = notice;
        }
      });

    yield* rpc.records.pipe(
      Stream.runForEach((record) =>
        Effect.gen(function* () {
          if (record.type === "extension_error") {
            const error = decodePi(PiExtensionError)(record);
            if (
              Option.isSome(error) &&
              error.value.extensionPath === `command:${PI_SIGN_IN_COMMAND}`
            ) {
              extensionError = error.value.error;
            }
            return;
          }
          if (record.type !== "extension_ui_request") return;
          const request = decodePi(PiExtensionUiRequest)(record);
          if (Option.isNone(request)) return;
          const { id, method } = request.value;
          if (method === "notify") {
            const notice = readPiSignInPayload(PiSignInNotice, request.value.message, nonce);
            if (Option.isSome(notice)) yield* handleNotice(notice.value);
            return;
          }
          if (!PI_DIALOG_METHODS.has(method)) return;
          const question =
            method === "select" || method === "input"
              ? readPiSignInPayload(PiSignInQuestion, request.value.title, nonce)
              : Option.none();
          // Another extension's dialog has nobody to answer it here.
          if (Option.isNone(question)) return yield* respond(id, null);
          const { id: questionId, ...asked } = question.value;
          const fiber = yield* options.ask(asked).pipe(
            Effect.flatMap((answer) => respond(id, answer)),
            Effect.ensuring(Effect.sync(() => waiting.delete(questionId))),
            Effect.forkIn(scope),
          );
          waiting.set(questionId, fiber);
        }).pipe(Effect.ensuring(Effect.sync(() => (processed += 1)))),
      ),
      Effect.forkIn(scope),
    );

    yield* rpc.request(
      { type: "prompt", message: `/${PI_SIGN_IN_COMMAND} ${nonce}` },
      { timeout: null },
    );
    // Everything Pi wrote before the ack, the outcome among it, is handled first.
    const written = rpc.recordCount();
    yield* Effect.sync(() => processed >= written).pipe(
      Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: (done) => done }),
      Effect.timeoutOption(DRAIN_TIMEOUT),
    );
    return piSignInOutcome(last, extensionError);
  });

/** The services a sign-in runs with. */
export type PiSignInEnv = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem;
