import { describe, expect, it } from "vite-plus/test";

import { PrintedRedirects } from "./loopbackRedirect.ts";

const page = (state: string) =>
  `https://auth.openai.com/oauth/authorize?redirect_uri=${encodeURIComponent(
    "http://localhost:1455/auth/callback",
  )}&state=${state}`;

describe("PrintedRedirects", () => {
  it("keeps every sign-in page a command prints, split across chunks or behind a link label", () => {
    const printed = new PrintedRedirects();
    const first = page("st-1");
    printed.push(`Open ${first.slice(0, 40)}`);
    // Not taken while the address may still be arriving.
    expect(printed.all).toEqual([]);
    printed.push(`${first.slice(40)}\r\n`);
    printed.push(`\u001b]8;;${page("st-2")}\u0007Sign in\u001b]8;;\u0007\r\n`);
    // A page that doesn't come back to this computer is no sign-in to finish here.
    printed.push("Docs: https://example.com/help?state=x\r\n");
    expect(printed.all.map((redirect) => redirect.state)).toEqual(["st-1", "st-2"]);
    expect(printed.all[0]!.redirect.href).toBe("http://localhost:1455/auth/callback");
  });
});
