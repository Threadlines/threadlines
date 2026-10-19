import * as Schema from "effect/Schema";

import { PortSchema, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  threadlinesHome: Schema.String,
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  /**
   * Non-secret identity for one desktop-spawned backend process. The server
   * echoes it in the `DESKTOP_LAUNCH_ID_HEADER` response header of the
   * public environment route so the desktop's readiness probe can tell its
   * own backend apart from an unrelated server answering on the same port.
   */
  desktopLaunchId: Schema.optional(TrimmedNonEmptyString),
  appVersion: Schema.optional(TrimmedNonEmptyString),
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  /**
   * The desktop already read PATH and the other shell variables from the
   * user's login shell (or PowerShell) before starting this backend, which
   * inherits them. The server then skips its own blocking probe at startup.
   */
  shellEnvironmentPrepared: Schema.optional(Schema.Boolean),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;

export const DESKTOP_LAUNCH_ID_HEADER = "x-threadlines-desktop-launch-id";

/**
 * Prefixes of the per-migration log lines the server writes while the database
 * schema is being updated. The desktop reads them out of the backend's captured
 * output to tell a slow migration apart from a hung process, so the server and
 * the desktop share these constants instead of matching on a literal that could
 * drift on one side only.
 *
 * Full line shapes:
 * - `Running migration 50_ProjectionTranscriptEventSequence (50 of 51)`
 * - `Finished migration 50_ProjectionTranscriptEventSequence in 8s 144ms`
 */
export const MIGRATION_RUNNING_LOG_PREFIX = "Running migration ";
export const MIGRATION_FINISHED_LOG_PREFIX = "Finished migration ";

/**
 * Exit code of a server that stopped because its database was made by another
 * app (its migration history names other steps), so it left the file alone.
 * The desktop reads the code rather than the error text, which a long trace can
 * push out of the captured output, to set such a copy aside and start fresh.
 */
export const FOREIGN_DATABASE_EXIT_CODE = 78;
