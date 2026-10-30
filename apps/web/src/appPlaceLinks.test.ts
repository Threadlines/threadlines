import { EnvironmentId } from "@threadlines/contracts";
import { placeHref } from "@threadlines/shared/appPlaces";
import { describe, expect, it } from "vite-plus/test";

import { placeArrivalHash, placeIdFromArrivalHash, resolvePlaceLink } from "./appPlaceLinks";

const THIS_MAC = EnvironmentId.make("environment-this-mac");
const WINDOWS_PC = EnvironmentId.make("environment-windows-pc");

const fromThread = (href: string, threadEnvironmentId: EnvironmentId | null) =>
  resolvePlaceLink({ href, threadEnvironmentId, primaryEnvironmentId: THIS_MAC });

describe("resolvePlaceLink", () => {
  it("opens a known place with the search that reveals it, and ignores unknown ones", () => {
    expect(fromThread(placeHref("threads.agentThreads"), THIS_MAC)).toEqual({
      kind: "open",
      placeId: "threads.agentThreads",
      href: "/settings/threads",
    });
    expect(fromThread(placeHref("plugins.skills"), THIS_MAC)).toMatchObject({
      kind: "open",
      href: "/settings/plugins?tab=skills",
    });
    expect(fromThread("threadlines-place:threads.renamedSince", THIS_MAC)).toBeNull();
    expect(fromThread("https://example.com", THIS_MAC)).toBeNull();
  });

  it("names another computer's setting without opening this computer's", () => {
    expect(fromThread(placeHref("threads.agentThreads"), WINDOWS_PC)).toEqual({
      kind: "elsewhere",
      placeId: "threads.agentThreads",
      environmentId: WINDOWS_PC,
    });
    // This device's settings and the desktop app's are here whatever the thread.
    expect(fromThread(placeHref("general.alerts"), WINDOWS_PC)).toMatchObject({
      kind: "open",
      href: "/settings/general",
    });
    expect(fromThread(placeHref("connections.threadlinesCommand"), WINDOWS_PC)).toMatchObject({
      kind: "open",
      href: "/settings/connections?section=agents",
    });
    // Pages that pick their own computer, and pages that span computers, open.
    expect(fromThread(placeHref("instructions.files"), WINDOWS_PC)).toMatchObject({
      kind: "open",
    });
    expect(fromThread(placeHref("scheduled"), WINDOWS_PC)).toMatchObject({ kind: "open" });
  });

  it("opens a Fleet section on the thread's computer's page", () => {
    expect(fromThread(placeHref("fleet.worksWith"), WINDOWS_PC)).toMatchObject({
      kind: "open",
      href: `/fleet/${WINDOWS_PC}`,
    });
    expect(fromThread(placeHref("fleet.worksWith"), null)).toMatchObject({
      href: `/fleet/${THIS_MAC}`,
    });
    expect(fromThread(placeHref("fleet"), WINDOWS_PC)).toMatchObject({ href: "/fleet" });
  });
});

describe("place arrival hash", () => {
  it("round-trips the place and ignores other hashes", () => {
    expect(placeArrivalHash("fleet.worksWith", 3)).toBe("place=fleet.worksWith&n=3");
    expect(placeIdFromArrivalHash(placeArrivalHash("fleet.worksWith", 3))).toBe("fleet.worksWith");
    expect(placeIdFromArrivalHash("place=nowhere.atAll&n=1")).toBeNull();
    expect(placeIdFromArrivalHash("section-heading")).toBeNull();
  });
});
