import { assert, expect, it } from "@effect/vitest";

import {
  buildPairingUrl,
  formatHeadlessServeOutput,
  renderTerminalQrCode,
  resolveAdvertisedServerUrl,
  resolveHeadlessConnectionHost,
  resolveHeadlessConnectionString,
  resolveListeningPort,
} from "./startupAccess.ts";

const LAN_INTERFACES = {
  en0: [
    {
      address: "192.168.1.42",
      netmask: "255.255.255.0",
      family: "IPv4" as const,
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: "192.168.1.42/24",
    },
  ],
  lo0: [
    {
      address: "127.0.0.1",
      netmask: "255.0.0.0",
      family: "IPv4" as const,
      mac: "00:00:00:00:00:00",
      internal: true,
      cidr: "127.0.0.1/8",
    },
  ],
};

// An unset host binds every interface, so the advertised URL has to be one
// another device can open. A loopback URL here is a dead pairing link.
it("resolves an unset host to a reachable interface", () => {
  expect(resolveHeadlessConnectionHost(undefined, LAN_INTERFACES)).toBe("192.168.1.42");
  expect(resolveHeadlessConnectionString(undefined, 3773, LAN_INTERFACES)).toBe(
    "http://192.168.1.42:3773",
  );
});

it("falls back to localhost when no external interface exists", () => {
  expect(resolveHeadlessConnectionHost(undefined, { lo0: LAN_INTERFACES.lo0 })).toBe("localhost");
});

it("keeps explicit bind hosts in the connection string", () => {
  expect(resolveHeadlessConnectionString("127.0.0.1", 3773)).toBe("http://127.0.0.1:3773");
  expect(resolveHeadlessConnectionString("::1", 3773)).toBe("http://[::1]:3773");
});

// A developer machine's first external interface is often a virtual adapter
// (WSL, Hyper-V, Docker) whose subnet no phone can reach; the physical NIC
// must win. Virtual-only machines still advertise their best candidate.
it("prefers a physical interface over virtual adapters", () => {
  const interfaces = {
    "vEthernet (WSL (Hyper-V firewall))": [
      {
        address: "172.22.16.1",
        netmask: "255.255.240.0",
        family: "IPv4" as const,
        mac: "00:15:5d:00:00:01",
        internal: false,
        cidr: "172.22.16.1/20",
      },
    ],
    "Wi-Fi": [
      {
        address: "10.0.0.15",
        netmask: "255.255.255.0",
        family: "IPv4" as const,
        mac: "aa:bb:cc:dd:ee:ff",
        internal: false,
        cidr: "10.0.0.15/24",
      },
    ],
  };
  expect(resolveHeadlessConnectionHost(undefined, interfaces)).toBe("10.0.0.15");
  expect(
    resolveHeadlessConnectionHost(undefined, {
      "vEthernet (WSL (Hyper-V firewall))": interfaces["vEthernet (WSL (Hyper-V firewall))"],
    }),
  ).toBe("172.22.16.1");
});

// The boot log's pairing URL uses the same rule as headless serve: a wildcard
// bind advertises an address other devices can open, not localhost.
it("advertises a reachable interface for wildcard binds in browser mode", () => {
  expect(
    resolveAdvertisedServerUrl({ host: "0.0.0.0", port: 8266, mode: "web" }, LAN_INTERFACES),
  ).toBe("http://192.168.1.42:8266");
});

it("advertises explicit hosts verbatim and keeps desktop wildcard binds on localhost", () => {
  expect(
    resolveAdvertisedServerUrl({ host: "127.0.0.1", port: 8266, mode: "web" }, LAN_INTERFACES),
  ).toBe("http://127.0.0.1:8266");
  expect(
    resolveAdvertisedServerUrl({ host: "0.0.0.0", port: 8266, mode: "desktop" }, LAN_INTERFACES),
  ).toBe("http://localhost:8266");
});

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const connectionString = resolveHeadlessConnectionString("0.0.0.0", 3773, {
    en0: [
      {
        address: "192.168.1.42",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "192.168.1.42/24",
      },
    ],
    lo0: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
  });

  expect(connectionString).toBe("http://192.168.1.42:3773");
});

it("prefers the actual bound port when an http server address is available", () => {
  expect(resolveListeningPort({ port: 4123 }, 3773)).toBe(4123);
  expect(resolveListeningPort("pipe", 3773)).toBe(3773);
  expect(resolveListeningPort(null, 3773)).toBe(3773);
});

it("builds a pairing URL that embeds the token in the hash", () => {
  expect(buildPairingUrl("http://192.168.1.42:3773", "PAIRCODE")).toBe(
    "http://192.168.1.42:3773/pair#token=PAIRCODE",
  );
});

it("renders terminal QR codes as a multi-line unicode block grid", () => {
  const qrCode = renderTerminalQrCode("http://192.168.1.42:3773/pair#token=PAIRCODE");

  assert.isTrue(qrCode.includes("█"));
  assert.isTrue(qrCode.split("\n").length > 10);
});

it("formats headless serve output with the connection string, token, pairing url, and qr code", () => {
  const output = formatHeadlessServeOutput({
    connectionString: "http://192.168.1.42:3773",
    token: "PAIRCODE",
    pairingUrl: "http://192.168.1.42:3773/pair#token=PAIRCODE",
  });

  expect(output).toContain("Connection string: http://192.168.1.42:3773");
  expect(output).toContain("Token: PAIRCODE");
  expect(output).toContain("Pairing URL: http://192.168.1.42:3773/pair#token=PAIRCODE");
  assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));
});
