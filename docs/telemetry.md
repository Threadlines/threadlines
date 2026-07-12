# Telemetry

Threadlines can send anonymous usage analytics to PostHog when usage analytics
are enabled in Settings or with `THREADLINES_TELEMETRY_ENABLED=true`.

Usage analytics are on by default in official builds and can be disabled from
Settings.

## What We Collect

Threadlines sends product and reliability events such as:

- app/server startup heartbeat;
- provider session start, stop, and recovery;
- turn sent, steered, interrupted, and compact-requested events;
- selected model family and sanitized model slug for provider turns;
- provider session start kind, such as fresh starts, resumes, same-provider
  restarts, and provider switches;
- model reroute events with sanitized from/to model values and a categorized reason;
- failed turn and provider runtime error events with categorized failure reasons;
- explicit thread fork events with sanitized source/target model values and
  context counts;
- provider approval/request responses;
- thread rollback and delete events;
- basic counts such as project count, thread count, attachment count, and active session count.

Each event includes basic environment properties such as operating system, CPU
architecture, Threadlines version, and whether the runtime is the desktop app or
CLI/web server.

## What We Do Not Collect

Threadlines does not send:

- prompts or agent responses;
- code, diffs, file contents, file paths, or repository names;
- terminal input or terminal output;
- raw custom/private model names;
- raw provider error messages or stack traces;
- provider API keys, auth tokens, secrets, or environment variable values;
- Codex, Claude, GitHub, or other third-party account identifiers.

Threadlines does not add an IP address to the analytics payload. As with any
HTTPS request, the receiving service can see the source IP at the transport
layer. The Threadlines PostHog project is configured to discard client IP data
after any transient GeoIP enrichment or bot detection, so it is not stored with
events.

## Anonymous Identifier

When telemetry is enabled, Threadlines creates a random install identifier in
its local state directory and sends only a SHA-256 hash of that identifier as the
analytics `distinct_id`.

Deleting the Threadlines local state directory resets this identifier.

## Configuration

Official builds may include the public PostHog project token at build time so
that users do not need to configure analytics manually.

Environment variables:

- `THREADLINES_POSTHOG_KEY`: PostHog project token.
- `THREADLINES_POSTHOG_HOST`: PostHog host. Defaults to `https://us.i.posthog.com`.
- `THREADLINES_TELEMETRY_ENABLED`: optional process-level override for local
  development and testing. Set to `false` to disable telemetry for the process.
  Release builds also use `false` as a build-time kill switch and omit the
  bundled PostHog token; `true` permits bundling while the in-app opt-out remains
  authoritative at runtime.
- `THREADLINES_TELEMETRY_FLUSH_BATCH_SIZE`: optional batch size override.
- `THREADLINES_TELEMETRY_MAX_BUFFERED_EVENTS`: optional in-memory buffer limit.
