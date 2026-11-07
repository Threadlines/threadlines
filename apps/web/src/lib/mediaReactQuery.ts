/**
 * The Media tab's listing query, and the helper both picture surfaces use to
 * show a revision read. Full pictures are read straight from the server and
 * kept only by the viewer, so they are not queries here.
 */
import type {
  EnvironmentId,
  ProjectId,
  ProjectRevisionFileResult,
  OrchestrationProjectMediaEntry,
  ThreadId,
} from "@threadlines/contracts";
import { queryOptions } from "@tanstack/react-query";

import { ensureEnvironmentApi } from "~/environmentApi";

/** Reads through the same transport as chat, including saved environments. */
export async function readMediaEntry(
  environmentId: EnvironmentId,
  entry: OrchestrationProjectMediaEntry,
) {
  const api = ensureEnvironmentApi(environmentId);
  if (!entry.source) {
    return api.projects.readFile({
      cwd: entry.cwd,
      relativePath: entry.relativePath,
      ...(entry.mediaKind === "document" ? { documents: true } : {}),
    });
  }
  if (entry.source.kind === "attachment") {
    const file = await api.attachments.read({ attachmentId: entry.source.attachment.id });
    return {
      kind: entry.mediaKind === "picture" ? ("image" as const) : ("document" as const),
      relativePath: entry.relativePath,
      mimeType: file.mimeType,
      base64: file.base64,
      size: entry.size,
    };
  }
  const preview = await api.orchestration.getProjectMediaPreview({
    threadId: entry.threadId,
    source: entry.source,
  });
  return preview.url
    ? { kind: "preview" as const, url: preview.url, size: entry.size }
    : { kind: "missing" as const, relativePath: entry.relativePath };
}

export const mediaQueryKeys = {
  all: ["media"] as const,
  list: (
    environmentId: EnvironmentId | null,
    projectId: ProjectId | null,
    threadId: ThreadId | null,
    revision: string,
  ) => ["media", "list", environmentId, projectId, threadId, revision] as const,
};

/** A listing is cheap and re-read whenever the tab is looked at again. */
const MEDIA_LIST_STALE_TIME = 10_000;

/**
 * The project's media, or one thread's with `threadId`. `revision` changes
 * when the caller knows the answer did (a turn of the thread landed), so the
 * listing follows turns without polling.
 */
export function projectMediaQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly threadId?: ThreadId | null;
  readonly revision: string;
  readonly enabled?: boolean;
  /** Re-read on this interval (ms) while enabled, for changes no revision announces. */
  readonly refetchInterval?: number;
}) {
  const threadId = input.threadId ?? null;
  return queryOptions({
    queryKey: mediaQueryKeys.list(input.environmentId, input.projectId, threadId, input.revision),
    queryFn: async () => {
      if (!input.environmentId || !input.projectId) {
        throw new Error("Media listing is unavailable.");
      }
      return ensureEnvironmentApi(input.environmentId).orchestration.listProjectMedia({
        projectId: input.projectId,
        ...(threadId ? { threadId } : {}),
      });
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null && input.projectId !== null,
    staleTime: MEDIA_LIST_STALE_TIME,
    ...(input.refetchInterval !== undefined ? { refetchInterval: input.refetchInterval } : {}),
    // A new revision is a new key; showing the last answer while it loads
    // keeps the grid from blanking every time a turn lands.
    placeholderData: (previous) => previous,
  });
}

/** A picture result as something an `<img>` can show, or null. */
export function revisionFileDataUrl(result: ProjectRevisionFileResult | undefined): string | null {
  return result?.kind === "image" ? `data:${result.mimeType};base64,${result.base64}` : null;
}
