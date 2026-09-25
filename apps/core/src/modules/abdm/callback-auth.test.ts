import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createFakeAbdmGateway } from "../../../test/helpers/abdm-fake-gateway";
import { loadConfig } from "../../kernel/config";
import { AbdmCallbackAuthError, AbdmCallbackVerifier, AbdmGatewayClient, abdmSettingsFrom } from "./index";
import type { Db } from "../../kernel/db/client";

/**
 * ABDM S0 — callback authentication. ABDM signs every callback's `Authorization: Bearer <jwt>` with
 * RS256; the key is published at `GET {gateway}/gateway/v3/certs`. The verifier must accept exactly
 * that and nothing adjacent to it: not `alg: none`, not HS256 keyed with the public key (the classic
 * confusion attack), not a token signed by a key nobody published, not an expired one, not one
 * minted for another audience.
 */
describe("AbdmCallbackVerifier", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clock: number;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    clock = Date.parse("2026-09-25T10:00:00.000Z");
  });

  const setup = (o: { audience?: string } = {}) => {
    const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: "secret", now: () => clock });
    const settings = abdmSettingsFrom(loadConfig({
      DATABASE_URL: "postgres://unused",
      SECRET_KEY: process.env.SECRET_KEY!,
      ABDM_BASE_URL: fake.baseUrl,
      ABDM_CLIENT_ID: "SBX_0001",
      ABDM_CLIENT_SECRET: "secret",
      ABDM_HIP_ID: "IN0000000001",
      ABDM_CALLBACK_BASE_URL: "https://hmis.example.test/api/abdm/callbacks",
      ...(o.audience !== undefined ? { ABDM_JWT_AUDIENCE: o.audience } : {}),
    }).abdm)!;
    const now = (): Date => new Date(clock);
    const client = new AbdmGatewayClient(settings, { db, fetch: fake.fetch, now });
    const verifier = new AbdmCallbackVerifier(settings, { client, now });
    const reason = (header: string | undefined): Promise<string | null> =>
      verifier.verify(header).then(() => null, (e: unknown) => {
        if (!(e instanceof AbdmCallbackAuthError)) throw e;
        return e.reason;
      });
    return { fake, verifier, reason };
  };

  it("accepts a gateway-signed RS256 token and returns its claims", async () => {
    const { fake, verifier } = setup();
    const claims = await verifier.verify(`Bearer ${fake.signCallbackJwt({ sub: "hiecm" })}`);
    expect(claims).toMatchObject({ aud: "account", sub: "hiecm" });
    expect(fake.certsServed()).toBe(1);
  });

  it("fetches the JWKS with the session bearer and the standard headers, and caches it", async () => {
    const { fake, verifier } = setup();
    await verifier.verify(`Bearer ${fake.signCallbackJwt()}`);
    await verifier.verify(`Bearer ${fake.signCallbackJwt()}`);
    expect(fake.certsServed()).toBe(1);
    const certs = fake.requests.find((r) => r.path === "/gateway/v3/certs")!;
    expect(certs.headers["authorization"]).toMatch(/^Bearer fake-access-/);
    expect(certs.headers["request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(certs.headers["timestamp"]).toMatch(/Z$/);
    expect(certs.headers["x-cm-id"]).toBe("sbx");
  });

  it("refetches after 24 h", async () => {
    const { fake, verifier } = setup();
    await verifier.verify(`Bearer ${fake.signCallbackJwt()}`);
    clock += 24 * 3600_000 + 1_000;
    await verifier.verify(`Bearer ${fake.signCallbackJwt()}`);
    expect(fake.certsServed()).toBe(2);
  });

  it("REJECTS a token signed by a key the gateway never published — after exactly one refetch", async () => {
    const { fake, reason } = setup();
    expect(await reason(`Bearer ${fake.signCallbackJwt()}`)).toBeNull(); // primes the cache
    expect(await reason(`Bearer ${fake.signCallbackJwt({}, { key: "wrong" })}`)).toBe("bad_signature");
    expect(fake.certsServed()).toBe(2);
  });

  it("REJECTS alg none", async () => {
    const { fake, reason } = setup();
    expect(await reason(`Bearer ${fake.unsignedJwt()}`)).toBe("alg_not_allowed");
    expect(fake.certsServed()).toBe(0); // refused before anything is fetched
  });

  it("REJECTS HS256 — including the confusion attack keyed with the gateway's own public key", async () => {
    const { fake, reason } = setup();
    expect(await reason(`Bearer ${fake.hs256Jwt(fake.publicKeyPem())}`)).toBe("alg_not_allowed");
    expect(await reason(`Bearer ${fake.hs256Jwt("shared-secret")}`)).toBe("alg_not_allowed");
    // An RS256 signature under an HS/none/other header is still refused on the header.
    expect(await reason(`Bearer ${fake.signCallbackJwt({}, { alg: "RS512" })}`)).toBe("alg_not_allowed");
  });

  it("REJECTS an expired token, a not-yet-valid one, and one with no expiry — with a small skew allowed", async () => {
    const { fake, reason } = setup();
    const nowS = Math.floor(clock / 1000);
    expect(await reason(`Bearer ${fake.signCallbackJwt({ exp: nowS - 120 })}`)).toBe("expired");
    expect(await reason(`Bearer ${fake.signCallbackJwt({ nbf: nowS + 120 })}`)).toBe("not_yet_valid");
    expect(await reason(`Bearer ${fake.signCallbackJwt({ exp: undefined })}`)).toBe("no_expiry");
    // Inside the skew both ways.
    expect(await reason(`Bearer ${fake.signCallbackJwt({ exp: nowS - 10 })}`)).toBeNull();
    expect(await reason(`Bearer ${fake.signCallbackJwt({ nbf: nowS + 10 })}`)).toBeNull();
  });

  it("REJECTS a token for another audience; accepts an audience array that contains ours", async () => {
    const { fake, reason } = setup();
    expect(await reason(`Bearer ${fake.signCallbackJwt({ aud: "someone-else" })}`)).toBe("audience");
    expect(await reason(`Bearer ${fake.signCallbackJwt({ aud: undefined })}`)).toBe("audience");
    expect(await reason(`Bearer ${fake.signCallbackJwt({ aud: ["x", "account"] })}`)).toBeNull();
  });

  it("the audience is configurable", async () => {
    const { fake, reason } = setup({ audience: "hmis-bridge" });
    expect(await reason(`Bearer ${fake.signCallbackJwt()}`)).toBe("audience");
    expect(await reason(`Bearer ${fake.signCallbackJwt({ aud: "hmis-bridge" })}`)).toBeNull();
  });

  it("an UNKNOWN kid refetches once, then rejects — and does not refetch again inside the cooldown", async () => {
    const { fake, reason } = setup();
    expect(await reason(`Bearer ${fake.signCallbackJwt()}`)).toBeNull();
    expect(await reason(`Bearer ${fake.signCallbackJwt({}, { kid: "no-such-kid" })}`)).toBe("unknown_kid");
    expect(fake.certsServed()).toBe(2);
    expect(await reason(`Bearer ${fake.signCallbackJwt({}, { kid: "another-unknown" })}`)).toBe("unknown_kid");
    expect(fake.certsServed()).toBe(2); // an attacker's stream of random kids cannot hammer the gateway
  });

  it("a ROTATED key is picked up by the refetch on its new kid", async () => {
    const { fake, reason } = setup();
    expect(await reason(`Bearer ${fake.signCallbackJwt()}`)).toBeNull();
    fake.rotateKey();
    expect(await reason(`Bearer ${fake.signCallbackJwt()}`)).toBeNull();
    expect(fake.certsServed()).toBe(2);
  });

  it("REJECTS a missing or malformed header without fetching anything", async () => {
    const { fake, reason } = setup();
    expect(await reason(undefined)).toBe("missing_bearer");
    expect(await reason("Basic abc")).toBe("missing_bearer");
    expect(await reason("Bearer not-a-jwt")).toBe("malformed");
    expect(await reason("Bearer a.b.c")).toBe("malformed");
    expect(fake.certsServed()).toBe(0);
  });
});
