import { ProviderInstanceId, type ServerProviderSkill } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { composerProviderSlashList } from "./composerAgentCommands";

const instanceId = ProviderInstanceId.make("antigravity");
const skill = (name: string, enabled = true): ServerProviderSkill => ({
  name,
  path: `/skills/${name}/SKILL.md`,
  enabled,
});
const THREADLINES = new Set(["model", "plan", "theme", "default"]);

describe("composerProviderSlashList", () => {
  it("keeps a provider's own status commands when it doesn't run skills on /", () => {
    const provider = {
      slashCommands: [{ name: "compact" }, { name: "model" }],
      skills: [skill("review")],
    };
    expect(
      composerProviderSlashList({
        provider,
        instanceId,
        sessionCommands: {
          providerInstanceId: instanceId,
          commands: [{ name: "other" }],
          updatedAt: "2026-11-23T00:00:00.000Z",
        },
        threadlinesCommands: THREADLINES,
      }),
    ).toEqual({ commands: provider.slashCommands, slashSkills: [] });
  });

  it("lists the status's skills, then the session's commands with the session's entry first", () => {
    const provider = {
      slashCommands: [],
      skills: [skill("review"), skill("compact"), skill("off", false), skill("two words")],
      slashSkills: true,
    };
    // Before a session has opened: the skills alone.
    expect(
      composerProviderSlashList({
        provider,
        instanceId,
        sessionCommands: undefined,
        threadlinesCommands: THREADLINES,
      }),
    ).toEqual({ commands: [], slashSkills: [skill("review"), skill("compact")] });

    const session = {
      providerInstanceId: instanceId,
      commands: [
        { name: "goal", input: { hint: "objective" } },
        { name: "compact", description: "Summarize the conversation" },
        { name: "model" },
      ],
      updatedAt: "2026-11-23T00:00:00.000Z",
    };
    expect(
      composerProviderSlashList({
        provider,
        instanceId,
        sessionCommands: session,
        threadlinesCommands: THREADLINES,
      }),
    ).toEqual({
      commands: [
        { name: "goal", input: { hint: "objective" } },
        { name: "compact", description: "Summarize the conversation" },
      ],
      slashSkills: [skill("review")],
    });

    // A list another account's session sent doesn't describe this one.
    expect(
      composerProviderSlashList({
        provider,
        instanceId: ProviderInstanceId.make("antigravity_work"),
        sessionCommands: session,
        threadlinesCommands: THREADLINES,
      }).commands,
    ).toEqual([]);
  });
});
