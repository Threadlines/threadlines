/**
 * Pi's sign-in, asked through Threadlines, in a real Pi with its own folder.
 * Runs when a Pi `cli.js` is available (THREADLINES_PI_CLI, or the server's
 * pinned dev dependency). Nothing here reaches the network: the key sign-in
 * only stores the key, and the ChatGPT sign-in fails on a made-up address
 * (it listens on 127.0.0.1:1455 meanwhile, as Pi's own /login does).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import type { ProviderAuthQuestion } from "../ProviderDriver.ts";
import { runPiSignIn } from "./PiSignIn.ts";
import { PI_SIGN_IN_GROUPS } from "./PiSignInExtensionSource.ts";
import { makeTestPiHome, resolveTestPiCli, testPiEnvironment } from "./testing/PiTestServers.ts";

const piCli = resolveTestPiCli();

const signIn = (agentDir: string, answer: (question: ProviderAuthQuestion) => string | null) =>
  Effect.gen(function* () {
    const asked: Array<ProviderAuthQuestion> = [];
    const reported: Array<string> = [];
    const exit = yield* runPiSignIn({
      launch: Effect.succeed({ command: process.execPath, prefixArgs: [piCli!] }),
      launchArgs: [],
      instanceEnvironment: undefined,
      cwd: tmpdir(),
      extensionDir: mkdtempSync(join(tmpdir(), "threadlines-pi-sign-in-")),
      baseEnvironment: testPiEnvironment(agentDir),
      report: (line) => Effect.sync(() => void reported.push(line)),
      ask: (question) =>
        Effect.sync(() => {
          asked.push(question);
          return answer(question);
        }),
      showCode: () => Effect.void,
    }).pipe(Effect.exit);
    return { exit, asked, reported };
  }).pipe(Effect.provide(NodeServices.layer));

describe.skipIf(!piCli)("Pi sign-in in a real Pi", () => {
  it.live(
    "lists Pi's providers, saves a typed key exactly as typed, and shows it as connected",
    () =>
      Effect.gen(function* () {
        const { agentDir } = makeTestPiHome("http://127.0.0.1:9");
        // Pi would run a stored key starting with "!" as a command.
        const typedKey = "!touch /tmp/never-$HOME";
        const first = yield* signIn(agentDir, (question) =>
          question.kind === "choice" ? "api_key:groq" : typedKey,
        );
        expect(first.exit._tag).toBe("Success");
        const [choice, key] = first.asked;
        expect(choice?.kind).toBe("choice");
        expect(choice?.options).toContainEqual({
          id: "oauth:openai",
          label: "OpenAI (ChatGPT subscription)",
          group: PI_SIGN_IN_GROUPS.account,
        });
        expect(choice?.options).toContainEqual({
          id: "api_key:groq",
          label: "Groq",
          group: PI_SIGN_IN_GROUPS.apiKey,
        });
        // Accounts first, then keys.
        const groups = (choice?.options ?? []).map((option) => option.group);
        expect(groups.lastIndexOf(PI_SIGN_IN_GROUPS.account)).toBeLessThan(
          groups.indexOf(PI_SIGN_IN_GROUPS.apiKey),
        );
        expect(key).toMatchObject({ kind: "secret", message: "Enter Groq API key" });
        // Stored in Pi's escaped form, which Pi reads back as the literal key.
        expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")).groq).toEqual({
          type: "api_key",
          key: "$!touch /tmp/never-$$HOME",
        });

        // The next sign-in shows it connected; cancelling the choice ends it.
        const second = yield* signIn(agentDir, () => null);
        expect(second.asked[0]?.options).toContainEqual({
          id: "api_key:groq",
          label: "Groq",
          group: PI_SIGN_IN_GROUPS.apiKey,
          configured: true,
        });
        expect(second.exit).toMatchObject({
          _tag: "Failure",
          cause: { reasons: [{ error: { message: "Sign-in cancelled." } }] },
        });
      }),
    60_000,
  );

  it.live(
    "relays a provider's own questions and sign-in page, and reports why it failed",
    () =>
      Effect.gen(function* () {
        const { agentDir } = makeTestPiHome("http://127.0.0.1:9");
        const { exit, asked, reported } = yield* signIn(agentDir, (question) =>
          question.kind === "choice" ? "oauth:openai" : "not an address",
        );
        // Every account sign-in Pi's own /login offers, Claude Pro/Max included.
        expect(asked[0]?.options).toContainEqual({
          id: "oauth:anthropic",
          label: "Anthropic (Claude Pro/Max)",
          group: PI_SIGN_IN_GROUPS.account,
        });
        // The browser page, and Pi's own question for the address it ends on.
        expect(reported.some((line) => line.startsWith("Sign-in page: https://"))).toBe(true);
        expect(asked[1]).toMatchObject({
          kind: "text",
          message: "Complete login in your browser, or paste the final redirect URL here:",
        });
        expect(exit).toMatchObject({
          _tag: "Failure",
          cause: {
            reasons: [{ error: { message: "Paste the full callback URL from the browser" } }],
          },
        });
        // ChatGPT's sign-in names this installation, as Pi's own /login does.
        expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).deviceId).toMatch(
          /^[0-9a-f-]{36}$/u,
        );
      }),
    60_000,
  );
});
