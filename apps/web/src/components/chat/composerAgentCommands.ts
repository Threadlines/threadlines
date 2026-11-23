import type {
  ProviderDriverKind,
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ThreadId,
  ThreadParticipantId,
} from "@threadlines/contracts";
import { isSlashCommandName } from "@threadlines/shared/slashCommands";
import { participantSessionKey } from "@threadlines/shared/threadParticipants";

import type { ProviderInstanceEntry } from "../../providerInstances";

export interface ComposerProviderSlashList {
  /** The provider section of the `/` list. */
  readonly commands: ReadonlyArray<ServerProviderSlashCommand>;
  /** Skills the agent runs on `/<name>`, for the Skills section; none it lists as a command. */
  readonly slashSkills: ReadonlyArray<ServerProviderSkill>;
}

const NO_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

export interface ComposerSlashAgent {
  /** Its provider's status, whose commands and skills the list offers. */
  readonly status: ServerProvider | null;
  readonly driverKind: ProviderDriverKind;
  /** Heading of the provider section. */
  readonly label: string;
  /** Its session's key, for the list that session reported. */
  readonly sessionKey: string | null;
  /** An added room agent rather than the thread's own. */
  readonly addedAgent: boolean;
}

/**
 * The agent the `/` list describes: the one the next message goes to. In a
 * room that is an added agent's own provider instance; otherwise the
 * composer's selected provider.
 */
export function composerSlashAgent(input: {
  readonly threadId: ThreadId | null;
  /** The added room agent the message is addressed to, or null. */
  readonly recipient: {
    readonly id: ThreadParticipantId;
    readonly instanceId: ProviderInstanceEntry["instanceId"];
  } | null;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly selected: {
    readonly status: ServerProvider | null;
    readonly driverKind: ProviderDriverKind;
    readonly label: string;
  };
}): ComposerSlashAgent {
  const recipient = input.recipient;
  const entry =
    recipient === null
      ? undefined
      : input.entries.find((candidate) => candidate.instanceId === recipient.instanceId);
  const keyOf = (participantId: ThreadParticipantId | null) =>
    input.threadId === null ? null : participantSessionKey(input.threadId, participantId);
  return entry !== undefined && recipient !== null
    ? {
        status: entry.snapshot,
        driverKind: entry.driverKind,
        label: entry.displayName,
        sessionKey: keyOf(recipient.id),
        addedAgent: true,
      }
    : { ...input.selected, sessionKey: keyOf(null), addedAgent: false };
}

/** The list a running session put on its provider's status, by session key. */
export function sessionSlashCommands(
  provider: Pick<ServerProvider, "sessionCommands"> | null,
  sessionKey: string | null,
): ReadonlyArray<ServerProviderSlashCommand> | undefined {
  if (sessionKey === null) return undefined;
  return provider?.sessionCommands?.find((entry) => entry.sessions.includes(sessionKey))?.commands;
}

/**
 * What the composer's `/` list offers from the agent the next message goes
 * to. A provider whose agent runs skills on `/<name>`
 * (`ServerProvider.slashSkills`, Antigravity) lists the commands that agent's
 * running session put on the status, else the status's own, and the status's
 * skills less any the commands already name, so the session's entry wins.
 * Commands Threadlines answers itself (`/model`, `/plan`…) stay Threadlines'.
 * Every other provider keeps its status's commands, as before.
 */
export function composerProviderSlashList(input: {
  readonly provider: Pick<ServerProvider, "slashCommands" | "skills" | "slashSkills"> | null;
  /** The list the agent's running session reported, if any (`sessionSlashCommands`). */
  readonly sessionCommands: ReadonlyArray<ServerProviderSlashCommand> | undefined;
  readonly threadlinesCommands: ReadonlySet<string>;
}): ComposerProviderSlashList {
  const provider = input.provider;
  if (provider?.slashSkills !== true) {
    return { commands: provider?.slashCommands ?? [], slashSkills: NO_SKILLS };
  }
  const commands = (input.sessionCommands ?? provider.slashCommands).filter(
    (command) => !input.threadlinesCommands.has(command.name),
  );
  const named = new Set(commands.map((command) => command.name));
  const slashSkills = provider.skills.filter(
    (skill) =>
      skill.enabled &&
      !named.has(skill.name) &&
      !input.threadlinesCommands.has(skill.name) &&
      isSlashCommandName(skill.name),
  );
  return { commands, slashSkills };
}
