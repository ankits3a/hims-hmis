import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { openSessionFor } from "./helpers/billing";
import {
  OT_IMPLANT_SERVICE_CODE, mkOtPatient, mkOtUser, otPatientCard, publishOtDefinition, seedOtBase,
} from "./helpers/ot";
import { daycareEncounters, otCaseImplants, otDepositHolds, roles } from "../src/kernel/db/schema";
import { loadConfig, requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { otManifest } from "../src/modules/ot";
import { recordReceipt } from "../src/modules/billing";
import { handleMaterialConsumed } from "../src/modules/ot/consumers";
import { materialConsumed } from "../src/modules/materials";
import { appendEvent } from "../src/kernel/events/append";
import { withTx } from "../src/kernel/db/client";
import type { OtBaseFixture } from "./helpers/ot";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 15 T8 — **THE HTTP SURFACE A THEATRE ACTUALLY CALLS, AND THE WHOLE CASE THROUGH IT.**
 *
 * ═══ THE MAPPING IS WALKED, NOT ASSERTED ═══
 *
 * A `MembershipError` once reached a counter as a 500 because one controller's `toHttp` had no
 * clause for it; Plan 13 shipped the same defect IN THE FIX for the first; Plan 14's own e2e caught
 * an unmapped `ApprovalError`. This module raises FIVE classes, so this suite drives a refusal from
 * every one of them through a real HTTP request and asserts a 4xx with the module's own code.
 * **A 500 anywhere here is the defect.**
 *
 * ═══ THE CHAIN, END TO END ═══
 *
 * book → gates → list → holding → sign-in → time-out → counts → implant → sign-out → bay → scores →
 * escort → discharge → bill, over HTTP, with the materials consumer run in-process where the
 * asynchronous half would otherwise leave the case unable to sign out. That is T8's acceptance and
 * the only test in the phase that proves the pieces compose through the ROUTES.
 */
jest.setTimeout(120_000);

describe("the mini-OT over HTTP (Plan 15 T8)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let app: INestApplication;
  let f: OtBaseFixture;
  let patientId: string;
  let cashier: Actor;
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
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await teardown();
  });

  beforeEach(async () => {
    await truncateAll(db);
    f = await seedOtBase(db);
    patientId = await mkOtPatient(db, f.coordinator, "Sunita Devi", { phone: "9800001111" });
    cashier = await mkOtUser(db, "ot_cashier_e2e", ["cashier"]);
    await openSessionFor(db, { id: cashier.id }, 0);
  });

  const server = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];

  async function userWith(permissions: string[]): Promise<{ token: string; id: string }> {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    const suffix = Math.random().toString(36).slice(2, 9);
    const { id } = await createUser(db, {
      username: `u${suffix}`, fullName: "Theatre", password: "correct horse battery",
    });
    if (permissions.length > 0) {
      const roleKey = `r${suffix}`;
      await createRole(db, roleKey, "Theatre");
      for (const p of permissions) await grantPermissionToRole(db, registry, roleKey, p);
      await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    }
    await db.insert(roles).values({ key: `noop-${suffix}`, title: "noop" }).onConflictDoNothing();
    const { token } = await createSession(db, cfg, id);
    return { token, id };
  }

  const ALL_PERMISSIONS = otManifest.permissions;

  /** Authenticated, and holding NOTHING from this module — the honest 403 subject. */
  async function frontOfficeUser(): Promise<{ token: string }> {
    return userWith(["opd.visits.read"]);
  }

  const auth = (token: string): [string, string] => ["Authorization", `Bearer ${token}`];

  // ═══════════════════════════ 401 and 403 ═══════════════════════════

  it("401 WITHOUT A TOKEN on every family", async () => {
    await request(server()).get("/ot/definitions/criteria").expect(401);
    await request(server()).post("/ot/cases").send({}).expect(401);
    await request(server()).post("/ot/cockpit/c1/sign-in").send({}).expect(401);
    await request(server()).get("/ot/recovery/board").expect(401);
  });

  it("403 WITH A TOKEN AND WITHOUT THE PERMISSION each family declares", async () => {
    const { token } = await frontOfficeUser();
    await request(server()).get("/ot/definitions/criteria").set(...auth(token)).expect(403);
    await request(server()).post("/ot/cases").set(...auth(token)).send({}).expect(403);
    await request(server()).post("/ot/cockpit/c1/sign-in").set(...auth(token)).send({}).expect(403);
    await request(server()).get("/ot/recovery/board").set(...auth(token)).expect(403);
    await request(server()).get("/ot/recovery/e1/bill-preview").set(...auth(token)).expect(403);
  });

  /**
   * DD14's separations, as ROUTES. A coordinator who may satisfy gates all morning may not reach the
   * override lane; a recovery nurse who may discharge may not compose the bill. These are the two
   * splits the permission table exists for, and a route that shared one permission would make the
   * table decorative.
   */
  it("DD14 — `gates.satisfy` does NOT open the override lane, and `discharge` does not open the bill", async () => {
    const satisfier = await userWith(["ot.gates.satisfy", "ot.cases.read"]);
    await request(server()).post("/ot/gates/g1/override").set(...auth(satisfier.token))
      .send({ surgeonId: "u1", anaesthetistId: "u2", reason: "x" }).expect(403);

    const discharger = await userWith(["ot.discharge", "ot.recovery.operate"]);
    await request(server()).get("/ot/recovery/e1/bill-preview").set(...auth(discharger.token)).expect(403);
  });

  // ═══════════════════════════ the five error families ═══════════════════════════

  /**
   * EVERY family, driven to a 4xx. The list is the `toHttp` mapper's own clause list, so a class
   * added to the module without a clause fails here rather than at a desk.
   */
  it("every error family maps to a 4xx and never a 500", async () => {
    const { token } = await userWith([...ALL_PERMISSIONS]);

    // 1. OtError — a class outside the ACTIVE whitelist.
    const criteria = await request(server()).post("/ot/cases").set(...auth(token)).send({
      patientId, procedureCode: "X", procedureClass: "ortho_mua", surgeonId: f.surgeon.id,
      listDate: "2026-09-02", payerClass: "self_pay",
    });
    expect(criteria.status).toBe(422);
    expect(criteria.body).toMatchObject({ code: "criteria_refused" });

    // 2. OtError — an unknown case is a 404, distinguishable from "wrong state".
    const unknown = await request(server()).get("/ot/cases/no-such-case/pack").set(...auth(token));
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: "unknown_case" });

    // 3. WorkflowError — a case in the wrong state for a transition is a 409, not a crash.
    const booked = await request(server()).post("/ot/cases").set(...auth(token)).send({
      patientId, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id,
      listDate: "2026-09-02", payerClass: "self_pay",
    }).expect(201);
    const caseId = (booked.body as { caseId: string }).caseId;
    const tooEarly = await request(server()).post(`/ot/cockpit/${caseId}/sign-in`).set(...auth(token)).send({});
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body).toMatchObject({ code: "bad_transition" });

    // 4. SodViolationError — one nurse as both scrub and circulating is a 403 with the pair named.
    const sod = await request(server()).post(`/ot/cockpit/${caseId}/counts`).set(...auth(token)).send({
      round: "final", itemType: "swab", expected: 10, counted: 10,
      scrubBy: f.otNurse.id, circulatingBy: f.otNurse.id,
    });
    expect(sod.status).toBe(403);
    expect(sod.body).toMatchObject({ code: "sod_violation", detail: { pairKey: "scrub_circulating" } });

    // 5. A zod refusal is a 400, and it is NOT one of the five — a malformed body is the caller's.
    const malformed = await request(server()).post("/ot/cases").set(...auth(token)).send({ patientId });
    expect(malformed.status).toBe(400);

    // 6. ResourceError — reached through the recovery bay. `already_occupied` is a 409.
    //    (The OT maps it to its own `bay_occupied`; the point is that neither is a 500.)
    const bad = await request(server()).post("/ot/recovery/no-such-encounter/admit")
      .set(...auth(token)).send({ bayResourceId: f.bayIds[0]! });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
  });

  // ═══════════════════════════ THE CHAIN ═══════════════════════════

  /**
   * ═══ ONE CASE, END TO END, THROUGH THE ROUTES ═══
   *
   * The plan's T8 acceptance in one test. Every step is an HTTP call by a user holding the
   * permission that step declares — not the god-token — so the permission table is walked as well
   * as the state machine.
   */
  it("walks a whole day-care case: book → gates → list → theatre → recovery → discharge → bill", async () => {
    /**
     * ═══ EACH USER HOLDS BOTH A PERMISSION SET AND A DOMAIN ROLE, AND THE TWO ARE DIFFERENT GATES ═══
     *
     * `@RequirePermission` guards the ROUTE; the workflow definition's `transitions[].roles` guards
     * the STATE MOVE. A coordinator with `ot.gates.satisfy` and no `daycare_coordinator` role gets
     * past the controller and is refused `role_denied` by the engine — which is exactly what the
     * first run of this test did, as a 403 at the first gate. Both checks are real and neither
     * substitutes for the other, so every user here carries both, as a hospital's would.
     */
    const coordinator = await userWith(["ot.cases.book", "ot.cases.read", "ot.gates.satisfy", "ot.list.manage"]);
    await assignRole(db, { userId: coordinator.id, roleKey: "daycare_coordinator", scopeType: "hospital" });
    const nurse = await userWith(["ot.cockpit.operate", "ot.counts.record", "ot.implants.scan", "ot.cases.read"]);
    await assignRole(db, { userId: nurse.id, roleKey: "ot_nurse", scopeType: "hospital" });
    const anaes = await userWith(["ot.cockpit.operate", "ot.cases.read"]);
    await assignRole(db, { userId: anaes.id, roleKey: "anaesthetist", scopeType: "hospital" });
    const surgeonUser = await userWith(["ot.cockpit.operate", "ot.cases.read"]);
    await assignRole(db, { userId: surgeonUser.id, roleKey: "surgeon", scopeType: "hospital" });
    const recovery = await userWith(["ot.recovery.operate", "ot.discharge", "ot.cases.read"]);
    await assignRole(db, { userId: recovery.id, roleKey: "recovery_nurse", scopeType: "hospital" });
    const biller = await userWith(["ot.bill.compose"]);
    await assignRole(db, { userId: biller.id, roleKey: "cashier", scopeType: "hospital" });
    await openSessionFor(db, { id: biller.id }, 0);

    /**
     * The e2e's surgeon is a NEW user, so the ACTIVE privilege list has to name them — and the first
     * run of this test proved the gate is live over HTTP by refusing the booking **403
     * `privilege_refused`** with `holds: []`. That is R-3.15 working ("outside privilege = booking
     * REFUSED, not a warning") and it is worth recording rather than quietly working around: the
     * fixture publishes a privilege list for the fixture's own surgeon, and a chain that walks a
     * different one has to credential them exactly as a credentialing committee would.
     */
    await publishOtDefinition(db, {
      kind: "privileges",
      body: {
        surgeons: [
          { surgeonId: surgeonUser.id, procedureClasses: ["gynae_dnc"] },
          { surgeonId: f.surgeon.id, procedureClasses: ["gynae_dnc"] },
        ],
      },
      drafter: f.drafter, ms: f.ms,
    });

    // ── BOOK ──
    const booked = await request(server()).post("/ot/cases").set(...auth(coordinator.token)).send({
      patientId, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: surgeonUser.id, anaesthetistId: anaes.id,
      anaesthesiaType: "general", listDate: "2026-09-02", payerClass: "self_pay",
    });
    expect({ status: booked.status, body: booked.body }).toMatchObject({ status: 201 });
    const { caseId, encounterId, encounterNo } = booked.body as { caseId: string; encounterId: string; encounterNo: string };
    expect(encounterNo).toMatch(/^D\d{10}$/);

    // ── THE DEPOSIT ──
    const { receiptId } = await recordReceipt(db, cashier, {
      patientId, tenders: [{ mode: "upi", amountPaise: 6_000_000, refText: "UPI/E2E" }],
    });
    await request(server()).post(`/ot/encounters/${encounterId}/deposit-hold`)
      .set(...auth(coordinator.token)).send({ receiptId, amountPaise: 6_000_000 }).expect(201);

    // ── THE GATES ──
    const gates = (await request(server()).get(`/ot/cases/${caseId}/gates`)
      .set(...auth(coordinator.token)).expect(200)).body as { id: string; kind: string }[];
    const gate = (kind: string): string => gates.find((g) => g.kind === kind)!.id;
    const consent = {
      procedureCode: "GYN-DNC-01", templateVersion: "v3", language: "hi", signer: "patient",
      thumbImpression: false, laterality: null, conversionCovered: true, signedAt: "2026-09-01T10:00:00.000Z",
    };
    for (const [kind, evidence] of [
      ["consent_procedure", consent],
      ["consent_anaesthesia", consent],
      ["anaesthesia_review", { asaGrade: 1, reviewedBy: anaes.id, reviewedAt: "2026-08-30T06:00:00.000Z" }],
      ["npo", {
        plannedStart: "2026-09-02T03:30:00.000Z", lastSolidsAt: "2026-09-01T16:00:00.000Z",
        lastClearFluidsAt: "2026-09-01T21:00:00.000Z", attestedBy: "patient",
      }],
      ["escort", {
        name: "Ram Kumar", relation: "husband", phone: "9800002222",
        idType: "aadhaar", idLast4: "4321", ageYears: 40,
      }],
      ["privilege", {}],
      ["deposit", {}],
    ] as [string, Record<string, unknown>][]) {
      await request(server()).post(`/ot/gates/${gate(kind)}/satisfy`)
        .set(...auth(coordinator.token)).send(evidence).expect(201);
    }

    // ── PUBLISH: the case reaches `ready` in the same call ──
    const published = await request(server()).post("/ot/lists/publish").set(...auth(coordinator.token))
      .send({ listDate: "2026-09-02", theatreResourceId: f.theatreId }).expect(201);
    expect((published.body as { readyCaseIds: string[] }).readyCaseIds).toEqual([caseId]);

    /**
     * ═══ THE SEAM, POSTED THE WAY THE COCKPIT POSTS IT ═══
     *
     * `resequenceList` in `apps/web/src/lib/ot-api.ts` sent `{ order, reason }` and this route reads
     * `caseIdsInOrder` and declared no `reason`. **This route had no end-to-end test at all**, which
     * is how two ends of one seam disagreed in a deployed module without a suite noticing: every
     * unit test called `resequence()` directly with the server's own field names, so the wire
     * between them was exercised by nothing.
     *
     * Sent here as the client sends it, `reason` included, so the two ends cannot drift apart again
     * without this failing.
     */
    await request(server()).post("/ot/lists/resequence").set(...auth(coordinator.token))
      .send({
        listDate: "2026-09-02", theatreResourceId: f.theatreId,
        caseIdsInOrder: [caseId], reason: "surgeon delayed in OPD",
      }).expect(201);

    // ── HOLDING: the wristband ──
    const card = await otPatientCard(db, patientId);
    const verified = await request(server()).post(`/ot/cockpit/${caseId}/verify-holding`)
      .set(...auth(nurse.token)).send({ qrPayload: card }).expect(201);
    expect(verified.body).toEqual({ ok: true });
    await request(server()).post(`/ot/cockpit/${caseId}/to-holding`).set(...auth(nurse.token)).send({}).expect(201);

    // ── THEATRE ──
    await request(server()).post(`/ot/cockpit/${caseId}/sign-in`).set(...auth(anaes.token)).send({}).expect(201);
    await request(server()).post(`/ot/cockpit/${caseId}/checklist`).set(...auth(nurse.token)).send({
      phase: "timeout", items: [{ key: "site_confirmed", answer: "yes" }],
      participants: [surgeonUser.id, anaes.id, nurse.id],
    }).expect(201);
    await request(server()).post(`/ot/cockpit/${caseId}/time-out`).set(...auth(nurse.token)).send({}).expect(201);
    await request(server()).post(`/ot/cockpit/${caseId}/incision`).set(...auth(surgeonUser.token)).send({}).expect(201);

    // ── THE IMPLANT, and its asynchronous half ──
    const deployed = await request(server()).post(`/ot/cockpit/${caseId}/implants`).set(...auth(nurse.token)).send({
      itemId: f.implantItemId, batchId: "b-plate-e2e", lotId: "lot-e2e",
      storeResourceId: f.consignmentStoreId, serviceCode: OT_IMPLANT_SERVICE_CODE,
      qtyBase: 1, serial: "SN-E2E-1",
    }).expect(201);
    expect(deployed.body).toMatchObject({ state: "deploying" });

    await request(server()).post(`/ot/cockpit/${caseId}/closure`).set(...auth(surgeonUser.token)).send({}).expect(201);
    await request(server()).post(`/ot/cockpit/${caseId}/counts`).set(...auth(nurse.token)).send({
      round: "final", itemType: "swab", expected: 10, counted: 10,
      scrubBy: nurse.id, circulatingBy: recovery.id,
    }).expect(201);
    await request(server()).post(`/ot/cockpit/${caseId}/checklist`).set(...auth(nurse.token)).send({
      phase: "signout", items: [], participants: [nurse.id],
    }).expect(201);

    // A18 — sign-out is REFUSED while the implant has no ledger fact. Over HTTP, as a 422.
    const tooSoon = await request(server()).post(`/ot/cockpit/${caseId}/sign-out`).set(...auth(nurse.token)).send({});
    expect(tooSoon.status).toBe(422);
    expect(tooSoon.body).toMatchObject({ code: "implant_deploying" });

    /**
     * ═══ THE MATERIALS HALF, IN THE ORDER PRODUCTION WRITES IT ═══
     *
     * The first version of this chain ran only OT's consumer and then asked for a bill — and got a
     * bill with NO implant line, silently ₹42,000 short. That is the honest shape of the seam:
     * `handleMaterialConsumed` moves OT's implant `deploying → confirmed`, but the line the bill is
     * composed from is materials' own `stock_ledger` consume row, which `consumptionsFor` reads
     * (DD13's one call). The consumer confirming is NOT the consumption. So this writes materials'
     * three facts first — batch, ledger row, `material.consumed` — exactly as Plan 14's issue path
     * does, and only then runs the consumer, which is the arrival order a worker produces.
     *
     * The three money operands are deliberately all different (§2.102): tariff ₹50,000, batch MRP
     * ₹42,000, gazette ceiling ₹45,000. A fixture where they coincide cannot tell which one the
     * clamp picked, and the assertion below names `mrp` because ₹42,000 is the least of the three.
     */
    await db.execute(sql`
      insert into stock_batches (id, item_id, batch_no, expiry_date, landed_cost_paise, ownership, vendor_id, mrp_paise, mrp_uom, created_by)
      values ('b-plate-e2e', ${f.implantItemId}, 'BATCH-E2E', '2028-01-01', 100, 'consignment', null, 4200000, 'each', 't')
      on conflict (id) do nothing
    `);
    await db.execute(sql`
      insert into stock_ledger (id, resource_id, batch_id, item_id, qty_delta, reason, ref_type, ref_id,
                                patient_id, encounter_id, actor_id, occurred_at)
      values ('led-e2e-1', ${f.consignmentStoreId}, 'b-plate-e2e', ${f.implantItemId}, -1, 'consume',
              'ot_case', ${caseId}, ${patientId}, ${encounterId}, ${nurse.id}, '2026-09-02T05:00:00.000Z')
    `);
    await db.execute(sql`
      insert into item_price_regulations (id, item_id, effective_from, ceiling_paise, mrp_default_paise, mrp_uom, gazette_ref, created_by)
      values (${newId()}, ${f.implantItemId}, '2026-01-01', 4500000, 4200000, 'each', 'NPPA/2026/1', 't')
    `);
    const consumedPayload = {
      ledgerEntryId: "led-e2e-1", itemId: f.implantItemId, batchId: "b-plate-e2e",
      ownership: "consignment" as const, vendorId: null, qtyBase: 1, patientId, encounterId,
      caseRef: { type: "ot_case" as const, id: caseId },
      mrpPaise: 4_200_000, mrpUom: "each", mrpPaisePerBase: 4_200_000, ceilingPaisePerBase: 4_500_000,
      occurredAt: "2026-09-02T05:00:00.000Z",
    };
    await withTx(db, (tx) => appendEvent(tx, materialConsumed.make({
      actor: { type: "system", id: "materials.consumption" },
      patientId, encounterId, occurredAt: new Date("2026-09-02T05:00:00.000Z"),
      payload: consumedPayload,
    })));

    // The materials consumer, run IN-PROCESS — the worker's half, without a worker.
    await withTx(db, (tx) => handleMaterialConsumed(tx, "e2e-consumed-1", consumedPayload));
    const implant = (await db.select().from(otCaseImplants).where(eq(otCaseImplants.caseId, caseId)))[0]!;
    expect({ state: implant.state, ledgerEntryId: implant.ledgerEntryId })
      .toEqual({ state: "confirmed", ledgerEntryId: "led-e2e-1" });

    await request(server()).post(`/ot/cockpit/${caseId}/sign-out`).set(...auth(nurse.token)).send({}).expect(201);
    await request(server()).post(`/ot/cockpit/${caseId}/wheel-out`).set(...auth(nurse.token)).send({}).expect(201);

    // ── RECOVERY ──
    await request(server()).post(`/ot/recovery/${encounterId}/admit`).set(...auth(recovery.token))
      .send({ bayResourceId: f.bayIds[0]! }).expect(201);
    const board = (await request(server()).get("/ot/recovery/board").set(...auth(recovery.token)).expect(200)).body as
      { code: string; occupantRef: string | null }[];
    expect(board.find((b) => b.code === "RB-1")).toMatchObject({ occupantRef: encounterId });

    const score = { vitals: 2, ambulation: 2, nausea: 2, pain: 2, bleeding: 2 };
    await request(server()).post(`/ot/recovery/${encounterId}/scores`).set(...auth(recovery.token))
      .send({ caseId, values: score, occurredAt: new Date(Date.now() - 60 * 60_000).toISOString() }).expect(201);
    const second = await request(server()).post(`/ot/recovery/${encounterId}/scores`).set(...auth(recovery.token))
      .send({ caseId, values: score, occurredAt: new Date(Date.now() - 20 * 60_000).toISOString() }).expect(201);
    expect((second.body as { readiness: { ready: boolean } }).readiness.ready).toBe(true);

    // A21 — discharge is refused without a DISCHARGE-time escort verification. Over HTTP.
    const noEscort = await request(server()).post(`/ot/recovery/${encounterId}/discharge`)
      .set(...auth(recovery.token)).send({ caseId, isbarAcknowledgedBy: "Lata Gowda" });
    expect(noEscort.status).toBe(422);
    expect(noEscort.body).toMatchObject({ code: "escort_required" });

    await request(server()).post(`/ot/recovery/${encounterId}/escort`).set(...auth(recovery.token)).send({
      at: "discharge",
      escort: {
        name: "Ram Kumar", relation: "husband", phone: "9800002222",
        idType: "aadhaar", idLast4: "4321", ageYears: 40,
      },
    }).expect(201);
    await request(server()).post(`/ot/recovery/${encounterId}/discharge`).set(...auth(recovery.token))
      .send({ caseId, isbarAcknowledgedBy: "Lata Gowda" }).expect(201);

    // ── THE BILL, by a DIFFERENT desk ──
    const preview = (await request(server()).get(`/ot/recovery/${encounterId}/bill-preview`)
      .set(...auth(biller.token)).expect(200)).body as {
        implantLines: { boundApplied: string; capUnitPaise: number }[]; packageLines: unknown[];
      };
    expect(preview.packageLines).toHaveLength(1);
    // The implant is clamped to its MRP, not billed at the ₹50,000 tariff.
    expect(preview.implantLines).toHaveLength(1);
    expect(preview.implantLines[0]).toMatchObject({ boundApplied: "mrp", capUnitPaise: 4_200_000 });

    /**
     * ═══ THE BALANCE IS REFUSED BEFORE IT IS TAKEN, AND THE REFUSAL IS READABLE ═══
     *
     * ₹1,02,000 billed against a ₹60,000 deposit leaves ₹42,000, and billing's D2 step 3 will not
     * issue an invoice that is left unsettled without a credit extension. Asking for the bill with
     * NO tender therefore has to fail — and the first run of this chain proved it failed as a
     * **500**, because T8's `toHttp` did not map `BillingError`. It is a 409 now, and the assertion
     * below is what stops it silently becoming a 500 again.
     */
    const noTender = await request(server()).post(`/ot/recovery/${encounterId}/bill`)
      .set(...auth(biller.token)).send({});
    expect({ status: noTender.status, code: (noTender.body as { code?: string }).code })
      .toEqual({ status: 409, code: "unsettled_issue_refused" });

    // The counter takes the ₹42,000 balance — under §269ST's ₹2,00,000 cash limit, so cash is legal.
    const settledRes = await request(server()).post(`/ot/recovery/${encounterId}/bill`)
      .set(...auth(biller.token)).send({ cashTenderPaise: 4_200_000 });
    expect({ status: settledRes.status, body: settledRes.body }).toMatchObject({ status: 201 });
    const settled = settledRes.body as {
        invoiceNo: string; netPayablePaise: number; allocatedPaise: number; refundPaise: number;
      };
    /**
     * ₹60,000 package + ₹42,000 implant = ₹1,02,000, settled to the paise: the ₹60,000 deposit hold
     * plus the ₹42,000 taken at the counter. `allocatedPaise` is the SUM of both legs
     * (`allocatedPaise + settledFromHeldPaise` in `settleDischargeBill`) — this assertion first
     * predicted it was the deposit share alone, and the execution corrected the prediction.
     *
     * Asserting only the total would pass just as happily if the deposit had been ignored and the
     * whole ₹1,02,000 taken in cash — which is a real failure (the patient pays twice and waits for
     * a refund), and one §269ST would make illegal above ₹2,00,000. So the hold is asserted spent as
     * well: the earmark is consumed, not merely present.
     */
    expect(settled.netPayablePaise).toBe(10_200_000);
    expect(settled.allocatedPaise).toBe(10_200_000);
    expect(settled.refundPaise).toBe(0);
    expect(settled.invoiceNo).toMatch(/^INV/);

    const holds = await db.select().from(otDepositHolds).where(eq(otDepositHolds.encounterId, encounterId));
    expect(holds.map((h) => ({ amountPaise: h.amountPaise, spent: h.releasedAt !== null })))
      .toEqual([{ amountPaise: 6_000_000, spent: true }]);

    const encounter = (await db.select().from(daycareEncounters).where(eq(daycareEncounters.id, encounterId)))[0]!;
    expect({ status: encounter.status, outcome: encounter.outcome })
      .toEqual({ status: "discharged", outcome: "discharged" });
  });
});
