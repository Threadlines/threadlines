/**
 * The Media tab's listing query, and the helper both picture surfaces use to
 * show a revision read. Full pictures are read straight from the server and
 * kept only by the viewer, so they are not queries here.
 */
import type {
  EnvironmentId,
  OrchestrationChatMediaEntry,
  ProjectId,
  ProjectReadFileResult,
  ProjectRevisionFileResult,
  ThreadId,
} from "@threadlines/contracts";
import { queryOptions } from "@tanstack/react-query";

import { ensureEnvironmentApi } from "~/environmentApi";

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
        includeChat: true,
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

/**
 * The bytes of a picture or PDF shared in chat, shaped like a file read so
 * tiles and the viewer treat it as one. Null for a `remote` picture, which
 * loads from its address as it does in the chat.
 */
export async function readChatMediaFile(
  environmentId: EnvironmentId,
  entry: OrchestrationChatMediaEntry,
): Promise<ProjectReadFileResult | null> {
  const api = ensureEnvironmentApi(environmentId);
  const document = entry.mediaKind === "document";
  switch (entry.source.kind) {
    case "attachment": {
      const file = await api.attachments.read({ attachmentId: entry.source.attachment.id });
      return {
        kind: document ? "document" : "image",
        relativePath: entry.name,
        mimeType: file.mimeType,
        base64: file.base64,
        size: file.sizeBytes,
      };
    }
    case "file":
      // From the thread's folder, as the chat reads it: a file outside it is
      // only served when its bytes really are a picture.
      return api.projects.readFile({
        cwd: entry.cwd,
        relativePath: entry.source.path,
        ...(document ? { documents: true } : {}),
      });
    case "inline": {
      const result = await api.orchestration.readChatMedia({
        threadId: entry.threadId,
        mediaId: entry.id,
      });
      return result.kind === "image"
        ? {
            kind: "image",
            relativePath: entry.name,
            mimeType: result.mimeType,
            base64: result.base64,
            size: result.size,
          }
        : { kind: "missing", relativePath: entry.name };
    }
    case "remote":
      return null;
  }
}
