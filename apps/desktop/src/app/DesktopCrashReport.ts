/**
 * DesktopCrashReport - anonymous startup telemetry for the desktop shell.
 *
 * The server owns regular usage analytics, but two things about startup only
 * the shell knows: that the backend never booted (there is no server to say
 * so), and how long it took to answer, measured from the moment the shell
 * started it. The shell sends one sanitized event for each itself. It honors
 * the same consent as the server (`settings.json`
 * `usageAnalyticsEnabled`, `THREADLINES_TELEMETRY_ENABLED` override, silence
 * in throwaway runs), reuses
 * the same anonymous install id file, and never sends raw paths: everything
 * under the user's home directory is scrubbed to `~` before leaving the
 * machine.
 */

import { scrubUserPaths } from "@threadlines/shared/scrubUserPaths";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Crypto from "node:crypto";
import * as NodeOS from "node:os";

import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "@threadlines/contracts";
import { fromLenientJson } from "@threadlines/shared/schemaJson";
import {
  isThrowawayTelemetryRun,
  parseTelemetryEnabledOverride,
} from "@threadlines/shared/telemetryConsent";

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
const OUTPUT_TAIL_MAX_CHARS = 2_000;

// Values following credential-shaped labels are cut before anything leaves
// the machine. Boot-phase stderr should never contain these, but a config
// echo or connection string in a crash must not end up in telemetry.
const SECRET_PATTERN =
  /((?:key|token|secret|password|passwd|credential|bearer|authorization)[\w-]*\s*[=:]\s*)[^\s"']+/gi;

export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, "$1[redacted]");
}

export interface DesktopStartupFailureReport {
  readonly failureKind: "process-exit" | "readiness-timeout";
  readonly attempts: number;
  readonly lastExitCode: Option.Option<number>;
  readonly lastReason: string;
  /** Interleaved stdout+stderr tail; the server logs fatal causes on stdout. */
  readonly outputTail: string;
}

/** How a start that reached readiness went; see reportBackendStarted. */
export interface DesktopBackendStartedReport {
  /** From starting the backend process to its first healthy answer. */
  readonly startupMs: number;
  /** 1 when the first process made it; more when earlier ones died first. */
  readonly attempts: number;
  /** Whether it outlasted the readiness deadline and got the "still starting" notice. */
  readonly slowStart: boolean;
}

export interface DesktopCrashReportShape {
  /** Best-effort: resolves void on success and on any failure alike. */
  readonly reportStartupFailure: (report: DesktopStartupFailureReport) => Effect.Effect<void>;
  /**
   * How long the app's first start of the backend took. The readiness
   * deadline is a guess until this says what starts really cost in the field.
   * Best-effort, like reportStartupFailure.
   */
  readonly reportBackendStarted: (report: DesktopBackendStartedReport) => Effect.Effect<void>;
}

export class DesktopCrashReport extends Context.Service<
  DesktopCrashReport,
  DesktopCrashReportShape
>()("threadlines/desktop/CrashReport") {}

/** Keeps the end of the captured stderr, where the fatal error lands. */
export function truncateTail(text: string, maxChars: number = OUTPUT_TAIL_MAX_CHARS): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownOption(ServerSettingsJson);

/**
 * Mirrors the server's telemetry consent: `THREADLINES_TELEMETRY_ENABLED`
 * wins when set, a throwaway run (CI, or a data folder in the temp folder)
 * sends nothing, otherwise `usageAnalyticsEnabled` from settings.json decoded
 * with the same lenient JSONC parser the server uses, defaulting to enabled
 * when the file is absent or undecodable.
 */
