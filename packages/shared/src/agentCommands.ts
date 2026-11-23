import type {
  OrchestrationAgentCommands,
  ProviderInstanceId,
  ServerProviderSlashCommand,
  ThreadParticipantId,
} from "@threadlines/contracts";

import { roomAgentKey } from "./threadParticipants.ts";

type AgentCommandsByAgent = Readonly<Record<string, OrchestrationAgentCommands>>;

/**
 * A thread's agent commands after one agent's session listed its commands:
 * that agent's entry is replaced, every other agent's kept. Every reader of
 * `thread.agent-commands-set` (server read models, clients) applies it.
 */
export function applyAgentCommands(
  current: AgentCommandsByAgent | undefined,
  update: {
    readonly participantId: ThreadParticipantId | null;
    readonly providerInstanceId: ProviderInstanceId;
    readonly commands: ReadonlyArray<ServerProviderSlashCommand>;
    readonly updatedAt: string;
  },
): AgentCommandsByAgent {
  return {
    ...current,
    [roomAgentKey(update.participantId)]: {
      providerInstanceId: update.providerInstanceId,
      commands: update.commands,
      updatedAt: update.updatedAt,
    },
  };
}

/** Whether two command lists say the same thing, in the same order (a
 *  session lists its commands each time it opens; only a change is recorded). */
export function sameSlashCommands(
  left: ReadonlyArray<ServerProviderSlashCommand>,
  right: ReadonlyArray<ServerProviderSlashCommand>,
): boolean {
  return (
    left.length === right.length &&
    left.every((command, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        command.name === other.name &&
        command.description === other.description &&
        command.input?.hint === other.input?.hint
      );
    })
  );
}
