import type { AuthSessionState } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { probePrimaryAccess } from "./accessRemoval";

const auth: AuthSessionState["auth"] = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "threadlines_session",
};

describe("probePrimaryAccess", () => {
  const signedOut = async () => ({ authenticated: false, auth }) as AuthSessionState;

  it("reports removed access when the computer no longer knows this session", async () => {
    // A paired browser holds nothing it could sign back in with.
    await expect(probePrimaryAccess(signedOut, async () => "unavailable")).resolves.toBe("removed");
  });

  it("treats the desktop app's own window as still having access once it signed back in", async () => {
    await expect(probePrimaryAccess(signedOut, async () => "renewed")).resolves.toBe("active");
  });

  it("keeps reconnecting when the desktop window could not get a new session yet", async () => {
    await expect(probePrimaryAccess(signedOut, async () => "failed")).resolves.toBe("unknown");
  });

  it("keeps a network failure inconclusive so reconnecting continues", async () => {
    await expect(
      probePrimaryAccess(async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).resolves.toBe("unknown");
  });

  it("reports active access when the session survives the disconnect", async () => {
    await expect(
      probePrimaryAccess(
        async () =>
          ({
            authenticated: true,
            auth,
            sessionMethod: "browser-session-cookie",
          }) as AuthSessionState,
      ),
    ).resolves.toBe("active");
  });
});
