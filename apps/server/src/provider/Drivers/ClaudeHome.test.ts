import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        const environment = yield* makeClaudeEnvironment({ homePath: "" }, { PATH: "/bin" });
        expect(environment.PATH).toBe("/bin");
        expect(environment.HOME).toBeUndefined();
      }),
    );

    it.effect("disables the CLI's interrupted-turn auto-resume unless explicitly configured", () =>
      Effect.gen(function* () {
        const defaulted = yield* makeClaudeEnvironment({ homePath: "" }, {});
        expect(defaulted.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBe("0");

        const overridden = yield* makeClaudeEnvironment(
          { homePath: "" },
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
        expect((yield* makeClaudeEnvironment({ homePath })).HOME).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}`,
        );
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
          `claude:home:${resolved}`,
        );
      }),
    );
  });
});
