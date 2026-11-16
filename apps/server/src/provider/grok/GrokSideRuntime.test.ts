// @effect-diagnostics nodeBuiltinImport:off
import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { prepareGrokSideRuntime, sandboxRecordProblem } from "./GrokSideRuntime.ts";

/** A checkout outside the temp folders: this package's own source. */
const checkout = path.dirname(fileURLToPath(import.meta.url));

const signInFile = async (expiresInMs: number) => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "grok-side-signin-")));
  const file = path.join(dir, "auth.json");
  const write = (ms: number) =>
    writeFile(
      file,
      JSON.stringify({
        "https://auth.x.ai::client": {
          key: "access-token",
          auth_mode: "oidc",
          refresh_token: "refresh-token",
          expires_at: new Date(Date.now() + ms).toISOString(),
        },
      }),
    );
  await write(expiresInMs);
  return { file, write };
};

const prepare = (input: {
  readonly cwd?: string;
  readonly signInPath: string;
  readonly renewSignIn?: Effect.Effect<void>;
  readonly platform?: NodeJS.Platform;
}) =>
  prepareGrokSideRuntime({
    cwd: input.cwd ?? checkout,
    baseEnvironment: { PATH: process.env.PATH, GROK_AUTH_PATH: input.signInPath },
    command: "grok",
    billsByKey: false,
    signInPath: input.signInPath,
    renewSignIn: input.renewSignIn ?? Effect.void,
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
  });

// Grok answers on the side on macOS only (sideAnswerDrivers.ts).
describe.skipIf(process.platform !== "darwin")("Grok side runtime", () => {
  it("copies the sign-in without its refresh token into a home that goes with the scope", async () => {
    const signIn = await signInFile(6 * 60 * 60_000);
    let home = "";
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const side = yield* prepare({ signInPath: signIn.file });
          home = side.spawn.env?.GROK_HOME ?? "";
          const copied = yield* Effect.promise(() =>
            readFile(path.join(home, "auth.json"), "utf8"),
          );
          expect(copied).toContain("access-token");
          expect(copied).not.toContain("refresh-token");
          expect(side.spawn.env?.GROK_AUTH_PATH).toBeUndefined();
          expect(side.spawn.env?.TMPDIR).toBe(path.join(home, "tmp"));
        }),
      ),
    );
    expect(home).not.toBe("");
    await expect(stat(home)).rejects.toThrow();
  });

  it("renews a sign-in close to expiring first, and refuses one that stays short", async () => {
    const signIn = await signInFile(10 * 60_000);
    const renewed = await Effect.runPromise(
      Effect.scoped(
        prepare({
          signInPath: signIn.file,
          renewSignIn: Effect.promise(() => signIn.write(6 * 60 * 60_000)),
        }).pipe(Effect.as("started")),
      ),
    );
    expect(renewed).toBe("started");

    await signIn.write(10 * 60_000);
    const refused = await Effect.runPromise(
      Effect.scoped(prepare({ signInPath: signIn.file })).pipe(Effect.flip),
    );
    expect(refused.message).toContain("expires soon");
  });

  it("refuses where its sandbox would let it write the checkout, or doesn't exist", async () => {
    const signIn = await signInFile(6 * 60 * 60_000);
    const inTemp = await realpath(await mkdtemp(path.join(os.tmpdir(), "grok-side-checkout-")));
    const tempRefusal = await Effect.runPromise(
      Effect.scoped(prepare({ cwd: inTemp, signInPath: signIn.file })).pipe(Effect.flip),
    );
    expect(tempRefusal.message).toContain("overlaps");

    const homeRefusal = await Effect.runPromise(
      Effect.scoped(prepare({ cwd: os.homedir(), signInPath: signIn.file })).pipe(Effect.flip),
    );
    expect(homeRefusal.message).toContain("home folder");

    const windowsRefusal = await Effect.runPromise(
      Effect.scoped(prepare({ signInPath: signIn.file, platform: "win32" })).pipe(Effect.flip),
    );
    expect(windowsRefusal.message).toContain("macOS only");
    const linuxRefusal = await Effect.runPromise(
      Effect.scoped(prepare({ signInPath: signIn.file, platform: "linux" })).pipe(Effect.flip),
    );
    expect(linuxRefusal.message).toContain("macOS only");
  });

  it("trusts only Grok's record of an enforced read-only sandbox that can't write the checkout", async () => {
    const record = (event: Record<string, unknown>) => `${JSON.stringify(event)}\n`;
    const applied = (writable: ReadonlyArray<string>) =>
      record({
        event_type: "ProfileApplied",
        profile: "read-only",
        enforced: true,
        read_write_paths: writable,
      });
    const same = async (folder: string) => folder;

    expect(
      await sandboxRecordProblem(applied(["/tmp", "/home/me/.grok"]), "/work/repo", same),
    ).toBe(undefined);
    expect(await sandboxRecordProblem(undefined, "/work/repo", same)).toContain("no record");
    expect(
      await sandboxRecordProblem(
        record({ event_type: "ApplyFailed", profile: "read-only", enforced: false }),
        "/work/repo",
        same,
      ),
    ).toContain("could not be applied");
    // A writable folder inside the checkout, and one that holds it.
    expect(await sandboxRecordProblem(applied(["/work/repo/.tmp"]), "/work/repo", same)).toContain(
      "/work/repo/.tmp",
    );
    expect(await sandboxRecordProblem(applied(["/work"]), "/work/repo", same)).toContain("/work");
    // A folder whose name only starts with dots is still inside.
    expect(await sandboxRecordProblem(applied(["/tmp"]), "/tmp/..review", same)).toContain("/tmp");
  });
});