export function resolveTelemetryConsent(input: {
  readonly envOverride: string | undefined;
  readonly throwawayRun: boolean;
  readonly rawSettingsJson: string | undefined;
}): boolean {
  const override = parseTelemetryEnabledOverride(input.envOverride);
  if (override !== undefined) return override;
  if (input.throwawayRun) return false;

  if (input.rawSettingsJson === undefined) {
    return DEFAULT_SERVER_SETTINGS.usageAnalyticsEnabled;
  }
  return Option.match(decodeServerSettingsJson(input.rawSettingsJson), {
    onNone: () => DEFAULT_SERVER_SETTINGS.usageAnalyticsEnabled,
    onSome: (settings) => settings.usageAnalyticsEnabled,
  });
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
  // to create it itself. Like the server, sending is skipped when the id
  // cannot be persisted: an unpersisted id would make every report look like
  // a fresh installation.
  const getIdentifier = Effect.gen(function* () {
    const existing = yield* fileSystem
      .readFileString(anonymousIdPath)
      .pipe(Effect.map(Option.some), Effect.orElseSucceed(Option.none<string>));
    if (Option.isSome(existing)) {
      return Option.some(hashIdentifier(existing.value));
    }
    const generated = Crypto.randomUUID();
    const persisted = yield* fileSystem.writeFileString(anonymousIdPath, generated).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    return persisted ? Option.some(hashIdentifier(generated)) : Option.none<string>();
  });

  /** Sends one event when telemetry is allowed and the install can be named. */
  const sendEvent = (event: string, properties: Record<string, unknown>) =>
    Effect.gen(function* () {
      // Same env overrides the server's AnalyticsService honors.
      const posthogKey = process.env.THREADLINES_POSTHOG_KEY?.trim() || bundledPosthogKey.trim();
      const posthogHost = process.env.THREADLINES_POSTHOG_HOST?.trim() || bundledPosthogHost;
      if (!posthogKey) return;

      const rawSettingsJson = yield* fileSystem
        .readFileString(environment.serverSettingsPath)
        .pipe(Effect.map(Option.some), Effect.orElseSucceed(Option.none<string>));
      const realPathOrSelf = (path: string) =>
        fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
      const tempDir = NodeOS.tmpdir();
      const consented = resolveTelemetryConsent({
        envOverride: process.env.THREADLINES_TELEMETRY_ENABLED,
        throwawayRun: isThrowawayTelemetryRun({
          baseDirs: [environment.baseDir, yield* realPathOrSelf(environment.baseDir)],
          tempDirs: [tempDir, yield* realPathOrSelf(tempDir)],
          ciEnv: process.env.CI,
        }),
        rawSettingsJson: Option.getOrUndefined(rawSettingsJson),
      });
      if (!consented) return;

      const identifier = yield* getIdentifier;
      if (Option.isNone(identifier)) return;
      const payload = {
        api_key: posthogKey,
        batch: [
          {
            event,
            distinct_id: identifier.value,
            properties: {
              $process_person_profile: false,
              platform: environment.platform,
              arch: environment.processArch,
              threadlinesVersion: environment.appVersion,
              clientType: "desktop-app",
              ...properties,
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
    });

  const scrub = (text: string) => redactSecrets(scrubUserPaths(text, environment.homeDirectory));

  const reportStartupFailure: DesktopCrashReportShape["reportStartupFailure"] = (report) =>
    sendEvent("desktop.backend.startup_failed", {
      failureKind: report.failureKind,
      attempts: report.attempts,
      exitCode: Option.getOrNull(report.lastExitCode),
      reason: scrub(report.lastReason),
      outputTail: scrub(truncateTail(report.outputTail)),
    }).pipe(
      Effect.catch((error) =>
        Effect.logDebug("startup failure crash report not sent", { cause: error }),
      ),
      Effect.withSpan("desktop.crashReport.reportStartupFailure"),
    );

  const reportBackendStarted: DesktopCrashReportShape["reportBackendStarted"] = (report) =>
    sendEvent("desktop.backend.started", {
      startupMs: Math.round(report.startupMs),
      attempts: report.attempts,
      slowStart: report.slowStart,
    }).pipe(
      Effect.catch((error) => Effect.logDebug("backend start report not sent", { cause: error })),
      Effect.withSpan("desktop.crashReport.reportBackendStarted"),
    );

  return DesktopCrashReport.of({ reportStartupFailure, reportBackendStarted });
});

export const layer = Layer.effect(DesktopCrashReport, makeDesktopCrashReport);

export { scrubUserPaths };
