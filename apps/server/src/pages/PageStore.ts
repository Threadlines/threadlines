// @effect-diagnostics nodeBuiltinImport:off
/**
 * Agent pages on disk (docs/agent-pages.md).
 *
 * Each published version is one file, stored exactly as the agent wrote it
 * once its local images are inlined:
 *
 *   <pagesDir>/<thread segment>/<pageId>/<versionId>.html | .md
 *
 * Nothing here decides which files to keep. A version file belongs to the
 * page row that names it; PageFileSweep removes files no live row names.
 *
 * Local images come only from the thread's page assets folder, a folder of
 * the system temp folder that Threadlines makes for the thread. An agent puts
 * a picture there with its own tools, so its provider's file rules decide
 * what it may copy; Threadlines never reads a file on an agent's behalf from
 * anywhere else. The one other file it reads is a page a provider's own tool
 * just published (readPublishedPage), named by that tool's result.
 */
import { constants as NodeFsConstants } from "node:fs";
import * as NodeFs from "node:fs/promises";
import NodeOs from "node:os";
import NodePath from "node:path";

import type { AgentPageKind } from "@threadlines/contracts";
import { AGENT_PAGE_MAX_BYTES, AGENT_PAGE_MAX_IMAGE_BYTES } from "@threadlines/shared/agentPages";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";

const MIB = 1024 * 1024;
const formatMib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;

/** Page and version ids are server-made UUIDs; anything else never names a file. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isPageFileId = (id: string) => UUID.test(id);

export const pageFileExtension = (kind: AgentPageKind) => (kind === "markdown" ? "md" : "html");

export function threadPagesDir(pagesDir: string, threadId: string): string | null {
  const segment = toSafeThreadAttachmentSegment(threadId);
  return segment === null ? null : NodePath.join(pagesDir, segment);
}

export function pageVersionPath(input: {
  readonly pagesDir: string;
  readonly threadId: string;
  readonly pageId: string;
  readonly versionId: string;
  readonly kind: AgentPageKind;
}): string | null {
  const threadDir = threadPagesDir(input.pagesDir, input.threadId);
  if (threadDir === null || !isPageFileId(input.pageId) || !isPageFileId(input.versionId)) {
    return null;
  }
  return NodePath.join(
    threadDir,
    input.pageId.toLowerCase(),
    `${input.versionId.toLowerCase()}.${pageFileExtension(input.kind)}`,
  );
}

/** The folder an agent saves a page's local images in. */
export function pageAssetsDir(threadId: string, tmpDir: string = NodeOs.tmpdir()): string | null {
  const segment = toSafeThreadAttachmentSegment(threadId);
  return segment === null ? null : NodePath.join(tmpDir, "threadlines-page-assets", segment);
}

export class PageStoreError extends Schema.TaggedError<PageStoreError>()("PageStoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const storeError = (message: string, cause?: unknown) =>
  new PageStoreError({ message, ...(cause === undefined ? {} : { cause }) });

/** Makes the thread's assets folder, private to this user, and returns its real path. */
export const ensurePageAssetsDir = Effect.fn("PageStore.ensurePageAssetsDir")(function* (
  threadId: string,
  tmpDir?: string,
) {
  const dir = pageAssetsDir(threadId, tmpDir);
  if (dir === null) {
    return yield* storeError("This thread has no page assets folder.");
  }
  return yield* Effect.tryPromise({
    try: async () => {
      await NodeFs.mkdir(dir, { recursive: true, mode: 0o700 });
      const info = await NodeFs.lstat(dir);
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      // On a shared /tmp another user could have made it first.
      if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
        throw storeError(`The page assets folder ${dir} is not a folder this user owns.`);
      }
      return await NodeFs.realpath(dir);
    },
    catch: (cause) =>
      cause instanceof PageStoreError
        ? cause
        : storeError("The page assets folder could not be made.", cause),
  });
});

