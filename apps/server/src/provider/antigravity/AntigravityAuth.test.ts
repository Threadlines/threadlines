import { describe, expect, it } from "vite-plus/test";

import { checkAntigravityRedirect } from "./AntigravityAuth.ts";

describe("checkAntigravityRedirect", () => {
  const pending = { redirect: new URL("http://127.0.0.1:53789/"), state: "8Jy4kHH5tYZC" };
  const accepted = (raw: string) => typeof checkAntigravityRedirect(raw, pending) !== "string";

  it("accepts the address a browser on another device ended on", () => {
    // Shape of the real redirect Google sent (code shortened).
    expect(
      accepted(
        "http://127.0.0.1:53789/?state=8Jy4kHH5tYZC&iss=https%3A%2F%2Faccounts.google.com&code=4%2F0AXlqoi6&scope=email",
      ),
    ).toBe(true);
    expect(accepted("http://127.0.0.1:53789/?state=8Jy4kHH5tYZC&error=access_denied")).toBe(true);
  });

  it("refuses anything that isn't this sign-in's redirect", () => {
    const refused = [
      // Another host, port, or path: the replay must only ever reach the agent.
      "http://localhost:53789/?state=8Jy4kHH5tYZC&code=x",
      "http://127.0.0.1:8080/?state=8Jy4kHH5tYZC&code=x",
      "http://127.0.0.1:53789/admin?state=8Jy4kHH5tYZC&code=x",
      "https://127.0.0.1:53789/?state=8Jy4kHH5tYZC&code=x",
      // Another sign-in attempt, or a duplicated state.
      "http://127.0.0.1:53789/?state=other&code=x",
      "http://127.0.0.1:53789/?state=8Jy4kHH5tYZC&state=8Jy4kHH5tYZC&code=x",
      // No result, or two.
      "http://127.0.0.1:53789/?state=8Jy4kHH5tYZC",
      "http://127.0.0.1:53789/?state=8Jy4kHH5tYZC&code=x&error=y",
      // Not issued by Google.
      "http://127.0.0.1:53789/?state=8Jy4kHH5tYZC&code=x&iss=https%3A%2F%2Fevil.example",
      "not a url",
    ];
    for (const raw of refused) expect(accepted(raw), raw).toBe(false);
  });
});
