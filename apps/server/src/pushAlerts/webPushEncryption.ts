// @effect-diagnostics nodeBuiltinImport:off
/**
 * Sealing a push alert for one phone (RFC 8291, "aes128gcm" content coding
 * from RFC 8188). The phone's browser made the key pair and the auth secret
 * when it subscribed and gave us the public half; only it can open what this
 * produces. The relay and the push service carry the bytes without reading
 * them.
 */
import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";

/** One record holds the whole alert: alerts are small (a push service takes 4 KB). */
const RECORD_SIZE = 4096;
const KEY_INFO_PREFIX = Buffer.from("WebPush: info\0", "latin1");
const CEK_INFO = Buffer.from("Content-Encoding: aes128gcm\0\x01", "latin1");
const NONCE_INFO = Buffer.from("Content-Encoding: nonce\0\x01", "latin1");
/** Delimiter after the last (here: only) record's plaintext. */
const LAST_RECORD_DELIMITER = 0x02;

export interface WebPushSubscriptionKeys {
  /** The browser's P-256 public key, uncompressed (65 bytes). */
  readonly p256dh: Uint8Array;
  /** The browser's 16-byte authentication secret. */
  readonly auth: Uint8Array;
}

/** Fixed inputs for tests; real alerts take a fresh key and salt each time. */
export interface WebPushEncryptionSeed {
  readonly senderPrivateKey: Uint8Array;
  readonly salt: Uint8Array;
}

const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest();

/**
 * The request body for one push message: an aes128gcm header (salt, record
 * size, the sender's one-time public key) followed by the sealed plaintext.
 */
export function encryptWebPushPayload(
  keys: WebPushSubscriptionKeys,
  plaintext: Uint8Array,
  seed?: WebPushEncryptionSeed,
): Uint8Array {
  if (keys.p256dh.length !== 65 || keys.p256dh[0] !== 0x04) {
    throw new Error("The subscription's p256dh key isn't an uncompressed P-256 point.");
  }
  if (keys.auth.length !== 16) {
    throw new Error("The subscription's auth secret isn't 16 bytes.");
  }
  const sender = createECDH("prime256v1");
  if (seed) sender.setPrivateKey(seed.senderPrivateKey);
  else sender.generateKeys();
  const senderPublicKey = sender.getPublicKey();
  const salt = seed?.salt ?? randomBytes(16);

  const ecdhSecret = sender.computeSecret(keys.p256dh);
  const keyInfo = Buffer.concat([KEY_INFO_PREFIX, keys.p256dh, senderPublicKey, Buffer.of(1)]);
  const ikm = hmac(hmac(keys.auth, ecdhSecret), keyInfo);
  const prk = hmac(salt, ikm);
  const contentKey = hmac(prk, CEK_INFO).subarray(0, 16);
  const nonce = hmac(prk, NONCE_INFO).subarray(0, 12);

  if (plaintext.length + 1 + 16 > RECORD_SIZE) {
    throw new Error("The alert is too large for one push message.");
  }
  const cipher = createCipheriv("aes-128-gcm", contentKey, nonce);
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.of(LAST_RECORD_DELIMITER)])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(16 + 4 + 1);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublicKey.length, 20);
  return Buffer.concat([header, senderPublicKey, sealed]);
}
