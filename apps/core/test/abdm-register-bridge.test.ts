import { setupTestDb, truncateAll } from "./helpers/db";
import { createFakeAbdmGateway } from "./helpers/abdm-fake-gateway";
import { abdmMessages } from "../src/kernel/db/schema";
import { loadConfig } from "../src/kernel/config";
import { registerBridge } from "../scripts/abdm-register-bridge";
import type { Db } from "../src/kernel/db/client";

/**
 * ABDM S0 — the operator CLI that tells ABDM where to send callbacks: `PATCH
 * {gateway}/gateway/v3/bridge/url` with `{"url": <callback base>}` (NHA wrapper README §5). It is
 * run once, by an operator, after the credentials exist. `scripts/` is not type-checked by the core
 * tsconfig, so this import is also what puts the script under `pnpm typecheck`.
 */
describe("abdm-register-bridge", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const SECRET = "bridge-secret-01c9";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  const env = (baseUrl: string, over: Record<string, string> = {}) => loadConfig({
    DATABASE_URL: "postgres://unused",
    SECRET_KEY: process.env.SECRET_KEY!,
    ABDM_BASE_URL: baseUrl,
    ABDM_CLIENT_ID: "SBX_0001",
    ABDM_CLIENT_SECRET: SECRET,
    ABDM_HIP_ID: "IN0000000001",
    ABDM_CALLBACK_BASE_URL: "https://hmis.example.test/api/abdm/callbacks",
    ...over,
  }).abdm;

  it("REFUSES when ABDM is not configured, and sends nothing", async () => {
    const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: SECRET });
    await expect(registerBridge({ abdm: env(fake.baseUrl, { ABDM_CALLBACK_BASE_URL: "" }), db, fetch: fake.fetch }))
      .rejects.toThrow(/ABDM not configured/);
    expect(fake.requests).toHaveLength(0);
  });

  it("PATCHes the configured callback base to /gateway/v3/bridge/url, with the bearer, and reports ABDM's answer", async () => {
    const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: SECRET });
    const result = await registerBridge({ abdm: env(fake.baseUrl), db, fetch: fake.fetch });
    expect(result.status).toBe(202);
    expect(result.url).toBe("https://hmis.example.test/api/abdm/callbacks");
    const patch = fake.requests.find((r) => r.method === "PATCH")!;
    expect(patch.url).toBe(`${fake.baseUrl}/gateway/v3/bridge/url`);
    expect(patch.body).toEqual({ url: "https://hmis.example.test/api/abdm/callbacks" });
    expect(patch.headers["authorization"]).toMatch(/^Bearer /);
    expect(patch.headers["x-cm-id"]).toBe("sbx");
    const rows = await db.select().from(abdmMessages);
    expect(rows.map((r) => r.kind).sort()).toEqual(["gateway.bridge_url", "gateway.session"]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it("passes ABDM's refusal through rather than claiming success", async () => {
    const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: SECRET });
    fake.on("PATCH", "/gateway/v3/bridge/url", () => new Response(JSON.stringify({ error: { code: "ABDM-1150", message: "Bridge API version cannot be null" } }), { status: 400 }));
    const result = await registerBridge({ abdm: env(fake.baseUrl), db, fetch: fake.fetch });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: { code: "ABDM-1150", message: "Bridge API version cannot be null" } });
  });
});