/** Writes one version, whole or not at all. */
export const writePageVersion = Effect.fn("PageStore.writePageVersion")(function* (input: {
  readonly path: string;
  readonly content: string;
}) {
  yield* Effect.tryPromise({
    try: async () => {
      await NodeFs.mkdir(NodePath.dirname(input.path), { recursive: true });
      const staging = `${input.path}.${process.pid}.${Date.now()}.tmp`;
      try {
        await NodeFs.writeFile(staging, input.content, { encoding: "utf8", flag: "wx" });
        await NodeFs.rename(staging, input.path);
      } catch (cause) {
        await NodeFs.rm(staging, { force: true });
        throw cause;
      }
    },
    catch: (cause) => storeError("The page could not be saved.", cause),
  });
});

const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Reads one stored version; refuses links, oversized files and bad text. */
export const readPageVersion = Effect.fn("PageStore.readPageVersion")(function* (path: string) {
  return yield* Effect.tryPromise({
    try: async () => {
      const handle = await NodeFs.open(path, NodeFsConstants.O_RDONLY | NodeFsConstants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > AGENT_PAGE_MAX_BYTES) {
          throw storeError("The page is not a readable page file.");
        }
        return textDecoder.decode(await handle.readFile());
      } finally {
        await handle.close();
      }
    },
    catch: (cause) =>
      cause instanceof PageStoreError ? cause : storeError("The page could not be read.", cause),
  });
});

/** The kind of page a published file is, by its extension. Null: not a page file. */
export const publishedPageKind = (path: string): AgentPageKind | null => {
  const extension = NodePath.extname(path).toLowerCase();
  if (extension === ".html" || extension === ".htm") return "html";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  return null;
};

/**
 * Reads the file a provider's own publishing tool just put online (a Claude
 * artifact), so the chat can show the same page. The path comes from that
 * tool's result, never from text an agent wrote, and the provider read the
 * file under its own rules a moment ago. A moment is still a gap, so this
 * takes only a plain page file: no link in its place, and no second name for
 * a file that lives somewhere else.
 */
export const readPublishedPage = Effect.fn("PageStore.readPublishedPage")(function* (path: string) {
  const kind = publishedPageKind(path);
  if (!NodePath.isAbsolute(path) || kind === null) {
    return yield* storeError("The published file is not an HTML or Markdown page.");
  }
  const content = yield* Effect.tryPromise({
    try: async () => {
      // Non-blocking, so a pipe put in the file's place is refused below
      // rather than waited on for a writer that never comes.
      const handle = await NodeFs.open(
        path,
        NodeFsConstants.O_RDONLY | NodeFsConstants.O_NOFOLLOW | NodeFsConstants.O_NONBLOCK,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1) {
          throw storeError("The published file is not a plain file.");
        }
        if (info.size > AGENT_PAGE_MAX_BYTES) {
          throw storeError(
            `The published page is ${formatMib(info.size)}; a page can be at most ${formatMib(AGENT_PAGE_MAX_BYTES)}.`,
          );
        }
        // The size it had when opened and no more, however it grows meanwhile.
        const bytes = Buffer.alloc(info.size);
        let filled = 0;
        while (filled < bytes.length) {
          const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        return textDecoder.decode(bytes.subarray(0, filled));
      } finally {
        await handle.close();
      }
    },
    catch: (cause) =>
      cause instanceof PageStoreError
        ? cause
        : storeError("The published page could not be read.", cause),
  });
  return { kind, content };
});

