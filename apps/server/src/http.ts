import Mime from "@effect/platform-node/Mime";
import { decodeOtlpTraceRecords } from "@threadlines/shared/observability";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
} from "effect/unstable/http";
import { OtlpTracer } from "effect/unstable/observability";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { resolveAttachmentPathById } from "./attachmentStore.ts";
import { resolveStaticDir, ServerConfig, shouldEnableTransferCompression } from "./config.ts";
import { BrowserTraceCollector } from "./observability/Services/BrowserTraceCollector.ts";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver.ts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import { respondToAuthError } from "./auth/http.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import {
  browserApiCorsAllowedHeaders,
  browserApiCorsAllowedMethods,
  browserApiCorsHeaders,
} from "./httpCors.ts";
import { IMAGE_MIME_TYPE_BY_EXTENSION, SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";
import { isCurrentProviderExtensionPluginIconPath } from "./provider/providerExtensions.ts";

const PROJECT_FAVICON_CACHE_CONTROL = "public, max-age=3600";
const PROJECT_FAVICON_FALLBACK_CACHE_CONTROL = "no-store";
const FALLBACK_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;
const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const STATIC_COMPRESSION_MIN_BYTES = 1_024;
const STATIC_COMPRESSION_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const STATIC_COMPRESSION_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const STATIC_COMPRESSION_CACHE_MAX_ENTRIES = 64;
const STATIC_IMMUTABLE_ASSET_PATTERN = /(?:^|\/)[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/u;
const STATIC_COMPRESSIBLE_CONTENT_TYPE_PATTERN =
  /^(?:text\/|application\/(?:javascript|json|wasm|xml)|image\/svg\+xml)/u;

type StaticContentEncoding = "br" | "gzip";

interface StaticCompressionCacheEntry {
  readonly data: Uint8Array;
  readonly size: number;
}

const staticCompressionCache = new Map<string, StaticCompressionCacheEntry>();
const pendingStaticCompressions = new Map<string, Promise<Uint8Array | null>>();
let staticCompressionCacheBytes = 0;

function acceptedStaticContentEncoding(value: string | undefined): StaticContentEncoding | null {
  if (!value) return null;
  const qualities = new Map<string, number>();
  for (const part of value.toLowerCase().split(",")) {
    const [nameRaw, ...parameters] = part.trim().split(";");
    const name = nameRaw?.trim();
    if (!name) continue;
    const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith("q="));
    const parsedQuality = qualityParameter
      ? Number.parseFloat(qualityParameter.trim().slice(2))
      : 1;
    qualities.set(name, Number.isFinite(parsedQuality) ? parsedQuality : 0);
  }
  const wildcardQuality = qualities.get("*") ?? 0;
  const brotliQuality = qualities.get("br") ?? wildcardQuality;
  const gzipQuality = qualities.get("gzip") ?? wildcardQuality;
  if (brotliQuality <= 0 && gzipQuality <= 0) return null;
  return brotliQuality >= gzipQuality ? "br" : "gzip";
}

function compressStaticData(
  data: Uint8Array,
  encoding: StaticContentEncoding,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, compressed: Buffer) => {
      if (error) {
        reject(error);
      } else {
        resolve(compressed);
      }
    };
    if (encoding === "br") {
      brotliCompress(
        data,
        {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: data.byteLength,
          },
        },
        callback,
      );
    } else {
      gzip(data, { level: 6 }, callback);
    }
  });
}

function cacheStaticCompression(key: string, data: Uint8Array): void {
  const existing = staticCompressionCache.get(key);
  if (existing) {
    staticCompressionCacheBytes -= existing.size;
    staticCompressionCache.delete(key);
  }
  staticCompressionCache.set(key, { data, size: data.byteLength });
  staticCompressionCacheBytes += data.byteLength;
  while (
    staticCompressionCache.size > STATIC_COMPRESSION_CACHE_MAX_ENTRIES ||
    staticCompressionCacheBytes > STATIC_COMPRESSION_CACHE_MAX_BYTES
  ) {
    const oldestKey = staticCompressionCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = staticCompressionCache.get(oldestKey);
    staticCompressionCache.delete(oldestKey);
    staticCompressionCacheBytes -= oldest?.size ?? 0;
  }
}

async function getCompressedStaticData(
  key: string,
  data: Uint8Array,
  encoding: StaticContentEncoding,
): Promise<Uint8Array | null> {
  const cached = staticCompressionCache.get(key);
  if (cached) {
    staticCompressionCache.delete(key);
    staticCompressionCache.set(key, cached);
    return cached.data;
  }
  const pending = pendingStaticCompressions.get(key);
  if (pending) return pending;
  const compression = compressStaticData(data, encoding)
    .then((compressed) => {
      if (compressed.byteLength >= data.byteLength) return null;
      cacheStaticCompression(key, compressed);
      return compressed;
    })
    .finally(() => pendingStaticCompressions.delete(key));
  pendingStaticCompressions.set(key, compression);
  return compression;
}

