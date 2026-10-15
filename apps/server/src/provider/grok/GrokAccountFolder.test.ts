// @effect-diagnostics nodeBuiltinImport:off
import * as os from "node:os";
import * as path from "node:path";
import { lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { grokContinuationKey, materializeGrokAccountFolder } from "./GrokAccountFolder.ts";

it.live(
  "lays an account over the main Grok folder: shared setup and sessions, its own sign-in",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "grok-account-")));
      const mainHome = path.join(root, "main");
      const account = path.join(root, "work");
      yield* Effect.promise(async () => {
        await mkdir(path.join(mainHome, "sessions"), { recursive: true });
        await writeFile(path.join(mainHome, "config.toml"), "[cli]\n");
        await writeFile(path.join(mainHome, "auth.json"), "{}");
      });

      const result = yield* materializeGrokAccountFolder({
        mainDir: mainHome,
        accountDir: account,
      });

      expect(result.sharesMainHistory).toBe(true);
      const sessions = yield* Effect.promise(() => realpath(path.join(account, "sessions")));
      expect(sessions).toBe(yield* Effect.promise(() => realpath(path.join(mainHome, "sessions"))));
      const config = yield* Effect.promise(() => lstat(path.join(account, "config.toml")));
      expect(config.isSymbolicLink() || config.nlink > 1).toBe(true);
      // The sign-in is the account's own: the main one is never linked in.
      const auth = yield* Effect.promise(() =>
        lstat(path.join(account, "auth.json")).then(
          () => "present",
          () => "absent",
        ),
      );
      expect(auth).toBe("absent");

      const environment = { GROK_HOME: mainHome };
      expect(grokContinuationKey(account, environment)).toBe(grokContinuationKey("", environment));
      const separate = path.join(root, "separate");
      yield* Effect.promise(() => mkdir(path.join(separate, "sessions"), { recursive: true }));
      expect(grokContinuationKey(separate, environment)).not.toBe(
        grokContinuationKey("", environment),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
