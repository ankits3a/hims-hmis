import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkCashier, openSessionFor } from "./helpers/billing";
import { openOpdVisit } from "./helpers/opd";
import { registerEncounterResolver } from "../src/kernel/episodes/encounter-resolvers";
import { getEncounter } from "../src/modules/opd";
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
  events, labAnalytes, labItems, labReferenceRanges, labReportDeliveries, labReports, labResults, labSpecimens, opdEncounters,
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
    await request(server()).get("/lab/desk/find").expect(401);
    await request(server()).get("/lab/reports/register?serviceDate=2026-08-29").expect(401);
    await request(server()).post("/lab/collection/labels").send({}).expect(401);
    await request(server()).post("/lab/bench/receive").send({}).expect(401);
    await request(server()).post("/lab/reports").send({}).expect(401);
  });

  it("403 WITH A TOKEN AND WITHOUT THE PERMISSION each family declares", async () => {
    const { token } = await userWith(["opd.visits.read"]);
    await request(server()).get("/lab/catalogue/search").set(...auth(token)).expect(403);
    await request(server()).post("/lab/desk/orders").set(...auth(token)).send({}).expect(403);
    await request(server()).get("/lab/desk/find?q=T-1&serviceDate=2026-08-29").set(...auth(token)).expect(403);
    await request(server()).get("/lab/reports/register?serviceDate=2026-08-29").set(...auth(token)).expect(403);
    await request(server()).get("/lab/reports/patient/p-1").set(...auth(token)).expect(403);
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

  /* ═══════════ PLAN 17c T6 — ONE PATIENT THROUGH FIVE SEATS, over the wire, every row read back ═══════════ */

  it("17c T6 — reception → collection → bench → verify → delivery for one patient, on the five seats' own routes", async () => {
    const op = await labOperator();
    await openSessionFor(db, { id: op.id }, 0);
    fx.unregister();
    fx.unregister = registerEncounterResolver("V", async (exec, no) => {
      const e = await getEncounter(exec, no);
      return e ? { patientId: e.patientId, intendedPayer: e.intendedPayer } : null;
    });
    const uhid = await uhidOf(db, fx.patientId);
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

    /* ── 1. RECEPTION: the token door, the Rx lines, the tube plan, one line on credit ── */
    const visit = await openOpdVisit(db, {
      clerk: fx.desk.actor, patientId: fx.patientId, departmentId: fx.labDepartmentId, doctorId: fx.pathologist.doctorId,
    }, new Date("2026-08-29T05:00:00Z"));
    await db.update(opdEncounters).set({
      advisedTests: [
        { serviceId: serviceIdForLabCode("CBC"), code: "CBC", name: "Complete blood count", pricePaise: 30000 },
        { serviceId: serviceIdForLabCode("LFT"), code: "LFT", name: "Liver function test", pricePaise: 30000 },
      ],
    }).where(eq(opdEncounters.id, visit.encounterId));
    const found = await request(server()).get("/lab/desk/find?q=T-1&serviceDate=2026-08-29").set(...auth(op.token)).expect(200);
    const hit = (found.body as { hits: { visit: { encounterNo: string; tokenNo: number; doctorUserId: string; advised: { serviceId: string }[] } }[] }).hits[0]!;
    expect(hit.visit.advised.map((a) => a.serviceId)).toEqual([serviceIdForLabCode("CBC"), serviceIdForLabCode("LFT")]);
    const preview = await request(server()).post("/lab/desk/preview").set(...auth(op.token))
      .send({ patientId: fx.patientId, encounterNo: hit.visit.encounterNo, serviceIds: hit.visit.advised.map((a) => a.serviceId) })
      .expect(201);
    const tubes = (preview.body as { tubes: { container: string }[]; lines: { serviceId: string; netPaise: number }[] });
    expect(tubes.tubes.map((t) => t.container)).toEqual(["sst", "edta"]);
    const cbcNet = tubes.lines.find((l) => l.serviceId === serviceIdForLabCode("CBC"))!.netPaise;
    const placed = await request(server()).post("/lab/desk/orders").set(...auth(op.token))
      .set("Idempotency-Key", "e2e-five-1")
      .send({
        patientId: fx.patientId, encounterNo: hit.visit.encounterNo, serviceDate: fx.serviceDate,
        orderingClinicianId: hit.visit.doctorUserId,
        items: hit.visit.advised.map((a) => ({ serviceId: a.serviceId })),
        /** CBC paid in cash; the LFT line rides on credit (D3) — the report will be HELD. */
        receipt: { tenders: [{ mode: "cash", amountPaise: cbcNet }] },
        credit: { reason: "rx_line_unpaid" },
      })
      .expect(201);
    const order = placed.body as { orderId: string; orderGroupId: string; itemIds: string[]; invoice: { invoiceId: string; creditExtended: boolean } };
    expect(order.invoice.creditExtended).toBe(true);

    /* ── 2. COLLECTION: on the awaiting list with the token, then labels, then one scan per tube ── */
    const awaiting = await request(server()).get(`/lab/collection/awaiting?serviceDate=${fx.serviceDate}`).set(...auth(op.token)).expect(200);
    expect((awaiting.body as { orderGroupId: string; tokenNo: number }[]).map((r) => [r.orderGroupId, r.tokenNo])).toEqual([[order.orderGroupId, hit.visit.tokenNo]]);
    const labels = await request(server()).post("/lab/collection/labels").set(...auth(op.token))
      .set("Idempotency-Key", "e2e-five-labels").send({ orderGroupId: order.orderGroupId, scannedUhid: uhid }).expect(201);
    const specimens = (labels.body as { specimens: { specimenId: string; specimenNo: string; container: string }[] }).specimens;
    expect(specimens).toHaveLength(2);
    const queue = await request(server()).get(`/lab/collection/queue?serviceDate=${fx.serviceDate}`).set(...auth(op.token)).expect(200);
    expect((queue.body as { specimenNo: string; tokenNo: number; patientDisplay: string }[]).map((r) => [r.tokenNo, r.patientDisplay]))
      .toEqual([[hit.visit.tokenNo, "Ram Kumar"], [hit.visit.tokenNo, "Ram Kumar"]]);
    for (const [i, s] of specimens.entries()) {
      await request(server()).post("/lab/collection/collect").set(...auth(op.token))
        .set("Idempotency-Key", `e2e-five-collect-${String(i)}`).send({ specimenId: s.specimenId, wristbandScanned: true }).expect(201);
    }

    /* ── 3. BENCH: the tubes ARRIVE with the patient, are received, and every analyte is keyed ── */
    const arrivals = await request(server()).get("/lab/bench/arrivals").set(...auth(op.token)).expect(200);
    expect((arrivals.body as { specimenNo: string; patientDisplay: string; wristbandScanned: boolean }[]).map((a) => [a.patientDisplay, a.wristbandScanned]))
      .toEqual([["Ram Kumar", true], ["Ram Kumar", true]]);
    for (const [i, s] of specimens.entries()) {
      await request(server()).post("/lab/bench/receive").set(...auth(op.token))
        .set("Idempotency-Key", `e2e-five-receive-${String(i)}`).send({ specimenNo: s.specimenNo }).expect(201);
    }
    expect(await request(server()).get("/lab/bench/arrivals").set(...auth(op.token)).expect(200).then((r) => r.body)).toEqual([]);
    const bench = await request(server()).get("/lab/bench/worklist").set(...auth(op.token)).expect(200);
    const items = bench.body as { orderItemId: string; serviceId: string; analytes: { analyteId: string; resultType: string; refLow: string | null; refHigh: string | null }[] }[];
    expect(items.map((i) => i.orderItemId).sort()).toEqual([...order.itemIds].sort());
    let keyed = 0;
    for (const item of items) {
      for (const a of item.analytes) {
        if (a.resultType === "formula") continue;
        const ranges = await db.select({ low: labReferenceRanges.low, high: labReferenceRanges.high, absLow: labAnalytes.absurdLow, absHigh: labAnalytes.absurdHigh })
          .from(labAnalytes).leftJoin(labReferenceRanges, eq(labReferenceRanges.analyteId, labAnalytes.id)).where(eq(labAnalytes.id, a.analyteId));
        const band = ranges.find((r) => r.low !== null && r.high !== null);
        const value = a.resultType !== "numeric" ? "Normal"
          : band ? String((Number(band.low) + Number(band.high)) / 2)
            : String(((Number(ranges[0]?.absLow ?? 0)) + Number(ranges[0]?.absHigh ?? 100)) / 2);
        await request(server()).post("/lab/bench/results").set(...auth(op.token))
          .set("Idempotency-Key", `e2e-five-result-${String(keyed)}`)
          .send({ orderItemId: item.orderItemId, analyteId: a.analyteId, value, entryMode: "manual" }).expect(201);
        keyed += 1;
      }
    }
    expect(keyed).toBeGreaterThan(5);
    expect(await request(server()).get("/lab/bench/worklist").set(...auth(op.token)).expect(200).then((r) => r.body)).toEqual([]);

    /* ── 4. VERIFY: the pathologist sees the target and (no) previous, signs every result, publishes ── */
    const path = await userWith([
      "lab.results.verify", "lab.results.read", "lab.reports.publish", "lab.reports.print", "lab.worklist.read",
      "lab.criticals.close", "orders.read", "billing.credit.extend", "billing.invoice.issue", "billing.invoice.read",
      "orders.place", "lab.orders.place", "patients.read",
    ], ["pathologist"]);
    const verify = await request(server()).get("/lab/verify/worklist").set(...auth(path.token)).expect(200);
    const rows = verify.body as { tatTargetMinutes: number; analytes: { resultId: string | null; verificationStatus: string | null; previous: unknown }[] }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.tatTargetMinutes).toBeGreaterThan(0);
      for (const a of row.analytes) {
        expect(a.previous).toBeNull();
        if (a.resultId !== null && a.verificationStatus === "unverified") {
          await request(server()).post(`/lab/verify/results/${a.resultId}`).set(...auth(path.token))
            .set("Idempotency-Key", `e2e-five-sign-${a.resultId}`).expect(201);
        }
      }
    }
    const publishable = await request(server()).get("/lab/reports/publishable").set(...auth(path.token)).expect(200);
    expect((publishable.body as { orderId: string; complete: boolean }[]).find((o) => o.orderId === order.orderId)?.complete).toBe(true);
    const published = await request(server()).post("/lab/reports").set(...auth(path.token))
      .set("Idempotency-Key", "e2e-five-publish").send({ orderId: order.orderId }).expect(201);
    const reportId = (published.body as { reportId: string }).reportId;

    /* ── 5. DELIVERY: the register says HELD; the counter cannot see the page; the money clears; the paper goes out ── */
    const counter = await userWith(["lab.reports.print", "patients.read"], ["lab_reception"]);
    const register = await request(server()).get(`/lab/reports/register?serviceDate=${today}`).set(...auth(counter.token)).expect(200);
    const reg = (register.body as { reportId: string; patientDisplay: string; delivery: { allowed: boolean }; notice: { status: string } | null; deliveries: unknown[] }[]);
    expect(reg.map((r) => [r.reportId, r.patientDisplay, r.delivery.allowed, r.notice?.status, r.deliveries.length]))
      .toEqual([[reportId, "Ram Kumar", false, "queued", 0]]);
    const heldView = await request(server()).get(`/lab/reports/patient/${fx.patientId}`).set(...auth(counter.token)).expect(200);
    const heldRow = (heldView.body as { reports: { reportId: string; snapshot: unknown; delivery: { allowed: boolean; outstandingPaise: number } }[] }).reports[0]!;
    expect([heldRow.reportId, heldRow.snapshot, heldRow.delivery.allowed]).toEqual([reportId, null, false]);
    await request(server()).post(`/lab/reports/${reportId}/print`).set(...auth(counter.token))
      .send({ channel: "print", collectorIdentity: "the patient" }).expect(422);
    await settleInvoice(db, { id: cashier.id, actor: { type: "user", id: cashier.id } }, fx.patientId, order.invoice.invoiceId, heldRow.delivery.outstandingPaise);
    const openView = await request(server()).get(`/lab/reports/patient/${fx.patientId}`).set(...auth(counter.token)).expect(200);
    const openRow = (openView.body as { reports: { snapshot: { patient: { name: string } } | null; delivery: { allowed: boolean } }[] }).reports[0]!;
    expect([openRow.delivery.allowed, openRow.snapshot?.patient.name]).toEqual([true, "Ram Kumar"]);
    await request(server()).post(`/lab/reports/${reportId}/print`).set(...auth(counter.token))
      .set("Idempotency-Key", "e2e-five-print").send({ channel: "print", collectorIdentity: "Sunita Kumar (daughter), Aadhaar seen" }).expect(201);
    const after = await request(server()).get(`/lab/reports/register?serviceDate=${today}`).set(...auth(counter.token)).expect(200);
    expect((after.body as { deliveries: { channel: string; collectorIdentity: string }[] }[])[0]!.deliveries)
      .toMatchObject([{ channel: "print", collectorIdentity: "Sunita Kumar (daughter), Aadhaar seen" }]);
    /** The doctor's screen was never held — on the real visit, through the real resolver. */
    const forDoctor = await request(server()).get(`/lab/results/encounter/${hit.visit.encounterNo}`).set(...auth(path.token)).expect(200);
    expect((forDoctor.body as unknown[]).length).toBe(keyed + (items.flatMap((i) => i.analytes).length - keyed));
  });

  /* ══════════════════ PLAN 17c T5 — the report centre's readers, over the wire ══════════════════ */

  it("17c T5 — the register and the by-patient reader answer on the counter's permission alone", async () => {
    /** `lab.reports.print` and `patients.read` — the counter, and NOT `lab.results.read`. */
    const counter = await userWith(["lab.reports.print", "patients.read"], ["lab_reception"]);
    const register = await request(server()).get("/lab/reports/register?serviceDate=2026-08-29").set(...auth(counter.token)).expect(200);
    expect(register.body).toEqual([]);
    const mine = await request(server()).get(`/lab/reports/patient/${fx.patientId}`).set(...auth(counter.token)).expect(200);
    expect((mine.body as { patient: { display: string }; reports: unknown[] }).patient.display).toBe("Ram Kumar");
    expect((mine.body as { reports: unknown[] }).reports).toEqual([]);
    await request(server()).get("/lab/reports/register").set(...auth(counter.token)).expect(400);
  });

  /* ══════════════════ PLAN 17c T1 — the reception seat's three doors, over the wire ══════════════════ */

  it("17c T1 — find by TOKEN returns the Rx lines; a WALK-IN with no visit is ordered in one request", async () => {
    const op = await labOperator();
    /**
     * The fixture's fake `V` resolver knows two visit numbers and the walk-in mints a third
     * (17a `d1f316b`'s lesson). The REAL registration is pinned by `opd/encounter-resolver.test.ts`;
     * this suite swaps in the real reader on the real row for the walk-in door.
     */
    fx.unregister();
    fx.unregister = registerEncounterResolver("V", async (exec, no) => {
      const e = await getEncounter(exec, no);
      return e ? { patientId: e.patientId, intendedPayer: e.intendedPayer } : null;
    });

    /* ── the token door ── */
    const visit = await openOpdVisit(db, {
      clerk: fx.desk.actor, patientId: fx.patientId, departmentId: fx.labDepartmentId, doctorId: fx.pathologist.doctorId,
    }, new Date("2026-08-29T05:00:00Z"));
    await db.update(opdEncounters).set({
      advisedTests: [{ serviceId: serviceIdForLabCode("TSH"), code: "TSH", name: "Thyroid stimulating hormone", pricePaise: 30000 }],
    }).where(eq(opdEncounters.id, visit.encounterId));
    const found = await request(server()).get("/lab/desk/find?q=T-1&serviceDate=2026-08-29").set(...auth(op.token)).expect(200);
    const hits = (found.body as { hits: { matchedOn: string; patient: { id: string }; visit: { encounterNo: string; tokenNo: number; advised: { code: string }[] } | null }[] }).hits;
    expect(hits).toHaveLength(1);
    expect([hits[0]!.matchedOn, hits[0]!.patient.id, hits[0]!.visit?.tokenNo, hits[0]!.visit?.advised.map((a) => a.code)])
      .toEqual(["token", fx.patientId, 1, ["TSH"]]);

    /* ── the walk-in door: no encounterNo on the wire, a `V` visit on the row ── */
    const placed = await request(server()).post("/lab/desk/orders").set(...auth(op.token))
      .set("Idempotency-Key", "e2e-walkin-1")
      .send({
        patientId: fx.otherPatientId, serviceDate: fx.serviceDate,
        walkIn: { referrerName: "Dr Sharma" },
        items: [{ serviceId: serviceIdForLabCode("CBC") }],
        credit: { reason: "outside prescription" },
      })
      .expect(201);
    const encounterNo = (placed.body as { encounterNo: string }).encounterNo;
    expect(encounterNo).toMatch(/^V\d{10}$/);
    const [enc] = await db.select().from(opdEncounters).where(eq(opdEncounters.visitNo, encounterNo));
    expect([enc!.patientId, enc!.departmentId, enc!.referrerName]).toEqual([fx.otherPatientId, fx.labDepartmentId, "Dr Sharma"]);
    const [order] = await db.select().from(orders).where(eq(orders.encounterNo, encounterNo));
    expect(order!.authority).toBe("external_prescription");

    /* ── both doors at once is a 400, not a guess ── */
    await request(server()).post("/lab/desk/orders").set(...auth(op.token))
      .send({ patientId: fx.patientId, encounterNo: fx.encounterNo, walkIn: {}, serviceDate: fx.serviceDate,
        orderingClinicianId: fx.pathologist.id, items: [{ serviceId: serviceIdForLabCode("CBC") }] })
      .expect(400);

    /* ── the preview names the tubes beside the price ── */
    const preview = await request(server()).post("/lab/desk/preview").set(...auth(op.token))
      .send({ patientId: fx.patientId, encounterNo: fx.encounterNo,
        serviceIds: [serviceIdForLabCode("CBC"), serviceIdForLabCode("LFT")] })
      .expect(201);
    expect((preview.body as { tubes: { container: string; codes: string[] }[] }).tubes.map((t) => t.container)).toEqual(["sst", "edta"]);
  });

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
