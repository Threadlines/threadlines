import { assert, describe, it } from "@effect/vitest";
import type { DesktopMenuActionPayload } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import {
  desktopThreadLinkChannel,
  DesktopThreadLinks,
  layer,
  makeThreadLinkInbox,
  threadLinkFromCandidates,
  threadLinkRegistration,
} from "./DesktopThreadLinks.ts";

const ENV = "6f1c2a7e-0b4d-4c55-9a3e-2d8f1b7c9e10";
const THREAD = "0b9e1d7a-3c2f-4e8b-a1d5-7f6c4b2e9a31";

describe("threadLinkFromCandidates", () => {
  it("opens only an exact link for this build's channel", () => {
    const opens = (candidate: string, channel: "latest" | "nightly" | "dev" = "latest") =>
      threadLinkFromCandidates([candidate], channel);

    assert.deepStrictEqual(opens(`threadlines://open/${ENV}/${THREAD}`), {
      environmentId: ENV,
      threadId: THREAD,
    });
    // Windows and some browsers add a trailing slash; schemes ignore case.
    assert.isNotNull(opens(`threadlines://open/${ENV}/${THREAD}/`));
    assert.isNotNull(opens(`Threadlines://OPEN/${ENV}/${THREAD}`));
    assert.isNotNull(opens(`threadlines-nightly://open/${ENV}/${THREAD}`, "nightly"));
    assert.isNotNull(opens(`threadlines-dev://open/${ENV}/${THREAD}`, "dev"));
    // Ids keep their case and may use dots, dashes and underscores.
    assert.deepStrictEqual(opens("threadlines://open/Env_1.a/T-2"), {
      environmentId: "Env_1.a",
      threadId: "T-2",
    });

    for (const ignored of [
      // Another channel's link.
      `threadlines-nightly://open/${ENV}/${THREAD}`,
      `threadlines-dev://open/${ENV}/${THREAD}`,
      // Not this scheme at all.
      `https://app.threadlines.dev/${ENV}/${THREAD}`,
      `threadlines:open/${ENV}/${THREAD}`,
      // Another action, or the wrong number of parts.
      `threadlines://settings/${ENV}/${THREAD}`,
      `threadlines://open/${ENV}`,
      `threadlines://open/${ENV}/${THREAD}/extra`,
      `threadlines://open//${THREAD}`,
      // Anything a link never carries.
      `threadlines://open/${ENV}/${THREAD}?next=https://evil.example`,
      `threadlines://open/${ENV}/${THREAD}#top`,
      `threadlines://open/${ENV}/..%2F..%2Fetc`,
      `threadlines://open/${ENV}/.hidden`,
      `threadlines://open/${ENV}/-flag`,
      `threadlines://open/${ENV}/a b`,
      `threadlines://open/${ENV}/${"a".repeat(129)}`,
    ]) {
      assert.isNull(opens(ignored), ignored);
    }
    assert.isNotNull(opens(`threadlines://open/${ENV}/${"a".repeat(128)}`));
  });

  it("finds the link among a launch's arguments", () => {
    assert.deepStrictEqual(
      threadLinkFromCandidates(
        [
          "C:\\Program Files\\Threadlines\\Threadlines.exe",
          "--allow-file-access-from-files",
          `threadlines://open/${ENV}/${THREAD}`,
        ],
        "latest",
      ),
      { environmentId: ENV, threadId: THREAD },
    );
    assert.isNull(threadLinkFromCandidates(["/usr/bin/threadlines", "--no-sandbox"], "latest"));
  });
});

describe("desktopThreadLinkChannel", () => {
  it("answers each channel's own scheme", () => {
    assert.equal(desktopThreadLinkChannel({ isDevelopment: false, appVersion: "0.9.0" }), "latest");
    assert.equal(
      desktopThreadLinkChannel({ isDevelopment: false, appVersion: "0.9.0-nightly.20261102.4" }),
      "nightly",
    );
    assert.equal(desktopThreadLinkChannel({ isDevelopment: true, appVersion: "0.9.0" }), "dev");
  });
});

