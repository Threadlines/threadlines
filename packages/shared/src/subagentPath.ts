export function isRootAgentPath(agentPath: string | null | undefined): boolean {
  if (!agentPath) {
    return false;
  }

  const segments = agentPath
    .split(/[\\/]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return segments.length === 1 && segments[0]?.toLowerCase() === "root";
}