// ---------------------------------------------------------------------------
// Local images

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};
const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES).join("|");
// POSIX `/…` (not protocol-relative `//…`) or Windows `C:\…` / `C:/…`.
const ABSOLUTE_PATH = String.raw`(?:/(?!/)|[a-z]:[\\/])`;
// An absolute image path that is a whole quoted string ("…", '…', `…`), an
// unquoted CSS url(…), or a Markdown image destination. URLs, data:, blob:
// and relative paths never match.
const LOCAL_IMAGE_PATTERN = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` +
    String.raw`|url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)` +
    String.raw`|!\[[^\]\r\n]{0,512}\]\(\s*<?(${ABSOLUTE_PATH}[^\s<>()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))>?`,
  "gid",
);

interface ImageReference {
  readonly start: number;
  readonly end: number;
  readonly path: string;
}

const findLocalImages = (content: string): ReadonlyArray<ImageReference> =>
  Array.from(content.matchAll(LOCAL_IMAGE_PATTERN)).flatMap((match) => {
    const span = match.indices?.[2] ?? match.indices?.[3] ?? match.indices?.[4];
    return span ? [{ start: span[0], end: span[1], path: content.slice(span[0], span[1]) }] : [];
  });

// Inside a JS string literal a Windows path's backslashes are escaped.
const filePathFor = (reference: string) =>
  /^[a-z]:/i.test(reference) ? reference.replaceAll("\\\\", "\\") : reference;

const latin1 = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/** Whether bytes are an image, whatever the file is named. */
const isImageBytes = (bytes: Uint8Array) => {
  const head = latin1(bytes, 0, 12);
  if (
    head.startsWith("\x89PNG") ||
    head.startsWith("\xff\xd8\xff") ||
    head.startsWith("GIF8") ||
    head.startsWith("\0\0\x01\0") ||
    (head.startsWith("BM") && head.slice(6, 10) === "\0\0\0\0") ||
    (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
    /^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
  ) {
    return true;
  }
  return hasSvgRoot(new TextDecoder().decode(bytes.subarray(0, 4096)));
};

const after = (text: string, token: string, from: number) => {
  const at = text.indexOf(token, from);
  return at === -1 ? -1 : at + token.length;
};

/** Whether an XML document's root element is <svg>, in one forward pass. */
const hasSvgRoot = (text: string) => {
  let at = 0;
  while (at !== -1) {
    while (/\s/.test(text.charAt(at))) at += 1;
    if (text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (text.slice(at, at + 9).toLowerCase() === "<!doctype") at = afterDoctype(text, at + 9);
    else return /^<svg[ \t\r\n/>]/.test(text.slice(at, at + 5));
  }
  return false;
};

const afterDoctype = (text: string, from: number) => {
  let inSubset = false;
  let at = from;
  while (at !== -1 && at < text.length) {
    const char = text[at];
    if (char === '"' || char === "'") at = after(text, char, at + 1);
    else if (inSubset && text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (inSubset && text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (char === ">" && !inSubset) return at + 1;
    else {
      if (char === "[") inSubset = true;
      else if (char === "]") inSubset = false;
      at += 1;
    }
  }
  return -1;
};

const dataUriPrefix = (path: string) =>
  `data:${IMAGE_MIME_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream"};base64,`;

/**
 * Reads one image from inside the assets folder, or says why not. The file
 * must be a regular file with one name (no symlink, no hard link to a file
 * elsewhere), and after it is opened its one name must still resolve inside
 * the folder to the very file that was opened, so swapping a folder for a
 * link while this runs gains nothing.
 */
async function readAssetImage(
  assetsRoot: string,
  reference: string,
): Promise<{ readonly bytes: Uint8Array } | { readonly refused: string }> {
  const requested = NodePath.resolve(filePathFor(reference));
  let real: string;
  try {
    real = await NodeFs.realpath(requested);
  } catch {
    return { refused: "missing" };
  }
  if (!real.startsWith(assetsRoot + NodePath.sep)) {
    return { refused: "outside" };
  }
  const linkInfo = await NodeFs.lstat(requested).catch(() => null);
  if (linkInfo === null || !linkInfo.isFile() || linkInfo.nlink !== 1) {
    return { refused: "not-a-file" };
  }
  if (linkInfo.size > AGENT_PAGE_MAX_IMAGE_BYTES) {
    return { refused: `too-large:${linkInfo.size}` };
  }
  const handle = await NodeFs.open(
    requested,
    NodeFsConstants.O_RDONLY | NodeFsConstants.O_NOFOLLOW,
  ).catch(() => null);
  if (handle === null) return { refused: "not-a-file" };
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== linkInfo.dev ||
      opened.ino !== linkInfo.ino
    ) {
      return { refused: "not-a-file" };
    }
    const realAfter = await NodeFs.realpath(requested).catch(() => null);
    const infoAfter = realAfter === null ? null : await NodeFs.lstat(realAfter).catch(() => null);
    if (
      realAfter === null ||
      !realAfter.startsWith(assetsRoot + NodePath.sep) ||
      infoAfter === null ||
      infoAfter.dev !== opened.dev ||
      infoAfter.ino !== opened.ino
    ) {
      return { refused: "outside" };
    }
    const bytes = new Uint8Array(await handle.readFile());
    if (bytes.byteLength > AGENT_PAGE_MAX_IMAGE_BYTES) {
      return { refused: `too-large:${bytes.byteLength}` };
    }
    return isImageBytes(bytes) ? { bytes } : { refused: "not-an-image" };
  } finally {
    await handle.close();
  }
}

