import { describe, expect, it } from "vite-plus/test";

import { browserSearchUrl } from "@threadlines/shared/browserSearch";

import { normalizePreviewUrl, resolveAddressEntry } from "./previewUrl";

describe("normalizePreviewUrl", () => {
  it("assumes http for a bare dev-server address", () => {
    // https would fail on every dev server without a certificate.
    expect(normalizePreviewUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizePreviewUrl("127.0.0.1:3000/pricing")).toBe("http://127.0.0.1:3000/pricing");
    expect(normalizePreviewUrl("192.168.1.20")).toBe("http://192.168.1.20/");
    // An explicit port on a public name is still someone's dev tunnel.
    expect(normalizePreviewUrl("example.com:8080")).toBe("http://example.com:8080/");
  });

  it("assumes https for a bare public site, like any browser", () => {
    expect(normalizePreviewUrl("google.com")).toBe("https://google.com/");
    expect(normalizePreviewUrl("facpmanuals.com/manuals")).toBe("https://facpmanuals.com/manuals");
  });

  it("keeps an explicit scheme", () => {
    expect(normalizePreviewUrl("https://example.com/a")).toBe("https://example.com/a");
    // Typing http is the escape hatch for an http-only site; it must not be
    // upgraded out from under the user.
    expect(normalizePreviewUrl("http://example.com/a")).toBe("http://example.com/a");
  });

  it("rejects entries that would navigate somewhere surprising", () => {
    expect(normalizePreviewUrl("")).toBeNull();
    expect(normalizePreviewUrl("   ")).toBeNull();
    expect(normalizePreviewUrl("javascript:alert(1)")).toBeNull();
    expect(normalizePreviewUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("resolveAddressEntry", () => {
  const url = (value: string) => ({ kind: "url", url: value });
  const search = (query: string) => ({ kind: "search", query });

  it("loads what names a place: a host, a port, a path, an IP address or localhost", () => {
    expect(resolveAddressEntry("localhost")).toEqual(url("http://localhost/"));
    expect(resolveAddressEntry("localhost:5173/app")).toEqual(url("http://localhost:5173/app"));
    expect(resolveAddressEntry("devbox:3000")).toEqual(url("http://devbox:3000/"));
    expect(resolveAddressEntry("intranet/")).toEqual(url("http://intranet/"));
    expect(resolveAddressEntry("192.168.1.20")).toEqual(url("http://192.168.1.20/"));
    expect(resolveAddressEntry("threadlines.dev")).toEqual(url("https://threadlines.dev/"));
    expect(resolveAddressEntry("https://example.com/a b")).toEqual(
      url("https://example.com/a%20b"),
    );
    expect(resolveAddressEntry("[::1]")).toEqual(url("http://[::1]/"));
    expect(resolveAddressEntry("例え。テスト")).toEqual(url("https://xn--r8jz45g.xn--zckzah/"));
  });

  it("keeps an address with a path or a port an address, whatever else it holds", () => {
    expect(resolveAddressEntry("localhost:5173/a b")).toEqual(url("http://localhost:5173/a%20b"));
    expect(resolveAddressEntry("example.com/a b")).toEqual(url("https://example.com/a%20b"));
    expect(resolveAddressEntry("user@devbox/path")).toEqual(url("http://user@devbox/path"));
    expect(resolveAddressEntry("127.1:3000/")).toEqual(url("http://127.0.0.1:3000/"));
    expect(resolveAddressEntry("127.0.0.1.")).toEqual(url("http://127.0.0.1/"));
    expect(resolveAddressEntry("//example.com/app")).toEqual(url("https://example.com/app"));
    expect(resolveAddressEntry("devbox\\logs")).toEqual(url("http://devbox/logs"));
  });

  it("searches for everything else", () => {
    expect(resolveAddressEntry("how to center a div")).toEqual(search("how to center a div"));
    expect(resolveAddressEntry("react")).toEqual(search("react"));
    expect(resolveAddressEntry("what is node.js")).toEqual(search("what is node.js"));
    expect(resolveAddressEntry("3.14")).toEqual(search("3.14"));
    expect(resolveAddressEntry("someone@example.com")).toEqual(search("someone@example.com"));
    expect(resolveAddressEntry("c++")).toEqual(search("c++"));
    expect(resolveAddressEntry("why?")).toEqual(search("why?"));
    expect(resolveAddressEntry("devbox?next=/logs")).toEqual(search("devbox?next=/logs"));
    expect(resolveAddressEntry("threadlines.dev pricing")).toEqual(
      search("threadlines.dev pricing"),
    );
    expect(resolveAddressEntry("javascript:alert(1)")).toEqual(search("javascript:alert(1)"));
  });

  it("sends a search to the chosen engine with the words encoded", () => {
    expect(browserSearchUrl("google", "tom & jerry?")).toBe(
      "https://www.google.com/search?q=tom+%26+jerry%3F",
    );
    expect(browserSearchUrl("duckduckgo", "c++")).toBe("https://duckduckgo.com/?q=c%2B%2B");
  });

  it("lets a leading ? force a search", () => {
    expect(resolveAddressEntry("?threadlines.dev")).toEqual(search("threadlines.dev"));
    expect(resolveAddressEntry("?")).toBeNull();
  });

  it("does nothing for an empty entry or a scheme the browser does not load", () => {
    expect(resolveAddressEntry("   ")).toBeNull();
    expect(resolveAddressEntry("file:///etc/passwd")).toBeNull();
  });
});
