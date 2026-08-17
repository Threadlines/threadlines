import { assert, it } from "@effect/vitest";

import { CODEX_APP_SERVER_ARGS } from "./codexAppServerArgs.ts";

it("suppresses the warning for Threadlines' intentional unstable Codex features", () => {
  assert.deepStrictEqual(CODEX_APP_SERVER_ARGS, [
    "app-server",
    "-c",
    "features.default_mode_request_user_input=true",
    "-c",
    "features.apply_patch_streaming_events=true",
    "-c",
    "suppress_unstable_features_warning=true",
  ]);
});
