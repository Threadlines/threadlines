import { describe, expect, it } from "vite-plus/test";

import { resolveSignInEndsWarning, signInEndsCopy } from "./signInEnds";

const signInEnds = {
  earliest: "2026-11-17T12:00:00.000Z",
  latest: "2026-11-20T12:00:00.000Z",
};
const at = (iso: string) =>
  resolveSignInEndsWarning({ instanceId: "claudeAgent", signInEnds, nowMs: Date.parse(iso) });

describe("resolveSignInEndsWarning", () => {
  it("warns from ten days before the latest end, more firmly as it nears", () => {
    expect(at("2026-11-10T11:00:00.000Z")).toBeNull();
    expect(at("2026-11-10T13:00:00.000Z")?.phase).toBe("upcoming");
    expect(at("2026-11-18T00:00:00.000Z")?.phase).toBe("any-day");
    expect(at("2026-11-21T00:00:00.000Z")?.phase).toBe("ended");
    expect(
      resolveSignInEndsWarning({ instanceId: "claudeAgent", signInEnds: undefined, nowMs: 0 }),
    ).toBeNull();
  });

  it("hides per sign-in: signing in again brings a new key", () => {
    expect(at("2026-11-12T00:00:00.000Z")?.dismissalKey).toBe(
      "claudeAgent:2026-11-20T12:00:00.000Z",
    );
    const warning = at("2026-11-12T00:00:00.000Z");
    expect(warning && signInEndsCopy(warning, "Claude · Work").lead).toMatch(
      /^Claude · Work sign-in ends between /,
    );
  });
});
