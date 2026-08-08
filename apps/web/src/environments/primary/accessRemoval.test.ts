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
  it("reports removed access when the computer no longer knows this session", async () => {
    await expect(
      probePrimaryAccess(async () => ({ authenticated: false, auth }) as AuthSessionState),
    ).resolves.toBe("removed");
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
