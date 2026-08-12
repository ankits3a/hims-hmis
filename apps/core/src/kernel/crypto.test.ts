import {
  randomToken, sha256Hex, sealSecret, openSecret,
  hmacSign, hmacVerify, makeBadgeToken, parseBadgeToken,
} from "./crypto";

const key = Buffer.alloc(32, 7);
const otherKey = Buffer.alloc(32, 8);

describe("kernel crypto", () => {
  it("randomToken is unique and url-safe", () => {
    const t = randomToken();
    expect(t).not.toBe(randomToken());
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("sha256Hex is deterministic hex", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("seals and opens a secret round-trip", () => {
    const sealed = sealSecret(key, "JBSWY3DPEHPK3PXP");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(openSecret(key, sealed)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("rejects tampered or wrong-key ciphertext", () => {
    const sealed = sealSecret(key, "secret");
    expect(() => openSecret(otherKey, sealed)).toThrow();
    const parts = sealed.split(".");
    parts[3] = (parts[3]![0] === "A" ? "B" : "A") + parts[3]!.slice(1); // deterministic one-char tamper
    expect(() => openSecret(key, parts.join("."))).toThrow();
  });

  it("hmac verifies only the exact payload and key", () => {
    const sig = hmacSign(key, "payload");
    expect(hmacVerify(key, "payload", sig)).toBe(true);
    expect(hmacVerify(key, "payload2", sig)).toBe(false);
    expect(hmacVerify(otherKey, "payload", sig)).toBe(false);
    expect(hmacVerify(key, "payload", "not-a-sig")).toBe(false);
  });

  it("badge tokens round-trip and reject tampering", () => {
    const token = makeBadgeToken(key, "01HUSER00000000000000000A", 3);
    expect(parseBadgeToken(key, token)).toEqual({ userId: "01HUSER00000000000000000A", badgeVersion: 3 });
    expect(parseBadgeToken(otherKey, token)).toBeNull();
    expect(parseBadgeToken(key, token.replace(".3.", ".4."))).toBeNull();
    expect(parseBadgeToken(key, "garbage")).toBeNull();
  });
});
