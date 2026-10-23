import { describe, expect, it } from "vite-plus/test";

import { base64UrlDecode, base64UrlEncode } from "../crypto.ts";
import {
  checkPushEndpoint,
  classifyPushResponse,
  importVapidKeyring,
  makeVapidAuthorizer,
  parseDeviceAlertBody,
  parseDevicePushBody,
  readCappedJson,
  vapidAuthorization,
} from "./webPush.ts";

async function makeVapidKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return { jwk: await crypto.subtle.exportKey("jwk", pair.privateKey), verifyKey: pair.publicKey };
}

describe("checkPushEndpoint", () => {
  it("sends only to the push services phones subscribe with", () => {
    for (const endpoint of [
      "https://web.push.apple.com/QGuQyavXutnMsuIk8Z0f",
      "https://api.push.apple.com/3/device/abc",
      "https://fcm.googleapis.com/fcm/send/dQ4w9WgXcQ:APA91b",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB",
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB",
    ]) {
      expect(checkPushEndpoint(endpoint)?.href).toBe(new URL(endpoint).href);
    }
    for (const endpoint of [
      "http://web.push.apple.com/abc",
      "https://web.push.apple.com.example.com/abc",
      "https://evilpush.apple.com/abc",
      "https://example.com/web.push.apple.com",
      "https://169.254.169.254/latest/meta-data",
      "https://web.push.apple.com:8443/abc",
      "https://user:pass@web.push.apple.com/abc",
      `https://web.push.apple.com/${"a".repeat(1100)}`,
      "not a url",
    ]) {
      expect(checkPushEndpoint(endpoint)).toBeNull();
    }
  });
});

describe("VAPID", () => {
  it("signs a token for the push service's origin that its public key verifies", async () => {
    const { jwk, verifyKey } = await makeVapidKeyPair();
    const key = (await importVapidKeyring(JSON.stringify({ nightly: jwk })))?.byChannel.get(
      "nightly",
    );
    expect(key).toBeDefined();
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", verifyKey));
    expect(base64UrlDecode(key!.publicKey)).toEqual(raw);

    const nowMs = Date.UTC(2026, 9, 23, 12, 0, 0);
    const header = await vapidAuthorization(
      key!,
      new URL("https://web.push.apple.com/QGuQyavXutnMsuIk8Z0f"),
      nowMs,
    );
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match?.[4]).toBe(key!.publicKey);
    const [, head, claims, signature] = match!;
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(head!)))).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(claims!)))).toEqual({
      aud: "https://web.push.apple.com",
      exp: nowMs / 1000 + 12 * 60 * 60,
      sub: "https://threadlines.dev",
    });
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      base64UrlDecode(signature!),
      new TextEncoder().encode(`${head}.${claims}`),
    );
    expect(verified).toBe(true);
  });

  it("keeps each channel's key and still signs with retired ones", async () => {
    const [stable, nightly, retired] = await Promise.all([
      makeVapidKeyPair(),
      makeVapidKeyPair(),
      makeVapidKeyPair(),
    ]);
    const keyring = await importVapidKeyring(
      JSON.stringify({ stable: stable.jwk, nightly: nightly.jwk, retired: [retired.jwk] }),
    );
    expect(keyring?.byChannel.size).toBe(2);
    expect(keyring?.byKeyId.size).toBe(3);
    expect(keyring?.byChannel.get("stable")?.keyId).not.toBe(
      keyring?.byChannel.get("nightly")?.keyId,
    );
  });

  it("has no keys when the secret is missing or holds no P-256 private key", async () => {
    expect(await importVapidKeyring(undefined)).toBeNull();
    expect(await importVapidKeyring("not json")).toBeNull();
    expect(
      await importVapidKeyring(JSON.stringify({ stable: { kty: "EC", crv: "P-384" } })),
    ).toBeNull();
  });

  it("signs a new token for a push service at most hourly", async () => {
    const { jwk } = await makeVapidKeyPair();
    const key = (await importVapidKeyring(JSON.stringify({ stable: jwk })))!.byChannel.get(
      "stable",
    )!;
    const authorize = makeVapidAuthorizer();
    const apple = new URL("https://web.push.apple.com/one");
    const nowMs = Date.UTC(2026, 9, 23, 12, 0, 0);
    const HOUR = 60 * 60 * 1000;

    const first = await authorize(key, apple, nowMs);
    expect(await authorize(key, new URL("https://web.push.apple.com/two"), nowMs + 10 * HOUR)).toBe(
      first,
    );
    expect(await authorize(key, new URL("https://fcm.googleapis.com/fcm/send/x"), nowMs)).not.toBe(
      first,
    );
    expect(await authorize(key, apple, nowMs + 11.5 * HOUR)).not.toBe(first);
  });
});

describe("classifyPushResponse", () => {
  it("forgets a dropped subscription, retries a busy service, and drops a bad message", () => {
    expect(classifyPushResponse(201)).toBe("sent");
    expect(classifyPushResponse(410)).toBe("gone");
    expect(classifyPushResponse(404)).toBe("gone");
    expect(classifyPushResponse(429)).toBe("retry");
    expect(classifyPushResponse(503)).toBe("retry");
    expect(classifyPushResponse(413)).toBe("rejected");
    expect(classifyPushResponse(403)).toBe("rejected");
  });
});

describe("push request bodies", () => {
  const kinds = { needs_you: true, finished: true, failed: false };

  it("takes a phone's subscription only for a push service and well-formed switches", () => {
    const body = {
      registrationId: "registration-1",
      endpoint: "https://web.push.apple.com/QGuQyavXutnMsuIk8Z0f",
      keyId: "key-nightly",
      kinds,
      revision: 1_766_000_000_000,
    };
    expect(parseDevicePushBody(body)?.endpoint.hostname).toBe("web.push.apple.com");
    expect(parseDevicePushBody({ ...body, revision: 0 })).toBeNull();
    expect(parseDevicePushBody({ ...body, endpoint: "https://example.com/push" })).toBeNull();
    expect(parseDevicePushBody({ ...body, kinds: { ...kinds, failed: "no" } })).toBeNull();
    expect(parseDevicePushBody({ ...body, registrationId: "short" })).toBeNull();
  });

  it("refuses an alert larger than a push service takes, or a body over the cap", async () => {
    const alert = (payload: Uint8Array) => ({
      registrationId: "registration-1",
      kind: "finished",
      payload: base64UrlEncode(payload),
      ttlSeconds: 600,
      urgency: "normal",
    });
    expect(parseDeviceAlertBody(alert(new Uint8Array(4096)))?.message.payload.length).toBe(4096);
    expect(parseDeviceAlertBody(alert(new Uint8Array(4097)))).toBeNull();
    expect(parseDeviceAlertBody({ ...alert(new Uint8Array(10)), ttlSeconds: 7200 })).toBeNull();
    expect(parseDeviceAlertBody({ ...alert(new Uint8Array(10)), kind: "everything" })).toBeNull();

    const post = (text: string) =>
      new Request("https://relay.test/x", { method: "POST", body: text });
    expect(await readCappedJson(post(JSON.stringify({ ok: true })), 100)).toEqual({ ok: true });
    expect(await readCappedJson(post(JSON.stringify({ big: "x".repeat(200) })), 100)).toBeNull();
  });
});
