import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createFakeAbdmGateway } from "../../../test/helpers/abdm-fake-gateway";
import { abdmMessages } from "../../kernel/db/schema";
import { loadConfig } from "../../kernel/config";
import { AbdmGatewayClient, AbdmGatewayError, abdmSettingsFrom } from "./index";
import type { AbdmSettings } from "./index";
import type { Db } from "../../kernel/db/client";

/**
 * ABDM S0 — the gateway client: the session token cache, the headers every call carries, and the
 * message log every outbound call is written to. Driven against the in-process fake gateway; CI
 * never contacts ABDM.
 */
const SECRET = "Sbx-Secret-9f2c1e77-never-in-a-row";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function settingsFor(baseUrl: string, secret = SECRET): AbdmSettings {
  const s = abdmSettingsFrom(loadConfig({
    DATABASE_URL: "postgres://unused",
    SECRET_KEY: process.env.SECRET_KEY!,
    ABDM_BASE_URL: baseUrl,
    ABDM_CLIENT_ID: "SBX_0001",
    ABDM_CLIENT_SECRET: secret,
    ABDM_HIP_ID: "IN0000000001",
    ABDM_CALLBACK_BASE_URL: "https://hmis.example.test/api/abdm/callbacks",
  }).abdm);
  if (s === null) throw new Error("test settings did not configure");
  return s;
}

