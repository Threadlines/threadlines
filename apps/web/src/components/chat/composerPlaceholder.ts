interface ComposerCapabilityInput {
  canReferenceFiles: boolean;
  canInvokeSkills: boolean;
  /** In a room, "@" also picks the agent a message goes to. */
  canMentionAgents?: boolean;
}

/**
 * What "@", "$" and "/" do in the composer, as the hint words it. An agent's
 * suggestion shows it on its own under the suggestion.
 */
export function buildComposerCapabilityHint(input: ComposerCapabilityInput): string {
  const capabilities: string[] = [];
  if (input.canMentionAgents && input.canReferenceFiles) {
    capabilities.push("@ agents or files");
  } else if (input.canMentionAgents) {
    capabilities.push("@ agents");
  } else if (input.canReferenceFiles) {
    capabilities.push("@ reference files");
  }
  if (input.canInvokeSkills) {
    capabilities.push("$ invoke skills");
  }
  capabilities.push("/ commands");
  return capabilities.join(", ");
}

export function buildDefaultComposerPlaceholder(
  input: ComposerCapabilityInput & {
    /**
     * In a room, the agent the message goes to. The hint names it, since the
     * model button has little room for its name on a phone.
     */
    recipientName?: string | undefined;
  },
): string {
  const lead = input.recipientName ? `Message ${input.recipientName}` : "Ask anything";
  return `${lead} · ${buildComposerCapabilityHint(input)}`;
}
