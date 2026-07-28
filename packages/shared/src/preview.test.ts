import { describe, expect, it } from "vitest";

import {
  browserApprovalKey,
  isBrowserHostApproved,
  isPrivateNetworkHost,
  withBrowserApproval,
} from "./preview.ts";

/**
 * This is the whole guardrail. A host wrongly called private, or an approval
 * entry that matches more than the site it names, is the difference between
 * "the agent asked first" and "the agent went wherever it liked".
 */
describe("isPrivateNetworkHost", () => {
  it("covers the addresses the preview panel exists for", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "127.1.2.3",
      // Dev servers print their listen address; browsers take it to mean here.
      "0.0.0.0",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.10",
      "100.64.0.1",
      "100.127.255.255",
      "169.254.1.1",
      "printer.local",
      "laptop.tail1234.ts.net",
      "::1",
      "[::1]",
      "fe80::1",
      "fd12:3456::1",
    ]) {
      expect(isPrivateNetworkHost(host), `${host} should be private`).toBe(true);
    }
  });

  it("treats everything else as public, including near misses", () => {
    for (const host of [
      "",
      "example.com",
      "127.0.0.1.example.com",
      "9.255.255.255",
      "11.0.0.1",
      // Just outside RFC 1918: 172.15 and 172.32 are public space.
      "172.15.0.1",
      "172.32.0.1",
      "192.169.1.1",
      // Just outside CGNAT: 100.63 and 100.128 are public space.
      "100.63.255.255",
      "100.128.0.1",
      "169.253.1.1",
      "notlocal",
      "example.localhost",
      "2606:4700::1111",
      // fe7f and fec0 sit either side of link-local; fb and fe00 either side of ULA.
      "fe7f::1",
      "fec0::1",
      "fbff::1",
      "fe00::1",
      // Not an address at all, so not a private one.
      "999.0.0.1",
      "10.0.0",
    ]) {
      expect(isPrivateNetworkHost(host), `${host} should be public`).toBe(false);
    }
  });
});

describe("browserApprovalKey", () => {
  it("normalises the shapes one site arrives in", () => {
    expect(browserApprovalKey("WWW.Example.COM")).toBe("www.example.com");
    expect(browserApprovalKey("[2606:4700::1111]")).toBe("2606:4700::1111");
    expect(browserApprovalKey("www.www.example.com")).toBe("www.www.example.com");
    expect(browserApprovalKey("wwwexample.com")).toBe("wwwexample.com");
  });
});

describe("isBrowserHostApproved", () => {
  it("lets private addresses through with nothing approved", () => {
    expect(isBrowserHostApproved("localhost", [])).toBe(true);
    expect(isBrowserHostApproved("192.168.0.9", [])).toBe(true);
  });

  it("matches only the approved host, case-insensitively", () => {
    const approved = ["example.com"];
    expect(isBrowserHostApproved("example.com", approved)).toBe(true);
    expect(isBrowserHostApproved("EXAMPLE.com", approved)).toBe(true);
    expect(isBrowserHostApproved("docs.example.com", approved)).toBe(false);
  });

  it("treats www and the bare domain as one site, in both directions", () => {
    // Typing google.com lands on www.google.com via the site's own redirect;
    // prompting for it would read as asking permission for the page the user
    // just asked for.
    expect(isBrowserHostApproved("www.example.com", ["example.com"])).toBe(true);
    expect(isBrowserHostApproved("example.com", ["www.example.com"])).toBe(true);
    // Only the www label, nothing broader.
    expect(isBrowserHostApproved("docs.example.com", ["www.example.com"])).toBe(false);
    expect(isBrowserHostApproved("wwwexample.com", ["example.com"])).toBe(false);
    // www.com is a site of its own, not permission for the whole of .com.
    expect(isBrowserHostApproved("com", ["www.com"])).toBe(false);
  });

  it("refuses a host that merely ends with an approved one", () => {
    // The dot is what makes it a subdomain. Without it, approving example.com
    // would also approve notexample.com, which is how this kind of check is
    // usually got wrong.
    expect(isBrowserHostApproved("notexample.com", ["example.com"])).toBe(false);
    expect(isBrowserHostApproved("example.com.evil.test", ["example.com"])).toBe(false);
    expect(isBrowserHostApproved("example.org", ["example.com"])).toBe(false);
    expect(isBrowserHostApproved("example.com", [])).toBe(false);
    expect(isBrowserHostApproved("tenant.github.io", ["github.io"])).toBe(false);
    expect(isBrowserHostApproved("example.com", ["com"])).toBe(false);
  });
});

describe("withBrowserApproval", () => {
  it("adds a public host once and leaves the list alone otherwise", () => {
    const approved = withBrowserApproval([], "WWW.Example.com");
    expect(approved).toEqual(["www.example.com"]);
    // The same host is not written twice.
    expect(withBrowserApproval(approved, "www.example.com")).toBe(approved);
    // A subdomain is a distinct approval.
    expect(withBrowserApproval(approved, "docs.example.com")).toEqual([
      "www.example.com",
      "docs.example.com",
    ]);
    // Private hosts are always allowed and never need remembering.
    expect(withBrowserApproval(approved, "localhost")).toBe(approved);
  });
});
