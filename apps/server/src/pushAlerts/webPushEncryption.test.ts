// @effect-diagnostics nodeBuiltinImport:off
import { createECDH } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { encryptWebPushPayload } from "./webPushEncryption.ts";

const fromBase64Url = (text: string) => Buffer.from(text.replace(/\s+/g, ""), "base64url");

// RFC 8291, section 5 and appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  senderPrivateKey: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  receiverPrivateKey: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  receiverPublicKey:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
    pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};

describe("encryptWebPushPayload", () => {
  it("matches the RFC 8291 example byte for byte", () => {
    const body = encryptWebPushPayload(
      { p256dh: fromBase64Url(RFC.receiverPublicKey), auth: fromBase64Url(RFC.auth) },
      Buffer.from(RFC.plaintext),
      { senderPrivateKey: fromBase64Url(RFC.senderPrivateKey), salt: fromBase64Url(RFC.salt) },
    );
    expect(Buffer.from(body).toString("base64url")).toBe(RFC.body.replace(/\s+/g, ""));
  });

  it("seals each alert with a fresh salt and one-time key", () => {
    const receiver = createECDH("prime256v1");
    receiver.generateKeys();
    const keys = { p256dh: receiver.getPublicKey(), auth: Buffer.alloc(16, 7) };
    const plaintext = Buffer.from("Fix the build");

    const first = Buffer.from(encryptWebPushPayload(keys, plaintext));
    const second = Buffer.from(encryptWebPushPayload(keys, plaintext));

    // Header: salt (16), record size (4), key length (1), the sender's key (65).
    expect(first.length).toBe(second.length);
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false);
    expect(first.subarray(21, 86).equals(second.subarray(21, 86))).toBe(false);
  });
});
