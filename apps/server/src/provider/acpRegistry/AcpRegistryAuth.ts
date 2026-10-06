// @effect-diagnostics nodeBuiltinImport:off - a scratch folder for the sign-in process
/**
 * AcpRegistryAuth — sign-in and sign-out for one community agent, with the
 * agent's own methods.
 *
 * Every flow closes the agent's launch gate first, as Antigravity's do: no
 * new process of the agent starts, its sessions stop (they hold the old
 * sign-in in memory), and the flow waits for the rest to end.
 *
 * - An `agent` method: a process of the agent is started and asked to
 *   `authenticate`; a `session/new` that then opens is the proof. Most
 *   agents open the browser themselves, on the computer they run on. One
 *   that instead asks for a page to be opened gets it shown to the user,
 *   who opens it or doesn't: an address from an agent Threadlines hasn't
 *   tested is never opened for them.
 * - A `terminal` method: the agent's own login command, in the sign-in
 *   terminal (`terminalCommand`). Exit code 0 is followed by a real check.
 * - Sign-out: the ACP `logout` request.
 *
 * @module provider/acpRegistry/AcpRegistryAuth
 */
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { AcpRegistrySettings, ProviderAuthFlow } from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { ChildProcessSpawner } from "effect/unstable/process";

import type { AcpProviderDescriptor } from "../acp/AcpProviderDescriptor.ts";
import { makeAcpProviderRuntime } from "../acp/AcpProviderRuntime.ts";
import {
  acpRegistrySignInPlans,
  type AcpRegistryLaunchPurpose,
} from "../acp/AcpRegistrySupport.ts";
import { closeLaunchGate, withLaunchGateClosed } from "../managedRuntime/LaunchGate.ts";
import type { ProviderInstanceAuthFlows } from "../ProviderDriver.ts";
import {
  type AcpRegistryAgentState,
  boundAgentText,
  bumpAcpRegistryAuthGeneration,
  readAcpRegistryOffers,
  writeAcpRegistryOffers,
} from "./AcpRegistryAgentState.ts";
import type { AcpRegistryInstaller } from "./AcpRegistryInstaller.ts";
import { planAcpRegistryLaunch } from "./AcpRegistryLaunch.ts";
import { selectAcpRegistrySignIn } from "./AcpRegistrySignIn.ts";

const SIGN_IN_TIMEOUT = Duration.minutes(5);
const SIGN_OUT_TIMEOUT = Duration.seconds(90);

/** `elicitation/create`, as far as a sign-in needs it: a page to open. */
const PageElicitation = Schema.Struct({
  mode: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});

const failure = (message: string) => ({ message });

export interface AcpRegistryAuthInput {
  readonly displayName: string;
  readonly agentRoot: string;
  readonly installer: AcpRegistryInstaller;
  readonly state: AcpRegistryAgentState;
  readonly settings: AcpRegistrySettings;
  /** The server's environment with the instance's own variables applied. */
  readonly environment: NodeJS.ProcessEnv;
  readonly instanceVariableNames: ReadonlySet<string>;
  readonly allowsEnvName: (name: string) => boolean;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** A descriptor whose launches ignore the gate: the flow has closed it itself. */
  readonly signInDescriptor: (
    purpose: AcpRegistryLaunchPurpose,
  ) => AcpProviderDescriptor<AcpRegistrySettings>;
  /** Stops every session of the instance. */
  readonly stopSessions: Effect.Effect<void>;
}

