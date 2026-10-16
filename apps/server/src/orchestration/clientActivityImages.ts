import type { OrchestrationThreadActivity } from "@threadlines/contracts";

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;

const trimmedString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toolCallIdOf = (payload: Json | null): string | null =>
  trimmedString(payload?.toolCallId) ?? trimmedString(asRecord(payload?.data)?.toolCallId);

/** The id clients give a row's first image; later ones add `:<index>`. */
const imageIdOf = (payload: Json | null): string => {
  const data = asRecord(payload?.data);
  return (
    trimmedString(asRecord(data?.item)?.id) ??
    trimmedString(data?.itemId) ??
    trimmedString(data?.id) ??
    "generated-image"
  );
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

interface ImageBlock {
  readonly mediaType: unknown;
  readonly data: string;
}

const imageBlockOf = (block: unknown): ImageBlock | null => {
  const record = asRecord(block);
  const source = asRecord(record?.source);
  return record?.type === "image" && source?.type === "base64" && typeof source.data === "string"
    ? { mediaType: source.media_type, data: source.data }
    : null;
};

const imageBlocksIn = (payload: Json | null): ReadonlyArray<ImageBlock> => {
  const content = resultOf(payload)?.result.content;
  return Array.isArray(content)
    ? content.map(imageBlockOf).filter((block): block is ImageBlock => block !== null)
    : [];
};

interface Completion {
  readonly imageId: string;
  readonly images: ReadonlyArray<ImageBlock>;
}

/**
 * Drops screenshot bytes a client would never show from the activities sent
 * to it in a chat snapshot or an older turn's steps.
 *
 * A tool call's image result rides on its in-progress `tool.updated` rows and
 * again on its `tool.completed` row, byte for byte. Clients merge a call's rows
 * into one work-log entry, keyed per image by the row's image id and the
 * image's position (see extractWorkLogImages in apps/web/src/session-logic.ts),
 * and the later row wins each key. So once the call completed, an update whose
 * images all sit at the same positions, with the same bytes, in its completion
 * is never displayed: on a real install that was about a third of snapshot
 * bytes.
 *
 * Such an update loses all its image blocks, never some (removing one would
 * renumber the rest and let the completion overwrite a different image). Only
 * the blocks clients read images from are touched (`type: "image"` with a
 * base64 source in the result's `content`), the completion compared is the
 * call's next one (the row that closes the merged entry), and everything else,
 * including the stored rows server code reads, stays whole.
 */
export function dropSupersededToolUpdateImages<A extends OrchestrationThreadActivity>(
  activities: ReadonlyArray<A>,
): ReadonlyArray<A> {
  // Walk newest first so the map holds each call's next completion.
  const nextCompletionByCall = new Map<string, Completion>();
  let result: A[] | null = null;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    const payload = asRecord(activity.payload);
    const toolCallId = toolCallIdOf(payload);
    if (toolCallId === null) continue;

    if (activity.kind === "tool.completed") {
      nextCompletionByCall.set(toolCallId, {
        imageId: imageIdOf(payload),
        images: imageBlocksIn(payload),
      });
      continue;
    }
    if (activity.kind !== "tool.updated") continue;

    const completion = nextCompletionByCall.get(toolCallId);
    const located = resultOf(payload);
    const content = located?.result.content;
    if (!completion || !located || !Array.isArray(content)) continue;
    const images = imageBlocksIn(payload);
    const superseded =
      images.length > 0 &&
      images.length <= completion.images.length &&
      imageIdOf(payload) === completion.imageId &&
      images.every(
        (image, imageIndex) =>
          image.data === completion.images[imageIndex]!.data &&
          image.mediaType === completion.images[imageIndex]!.mediaType,
      );
    if (!superseded) continue;

    const data = asRecord(payload!.data)!;
    const strippedResult = {
      ...located.result,
      content: content.filter((block) => imageBlockOf(block) === null),
    };
    const strippedData = located.inItem
      ? { ...data, item: { ...asRecord(data.item), result: strippedResult } }
      : { ...data, result: strippedResult };
    result ??= [...activities];
    result[index] = { ...activity, payload: { ...payload, data: strippedData } };
  }
  return result ?? activities;
}
