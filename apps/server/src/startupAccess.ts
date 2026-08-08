import { networkInterfaces } from "node:os";

import { QrCode } from "@threadlines/shared/qrCode";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";

import { ServerConfig } from "./config.ts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";

export interface HeadlessServeAccessInfo {
  readonly connectionString: string;
  readonly token: string;
  readonly pairingUrl: string;
}

type NetworkInterfacesMap = ReturnType<typeof networkInterfaces>;

export const isLoopbackHost = (host: string | undefined): boolean => {
  if (!host || host.length === 0) {
    return true;
  }

  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
};

export const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

export const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

const normalizeHost = (host: string): string =>
  host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

const isIpv4Family = (family: string | number): boolean => family === "IPv4" || family === 4;

const isIpv6Family = (family: string | number): boolean => family === "IPv6" || family === 6;

/**
 * Adapters that exist for the host's own plumbing: their subnets are usually
 * unreachable from other physical devices, so a pairing URL on one is a dead
 * link for the phone it's meant for. Matched by interface name because the
 * OS exposes nothing more structured; deprioritized rather than excluded so a
 * machine with only virtual adapters still advertises something routable-ish.
 */
const VIRTUAL_INTERFACE_NAME_PATTERN =
  /vethernet|wsl|hyper-v|docker|vmware|virtualbox|vbox|tailscale|zerotier|utun|tun[0-9]|tap[0-9]|bridge/i;

export const resolveHeadlessConnectionHost = (
  host: string | undefined,
  interfaces: NetworkInterfacesMap = networkInterfaces(),
): string => {
  // An unset host binds every interface, exactly like an explicit wildcard.
  // Reporting `localhost` for it printed a pairing URL only this machine could
  // open, which is useless for the one thing `serve` exists to do: pair a phone.
  if (host !== undefined && !isWildcardHost(host)) {
    return normalizeHost(host);
  }

  const interfaceEntries = Object.entries(interfaces).flatMap(
    ([name, entries]) => entries?.map((entry) => ({ name, entry })) ?? [],
  );
  const externalIpv4 = interfaceEntries.filter(
    ({ entry }) => !entry.internal && isIpv4Family(entry.family),
  );
  const physicalIpv4 = externalIpv4.find(({ name }) => !VIRTUAL_INTERFACE_NAME_PATTERN.test(name));
  const pickedIpv4 = physicalIpv4 ?? externalIpv4[0];
  if (pickedIpv4) {
    return pickedIpv4.entry.address;
  }

  const externalIpv6 = interfaceEntries.find(
    ({ entry }) => !entry.internal && isIpv6Family(entry.family),
  );
  return externalIpv6 ? normalizeHost(externalIpv6.entry.address) : "localhost";
};

export const resolveHeadlessConnectionString = (
  host: string | undefined,
  port: number,
  interfaces: NetworkInterfacesMap = networkInterfaces(),
): string => {
  const connectionHost = resolveHeadlessConnectionHost(host, interfaces);
  return `http://${formatHostForUrl(connectionHost)}:${port}`;
};

/**
 * The URL a starting server advertises (boot-log pairing URL and browser-open
 * target). An explicit non-wildcard host is advertised verbatim. A wildcard
 * bind exists so other devices can connect, so browser-mode servers advertise
 * a reachable interface instead of localhost, which only reaches this
 * machine; the desktop shell keeps localhost — its wildcard rebinds are for
 * nearby devices whose URLs come from the Devices dialog, not this log line.
 */
export const resolveAdvertisedServerUrl = (
  input: {
    readonly host: string | undefined;
    readonly port: number;
    readonly mode: string;
  },
  interfaces: NetworkInterfacesMap = networkInterfaces(),
): string => {
  if (input.host && !isWildcardHost(input.host)) {
    return `http://${formatHostForUrl(input.host)}:${input.port}`;
  }
  if (input.mode === "desktop") {
    return `http://localhost:${input.port}`;
  }
  return resolveHeadlessConnectionString(input.host, input.port, interfaces);
};

export const resolveListeningPort = (address: unknown, fallbackPort: number): number => {
  if (
    typeof address === "object" &&
    address !== null &&
    "port" in address &&
    typeof address.port === "number"
  ) {
    return address.port;
  }
  return fallbackPort;
};

export const buildPairingUrl = (connectionString: string, token: string): string => {
  const url = new URL(connectionString);
  url.pathname = "/pair";
  url.searchParams.delete("token");
  url.hash = new URLSearchParams([["token", token]]).toString();
  return url.toString();
};

export const renderTerminalQrCode = (value: string, margin = 2): string => {
  const qrCode = QrCode.encodeText(value, QrCode.Ecc.MEDIUM);
  const rows: Array<string> = [];
  const isDark = (x: number, y: number): boolean =>
    x >= 0 && x < qrCode.size && y >= 0 && y < qrCode.size && qrCode.getModule(x, y);

  for (let y = -margin; y < qrCode.size + margin; y += 2) {
    let row = "";

    for (let x = -margin; x < qrCode.size + margin; x += 1) {
      const topDark = isDark(x, y);
      const bottomDark = isDark(x, y + 1);

      row += topDark ? (bottomDark ? "█" : "▀") : bottomDark ? "▄" : " ";
    }

    rows.push(row);
  }

  return rows.join("\n");
};

export const formatHeadlessServeOutput = (accessInfo: HeadlessServeAccessInfo): string =>
  [
    "Threadlines server is ready.",
    `Connection string: ${accessInfo.connectionString}`,
    `Token: ${accessInfo.token}`,
    `Pairing URL: ${accessInfo.pairingUrl}`,
    "",
    renderTerminalQrCode(accessInfo.pairingUrl),
    "",
  ].join("\n");

export const issueHeadlessServeAccessInfo = Effect.fn("issueHeadlessServeAccessInfo")(function* () {
  const serverConfig = yield* ServerConfig;
  const httpServer = yield* HttpServer.HttpServer;
  const serverAuth = yield* ServerAuth;
  const connectionString = resolveHeadlessConnectionString(
    serverConfig.host,
    resolveListeningPort(httpServer.address, serverConfig.port),
  );
  const issued = yield* serverAuth.issuePairingCredential({ role: "owner" });

  return {
    connectionString,
    token: issued.credential,
    pairingUrl: buildPairingUrl(connectionString, issued.credential),
  } satisfies HeadlessServeAccessInfo;
});
