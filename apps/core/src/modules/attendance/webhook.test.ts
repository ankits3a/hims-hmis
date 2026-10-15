import { bioattendSignature, verifyBioattendWebhook } from "./webhook";

/**
 * The guide's webhook TEST VECTOR ("Webhook", dummy secret): secret = `ab` repeated 32 times (64
 * characters, used AS TEXT), timestamp 1791542400, body exactly
 * `{"event":"punches","sent_at":"2026-10-09 16:20:00","punches":[]}`.
 */
const SECRET = "ab".repeat(32);
const TS = "1791542400";
const BODY = Buffer.from('{"event":"punches","sent_at":"2026-10-09 16:20:00","punches":[]}', "utf8");
const SIG = "sha256=8544ba90806b6b197b5c910d936bf2100f8a7e7a2c4c6164584779119c6643eb";
const AT = Number(TS) * 1000;

describe("the bioattend webhook signature", () => {
  it("the guide's test vector", () => {
    expect(bioattendSignature(SECRET, TS, BODY)).toBe(SIG);
    expect(verifyBioattendWebhook({ secret: SECRET, timestamp: TS, signature: SIG, raw: BODY, nowMs: AT })).toBe("ok");
  });

  it("the secret is TEXT, not hex-decoded — the opposite of the Aadhaar key", () => {
    // `abab…` happens to be valid hex; hex-decoding it is the mistake the guide warns about.
    const { createHmac } = jest.requireActual<typeof import("node:crypto")>("node:crypto");
    const wrong = `sha256=${createHmac("sha256", Buffer.from(SECRET, "hex")).update(`${TS}.`).update(BODY).digest("hex")}`;
    expect(wrong).not.toBe(SIG);
    expect(verifyBioattendWebhook({ secret: SECRET, timestamp: TS, signature: wrong, raw: BODY, nowMs: AT })).toBe("bad_signature");
  });

  it("one character changed anywhere fails: the body, the signature, the timestamp, the secret", () => {
    const check = (over: Partial<{ secret: string; timestamp: string; signature: string; raw: Buffer }>) =>
      verifyBioattendWebhook({ secret: SECRET, timestamp: TS, signature: SIG, raw: BODY, nowMs: AT, skipAgeCheck: true, ...over });
    expect(check({})).toBe("ok");
    expect(check({ raw: Buffer.from(BODY.toString("utf8").replace("16:20:00", "16:20:01"), "utf8") })).toBe("bad_signature");
    expect(check({ raw: Buffer.from(`${BODY.toString("utf8")} `, "utf8") })).toBe("bad_signature"); // re-serialised JSON would not match
    expect(check({ signature: SIG.replace(/b$/, "c") })).toBe("bad_signature");
    expect(check({ signature: SIG.slice("sha256=".length) })).toBe("bad_signature");
    expect(check({ signature: undefined })).toBe("bad_signature");
    expect(check({ timestamp: "1791542401" })).toBe("bad_signature");
    expect(check({ secret: `bb${"ab".repeat(31)}` })).toBe("bad_signature");
  });

  it("the five-minute check, both ways: 300 s either side is in, 301 s either side is out", () => {
    const at = (offsetSeconds: number) => verifyBioattendWebhook({ secret: SECRET, timestamp: TS, signature: SIG, raw: BODY, nowMs: AT + offsetSeconds * 1000 });
    expect(at(0)).toBe("ok");
    expect(at(300)).toBe("ok"); // the message is five minutes old
    expect(at(-300)).toBe("ok"); // our clock is five minutes behind theirs
    expect(at(301)).toBe("stale");
    expect(at(-301)).toBe("stale");
    expect(at(86_400)).toBe("stale");
  });

  it("a timestamp that is not digits is never fresh, even correctly signed", () => {
    const ts = "1791542400.5";
    const sig = bioattendSignature(SECRET, ts, BODY);
    expect(verifyBioattendWebhook({ secret: SECRET, timestamp: ts, signature: sig, raw: BODY, nowMs: AT })).toBe("stale");
    expect(verifyBioattendWebhook({ secret: SECRET, timestamp: undefined, signature: bioattendSignature(SECRET, "", BODY), raw: BODY, nowMs: AT })).toBe("stale");
  });
});
