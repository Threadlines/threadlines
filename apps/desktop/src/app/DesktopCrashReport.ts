/**
 * DesktopCrashReport - anonymous startup-failure telemetry for the desktop
 * shell.
 *
 * The server owns regular usage analytics, but when the backend never boots
 * there is no server to report anything — so the shell sends one sanitized
 * event itself. It honors the same consent as the server (`settings.json`
 * `usageAnalyticsEnabled`, `THREADLINES_TELEMETRY_ENABLED` override), reuses
 * the same anonymous install id file, and never sends raw paths: everything
 * under the user's home directory is scrubbed to `~` before leaving the
 * machine.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as Crypto from "node:crypto";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

declare const __THREADLINES_BUNDLED_POSTHOG_KEY__: string | undefined;
declare const __THREADLINES_BUNDLED_POSTHOG_HOST__: string | undefined;

const bundledPosthogKey =
  typeof __THREADLINES_BUNDLED_POSTHOG_KEY__ === "string"
    ? __THREADLINES_BUNDLED_POSTHOG_KEY__
    : "";

const bundledPosthogHost =
  typeof __THREADLINES_BUNDLED_POSTHOG_HOST__ === "string"
    ? __THREADLINES_BUNDLED_POSTHOG_HOST__
    : "https://us.i.posthog.com";

const ANONYMOUS_ID_FILE_NAME = "anonymous-id";
const STDERR_TAIL_MAX_CHARS = 4_000;

export interface DesktopStartupFailureReport {
  readonly failureKind: "process-exit" | "readiness-timeout";
  readonly attempts: number;
  readonly lastExitCode: Option.Option<number>;
  readonly lastReason: string;
  readonly stderrTail: string;
}

export interface DesktopCrashReportShape {
  /** Best-effort: resolves void on success and on any failure alike. */
  readonly reportStartupFailure: (report: DesktopStartupFailureReport) => Effect.Effect<void>;
}

export class DesktopCrashReport extends Context.Service<
  DesktopCrashReport,
  DesktopCrashReportShape
>()("threadlines/desktop/CrashReport") {}

/**
 * Replaces every occurrence of the user's home directory (either separator
 * style, any casing) with `~` so crash reports carry no usernames or absolute
 * personal paths.
 */
export function scrubUserPaths(text: string, homeDirectory: string): string {
  if (homeDirectory.length === 0) {
    return text;
  }
  const variants = new Set([
    homeDirectory,
    homeDirectory.replaceAll("\\", "/"),
    homeDirectory.replaceAll("/", "\\"),
  ]);
  let scrubbed = text;
  for (const variant of variants) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    scrubbed = scrubbed.replace(new RegExp(escaped, "gi"), "~");
  }
  return scrubbed;
}

/** Keeps the end of the captured stderr, where the fatal error lands. */
export function truncateTail(text: string, maxChars: number = STDERR_TAIL_MAX_CHARS): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/**
 * Mirrors the server's telemetry consent: `THREADLINES_TELEMETRY_ENABLED`
 * wins when set, otherwise `usageAnalyticsEnabled` from settings.json,
 * defaulting to enabled when the file is absent or unreadable.
 */
export function resolveTelemetryConsent(input: {
  readonly envOverride: string | undefined;
  readonly rawSettingsJson: string | undefined;
}): boolean {
  const override = input.envOverride?.trim().toLowerCase();
  if (override === "false") return false;
  if (override === "true") return true;

  if (input.rawSettingsJson === undefined) {
    return true;
  }
  try {
    const parsed: unknown = JSON.parse(input.rawSettingsJson);
    if (typeof parsed === "object" && parsed !== null && "usageAnalyticsEnabled" in parsed) {
      return (parsed as { usageAnalyticsEnabled?: unknown }).usageAnalyticsEnabled !== false;
    }
  } catch {
    // Unreadable settings keep the default.
  }
  return true;
}

const hashIdentifier = (value: string): string =>
  Crypto.createHash("sha256").update(value).digest("hex");

const makeDesktopCrashReport = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const anonymousIdPath = environment.path.join(environment.stateDir, ANONYMOUS_ID_FILE_NAME);

  // Same file the server uses, so the crash report and later usage telemetry
  // count as one install. Created here when the backend never got far enough
  // to create it itself.
  const getIdentifier = Effect.gen(function* () {
    const existing = yield* fileSystem
      .readFileString(anonymousIdPath)
      .pipe(Effect.map(Option.some), Effect.orElseSucceed(Option.none<string>));
    if (Option.isSome(existing)) {
      return hashIdentifier(existing.value);
    }
    const generated = Crypto.randomUUID();
    yield* fileSystem.writeFileString(anonymousIdPath, generated).pipe(Effect.ignore);
    return hashIdentifier(generated);
  });

  const reportStartupFailure: DesktopCrashReportShape["reportStartupFailure"] = (report) =>
    Effect.gen(function* () {
      // Same env overrides the server's AnalyticsService honors.
      const posthogKey = process.env.THREADLINES_POSTHOG_KEY?.trim() || bundledPosthogKey.trim();
      const posthogHost = process.env.THREADLINES_POSTHOG_HOST?.trim() || bundledPosthogHost;
      if (!posthogKey) return;

      const rawSettingsJson = yield* fileSystem
        .readFileString(environment.serverSettingsPath)
        .pipe(Effect.map(Option.some), Effect.orElseSucceed(Option.none<string>));
      const consented = resolveTelemetryConsent({
        envOverride: process.env.THREADLINES_TELEMETRY_ENABLED,
        rawSettingsJson: Option.getOrUndefined(rawSettingsJson),
      });
      if (!consented) return;

      const identifier = yield* getIdentifier;
      const scrub = (text: string) => scrubUserPaths(text, environment.homeDirectory);
      const payload = {
        api_key: posthogKey,
        batch: [
          {
            event: "desktop.backend.startup_failed",
            distinct_id: identifier,
            properties: {
              $process_person_profile: false,
              platform: environment.platform,
              arch: environment.processArch,
              threadlinesVersion: environment.appVersion,
              clientType: "desktop-app",
              failureKind: report.failureKind,
              attempts: report.attempts,
              exitCode: Option.getOrNull(report.lastExitCode),
              reason: scrub(report.lastReason),
              stderrTail: scrub(truncateTail(report.stderrTail)),
            },
            timestamp: new Date().toISOString(),
          },
        ],
      };

      yield* HttpClientRequest.post(`${posthogHost}/batch/`).pipe(
        HttpClientRequest.bodyJson(payload),
        Effect.flatMap(httpClient.execute),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.asVoid,
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.logDebug("startup failure crash report not sent", { cause: error }),
      ),
      Effect.withSpan("desktop.crashReport.reportStartupFailure"),
    );

  return DesktopCrashReport.of({ reportStartupFailure });
});

export const layer = Layer.effect(DesktopCrashReport, makeDesktopCrashReport);
