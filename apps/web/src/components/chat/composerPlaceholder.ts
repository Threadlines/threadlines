export function buildDefaultComposerPlaceholder(input: {
  canReferenceFiles: boolean;
  canInvokeSkills: boolean;
  /** In a room, "@" also picks the agent a message goes to. */
  canMentionAgents?: boolean;
  /**
   * In a room, the agent the message goes to. The hint names it, since the
   * model button has little room for its name on a phone.
   */
  recipientName?: string | undefined;
}): string {
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
  const lead = input.recipientName ? `Message ${input.recipientName}` : "Ask anything";
  return `${lead} · ${capabilities.join(", ")}`;
}
