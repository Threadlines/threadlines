/**
 * Seals an event task's webhook delivery to its computer's hook key, so a
 * delivery waiting at the relay (docs/design/event-tasks.md) can't be read in
 * relay storage. The relay seals (it holds only the public key); the server
 * opens. It is not a secret from the relay itself, which sees each request
 * while it handles it; the sender's own signature, checked on the computer,
 * is what proves who sent it.
 *
 * Envelope: `v1.<ephemeral public key>.<iv>.<ciphertext>`, each base64url. The
 * AES-256-GCM key is HKDF-SHA256 of the ECDH secret between a fresh P-256 key
 * and the host's, salted with the fresh public key; the additional data binds
 * host, hook and delivery, so a sealed delivery can't be passed off as
 * another's.
 *
 * Pure WebCrypto: runs in the relay worker and in the server alike.
 */
import {
  type Bytes,
  type StoredKeyPair,
  fromBase64Url,
  fromUtf8,
  loadStoredKeyPair,
  P256,
  toBase64Url,
  utf8,
} from "./relaySecure.ts";

const ENVELOPE_VERSION = "v1";
const HKDF_INFO = utf8("threadlines-hook-v1");
const IV_BYTES = 12;

/** One webhook request as the relay received it. */
export interface HookPayload {
  readonly method: string;
  /** The query string without its `?`; empty when there was none. */
  readonly query: string;
  /** The kept headers, names lowercased. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly receivedAt: string;
}

/** The additional data a delivery is sealed with. */
export function hookDeliveryAad(hostId: string, hookId: string, deliveryId: string): Bytes {
  return utf8(`threadlines-hook-v1|${hostId}|${hookId}|${deliveryId}`);
}

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

function copy(bytes: Uint8Array): Bytes {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

async function aesKey(sharedSecret: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const material = await subtle().importKey("raw", copy(sharedSecret), "HKDF", false, [
    "deriveKey",
  ]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: copy(salt), info: HKDF_INFO },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function encodePayload(payload: HookPayload): Bytes {
  return utf8(
    JSON.stringify({
      m: payload.method,
      q: payload.query,
      h: payload.headers,
      b: toBase64Url(payload.body),
      r: payload.receivedAt,
    }),
  );
}

function decodePayload(bytes: Uint8Array): HookPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const headers = record["h"];
  if (
    typeof record["m"] !== "string" ||
    typeof record["q"] !== "string" ||
    typeof record["b"] !== "string" ||
    typeof record["r"] !== "string" ||
    typeof headers !== "object" ||
    headers === null ||
    Object.values(headers).some((value) => typeof value !== "string")
  ) {
    return null;
  }
  const body = fromBase64Url(record["b"]);
  if (body === null) return null;
  return {
    method: record["m"],
    query: record["q"],
    headers: headers as Record<string, string>,
    body,
    receivedAt: record["r"],
  };
}

/** Seals `payload` to the host's hook public key (raw P-256, base64url). */
export async function sealHookDelivery(input: {
  readonly publicKey: string;
  readonly aad: Uint8Array;
  readonly payload: HookPayload;
}): Promise<string> {
  const raw = fromBase64Url(input.publicKey);
  if (raw === null) throw new Error("Invalid hook public key.");
  const hostKey = await P256.importPublicKey(raw);
  const ephemeral = await P256.generateKeyPair();
  const key = await aesKey(await P256.dh(ephemeral.privateKey, hostKey), ephemeral.publicKey);
  const iv = new Uint8Array(IV_BYTES);
  globalThis.crypto.getRandomValues(iv);
  const ciphertext = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv, additionalData: copy(input.aad) },
      key,
      encodePayload(input.payload),
    ),
  );
  return [
    ENVELOPE_VERSION,
    toBase64Url(ephemeral.publicKey),
    toBase64Url(iv),
    toBase64Url(ciphertext),
  ].join(".");
}

/** Opens a sealed delivery with the host's hook key pair; null if it doesn't open. */
export async function openHookDelivery(input: {
  readonly keyPair: StoredKeyPair;
  readonly aad: Uint8Array;
  readonly envelope: string;
}): Promise<HookPayload | null> {
  const [version, ephemeralText, ivText, ciphertextText, extra] = input.envelope.split(".");
  if (version !== ENVELOPE_VERSION || extra !== undefined) return null;
  const ephemeralRaw = fromBase64Url(ephemeralText ?? "");
  const iv = fromBase64Url(ivText ?? "");
  const ciphertext = fromBase64Url(ciphertextText ?? "");
  if (!ephemeralRaw || !iv || iv.length !== IV_BYTES || !ciphertext) return null;
  try {
    const own = await loadStoredKeyPair(input.keyPair);
    const ephemeral = await P256.importPublicKey(ephemeralRaw);
    const key = await aesKey(await P256.dh(own.privateKey, ephemeral), ephemeralRaw);
    const plaintext = new Uint8Array(
      await subtle().decrypt(
        { name: "AES-GCM", iv, additionalData: copy(input.aad) },
        key,
        ciphertext,
      ),
    );
    return decodePayload(plaintext);
  } catch {
    return null;
  }
}
