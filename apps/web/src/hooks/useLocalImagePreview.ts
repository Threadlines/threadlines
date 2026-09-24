import type { EnvironmentId } from "@threadlines/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { workspaceReadRelativePath } from "../fileViewerStore";
import { isImageFilePath } from "../lib/imageFilePaths";
import { projectReadFileQueryOptions } from "../lib/projectReactQuery";

export interface LocalImagePreview {
  readonly status: "loading" | "ready" | "missing" | "unavailable";
  readonly dataUrl?: string | undefined;
}

const UNAVAILABLE: LocalImagePreview = { status: "unavailable" };
const MISSING: LocalImagePreview = { status: "missing" };
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
 * A path the server reports as gone is `missing`, so the reference can look
 * gone too. Every other failure -- binary, text, outside-root refusal, RPC
 * error -- is one `unavailable`: none of them says the file is not there. A
 * reference to a file that has since been deleted is an ordinary thing in a
 * transcript, not an error worth a message.
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
  const file = query.data;
  // Keyed on the cached result, which keeps its identity between renders, so a
  // caller that re-renders on every streamed delta does not rebuild a
  // multi-megabyte data url each time.
  const ready = useMemo<LocalImagePreview | null>(
    () =>
      file?.kind === "image"
        ? { status: "ready", dataUrl: `data:${file.mimeType};base64,${file.base64}` }
        : null,
    [file],
  );

  if (!enabled) {
    return UNAVAILABLE;
  }
  if (file) {
    return ready ?? (file.kind === "missing" ? MISSING : UNAVAILABLE);
  }
  return query.isError ? UNAVAILABLE : LOADING;
}
