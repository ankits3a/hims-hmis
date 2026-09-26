import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { ecdh, weierstrassN } from "@noble/curves/abstract/weierstrass";

/**
 * ═══ ABDM S2 — FIDELIUS: THE ENCRYPTION EVERY HEALTH-INFORMATION TRANSFER CARRIES ═══
 *
 * Sources, and how far each is trusted (spec summary §4.5):
 *   · AUTHORITATIVE — the NHA wrapper's `EncryptionService.java` + `CipherKeyManager.java`: ECDH on
 *     BouncyCastle's named curve `curve25519`, the shared secret's X coordinate, `xor = sender nonce ⊕
 *     requester nonce`, `salt = xor[0:20]`, `iv = xor[20:32]` (the LAST 12 bytes), `aesKey =
 *     HKDF-SHA256(ikm = sharedX, salt, info = none, 32)`, AES-256-GCM with a 128-bit tag appended,
 *     base64. The private key is the base64 of its big-endian integer, the public key `04‖X‖Y`
 *     (`getQ().getEncoded(false)`), and the key the wrapper SENDS is `ecKey.getEncoded()` — X.509
 *     SubjectPublicKeyInfo with the curve's parameters spelled out.
 *   · CROSS-CHECK — fidelius-cli (the README vector `fidelius.test.ts` reproduces byte for byte) and
 *     the Care connector's `fidelius.py`, whose `x509` prefix is the one below.
 *
 * THE CURVE IS NOT X25519. BouncyCastle's `curve25519` is Curve25519 in SHORT-WEIERSTRASS form
 * (y² = x³ + ax + b over 2²⁵⁵−19), so Node's `x25519` cannot be used; the arithmetic is
 * `@noble/curves`' generic Weierstrass implementation — audited, constant-time `multiply`, and it
 * validates every peer point (on the curve AND in the prime-order subgroup, cofactor 8) before it
 * multiplies. No scalar multiplication is written here.
 *
 * THE PRIVATE KEY lives in a `#private` field of a `FideliusKeyPair` for ONE transfer and dies with
 * it: `toJSON`, a spread and `util.inspect` all see only the public key and the nonce. Nothing in
 * this module writes, logs or returns it.
 */
export const BC_CURVE25519: Readonly<{ p: bigint; n: bigint; h: bigint; a: bigint; b: bigint; Gx: bigint; Gy: bigint }> = {
  p: 2n ** 255n - 19n,
  n: 2n ** 252n + 0x14def9dea2f79cd65812631a5cf5d3edn,
  h: 8n,
  a: 0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa984914a144n,
  b: 0x7b425ed097b425ed097b425ed097b425ed097b425ed097b4260b5e9c7710c864n,
  Gx: 0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad245an,
  Gy: 0x20ae19a1b8a086b4e01edd2c7748d14c923d4d7e6d7c61b229e9c5a27eced3d9n,
};

const Point = weierstrassN(BC_CURVE25519);
const curve = ecdh(Point);

/**
 * The DER prefix of BouncyCastle's `getEncoded()` for this curve (explicit parameters), up to and
 * including the BIT STRING header; the 65-byte uncompressed point follows. It is the Care
 * connector's `encode_x509_public_key_to_base64` fixed prefix, read here off fidelius-cli's README
 * requester key (a PUBLIC key) by dropping its last 65 bytes, so the constant cannot be mistyped;
 * `fidelius.test.ts` rebuilds both README X.509 keys from their private keys through it.
 */
const X509_PREFIX = ((): Buffer => {
  const readmeRequesterX509 = Buffer.from(
    "MIIBMTCB6gYHKoZIzj0CATCB3gIBATArBgcqhkjOPQEBAiB/////////////////////////////////////////7TBEBCAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqYSRShRAQge0Je0Je0Je0Je0Je0Je0Je0Je0Je0Je0JgtenHcQyGQEQQQqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq0kWiCuGaG4oIa04B7dLHdI0UySPU1+bXxhsinpxaJ+ztPZAiAQAAAAAAAAAAAAAAAAAAAAFN753qL3nNZYEmMaXPXT7QIBCANCAAQIXg+a1Kk8uFecUeP+h1pmKaKbuQjvijvARAktLnTalE0jaPdUyKiCMtQOFYfhfeHPp/bwHMF1NmxnH7COX+vW",
    "base64",
  );
  return Buffer.from(readmeRequesterX509.subarray(0, readmeRequesterX509.length - 65));
})();

export const FIDELIUS_CRYPTO_ALG = "ECDH";
export const FIDELIUS_CURVE_NAME = "Curve25519";
/** The wrapper's `CipherKeyManager.PARAMETERS`. */
export const FIDELIUS_KEY_PARAMETERS = "Curve25519/32byte random key";
const NONCE_BYTES = 32;

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const toBigInt = (bytes: Uint8Array): bigint => (bytes.length === 0 ? 0n : BigInt(`0x${Buffer.from(bytes).toString("hex")}`));
const to32 = (n: bigint): Buffer => Buffer.from(n.toString(16).padStart(64, "0"), "hex");

