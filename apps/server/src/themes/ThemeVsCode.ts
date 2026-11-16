// @effect-diagnostics nodeBuiltinImport:off - SHA-256 of a downloaded extension, and its zip's bytes
/**
 * VS Code themes (docs/design/custom-themes.md, "VS Code themes"): color
 * themes from extensions on the Open VSX store, turned into Threadlines
 * themes to try.
 *
 * Searching: the store's search, then each result's package.json, so only
 * extensions under an open license (VSCODE_THEME_LICENSES) that hold color
 * themes are listed. Reading one: its package, checked against the SHA-256
 * the store gives, then its theme files out of the zip, each followed through
 * its `include` chain and converted (themeVsCode.ts).
 *
 * Everything comes from open-vsx.org and the host it sends downloads to,
 * over https, on the public internet, every response size-capped. A package
 * is opened in memory and only its manifest and theme files are read, each
 * capped; nothing is written to disk. Results are kept in memory a while.
 */
import { createHash } from "node:crypto";

import {
  type ThemeVsCodeExtension,
  ThemeVsCodeError,
  type ThemeVsCodePackage,
  type ThemeVsCodeReadInput,
  type ThemeVsCodeSearchInput,
  type ThemeVsCodeSearchResult,
  type ThemeVsCodeTheme,
} from "@threadlines/contracts";
import {
  convertVsCodeTheme,
  joinThemePath,
  parseJsonWithComments,
  readVsCodeTheme,
  vsCodeThemeLicense,
} from "@threadlines/shared/themeVsCode";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import yauzl from "yauzl";

import { makeHttpsFetch } from "../provider/managedRuntime/HttpsFetch.ts";
import type { DownloadFetch } from "../provider/managedRuntime/VerifiedDownload.ts";
import { readCapped } from "./themeFonts.ts";

export const OPEN_VSX_API = "https://open-vsx.org/api";
/** Where the store sends its file downloads. */
const OPEN_VSX_HOSTS = ["open-vsx.org", "openvsx.eclipsecontent.org"];
const PAGE_SIZE = 30;
const FETCH_TIMEOUT_MS = 20_000;
const SEARCH_MAX_BYTES = 1024 * 1024;
const MANIFEST_MAX_BYTES = 256 * 1024;
const PACKAGE_MAX_BYTES = 12 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 5_000;
const THEME_FILE_MAX_BYTES = 1024 * 1024;
/** All the files read out of one package together. */
const PACKAGE_READ_MAX_BYTES = 24 * 1024 * 1024;
const MAX_THEMES_PER_EXTENSION = 40;
/** Package manifests fetched at once while a search page is checked. */
const MANIFEST_CONCURRENCY = 6;
/** Packages downloaded at once, across every caller. */
const PACKAGE_CONCURRENCY = 3;
const SEARCHES_KEPT = 40;
const SEARCH_FRESH_MS = 10 * 60_000;
const MANIFESTS_KEPT = 600;
const PACKAGES_KEPT = 40;

export interface ThemeVsCodeShape {
  /** One page of extensions with color themes, under an open license. */
  readonly search: (
    input: ThemeVsCodeSearchInput,
  ) => Effect.Effect<ThemeVsCodeSearchResult, ThemeVsCodeError>;
  /** An extension's color themes, converted. */
  readonly read: (
    input: ThemeVsCodeReadInput,
  ) => Effect.Effect<ThemeVsCodePackage, ThemeVsCodeError>;
}

export class ThemeVsCode extends Context.Service<ThemeVsCode, ThemeVsCodeShape>()(
  "threadlines/themes/ThemeVsCode",
) {}

const vsCodeError = (detail: string) => new ThemeVsCodeError({ detail });
const isVsCodeError = Schema.is(ThemeVsCodeError);
const UNREACHABLE = "Couldn't reach the VS Code theme store (open-vsx.org).";

/** The store didn't answer, or answered with an error. */
class StoreUnreachable extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? [...value.trim()].slice(0, max).join("").trim() : "";

