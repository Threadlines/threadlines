/**
 * Setting up a project on another computer (docs/design/fleet.md, Part 8),
 * in the app's words: what a folder would mean, how far a job got. Pure, so
 * the dialog, the toasts and the Fleet page say the same things.
 *
 * @module projectSetup
 */
import { parseGitTransferProgress } from "@threadlines/shared/git";
import type {
  ProjectSetupDestinationState,
  ProjectSetupJob,
  ProjectSetupStage,
} from "@threadlines/contracts";

/** The folder states a setup can't use: Start waits for another folder. */
export function isProjectSetupDestinationBlocked(state: ProjectSetupDestinationState): boolean {
  return state === "other-repository" || state === "not-empty" || state === "not-a-folder";
}

/** One line under the folder field: what Start would do with it. */
export function describeProjectSetupDestination(
  state: ProjectSetupDestinationState,
  computerLabel: string,
): string {
  switch (state) {
    case "missing":
      return "A new folder.";
    case "empty":
      return "An empty folder.";
    case "same-repository":
      return `${computerLabel} already has a copy here. It will be added as it is, keeping its own files.`;
    case "other-repository":
      return "That folder holds a different repository.";
    case "not-empty":
      return "That folder isn't empty. Pick a new one.";
    case "not-a-folder":
      return "That's a file, not a folder.";
  }
}

const STAGE_WORDS: Record<ProjectSetupStage, string> = {
  cloning: "Downloading",
  submodules: "Getting submodules",
  copying: "Copying files",
  publishing: "Moving it into place",
  adding: "Adding the project",
  done: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Where a job stands, in a word or two: "Downloading · 45%". */
export function describeProjectSetupStage(
  job: Pick<ProjectSetupJob, "stage" | "progress">,
): string {
  const words = STAGE_WORDS[job.stage];
  return job.stage === "cloning" && job.progress.percent !== null
    ? `${words} · ${job.progress.percent}%`
    : words;
}

/**
 * The line under the stage. While the download runs, how much has come of
 * how much: "286 MB of about 553 MB · 19 MB/s". Otherwise git's own account
 * of the step ("Resolving deltas · ..."). Null when git hasn't said anything
 * worth showing.
 */
export function describeProjectSetupProgress(
  job: Pick<ProjectSetupJob, "stage" | "progress" | "expectedBytes">,
): string | null {
  if (job.stage !== "cloning" && job.stage !== "submodules") return null;
  const transfer =
    job.progress.phase === "Receiving objects"
      ? parseGitTransferProgress(job.progress.detail)
      : null;
  if (transfer !== null) {
    const received = formatProjectSetupFileSize(transfer.receivedBytes);
    const total =
      job.expectedBytes !== undefined && job.expectedBytes > 0
        ? ` of about ${formatProjectSetupFileSize(job.expectedBytes)}`
        : "";
    const speed =
      transfer.bytesPerSecond !== null
        ? ` · ${formatProjectSetupFileSize(transfer.bytesPerSecond)}/s`
        : "";
    return `${received}${total}${speed}`;
  }
  const parts = [job.progress.phase, job.progress.detail].filter(
    (part): part is string => part !== null && part.trim().length > 0,
  );
  return parts.length === 0 ? null : parts.join(" · ");
}

/** A size the short way: "812 B", "4 KB", "1.2 MB", "553 MB", "1.4 GB". */
export function formatProjectSetupFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) {
    const megabytes = bytes / 1024 ** 2;
    return megabytes < 10 ? `${megabytes.toFixed(1)} MB` : `${Math.round(megabytes)} MB`;
  }
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Why the ignored files can't go: this app reaches `label` without encryption. */
export function projectSetupFilesBlockedReason(label: string): string {
  return `This app reaches ${label} over an unencrypted address, so files can't be sent. Connect it with a code to send them.`;
}