/**
 * A peer's public key, in either form ABDM participants send: the raw uncompressed point
 * (`04‖X‖Y`, 65 bytes — fidelius-cli's `publicKey`) or X.509 SubjectPublicKeyInfo ending in that
 * point (the wrapper's and Care's `keyToShare`). The last 65 bytes are the point in both; the point
 * is then validated by `@noble/curves` (on the curve, in the prime-order subgroup), so a DER blob
 * that merely ends in 65 plausible bytes is still refused unless they ARE a valid point.
 */
export function parseFideliusPublicKey(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 65) throw new Error("fidelius: a public key is at least a 65-byte uncompressed point");
  const point = bytes.subarray(bytes.length - 65);
  if (point[0] !== 0x04) throw new Error("fidelius: a public key must end in an uncompressed point (0x04‖X‖Y)");
  if (bytes.length !== 65 && bytes[0] !== 0x30) throw new Error("fidelius: a public key longer than a point must be DER SubjectPublicKeyInfo");
  Point.fromHex(point).assertValidity();
  return new Uint8Array(point);
}

function nonceBytes(value: string, whose: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== NONCE_BYTES) throw new Error(`fidelius: the ${whose} nonce must be ${NONCE_BYTES} bytes, got ${bytes.length}`);
  return bytes;
}

export class FideliusKeyPair {
  readonly #d: bigint;
  /** base64 of 32 random bytes. Public — it travels in the key material. */
  readonly nonce: string;
  readonly #pointRaw: Uint8Array;

  private constructor(d: bigint, nonce: string) {
    if (d <= 0n || d >= BC_CURVE25519.n) throw new Error("fidelius: a private key must be in [1, n-1]");
    nonceBytes(nonce, "own");
    this.#d = d;
    this.nonce = nonce;
    this.#pointRaw = curve.getPublicKey(to32(d), false);
  }

  /** A fresh ephemeral pair and nonce — one per transfer (wrapper `CipherKeyManager.fetchKeys`). */
  static generate(): FideliusKeyPair {
    return new FideliusKeyPair(toBigInt(curve.utils.randomSecretKey()), randomBytes(NONCE_BYTES).toString("base64"));
  }

  /** For the published test vector and for an HIU reading its own stored material (S3). */
  static fromPrivateKey(privateKeyBase64: string, nonceBase64: string): FideliusKeyPair {
    return new FideliusKeyPair(toBigInt(Buffer.from(privateKeyBase64, "base64")), nonceBase64);
  }

  /** `04‖X‖Y`, base64 — fidelius-cli's `publicKey`. */
  publicKeyRaw(): string {
    return b64(this.#pointRaw);
  }

  /** X.509 SubjectPublicKeyInfo, base64 — what the NHA wrapper and Care put in `dhPublicKey.keyValue`. */
  publicKeyX509(): string {
    return b64(Buffer.concat([X509_PREFIX, this.#pointRaw]));
  }

  /** ECDH with a peer's public key: the X coordinate, 32 bytes big-endian (BouncyCastle's `generateSecret`). */
  sharedX(peerPublicKey: string): Buffer {
    const shared = curve.getSharedSecret(to32(this.#d), parseFideliusPublicKey(peerPublicKey), true);
    return Buffer.from(shared.subarray(1));
  }

  toJSON(): { publicKey: string; nonce: string } {
    return { publicKey: this.publicKeyX509(), nonce: this.nonce };
  }

  toString(): string {
    return `FideliusKeyPair(${this.publicKeyX509().slice(-16)})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export type FideliusPeer = { publicKey: string; nonce: string };

/**
 * The session key and IV for one direction. `own` is always the key pair held by the caller: the
 * sender encrypting, or the requester decrypting. The XOR is symmetric, so both sides derive the
 * same bytes — the wrapper's `xorOfRandom(senderNonce, receiverNonce)`.
 */
function sessionKey(own: FideliusKeyPair, peer: FideliusPeer): { key: Buffer; iv: Buffer } {
  const a = nonceBytes(own.nonce, "own");
  const b = nonceBytes(peer.nonce, "peer");
  const xor = Buffer.alloc(NONCE_BYTES);
  for (let i = 0; i < NONCE_BYTES; i += 1) xor[i] = a[i]! ^ b[i]!;
  const salt = xor.subarray(0, 20);
  const iv = xor.subarray(20, 32);
  const key = Buffer.from(hkdfSync("sha256", own.sharedX(peer.publicKey), salt, Buffer.alloc(0), 32));
  return { key, iv: Buffer.from(iv) };
}

/** AES-256-GCM, the 16-byte tag appended, base64 — the entry `content` of a data push. */
export function fideliusEncrypt(sender: FideliusKeyPair, requester: FideliusPeer, plaintext: string): string {
  const { key, iv } = sessionKey(sender, requester);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return ct.toString("base64");
}

/** The requester's half. Throws on any authentication failure — a wrong key, nonce or a tampered byte. */
export function fideliusDecrypt(requester: FideliusKeyPair, sender: FideliusPeer, ciphertextBase64: string): string {
  const raw = Buffer.from(ciphertextBase64, "base64");
  if (raw.length < 16) throw new Error("fidelius: ciphertext shorter than its tag");
  const { key, iv } = sessionKey(requester, sender);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8");
}