/** A color theme an extension declares: its label, kind and file. */
interface DeclaredTheme {
  readonly label: string;
  readonly uiTheme: string | undefined;
  readonly path: string;
}

/** What a package.json says that matters here. */
interface ExtensionManifest {
  readonly displayName: string;
  readonly description: string;
  readonly license: string | null;
  readonly themes: ReadonlyArray<DeclaredTheme>;
  readonly author: string | undefined;
  readonly link: string | undefined;
}

/** Just the name of an npm-style author ("Name <email> (url)"): never the address. */
function authorName(value: unknown): string | undefined {
  const raw = isRecord(value) ? value.name : value;
  if (typeof raw !== "string") return undefined;
  // Cut before any pattern runs: the store's metadata can be anything.
  const name = raw
    .slice(0, 200)
    .split(/[<(]/, 1)[0]!
    .split(/\s+/)
    .filter((word) => !word.includes("@") && !/^https?:/i.test(word))
    .join(" ")
    .trim();
  return name === "" ? undefined : name.slice(0, 60);
}

/** An https page for the theme: its homepage, else its repository. */
function linkOf(manifest: Record<string, unknown>): string | undefined {
  const candidates = [
    manifest.homepage,
    isRecord(manifest.repository) ? manifest.repository.url : manifest.repository,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length > 300) continue;
    const url = candidate
      .trim()
      .replace(/^git\+/, "")
      .replace(/\.git$/, "")
      .replace(/^git:\/\//, "https://");
    if (url.length <= 200 && /^https:\/\/[^\s/]+\S*$/.test(url)) return url;
  }
  return undefined;
}

export function readExtensionManifest(value: unknown): ExtensionManifest | null {
  if (!isRecord(value)) return null;
  const contributes = isRecord(value.contributes) ? value.contributes : {};
  const declared = Array.isArray(contributes.themes) ? contributes.themes : [];
  const themes: DeclaredTheme[] = [];
  for (const entry of declared) {
    if (!isRecord(entry) || typeof entry.path !== "string") continue;
    // Only JSON color themes: a TextMate (.tmTheme) file isn't read.
    if (!entry.path.toLowerCase().endsWith(".json")) continue;
    themes.push({
      label: text(entry.label, 120) || text(entry.id, 120) || entry.path,
      uiTheme: typeof entry.uiTheme === "string" ? entry.uiTheme : undefined,
      path: entry.path,
    });
  }
  return {
    displayName: text(value.displayName, 120) || text(value.name, 120),
    description: text(value.description, 400),
    license: vsCodeThemeLicense(value.license),
    themes,
    author: authorName(value.author),
    link: linkOf(value),
  };
}

/** A label like `%themeLabel%`, looked up in the package's translations. */
function localizedLabel(label: string, nls: Record<string, unknown> | null): string {
  const key = /^%(.+)%$/.exec(label)?.[1];
  if (key === undefined) return label;
  const value = nls?.[key];
  const found = isRecord(value) ? value.message : value;
  return typeof found === "string" && found.trim() !== "" ? text(found, 120) : label;
}

/** Keeps a map to its newest `limit` entries. */
function remember<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value as K);
}

