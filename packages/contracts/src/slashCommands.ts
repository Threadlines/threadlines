import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A command an agent runs when a message starts with `/<name>`: a provider's
 * own commands on its status (`ServerProvider.slashCommands`), and the list
 * a running session reported for its thread (`OrchestrationThread.agentCommands`).
 * Re-exported from `server.ts`; its own module so orchestration contracts can
 * use it without importing the server contracts.
 */
export const ServerProviderSlashCommandInput = Schema.Struct({
  hint: TrimmedNonEmptyString,
});
export type ServerProviderSlashCommandInput = typeof ServerProviderSlashCommandInput.Type;

export const ServerProviderSlashCommand = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  input: Schema.optional(ServerProviderSlashCommandInput),
});
export type ServerProviderSlashCommand = typeof ServerProviderSlashCommand.Type;
