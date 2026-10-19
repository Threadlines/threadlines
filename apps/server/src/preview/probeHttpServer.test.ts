import { createServer } from "node:http";
import { describe, expect, it } from "vite-plus/test";

import { extractHtmlTitle, isHtmlContentType, probeHttpServer } from "./probeHttpServer.ts";

describe("extractHtmlTitle", () => {
  it("reads a title across attributes and newlines", () => {
    expect(extractHtmlTitle('<html><head><title data-x="1">My\n  Dev App</title>')).toBe(
      "My Dev App",
    );
  });

  it("returns null when there is no usable title", () => {
    expect(extractHtmlTitle("<html><head></head>")).toBeNull();
    expect(extractHtmlTitle("<title>   </title>")).toBeNull();
  });
});

describe("probeHttpServer", () => {
  it("reaches a server bound only to the IPv6 loopback", async () => {
    // Node resolving "localhost" to ::1 leaves dev servers refusing 127.0.0.1;
    // the probe must connect to the address the listener is actually on.
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><head><title>Dev App</title></head></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "::1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server did not report a port");
    }

    try {
      expect(await probeHttpServer(address.port, "::1")).toEqual({ title: "Dev App" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("isHtmlContentType", () => {
  it("accepts html with a charset", () => {
    expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
  });

  it("rejects everything else, including a missing header", () => {
    // AirPlay answers without a content type; an API serves JSON. Neither is a
    // page you would open in the preview.
    expect(isHtmlContentType(undefined)).toBe(false);
    expect(isHtmlContentType("application/json")).toBe(false);
  });
});
