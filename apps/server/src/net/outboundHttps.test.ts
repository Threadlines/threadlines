import * as net from "node:net";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  checkOutboundUrl,
  isBlockedAddress,
  postOutbound,
  postToAddresses,
} from "./outboundHttps.ts";

describe("outbound calls", () => {
  it("refuses private, loopback, link-local, CGNAT, NAT64 and mapped addresses", () => {
    const refused = [
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254",
      "100.100.1.1",
      "172.16.0.1",
      "192.168.1.1",
      "0.0.0.0",
      "224.0.0.1",
      "::",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
      "64:ff9b::10.0.0.1",
      "64:ff9b::a9fe:a9fe",
      "2002:a00:1::",
      "not-an-address",
    ];
    const allowed = ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"];
    expect(refused.filter((address) => !isBlockedAddress(address))).toEqual([]);
    expect(allowed.filter((address) => isBlockedAddress(address))).toEqual([]);
  });

  it("takes https addresses only, without a user or password", async () => {
    expect(() => checkOutboundUrl("http://alerts.example/hook")).toThrow("https://");
    expect(() => checkOutboundUrl("https://me:secret@alerts.example/hook")).toThrow("password");
    expect(checkOutboundUrl(" https://alerts.example/hook?x=1 ").href).toBe(
      "https://alerts.example/hook?x=1",
    );
    // A name for this computer is refused before anything is sent.
    const result = await Effect.runPromise(
      postOutbound({ url: "https://localhost:1/hook", headers: {}, body: "{}" }),
    );
    expect(result).toMatchObject({ type: "not_sent" });
  });

  it("connects only to the checked address, and gives up in time without sending twice", async () => {
    // Accepts the connection and never answers TLS: the call goes to this
    // address though the URL's host resolves nowhere.
    const connections: Array<string> = [];
    const server = net.createServer((socket) => {
      connections.push(socket.remoteAddress ?? "");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      const result = await Effect.runPromise(
        postToAddresses(
          new URL(`https://alerts.invalid:${port}/hook`),
          [{ address: "127.0.0.1", family: 4 }],
          { headers: {}, body: "{}" },
          300,
        ),
      );
      expect(connections.length).toBe(1);
      // TLS never came up, so the receiver can't have read it: safe to try again.
      expect(result).toEqual({ type: "not_sent", detail: "Couldn't connect in time." });
    } finally {
      server.close();
    }
  });
});