describe("threadLinkRegistration", () => {
  const base = {
    execPath: "C:\\repo\\node_modules\\electron\\dist\\electron.exe",
    entryScriptPath: "C:\\repo\\apps\\desktop\\dist-electron\\main.cjs",
    isAppImage: false,
  };

  it("claims the scheme the way each kind of run is started", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      assert.deepStrictEqual(
        threadLinkRegistration({ ...base, platform, isPackaged: true, isDevelopment: false }),
        { kind: "register" },
      );
    }
    // Linux finds a link's app by its desktop entry, which only the .deb installs.
    assert.equal(
      threadLinkRegistration({
        ...base,
        platform: "linux",
        isPackaged: true,
        isDevelopment: false,
        isAppImage: true,
      }).kind,
      "skip",
    );
    // On Windows an unpackaged run is Electron plus its entry script; elsewhere
    // nothing of its own declares the scheme.
    assert.deepStrictEqual(
      threadLinkRegistration({
        ...base,
        platform: "win32",
        isPackaged: false,
        isDevelopment: false,
      }),
      { kind: "register", launch: { path: base.execPath, args: [base.entryScriptPath] } },
    );
    for (const platform of ["darwin", "linux"] as const) {
      assert.equal(
        threadLinkRegistration({ ...base, platform, isPackaged: false, isDevelopment: false }).kind,
        "skip",
      );
    }
    // macOS hands links to the running dev app; Windows and Linux would start another.
    assert.deepStrictEqual(
      threadLinkRegistration({
        ...base,
        platform: "darwin",
        isPackaged: false,
        isDevelopment: true,
      }),
      { kind: "register" },
    );
    for (const platform of ["win32", "linux"] as const) {
      assert.equal(
        threadLinkRegistration({ ...base, platform, isPackaged: false, isDevelopment: true }).kind,
        "skip",
      );
    }
  });
});

describe("DesktopThreadLinks", () => {
  it.effect("opens a link that arrived during startup once started, and ignores others", () =>
    Effect.gen(function* () {
      const dispatched: Array<{ action: string; payload?: DesktopMenuActionPayload }> = [];
      const claimed: Array<{ scheme: string; launch: unknown }> = [];
      const inbox = makeThreadLinkInbox();
      const dispatchMenuAction: DesktopWindow.DesktopWindowShape["dispatchMenuAction"] = (
        action,
        payload,
      ) =>
        Effect.sync(() => {
          dispatched.push(payload === undefined ? { action } : { action, payload });
        });
      const services = Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          isDevelopment: false,
          isPackaged: true,
          platform: "linux",
          appVersion: "0.9.0-nightly.20261102.4",
        } as DesktopEnvironment.DesktopEnvironmentShape),
        Layer.succeed(ElectronApp.ElectronApp, {
          setAsDefaultProtocolClient: (scheme, launch) =>
            Effect.sync(() => {
              claimed.push({ scheme, launch });
              return true;
            }),
        } as ElectronApp.ElectronAppShape),
        Layer.succeed(DesktopWindow.DesktopWindow, {
          dispatchMenuAction,
        } as DesktopWindow.DesktopWindowShape),
      );

      yield* Effect.gen(function* () {
        const threadLinks = yield* DesktopThreadLinks;
        // The first launch's arguments, before the window can open.
        inbox.receive(["/opt/Threadlines/threadlines", `threadlines-nightly://open/${ENV}/a`]);
        yield* threadLinks.receive([`threadlines://open/${ENV}/stable-link`]);
        assert.deepStrictEqual(dispatched, []);

        yield* threadLinks.start;
        // A second launch, once running.
        yield* threadLinks.receive(["/opt/Threadlines/threadlines", "--no-sandbox"]);
        yield* threadLinks.receive([`threadlines-nightly://open/${ENV}/b`]);
        yield* Effect.yieldNow;

        assert.deepStrictEqual(claimed, [{ scheme: "threadlines-nightly", launch: undefined }]);
        assert.deepStrictEqual(dispatched, [
          { action: "open-thread", payload: { environmentId: ENV, threadId: "a" } },
          { action: "open-thread", payload: { environmentId: ENV, threadId: "b" } },
        ]);
      }).pipe(
        Effect.provide(
          layer({
            inbox,
            execPath: "/opt/Threadlines/threadlines",
            entryScriptPath: undefined,
            isAppImage: false,
          }).pipe(Layer.provide(services)),
        ),
      );
    }),
  );
});
