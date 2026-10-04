/**
 * End-to-end encryption for "Connect a device" connections, shared by the
 * server (host side) and the web app (device side). The relay, and anything
 * else between the two, only ever sees ciphertext and can't impersonate either
 * side.
 *
 * - Handshake: the Noise KK pattern (both static keys are known from pairing),
 *   the device as initiator. Suite: ECDH P-256, AES-256-GCM, SHA-256 through
 *   WebCrypto, which browsers, Electron, and Node all have. P-256 public keys
 *   are 65-byte uncompressed SEC1 points (WebCrypto rejects invalid points on
 *   import); DH output is 32 bytes. The DH is pluggable so tests can run the
 *   same code as Noise_KK_25519_AESGCM_SHA256 against a reference
 *   implementation.
 * - Transport: one AES-GCM cipher per direction with Noise's counter nonce.
 *   The receiver only accepts the exact next counter, so a dropped, reordered,
 *   or replayed message fails to decrypt. Unlike Noise transport messages
 *   there's no 65535-byte cap: a message is one whole RPC frame.
 * - Wire: binary WebSocket frames, a type byte and a payload. A message is
 *   split into parts below Cloudflare's 1 MiB message cap. Inside encryption
 *   each message is a record: app text, or the channel's own confirm,
 *   keepalive, and ack.
 * - Pairing: the commitment-based match number for code joins and the claim
 *   proof for QR joins (see `pairingMatchNumber` and `claimProof`).
 */

export type Bytes = Uint8Array<ArrayBuffer>;
type Subtle = typeof globalThis.crypto.subtle;
export type SecureKey = Awaited<ReturnType<Subtle["importKey"]>>;

const subtle = (): Subtle => globalThis.crypto.subtle;

// ----- bytes ------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(text: string): Bytes {
  const encoded = textEncoder.encode(text);
  const bytes = new Uint8Array(encoded.length);
  bytes.set(encoded);
  return bytes;
}

export function fromUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function concatBytes(...parts: ReadonlyArray<Uint8Array>): Bytes {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Concatenation that can't be read two ways: each field is length-prefixed. */
function framed(...fields: ReadonlyArray<Uint8Array>): Bytes {
  const parts: Array<Uint8Array> = [];
  for (const field of fields) {
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, field.length);
    parts.push(length, field);
  }
  return concatBytes(...parts);
}

function copyBytes(view: Uint8Array): Bytes {
  const out = new Uint8Array(view.length);
  out.set(view);
  return out;
}

