/**
 * Shared argv for spawning `codex app-server`.
 *
 * `default_mode_request_user_input` is an upstream feature flag (off by
 * default) that exposes the `request_user_input` tool outside Plan mode, so
 * Codex can ask structured questions during build turns. It is passed as a
 * `-c` config override rather than `--enable` so codex versions that do not
 * know the feature ignore it instead of failing to start.
 *
 * Threadlines opts into this feature deliberately, so suppress the generic
 * unstable-feature warning Codex otherwise emits when each thread starts.
 */
export const CODEX_APP_SERVER_ARGS: ReadonlyArray<string> = [
  "app-server",
  "-c",
  "features.default_mode_request_user_input=true",
  "-c",
  "suppress_unstable_features_warning=true",
];
