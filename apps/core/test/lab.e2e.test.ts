import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkCashier, openSessionFor } from "./helpers/billing";
import {
  grantLabResultPermissions, seedLabDeskBase, serviceIdForLabCode, settleInvoice, uhidOf,
} from "./helpers/lab";
import { loadConfig, requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import {
  events, labAnalytes, labItems, labReportDeliveries, labReports, labResults, labSpecimens,
  orderItems, orders,
} from "../src/kernel/db/schema";
import type { LabDeskFixture } from "./helpers/lab";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 17b T8 — **THE LABORATORY OVER HTTP, END TO END.**
 *
 * ═══ WHY EVERY ASSERTION HERE IS OVER THE WIRE AND OVER THE ROWS IT WROTE ═══
 *
 * 22c-A's close review C1: a field missing from a route's zod schema returned **200 and wrote
 * nothing**, and every test in that phase had called the service directly. So this suite posts real
 * bodies to real routes and then reads the DATABASE — the order, the tube, the result, the report,
 * the delivery register — because a status code proves that a handler returned, not that it did
 * anything.
 *
 * ═══ AND THE ERROR MAP IS EXECUTED, NOT ASSERTED ═══
 *
 * Plan 09, Plan 13 and Plan 15 each shipped a module error escaping `toHttp` and reaching a counter
 * as a **500**. `lab-http.ts` maps seven classes; this suite drives a real refusal from each one it
 * can reach through a real route and asserts a 4xx carrying the module's own `code`. **A 500
 * anywhere in this file is the defect.**
 */
jest.setTimeout(180_000);

describe("the laboratory over HTTP (17b T8)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let app: INestApplication;
  let fx: LabDeskFixture;
  let cashier: { id: string };
  const cfg = loadConfig({
    DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY!,
  } as NodeJS.ProcessEnv);

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await teardown();
  });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    cashier = await mkCashier(db, "lab.e2e.cashier");
    await openSessionFor(db, cashier, 0);
  });
  afterEach(() => { fx.unregister(); });

  const server = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];
  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];

  /**
   * ═══ PERMISSIONS **AND** ROLES, AND THE SECOND HALF IS THE ONE THAT SURPRISES (§9.2 F39) ═══
   *
   * `@RequirePermission` gates the ROUTE; the workflow engine gates the TRANSITION on the
   * definition's declared ROLE LIST and it checks `user_roles`, not permissions (17a S4). So a user
   * holding all fifteen lab permissions and none of the four lab ROLE KEYS reaches every handler
   * and is refused `role_denied` by `ordered → awaiting_collection` the moment it prints a label.
   *
   * **This is a go-live fact, not a test detail**: the runbook must grant the roles as well as the
   * permissions, and T9 says so. It was found HERE, by the e2e, exactly as this suite exists to —
   * every service-level suite passed because their fixtures use the real role-bearing users.
   */
  async function userWith(
    permissions: string[],
    roleKeys: readonly string[] = [],
  ): Promise<{ token: string; id: string }> {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    const suffix = Math.random().toString(36).slice(2, 9);
    const { id } = await createUser(db, {
      username: `lab${suffix}`, fullName: "Laboratory", password: "correct horse battery",
    });
    if (permissions.length > 0) {
      const roleKey = `labr${suffix}`;
      await createRole(db, roleKey, "Laboratory");
      for (const p of permissions) await grantPermissionToRole(db, registry, roleKey, p);
      await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    }
    for (const roleKey of roleKeys) await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    const { token } = await createSession(db, cfg, id);
    return { token, id };
  }

  /** Every permission the laboratory declares, on one login — the small hospital's one operator. */
  async function labOperator(): Promise<{ token: string; id: string }> {
    return userWith([
      "lab.orders.place", "lab.catalogue.read", "lab.catalogue.manage", "lab.desk.operate",
      "lab.collection.operate", "lab.accession.operate", "lab.results.enter", "lab.results.verify",
      "lab.results.read", "lab.reports.publish", "lab.reports.print", "lab.reports.amend",
      "lab.reports.release_unpaid", "lab.criticals.close", "lab.worklist.read",
      "orders.place", "orders.read", "orders.cancel",
      "billing.invoice.issue", "billing.invoice.read", "billing.credit.extend",
      "billing.credit_note.issue", "patients.read",
    ], ["lab_reception", "lab_technician", "phlebotomist"]);
  }

  const analyteIdFor = async (code: string): Promise<string> =>
    (await db.select({ id: labAnalytes.id }).from(labAnalytes).where(eq(labAnalytes.code, code)))[0]!.id;

  /* ══════════════════════════ 401 and 403 on every family ══════════════════════════ */

  it("401 WITHOUT A TOKEN on every controller", async () => {
    await request(server()).get("/lab/catalogue/search").expect(401);
    await request(server()).post("/lab/desk/orders").send({}).expect(401);
    await request(server()).post("/lab/collection/labels").send({}).expect(401);
    await request(server()).post("/lab/bench/receive").send({}).expect(401);
    await request(server()).post("/lab/reports").send({}).expect(401);
  });

  it("403 WITH A TOKEN AND WITHOUT THE PERMISSION each family declares", async () => {
    const { token } = await userWith(["opd.visits.read"]);
    await request(server()).get("/lab/catalogue/search").set(...auth(token)).expect(403);
    await request(server()).post("/lab/desk/orders").set(...auth(token)).send({}).expect(403);
    await request(server()).post("/lab/collection/labels").set(...auth(token)).send({}).expect(403);
    await request(server()).post("/lab/bench/results").set(...auth(token)).send({}).expect(403);
    await request(server()).post("/lab/verify/results/r1").set(...auth(token)).expect(403);
    await request(server()).post("/lab/reports").set(...auth(token)).send({}).expect(403);
  });

  /**
   * ═══ DD16's SEPARATIONS, AS ROUTES ═══
   *
   * A technologist who keys numbers all day may not sign one, and a counter clerk who hands reports
   * over all day may not publish one. A route that shared a permission would make the table
   * decorative — which is exactly what the manifest's own header says these splits exist to avoid.
   */
  it("DD16 — `results.enter` does NOT open the verify route, and `reports.print` does not publish", async () => {
    const tech = await userWith(["lab.results.enter", "lab.worklist.read"]);
    await request(server()).post("/lab/verify/results/r1").set(...auth(tech.token)).expect(403);
    const clerk = await userWith(["lab.reports.print", "lab.results.read"]);
    await request(server()).post("/lab/reports").set(...auth(clerk.token))
      .send({ orderId: "o1" }).expect(403);
  });

  /**
   * ═══ §9.2 F39 — FIFTEEN PERMISSIONS AND NO ROLE IS A LOGIN THAT CANNOT DRAW BLOOD ═══
   *
   * Found by this suite and by nothing else in the phase. Every service-level fixture uses users
   * built with the real role keys, so the gap was invisible to 243 green tests. The runbook (T9)
   * grants both, and this row is what stops a future seed granting only one.
   */
  it("F39: a login with every lab PERMISSION and no lab ROLE is refused role_denied at the label", async () => {
    const permissionsOnly = await userWith([
      "lab.desk.operate", "lab.orders.place", "lab.collection.operate", "lab.catalogue.read",
      "orders.place", "orders.read", "patients.read",
      "billing.invoice.issue", "billing.invoice.read", "billing.credit.extend",
    ]);
    const placed = await request(server()).post("/lab/desk/orders").set(...auth(permissionsOnly.token))
      .send({
        patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
        orderingClinicianId: fx.pathologist.id,
        items: [{ serviceId: serviceIdForLabCode("TSH") }],
        credit: { reason: "counter order" },
      }).expect(201);

    const refused = await request(server()).post("/lab/collection/labels").set(...auth(permissionsOnly.token))
      .send({
        orderGroupId: (placed.body as { orderGroupId: string }).orderGroupId,
        scannedUhid: await uhidOf(db, fx.patientId),
      }).expect(403);
    /** A 403 with a WORKFLOW code — not a permission one. The message names the roles it wants. */
    expect((refused.body as { code: string }).code).toBe("role_denied");
    expect((refused.body as { message: string }).message).toContain("lab_technician");
    expect(await db.select().from(labSpecimens)).toHaveLength(0);
  });

  /* ══════════════════ THE WHOLE CHAIN, OVER THE WIRE, ROW BY ROW ══════════════════ */

  it("desk → labels → collect → receive → result → verify → publish → print, and every row is READ BACK", async () => {
    const op = await labOperator();
    const uhid = await uhidOf(db, fx.patientId);

    /* ── 1. THE DESK. The BODY it wrote is what is asserted, not the 201. ── */
    const placed = await request(server()).post("/lab/desk/orders").set(...auth(op.token))
      .set("Idempotency-Key", "e2e-desk-1")
      .send({
        patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
        orderingClinicianId: fx.pathologist.id,
        items: [{ serviceId: serviceIdForLabCode("TSH") }],
        credit: { reason: "counter order" },
      })
      .expect(201);
    const orderId = (placed.body as { orderId: string }).orderId;
    const itemIds = (placed.body as { itemIds: string[] }).itemIds;
    const [orderRow] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect([orderRow!.kind, orderRow!.encounterNo, orderRow!.status])
      .toEqual(["lab", fx.encounterNo, "open"]);
    const [labItem] = await db.select().from(labItems).where(eq(labItems.orderItemId, itemIds[0]!));
    expect(labItem!.chargeReason).toBe("lab_desk");
    expect(labItem!.invoiceId).not.toBeNull();

    /** DD19 — THE SAME KEY REPLAYS THE ORIGINAL RESULT AND PLACES NOTHING. */
    const replay = await request(server()).post("/lab/desk/orders").set(...auth(op.token))
      .set("Idempotency-Key", "e2e-desk-1")
      .send({
        patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
        orderingClinicianId: fx.pathologist.id,
        items: [{ serviceId: serviceIdForLabCode("TSH") }],
        credit: { reason: "counter order" },
      })
      .expect(201);
    expect((replay.body as { orderId: string }).orderId).toBe(orderId);
    expect(await db.select().from(orders)).toHaveLength(1);

    /* ── 2. THE LABEL, with the scan that has to happen first (DD10). ── */
    const labels = await request(server()).post("/lab/collection/labels").set(...auth(op.token))
      .set("Idempotency-Key", "e2e-labels-1")
      .send({ orderGroupId: (placed.body as { orderGroupId: string }).orderGroupId, scannedUhid: uhid });
    expect(labels.status).toBe(201);
    const specimen = (labels.body as { specimens: { specimenId: string; specimenNo: string }[] }).specimens[0]!;
    const [tube] = await db.select().from(labSpecimens).where(eq(labSpecimens.id, specimen.specimenId));
    expect([tube!.status, tube!.patientId]).toEqual(["labelled", fx.patientId]);

    /* ── 3. THE DRAW, and 4. THE BENCH. The TAT clock starts at RECEIVE, never before. ── */
    await request(server()).post("/lab/collection/collect").set(...auth(op.token))
      .send({ specimenId: specimen.specimenId, wristbandScanned: true }).expect(201);
    await request(server()).post("/lab/bench/receive").set(...auth(op.token))
      .set("Idempotency-Key", "e2e-receive-1")
      .send({ specimenNo: specimen.specimenNo }).expect(201);
    const [afterReceive] = await db.select().from(labItems)
      .where(eq(labItems.orderItemId, itemIds[0]!));
    expect(afterReceive!.tatStartedAt).not.toBeNull();
    const [envelope] = await db.select().from(orderItems).where(eq(orderItems.id, itemIds[0]!));
    expect(envelope!.status).toBe("in_progress");

    /* ── 5. THE NUMBER, with its range snapshotted at entry (DD2). ── */
    const entered = await request(server()).post("/lab/bench/results").set(...auth(op.token))
      .set("Idempotency-Key", "e2e-result-1")
      .send({
        orderItemId: itemIds[0]!, analyteId: await analyteIdFor("TSH"),
        value: "5.5", entryMode: "manual",
      })
      .expect(201);
    const resultId = (entered.body as { resultId: string }).resultId;
    const [resultRow] = await db.select().from(labResults).where(eq(labResults.id, resultId));
    expect([resultRow!.flag, resultRow!.refLow, resultRow!.refHigh, resultRow!.verificationStatus])
      .toEqual(["H", "0.3500", "4.9400", "unverified"]);

    /* ── 6. THE SIGNATURE. A second pair of hands: the operator entered, so a verifier signs. ── */
    await request(server()).post(`/lab/verify/results/${resultId}`).set(...auth(op.token))
      .set("Idempotency-Key", "e2e-verify-1")
      .expect(403);
    const path = await userWith([
      "lab.results.verify", "lab.results.read", "lab.reports.publish", "lab.reports.print",
      "lab.worklist.read", "orders.read", "billing.credit.extend", "billing.invoice.issue",
      "billing.invoice.read", "orders.place", "lab.orders.place", "patients.read",
    ], ["pathologist"]);
    await request(server()).post(`/lab/verify/results/${resultId}`).set(...auth(path.token))
      .set("Idempotency-Key", "e2e-verify-1")
      .expect(201);
    const [signed] = await db.select().from(labResults).where(eq(labResults.id, resultId));
    expect([signed!.verificationStatus, signed!.verifiedBy]).toEqual(["verified", path.id]);
    const [completed] = await db.select().from(orderItems).where(eq(orderItems.id, itemIds[0]!));
    expect(completed!.status).toBe("completed");

    /* ── 7. THE DOCUMENT, and the interlock in front of the hand-over. ── */
    const report = await request(server()).post("/lab/reports").set(...auth(path.token))
      .set("Idempotency-Key", "e2e-publish-1")
      .send({ orderId }).expect(201);
    const reportId = (report.body as { reportId: string }).reportId;
    const [reportRow] = await db.select().from(labReports).where(eq(labReports.id, reportId));
    expect([reportRow!.version, reportRow!.status, reportRow!.signedBy])
      .toEqual([1, "published", path.id]);

    /** THE INTERLOCK, over the wire: 422 with the module's own code, never a 402 and never a 500. */
    const held = await request(server()).post(`/lab/reports/${reportId}/print`).set(...auth(path.token))
      .send({ channel: "print", collectorIdentity: "the patient" }).expect(422);
    expect((held.body as { code: string }).code).toBe("report_print_blocked");
    expect(await db.select().from(labReportDeliveries)).toHaveLength(0);
    expect(await db.select().from(events).where(eq(events.name, "lab.report_print_blocked")))
      .toHaveLength(1);

    /* ── 8. THE MONEY CLEARS, AND THE SAME REQUEST SUCCEEDS. ── */
    await settleInvoice(db, { id: cashier.id, actor: { type: "user", id: cashier.id } },
      fx.patientId, labItem!.invoiceId!, orderRow!.id === orderId ? 30000 : 30000);
    const printed = await request(server()).post(`/lab/reports/${reportId}/print`).set(...auth(path.token))
      .set("Idempotency-Key", "e2e-print-1")
      .send({ channel: "print", collectorIdentity: "Sunita Kumar (daughter), Aadhaar seen" })
      .expect(201);
    expect((printed.body as { printCount: number }).printCount).toBe(1);
    const [delivery] = await db.select().from(labReportDeliveries);
    expect([delivery!.channel, delivery!.collectorIdentity])
      .toEqual(["print", "Sunita Kumar (daughter), Aadhaar seen"]);

    /* ── 9. THE DOCTOR'S READ IS NEVER HELD, AND IT IS ON THE WIRE TOO (02 O-1). ── */
    const forDoctor = await request(server())
      .get(`/lab/results/encounter/${fx.encounterNo}`).set(...auth(path.token)).expect(200);
    expect((forDoctor.body as { analyteCode: string }[])[0]!.analyteCode).toBe("TSH");
  });

  /* ══════════════ EVERY ERROR FAMILY, THROUGH A REAL ROUTE, AS A 4xx ══════════════ */

  it("walks a refusal from each error family through the wire — and NONE of them is a 500", async () => {
    const op = await labOperator();

    /** `LabError` — the module's own union. 404 for an unknown row. */
    const unknown = await request(server()).get("/lab/reports/nope").set(...auth(op.token)).expect(404);
    expect((unknown.body as { code: string }).code).toBe("unknown_report");

    /** `LabError` — 404 for an orderable this hospital does not carry (`unknown_service`). */
    const orphan = await request(server()).post("/lab/desk/orders").set(...auth(op.token))
      .send({
        patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
        orderingClinicianId: fx.pathologist.id,
        items: [{ serviceId: "SVC-NOT-IN-THE-CATALOGUE" }],
        credit: { reason: "x" },
      }).expect(404);
    expect((orphan.body as { code: string }).code).toBe("unknown_service");

    /** `LabError` — 422, a clinical hard stop: an HIV test keyed without recorded consent. */
    const consent = await request(server()).post("/lab/desk/orders").set(...auth(op.token))
      .send({
        patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
        orderingClinicianId: fx.pathologist.id,
        items: [{ serviceId: serviceIdForLabCode("HIV") }],
        credit: { reason: "x" },
      }).expect(422);
    expect((consent.body as { code: string }).code).toBe("consent_required");

    /** `LabError` — 403, the PCPNDT refusal, which is the one that names an Act. */
    const foetal = await request(server()).post("/lab/catalogue/orderables").set(...auth(op.token))
      .send({
        serviceId: "SVC-X", code: "USG-SEX", nameEn: "Foetal sex", discipline: "clinical_pathology",
        specimenType: "none", container: "none", tatMinutesRoutine: 30,
        reportsFoetalSex: true, analyteCodes: ["TSH"],
      }).expect(422);
    expect((foetal.body as { code: string }).code).toBe("foetal_sex_refused");

    /** `TariffError` — an orderable the tariff has no price for. The go-live failure, as a 4xx. */
    const unpriced = await request(server()).post("/lab/desk/orders").set(...auth(op.token))
      .send({
        patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
        orderingClinicianId: fx.pathologist.id,
        items: [{ serviceId: serviceIdForLabCode("TROPI") }],
        credit: { reason: "x" },
      });
    expect(unpriced.status).toBeGreaterThanOrEqual(400);
    expect(unpriced.status).toBeLessThan(500);
    expect((unpriced.body as { code: string }).code).toBe("tariff_item_missing");

    /** `LabError` — 409, a CAS/state refusal: a tube that was never drawn cannot be accessioned. */
    const notReceivable = await request(server()).post("/lab/bench/receive").set(...auth(op.token))
      .send({ specimenNo: "S0000000000" }).expect(404);
    expect((notReceivable.body as { code: string }).code).toBe("unknown_specimen");

    /** A zod refusal is a 400 carrying the ISSUES — a counter cannot fix "invalid body". */
    const bad = await request(server()).post("/lab/bench/results").set(...auth(op.token))
      .send({ orderItemId: "i1" }).expect(400);
    expect(Array.isArray((bad.body as { message: unknown }).message)).toBe(true);
  });

  /**
   * ═══ 22c-A's C1, AS AN ASSERTION ABOUT THIS PHASE'S OWN SCHEMAS ═══
   *
   * A field the wire schema omits does not reach the service, and the request looks like a success.
   * The three below are the fields whose LOSS is silent and expensive, so each is sent and then read
   * back off the ROW it was supposed to reach.
   */
  it("22c-A C1 — `reflexConsent`, `consent` and `priority` reach the ROW, not just the handler", async () => {
    const op = await labOperator();
    const placed = await request(server()).post("/lab/desk/orders").set(...auth(op.token))
      .send({
        patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
        orderingClinicianId: fx.pathologist.id,
        priority: "stat",
        reflexConsent: true,
        items: [{ serviceId: serviceIdForLabCode("HIV"), consent: { recordedBy: "Nurse Priya" } }],
        credit: { reason: "counter order" },
      }).expect(201);
    const itemId = (placed.body as { itemIds: string[] }).itemIds[0]!;
    const [row] = await db.select().from(labItems).where(eq(labItems.orderItemId, itemId));
    expect([row!.priority, row!.consentRecordedBy]).toEqual(["stat", "Nurse Priya"]);
    expect(row!.reflexConsentedAt).not.toBeNull();
    expect(row!.consentRecordedAt).not.toBeNull();
  });
});
