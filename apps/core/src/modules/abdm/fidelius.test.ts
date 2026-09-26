import { inspect } from "node:util";
import { openSecret, sealSecret } from "../../kernel/crypto";
import {
  BC_CURVE25519, FideliusKeyPair, fideliusDecrypt, fideliusEncrypt, parseFideliusPublicKey,
} from "./fidelius";

/**
 * ABDM S2 — FIDELIUS (the ECDH + AES-GCM scheme every HIP→HIU transfer is encrypted with).
 *
 * THE VECTOR is the one published in fidelius-cli's README (mgrmtech/fidelius-cli, the reference
 * the NHA guidelines point to), and `/opt/hmis-context/reference/abdm/third-party/fidelius-cli/
 * verify-readme-vector-node22.mjs` proved it against BouncyCastle's short-Weierstrass Curve25519 with
 * plain BigInt arithmetic. This suite proves the SHIPPED implementation — `@noble/curves`'
 * constant-time ladder over the same curve — reproduces it byte for byte, in BOTH directions:
 *
 *   · encrypt as the SENDER (the HIP: its private key, the requester's public key, sender nonce
 *     first) → exactly the README's `encryptedData`;
 *   · decrypt as the REQUESTER (the HIU: its private key, the sender's public key) → the plaintext.
 *
 * A mismatch here means an HIU cannot read what we send, and no other test can see that.
 */
const requester = {
  priv: "DMxHPri8d7IT23KgLk281zZenMfVHSdeamq0RhwlIBk=",
  pub: "BAheD5rUqTy4V5xR4/6HWmYpopu5CO+KO8BECS0udNqUTSNo91TIqIIy1A4Vh+F94c+n9vAcwXU2bGcfsI5f69Y=",
  x509: "MIIBMTCB6gYHKoZIzj0CATCB3gIBATArBgcqhkjOPQEBAiB/////////////////////////////////////////7TBEBCAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqYSRShRAQge0Je0Je0Je0Je0Je0Je0Je0Je0Je0Je0JgtenHcQyGQEQQQqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq0kWiCuGaG4oIa04B7dLHdI0UySPU1+bXxhsinpxaJ+ztPZAiAQAAAAAAAAAAAAAAAAAAAAFN753qL3nNZYEmMaXPXT7QIBCANCAAQIXg+a1Kk8uFecUeP+h1pmKaKbuQjvijvARAktLnTalE0jaPdUyKiCMtQOFYfhfeHPp/bwHMF1NmxnH7COX+vW",
  nonce: "6uj1RdDUbcpI3lVMZvijkMC8Te20O4Bcyz0SyivX8Eg=",
};
const sender = {
  priv: "AYhVZpbVeX4KS5Qm/W0+9Ye2q3rnVVGmqRICmseWni4=",
  pub: "BABVt+mpRLMXiQpIfEq6bj8hlXsdtXIxLsspmMgLNI1SR5mHgDVbjHO2A+U4QlMddGzqyEidzm1AkhtSxSO2Ahg=",
  x509: "MIIBMTCB6gYHKoZIzj0CATCB3gIBATArBgcqhkjOPQEBAiB/////////////////////////////////////////7TBEBCAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqYSRShRAQge0Je0Je0Je0Je0Je0Je0Je0Je0Je0Je0JgtenHcQyGQEQQQqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq0kWiCuGaG4oIa04B7dLHdI0UySPU1+bXxhsinpxaJ+ztPZAiAQAAAAAAAAAAAAAAAAAAAAFN753qL3nNZYEmMaXPXT7QIBCANCAAQAVbfpqUSzF4kKSHxKum4/IZV7HbVyMS7LKZjICzSNUkeZh4A1W4xztgPlOEJTHXRs6shInc5tQJIbUsUjtgIY",
  nonce: "lmXgblZwotx+DfBgKJF0lZXtAXgBEYr5khh79Zytr2Y=",
};
const PLAINTEXT = "Wormtail should never have been Potter cottage's secret keeper.";
const ENCRYPTED = "pzMvVZNNVtJzqPkkxcCbBUWgDEBy/mBXIeT2dJWI16ZAQnnXUb9lI+S4k8XK6mgZSKKSRIHkcNvJpllnBg548wUgavBa0vCRRwdL6kY6Yw==";

