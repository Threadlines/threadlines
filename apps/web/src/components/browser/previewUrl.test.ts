import { describe, expect, it } from "vite-plus/test";

import { normalizePreviewUrl } from "./previewUrl";

describe("normalizePreviewUrl", () => {
  it("assumes http for a bare dev-server address", () => {
    // https would fail on every dev server without a certificate.
    expect(normalizePreviewUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizePreviewUrl("127.0.0.1:3000/pricing")).toBe("http://127.0.0.1:3000/pricing");
  });

  it("keeps an explicit scheme", () => {
    expect(normalizePreviewUrl("https://example.com/a")).toBe("https://example.com/a");
  });

  it("rejects entries that would navigate somewhere surprising", () => {
    expect(normalizePreviewUrl("")).toBeNull();
    expect(normalizePreviewUrl("   ")).toBeNull();
    expect(normalizePreviewUrl("javascript:alert(1)")).toBeNull();
    expect(normalizePreviewUrl("file:///etc/passwd")).toBeNull();
  });
});
