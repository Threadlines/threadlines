import { describe, expect, it } from "vite-plus/test";

import { buildMcpAppDocument } from "./mcpAppDocument.ts";
import {
  mcpAppContentSecurityPolicy,
  mcpAppFrameAllow,
  mcpToolUiFromMeta,
  mcpToolCallableByApp,
  readMcpAppMessage,
  readMcpAppResourceUi,
} from "./mcpApps.ts";

describe("MCP app views", () => {
  it("lets a view reach only the hosts it declared, and never posts a form", () => {
    const ui = readMcpAppResourceUi({
      ui: {
        csp: {
          connectDomains: ["https://api.example.com", "wss://live.example.com"],
          resourceDomains: [
            "https://*.cdn.example.com",
            // Each of these would widen the policy past a host: dropped.
            "*",
            "https:",
            "'unsafe-eval'",
            "https://ok.example.com 'unsafe-eval'",
            "https://evil.example.com; script-src *",
            "javascript:alert(1)",
          ],
        },
        permissions: { clipboardWrite: {}, camera: true },
        prefersBorder: false,
      },
    });
    expect(ui).toEqual({
      csp: {
        connectDomains: ["https://api.example.com", "wss://live.example.com"],
        resourceDomains: ["https://*.cdn.example.com"],
      },
      // A permission is declared with an object, as the spec has it.
      permissions: { clipboardWrite: true },
      prefersBorder: false,
    });

    // Devices are never passed on to a view; the clipboard is.
    expect(mcpAppFrameAllow({ camera: true, microphone: true, geolocation: true })).toBeUndefined();
    expect(mcpAppFrameAllow(ui.permissions)).toBe("clipboard-write *");

    const policy = mcpAppContentSecurityPolicy(ui.csp);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src https://api.example.com wss://live.example.com");
    expect(policy).toContain("script-src 'unsafe-inline' https://*.cdn.example.com");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toContain("unsafe-eval");
    // A view that declared nothing connects nowhere.
    expect(mcpAppContentSecurityPolicy({})).toContain("connect-src 'none'");
  });

  it("puts the policy ahead of everything the view says", () => {
    const wrapped = (html: string) => buildMcpAppDocument({ html, csp: {}, appearance: "dark" });
    // A view's own doctype stays first, so it keeps its rendering mode.
    expect(wrapped("\n<!DOCTYPE html><p>ok</p>").startsWith("\n<!DOCTYPE html><meta charset")).toBe(
      true,
    );
    // "<!-->" is a whole comment to the browser: a scan that read on to the
    // next "-->" would let the script run before the policy.
    for (const html of [
      "<!--><script>steal()</script><!-- --><!doctype html><p>x</p>",
      "<!-- built --><!DOCTYPE html><script>steal()</script>",
    ]) {
      const document = wrapped(html);
      expect(document.startsWith("<!doctype html><meta charset")).toBe(true);
      expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf("steal()"));
    }
  });

  it("reads a tool's app and who may call it, the spec's default being both", () => {
    expect(mcpToolUiFromMeta({ ui: { resourceUri: "ui://weather/view.html" } })).toEqual({
      resourceUri: "ui://weather/view.html",
      visibility: ["model", "app"],
    });
    // The spec's earlier flat key.
    expect(mcpToolUiFromMeta({ "ui/resourceUri": "ui://weather/view.html" })?.resourceUri).toBe(
      "ui://weather/view.html",
    );
    const appOnly = mcpToolUiFromMeta({ ui: { resourceUri: "ui://w/v", visibility: ["app"] } });
    const modelOnly = mcpToolUiFromMeta({ ui: { visibility: ["model"] } });
    expect(mcpToolCallableByApp(appOnly)).toBe(true);
    expect(mcpToolCallableByApp(modelOnly)).toBe(false);
    expect(mcpToolCallableByApp(mcpToolUiFromMeta({ other: true }))).toBe(true);
  });

  it("tells requests, notifications and answers apart", () => {
    expect(
      readMcpAppMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } }),
    ).toMatchObject({ kind: "request", id: 1, method: "tools/call" });
    expect(readMcpAppMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" })).toEqual({
      kind: "notification",
      method: "ui/notifications/initialized",
      params: {},
    });
    expect(readMcpAppMessage({ jsonrpc: "2.0", id: "t", result: {} })).toMatchObject({
      kind: "response",
      id: "t",
    });
    expect(readMcpAppMessage({ method: "ui/initialize" })).toBeUndefined();
  });
});
