import {
  EnvironmentId,
  type ModelSelection,
  ProviderInstanceId,
  type ThreadMovePreview,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { checkMoveTarget } from "./ThreadMoves.ts";

const MAC_MINI = EnvironmentId.make("environment-mac-mini");
const claude: ModelSelection = {
  instanceId: ProviderInstanceId.make("mac-claude"),
  model: "opus-5-5",
};
const codex: ModelSelection = {
  instanceId: ProviderInstanceId.make("mac-codex"),
  model: "gpt-6-astra",
};
const agents = [
  {
    instanceId: "mac-claude",
    name: "Claude",
    billing: "Claude Max",
    models: [{ model: "opus-5-5", name: "Opus 5.5" }],
    driver: "claudeAgent",
  },
  {
    instanceId: "mac-codex",
    name: "Codex",
    billing: "ChatGPT Pro",
    models: [{ model: "gpt-6-astra", name: "GPT-6 Astra" }],
    driver: "codex",
  },
] as ThreadMovePreview["targets"][number]["agents"];

const shown = (target: Partial<ThreadMovePreview["targets"][number]>): ThreadMovePreview => ({
  targets: [{ environmentId: MAC_MINI, label: "Mac mini", agents, ...target }],
});

describe("checkMoveTarget", () => {
  it("takes the target's suggestion when the move names no agent, and a named one as named", () => {
    expect(checkMoveTarget(shown({ suggestedAgent: claude }), MAC_MINI, undefined)).toMatchObject({
      agent: claude,
    });
    expect(checkMoveTarget(shown({ suggestedAgent: claude }), MAC_MINI, codex)).toMatchObject({
      agent: codex,
    });
  });

  it("can't go when the target suggests none and none is named", () => {
    expect(checkMoveTarget(shown({}), MAC_MINI, undefined)).toEqual({
      refusal: "Mac mini has no agent ready.",
    });
  });

  it("waits on an unreachable target, whatever the agent", () => {
    expect(
      checkMoveTarget(
        shown({
          refusal: "Mac mini can't be reached right now.",
          unreachable: true,
          agents: [],
        }),
        MAC_MINI,
        undefined,
      ),
    ).toHaveProperty("unreachable");
  });
});
