/**
 * The pictures the chat shows: on a tool step's row (inline bytes, a URL, or
 * a path on the agent's machine) and in an agent's reply (images, links and
 * paths it draws as previews). Shared so the chat, which draws them, and the
 * server, which lists them in the Media tab, apply one rule.
 *
 * @module chatMedia
 */
import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { parse, postprocess, preprocess } from "micromark";
import { gfm } from "micromark-extension-gfm";

import {
  findBareImagePaths,
  isAbsoluteInlineFilePath,
  isImageFilePath,
  localhostUrlFromText,
  parseChatFileReference,
  resolveMarkdownFileLinkTarget,
  splitPathAndPosition,
} from "./chatLinks.ts";
import { splitMarkdownBlocks } from "./markdownBlocks.ts";

/** One picture on a tool step's row. */
export interface ToolImagePreview {
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
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

/**
 * The pictures a tool step shows, as the chat draws them on its row: inline
 * bytes, a loadable URL, or a path on the agent's machine. A screenshot's
 * bytes run to megabytes, so callers that read the same payload often should
 * remember the answer per payload.
 */
export function readToolImages(payload: Record<string, unknown> | null): ToolImagePreview[] {
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

/**
 * The tool call a step belongs to. A call's started, updated and completed
 * rows carry the same pictures, so this (with the picture's place on the row)
 * tells one screenshot from another; null when the provider named no call.
 */
export function toolCallIdentity(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  return (
    asTrimmedString(payload?.toolCallId) ??
    asTrimmedString(data?.toolCallId) ??
    asTrimmedString(item?.id) ??
    asTrimmedString(data?.itemId) ??
    asTrimmedString(data?.id)
  );
}

/**
 * Where a tool step says its picture lives, when it names a picture file: a
 * screenshot tool's saved path, or the file a `Read` of a picture opened.
 * The chat shows such a step's inline bytes; this is the same picture on disk.
 */
export function toolImagePath(payload: Record<string, unknown> | null): string | null {
  const path = asTrimmedString(imagePathFromPayload(payload));
  return path !== null && isImageFilePath(path) ? path : null;
}

/** A picture an agent's reply shows, as the reply wrote it. */
export type MessagePicture =
  /** A link or image destination, an absolute path in inline code, or a bare
   *  path in prose: resolve it with {@link resolveMessagePicturePath}. */
  | { readonly kind: "path"; readonly path: string }
  /** Inline code naming a file the chat finds by searching the project
   *  (`home.png`, `shots/home.png`), with any `:line` suffix as written. */
  | { readonly kind: "citation"; readonly reference: string }
  /** An `http(s)` image the chat loads from the web. */
  | { readonly kind: "remote"; readonly url: string };

/** The file a `path` picture names, resolved against the thread's folder. */
export function resolveMessagePicturePath(path: string, cwd: string): string | null {
  const target = resolveMarkdownFileLinkTarget(path, cwd);
  if (target === null) return null;
  const file = splitPathAndPosition(target).path;
  return isImageFilePath(file) ? file : null;
}

// Only for telling a relative destination from a URL: the real folder is
// applied when the picture is listed, as the chat applies the thread's.
const CLASSIFY_CWD = "/";

/** Backslash escapes and character references, decoded as markdown does. */
function decodeDestination(raw: string): string {
  return raw.replace(
    /\\([!-/:-@[-`{-~])|&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/gu,
    (match, escaped, dec, hex, name) => {
      if (escaped !== undefined) return escaped;
      if (dec !== undefined || hex !== undefined) {
        const point = Number.parseInt(dec ?? hex, dec !== undefined ? 10 : 16);
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "\uFFFD";
      }
      const decoded = decodeNamedCharacterReference(name);
      return decoded === false ? match : decoded;
    },
  );
}

type MicromarkEvent = ReturnType<typeof postprocess>[number];

/** A reference label as markdown matches it: case-blind, spaces collapsed. */
function normalizeLabel(value: string): string {
  return value
    .replace(/[\t\n\r ]+/gu, " ")
    .trim()
    .toLowerCase()
    .toUpperCase();
}

function parseBlock(block: string): ReadonlyArray<MicromarkEvent> {
  return postprocess(
    parse({ extensions: [gfm()] })
      .document()
      .write(preprocess()(block, undefined, true)),
  );
}

/**
 * The pictures an agent's reply shows, in order, each once. Mirrors the chat's
 * markdown: `![](...)` to a local picture or an `http(s)` one, a link to a
 * local picture, inline code that is an absolute picture path or a file the
 * chat looks up, and a bare absolute, home or `./` picture path in prose.
 * Code blocks show none. The chat renders a reply block by block
 * (splitMarkdownBlocks), so a reference-style link only finds a definition in
 * its own block, here as there. Your own messages are plain text in the chat,
 * so this is only for the agent's.
 */
export function extractMessagePictures(text: string): MessagePicture[] {
  const found = new Map<string, MessagePicture>();
  for (const block of splitMarkdownBlocks(text)) {
    for (const picture of extractBlockPictures(block)) {
      const key = `${picture.kind}\u0000${
        picture.kind === "path"
          ? picture.path
          : picture.kind === "citation"
            ? picture.reference
            : picture.url
      }`;
      if (!found.has(key)) found.set(key, picture);
    }
  }
  return [...found.values()];
}

function extractBlockPictures(block: string): MessagePicture[] {
  if (block.trim().length === 0) return [];
  const events = parseBlock(block);
  const pictures: MessagePicture[] = [];
  const isLocalPicture = (value: string) => resolveMessagePicturePath(value, CLASSIFY_CWD) !== null;

  // Reference definitions first: a use may come before its definition.
  const definitions = new Map<string, string>();
  let definitionLabel: string | null = null;
  for (const [phase, token, context] of events) {
    if (phase !== "enter") continue;
    if (token.type === "definitionLabelString") {
      definitionLabel = normalizeLabel(context.sliceSerialize(token));
    } else if (token.type === "definitionDestinationString" && definitionLabel !== null) {
      // The first definition of a label wins.
      if (!definitions.has(definitionLabel)) {
        definitions.set(definitionLabel, decodeDestination(context.sliceSerialize(token)));
      }
      definitionLabel = null;
    }
  }

  // Links and images can nest (an image inside a link); each keeps its own
  // destination, or its label for a reference to a definition.
  const resources: Array<{
    readonly image: boolean;
    /** How many pictures were found before it opened. */
    readonly start: number;
    destination: string | null;
    label: string | null;
    reference: string | null;
  }> = [];
  let codeText: string[] | null = null;
  let definitionDepth = 0;
  let prose = "";
  const flushProse = () => {
    if (prose.length > 0) {
      for (const match of findBareImagePaths(prose))
        pictures.push({ kind: "path", path: match.text });
      prose = "";
    }
  };

  for (const [phase, token, context] of events) {
    const type = token.type;
    // An escaped character is part of the text it sits in (`my\_shot.png`).
    if (type === "characterEscape" || type === "escapeMarker") continue;
    // A definition shows nothing where it is written.
    if (type === "definition") {
      definitionDepth += phase === "enter" ? 1 : -1;
      continue;
    }
    if (definitionDepth > 0) continue;
    if (phase === "enter") {
      if (type === "data" || type === "characterEscapeValue") {
        if (resources.length === 0 && codeText === null) prose += context.sliceSerialize(token);
        continue;
      }
      if (type === "lineEnding" && resources.length === 0 && codeText === null) {
        prose += " ";
        continue;
      }
      flushProse();
      if (type === "image" || type === "link") {
        resources.push({
          image: type === "image",
          start: pictures.length,
          destination: null,
          label: null,
          reference: null,
        });
      } else if (type === "resourceDestinationString") {
        const resource = resources.at(-1);
        if (resource) resource.destination = decodeDestination(context.sliceSerialize(token));
      } else if (type === "labelText") {
        const resource = resources.at(-1);
        if (resource && resource.label === null) resource.label = context.sliceSerialize(token);
      } else if (type === "referenceString") {
        const resource = resources.at(-1);
        if (resource) resource.reference = context.sliceSerialize(token);
      } else if (type === "codeText") {
        codeText = [];
      } else if (type === "codeTextData" && codeText !== null) {
        codeText.push(context.sliceSerialize(token));
      } else if (type === "lineEnding" && codeText !== null) {
        // The chat only reads inline code that stays on one line.
        codeText.push("\n");
      }
      continue;
    }
    if (type === "data" || type === "characterEscapeValue" || type === "lineEnding") continue;
    flushProse();
    if (type === "image" || type === "link") {
      const resource = resources.pop();
      if (!resource) continue;
      // `[text][label]`, `[label][]` or `[label]`: the definition's destination.
      const destination = (
        resource.destination ??
        definitions.get(normalizeLabel(resource.reference ?? resource.label ?? "")) ??
        ""
      ).trim();
      if (destination.length === 0) continue;
      if (isLocalPicture(destination)) {
        // A link to a picture shows as that picture, in place of whatever
        // its text held (a thumbnail, say).
        pictures.length = resource.start;
        pictures.push({ kind: "path", path: destination });
      } else if (resource.image && /^https?:\/\//iu.test(destination)) {
        pictures.push({ kind: "remote", url: destination });
      }
    } else if (type === "codeText" && codeText !== null) {
      const span = codeText.join("");
      codeText = null;
      if (span.includes("\n")) continue;
      const reference = span.trim();
      if (reference.length === 0 || localhostUrlFromText(reference) !== null) continue;
      if (isAbsoluteInlineFilePath(reference)) {
        if (isLocalPicture(reference)) pictures.push({ kind: "path", path: reference });
      } else if (parseChatFileReference(reference) !== null && isLocalPicture(reference)) {
        pictures.push({ kind: "citation", reference });
      }
    }
  }
  flushProse();
  return pictures;
}
