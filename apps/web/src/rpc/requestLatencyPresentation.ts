import type { SlowRpcAckRequest } from "./requestLatencyState";

const SLOW_RPC_AREA_LABELS: Readonly<Record<string, string>> = {
  filesystem: "Files",
  git: "Git",
  orchestration: "Thread",
  server: "Server",
  shell: "Shell",
  vcs: "Source control",
};

function formatRpcTagSegment(value: string): string {
  return value
    .replace(/[-_]+/gu, " ")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

export function formatSlowRpcTagLabel(tag: string): string {
  const parts = tag
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return "request";
  }

  const [area, ...rest] = parts;
  const areaLabel = area ? SLOW_RPC_AREA_LABELS[area] : undefined;
  const methodLabel = rest.map(formatRpcTagSegment).filter(Boolean).join(" ");
  if (areaLabel && methodLabel.length > 0) {
    return `${areaLabel} ${methodLabel}`;
  }

  return parts.map(formatRpcTagSegment).filter(Boolean).join(" ") || tag;
}

export function describeSlowRpcAckToast(requests: ReadonlyArray<SlowRpcAckRequest>): string {
  const count = requests.length;
  const thresholdSeconds = Math.round((requests[0]?.thresholdMs ?? 0) / 1000);
  const requestLabels = requests
    .slice(0, 2)
    .map((request) => formatSlowRpcTagLabel(request.tag))
    .filter((tag) => tag.trim().length > 0);
  const requestSummary =
    requestLabels.length === 0
      ? null
      : `${requestLabels.join(", ")}${requests.length > requestLabels.length ? ", ..." : ""}`;

  if (requestSummary) {
    return `${count} request${count === 1 ? "" : "s"} waiting longer than ${thresholdSeconds}s: ${requestSummary}.`;
  }

  return `${count} request${count === 1 ? "" : "s"} waiting longer than ${thresholdSeconds}s.`;
}
