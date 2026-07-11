import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildHostedPairingUrl,
  buildHostedRelayPairingUrl,
  buildRelayDeviceSocketUrl,
  hasHostedPairingRequest,
  hasHostedPairingRouteIntent,
  isHostedStaticApp,
  readHostedPairingRequest,
} from "./hostedPairing";

describe("hostedPairing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads hosted pairing host and query token parameters", () => {
    const url = new URL("https://app.threadlines.dev/pair?host=100.64.1.2:3773&token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      kind: "direct",
      host: "100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });

  it("reads hosted relay pairing parameters", () => {
    const url = new URL(
      "https://app.threadlines.dev/pair?relay=https%3A%2F%2Frelay.threadlines.dev%2F&session=session-1&label=Phone#token=device-token",
    );

    expect(readHostedPairingRequest(url)).toEqual({
      kind: "relay",
      relayOrigin: "https://relay.threadlines.dev",
      sessionId: "session-1",
      token: "device-token",
      label: "Phone",
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });

  it("builds hosted relay pairing URLs with hash tokens", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.threadlines.dev");

    const url = new URL(
      buildHostedRelayPairingUrl({
        relayOrigin: "https://relay.threadlines.dev/",
        sessionId: "session-1",
        token: "device-token",
        label: "Phone",
      }),
    );

    expect(url.origin).toBe("https://app.threadlines.dev");
    expect(url.pathname).toBe("/pair");
    expect(url.searchParams.get("relay")).toBe("https://relay.threadlines.dev");
    expect(url.searchParams.get("session")).toBe("session-1");
    expect(url.searchParams.get("label")).toBe("Phone");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.hash).toBe("#token=device-token");
  });

  it("builds raw relay device socket URLs", () => {
    expect(
      buildRelayDeviceSocketUrl({
        relayOrigin: "https://relay.threadlines.dev",
        sessionId: "session-1",
      }),
    ).toBe("wss://relay.threadlines.dev/v1/sessions/session-1/connect?role=device&mode=raw");
  });

  it("prefers hash tokens so generated hosted links do not put credentials in search params", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.app.threadlines.dev");

    const url = new URL(
      buildHostedPairingUrl({
        host: "https://backend.example.com:3773",
        token: "pairing-token",
        label: "Workstation",
      }),
    );

    expect(url.origin).toBe("https://preview.app.threadlines.dev");
    expect(url.pathname).toBe("/pair");
    expect(url.searchParams.get("host")).toBe("https://backend.example.com:3773");
    expect(url.searchParams.get("label")).toBe("Workstation");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.hash).toBe("#token=pairing-token");
  });

  it("ignores incomplete hosted pairing requests", () => {
    expect(
      hasHostedPairingRequest(new URL("https://app.threadlines.dev/pair?host=backend.example.com")),
    ).toBe(false);
    expect(
      hasHostedPairingRequest(new URL("https://app.threadlines.dev/pair?token=ABCD1234")),
    ).toBe(false);
    expect(
      hasHostedPairingRequest(new URL("https://app.threadlines.dev/pair?relay=%25&session=abc")),
    ).toBe(false);
  });

  it("keeps hosted pairing route intent after the secret is stripped from the URL", () => {
    expect(
      hasHostedPairingRouteIntent(
        new URL(
          "https://app.threadlines.dev/pair?relay=https%3A%2F%2Frelay.threadlines.dev&session=session-1",
        ),
      ),
    ).toBe(true);
    expect(
      hasHostedPairingRouteIntent(new URL("https://app.threadlines.dev/pair?host=backend.test")),
    ).toBe(true);
    expect(hasHostedPairingRouteIntent(new URL("https://app.threadlines.dev/pair"))).toBe(false);
  });

  it("detects the hosted static app only when no backend URL is configured", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.app.threadlines.dev");
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_WS_URL", "");

    expect(isHostedStaticApp(new URL("https://preview.app.threadlines.dev/"))).toBe(true);
    expect(isHostedStaticApp(new URL("https://preview.app.threadlines.dev/pair"))).toBe(true);
    expect(isHostedStaticApp(new URL("https://backend.example.com/"))).toBe(false);

    vi.stubEnv("VITE_HTTP_URL", "https://backend.example.com");
    expect(isHostedStaticApp(new URL("https://preview.app.threadlines.dev/"))).toBe(false);
  });

  it("keeps the production custom domain static when Vercel exposes its project URL", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://threadlines-app.vercel.app");
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_WS_URL", "");

    expect(isHostedStaticApp(new URL("https://app.threadlines.dev/"))).toBe(true);
    expect(isHostedStaticApp(new URL("https://threadlines-app.vercel.app/"))).toBe(true);
    expect(isHostedStaticApp(new URL("https://backend.example.com/"))).toBe(false);
  });

  it("detects hosted channel aliases as static apps", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.threadlines.dev");
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "nightly");
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_WS_URL", "");

    expect(isHostedStaticApp(new URL("https://nightly.app.threadlines.dev/"))).toBe(true);

    vi.stubEnv("VITE_HTTP_URL", "https://backend.example.com");
    expect(isHostedStaticApp(new URL("https://nightly.app.threadlines.dev/"))).toBe(false);
  });
});
