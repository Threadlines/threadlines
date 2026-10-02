import { describe, expect, it } from "vite-plus/test";
import { isThrowawayTelemetryRun, parseTelemetryEnabledOverride } from "./telemetryConsent.ts";

describe("isThrowawayTelemetryRun", () => {
  const realInstall = {
    baseDirs: ["/Users/someone/.threadlines"],
    tempDirs: ["/var/folders/ab/T", "/private/var/folders/ab/T"],
  };

  it("treats a CI job as throwaway unless CI is explicitly off", () => {
    expect(isThrowawayTelemetryRun({ ...realInstall, ciEnv: "true" })).toBe(true);
    expect(isThrowawayTelemetryRun({ ...realInstall, ciEnv: "1" })).toBe(true);
    expect(isThrowawayTelemetryRun({ ...realInstall, ciEnv: "false" })).toBe(false);
    expect(isThrowawayTelemetryRun({ ...realInstall, ciEnv: "no" })).toBe(false);
    expect(isThrowawayTelemetryRun({ ...realInstall, ciEnv: undefined })).toBe(false);
  });

  it("treats a data folder inside the temp folder as throwaway, however it is spelled", () => {
    expect(
      isThrowawayTelemetryRun({
        ...realInstall,
        baseDirs: ["/private/var/folders/ab/T/smoke-1/home"],
        ciEnv: undefined,
      }),
    ).toBe(true);
    expect(
      isThrowawayTelemetryRun({
        baseDirs: ["c:\\users\\someone\\appdata\\local\\temp\\tl-test-3"],
        tempDirs: ["C:\\Users\\someone\\AppData\\Local\\Temp"],
        ciEnv: undefined,
      }),
    ).toBe(true);
    // A sibling whose name only starts like the temp folder is a real install.
    expect(
      isThrowawayTelemetryRun({
        baseDirs: ["/var/folders/ab/Threadlines"],
        tempDirs: ["/var/folders/ab/T"],
        ciEnv: undefined,
      }),
    ).toBe(false);
  });
});

describe("parseTelemetryEnabledOverride", () => {
  it("reads the same spellings as the server's Config.boolean", () => {
    expect(parseTelemetryEnabledOverride("1")).toBe(true);
    expect(parseTelemetryEnabledOverride("yes")).toBe(true);
    expect(parseTelemetryEnabledOverride("off")).toBe(false);
    expect(parseTelemetryEnabledOverride("false")).toBe(false);
    expect(parseTelemetryEnabledOverride("maybe")).toBeUndefined();
    expect(parseTelemetryEnabledOverride(undefined)).toBeUndefined();
  });
});