export function randomBytes(length: number): Bytes {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** Decodes base64url; null for anything that isn't. */
export function fromBase64Url(text: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/gu, "+").replace(/_/gu, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/** Compares without stopping at the first difference. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

// ----- primitives ---------------------------------------------------------------

export async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle().digest("SHA-256", copyBytes(data)));
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const imported = await subtle().importKey(
    "raw",
    copyBytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await subtle().sign("HMAC", imported, copyBytes(data)));
}

/** Noise's HKDF: two outputs keyed by the chaining key. */
async function hkdf2(chainingKey: Bytes, inputKeyMaterial: Uint8Array): Promise<[Bytes, Bytes]> {
  const tempKey = await hmacSha256(chainingKey, inputKeyMaterial);
  const output1 = await hmacSha256(tempKey, new Uint8Array([0x01]));
  const output2 = await hmacSha256(tempKey, concatBytes(output1, new Uint8Array([0x02])));
  return [output1, output2];
}

// ----- DH functions -------------------------------------------------------------

export interface NoiseKeyPair {
  readonly privateKey: SecureKey;
  /** Raw public key bytes, as they go on the wire. */
  readonly publicKey: Bytes;
}

export interface NoiseDh {
  /** The DH name in the Noise protocol name. */
  readonly name: string;
  readonly publicKeyLength: number;
  readonly generateKeyPair: () => Promise<NoiseKeyPair>;
  /** Imports a peer's raw public key; throws for anything that isn't a valid point. */
  readonly importPublicKey: (raw: Uint8Array) => Promise<SecureKey>;
  readonly importKeyPair: (
    privatePkcs8: Uint8Array,
    publicKey: Uint8Array,
  ) => Promise<NoiseKeyPair>;
  readonly dh: (privateKey: SecureKey, publicKey: SecureKey) => Promise<Bytes>;
}

function makeDh(input: {
  readonly name: string;
  readonly publicKeyLength: number;
  readonly algorithm: { readonly name: string; readonly namedCurve?: string };
  readonly isValidRawPublicKey: (raw: Uint8Array) => boolean;
}): NoiseDh {
  const algorithm = input.algorithm;
  const deriveName = algorithm.name;
  const importPublicKey = async (raw: Uint8Array) => {
    if (raw.length !== input.publicKeyLength || !input.isValidRawPublicKey(raw)) {
      throw new Error("Invalid public key.");
    }
    return subtle().importKey("raw", copyBytes(raw), algorithm, true, []);
  };
  return {
    name: input.name,
    publicKeyLength: input.publicKeyLength,
    importPublicKey,
    generateKeyPair: async () => {
      const pair = (await subtle().generateKey(algorithm, true, ["deriveBits"])) as {
        readonly privateKey: SecureKey;
        readonly publicKey: SecureKey;
      };
      const publicKey = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
      return { privateKey: pair.privateKey, publicKey };
    },
    importKeyPair: async (privatePkcs8, publicKey) => {
      // Validates the public half too, so a corrupt stored key fails loudly.
      await importPublicKey(publicKey);
      const privateKey = await subtle().importKey(
        "pkcs8",
        copyBytes(privatePkcs8),
        algorithm,
        true,
        ["deriveBits"],
      );
      return { privateKey, publicKey: copyBytes(publicKey) };
    },
    dh: async (privateKey, publicKey) =>
      new Uint8Array(
        await subtle().deriveBits({ name: deriveName, public: publicKey }, privateKey, 256),
      ),
  };
}

/** Production DH: P-256, 65-byte uncompressed public keys. */
export const P256: NoiseDh = makeDh({
  name: "P256",
  publicKeyLength: 65,
  algorithm: { name: "ECDH", namedCurve: "P-256" },
  isValidRawPublicKey: (raw) => raw[0] === 0x04,
});

/** X25519, used to check the Noise code against a reference implementation. */
export const X25519: NoiseDh = makeDh({
  name: "25519",
  publicKeyLength: 32,
  algorithm: { name: "X25519" },
  isValidRawPublicKey: () => true,
});

export async function exportPrivateKey(keyPair: NoiseKeyPair): Promise<Bytes> {
  return new Uint8Array(await subtle().exportKey("pkcs8", keyPair.privateKey));
}

// ----- Noise state objects ---------------------------------------------------------

const TAG_BYTES = 16;
const EMPTY: Bytes = new Uint8Array(0);

/** A Noise CipherState over AES-256-GCM. Decryption only accepts the next counter. */
export class CipherState {
  private key: SecureKey | null = null;
  private nonce = 0;

  static async withKey(raw: Uint8Array): Promise<CipherState> {
    const state = new CipherState();
    await state.initializeKey(raw);
    return state;
  }

  async initializeKey(raw: Uint8Array): Promise<void> {
    this.key = await subtle().importKey("raw", copyBytes(raw), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    this.nonce = 0;
  }

  hasKey(): boolean {
    return this.key !== null;
  }

  private iv(): Bytes {
    // Noise's AESGCM nonce: 32 zero bits, then the counter as 64-bit big-endian.
    const iv = new Uint8Array(12);
    const view = new DataView(iv.buffer);
    view.setUint32(4, Math.floor(this.nonce / 0x1_0000_0000));
    view.setUint32(8, this.nonce >>> 0);
    return iv;
  }

  async encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Promise<Bytes> {
    if (!this.key) return copyBytes(plaintext);
    const ciphertext = new Uint8Array(
      await subtle().encrypt(
        { name: "AES-GCM", iv: this.iv(), additionalData: copyBytes(ad), tagLength: 128 },
        this.key,
        copyBytes(plaintext),
      ),
    );
    this.nonce += 1;
    return ciphertext;
  }

  async decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Promise<Bytes> {
    if (!this.key) return copyBytes(ciphertext);
    const plaintext = new Uint8Array(
      await subtle().decrypt(
        { name: "AES-GCM", iv: this.iv(), additionalData: copyBytes(ad), tagLength: 128 },
        this.key,
        copyBytes(ciphertext),
      ),
    );
    this.nonce += 1;
    return plaintext;
  }
}

class SymmetricState {
  private chainingKey: Bytes;
  hash: Bytes;
  private readonly cipher = new CipherState();

  private constructor(initial: Bytes) {
    this.chainingKey = initial;
    this.hash = initial;
  }

  static async initialize(protocolName: string): Promise<SymmetricState> {
    const name = utf8(protocolName);
    if (name.length <= 32) {
      const padded = new Uint8Array(32);
      padded.set(name);
      return new SymmetricState(padded);
    }
    return new SymmetricState(await sha256(name));
  }

  async mixKey(inputKeyMaterial: Uint8Array): Promise<void> {
    const [chainingKey, tempKey] = await hkdf2(this.chainingKey, inputKeyMaterial);
    this.chainingKey = chainingKey;
    await this.cipher.initializeKey(tempKey);
  }

  async mixHash(data: Uint8Array): Promise<void> {
    this.hash = await sha256(concatBytes(this.hash, data));
  }

  async encryptAndHash(plaintext: Uint8Array): Promise<Bytes> {
    const ciphertext = await this.cipher.encryptWithAd(this.hash, plaintext);
    await this.mixHash(ciphertext);
    return ciphertext;
  }

  async decryptAndHash(ciphertext: Uint8Array): Promise<Bytes> {
    const plaintext = await this.cipher.decryptWithAd(this.hash, ciphertext);
    await this.mixHash(ciphertext);
    return plaintext;
  }

  async split(): Promise<[CipherState, CipherState]> {
    const [first, second] = await hkdf2(this.chainingKey, EMPTY);
    return [await CipherState.withKey(first), await CipherState.withKey(second)];
  }
}

// ----- Noise KK ----------------------------------------------------------------------

export const SECURE_PROTOCOL_NAME = "Noise_KK_P256_AESGCM_SHA256";

export interface SecureTransport {
  readonly send: CipherState;
  readonly receive: CipherState;
  /** The handshake hash; identical on both sides of a completed handshake. */
  readonly handshakeHash: Bytes;
}

export interface KKOptions {
  readonly staticKeyPair: NoiseKeyPair;
  readonly remoteStaticPublicKey: Uint8Array;
  readonly prologue: Uint8Array;
  readonly dh?: NoiseDh;
  readonly protocolName?: string;
  /** Only for tests with fixed vectors. */
  readonly ephemeralKeyPair?: NoiseKeyPair;
}

async function initializeKK(options: KKOptions, initiator: boolean) {
  const dh = options.dh ?? P256;
  const state = await SymmetricState.initialize(options.protocolName ?? SECURE_PROTOCOL_NAME);
  await state.mixHash(options.prologue);
  // Pre-messages: "-> s" then "<- s".
  const initiatorStatic = initiator
    ? options.staticKeyPair.publicKey
    : options.remoteStaticPublicKey;
  const responderStatic = initiator
    ? options.remoteStaticPublicKey
    : options.staticKeyPair.publicKey;
  await state.mixHash(initiatorStatic);
  await state.mixHash(responderStatic);
  const remoteStatic = await dh.importPublicKey(options.remoteStaticPublicKey);
  const ephemeral = options.ephemeralKeyPair ?? (await dh.generateKeyPair());
  return { dh, state, remoteStatic, ephemeral };
}

/** Size of a KK handshake message with an empty payload. */
export function kkMessageLength(dh: NoiseDh = P256, payloadLength = 0): number {
  return dh.publicKeyLength + payloadLength + TAG_BYTES;
}

/** Device side: `-> e, es, ss` then `<- e, ee, se`. */
export async function startKKInitiator(options: KKOptions) {
  const { dh, state, remoteStatic, ephemeral } = await initializeKK(options, true);
  const staticPrivate = options.staticKeyPair.privateKey;
  return {
    writeMessage1: async (payload: Uint8Array = EMPTY): Promise<Bytes> => {
      await state.mixHash(ephemeral.publicKey);
      await state.mixKey(await dh.dh(ephemeral.privateKey, remoteStatic)); // es
      await state.mixKey(await dh.dh(staticPrivate, remoteStatic)); // ss
      return concatBytes(ephemeral.publicKey, await state.encryptAndHash(payload));
    },
    readMessage2: async (
      message: Uint8Array,
    ): Promise<{ readonly payload: Bytes; readonly transport: SecureTransport }> => {
      if (message.length < dh.publicKeyLength + TAG_BYTES) throw new Error("Short handshake.");
      const remoteEphemeralRaw = message.subarray(0, dh.publicKeyLength);
      const remoteEphemeral = await dh.importPublicKey(remoteEphemeralRaw);
      await state.mixHash(remoteEphemeralRaw);
      await state.mixKey(await dh.dh(ephemeral.privateKey, remoteEphemeral)); // ee
      await state.mixKey(await dh.dh(staticPrivate, remoteEphemeral)); // se
      const payload = await state.decryptAndHash(message.subarray(dh.publicKeyLength));
      const [first, second] = await state.split();
      return { payload, transport: { send: first, receive: second, handshakeHash: state.hash } };
    },
  };
}

/** Host side of the same handshake. */
export async function startKKResponder(options: KKOptions) {
  const { dh, state, remoteStatic, ephemeral } = await initializeKK(options, false);
  const staticPrivate = options.staticKeyPair.privateKey;
  let remoteEphemeral: SecureKey | null = null;
  return {
    readMessage1: async (message: Uint8Array): Promise<Bytes> => {
      if (message.length < dh.publicKeyLength + TAG_BYTES) throw new Error("Short handshake.");
      const remoteEphemeralRaw = message.subarray(0, dh.publicKeyLength);
      remoteEphemeral = await dh.importPublicKey(remoteEphemeralRaw);
      await state.mixHash(remoteEphemeralRaw);
      await state.mixKey(await dh.dh(staticPrivate, remoteEphemeral)); // es
      await state.mixKey(await dh.dh(staticPrivate, remoteStatic)); // ss
      return state.decryptAndHash(message.subarray(dh.publicKeyLength));
    },
    writeMessage2: async (
      payload: Uint8Array = EMPTY,
    ): Promise<{ readonly message: Bytes; readonly transport: SecureTransport }> => {
      if (!remoteEphemeral) throw new Error("Read message 1 first.");
      await state.mixHash(ephemeral.publicKey);
      await state.mixKey(await dh.dh(ephemeral.privateKey, remoteEphemeral)); // ee
      await state.mixKey(await dh.dh(ephemeral.privateKey, remoteStatic)); // se
      const message = concatBytes(ephemeral.publicKey, await state.encryptAndHash(payload));
      const [first, second] = await state.split();
      return { message, transport: { send: second, receive: first, handshakeHash: state.hash } };
    },
  };
}

/** Binds a handshake to one host and one device. */
export function securePrologue(hostId: string, deviceId: string): Bytes {
  return framed(utf8("threadlines-relay-e2e-v1"), utf8(hostId), utf8(deviceId));
}

// ----- frames and records ----------------------------------------------------------------

export const SECURE_FRAME_HANDSHAKE = 0x01;
export const SECURE_FRAME_DATA_FINAL = 0x02;
export const SECURE_FRAME_DATA_PART = 0x03;
/** Encrypted message parts stay well under Cloudflare's 1 MiB message cap. */
export const SECURE_PART_BYTES = 512 * 1024;
/** Above the largest legitimate RPC frame (8 attachments at 14M data-url chars). */
export const SECURE_MAX_MESSAGE_BYTES = 200 * 1024 * 1024;
/**
 * With a first-message cap set: what may queue up behind that first message
 * before it has decrypted (a client's first requests follow its confirm
 * straight away).
 */
const PRE_FIRST_RECORD_BACKLOG_BYTES = 16 * 1024 * 1024;

export const SECURE_RECORD_APP = 0x00;
export const SECURE_RECORD_CONFIRM = 0x01;
export const SECURE_RECORD_KEEPALIVE = 0x02;
export const SECURE_RECORD_ACK = 0x03;

export const SECURE_CONFIRM_SESSION = 0x01;
export const SECURE_CONFIRM_PROBE = 0x02;

export function handshakeFrame(message: Uint8Array): Bytes {
  return concatBytes(new Uint8Array([SECURE_FRAME_HANDSHAKE]), message);
}

/** The handshake message in a frame, or null unless it's exactly the expected size. */
export function readHandshakeFrame(frame: Uint8Array, expectedLength: number): Bytes | null {
  if (frame.length !== expectedLength + 1 || frame[0] !== SECURE_FRAME_HANDSHAKE) return null;
  return copyBytes(frame.subarray(1));
}

/** Turns WebSocket message data into bytes; null for text frames. */
export function binaryFrameBytes(data: unknown): Bytes | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return copyBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return null;
}

/**
 * Encrypted records over binary frames after the handshake. Sends and receives
 * each run through one queue, so frames go out and come in in order even
 * though WebCrypto is asynchronous. Any bad frame stops the stream and reports
 * an error; the owner closes the socket.
 */
export class SecureStream {
  private sendQueue: Promise<void> = Promise.resolve();
  private receiveQueue: Promise<void> = Promise.resolve();
  private parts: Array<Bytes> = [];
  private partBytes = 0;
  /** Ciphertext waiting in the decrypt queue. */
  private queuedBytes = 0;
  private messagesAssembled = 0;
  private firstRecordSeen = false;
  private readonly firstMessageMaxBytes: number;
  private readonly guardFirstRecord: boolean;
  private stopped = false;
  private readonly transport: SecureTransport;
  private readonly sendFrame: (frame: Bytes) => void;
  private readonly onRecord: (type: number, body: Bytes) => void;
  private readonly onError: (reason: string) => void;

  constructor(input: {
    readonly transport: SecureTransport;
    readonly sendFrame: (frame: Bytes) => void;
    readonly onRecord: (type: number, body: Bytes) => void;
    readonly onError: (reason: string) => void;
    /**
     * Caps the first incoming message. The host sets it to confirm size: until
     * the device's first record decrypts, the peer may be a replayed
     * handshake, and nothing larger is buffered for it.
     */
    readonly firstMessageMaxBytes?: number;
  }) {
    this.firstMessageMaxBytes = input.firstMessageMaxBytes ?? SECURE_MAX_MESSAGE_BYTES;
    this.guardFirstRecord = input.firstMessageMaxBytes !== undefined;
    this.transport = input.transport;
    this.sendFrame = input.sendFrame;
    this.onRecord = input.onRecord;
    this.onError = input.onError;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  stop(): void {
    this.stopped = true;
    this.parts = [];
    this.partBytes = 0;
  }

  private fail(reason: string): void {
    if (this.stopped) return;
    this.stop();
    this.onError(reason);
  }

  sendRecord(type: number, body: Uint8Array = EMPTY): void {
    const record = concatBytes(new Uint8Array([type]), body);
    this.sendQueue = this.sendQueue.then(async () => {
      if (this.stopped) return;
      let ciphertext: Bytes;
      try {
        ciphertext = await this.transport.send.encryptWithAd(EMPTY, record);
      } catch {
        this.fail("Couldn't encrypt a message.");
        return;
      }
      if (this.stopped) return;
      for (let offset = 0; offset < ciphertext.length; offset += SECURE_PART_BYTES) {
        const end = Math.min(offset + SECURE_PART_BYTES, ciphertext.length);
        const type = end === ciphertext.length ? SECURE_FRAME_DATA_FINAL : SECURE_FRAME_DATA_PART;
        this.sendFrame(concatBytes(new Uint8Array([type]), ciphertext.subarray(offset, end)));
      }
    });
  }

  sendText(text: string): void {
    this.sendRecord(SECURE_RECORD_APP, utf8(text));
  }

  receiveFrame(frame: Uint8Array): void {
    if (this.stopped) return;
    const type = frame[0];
    if (type !== SECURE_FRAME_DATA_PART && type !== SECURE_FRAME_DATA_FINAL) {
      this.fail("Unexpected frame.");
      return;
    }
    // Senders split at exactly SECURE_PART_BYTES, so every part but the last
    // is full size; anything else is garbage and would only pad the buffer.
    const payloadLength = frame.length - 1;
    if (
      (type === SECURE_FRAME_DATA_PART && payloadLength !== SECURE_PART_BYTES) ||
      (type === SECURE_FRAME_DATA_FINAL &&
        (payloadLength === 0 || payloadLength > SECURE_PART_BYTES))
    ) {
      this.fail("Malformed message part.");
      return;
    }
    // The first message must fit the first-message cap. When the caller set
    // one (the host, expecting a tiny confirm), whatever follows may only
    // build up a small backlog until that first record decrypts. Otherwise,
    // and afterwards, the backlog waiting to decrypt is held to about one
    // maximum message.
    const messageCap =
      this.messagesAssembled === 0 ? this.firstMessageMaxBytes : SECURE_MAX_MESSAGE_BYTES;
    const backlogCap =
      this.guardFirstRecord && !this.firstRecordSeen
        ? PRE_FIRST_RECORD_BACKLOG_BYTES
        : SECURE_MAX_MESSAGE_BYTES + 2 * SECURE_PART_BYTES;
    this.partBytes += payloadLength;
    if (
      this.partBytes > messageCap + TAG_BYTES + 1 ||
      this.queuedBytes + this.partBytes > backlogCap
    ) {
      this.fail("Message too large.");
      return;
    }
    this.parts.push(copyBytes(frame.subarray(1)));
    if (type === SECURE_FRAME_DATA_PART) return;
    const ciphertext = concatBytes(...this.parts);
    this.parts = [];
    this.partBytes = 0;
    this.messagesAssembled += 1;
    this.queuedBytes += ciphertext.length;
    this.receiveQueue = this.receiveQueue.then(async () => {
      this.queuedBytes -= ciphertext.length;
      if (this.stopped) return;
      let record: Bytes;
      try {
        record = await this.transport.receive.decryptWithAd(EMPTY, ciphertext);
      } catch {
        this.fail("A message failed to decrypt.");
        return;
      }
      if (this.stopped || record.length === 0) {
        if (record.length === 0) this.fail("Empty record.");
        return;
      }
      this.firstRecordSeen = true;
      this.onRecord(record[0]!, record.subarray(1));
    });
  }
}

// ----- keys --------------------------------------------------------------------------------

/** A static key pair as stored: pkcs8 private key and raw public key, base64url. */
export interface StoredKeyPair {
  readonly privateKey: string;
  readonly publicKey: string;
}

export async function generateStoredKeyPair(dh: NoiseDh = P256): Promise<StoredKeyPair> {
  const pair = await dh.generateKeyPair();
  return {
    privateKey: toBase64Url(await exportPrivateKey(pair)),
    publicKey: toBase64Url(pair.publicKey),
  };
}

export async function loadStoredKeyPair(
  stored: StoredKeyPair,
  dh: NoiseDh = P256,
): Promise<NoiseKeyPair> {
  const privateKey = fromBase64Url(stored.privateKey);
  const publicKey = fromBase64Url(stored.publicKey);
  if (!privateKey || !publicKey) throw new Error("Invalid stored key.");
  return dh.importKeyPair(privateKey, publicKey);
}

/** Decodes a public key and checks it's a valid point; null otherwise. */
export async function decodePublicKey(text: string, dh: NoiseDh = P256): Promise<Bytes | null> {
  const raw = fromBase64Url(text);
  if (!raw) return null;
  try {
    await dh.importPublicKey(raw);
    return raw;
  } catch {
    return null;
  }
}

// ----- pairing -----------------------------------------------------------------------------

export const PAIRING_NONCE_BYTES = 16;
export const MATCH_NUMBER_DIGITS = 4;

/** The joiner's commitment to its key and nonce, sent before it sees the host's nonce. */
export async function pairingCommitment(
  devicePublicKey: Uint8Array,
  deviceNonce: Uint8Array,
): Promise<string> {
  return toBase64Url(
    await sha256(framed(utf8("threadlines-pair-commit-v1"), devicePublicKey, deviceNonce)),
  );
}

/**
 * The number both screens show for a code join. Each side computes it from
 * its own view of the transcript; a relay in the middle has to fix its keys
 * and nonces before it can learn what the honest sides chose, so the numbers
 * only match by chance (1 in 10,000).
 */
export async function pairingMatchNumber(input: {
  readonly hostPublicKey: Uint8Array;
  readonly devicePublicKey: Uint8Array;
  readonly hostNonce: Uint8Array;
  readonly deviceNonce: Uint8Array;
}): Promise<string> {
  const digest = await sha256(
    framed(
      utf8("threadlines-pair-sas-v1"),
      input.hostPublicKey,
      input.devicePublicKey,
      input.hostNonce,
      input.deviceNonce,
    ),
  );
  const value = new DataView(digest.buffer).getUint32(0) % 10 ** MATCH_NUMBER_DIGITS;
  return String(value).padStart(MATCH_NUMBER_DIGITS, "0");
}

/**
 * What a QR invite secret yields: the token the relay checks (it stores only
 * its hash) and the key the claim proof is made with, which the relay never
 * sees.
 */
export async function claimSecrets(inviteSecret: Uint8Array): Promise<{
  readonly claimToken: string;
  readonly macKey: Bytes;
}> {
  const claimToken = await hmacSha256(inviteSecret, utf8("threadlines-claim-token-v1"));
  const macKey = await hmacSha256(inviteSecret, utf8("threadlines-claim-mac-v1"));
  return { claimToken: toBase64Url(claimToken), macKey };
}

/** Proves the claimer saw the QR code and binds its key to this invite and join. */
export async function claimProof(input: {
  readonly macKey: Uint8Array;
  readonly inviteId: string;
  readonly joinId: string;
  readonly devicePublicKey: Uint8Array;
}): Promise<string> {
  return toBase64Url(
    await hmacSha256(
      input.macKey,
      framed(
        utf8("threadlines-claim-v1"),
        utf8(input.inviteId),
        utf8(input.joinId),
        input.devicePublicKey,
      ),
    ),
  );
}

export async function verifyClaimProof(input: {
  readonly macKey: Uint8Array;
  readonly inviteId: string;
  readonly joinId: string;
  readonly devicePublicKey: Uint8Array;
  readonly proof: string;
}): Promise<boolean> {
  const expected = fromBase64Url(await claimProof(input));
  const actual = fromBase64Url(input.proof);
  return expected !== null && actual !== null && bytesEqual(expected, actual);
}
