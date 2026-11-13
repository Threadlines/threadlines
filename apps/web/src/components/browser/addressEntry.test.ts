import { browserSearchUrl } from "@threadlines/shared/browserSearch";
import { describe, expect, it } from "vite-plus/test";

import { resolveAddressEntry } from "./addressEntry";

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
