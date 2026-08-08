import "../../index.css";

import type { AuthSessionState } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { PairingRouteSurface } from "./PairingRouteSurface";

const auth: AuthSessionState["auth"] = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "threadlines_session",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

/**
 * A phone that opens a computer's LAN address without a token lands here: this
 * form is the manual pairing path for a directly reachable server, so its happy
 * path has to keep working.
 */
describe("PairingRouteSurface", () => {
  beforeEach(async () => {
    const { __resetServerAuthBootstrapForTests } = await import("../../environments/primary");
    __resetServerAuthBootstrapForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("pairs the browser with a token typed into the form", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ authenticated: true, sessionMethod: "browser-session-cookie" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const onAuthenticated = vi.fn();

    render(<PairingRouteSurface auth={auth} onAuthenticated={onAuthenticated} />);

    await page.getByLabelText("Pairing token").fill("PAIRCODE1234");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect.poll(() => onAuthenticated.mock.calls.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/bootstrap"),
      expect.objectContaining({
        body: JSON.stringify({ credential: "PAIRCODE1234" }),
        method: "POST",
      }),
    );
  });

  it("keeps the form usable and names the problem when the token is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ error: "Invalid bootstrap credential." }, 401)),
    );
    const onAuthenticated = vi.fn();

    render(<PairingRouteSurface auth={auth} onAuthenticated={onAuthenticated} />);

    await page.getByLabelText("Pairing token").fill("NOPE");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect
      .element(page.getByText("Invalid pairing token. Check the token and try again."))
      .toBeVisible();
    expect(onAuthenticated).not.toHaveBeenCalled();
    await expect.element(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  });
});
