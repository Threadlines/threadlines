import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { runDictationWorker } from "../dictation/worker.ts";

/**
 * Internal entry point the server forks for speech-to-text. Routing it through
 * the CLI means the same path (`process.argv[1]`) works in dev, npm and
 * desktop builds. The worker exits itself when the parent disconnects, so the
 * handler simply never completes.
 */
export const dictationWorkerCommand = Command.make("dictation-worker").pipe(
  Command.withDescription("Internal: run the local speech-to-text worker process."),
  Command.withHandler(() => Effect.sync(runDictationWorker).pipe(Effect.andThen(Effect.never))),
);
