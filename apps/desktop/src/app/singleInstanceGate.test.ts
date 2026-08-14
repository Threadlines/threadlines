import { assert, describe, it } from "@effect/vitest";

import {
  readSingleInstanceGateConfigFromEnv,
  resolvePrimaryReadinessProbeUrl,
  resolveServerRuntimeStatePath,
  shouldRequestSingleInstanceLock,
} from "./singleInstanceGate.ts";

const gateFor = (env: Record<string, string | undefined>): boolean =>
  shouldRequestSingleInstanceLock(readSingleInstanceGateConfigFromEnv(env));

describe("readSingleInstanceGateConfigFromEnv", () => {
  it("only treats a parsable dev-server URL as development", () => {
    assert.equal(readSingleInstanceGateConfigFromEnv({}).isDevelopment, false);
    assert.equal(
      readSingleInstanceGateConfigFromEnv({ VITE_DEV_SERVER_URL: "   " }).isDevelopment,
      false,
    );
    assert.equal(
      readSingleInstanceGateConfigFromEnv({ VITE_DEV_SERVER_URL: "not a url" }).isDevelopment,
      false,
    );
    assert.equal(
      readSingleInstanceGateConfigFromEnv({ VITE_DEV_SERVER_URL: "http://localhost:5173" })
        .isDevelopment,
      true,
    );
  });

  it("accepts only affirmative kill-switch values", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " on "]) {
      assert.equal(
        readSingleInstanceGateConfigFromEnv({
          THREADLINES_DISABLE_SINGLE_INSTANCE_LOCK: value,
        }).disabledByEnv,
        true,
        `expected ${JSON.stringify(value)} to disable the lock`,
      );
    }
    for (const value of ["0", "false", "no", "off", "", "  ", "maybe"]) {
      assert.equal(
        readSingleInstanceGateConfigFromEnv({
          THREADLINES_DISABLE_SINGLE_INSTANCE_LOCK: value,
        }).disabledByEnv,
        false,
        `expected ${JSON.stringify(value)} to leave the lock enabled`,
      );
    }
  });

  it("follows the THREADLINES → BADCODE → T3CODE alias order", () => {
    assert.equal(
      readSingleInstanceGateConfigFromEnv({
        THREADLINES_DISABLE_SINGLE_INSTANCE_LOCK: "0",
        BADCODE_DISABLE_SINGLE_INSTANCE_LOCK: "1",
      }).disabledByEnv,
      false,
    );
    assert.equal(
      readSingleInstanceGateConfigFromEnv({
        BADCODE_DISABLE_SINGLE_INSTANCE_LOCK: "1",
        T3CODE_DISABLE_SINGLE_INSTANCE_LOCK: "0",
      }).disabledByEnv,
      true,
    );
    assert.equal(
      readSingleInstanceGateConfigFromEnv({
        T3CODE_DISABLE_SINGLE_INSTANCE_LOCK: "yes",
      }).disabledByEnv,
      true,
    );
  });
});

describe("shouldRequestSingleInstanceLock", () => {
  it("locks release launches and leaves development launches alone", () => {
    assert.equal(gateFor({}), true);
    assert.equal(gateFor({ VITE_DEV_SERVER_URL: "http://localhost:5173" }), false);
  });

  it("stays off when the kill switch is set, in either lane", () => {
    assert.equal(gateFor({ THREADLINES_DISABLE_SINGLE_INSTANCE_LOCK: "1" }), false);
    assert.equal(
      gateFor({
        VITE_DEV_SERVER_URL: "http://localhost:5173",
        THREADLINES_DISABLE_SINGLE_INSTANCE_LOCK: "1",
      }),
      false,
    );
  });
});

describe("resolveServerRuntimeStatePath", () => {
  const posixPath = { join: (...segments: ReadonlyArray<string>) => segments.join("/") };

  it("defaults to the release state directory under the home directory", () => {
    assert.equal(
      resolveServerRuntimeStatePath({ env: {}, homeDirectory: "/home/will", path: posixPath }),
      "/home/will/.threadlines/userdata/server-runtime.json",
    );
  });

  it("follows THREADLINES_HOME and the dev lane", () => {
    assert.equal(
      resolveServerRuntimeStatePath({
        env: { THREADLINES_HOME: "/tmp/tl-home" },
        homeDirectory: "/home/will",
        path: posixPath,
      }),
      "/tmp/tl-home/userdata/server-runtime.json",
    );
    assert.equal(
      resolveServerRuntimeStatePath({
        env: { VITE_DEV_SERVER_URL: "http://localhost:5173" },
        homeDirectory: "/home/will",
        path: posixPath,
      }),
      "/home/will/.threadlines/dev/server-runtime.json",
    );
  });
});

describe("resolvePrimaryReadinessProbeUrl", () => {
  const validState = JSON.stringify({
    version: 1,
    pid: 1234,
    port: 3774,
    origin: "http://127.0.0.1:3774",
    startedAt: "2026-08-14T00:00:00.000Z",
  });

  it("builds the readiness URL from a valid runtime-state file", () => {
    assert.equal(
      resolvePrimaryReadinessProbeUrl(validState),
      "http://127.0.0.1:3774/.well-known/threadlines/environment",
    );
  });

  it("rejects a missing, malformed, or untrusted state file", () => {
    assert.equal(resolvePrimaryReadinessProbeUrl(undefined), undefined);
    assert.equal(resolvePrimaryReadinessProbeUrl(""), undefined);
    assert.equal(resolvePrimaryReadinessProbeUrl("not json"), undefined);
    assert.equal(resolvePrimaryReadinessProbeUrl('"just a string"'), undefined);
    assert.equal(
      resolvePrimaryReadinessProbeUrl(JSON.stringify({ version: 2, origin: "http://x:1" })),
      undefined,
      "an unknown schema version must not be probed",
    );
    assert.equal(
      resolvePrimaryReadinessProbeUrl(JSON.stringify({ version: 1, origin: "not a url" })),
      undefined,
    );
    assert.equal(
      resolvePrimaryReadinessProbeUrl(JSON.stringify({ version: 1, origin: "file:///etc" })),
      undefined,
      "only http(s) origins may be probed",
    );
  });
});
