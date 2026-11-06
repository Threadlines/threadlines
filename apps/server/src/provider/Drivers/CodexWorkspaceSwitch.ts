/**
 * Moving a Codex sign-in to another of its ChatGPT workspaces (Settings ›
 * Codex › Account & Sign-in, "Workspace"), run as the `switch-workspace`
 * provider-auth flow so it gets the panel's progress, page opening, pasted
 * redirect and Stop.
 *
 * Codex does the switch itself (`accountSession/switch`, experimental since
 * 0.167). A workspace behind its company's single sign-on answers with a page
 * to open instead, and the switch finishes when that sign-in does. Every
 * Codex chat of the instance runs its own app-server holding the sign-in it
 * started with, so the switch first stops them all and keeps new ones from
 * starting until it is over (the launch gate): none can carry on in the old
 * workspace. One-shot `codex exec` runs (commit messages, titles) are left
 * alone: they read the saved sign-in as they start and last seconds, so one
 * in flight finishes in the old workspace, and holding them off would fail
 * them for as long as a sign-on takes.
 *
 * @module provider/Drivers/CodexWorkspaceSwitch
 */
import type { CodexSettings } from "@threadlines/contracts";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { ChildProcessSpawner } from "effect/process";

import {
  matchPrintedRedirect,
  PrintedRedirects,
  replayLoopbackRedirect,
} from "../auth/loopbackRedirect.ts";
import {
  initializeCodexAppServerClient,
  makeCodexAppServerClient,
} from "../Layers/CodexProvider.ts";
import { type LaunchGate, withLaunchGateClosed } from "../managedRuntime/LaunchGate.ts";
import type { ProviderInstanceAuthFlows } from "../ProviderDriver.ts";

/** How long a workspace's single sign-on may take in the browser. */
const SIGN_ON_TIMEOUT = Duration.minutes(10);
/** How long a stopped sign-on waits for Codex to cancel it before the process just goes. */
const SIGN_ON_CANCEL_TIMEOUT = Duration.seconds(5);

const failure = (message: string) => ({ message });

/** What the panel calls a workspace: its name, or "your personal workspace". */
function workspaceLabel(
  workspace: EffectCodexSchema.V2AccountSessionsResponse__AccountSessionWorkspace,
): string {
  const name = workspace.name?.trim();
  if (name) return name;
  return workspace.kind === "personal" ? "your personal workspace" : "that workspace";
}

/** Codex's refusals, in the panel's words; anything else as Codex said it. */
function friendlySwitchError(message: string): string {
  if (message.includes("requires a new sign-in")) {
    return "That workspace needs you to sign in again. Sign in to Codex, then switch.";
  }
  if (message.includes("current login")) {
    return "A Codex sign-in is still in progress. Finish or cancel it, then switch.";
  }
  if (message.includes("government workspaces")) {
    return "Government workspaces need their own sign-in. Sign in to Codex with that workspace.";
  }
  return message;
}