/** A package's files, read out of its zip on demand, every read capped. */
async function openPackage(bytes: Uint8Array): Promise<{
  readonly read: (path: string) => Promise<string | null>;
  readonly close: () => void;
}> {
  const zip = await yauzl.fromBufferPromise(Buffer.from(bytes), {
    autoClose: false,
    lazyEntries: true,
    strictFileNames: false,
    validateEntrySizes: true,
  });
  if (zip.entryCount > ZIP_MAX_ENTRIES) {
    zip.close();
    throw new Error("The extension package holds too many files.");
  }
  const entries = new Map<string, yauzl.Entry>();
  for await (const entry of zip.eachEntry()) {
    if (!entry.fileName.endsWith("/")) entries.set(entry.fileName, entry);
  }
  let readSoFar = 0;
  return {
    read: async (path) => {
      const entry = entries.get(path);
      if (entry === undefined) return null;
      if (entry.uncompressedSize > THEME_FILE_MAX_BYTES) {
        throw new Error(`${path} is larger than a theme file may be.`);
      }
      readSoFar += entry.uncompressedSize;
      if (readSoFar > PACKAGE_READ_MAX_BYTES)
        throw new Error("The extension's themes are too large.");
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        size += chunk.byteLength;
        if (size > THEME_FILE_MAX_BYTES) {
          stream.destroy();
          throw new Error(`${path} is larger than a theme file may be.`);
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    },
    close: () => zip.close(),
  };
}

/** Builds the service on a given fetch; `ThemeVsCodeLive` uses the real one. */
export const makeThemeVsCode = Effect.fn("ThemeVsCode.make")(function* (
  options: { readonly fetch?: DownloadFetch; readonly now?: () => number } = {},
) {
  const fetch =
    options.fetch ??
    makeHttpsFetch({ allowedHosts: OPEN_VSX_HOSTS, publicAddressesOnly: true, maxRedirects: 2 });
  const now = options.now ?? Date.now;
  const downloads = yield* Semaphore.make(PACKAGE_CONCURRENCY);
  const searches = new Map<
    string,
    { readonly at: number; readonly result: ThemeVsCodeSearchResult }
  >();
  /** Each manifest read, and when; one that wasn't there is asked for again after a while. */
  const manifests = new Map<
    string,
    { readonly at: number; readonly manifest: ExtensionManifest | null }
  >();
  const packages = new Map<string, ThemeVsCodePackage>();

  /** One file from the store, at most `maxBytes`; null when it isn't there. */
  const fetchBytes = async (url: string, maxBytes: number, signal: AbortSignal) => {
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      });
    } catch (cause) {
      throw new StoreUnreachable(String(cause));
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new StoreUnreachable(`open-vsx.org answered ${response.status}`);
    }
    const bytes = await readCapped(response, maxBytes).catch((cause: unknown) => {
      throw new StoreUnreachable(String(cause));
    });
    if (bytes === null) throw vsCodeError("The store sent a file larger than a theme's may be.");
    return bytes;
  };

  const fileUrl = (input: ThemeVsCodeReadInput, file: string) =>
    `${OPEN_VSX_API}/${encodeURIComponent(input.namespace)}/${encodeURIComponent(input.name)}/${encodeURIComponent(input.version)}/file/${encodeURIComponent(file)}`;

  /**
   * An extension's package.json, read once per version; null when it isn't
   * there or isn't a manifest. A store that didn't answer throws
   * StoreUnreachable, and nothing is remembered.
   */
  const manifestOf = async (input: ThemeVsCodeReadInput, signal: AbortSignal) => {
    const key = `${input.namespace}.${input.name}@${input.version}`;
    const known = manifests.get(key);
    if (known !== undefined && (known.manifest !== null || now() - known.at < SEARCH_FRESH_MS)) {
      return known.manifest;
    }
    const bytes = await fetchBytes(fileUrl(input, "package.json"), MANIFEST_MAX_BYTES, signal);
    let manifest: ExtensionManifest | null = null;
    try {
      manifest =
        bytes === null
          ? null
          : readExtensionManifest(parseJsonWithComments(new TextDecoder().decode(bytes)));
    } catch {
      manifest = null;
    }
    remember(manifests, key, { at: now(), manifest }, MANIFESTS_KEPT);
    return manifest;
  };

  const search: ThemeVsCodeShape["search"] = (input) =>
    Effect.tryPromise({
      try: async (signal) => {
        const offset = input.offset ?? 0;
        const query = input.query.trim();
        const key = JSON.stringify([query.toLowerCase(), input.sort, offset]);
        const kept = searches.get(key);
        if (kept !== undefined && now() - kept.at < SEARCH_FRESH_MS) return kept.result;
        const params = new URLSearchParams({
          category: "Themes",
          query,
          size: String(PAGE_SIZE),
          offset: String(offset),
          sortBy:
            input.sort === "downloads"
              ? "downloadCount"
              : input.sort === "rating"
                ? "averageRating"
                : "relevance",
          sortOrder: "desc",
        });
        const bytes = await fetchBytes(
          `${OPEN_VSX_API}/-/search?${params}`,
          SEARCH_MAX_BYTES,
          signal,
        );
        const parsed: unknown = bytes === null ? null : JSON.parse(new TextDecoder().decode(bytes));
        if (!isRecord(parsed) || !Array.isArray(parsed.extensions)) {
          throw new Error("The store's answer wasn't a search result.");
        }
        const total = typeof parsed.totalSize === "number" ? parsed.totalSize : 0;
        const found = parsed.extensions
          .filter(isRecord)
          .filter((entry) => entry.deprecated !== true);
        const listed: Array<ThemeVsCodeExtension | null> = Array.from(
          { length: found.length },
          () => null,
        );
        let next = 0;
        let unanswered = 0;
        const worker = async () => {
          while (next < found.length) {
            const index = next++;
            const entry = found[index]!;
            const ids = {
              namespace: text(entry.namespace, 100),
              name: text(entry.name, 100),
              version: text(entry.version, 100),
            };
            if (
              ![ids.namespace, ids.name, ids.version].every((id) =>
                /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id),
              )
            ) {
              continue;
            }
            let manifest: ExtensionManifest | null;
            try {
              manifest = await manifestOf(ids, signal);
            } catch (cause) {
              // Left out this time; the page isn't kept, so the next search asks again.
              if (!(cause instanceof StoreUnreachable)) throw cause;
              unanswered += 1;
              continue;
            }
            if (manifest === null || manifest.license === null || manifest.themes.length === 0)
              continue;
            listed[index] = {
              ...ids,
              displayName: text(entry.displayName, 120) || ids.name,
              publisher: ids.namespace,
              description: text(entry.description, 400),
              downloads:
                typeof entry.downloadCount === "number" && entry.downloadCount > 0
                  ? Math.floor(entry.downloadCount)
                  : 0,
              license: manifest.license,
              themeCount: Math.min(manifest.themes.length, MAX_THEMES_PER_EXTENSION),
            };
          }
        };
        await Promise.all(Array.from({ length: MANIFEST_CONCURRENCY }, worker));
        const result: ThemeVsCodeSearchResult = {
          extensions: listed.filter((entry): entry is ThemeVsCodeExtension => entry !== null),
          nextOffset: offset + PAGE_SIZE < total ? offset + PAGE_SIZE : null,
          ...(unanswered > 0 ? { incomplete: true } : {}),
        };
        if (unanswered > 0 && result.extensions.length === 0)
          throw new StoreUnreachable("manifests");
        if (unanswered === 0) remember(searches, key, { at: now(), result }, SEARCHES_KEPT);
        return result;
      },
      catch: (cause) => (isVsCodeError(cause) ? cause : vsCodeError(UNREACHABLE)),
    });

  const readPackage = (input: ThemeVsCodeReadInput) =>
    Effect.tryPromise({
      try: async (signal) => {
        const key = `${input.namespace}.${input.name}@${input.version}`;
        const kept = packages.get(key);
        if (kept !== undefined) return kept;
        const manifest = await manifestOf(input, signal);
        if (manifest === null) throw vsCodeError("That extension couldn't be read from the store.");
        if (manifest.license === null) {
          throw vsCodeError(
            "That extension isn't under an open license, so it can't be brought in.",
          );
        }
        const file = `${input.namespace}.${input.name}-${input.version}`;
        const digest = await fetchBytes(fileUrl(input, `${file}.sha256`), 1024, signal);
        const expected =
          digest === null ? null : /\b[0-9a-f]{64}\b/i.exec(new TextDecoder().decode(digest))?.[0];
        if (expected == null)
          throw vsCodeError("The store didn't say what that extension should hold.");
        const bytes = await fetchBytes(fileUrl(input, `${file}.vsix`), PACKAGE_MAX_BYTES, signal);
        if (bytes === null) throw vsCodeError("That extension isn't in the store anymore.");
        if (createHash("sha256").update(bytes).digest("hex") !== expected.toLowerCase()) {
          throw vsCodeError("The extension that arrived isn't the one the store lists.");
        }
        const zip = await openPackage(bytes).catch(() => {
          throw vsCodeError("That extension's package couldn't be opened.");
        });
        try {
          // What's inside decides, not what the store said: the license again, then the themes.
          const packaged = await zip.read("extension/package.json");
          const inside =
            packaged === null ? null : readExtensionManifest(parseJsonWithComments(packaged));
          if (inside === null) throw vsCodeError("That extension's package has no manifest.");
          if (inside.license === null) {
            throw vsCodeError(
              "That extension isn't under an open license, so it can't be brought in.",
            );
          }
          const nlsText = await zip.read("extension/package.nls.json").catch(() => null);
          let nls: Record<string, unknown> | null = null;
          try {
            const value = nlsText === null ? null : parseJsonWithComments(nlsText);
            nls = isRecord(value) ? value : null;
          } catch {
            nls = null;
          }
          const themes: ThemeVsCodeTheme[] = [];
          const skipped: Array<{ label: string; reason: string }> = [];
          for (const declared of inside.themes.slice(0, MAX_THEMES_PER_EXTENSION)) {
            const label = localizedLabel(declared.label, nls);
            const path = joinThemePath("extension/package.json", declared.path);
            if (path === null) {
              skipped.push({ label, reason: "Its file is outside the extension." });
              continue;
            }
            try {
              const theme = await readVsCodeTheme(path, zip.read);
              const converted = convertVsCodeTheme({
                theme,
                label,
                ...(declared.uiTheme === undefined ? {} : { uiTheme: declared.uiTheme }),
                source: {
                  extension: `${input.namespace}.${input.name}`,
                  version: input.version,
                  license: inside.license,
                  author: inside.author ?? input.namespace,
                  link:
                    inside.link ??
                    `https://open-vsx.org/extension/${input.namespace}/${input.name}`,
                },
              });
              if (!converted.ok) {
                skipped.push({ label, reason: converted.problem });
                continue;
              }
              const { manifest, adjusted } = converted;
              themes.push({
                label: manifest.name,
                file: path,
                base: manifest.base,
                colors: {
                  background: manifest.colors.background,
                  foreground: manifest.colors.foreground,
                  accent: manifest.colors.accent,
                },
                manifest,
                adjusted,
              });
            } catch (cause) {
              skipped.push({
                label,
                reason: cause instanceof Error ? cause.message : "Its file couldn't be read.",
              });
            }
          }
          const result: ThemeVsCodePackage = {
            extension: {
              namespace: input.namespace,
              name: input.name,
              version: input.version,
              displayName: inside.displayName || input.name,
              publisher: input.namespace,
              description: inside.description,
              downloads: 0,
              license: inside.license,
              themeCount: themes.length,
            },
            themes,
            skipped,
          };
          remember(packages, key, result, PACKAGES_KEPT);
          return result;
        } finally {
          zip.close();
        }
      },
      catch: (cause) =>
        isVsCodeError(cause)
          ? cause
          : cause instanceof StoreUnreachable
            ? vsCodeError(UNREACHABLE)
            : vsCodeError("That extension couldn't be read."),
    });

  const read: ThemeVsCodeShape["read"] = (input) => downloads.withPermits(1)(readPackage(input));

  return ThemeVsCode.of({ search, read });
});

export const ThemeVsCodeLive = Layer.effect(ThemeVsCode, makeThemeVsCode());
