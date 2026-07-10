import type { EnvironmentId } from "@threadlines/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureEnvironmentApi } from "~/environmentApi";
import { environmentUsesRelayTransport, resolveEnvironmentHttpUrl } from "~/environments/runtime";

export const attachmentPreviewQueryKeys = {
  preview: (environmentId: EnvironmentId, attachmentId: string) =>
    ["attachments", "preview", environmentId, attachmentId] as const,
};

/**
 * Fetches stored attachment bytes over the environment's WebSocket RPC and
 * yields a data URL. Relay-paired environments (phonelink) cannot reach the
 * server's `/attachments` HTTP route — the relay only carries the WebSocket —
 * so this is their only preview transport.
 */
export function chatAttachmentPreviewQueryOptions(input: {
  environmentId: EnvironmentId;
  attachmentId: string;
}) {
  return queryOptions({
    queryKey: attachmentPreviewQueryKeys.preview(input.environmentId, input.attachmentId),
    queryFn: async () => {
      const api = ensureEnvironmentApi(input.environmentId);
      const attachment = await api.attachments.read({ attachmentId: input.attachmentId });
      return `data:${attachment.mimeType};base64,${attachment.base64}`;
    },
    // Stored attachments are immutable, so a fetched preview never goes stale.
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
}

export function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

/**
 * Loads a stored attachment's raw bytes: over HTTP against the environment's
 * `/attachments` route, or over the WebSocket RPC for relay-paired
 * environments where that route is unreachable.
 */
export async function loadChatAttachmentBlob(input: {
  environmentId: EnvironmentId;
  attachmentId: string;
}): Promise<Blob> {
  if (environmentUsesRelayTransport(input.environmentId)) {
    const api = ensureEnvironmentApi(input.environmentId);
    const attachment = await api.attachments.read({ attachmentId: input.attachmentId });
    const binary = atob(attachment.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: attachment.mimeType });
  }
  const url = resolveEnvironmentHttpUrl({
    environmentId: input.environmentId,
    pathname: attachmentPreviewRoutePath(input.attachmentId),
  });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`The attachment could not be loaded (HTTP ${response.status}).`);
  }
  return response.blob();
}
