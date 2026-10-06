import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AcpRegistrySettings } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeAcpRegistryDescriptor } from "../acp/AcpRegistrySupport.ts";
import { makeAcpRegistryTestAgent } from "../testUtils/acpRegistryAgentFixture.ts";
import { makeAcpRegistryAuthFlows } from "./AcpRegistryAuth.ts";

const settings = Schema.decodeSync(AcpRegistrySettings)({});
const SIGN_IN_PAGE = "https://accounts.mock.test/device?code=ABCD";

/** Real processes and files; nothing here has a reason to reach the network. */
const services = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("A community agent's sign-in doesn't use the network here")),
  ),
);

/**
 * An installed agent that needs a sign-in, with the flows its instance would
 * have and the status check its row would run. `answerPage` is what the
 * user does when the agent asks for a page to be opened.
 */
const makeSignedOutAgent = (mockEnv: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const agent = yield* makeAcpRegistryTestAgent({
      T3_ACP_AUTH_REQUIRED: "until-authenticated",
      ...mockEnv,
    });
    yield* agent.install;
    const descriptor = makeAcpRegistryDescriptor(agent.descriptorInput);
    const stoppedSessions = { count: 0 };
    const flows = makeAcpRegistryAuthFlows({
      displayName: "Test Agent",
      agentRoot: agent.descriptorInput.agentRoot,
      installer: agent.installer,
      state: agent.state,
      settings,
      environment: process.env,
      instanceVariableNames: new Set(),
      allowsEnvName: () => true,
      childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      signInDescriptor: (purpose) =>
        makeAcpRegistryDescriptor({ ...agent.descriptorInput, purpose }),
      stopSessions: Effect.sync(() => {
        stoppedSessions.count += 1;
      }),
    });
    const lines: Array<string> = [];
    const pages: Array<{
      readonly url: string;
      readonly message: string | null;
      /** Whether the agent was closed to other work while it asked. */
      readonly closed: boolean;
    }> = [];
    const run = (flow: "login" | "logout", answerPage: boolean) =>
      flows.run({
        flow,
        report: (line) =>
          Effect.sync(() => {
            lines.push(line);
          }),
        requestPage: (request) =>
          Effect.sync(() => {
            pages.push({ ...request, closed: agent.state.gate.busy });
            return answerPage;
          }),
      });
    return {
      ...agent,
      flows,
      run,
      lines,
      pages,
      stoppedSessions,
      probe: descriptor.probe(settings, process.env),
      community: () => descriptor.snapshotExtras?.().community,
    };
  });

describe.skipIf(process.platform === "win32")("makeAcpRegistryAuthFlows", () => {
  it.live("signs in with the agent's own method, opening its page only when the user says so", () =>
    Effect.gen(function* () {
      const agent = yield* makeSignedOutAgent({ T3_ACP_AUTH_PAGE_URL: SIGN_IN_PAGE });
      assert.deepStrictEqual((yield* agent.probe).auth, { status: "unauthenticated" });
      assert.deepStrictEqual(agent.flows.flows, ["login", "logout"]);
      assert.equal(agent.flows.describe("login"), "Sign in to Test Agent");

      // The user says no: the sign-in fails, and nothing about the agent changes.
      const declined = yield* Effect.flip(agent.run("login", false));
      assert.isString(declined.message);
      assert.deepStrictEqual(agent.pages, [
        { url: SIGN_IN_PAGE, message: "Open this page to sign in to Mock.", closed: true },
      ]);
      assert.isNull(agent.state.offers?.verifiedAuthMethodId ?? null);
      assert.isFalse(agent.state.gate.busy);
      assert.deepStrictEqual((yield* agent.probe).auth, { status: "unauthenticated" });

      yield* agent.run("login", true);
      assert.lengthOf(agent.pages, 2);
      assert.include(agent.lines, "Test Agent asked to open a sign-in page.");
      assert.equal(agent.lines.at(-1), "Signed in.");
      // Its sessions were stopped first, and it can start again afterwards.
      assert.isAbove(agent.stoppedSessions.count, 0);
      assert.isFalse(agent.state.gate.busy);

      // The method that worked is remembered, and the next look finds the agent ready
      // without asking for a page: only the sign-in panel offers to open one.
      assert.equal(agent.state.offers?.verifiedAuthMethodId, "mock-login");
      const ready = yield* agent.probe;
      assert.deepInclude(ready, { status: "ready" });
      assert.lengthOf(agent.pages, 2);
      assert.isTrue(agent.community()?.signIn.canSignOut);

      yield* agent.run("logout", true);
      assert.equal(agent.lines.at(-1), "Signed out.");
      assert.isNull(agent.state.offers?.verifiedAuthMethodId ?? null);
      assert.deepStrictEqual((yield* agent.probe).auth, { status: "unauthenticated" });
    }).pipe(Effect.provide(services)),
  );

  it.live("refuses to sign in while another sign-in has the agent closed", () =>
    Effect.gen(function* () {
      const agent = yield* makeSignedOutAgent({});
      yield* agent.probe;
      const before = yield* agent.starts;

      agent.state.gate.busy = true;
      assert.deepStrictEqual(yield* Effect.flip(agent.run("login", true)), {
        message: "Test Agent is already signing in or out.",
      });
      // The agent wasn't started for it.
      assert.equal(yield* agent.starts, before);
      agent.state.gate.busy = false;

      yield* agent.run("login", true);
      assert.lengthOf(agent.pages, 0);
      assert.deepInclude(yield* agent.probe, { status: "ready" });
    }).pipe(Effect.provide(services)),
  );
});
