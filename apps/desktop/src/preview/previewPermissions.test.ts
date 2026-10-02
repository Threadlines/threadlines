import { describe, expect, it } from "vite-plus/test";

import { isPreviewPermissionAllowed } from "./previewPermissions.ts";

describe("isPreviewPermissionAllowed", () => {
  it("lets any page write to the clipboard, so error overlays can copy", () => {
    expect(isPreviewPermissionAllowed("clipboard-sanitized-write", "https://example.com/")).toBe(
      true,
    );
    expect(isPreviewPermissionAllowed("clipboard-sanitized-write", undefined)).toBe(true);
  });

  it("lets only local and network pages read the clipboard or notify", () => {
    for (const permission of ["clipboard-read", "notifications"]) {
      for (const url of [
        "http://localhost:5173/settings",
        "http://127.0.0.1:3000",
        "http://192.168.1.20:8080/",
        "http://[::1]:4000/",
        "http://my-mac.local:3000",
        // The check handler passes an origin, not a URL.
        "http://localhost:5173",
        "blob:http://localhost:5173/0b6c5bb4-5d0b-4a50-9a8e-1b8f9f1d2a3c",
      ]) {
        expect(isPreviewPermissionAllowed(permission, url), `${permission} ${url}`).toBe(true);
      }
      for (const url of [
        "https://example.com/",
        "https://localhost.example.com/",
        "https://example.com/?next=http://localhost",
        "about:blank",
        "null",
        "",
        undefined,
        null,
      ]) {
        expect(isPreviewPermissionAllowed(permission, url), `${permission} ${url}`).toBe(false);
      }
    }
  });

  it("denies everything else, even to local pages", () => {
    for (const permission of ["media", "geolocation", "fullscreen", "clipboard-write", "midi"]) {
      expect(isPreviewPermissionAllowed(permission, "http://localhost:3000/"), permission).toBe(
        false,
      );
    }
  });
});
