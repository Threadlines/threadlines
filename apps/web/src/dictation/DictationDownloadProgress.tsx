/**
 * The download line shared by the composer's setup popover and the Settings
 * model rows: a hairline bar and the byte count under it. Kept in one place so
 * a download reads identically wherever the user happens to be watching it.
 *
 * @module DictationDownloadProgress
 */
import { cn } from "~/lib/utils";
import { formatDownloadProgress } from "../lib/formatBytes";

export function DictationProgressBar({
  bytesDownloaded,
  bytesTotal,
  className,
}: {
  bytesDownloaded: number;
  bytesTotal: number;
  className?: string;
}) {
  const percent =
    bytesTotal > 0 ? Math.min(100, Math.max(0, (bytesDownloaded / bytesTotal) * 100)) : 0;
  return (
    <div
      aria-hidden="true"
      className={cn("h-[3px] w-full overflow-hidden rounded-full bg-control-active", className)}
    >
      <div className="h-full bg-primary-readable" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function DictationProgressLabel({
  bytesDownloaded,
  bytesTotal,
  className,
}: {
  bytesDownloaded: number;
  bytesTotal: number;
  className?: string;
}) {
  return (
    <span className={cn("font-mono text-[11px] text-muted-foreground", className)}>
      {formatDownloadProgress(bytesDownloaded, bytesTotal)}
    </span>
  );
}
