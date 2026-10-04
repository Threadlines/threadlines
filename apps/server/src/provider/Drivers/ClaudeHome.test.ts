import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import {
  mergeProviderInstanceEnvironment,
  refreshProviderInstanceEnvironment,
} from "../ProviderInstanceEnvironment.ts";

import {
  claudeInstanceBaseEnvironment,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses refreshed PATH when a retained environment is passed to a new process", () =>
      Effect.gen(function* () {
        const baseEnv = { PATH: "/old/bin" };
        const environment = yield* makeClaudeEnvironment(
          { homePath: "", accountFolder: "" },
          baseEnv,
        );
        baseEnv.PATH = "/new/bin";
        expect({ ...environment }.PATH).toBe("/new/bin");
      }),
    );
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        const environment = yield* makeClaudeEnvironment(
          { homePath: "", accountFolder: "" },
          { PATH: "/bin" },
        );
        expect(environment.PATH).toBe("/bin");
        expect(environment.HOME).toBeUndefined();
      }),
    );

    it.effect("disables the CLI's interrupted-turn auto-resume unless explicitly configured", () =>
      Effect.gen(function* () {
        const defaulted = yield* makeClaudeEnvironment({ homePath: "", accountFolder: "" }, {});
        expect(defaulted.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBe("0");

        const overridden = yield* makeClaudeEnvironment(
          { homePath: "", accountFolder: "" },
          { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1" },
        );
        expect(overridden.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBe("1");
      }),
    );

    it.effect("forwards configured subagent limits and drops blank or invalid values", () =>
      Effect.gen(function* () {
        const configured = yield* makeClaudeEnvironment(
          {
            homePath: "",
            accountFolder: "",
            maxConcurrentSubagents: "8",
            maxSubagentsPerSession: "50",
            maxSubagentSpawnDepth: "1",
          },
          { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "20" },
        );
        expect(configured.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe("8");
        expect(configured.CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION).toBe("50");
        expect(configured.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe("1");

        const invalid = yield* makeClaudeEnvironment(
          {
            homePath: "",
            accountFolder: "",
            maxConcurrentSubagents: "",
            maxSubagentsPerSession: "0",
            maxSubagentSpawnDepth: "two",
          },
          {},
        );
        expect(invalid.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBeUndefined();
        expect(invalid.CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION).toBeUndefined();
        expect(invalid.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBeUndefined();
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath, accountFolder: "" })).HOME).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath, accountFolder: "" }, {})).toBe(
          `claude:home:${resolved}`,
        );
        expect(
          yield* makeClaudeCapabilitiesCacheKey(
            { binaryPath: "claude", homePath, accountFolder: "" },
            {},
          ),
        ).toBe(`claude\0${resolved}\0${path.join(resolved, ".claude")}`);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "", accountFolder: "" }, {})).toBe(
          `claude:home:${resolved}`,
        );
      }),
    );
  });

  describe("account folders", () => {
    it.effect("moves only Claude's folder: HOME stays, secure-storage override is dropped", () =>
      Effect.gen(function* () {
        const environment = yield* makeClaudeEnvironment(
          { homePath: "", accountFolder: "/tmp/accounts/work" },
          {
            HOME: "/Users/me",
            CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
            CLAUDE_CONFIG_DIR: "/elsewhere",
          },
        );
        expect(environment.CLAUDE_CONFIG_DIR).toBe("/tmp/accounts/work");
        expect(environment.HOME).toBe("/Users/me");
        expect("CLAUDE_SECURESTORAGE_CONFIG_DIR" in environment).toBe(false);
      }),
    );

    it.effect("never inherits server credentials into an account", () =>
      Effect.sync(() => {
        const base = {
          ANTHROPIC_API_KEY: "server",
          CLAUDE_CODE_OAUTH_TOKEN: "server",
          PATH: "/bin",
        };
        expect(claudeInstanceBaseEnvironment({ accountFolder: "/tmp/a" }, base)).toEqual({
          PATH: "/bin",
        });
        expect(claudeInstanceBaseEnvironment({ accountFolder: "" }, base)).toBe(base);
      }),
    );

    it.effect("keeps server credentials out of an account across environment refreshes", () =>
      Effect.sync(() => {
        vi.stubEnv("ANTHROPIC_API_KEY", "server-key");
        vi.stubEnv("PATH", "/new/bin");
        try {
          const config = { accountFolder: "/tmp/accounts/work" };
          const processEnv = mergeProviderInstanceEnvironment(
            [],
            claudeInstanceBaseEnvironment(config),
          );
          refreshProviderInstanceEnvironment(
            undefined,
            processEnv,
            claudeInstanceBaseEnvironment(config),
          );
          expect(processEnv.PATH).toBe("/new/bin");
          expect("ANTHROPIC_API_KEY" in processEnv).toBe(false);
        } finally {
          vi.unstubAllEnvs();
        }
      }),
    );

    it.effect("shares the main folder's resume group only while history is linked", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const home = path.resolve(NodeOS.homedir());
        const config = { homePath: "", accountFolder: "/tmp/accounts/work" };
        expect(yield* makeClaudeContinuationGroupKey(config, {}, { sharesMainHistory: true })).toBe(
          `claude:home:${home}`,
        );
        expect(
          yield* makeClaudeContinuationGroupKey(config, {}, { sharesMainHistory: false }),
        ).toBe("claude:config:/tmp/accounts/work");
        expect(
          yield* makeClaudeContinuationGroupKey(
            { homePath: "", accountFolder: "" },
            { CLAUDE_CONFIG_DIR: "/tmp/other-claude" },
          ),
        ).toBe("claude:config:/tmp/other-claude");
      }),
    );
  });
});
