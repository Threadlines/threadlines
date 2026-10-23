import { assert, describe, it } from "@effect/vitest";

import { outsideAgentOrigin } from "./OutsideAgentConnections.ts";

describe("outsideAgentOrigin", () => {
  const local = { port: 3773, remoteAddress: "127.0.0.1", headers: {} };

  it("takes this computer's loopback names on the server's port", () => {
    assert.strictEqual(
      outsideAgentOrigin({ ...local, host: "127.0.0.1:3773" }),
      "http://127.0.0.1:3773",
    );
    assert.strictEqual(
      outsideAgentOrigin({ ...local, host: "LOCALHOST:3773", remoteAddress: "::1" }),
      "http://localhost:3773",
    );
    assert.strictEqual(outsideAgentOrigin({ ...local, host: "[::1]:3773" }), "http://[::1]:3773");
  });

  it("refuses anything that didn't come from this computer", () => {
    // A LAN client reaching a network-exposed server, claiming loopback.
    assert.isNull(
      outsideAgentOrigin({ ...local, host: "127.0.0.1:3773", remoteAddress: "192.168.1.20" }),
    );
    // Tailscale Serve connects from loopback on someone else's behalf.
    assert.isNull(
      outsideAgentOrigin({
        ...local,
        host: "127.0.0.1:3773",
        headers: { "tailscale-user-login": "someone@example.com" },
      }),
    );
    assert.isNull(
      outsideAgentOrigin({
        ...local,
        host: "127.0.0.1:3773",
        headers: { "x-forwarded-for": "1.2.3.4" },
      }),
    );
    // A DNS-rebinding page, another port, no Host, an unknown socket.
    assert.isNull(outsideAgentOrigin({ ...local, host: "evil.example:3773" }));
    assert.isNull(outsideAgentOrigin({ ...local, host: "127.0.0.1:3774" }));
    assert.isNull(outsideAgentOrigin({ ...local, host: undefined }));
    assert.isNull(
      outsideAgentOrigin({ ...local, host: "127.0.0.1:3773", remoteAddress: undefined }),
    );
  });
});
