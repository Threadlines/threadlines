import type { OrchestrationThreadActivity } from "@threadlines/contracts";

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;

const toolCallIdOf = (payload: Json | null): string | null => {
  const id = payload?.toolCallId ?? asRecord(payload?.data)?.toolCallId;
  return typeof id === "string" && id.length > 0 ? id : null;
};

/** Where a tool result's content blocks live: `data.result`, else `data.item.result`. */
const resultOf = (
  payload: Json | null,
): { readonly result: Json; readonly inItem: boolean } | null => {
  const data = asRecord(payload?.data);
  const inItem = data?.result === undefined || data.result === null;
  const result = asRecord(inItem ? asRecord(data?.item)?.result : data?.result);
  return result ? { result, inItem } : null;
};

const imageDataOf = (block: unknown): string | null => {
  const record = asRecord(block);
  const source = asRecord(record?.source);
  return record?.type === "image" && source?.type === "base64" && typeof source.data === "string"
    ? source.data
    : null;
};

const imageDataIn = (payload: Json | null): ReadonlyArray<string> => {
  const content = resultOf(payload)?.result.content;
  return Array.isArray(content)
    ? content.map(imageDataOf).filter((data): data is string => data !== null)
    : [];
};

/**
 * Drops screenshot bytes a client would never show from the activities sent
 * to it in a chat snapshot or an older turn's steps.
 *
 * A tool call's image result rides on its in-progress `tool.updated` rows and
 * again on its `tool.completed` row, byte for byte. Clients merge a call's rows
 * into one work-log entry in which the later row's images replace the earlier
 * ones (their image ids match), so once the call completed the `tool.updated`
 * copy is never displayed. On a real install it was about a third of snapshot
 * bytes.
 *
 * Only the blocks clients read images from are touched (`type: "image"` with a
 * base64 source in the result's `content`; see imageBlocksFromPayload in
 * apps/web/src/session-logic.ts), and only when a later `tool.completed` of the
 * same tool call carries the same data. Everything else, and the stored rows
 * that server code reads, stays whole.
 */
export function dropSupersededToolUpdateImages<A extends OrchestrationThreadActivity>(
  activities: ReadonlyArray<A>,
): ReadonlyArray<A> {
  // Walk newest first so the map only ever holds images of later completions.
  const completedImagesByCall = new Map<string, Set<string>>();
  let result: A[] | null = null;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    const payload = asRecord(activity.payload);
    const toolCallId = toolCallIdOf(payload);
    if (toolCallId === null) continue;

    if (activity.kind === "tool.completed") {
      const images = imageDataIn(payload);
      if (images.length > 0) {
        const known = completedImagesByCall.get(toolCallId) ?? new Set<string>();
        for (const data of images) known.add(data);
        completedImagesByCall.set(toolCallId, known);
      }
      continue;
    }
    if (activity.kind !== "tool.updated") continue;

    const laterImages = completedImagesByCall.get(toolCallId);
    const located = resultOf(payload);
    const content = located?.result.content;
    if (!laterImages || !located || !Array.isArray(content)) continue;
    const kept = content.filter((block) => {
      const data = imageDataOf(block);
      return data === null || !laterImages.has(data);
    });
    if (kept.length === content.length) continue;

    const data = asRecord(payload!.data)!;
    const strippedResult = { ...located.result, content: kept };
    const strippedData = located.inItem
      ? { ...data, item: { ...asRecord(data.item), result: strippedResult } }
      : { ...data, result: strippedResult };
    result ??= [...activities];
    result[index] = { ...activity, payload: { ...payload, data: strippedData } };
  }
  return result ?? activities;
}
