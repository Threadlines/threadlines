import { EnvironmentId, ThreadId } from "@threadlines/contracts";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { DraftId } from "./composerDraftStore";
import { removeLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";
import {
  LAST_VISITED_THREAD_ROUTE_STORAGE_KEY,
  readLastVisitedThreadRoute,
  recordLastVisitedThreadRoute,
  resolveRestorableThreadRoute,
} from "./lastVisitedThreadRoute";

const LOCAL = EnvironmentId.make("environment-local");
const REMOTE = EnvironmentId.make("environment-remote");
const THREAD = ThreadId.make("thread-1");
const DRAFT = "draft-1" as DraftId;

describe("lastVisitedThreadRoute", () => {
  beforeEach(() => {
    removeLocalStorageItem(LAST_VISITED_THREAD_ROUTE_STORAGE_KEY);
  });

  it("remembers the thread each environment had open, separately", () => {
    expect(readLastVisitedThreadRoute(LOCAL)).toBeNull();

    recordLastVisitedThreadRoute(LOCAL, {
      kind: "server",
      threadRef: { environmentId: LOCAL, threadId: THREAD },
    });
    recordLastVisitedThreadRoute(REMOTE, { kind: "draft", draftId: DRAFT });

    expect(readLastVisitedThreadRoute(LOCAL)).toEqual({ kind: "server", threadId: THREAD });
    expect(readLastVisitedThreadRoute(REMOTE)).toEqual({ kind: "draft", draftId: DRAFT });
  });

  it("restores a thread that is still there, on the environment that recorded it", () => {
    const entry = { kind: "server", threadId: String(THREAD) } as const;

    expect(
      resolveRestorableThreadRoute({
        entry,
        environmentId: LOCAL,
        serverThreadExists: true,
        draftThreadExists: false,
      }),
    ).toEqual({ kind: "server", threadRef: { environmentId: LOCAL, threadId: THREAD } });

    expect(
      resolveRestorableThreadRoute({
        entry: { kind: "draft", draftId: String(DRAFT) },
        environmentId: LOCAL,
        serverThreadExists: false,
        draftThreadExists: true,
      }),
    ).toEqual({ kind: "draft", draftId: DRAFT });
  });

  it("falls back to the old behaviour when the recorded route is gone", () => {
    // A thread deleted from another device, a draft that never came back out
    // of storage, or nothing recorded at all: each has to leave the caller on
    // its default (start a draft / show the no-thread shell) rather than
    // route into a dead page.
    expect(
      resolveRestorableThreadRoute({
        entry: { kind: "server", threadId: String(THREAD) },
        environmentId: LOCAL,
        serverThreadExists: false,
        draftThreadExists: true,
      }),
    ).toBeNull();

    expect(
      resolveRestorableThreadRoute({
        entry: { kind: "draft", draftId: String(DRAFT) },
        environmentId: LOCAL,
        serverThreadExists: true,
        draftThreadExists: false,
      }),
    ).toBeNull();

    expect(
      resolveRestorableThreadRoute({
        entry: null,
        environmentId: LOCAL,
        serverThreadExists: true,
        draftThreadExists: true,
      }),
    ).toBeNull();

    // No environment yet means nothing to scope the record to.
    expect(
      resolveRestorableThreadRoute({
        entry: { kind: "server", threadId: String(THREAD) },
        environmentId: null,
        serverThreadExists: true,
        draftThreadExists: true,
      }),
    ).toBeNull();
  });

  it("ignores a record it cannot make sense of instead of throwing at startup", () => {
    // A record left by a build with a different shape has to read as "nothing
    // remembered": this runs on the load path, so a throw here is a blank app.
    setLocalStorageItem(
      LAST_VISITED_THREAD_ROUTE_STORAGE_KEY,
      { byEnvironmentId: { [String(LOCAL)]: { kind: "somethingElse" } } },
      Schema.Struct({
        byEnvironmentId: Schema.Record(Schema.String, Schema.Struct({ kind: Schema.String })),
      }),
    );

    expect(readLastVisitedThreadRoute(LOCAL)).toBeNull();
  });
});