describe("Fidelius — the published fidelius-cli vector, on @noble/curves", () => {
  it("the curve is BouncyCastle's short-Weierstrass curve25519 (p, a, b, G, n, h) — and each README public key is d·G on it", () => {
    expect(BC_CURVE25519.p).toBe(2n ** 255n - 19n);
    expect(BC_CURVE25519.h).toBe(8n);
    expect(BC_CURVE25519.n).toBe(2n ** 252n + 0x14def9dea2f79cd65812631a5cf5d3edn);
    for (const km of [requester, sender]) {
      const kp = FideliusKeyPair.fromPrivateKey(km.priv, km.nonce);
      expect(kp.publicKeyRaw()).toBe(km.pub);
      // BouncyCastle's `getEncoded()` — the form the NHA wrapper and the Care connector SEND.
      expect(kp.publicKeyX509()).toBe(km.x509);
    }
  });

  it("ENCRYPTS as the sender to exactly the README ciphertext", () => {
    const hip = FideliusKeyPair.fromPrivateKey(sender.priv, sender.nonce);
    expect(fideliusEncrypt(hip, { publicKey: requester.pub, nonce: requester.nonce }, PLAINTEXT)).toBe(ENCRYPTED);
    // …and the requester's key in X.509 form yields the same bytes (the CLI accepts both; so do we).
    expect(fideliusEncrypt(hip, { publicKey: requester.x509, nonce: requester.nonce }, PLAINTEXT)).toBe(ENCRYPTED);
  });

  it("DECRYPTS as the requester to exactly the README plaintext, with the sender's key in either form", () => {
    const hiu = FideliusKeyPair.fromPrivateKey(requester.priv, requester.nonce);
    expect(fideliusDecrypt(hiu, { publicKey: sender.pub, nonce: sender.nonce }, ENCRYPTED)).toBe(PLAINTEXT);
    expect(fideliusDecrypt(hiu, { publicKey: sender.x509, nonce: sender.nonce }, ENCRYPTED)).toBe(PLAINTEXT);
  });

  it("a tampered ciphertext, a wrong nonce or a wrong key does not decrypt (GCM authenticates)", () => {
    const hiu = FideliusKeyPair.fromPrivateKey(requester.priv, requester.nonce);
    const raw = Buffer.from(ENCRYPTED, "base64");
    raw[3] = raw[3]! ^ 0x01;
    expect(() => fideliusDecrypt(hiu, { publicKey: sender.pub, nonce: sender.nonce }, raw.toString("base64"))).toThrow();
    expect(() => fideliusDecrypt(hiu, { publicKey: sender.pub, nonce: requester.nonce }, ENCRYPTED)).toThrow();
    const stranger = FideliusKeyPair.generate();
    expect(() => fideliusDecrypt(stranger, { publicKey: sender.pub, nonce: sender.nonce }, ENCRYPTED)).toThrow();
  });

  it("a fresh pair round-trips a FHIR-sized UTF-8 document both ways, and every pair and nonce is new", () => {
    const hip = FideliusKeyPair.generate();
    const hiu = FideliusKeyPair.generate();
    expect(hip.publicKeyRaw()).not.toBe(hiu.publicKeyRaw());
    expect(hip.nonce).not.toBe(hiu.nonce);
    expect(Buffer.from(hip.nonce, "base64")).toHaveLength(32);
    const doc = JSON.stringify({ resourceType: "Bundle", note: "रक्तचाप सामान्य — BP normal", pad: "x".repeat(50_000) });
    const ct = fideliusEncrypt(hip, { publicKey: hiu.publicKeyX509(), nonce: hiu.nonce }, doc);
    expect(fideliusDecrypt(hiu, { publicKey: hip.publicKeyX509(), nonce: hip.nonce }, ct)).toBe(doc);
  });

  it("refuses a public key that is not a point of the prime-order subgroup, and a nonce that is not 32 bytes", () => {
    const hip = FideliusKeyPair.generate();
    const offCurve = Buffer.from(requester.pub, "base64");
    offCurve[64] = offCurve[64]! ^ 0x01;
    expect(() => parseFideliusPublicKey(offCurve.toString("base64"))).toThrow();
    expect(() => parseFideliusPublicKey(Buffer.alloc(40, 7).toString("base64"))).toThrow();
    expect(() => fideliusEncrypt(hip, { publicKey: requester.pub, nonce: Buffer.alloc(16, 1).toString("base64") }, "x")).toThrow(/nonce/);
  });

  it("S3 — the HIU's half is held SEALED between its request and the HIP's push: the seal is not the key, and the opened pair decrypts the README ciphertext", () => {
    const key = Buffer.alloc(32, 7);
    const hiu = FideliusKeyPair.fromPrivateKey(requester.priv, requester.nonce);
    let handed = "";
    const sealed = hiu.sealPrivateKey((p) => { handed = p; return sealSecret(key, p); });
    // the sealer is the ONE thing that ever sees the private key, and it sees it in the README's form
    expect(Buffer.from(handed, "base64")).toEqual(Buffer.from(requester.priv, "base64"));
    const d = BigInt(`0x${Buffer.from(requester.priv, "base64").toString("hex")}`);
    for (const t of [requester.priv, d.toString(), d.toString(16)]) expect(sealed).not.toContain(t);
    const back = FideliusKeyPair.fromSealed(sealed, requester.nonce, (s) => openSecret(key, s));
    expect(back.publicKeyX509()).toBe(requester.x509);
    expect(fideliusDecrypt(back, { publicKey: sender.x509, nonce: sender.nonce }, ENCRYPTED)).toBe(PLAINTEXT);
    // a seal opened under another key is refused, not turned into some other key pair
    expect(() => FideliusKeyPair.fromSealed(sealed, requester.nonce, (s) => openSecret(Buffer.alloc(32, 8), s))).toThrow();
  });

  it("THE PRIVATE KEY NEVER SERIALISES: not in JSON, not in a spread, not in util.inspect", () => {
    const kp = FideliusKeyPair.fromPrivateKey(sender.priv, sender.nonce);
    const d = BigInt(`0x${Buffer.from(sender.priv, "base64").toString("hex")}`);
    const texts = [JSON.stringify(kp), JSON.stringify({ ...kp }), inspect(kp, { depth: 5, showHidden: true }), String(kp)];
    for (const t of texts) {
      expect(t).not.toContain(sender.priv);
      expect(t).not.toContain(d.toString());
      expect(t).not.toContain(d.toString(16));
    }
    expect(JSON.parse(JSON.stringify(kp))).toEqual({ publicKey: sender.x509, nonce: sender.nonce });
  });
});