function staticCacheControl(filePath: string): string {
  if (filePath.endsWith("index.html")) return "no-cache";
  if (STATIC_IMMUTABLE_ASSET_PATTERN.test(filePath)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

export const browserApiCorsLayer = HttpRouter.cors({
  allowedMethods: [...browserApiCorsAllowedMethods],
  allowedHeaders: [...browserApiCorsAllowedHeaders],
  maxAge: 600,
});

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const requireAuthenticatedRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  yield* serverAuth.authenticateHttpRequest(request);
});

const serverEnvironmentRouteHandler = Effect.gen(function* () {
  const descriptor = yield* Effect.service(ServerEnvironment).pipe(
    Effect.flatMap((serverEnvironment) => serverEnvironment.getDescriptor),
  );
  return HttpServerResponse.jsonUnsafe(descriptor, {
    status: 200,
    headers: browserApiCorsHeaders,
  });
});

export const serverEnvironmentRouteLayer = HttpRouter.add(
  "GET",
  "/.well-known/threadlines/environment",
  serverEnvironmentRouteHandler,
);

export const legacyServerEnvironmentRouteLayer = HttpRouter.add(
  "GET",
  "/.well-known/t3/environment",
  serverEnvironmentRouteHandler,
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.text("Trace export failed.", { status: 502 })),
        ),
      );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const attachmentsRouteLayer = HttpRouter.add(
  "GET",
  `${ATTACHMENTS_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    const rawRelativePath = url.value.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
    const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
    if (!normalizedRelativePath) {
      return HttpServerResponse.text("Invalid attachment path", { status: 400 });
    }

    const isIdLookup =
      !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
    const filePath = isIdLookup
      ? resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: normalizedRelativePath,
        })
      : resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: normalizedRelativePath,
        });
    if (!filePath) {
      return HttpServerResponse.text(isIdLookup ? "Not Found" : "Invalid attachment path", {
        status: isIdLookup ? 404 : 400,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const projectFaviconRouteLayer = HttpRouter.add(
  "GET",
  "/api/project-favicon",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const projectCwd = url.value.searchParams.get("cwd");
    if (!projectCwd) {
      return HttpServerResponse.text("Missing cwd parameter", { status: 400 });
    }

    const faviconResolver = yield* ProjectFaviconResolver;
    const faviconFilePath = yield* faviconResolver.resolvePath(projectCwd);
    if (!faviconFilePath) {
      return HttpServerResponse.text(FALLBACK_PROJECT_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: {
          "Cache-Control": PROJECT_FAVICON_FALLBACK_CACHE_CONTROL,
        },
      });
    }

    return yield* HttpServerResponse.file(faviconFilePath, {
      status: 200,
      headers: {
        "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const pluginIconRouteLayer = HttpRouter.add(
  "GET",
  "/api/plugin-icon",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const filePath = url.value.searchParams.get("path");
    const path = yield* Path.Path;
    if (
      !filePath ||
      !path.isAbsolute(filePath) ||
      !isCurrentProviderExtensionPluginIconPath(filePath)
    ) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = IMAGE_MIME_TYPE_BY_EXTENSION[extension];
    if (!SAFE_IMAGE_FILE_EXTENSIONS.has(extension) || !contentType) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.option);
    if (Option.isNone(fileInfo) || fileInfo.value.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
      },
    }).pipe(
      Effect.catch(() => Effect.succeed(HttpServerResponse.text("Not Found", { status: 404 }))),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir = config.staticDir ?? (config.devUrl ? yield* resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: {
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem
      .readFile(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    const headers: Record<string, string> = {
      "Cache-Control": staticCacheControl(filePath),
      "X-Content-Type-Options": "nosniff",
    };
    let responseData = data;
    if (
      shouldEnableTransferCompression(config) &&
      data.byteLength >= STATIC_COMPRESSION_MIN_BYTES &&
      data.byteLength <= STATIC_COMPRESSION_MAX_SOURCE_BYTES &&
      STATIC_COMPRESSIBLE_CONTENT_TYPE_PATTERN.test(contentType)
    ) {
      const encoding = acceptedStaticContentEncoding(request.headers["accept-encoding"]);
      if (encoding) {
        const modifiedAt = Option.match(fileInfo.mtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        });
        const compressed = yield* Effect.tryPromise(() =>
          getCompressedStaticData(
            `${filePath}:${Number(fileInfo.size)}:${modifiedAt}:${encoding}`,
            data,
            encoding,
          ),
        ).pipe(Effect.catch(() => Effect.succeed(null)));
        if (compressed) {
          responseData = compressed;
          headers["Content-Encoding"] = encoding;
          headers.Vary = "Accept-Encoding";
        }
      }
    }

    return HttpServerResponse.uint8Array(responseData, {
      status: 200,
      contentType,
      headers,
    });
  }),
);
