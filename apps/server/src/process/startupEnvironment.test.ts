import { assert, it } from "@effect/vitest";
import { WORKING_FOLDER_LOOKUP_VARIABLE } from "@threadlines/shared/windowsCommandLookup";

import { prepareStartupEnvironment } from "./startupEnvironment.ts";

it("drops the desktop app's ELECTRON_RUN_AS_NODE so programs the server starts never inherit it", () => {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1", PATH: "/usr/bin", HOME: "/home/a" };
  prepareStartupEnvironment(env, "linux");
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/a" });

  const windowsEnv: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1", Path: "C:\\Windows" };
  prepareStartupEnvironment(windowsEnv, "win32");
  assert.equal(windowsEnv.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(windowsEnv[WORKING_FOLDER_LOOKUP_VARIABLE], "1");
});
