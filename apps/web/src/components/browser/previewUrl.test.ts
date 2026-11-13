import { describe, expect, it } from "vite-plus/test";

import { normalizePreviewUrl } from "./previewUrl";

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
