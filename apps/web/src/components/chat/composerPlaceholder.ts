export function buildDefaultComposerPlaceholder(input: {
  canReferenceFiles: boolean;
  canInvokeSkills: boolean;
}): string {
  const capabilities: string[] = [];
  if (input.canReferenceFiles) {
    capabilities.push("@ reference files");
  }
  if (input.canInvokeSkills) {
    capabilities.push("$ invoke skills");
  }
  capabilities.push("/ commands");
  return `Ask anything — ${capabilities.join(", ")}`;
}