/**
 * Replaces every absolute-path image reference with a data URI. Every
 * referenced image must be readable from the assets folder, or the publish is
 * refused with a message naming each path and what to do.
 */
export const inlinePageImages = Effect.fn("PageStore.inlinePageImages")(function* (input: {
  readonly content: string;
  readonly assetsRoot: string;
}) {
  const references = findLocalImages(input.content);
  if (references.length === 0) {
    if (Buffer.byteLength(input.content) > AGENT_PAGE_MAX_BYTES) {
      return yield* storeError(
        `The page is ${formatMib(Buffer.byteLength(input.content))}; the limit is ${formatMib(AGENT_PAGE_MAX_BYTES)}.`,
      );
    }
    return input.content;
  }
  const paths = [...new Set(references.map((reference) => reference.path))];
  const results = yield* Effect.tryPromise({
    try: () =>
      Promise.all(
        paths.map(async (path) => [path, await readAssetImage(input.assetsRoot, path)] as const),
      ),
    catch: (cause) => storeError("The page's images could not be read.", cause),
  });
  const problems = results.flatMap(([path, result]) =>
    "refused" in result ? [{ path, reason: result.refused }] : [],
  );
  if (problems.length > 0) {
    const describe = ({ path, reason }: { path: string; reason: string }) =>
      reason === "outside"
        ? `${path} is outside the page assets folder`
        : reason === "missing"
          ? `${path} does not exist`
          : reason === "not-an-image"
            ? `${path} is not an image`
            : reason.startsWith("too-large:")
              ? `${path} is ${formatMib(Number(reason.slice("too-large:".length)))} (each image must be at most ${formatMib(AGENT_PAGE_MAX_IMAGE_BYTES)})`
              : `${path} is not a regular file (links are refused)`;
    return yield* storeError(
      `${problems.map(describe).join("; ")}. Save local images as regular files in ${input.assetsRoot} and reference them by absolute path, or remove them.`,
    );
  }
  const dataUris = new Map(
    results.flatMap(([path, result]) =>
      "bytes" in result
        ? [[path, dataUriPrefix(path) + Buffer.from(result.bytes).toString("base64")] as const]
        : [],
    ),
  );
  const parts: Array<string> = [];
  let cursor = 0;
  for (const reference of references) {
    const dataUri = dataUris.get(reference.path);
    if (dataUri === undefined) continue;
    parts.push(input.content.slice(cursor, reference.start), dataUri);
    cursor = reference.end;
  }
  parts.push(input.content.slice(cursor));
  const inlined = parts.join("");
  const bytes = Buffer.byteLength(inlined);
  if (bytes > AGENT_PAGE_MAX_BYTES) {
    return yield* storeError(
      `With its images inlined the page is ${formatMib(bytes)}; the limit is ${formatMib(AGENT_PAGE_MAX_BYTES)}. Use smaller images.`,
    );
  }
  return inlined;
});

/** Removes one version file; a missing file is fine. */
export const removePageVersion = (path: string) =>
  Effect.tryPromise(() => NodeFs.rm(path, { force: true })).pipe(Effect.ignore);
