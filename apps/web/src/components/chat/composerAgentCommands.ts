import type {
  OrchestrationAgentCommands,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@threadlines/contracts";

export interface ComposerProviderSlashList {
  /** The provider section of the `/` list. */
  readonly commands: ReadonlyArray<ServerProviderSlashCommand>;
  /** Skills the agent runs on `/<name>`, for the Skills section; none it lists as a command. */
  readonly slashSkills: ReadonlyArray<ServerProviderSkill>;
}

const NO_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

/**
 * What the composer's `/` list offers from the agent. A provider whose agent
 * runs skills on `/<name>` (`ServerProvider.slashSkills`, Antigravity) lists
 * the commands its session reported for this thread, once there is such a
 * list from this provider instance, else the status's; and the status's
 * skills, less any the commands already name, so the session's entry wins.
 * Commands Threadlines answers itself (`/model`, `/plan`…) stay Threadlines'.
 * Every other provider keeps its status's commands, as before.
 */
export function composerProviderSlashList(input: {
  readonly provider: Pick<ServerProvider, "slashCommands" | "skills" | "slashSkills"> | null;
  readonly instanceId: ProviderInstanceId;
  /** The list the agent's session last reported for this thread, if any. */
  readonly sessionCommands: OrchestrationAgentCommands | undefined;
  readonly threadlinesCommands: ReadonlySet<string>;
}): ComposerProviderSlashList {
  const provider = input.provider;
  if (provider?.slashSkills !== true) {
    return { commands: provider?.slashCommands ?? [], slashSkills: NO_SKILLS };
  }
  const sessionCommands =
    input.sessionCommands?.providerInstanceId === input.instanceId
      ? input.sessionCommands.commands
      : undefined;
  const commands = (sessionCommands ?? provider.slashCommands).filter(
    (command) => !input.threadlinesCommands.has(command.name),
  );
  const named = new Set(commands.map((command) => command.name));
  const slashSkills = provider.skills.filter(
    (skill) =>
      skill.enabled &&
      !named.has(skill.name) &&
      !input.threadlinesCommands.has(skill.name) &&
      !/\s/u.test(skill.name),
  );
  return { commands, slashSkills };
}