describe("AbdmGatewayClient", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clock: number;
  const now = (): Date => new Date(clock);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    clock = Date.parse("2026-09-25T10:00:00.000Z");
  });

  const setup = (o: { expiresIn?: number; secret?: string } = {}) => {
    const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: SECRET, expiresIn: o.expiresIn, now: () => clock });
    const client = new AbdmGatewayClient(settingsFor(fake.baseUrl, o.secret), { db, fetch: fake.fetch, now });
    return { fake, client };
  };

  /** Every stored message, as the text Postgres would hand anyone who reads the table. */
  const storedText = async (): Promise<string> =>
    ((await db.execute(sql`select coalesce(json_agg(m)::text, '') as t from abdm_messages m`)).rows[0] as { t: string }).t;

  it("reuses one session across calls", async () => {
    const { fake, client } = setup();
    await client.call("GET", "/gateway/v3/certs", undefined, { kind: "gateway.certs" });
    await client.call("GET", "/gateway/v3/certs", undefined, { kind: "gateway.certs" });
    expect(fake.sessionsIssued()).toBe(1);
  });

  it("reads expiresIn and refreshes 30 s EARLY — not at expiry, and not before the window", async () => {
    const { fake, client } = setup({ expiresIn: 60 });
    await client.accessToken();
    clock += 29_000; // 31 s left: still outside the 30 s window
    await client.accessToken();
    expect(fake.sessionsIssued()).toBe(1);
    clock += 2_000; // 29 s left: inside the window
    await client.accessToken();
    expect(fake.sessionsIssued()).toBe(2);
  });

  it("a 401 drops the cached token and retries ONCE with a fresh session", async () => {
    const { fake, client } = setup();
    await client.accessToken();
    fake.revokeTokens();
    const res = await client.call("GET", "/gateway/v3/certs", undefined, { kind: "gateway.certs" });
    expect(res.status).toBe(200);
    expect(fake.sessionsIssued()).toBe(2);

    // …and ONLY once: a gateway that keeps answering 401 gets the 401 back, not a loop.
    fake.on("GET", "/gateway/v3/certs", () => new Response(JSON.stringify({ code: "900901" }), { status: 401 }));
    const again = await client.call("GET", "/gateway/v3/certs", undefined, { kind: "gateway.certs" });
    expect(again.status).toBe(401);
    expect(fake.sessionsIssued()).toBe(3);
    expect(fake.requests.filter((r) => r.path === "/gateway/v3/certs")).toHaveLength(4);
  });

  it("the session call carries REQUEST-ID, TIMESTAMP and X-CM-ID, and the client-credentials body", async () => {
    const { fake, client } = setup();
    await client.accessToken();
    const [session] = fake.requests;
    expect(session!.method).toBe("POST");
    expect(session!.path).toBe("/gateway/v3/sessions");
    expect(session!.headers["request-id"]).toMatch(UUID);
    expect(session!.headers["timestamp"]).toBe("2026-09-25T10:00:00.000Z");
    expect(session!.headers["x-cm-id"]).toBe("sbx");
    expect(session!.headers["authorization"]).toBeUndefined();
    expect(session!.body).toEqual({ clientId: "SBX_0001", clientSecret: SECRET, grantType: "client_credentials" });
  });

  it("every call carries Authorization Bearer, a fresh REQUEST-ID, TIMESTAMP (ISO, ms, Z), X-CM-ID and the per-call facility header", async () => {
    const { fake, client } = setup();
    clock += 7; // a non-zero millisecond, so the format is visible
    const a = await client.call("PATCH", "/gateway/v3/bridge/url", { url: "https://x.test" }, { kind: "gateway.bridge_url", hipId: "IN0000000001" });
    const b = await client.call("GET", "/gateway/v3/certs", undefined, { kind: "gateway.certs", hiuId: "HIU-9" });
    const [patch, certs] = fake.requests.filter((r) => r.path !== "/gateway/v3/sessions");
    expect(patch!.headers["authorization"]).toMatch(/^Bearer fake-access-1-/);
    expect(patch!.headers["request-id"]).toMatch(UUID);
    expect(patch!.headers["request-id"]).toBe(a.requestId);
    expect(certs!.headers["request-id"]).toBe(b.requestId);
    expect(a.requestId).not.toBe(b.requestId);
    expect(patch!.headers["timestamp"]).toMatch(ISO_MS_Z);
    expect(patch!.headers["timestamp"]).toBe("2026-09-25T10:00:00.007Z");
    expect(patch!.headers["x-cm-id"]).toBe("sbx");
    expect(patch!.headers["x-hip-id"]).toBe("IN0000000001");
    expect(patch!.headers["x-hiu-id"]).toBeUndefined();
    expect(patch!.headers["content-type"]).toBe("application/json");
    expect(certs!.headers["x-hiu-id"]).toBe("HIU-9");
    expect(certs!.headers["x-hip-id"]).toBeUndefined();
  });

  it("an extra header may not overwrite one the client owns", async () => {
    const { client } = setup();
    await expect(client.call("GET", "/gateway/v3/certs", undefined, { extraHeaders: { "request-id": "mine" } }))
      .rejects.toThrow(/reserved/);
  });

  it("writes EVERY outbound call to the message log with secret-free headers — the session body never stored", async () => {
    const { client } = setup();
    const res = await client.call("PATCH", "/gateway/v3/bridge/url", { url: "https://x.test" }, { kind: "gateway.bridge_url" });
    const rows = await db.select().from(abdmMessages).orderBy(abdmMessages.createdAt, abdmMessages.id);
    expect(rows.map((r) => [r.direction, r.kind, r.httpStatus])).toEqual([
      ["out", "gateway.session", 202],
      ["out", "gateway.bridge_url", 202],
    ]);
    const bridge = rows.find((r) => r.kind === "gateway.bridge_url")!;
    expect(bridge.requestId).toBe(res.requestId);
    expect(bridge.path).toBe("/gateway/v3/bridge/url");
    expect(bridge.body).toEqual({ url: "https://x.test" });
    expect(bridge.headers).toMatchObject({ "REQUEST-ID": res.requestId, "X-CM-ID": "sbx", Authorization: "Bearer [redacted]" });
    const session = rows.find((r) => r.kind === "gateway.session")!;
    expect(session.body).toEqual({ redacted: expect.any(String) });
    expect(session.responseBody).toMatchObject({ redacted: expect.any(String), expiresIn: 1200 });

    const text = await storedText();
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/fake-access-/); // the bearer token is a credential too
    expect(text).not.toMatch(/fake-refresh-/);
  });

  it("a refused session throws WITHOUT the secret — even when the gateway echoes it back", async () => {
    const wrong = "Wrong-Secret-4b1d-echoed-by-the-gateway";
    const { client } = setup({ secret: wrong });
    const err = await client.accessToken().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AbdmGatewayError);
    expect((err as AbdmGatewayError).status).toBe(401);
    expect((err as Error).message).toMatch(/HTTP 401/);
    expect((err as Error).message).not.toContain(wrong);
    expect(String((err as Error).stack)).not.toContain(wrong);
    expect(JSON.stringify(err)).not.toContain(wrong);
    const text = await storedText();
    expect(text).toMatch(/ABDM-1017/); // the refusal IS recorded, for the operator…
    expect(text).not.toContain(wrong); // …scrubbed of what the gateway should never have echoed
  });

  it("a network failure is logged and thrown without the secret", async () => {
    const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: SECRET });
    const client = new AbdmGatewayClient(settingsFor(fake.baseUrl), {
      db, now,
      fetch: async () => { throw new Error(`connect ECONNREFUSED while sending ${SECRET}`); },
    });
    const err = await client.accessToken().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AbdmGatewayError);
    expect((err as Error).message).not.toContain(SECRET);
    const rows = await db.select().from(abdmMessages);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.httpStatus).toBeNull();
    expect(rows[0]!.error).toMatch(/ECONNREFUSED/);
    expect(await storedText()).not.toContain(SECRET);
  });

  it("the settings object never serialises the secret either", () => {
    const s = settingsFor("https://fake-gateway.test/api/hiecm");
    expect(s.clientSecret).toBe(SECRET);
    expect(JSON.stringify(s)).not.toContain(SECRET);
    expect(JSON.stringify({ ...s })).not.toContain(SECRET);
  });
});
