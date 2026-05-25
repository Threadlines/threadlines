import type { VcsStatusResult } from "@t3tools/contracts";

export function buildGeneratedCommitMessage(
  files: ReadonlyArray<VcsStatusResult["workingTree"]["files"][number]>,
): string {
  if (files.length === 0) {
    return "";
  }

  const firstFile = files[0]!;
  const firstPathParts = firstFile.path.split(/[\\/]/g).filter(Boolean);
  const firstName = firstPathParts.at(-1) ?? firstFile.path;
  if (files.length === 1) {
    return `Update ${firstName}`;
  }

  return `Update ${firstName} and ${files.length - 1} more`;
}

export function formatCommitGraphTimestamp(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (elapsedSeconds < 60) {
    return "just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) {
    return `${elapsedDays}d ago`;
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