export function makeAcpRegistryAuthFlows(input: AcpRegistryAuthInput): ProviderInstanceAuthFlows {
  const { displayName, installer, state } = input;

  /** The method this sign-in would use, from what the agent last said about itself. */
  const chosenMethod = Effect.gen(function* () {
    const installed = yield* installer.installed;
    if (!installed) return yield* Effect.fail(failure(`${displayName} isn't installed.`));
    const offers = yield* readAcpRegistryOffers(
      state,
      input.agentRoot,
      installed.receipt.recipeDigest,
    );
    const plans = acpRegistrySignInPlans({
      installed,
      authMethods: offers?.authMethods ?? [],
      allowsEnvName: input.allowsEnvName,
    });
    const plan = selectAcpRegistrySignIn(plans, input.settings.authMethodId);
    if (!plan) {
      return yield* Effect.fail(
        failure(
          plans.length === 0
            ? `${displayName} hasn't said how it signs in. Check it again, then try once more.`
            : `${displayName} signs in its own way. See its website for how.`,
        ),
      );
    }
    return { installed, plan };
  });

  /** Runs `use` with the agent closed and every process of it gone, then lets it start again. */
  const closed = <A, E>(
    emit: (line: string) => Effect.Effect<void>,
    use: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | { readonly message: string }> =>
    withLaunchGateClosed(
      state.gate,
      {
        whenAlreadyClosed: () => failure(`${displayName} is already signing in or out.`),
        whenStillHeld: () =>
          failure(`${displayName} is still busy with other work. Try again in a moment.`),
        stop: input.stopSessions,
        onWaiting: emit(`Waiting for ${displayName} to finish its current work…`),
      },
      use,
    );

  const withScratchDir = <A, E>(use: (dir: string) => Effect.Effect<A, E, Scope.Scope>) =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "threadlines-agent-sign-in-")),
        catch: () => new Error(`Couldn't make a folder to start ${displayName} in.`),
      }),
      (dir) => use(dir).pipe(Effect.scoped),
      (dir) =>
        Effect.promise(() =>
          NodeFS.rm(dir, { recursive: true, force: true }).catch(() => undefined),
        ),
    );

  const runtime = (cwd: string, authMethodId?: string) =>
    makeAcpProviderRuntime(input.signInDescriptor({ kind: "signIn" }), {
      settings: input.settings,
      environment: input.environment,
      childProcessSpawner: input.childProcessSpawner,
      cwd,
      clientInfo: { name: "threadlines", version: "0.0.0" },
      ...(authMethodId ? { authMethodId } : {}),
    });

  /** What a sign-in or sign-out changes: everything known about the agent's sign-in is old. */
  const afterAuthChange = (verifiedAuthMethodId: string | null) =>
    Effect.gen(function* () {
      const installed = yield* installer.installed;
      bumpAcpRegistryAuthGeneration(state);
      if (!installed) return;
      yield* writeAcpRegistryOffers(
        state,
        input.agentRoot,
        { recipeDigest: installed.receipt.recipeDigest, authGeneration: state.authGeneration },
        (current) => ({
          authMethods: current?.authMethods ?? [],
          canSignOut: current?.canSignOut ?? false,
          reportedVersion: current?.reportedVersion ?? null,
          models: current?.models ?? null,
          verifiedAuthMethodId,
        }),
      );
    });

  const signInWithAgent = (
    methodId: string,
    emit: (line: string) => Effect.Effect<void>,
    requestPage: (request: {
      readonly url: string;
      readonly message: string | null;
    }) => Effect.Effect<boolean>,
  ) =>
    withScratchDir((scratch) =>
      Effect.gen(function* () {
        const acp = yield* runtime(scratch, methodId);
        yield* acp.handleExtRequest("elicitation/create", PageElicitation, (request) =>
          Effect.gen(function* () {
            const url = request.url?.trim() ?? "";
            if (request.mode !== "url" || !/^https?:\/\//iu.test(url)) return { action: "decline" };
            yield* emit(`${displayName} asked to open a sign-in page.`);
            const opened = yield* requestPage({
              url,
              message: boundAgentText(request.message, 300),
            });
            return { action: opened ? "accept" : "decline" };
          }),
        );
        yield* emit(`Starting ${displayName}…`);
        // initialize, authenticate (waits for the user), then session/new
        // proves the sign-in works.
        yield* acp.start().pipe(
          Effect.timeoutOrElse({
            duration: SIGN_IN_TIMEOUT,
            orElse: () => Effect.fail(new Error("Sign-in timed out after 5 minutes. Try again.")),
          }),
        );
        yield* afterAuthChange(methodId);
        yield* emit("Signed in.");
      }),
    ).pipe(
      Effect.mapError((error) =>
        failure(
          boundAgentText(error instanceof Error ? error.message : String(error), 300) ??
            "Sign-in failed.",
        ),
      ),
    );

  const signOut = (emit: (line: string) => Effect.Effect<void>) =>
    withScratchDir((scratch) =>
      Effect.gen(function* () {
        const acp = yield* runtime(scratch);
        yield* emit(`Signing out of ${displayName}…`);
        yield* acp.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "threadlines", version: "0.0.0" },
        });
        yield* acp.request("logout", {});
        yield* afterAuthChange(null);
        yield* emit("Signed out.");
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: SIGN_OUT_TIMEOUT,
        orElse: () => Effect.fail(new Error(`${displayName} did not finish signing out.`)),
      }),
      Effect.mapError((error) =>
        failure(
          boundAgentText(error instanceof Error ? error.message : String(error), 300) ??
            "Sign-out failed.",
        ),
      ),
    );

  return {
    // Read at each start: whether the agent can sign out is only known once it has said so.
    get flows(): ReadonlyArray<ProviderAuthFlow> {
      return state.offers?.canSignOut ? ["login", "logout"] : ["login"];
    },
    describe: (flow) =>
      flow === "logout" ? `Sign out of ${displayName}` : `Sign in to ${displayName}`,
    run: ({ flow, report: emit, requestPage }) => {
      if (flow === "logout") return closed(emit, signOut(emit));
      if (flow !== "login") return Effect.fail(failure(`${displayName} has no such sign-in flow.`));
      return chosenMethod.pipe(
        Effect.flatMap(({ plan }) =>
          closed(emit, signInWithAgent(plan.method.id, emit, requestPage)),
        ),
      );
    },
    completeRedirect: () =>
      Effect.fail(failure(`Finish signing in on the computer ${displayName} runs on.`)),
    terminalCommand: (flow) =>
      Effect.gen(function* () {
        if (flow !== "login") return undefined;
        const { installed, plan } = yield* chosenMethod;
        if (plan.method.kind !== "terminal" || !plan.command) return undefined;
        const command = plan.command;
        // A command of the agent's own program gets the agent's environment;
        // its arguments are the method's, in place of the registry's.
        const isAgentProgram = command.program === installed.launch.program;
        const launch = planAcpRegistryLaunch({
          launch: {
            program: command.program,
            prefixArgs: [],
            needsShell: isAgentProgram && installed.launch.needsShell,
          },
          args: command.args,
          recipeEnv: installed.receipt.recipe.env,
          environment: input.environment,
          instanceVariableNames: input.instanceVariableNames,
          nodeBinDir: installed.node?.binDir ?? null,
          extraEnv: command.env,
        });
        if (!launch.ok) return yield* Effect.fail(failure(launch.reason));
        if (launch.shell) {
          return yield* Effect.fail(
            failure(`${displayName}'s login command can't be run from Threadlines on Windows.`),
          );
        }
        // Closed for as long as the command runs: reopened by `finished`.
        // Waiting for the agent's other work to stop can be given up; from
        // the moment the gate is closed until the command is handed over,
        // nothing can cut in and leave it closed with nobody to reopen it.
        const { reopen, lease } = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const reopenGate = yield* restore(
              closeLaunchGate(state.gate, {
                whenAlreadyClosed: () => failure(`${displayName} is already signing in or out.`),
                whenStillHeld: () =>
                  failure(`${displayName} is still busy with other work. Try again in a moment.`),
                stop: input.stopSessions,
              }),
            );
            // The agent's files stay leased while its login command runs from them.
            const leaseScope = yield* Scope.make();
            yield* installer.acquire.pipe(
              Scope.provide(leaseScope),
              Effect.mapError((error) => failure(error.message)),
              Effect.tapError(() =>
                Scope.close(leaseScope, Exit.void).pipe(Effect.andThen(reopenGate)),
              ),
            );
            return { reopen: reopenGate, lease: leaseScope };
          }),
        );
        return {
          file: launch.command,
          args: launch.args,
          env: launch.env,
          display: [NodePath.basename(command.program), ...command.args].join(" "),
          finished: (exitCode) =>
            Effect.gen(function* () {
              yield* Scope.close(lease, Exit.void);
              if (exitCode === 0) yield* afterAuthChange(null);
              yield* reopen;
            }),
        };
      }),
  };
}
