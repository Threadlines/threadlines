export function buildDefaultComposerPlaceholder(input: {
  canReferenceFiles: boolean;
  canInvokeSkills: boolean;
  /** In a room, "@" also picks the agent a message goes to. */
  canMentionAgents?: boolean;
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
  return `Ask anything · ${capabilities.join(", ")}`;
}
