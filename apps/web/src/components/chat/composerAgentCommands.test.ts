import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ThreadParticipantId,
  type ServerProvider,
  type ServerProviderSkill,
} from "@threadlines/contracts";
import { participantSessionKey } from "@threadlines/shared/threadParticipants";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  composerProviderSlashList,
  composerSlashAgent,
  sessionSlashCommands,
} from "./composerAgentCommands";

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
        sessionCommands: [{ name: "other" }],
        threadlinesCommands: THREADLINES,
      }),
    ).toEqual({ commands: provider.slashCommands, slashSkills: [] });
  });

  it("lists the status's skills, then the session's commands with the session's entry first", () => {
    const provider = {
      slashCommands: [],
      skills: [
        skill("review"),
        skill("compact"),
        skill("off", false),
        skill("two words"),
        skill("a/b"),
      ],
      slashSkills: true,
    };
    // Before a session has listed its own: the skills alone, only typeable ones.
    expect(
      composerProviderSlashList({
        provider,
        sessionCommands: undefined,
        threadlinesCommands: THREADLINES,
      }),
    ).toEqual({ commands: [], slashSkills: [skill("review"), skill("compact")] });

    expect(
      composerProviderSlashList({
        provider,
        sessionCommands: [
          { name: "goal", input: { hint: "objective" } },
          { name: "compact", description: "Summarize the conversation" },
          { name: "model" },
        ],
        threadlinesCommands: THREADLINES,
      }),
    ).toEqual({
      commands: [
        { name: "goal", input: { hint: "objective" } },
        { name: "compact", description: "Summarize the conversation" },
      ],
      slashSkills: [skill("review")],
    });
  });

  it("finds the list of the session the next message goes to, a room agent's included", () => {
    const thread = ThreadId.make("thread-1");
    const agent = ThreadParticipantId.make("7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d");
    const provider = {
      sessionCommands: [
        { sessions: [thread], commands: [{ name: "goal" }] },
        { sessions: [participantSessionKey(thread, agent)], commands: [{ name: "compact" }] },
      ],
    };
    expect(sessionSlashCommands(provider, participantSessionKey(thread, null))).toEqual([
      { name: "goal" },
    ]);
    expect(sessionSlashCommands(provider, participantSessionKey(thread, agent))).toEqual([
      { name: "compact" },
    ]);
    expect(sessionSlashCommands(provider, "thread-2")).toBeUndefined();
  });

  it("describes the agent the next message goes to: a room agent's own provider and session", () => {
    const thread = ThreadId.make("thread-1");
    const agent = ThreadParticipantId.make("7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d");
    const antigravity = {
      instanceId: ProviderInstanceId.make("antigravity"),
      driverKind: ProviderDriverKind.make("antigravity"),
      displayName: "Antigravity",
      snapshot: { slashSkills: true },
    } as unknown as ProviderInstanceEntry;
    const claude = {
      status: { slashCommands: [{ name: "compact" }] } as unknown as ServerProvider,
      driverKind: ProviderDriverKind.make("claudeAgent"),
      label: "Claude",
    };
    // Claude's thread, Antigravity added and addressed: Antigravity's list.
    expect(
      composerSlashAgent({
        threadId: thread,
        recipient: { id: agent, instanceId: antigravity.instanceId },
        entries: [antigravity],
        selected: claude,
      }),
    ).toEqual({
      status: antigravity.snapshot,
      driverKind: antigravity.driverKind,
      label: "Antigravity",
      sessionKey: participantSessionKey(thread, agent),
      addedAgent: true,
    });
    // The thread's own agent addressed: its own provider and session.
    expect(
      composerSlashAgent({
        threadId: thread,
        recipient: null,
        entries: [antigravity],
        selected: claude,
      }),
    ).toEqual({ ...claude, sessionKey: thread, addedAgent: false });
  });
});
