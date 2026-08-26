import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { newId } from "@hmis/contracts";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { differingByOneChar } from "./helpers/mutate";
import {
  commissionAccruals, counterparties, partnerAgreements, receivableExpectations, registrationConfig,
  roles,
} from "../src/kernel/db/schema";
import { loadConfig, requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 09 T7 — THE HTTP SURFACE A BROWSER ACTUALLY CALLS.
 *
 * 11h's close review (MAJOR 5) found a whole feature whose assertions were against FUNCTIONS while
 * the route itself — its zod schema, its guard, its status codes — had no test of any kind. The
 * FIRST tests below are the ones that lesson names: an unauthenticated call, and a call with a
 * token but without the permission each route declares.
 *
 * ═══ THE FLAG IS THE SUBJECT OF THE FIRST REAL TEST, NOT AN AFTERTHOUGHT ═══
 *
 * `RECEIVABLE_COMMISSION_ENABLED` ships OFF (DD14, O-8 — the owner's). What a deployed hospital
 * gets TODAY is a mounted, guarded, permission-checked route surface that refuses to write
 * anything, and that is asserted here as the shipped behaviour rather than described in a comment.
 * The rest of the suite arms the flag to exercise the lane the owner will one day turn on.
 *
 * Every partner, code, reference and amount below is INVENTED HERE (DD3 / owner ruling O-9).
 */
const FLAG = "RECEIVABLE_COMMISSION_ENABLED";

describe("partner receivables over HTTP", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let app: INestApplication;
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! } as NodeJS.ProcessEnv);

  const AGREEMENT_FROM = new Date("2026-01-01T00:00:00Z");
  let previousFlag: string | undefined;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    previousFlag = process.env[FLAG];
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardown();
    if (previousFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = previousFlag;
  });

  beforeEach(async () => {
    process.env[FLAG] = "true";
    await truncateAll(db);
    await seedSodPairs(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
  });

  const server = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];

  async function deskUser(permissions: string[]): Promise<{ token: string; actor: Actor }> {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    const suffix = Math.random().toString(36).slice(2, 9);
    const { id } = await createUser(db, { username: `u${suffix}`, fullName: "Desk", password: "correct horse battery" });
    if (permissions.length > 0) {
      const roleKey = `r${suffix}`;
      await createRole(db, roleKey, "Desk");
      for (const p of permissions) await grantPermissionToRole(db, registry, roleKey, p);
      await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    }
    await db.insert(roles).values({ key: `noop-${suffix}`, title: "noop" }).onConflictDoNothing();
    const { token } = await createSession(db, cfg, id);
    return { token, actor: { type: "user", id } };
  }

  async function partnerFor(): Promise<string> {
    const counterpartyId = newId();
    await db.insert(counterparties).values({
      id: counterpartyId, code: `INV-CP-${counterpartyId.slice(-6)}`, name: "Invented Diagnostic Partner",
      payeeClass: "channel_partner", status: "active", createdBy: "test",
    });
    await db.insert(partnerAgreements).values({
      id: newId(), counterpartyId, versionNo: 1, effectiveFrom: AGREEMENT_FROM,
      effectiveTo: null, status: "active", createdBy: "test",
      terms: {
        payableRateBps: 1_000, eligibleCategories: ["diagnostics"], kicker: null,
        receivableRateBps: 1_500, unclaimedExpiryDays: 45,
      },
    });
    return counterpartyId;
  }

  const ALL_PERMISSIONS = [
    "partners.attribution.issue", "partners.statement.import",
    "partners.receivable.operate", "partners.ledger.read",
  ];

  // ── 11h MAJOR 5 — the guards, first ───────────────────────────────────────────────────────

  it("401 WITHOUT A TOKEN on every route — they are guarded like every other", async () => {
    await request(server()).post("/partners/attributions").send({}).expect(401);
    await request(server()).get("/partners/attributions/RF-1").expect(401);
    await request(server()).post("/partners/attributions/x/void").send({}).expect(401);
    await request(server()).post("/partners/statements/import").send({}).expect(401);
    await request(server()).get("/partners/statements/S1/quarantine").expect(401);
    await request(server()).post("/partners/refs").send({}).expect(401);
    await request(server()).post("/partners/receivables/x/write-off").send({}).expect(401);
    await request(server()).post("/partners/receivables/expire").send({}).expect(401);
    await request(server()).get("/partners/receivables/aging").expect(401);
  });

  it("403 with a token but WITHOUT the permission each route declares", async () => {
    const { token } = await deskUser([]);
    const auth = (r: request.Test): request.Test => r.set("Authorization", `Bearer ${token}`);
    await auth(request(server()).post("/partners/attributions").send({})).expect(403);
    await auth(request(server()).post("/partners/statements/import").send({})).expect(403);
    await auth(request(server()).post("/partners/refs").send({})).expect(403);
    await auth(request(server()).get("/partners/receivables/aging")).expect(403);
  });

  /**
   * DD18 — the four permissions are declared on `partnersManifest` and held by NOBODY in the
   * shipped role model, so a real deployment answers 403 to every route above until the owner
   * grants them. Asserted against the manifest itself, so the census cannot drift from the routes.
   */
  it("DD18 — every permission these routes require is declared by `partnersManifest`", () => {
    const manifest = ALL_MANIFESTS.find((m) => m.key === "partners")!;
    for (const permission of ALL_PERMISSIONS) expect(manifest.permissions).toContain(permission);
    expect(manifest.menu).toEqual([
      { label: "Partner receivables", path: "/partners/receivables", permission: "partners.receivable.operate" },
    ]);
  });

  // ── THE FLAG, AS SHIPPED (DD14 / O-8) ─────────────────────────────────────────────────────

  it("with `RECEIVABLE_COMMISSION_ENABLED` OFF every write route is a typed 409 and NOTHING is written", async () => {
    delete process.env[FLAG];
    const counterpartyId = await partnerFor();
    const { token } = await deskUser(ALL_PERMISSIONS);
    const auth = (r: request.Test): request.Test => r.set("Authorization", `Bearer ${token}`);

    const issued = await auth(request(server())
      .post("/partners/attributions")
      .send({ counterpartyId, referredValuePaise: 400_000 })).expect(409);
    expect(issued.body).toMatchObject({ statusCode: 409, code: "receivable_disabled" });

    await auth(request(server())
      .post("/partners/statements/import")
      .send({ counterpartyId, statementRef: "S1", statementPeriod: "2026-M08", csv: "attribution_ref,partner_ref,amount_paise\nRF-1,,1\n" }))
      .expect(409);
    await auth(request(server()).post("/partners/receivables/expire").send({})).expect(409);

    expect(await db.select().from(receivableExpectations)).toHaveLength(0);
    expect(await db.select().from(commissionAccruals)).toHaveLength(0);

    // …and the READ still answers, with zeros. An operator confirming the lane is inert must not
    // be refused the one screen that would tell them.
    const aging = await auth(request(server()).get("/partners/receivables/aging")).expect(200);
    expect(aging.body.totals).toMatchObject({ outstandingPaise: 0, confirmedPaise: 0 });
  });

  // ── THE LANE, ARMED ───────────────────────────────────────────────────────────────────────

  it("issues a slip whose response carries the QR payload and NO identity field (DD15)", async () => {
    const counterpartyId = await partnerFor();
    const { token } = await deskUser(ALL_PERMISSIONS);

    const res = await request(server())
      .post("/partners/attributions")
      .set("Authorization", `Bearer ${token}`)
      .send({ counterpartyId, serviceHint: "outbound imaging", referredValuePaise: 400_000 })
      .expect(201);

    expect(res.body).toMatchObject({ counterpartyId, expectedPaise: 60_000, patientId: null });
    expect(res.body.qrPayload).toBe(res.body.code);
    expect(Object.keys(res.body).sort()).toEqual([
      "attributionId", "code", "counterpartyId", "expectationId", "expectedPaise", "expiresAt",
      "issuedAt", "patientId", "qrPayload", "serviceHint",
    ]);
  });

  it("the wedge's scan route resolves the printed code and 404s a near miss", async () => {
    const counterpartyId = await partnerFor();
    const { token } = await deskUser(ALL_PERMISSIONS);
    const issued = await request(server())
      .post("/partners/attributions").set("Authorization", `Bearer ${token}`)
      .send({ counterpartyId, referredValuePaise: 400_000 }).expect(201);
    const code = issued.body.code as string;

    const scanned = await request(server())
      .get(`/partners/attributions/${code}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(scanned.body).toMatchObject({
      code, counterpartyId, state: "issued",
      expectation: { state: "expected", amountPaise: 60_000 },
    });

    const missed = await request(server())
      // `differingByOneChar`, not a literal X: one ULID in 32 ends in X and would re-request the
      // REAL code, turning this 404 assertion into a 200 at random (test/helpers/mutate.ts).
      .get(`/partners/attributions/${differingByOneChar(code)}`).set("Authorization", `Bearer ${token}`).expect(404);
    expect(missed.body).toMatchObject({ code: "unknown_attribution" });
  });

  it("a statement imports over HTTP, and the same file a second time is a typed 409", async () => {
    const counterpartyId = await partnerFor();
    const { token } = await deskUser(ALL_PERMISSIONS);
    const issued = await request(server())
      .post("/partners/attributions").set("Authorization", `Bearer ${token}`)
      .send({ counterpartyId, referredValuePaise: 400_000 }).expect(201);

    const body = {
      counterpartyId, statementRef: "INV-STMT-E2E", statementPeriod: "2026-M08",
      csv: `attribution_ref,partner_ref,amount_paise\n${issued.body.code as string},,60000\n`,
    };
    const first = await request(server())
      .post("/partners/statements/import").set("Authorization", `Bearer ${token}`).send(body).expect(201);
    expect(first.body).toMatchObject({ linesMatched: 1, linesDisputed: 0, confirmedPaise: 60_000 });

    const second = await request(server())
      .post("/partners/statements/import").set("Authorization", `Bearer ${token}`).send(body).expect(409);
    expect(second.body).toMatchObject({ code: "statement_already_imported" });
  });

  it("V1 over HTTP — a claim against a slip we never issued disputes, and the line is readable verbatim", async () => {
    const counterpartyId = await partnerFor();
    const { token } = await deskUser(ALL_PERMISSIONS);

    const res = await request(server())
      .post("/partners/statements/import").set("Authorization", `Bearer ${token}`)
      .send({
        counterpartyId, statementRef: "INV-STMT-V1", statementPeriod: "2026-M08",
        csv: "attribution_ref,partner_ref,amount_paise\nRF-NOSUCHSLIP,,60000\n",
      }).expect(201);
    expect(res.body).toMatchObject({ linesDisputed: 1, confirmedPaise: 0 });

    const quarantine = await request(server())
      .get("/partners/statements/INV-STMT-V1/quarantine").set("Authorization", `Bearer ${token}`).expect(200);
    expect(quarantine.body.rows).toEqual([
      { id: expect.any(String), rowNo: 2, reason: "unknown_attribution", line: "RF-NOSUCHSLIP,,60000" },
    ]);
  });

  it("a malformed body is a 400 in the module's own error shape, never a 500", async () => {
    const { token } = await deskUser(ALL_PERMISSIONS);
    const res = await request(server())
      .post("/partners/attributions").set("Authorization", `Bearer ${token}`)
      .send({ counterpartyId: "", referredValuePaise: -1 }).expect(400);
    expect(res.body).toMatchObject({ statusCode: 400, code: "invalid_request" });

    const badColumns = await request(server())
      .post("/partners/statements/import").set("Authorization", `Bearer ${token}`)
      .send({ counterpartyId: await partnerFor(), statementRef: "S", statementPeriod: "2026-M08", csv: "ref,amount\nRF-1,1\n" })
      .expect(400);
    expect(badColumns.body).toMatchObject({ statusCode: 400, code: "statement_columns_unknown" });
  });

  it("an unknown counterparty is a 404 and an already-matched void is a 409 — both typed", async () => {
    const counterpartyId = await partnerFor();
    const { token } = await deskUser(ALL_PERMISSIONS);
    await request(server())
      .post("/partners/attributions").set("Authorization", `Bearer ${token}`)
      .send({ counterpartyId: newId(), referredValuePaise: 1 }).expect(404);

    const issued = await request(server())
      .post("/partners/attributions").set("Authorization", `Bearer ${token}`)
      .send({ counterpartyId, referredValuePaise: 400_000 }).expect(201);
    await db.update(receivableExpectations).set({ state: "matched" });

    const refused = await request(server())
      .post(`/partners/attributions/${issued.body.attributionId as string}/void`)
      .set("Authorization", `Bearer ${token}`).send({ reason: "cancelled" }).expect(409);
    expect(refused.body).toMatchObject({ code: "expectation_state_conflict" });
  });

  it("the aging report over HTTP shows the referral nobody mentioned, and carries no identity", async () => {
    const counterpartyId = await partnerFor();
    const { token } = await deskUser(ALL_PERMISSIONS);
    await request(server())
      .post("/partners/attributions").set("Authorization", `Bearer ${token}`)
      .send({ counterpartyId, referredValuePaise: 400_000 }).expect(201);

    const res = await request(server())
      .get(`/partners/receivables/aging?counterpartyId=${counterpartyId}`)
      .set("Authorization", `Bearer ${token}`).expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ state: "expected", bucket: "0-30", amountPaise: 60_000 });
    expect(res.body.totals).toMatchObject({ outstandingPaise: 60_000, confirmedPaise: 0 });
    for (const forbidden of ["uhid", "patientId", "phone", "holderName"]) {
      expect(JSON.stringify(res.body)).not.toContain(forbidden);
    }
  });

  it("V4 and V5 over HTTP — a cancelled referral voids, and the sweep writes off what is overdue", async () => {
    const counterpartyId = await partnerFor();
    const { token } = await deskUser(ALL_PERMISSIONS);
    const issued = await request(server())
      .post("/partners/attributions").set("Authorization", `Bearer ${token}`)
      .send({ counterpartyId, referredValuePaise: 400_000 }).expect(201);

    const voided = await request(server())
      .post(`/partners/attributions/${issued.body.attributionId as string}/void`)
      .set("Authorization", `Bearer ${token}`).send({ reason: "referred test cancelled" }).expect(201);
    expect(voided.body).toMatchObject({ state: "void", expectationIds: [issued.body.expectationId] });

    // Nothing is overdue now, so the sweep is a clean no-op that says so.
    const swept = await request(server())
      .post("/partners/receivables/expire").set("Authorization", `Bearer ${token}`).send({}).expect(201);
    expect(swept.body).toEqual({ expiredExpectationIds: [], expiredAttributionIds: [] });
  });
});
