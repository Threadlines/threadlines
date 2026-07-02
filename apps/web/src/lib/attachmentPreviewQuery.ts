import type { EnvironmentId } from "@threadlines/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureEnvironmentApi } from "~/environmentApi";

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
