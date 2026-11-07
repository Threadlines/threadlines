/** Image sources shared by chat tool rows and the Media listing. */
import { micromark } from "micromark";
import { classifyMediaPath, isImageFilePath } from "./media.ts";

/** Media explicitly shown or linked in a message, excluding fenced examples. */
export function extractMessageMedia(text: string): ReadonlyArray<{ path: string; image: boolean }> {
  const html = micromark(text, { allowDangerousProtocol: true }).replace(
    /<pre[\s\S]*?<\/pre>/gu,
    "",
  );
  const found = new Map<string, { path: string; image: boolean }>();
  const add = (raw: string, image = false) => {
    const path = decodeHtml(raw).trim();
    const local = !/^(?:https?:|data:|blob:)/iu.test(path);
    const kind = classifyMediaPath(path.replace(/:\d+(?::\d+)?$/u, "").split(/[?#]/u)[0] ?? path);
    if (path && (image || (local && kind !== null))) {
      found.set(path, { path, image: image || kind === "picture" });
    }
  };
  for (const match of html.matchAll(/<(img|a)\b[^>]*?\b(?:src|href)="([^"]*)"/gu)) {
    add(match[2]!, match[1] === "img");
  }
  for (const match of html.matchAll(/<code>([^<]+)<\/code>/gu)) add(match[1]!);
  const prose = decodeHtml(html.replace(/<[^>]*>/gu, " "));
  for (const match of prose.matchAll(/(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\/)[^\s"'`<>|*?]+/gu)) {
    const previous = prose[(match.index ?? 0) - 1];
    if (previous && /[A-Za-z0-9._\-/\\:@]/u.test(previous)) continue;
    add(match[0].replace(/[.,;!?)]+$/u, ""));
  }
  return [...found.values()];
}

function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|quot|lt|gt|apos|#(?:x[0-9a-f]+|[0-9]+));/giu, (entity) => {
    const named: Record<string, string> = {
      "&amp;": "&",
      "&quot;": '"',
      "&lt;": "<",
      "&gt;": ">",
      "&apos;": "'",
    };
    if (named[entity]) return named[entity]!;
    const point =
      entity[2]?.toLowerCase() === "x"
        ? Number.parseInt(entity.slice(3, -1), 16)
        : Number.parseInt(entity.slice(2, -1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

export interface ChatMediaImage {
  id: string;
  name: string;
  /** Directly renderable source (a data, http, or blob url), when the provider
   *  gave us the bytes. */
  previewUrl?: string;
  /** Where the image lives on the agent's machine, when the provider only named
   *  it. The renderer loads it over the `projects.readFile` RPC; carrying the
   *  path instead of the bytes keeps screenshots out of the stored event log. */
  path?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function asBase64ImageDataUrl(value: string): { previewUrl: string; mimeType: string } | null {
  const normalized = value.replace(/\s+/g, "");
  if (normalized.length < 32 || !/^[A-Za-z0-9+/=_-]+$/u.test(normalized)) {
    return null;
  }

  const base64 = normalized.replace(/-/g, "+").replace(/_/g, "/");
  const mimeType = inferImageMimeTypeFromBase64(base64);
  return {
    previewUrl: `data:${mimeType};base64,${padBase64(base64)}`,
    mimeType,
  };
}

function imageSourceFromValue(
  value: string,
  options?: { readonly allowBase64?: boolean },
): { previewUrl: string; mimeType?: string | undefined } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const dataUrlMatch = /^data:(image\/[a-z0-9.+-]+);base64,/iu.exec(trimmed);
  if (dataUrlMatch) {
    return {
      previewUrl: trimmed,
      mimeType: dataUrlMatch[1],
    };
  }

  if (/^(?:https?:|blob:)/iu.test(trimmed)) {
    return { previewUrl: trimmed };
  }

  if (options?.allowBase64) {
    return asBase64ImageDataUrl(trimmed);
  }

  return null;
}

function inferImageMimeTypeFromBase64(value: string): string {
  if (value.startsWith("iVBORw0KGgo")) return "image/png";
  if (value.startsWith("/9j/")) return "image/jpeg";
  if (value.startsWith("R0lGOD")) return "image/gif";
  if (value.startsWith("UklGR")) return "image/webp";
  if (value.startsWith("PHN2Zy") || value.startsWith("PD94bWw")) return "image/svg+xml";
  if (value.includes("ZnR5cGF2aWY", 4)) return "image/avif";
  return "image/png";
}

function padBase64(value: string): string {
  const remainder = value.length % 4;
  return remainder === 0 ? value : `${value}${"=".repeat(4 - remainder)}`;
}

function extensionForImageMimeType(mimeType: string | undefined): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "image/avif":
      return ".avif";
    default:
      return ".png";
  }
}

function fileNameFromPath(value: unknown): string | null {
  const raw = asTrimmedString(value);
  if (!raw) {
    return null;
  }

  const pathWithoutQuery = raw.split(/[?#]/u)[0] ?? raw;
  const normalized = pathWithoutQuery.replace(/\\/g, "/");
  const segments = normalized.split("/");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const candidate = segments[index]?.trim();
    if (candidate && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

function generatedImageName(input: {
  readonly id: string;
  readonly mimeType: string | undefined;
  readonly path: unknown;
}): string {
  return fileNameFromPath(input.path) ?? `${input.id}${extensionForImageMimeType(input.mimeType)}`;
}

/** The path a tool row names its image by, wherever the provider put it. */
function imagePathFromPayload(payload: Record<string, unknown> | null): unknown {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const input = asRecord(data?.input ?? item?.input);
  return (
    item?.savedPath ??
    item?.saved_path ??
    item?.path ??
    data?.savedPath ??
    data?.path ??
    input?.file_path ??
    input?.filePath ??
    input?.path
  );
}

/**
 * Image bytes a tool result carried inline, as `{mimeType, base64}` blocks.
 *
 * The Claude driver stores the raw `tool_result` block on the activity, so a
 * screenshot tool's `{type: "image", source: {type: "base64", ...}}` content
 * blocks are already here; reading them is what makes an MCP screenshot row a
 * picture without the event log holding a second copy.
 *
 * Rows saved before the server learned to keep image bytes whole hold a
 * trimmed copy (`...` plus the tail). That is not base64, and a data URL built
 * from it draws as a broken image, so such a block is skipped and the row falls
 * back to loading the named path.
 *
 */
function readImageBlocks(
  payload: Record<string, unknown> | null,
): Array<{ mimeType: string; base64: string }> {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const content = asRecord(data?.result ?? item?.result)?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((entry) => {
    const block = asRecord(entry);
    const source = asRecord(block?.source);
    if (block?.type !== "image" || source?.type !== "base64") {
      return [];
    }
    const mimeType = asTrimmedString(source.media_type);
    const base64 = asTrimmedString(source.data);
    return mimeType && base64 && isWholeBase64(base64) ? [{ mimeType, base64 }] : [];
  });
}

/** Any character outside the base64 alphabet and its `=` padding. */
const NON_BASE64_CHARACTER = /[^A-Za-z0-9+/=]/u;

/**
 * Whether `value` is whole base64: one or more alphabet characters, then at
 * most two `=`. The same answer as `/^[A-Za-z0-9+/]+={0,2}$/u`, but searching
 * for a stray character runs several times faster over a screenshot's
 * megabytes than matching the whole string against the pattern.
 */
export function isWholeBase64(value: string): boolean {
  if (NON_BASE64_CHARACTER.test(value)) {
    return false;
  }
  const paddingStart = value.indexOf("=");
  if (paddingStart === -1) {
    return value.length > 0;
  }
  const paddingLength = value.length - paddingStart;
  return (
    paddingStart > 0 &&
    (paddingLength === 1 || (paddingLength === 2 && value[paddingStart + 1] === "="))
  );
}

/** The pictures a step shows; callers may memoize immutable payloads. */
export function extractWorkLogImages(
  payload: Record<string, unknown> | null,
): ReadonlyArray<ChatMediaImage> {
  const imageBlocks = readImageBlocks(payload);
  if (!isImagePreviewPayload(payload, imageBlocks.length > 0)) {
    return [];
  }

  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const imageId =
    asTrimmedString(item?.id) ??
    asTrimmedString(data?.itemId) ??
    asTrimmedString(data?.id) ??
    "generated-image";
  const result = asTrimmedString(item?.result ?? data?.result ?? payload?.result);
  const path = imagePathFromPayload(payload);

  if (imageBlocks.length > 0) {
    return imageBlocks.map((block, index) => ({
      id: index === 0 ? imageId : `${imageId}:${index}`,
      name: generatedImageName({ id: imageId, mimeType: block.mimeType, path }),
      previewUrl: `data:${block.mimeType};base64,${block.base64}`,
    }));
  }

  const source = result
    ? imageSourceFromValue(result, { allowBase64: true })
    : imageSourceFromValue(asTrimmedString(path) ?? "", { allowBase64: false });

  if (source) {
    return [
      {
        id: imageId,
        name: generatedImageName({
          id: imageId,
          mimeType: source.mimeType,
          path,
        }),
        previewUrl: source.previewUrl,
      },
    ];
  }

  // A local path is not a source the browser can load, but it is a source the
  // renderer can fetch over the workspace RPC. Carrying the path here is what
  // turns "Viewed image" and Claude's `Read` of a screenshot into a picture.
  const localPath = asTrimmedString(path);
  if (localPath && isImageFilePath(localPath)) {
    return [
      {
        id: imageId,
        name: generatedImageName({ id: imageId, mimeType: undefined, path }),
        path: localPath,
      },
    ];
  }

  return [];
}

function isImagePreviewPayload(
  payload: Record<string, unknown> | null,
  hasImageBlocks: boolean,
): boolean {
  if (payload?.itemType === "image_view") {
    return true;
  }
  // A payload carrying image bytes needs no guessing from its name: a
  // screenshot tool can be called anything (`browser_screenshot`,
  // `take_screenshot`) and none of those words is "image".
  if (hasImageBlocks) {
    return true;
  }

  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const title = asTrimmedString(payload?.title)?.toLowerCase();
  const namespace = asTrimmedString(item?.namespace ?? data?.namespace)?.toLowerCase();
  const tool = asTrimmedString(item?.tool ?? data?.tool)?.toLowerCase();
  const itemType = asTrimmedString(item?.type ?? data?.type)?.toLowerCase();
  const path = asTrimmedString(imagePathFromPayload(payload))?.toLowerCase();

  return [title, namespace, tool, itemType, path].some(
    (value) =>
      value?.includes("image") === true || /\.(?:png|jpe?g|gif|webp|avif|svg)$/iu.test(value ?? ""),
  );
}
