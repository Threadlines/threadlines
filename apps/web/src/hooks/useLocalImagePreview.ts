import type { EnvironmentId } from "@threadlines/contracts";
import { useQuery } from "@tanstack/react-query";

import { workspaceReadRelativePath } from "../fileViewerStore";
import { isImageFilePath } from "../lib/imageFilePaths";
import { projectReadFileQueryOptions } from "../lib/projectReactQuery";

export interface LocalImagePreview {
  readonly status: "loading" | "ready" | "unavailable";
  readonly dataUrl?: string | undefined;
}

const UNAVAILABLE: LocalImagePreview = { status: "unavailable" };
const LOADING: LocalImagePreview = { status: "loading" };

/**
 * The one way a chat surface turns a path an agent mentioned into pixels.
 *
 * Bytes travel over the `projects.readFile` WebSocket RPC and nothing else: a
 * relay-paired phone has no HTTP route to the server, so an `<img src>` pointed
 * at one would simply never load. Going through the shared react-query cache
 * also means the same screenshot cited in prose, in a link, and on a tool row
 * is fetched once.
 *
 * Every failure -- missing file, binary, text, outside-root refusal, RPC error
 * -- is one `unavailable`. A reference to a file that has since been deleted is
 * an ordinary thing in a transcript, not an error worth a message.
 */
export function useLocalImagePreview(input: {
  readonly environmentId: EnvironmentId | undefined;
  readonly cwd: string | undefined;
  /** Absolute, `../`-relative, or workspace-relative path to the image. */
  readonly path: string | undefined;
}): LocalImagePreview {
  const relativePath =
    input.cwd && input.path && isImageFilePath(input.path)
      ? workspaceReadRelativePath(input.path, input.cwd)
      : null;
  const enabled = Boolean(input.environmentId && input.cwd && relativePath);
  const query = useQuery({
    ...projectReadFileQueryOptions({
      environmentId: input.environmentId ?? null,
      cwd: input.cwd ?? null,
      relativePath,
      enabled,
    }),
    // A refused or unreadable path fails the same way every time, and a long
    // transcript can hold many of them; retrying each one is pure traffic.
    retry: false,
  });

  if (!enabled) {
    return UNAVAILABLE;
  }
  if (query.data) {
    return query.data.kind === "image"
      ? { status: "ready", dataUrl: `data:${query.data.mimeType};base64,${query.data.base64}` }
      : UNAVAILABLE;
  }
  return query.isError ? UNAVAILABLE : LOADING;
}