export function makeCodexWorkspaceSwitchFlows(input: {
  readonly settings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** Held by every Codex chat of the instance (see CodexAdapter). */
  readonly gate: LaunchGate;
  /** Stops every Codex chat of the instance; run on each poll of the drain. */
  readonly stopSessions: Effect.Effect<void>;
}): ProviderInstanceAuthFlows {
  // The sign-on a switch is waiting on, for a browser address pasted from
  // another device: its redirect, replayed to Codex's listener here.
  let pendingSignOn: PrintedRedirects | undefined;
  let report: ((line: string) => Effect.Effect<void>) | undefined;

  const switchWorkspace = (workspaceId: string, emit: (line: string) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      const client = yield* makeCodexAppServerClient({
        binaryPath: input.settings.binaryPath,
        homePath: input.settings.homePath,
        cwd: process.cwd(),
        environment: input.environment,
      });
      yield* initializeCodexAppServerClient(client);
      const sessions = yield* client.request("accountSession/list", {
        refreshWorkspaceMetadata: true,
      });
      const active = sessions.sessions.find(
        (session) => session.isActive || session.sessionId === sessions.activeSessionId,
      );
      if (!active) {
        return yield* Effect.fail(failure("Codex isn't signed in with ChatGPT."));
      }
      const target = active.workspaces.find((workspace) => workspace.accountId === workspaceId);
      if (!target) {
        return yield* Effect.fail(failure("This sign-in can't use that workspace any more."));
      }
      const label = workspaceLabel(target);
      if (active.selectedWorkspaceAccountId === workspaceId) {
        yield* emit(`Already in ${label}.`);
        return;
      }

      // Listened for before the switch is asked: a completion is only told
      // to the handlers there when it arrives.
      const completions =
        yield* Queue.unbounded<EffectCodexSchema.V2AccountLoginCompletedNotification>();
      yield* client.handleServerNotification("account/login/completed", (notification) =>
        Queue.offer(completions, notification).pipe(Effect.asVoid),
      );

      yield* emit(`Switching to ${label}…`);
      const response = yield* client
        .request("accountSession/switch", {
          sessionId: active.sessionId,
          accountId: workspaceId,
          allowBrowserLogin: true,
        })
        .pipe(Effect.mapError((error) => failure(friendlySwitchError(error.message))));

      if ("auth_url" in response) {
        const loginId = response.login_id;
        const printed = new PrintedRedirects();
        printed.push(`${response.auth_url}\n`);
        pendingSignOn = printed;
        // The page on its own line: clients open it from the output.
        yield* emit(response.auth_url);
        yield* emit(
          `Sign in to ${label} in your browser to finish. On another device, paste the address the page ends on.`,
        );
        const outcome = yield* Effect.gen(function* () {
          while (true) {
            const notification = yield* Queue.take(completions);
            // This process started no other sign-in; one Codex left unnamed is this one.
            if (!notification.loginId || notification.loginId === loginId) return notification;
          }
        }).pipe(
          Effect.timeoutOrElse({
            duration: SIGN_ON_TIMEOUT,
            orElse: () =>
              Effect.fail(failure("The sign-in took longer than 10 minutes. Try again.")),
          }),
          // Stopped from the panel: Codex keeps the current workspace. A Codex
          // that doesn't answer is ended with the scope all the same.
          Effect.onInterrupt(() =>
            client
              .request("account/login/cancel", { loginId })
              .pipe(Effect.timeoutOption(SIGN_ON_CANCEL_TIMEOUT), Effect.ignore),
          ),
        );
        if (!outcome.success) {
          return yield* Effect.fail(
            failure(friendlySwitchError(outcome.error?.trim() || "The sign-in didn't finish.")),
          );
        }
      }
      yield* emit(`Switched to ${label}.`);
    }).pipe(
      Effect.scoped,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
      Effect.ensuring(
        Effect.sync(() => {
          pendingSignOn = undefined;
        }),
      ),
      Effect.mapError((error) =>
        "message" in error && typeof error.message === "string"
          ? failure(error.message)
          : failure("Codex couldn't switch workspace."),
      ),
    );

  return {
    flows: ["switch-workspace"],
    describe: () => "Switch ChatGPT workspace",
    run: ({ flow, workspaceId, report: emit }) => {
      if (flow !== "switch-workspace" || !workspaceId) {
        return Effect.fail(failure("Pick a workspace to switch to."));
      }
      report = emit;
      return withLaunchGateClosed(
        input.gate,
        {
          whenAlreadyClosed: () => failure("Codex is already switching workspace."),
          whenStillHeld: () =>
            failure("Codex chats didn't stop in time, so nothing was switched. Try again."),
          stop: input.stopSessions,
          onWaiting: emit("Stopping Codex chats on this computer…"),
        },
        switchWorkspace(workspaceId, emit),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            report = undefined;
          }),
        ),
      );
    },
    completeRedirect: (raw) =>
      Effect.gen(function* () {
        const printed = pendingSignOn;
        if (!printed) {
          return yield* Effect.fail(failure("No workspace sign-in is waiting for an address."));
        }
        const matched = matchPrintedRedirect(raw, printed.all);
        if (typeof matched === "string") return yield* Effect.fail(failure(matched));
        const status = yield* Effect.tryPromise({
          try: () => replayLoopbackRedirect(matched.url),
          catch: () => failure("Codex didn't take that address. Try the sign-in again."),
        });
        if (status >= 400) {
          return yield* Effect.fail(
            failure("Codex didn't take that address. Try the sign-in again."),
          );
        }
        if (report) yield* report("Got the address; finishing the switch…");
      }),
  };
}
