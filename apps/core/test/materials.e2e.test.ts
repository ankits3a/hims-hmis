import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { formularyMedicines, roles, stockBatches } from "../src/kernel/db/schema";
import { loadConfig, requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { seedSodPairs } from "../src/kernel/auth/sod";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { materialsManifest, registerMaterialsApprovalTypes } from "../src/modules/materials";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 14 T8 — **THE HTTP SURFACE A BROWSER ACTUALLY CALLS.**
 *
 * 11h's close review (MAJOR 5) found a whole feature whose assertions were against FUNCTIONS while
 * the route itself — its zod schema, its guard, its status codes — had no test of any kind. The
 * FIRST tests here are the ones that lesson names: an unauthenticated call, and a call with a token
 * but without the permission each family declares.
 *
 * ═══ THE MAPPING IS WALKED, NOT ASSERTED (Plan 09's 500, and Plan 13's second one) ═══
 *
 * A `MembershipError` once reached a counter as a 500 because one controller's `toHttp` had no
 * clause for it; Plan 13 then shipped the same defect again IN THE FIX for the first. So this suite
 * drives a REFUSAL FROM EVERY FAMILY through HTTP and asserts a 4xx with the module's own code —
 * items, vendors, stores, stock, GRN, transfers. A 500 anywhere here is the defect, and the whole
 * point is that it would show up as a failing test rather than as a support call.
 *
 * ═══ THE CHAIN, END TO END ═══
 *
 * capture → QC → post → issue → receive, over HTTP, with the runner's own numbers checked at each
 * step. That is T8's acceptance and it is the only test in the phase that proves the pieces compose
 * through the routes rather than only through the functions.
 */
describe("materials over HTTP (Plan 14 T8)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let app: INestApplication;
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
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardown();
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    // What `seed:materials` does on every deploy (DD10). Without it `requestApproval` throws
    // `unknown_type` — which is how this suite found the missing `ApprovalError` mapping (F13).
    await registerMaterialsApprovalTypes(db, { type: "user", id: "e2e-activator" });
  });

  const server = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];

  /** A user holding exactly `permissions`, with a live session token. */
  async function userWith(permissions: string[]): Promise<{ token: string; id: string }> {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    const suffix = Math.random().toString(36).slice(2, 9);
    const { id } = await createUser(db, {
      username: `u${suffix}`, fullName: "Store", password: "correct horse battery",
    });
    if (permissions.length > 0) {
      const roleKey = `r${suffix}`;
      await createRole(db, roleKey, "Store");
      for (const p of permissions) await grantPermissionToRole(db, registry, roleKey, p);
      await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    }
    await db.insert(roles).values({ key: `noop-${suffix}`, title: "noop" }).onConflictDoNothing();
    const { token } = await createSession(db, cfg, id);
    return { token, id };
  }

  /** Every `materials.*` string the manifest declares — the `materials_head` grant. */
  const ALL_PERMISSIONS = materialsManifest.permissions;

  /**
   * A `front_office` actor: authenticated, and holding NOTHING from this module. The plan names it
   * as the 403 subject, and it is the honest one — a real role that exists in the hospital and has
   * no business in the stores.
   */
  async function frontOfficeUser(): Promise<{ token: string }> {
    return userWith(["opd.visits.read"]);
  }

  // ═══════════════════════════ 401: guarded like every other route ═══════════════════════════

  it("401 WITHOUT A TOKEN on every family", async () => {
    await request(server()).get("/materials/items").expect(401);
    await request(server()).post("/materials/items").send({}).expect(401);
    await request(server()).get("/materials/vendors").expect(401);
    await request(server()).post("/materials/vendors").send({}).expect(401);
    await request(server()).get("/materials/stores").expect(401);
    await request(server()).post("/materials/stores").send({}).expect(401);
    await request(server()).get("/materials/stock/balances").expect(401);
    await request(server()).get("/materials/expiring").expect(401);
    await request(server()).get("/materials/grns").expect(401);
    await request(server()).post("/materials/grns").send({}).expect(401);
    await request(server()).get("/materials/transfers").expect(401);
    await request(server()).post("/materials/transfers").send({}).expect(401);
    await request(server()).post("/materials/recalls").send({}).expect(401);
    await request(server()).get("/materials/consumptions?encounterId=e").expect(401);
  });

  // ═══════════════════════════ 403: authenticated, unauthorised ═══════════════════════════

  it("403 for an authenticated `front_office` actor on EVERY family", async () => {
    const { token } = await frontOfficeUser();
    const auth = (r: request.Test): request.Test => r.set("Authorization", `Bearer ${token}`);
    await auth(request(server()).get("/materials/items")).expect(403);
    await auth(request(server()).post("/materials/items").send({})).expect(403);
    await auth(request(server()).get("/materials/vendors")).expect(403);
    await auth(request(server()).post("/materials/vendors").send({})).expect(403);
    await auth(request(server()).get("/materials/stores")).expect(403);
    await auth(request(server()).post("/materials/stores").send({})).expect(403);
    await auth(request(server()).get("/materials/stock/balances")).expect(403);
    await auth(request(server()).get("/materials/stock/movements")).expect(403);
    await auth(request(server()).get("/materials/expiring")).expect(403);
    await auth(request(server()).get("/materials/grns")).expect(403);
    await auth(request(server()).post("/materials/grns").send({})).expect(403);
    await auth(request(server()).get("/materials/transfers")).expect(403);
    await auth(request(server()).post("/materials/transfers").send({})).expect(403);
    await auth(request(server()).post("/materials/recalls").send({})).expect(403);
    await auth(request(server()).get("/materials/consumptions?encounterId=e")).expect(403);
  });

  /**
   * **DD8's two-stage gate, as authority.** A holder of `grn.capture` may record the delivery and
   * may NOT sign the verdict; the permissions are distinct even though one person may hold both.
   */
  it("403 for a storekeeper on the QC verdict — capture and QC are different permissions", async () => {
    const { token } = await userWith(["materials.grn.capture"]);
    await request(server()).post("/materials/grns/some-id/qc")
      .set("Authorization", `Bearer ${token}`).send({}).expect(403);
    await request(server()).post("/materials/grns/some-id/post")
      .set("Authorization", `Bearer ${token}`).send({}).expect(403);
    // …and the recall freeze is narrower still: not even a storekeeper holds it.
    await request(server()).post("/materials/recalls")
      .set("Authorization", `Bearer ${token}`).send({ batchId: "b", reason: "x" }).expect(403);
  });

  /**
   * ═══ CLOSE REVIEW M6 — THE PHARMACIST'S GRANT, WALKED END TO END ═══
   *
   * DD11 makes **the pharmacist the QC signatory for drugs**, and `seed-roles.ts` grants `pharmacy`
   * exactly `items.read`, `stock.read` and `grn.qc` — deliberately not `grn.capture`.
   *
   * Both GRN READ routes were guarded on `materials.grn.capture`, so that role got a 403 on the
   * list and a 403 on the detail while `POST grns/:id/qc` stayed open to it. **The one authority
   * DD11 rules was unreachable in practice**: a signatory who cannot open the document. The menu
   * entry was gated the same way, so there was not even a link.
   *
   * The 403 leg above walks six families and finds this one healthy, which is the shape worth
   * noticing: a permission suite that checks *"the wrong role is refused"* cannot see *"the RIGHT
   * role is refused too"*. That needs a POSITIVE leg with a real, narrow grant, and this is it.
   */
  it("M6: a `pharmacy`-shaped actor can LIST a GRN, READ it, and sign its verdict", async () => {
    const capture = await userWith([...ALL_PERMISSIONS]);
    const cap = (r: request.Test): request.Test => r.set("Authorization", `Bearer ${capture.token}`);

    const medicineId = newId();
    await db.insert(formularyMedicines).values({
      id: medicineId, brandName: "Crocin 500 m6", form: "tablet", createdBy: "t", updatedBy: "t",
    });
    const itemRes = await cap(request(server()).post("/materials/items").send({
      code: "CROC-M6", name: "Crocin 500mg tablet", class: "drug",
      formularyMedicineId: medicineId, baseUom: "tablet", batchTracked: true, shelfLifeDays: 1095,
      uoms: [{ uom: "strip", toBaseMultiplier: 10 }],
    })).expect(201);
    const itemId = (itemRes.body as { itemId: string }).itemId;

    const vendorRes = await cap(request(server()).post("/materials/vendors").send({
      code: "ACME-M6", legalName: "Acme Pharma Pvt Ltd",
    })).expect(201);
    const vendorId = (vendorRes.body as { vendorId: string }).vendorId;
    for (const doc of [{ type: "gst_certificate", number: "09AAACA1234A1Z5" }, { type: "pan", number: "AAACA1234A" }]) {
      await cap(request(server()).post(`/materials/vendors/${vendorId}/documents`).send(doc)).expect(201);
    }
    await cap(request(server()).post(`/materials/vendors/${vendorId}/activate`).send({})).expect(201);
    const storeRes = await cap(request(server()).post("/materials/stores").send({
      code: "MAIN-M6", name: "Main store",
    })).expect(201);
    const storeResourceId = (storeRes.body as { resourceId: string }).resourceId;

    const grnRes = await cap(request(server()).post("/materials/grns").send({
      vendorId, source: "challan", storeResourceId,
      challanNo: "CH/M6/1", challanDate: "2026-08-27",
      lines: [{
        itemId, uom: "strip", qtyInUom: 10, batchNo: "B-M6-1",
        mfgDate: "2026-01-01", expiryDate: "2028-06-30",
        mrpPaise: 8500, mrpUom: "strip", unitCostPaise: 700,
      }],
    })).expect(201);
    const grnId = (grnRes.body as { grnId: string }).grnId;

    // THE PHARMACIST — the three permissions `seed-roles.ts` actually grants that role, and no more.
    const pharm = await userWith(["materials.items.read", "materials.stock.read", "materials.grn.qc"]);
    const asPharmacist = (r: request.Test): request.Test => r.set("Authorization", `Bearer ${pharm.token}`);

    // Reads the worklist…
    const list = await asPharmacist(request(server()).get("/materials/grns")).expect(200);
    expect((list.body as { grns: { id: string }[] }).grns.map((g) => g.id)).toContain(grnId);
    // …opens the one awaiting a verdict…
    const detail = await asPharmacist(request(server()).get(`/materials/grns/${grnId}`)).expect(200);
    expect((detail.body as { grn: { status: string } }).grn.status).toBe("gate_qc");
    // …and signs it.
    const qc = await asPharmacist(request(server()).post(`/materials/grns/${grnId}/qc`).send({})).expect(201);
    expect((qc.body as { status: string }).status).toBe("accepted");

    /**
     * And the gate has NOT been widened in the other direction: reading a GRN is `stock.read`,
     * CAPTURING one is still `grn.capture`, which the pharmacist does not hold. DD8's two-stage
     * gate survives the fix.
     */
    await asPharmacist(request(server()).post("/materials/grns").send({})).expect(403);
  });

  /**
   * CLOSE REVIEW M1 — `POST /materials/stores` reaches `createResource`, which raises
   * `ResourceError`: not a `MaterialsError`, not an `ApprovalError`, and there is no global
   * exception filter. Every one of them answered **500**. The leg below the header walks six
   * families and not `stores` — the only family with an unmapped error class, which is how a guard
   * that looks thorough leaves the one gap that matters.
   */
  it("M1: a `stores` refusal is a mapped 4xx with its own code — it was a 500", async () => {
    const { token } = await userWith([...ALL_PERMISSIONS]);
    const auth = (r: request.Test): request.Test => r.set("Authorization", `Bearer ${token}`);

    await auth(request(server()).post("/materials/stores").send({ code: "DUP-M1", name: "First" })).expect(201);
    // Case-insensitively the same code — `duplicate_code`, 409.
    await auth(request(server()).post("/materials/stores").send({ code: "dup-m1", name: "Second" }))
      .expect(409).expect((r) => { expect(r.body.code).toBe("duplicate_code"); });
    // A parent that does not exist — `unknown_resource`, 404.
    await auth(request(server()).post("/materials/stores")
      .send({ code: "ORPHAN-M1", name: "Orphan", parentId: newId() }))
      .expect(404).expect((r) => { expect(r.body.code).toBe("unknown_resource"); });
  });

  // ═══════════════ THE REFUSAL MAPPING, WALKED FROM EVERY FAMILY (Plan 13's M-class) ═══════════════

  it("every family's refusal reaches HTTP as a 4xx with the module's own code — never a 500", async () => {
    const { token } = await userWith([...ALL_PERMISSIONS]);
    const auth = (r: request.Test): request.Test => r.set("Authorization", `Bearer ${token}`);

    // items — 404 for a thing that is not there…
    await auth(request(server()).get(`/materials/items/${newId()}`))
      .expect(404).expect((r) => { expect(r.body.code).toBe("unknown_item"); });
    // …and 409 for DD3's rule, named as the RULE and not as a constraint.
    await auth(request(server()).post("/materials/items").send({
      code: "NOMED", name: "a drug with no medicine", class: "drug",
      baseUom: "tablet", batchTracked: true,
    })).expect(409).expect((r) => { expect(r.body.code).toBe("drug_needs_medicine"); });

    // vendors
    await auth(request(server()).get(`/materials/vendors/${newId()}`))
      .expect(404).expect((r) => { expect(r.body.code).toBe("unknown_vendor"); });
    const vendorRes = await auth(request(server()).post("/materials/vendors").send({
      code: "ACME", legalName: "Acme Pharma Pvt Ltd",
    })).expect(201);
    const vendorId = (vendorRes.body as { vendorId: string }).vendorId;
    // Activating without the paperwork.
    await auth(request(server()).post(`/materials/vendors/${vendorId}/activate`).send({}))
      .expect(409).expect((r) => { expect(r.body.code).toBe("documents_incomplete"); });

    // stores — a resource that is not a store.
    await auth(request(server()).get(`/materials/transfers/${newId()}`))
      .expect(404).expect((r) => { expect(r.body.code).toBe("unknown_document"); });

    // stock — an unknown batch on a recall.
    await auth(request(server()).post("/materials/recalls").send({ batchId: newId(), reason: "test" }))
      .expect(404).expect((r) => { expect(r.body.code).toBe("unknown_batch"); });

    // GRN
    await auth(request(server()).get(`/materials/grns/${newId()}`))
      .expect(404).expect((r) => { expect(r.body.code).toBe("unknown_document"); });

    // bank changes — the one unmasked reader.
    await auth(request(server()).get(`/materials/bank-changes/${newId()}`))
      .expect(404).expect((r) => { expect(r.body.code).toBe("unknown_document"); });

    // …and a malformed body is a 400 from zod, not a 500 and not a module code.
    await auth(request(server()).post("/materials/items").send({ code: "" })).expect(400);
  });

  // ═══════════════════════ THE CHAIN: capture → QC → post → issue → receive ═══════════════════════

  it("the whole chain runs over HTTP, and the numbers are right at every step", async () => {
    const { token } = await userWith([...ALL_PERMISSIONS]);
    const auth = (r: request.Test): request.Test => r.set("Authorization", `Bearer ${token}`);

    // ── the masters ──
    const medicineId = newId();
    await db.insert(formularyMedicines).values({
      id: medicineId, brandName: "Crocin 500 e2e", form: "tablet", createdBy: "t", updatedBy: "t",
    });
    const itemRes = await auth(request(server()).post("/materials/items").send({
      code: "CROC500", name: "Crocin 500mg tablet", class: "drug",
      formularyMedicineId: medicineId, baseUom: "tablet", batchTracked: true, shelfLifeDays: 1095,
      uoms: [{ uom: "strip", toBaseMultiplier: 10 }, { uom: "box", toBaseMultiplier: 100 }],
    })).expect(201);
    const itemId = (itemRes.body as { itemId: string }).itemId;

    const vendorRes = await auth(request(server()).post("/materials/vendors").send({
      code: "ACME", legalName: "Acme Pharma Pvt Ltd",
    })).expect(201);
    const vendorId = (vendorRes.body as { vendorId: string }).vendorId;
    await auth(request(server()).post(`/materials/vendors/${vendorId}/documents`).send({
      type: "gst_certificate", number: "09AAACA1234A1Z5",
    })).expect(201);
    await auth(request(server()).post(`/materials/vendors/${vendorId}/documents`).send({
      type: "pan", number: "AAACA1234A",
    })).expect(201);
    await auth(request(server()).post(`/materials/vendors/${vendorId}/activate`).send({})).expect(201);

    const mainRes = await auth(request(server()).post("/materials/stores").send({
      code: "MAIN", name: "Main store",
    })).expect(201);
    const main = (mainRes.body as { resourceId: string }).resourceId;
    const wardRes = await auth(request(server()).post("/materials/stores").send({
      code: "WARD-A", name: "Ward A",
    })).expect(201);
    const ward = (wardRes.body as { resourceId: string }).resourceId;

    // ── CAPTURE: 3 boxes = 300 tablets. `qty_in_uom` and `qty_base` DIFFER (§2.102). ──
    const grnRes = await auth(request(server()).post("/materials/grns").send({
      vendorId, source: "challan", storeResourceId: main,
      challanNo: "CH/E2E/1", challanDate: "2026-08-27",
      lines: [{
        itemId, uom: "box", qtyInUom: 3, batchNo: "B-E2E-1",
        mfgDate: "2026-01-01", expiryDate: "2028-06-30",
        mrpPaise: 8500, mrpUom: "strip", unitCostPaise: 700,
      }],
    })).expect(201);
    const grnId = (grnRes.body as { grnId: string; grnNo: string }).grnId;
    expect((grnRes.body as { grnNo: string }).grnNo).toMatch(/^GRN\d{10}$/);

    // Nothing has moved yet.
    let balances = await auth(request(server()).get("/materials/stock/balances")).expect(200);
    expect((balances.body as { balances: unknown[] }).balances).toEqual([]);

    // ── QC ──
    const qcRes = await auth(request(server()).post(`/materials/grns/${grnId}/qc`).send({})).expect(201);
    expect((qcRes.body as { status: string }).status).toBe("accepted");
    // …and STILL nothing has moved.
    balances = await auth(request(server()).get("/materials/stock/balances")).expect(200);
    expect((balances.body as { balances: unknown[] }).balances).toEqual([]);

    // ── POST ──
    const postRes = await auth(request(server()).post(`/materials/grns/${grnId}/post`).send({})).expect(201);
    expect((postRes.body as { ledgerEntryIds: string[] }).ledgerEntryIds).toHaveLength(1);
    balances = await auth(request(server()).get(`/materials/stock/balances?resourceId=${main}`)).expect(200);
    expect((balances.body as { balances: { qtyOnHand: number }[] }).balances[0]?.qtyOnHand).toBe(300);

    // ── ISSUE: 100 tablets, FEFO ──
    const issueRes = await auth(request(server()).post("/materials/transfers").send({
      fromResourceId: main, toResourceId: ward,
      lines: [{ itemId, qtyBase: 100 }],
    })).expect(201);
    const transferId = (issueRes.body as { transferId: string }).transferId;
    const lineId = (issueRes.body as { lines: { transferLineId: string }[] }).lines[0]?.transferLineId ?? "";

    balances = await auth(request(server()).get(`/materials/stock/balances?resourceId=${main}`)).expect(200);
    expect((balances.body as { balances: { qtyOnHand: number }[] }).balances[0]?.qtyOnHand).toBe(200);
    // The transit store is a REAL place and holds the 100 (DD9).
    const stores = await auth(request(server()).get("/materials/stores?includeTransit=true")).expect(200);
    const transit = (stores.body as { stores: { id: string; code: string }[] }).stores
      .find((s) => s.code === "IN-TRANSIT");
    expect(transit).toBeDefined();
    balances = await auth(request(server()).get(`/materials/stock/balances?resourceId=${transit?.id ?? ""}`)).expect(200);
    expect((balances.body as { balances: { qtyOnHand: number }[] }).balances[0]?.qtyOnHand).toBe(100);
    // …and `listStores` HIDES it by default — DD9's one predicate.
    const visible = await auth(request(server()).get("/materials/stores")).expect(200);
    expect((visible.body as { stores: { code: string }[] }).stores.map((s) => s.code))
      .toEqual(["MAIN", "WARD-A"]);

    // ── RECEIVE SHORT: 70 of 100. THIRTY stay in transit (A18). ──
    const recvRes = await auth(request(server()).post(`/materials/transfers/${transferId}/receive`).send({
      lines: [{ lineId, qtyReceived: 70 }],
    })).expect(201);
    expect((recvRes.body as { status: string }).status).toBe("discrepancy");

    balances = await auth(request(server()).get(`/materials/stock/balances?resourceId=${ward}`)).expect(200);
    expect((balances.body as { balances: { qtyOnHand: number }[] }).balances[0]?.qtyOnHand).toBe(70);
    balances = await auth(request(server()).get(`/materials/stock/balances?resourceId=${transit?.id ?? ""}`)).expect(200);
    expect((balances.body as { balances: { qtyOnHand: number }[] }).balances[0]?.qtyOnHand).toBe(30);
    // The three stores still add up to what was received.
    balances = await auth(request(server()).get(`/materials/stock/balances?itemId=${itemId}`)).expect(200);
    expect((balances.body as { balances: { qtyOnHand: number }[] }).balances
      .reduce((a, b) => a + b.qtyOnHand, 0)).toBe(300);

    // The discrepancy worklist renders (DD16's second tab).
    const disc = await auth(request(server()).get("/materials/transfers/discrepancies")).expect(200);
    expect((disc.body as { transfers: unknown[] }).transfers).toHaveLength(1);

    // ── THE RECALL: one action, and the ward's stock freezes too ──
    const batchId = (await db.select().from(stockBatches).where(eq(stockBatches.itemId, itemId)))[0]?.id ?? "";
    const recallRes = await auth(request(server()).post("/materials/recalls").send({
      batchId, reason: "NPPA recall 2026/44",
    })).expect(201);
    expect((recallRes.body as { locations: unknown[] }).locations).toHaveLength(3);
    // …and nothing may leave any of them.
    await auth(request(server()).post("/materials/transfers").send({
      fromResourceId: main, toResourceId: ward, lines: [{ itemId, qtyBase: 1 }],
    })).expect(409).expect((r) => { expect(r.body.code).toBe("insufficient_stock"); });

    // ── the movement history reads back, ordered by `seq` ──
    const moves = await auth(request(server()).get(`/materials/stock/movements?batchId=${batchId}`)).expect(200);
    const reasons = (moves.body as { movements: { reason: string }[] }).movements.map((m) => m.reason);
    // grn, issue×2 (out of main, into transit), receive×2 (out of transit, into ward).
    expect(reasons).toEqual(["grn", "issue", "issue", "receive", "receive"]);
  });

  // ═══════════════════════════ the masked read, over HTTP ═══════════════════════════

  it("a vendor's bank never leaves the API unmasked through a read route (A7)", async () => {
    const { token } = await userWith([...ALL_PERMISSIONS, "approvals.requests.read"]);
    const auth = (r: request.Test): request.Test => r.set("Authorization", `Bearer ${token}`);
    const vendorRes = await auth(request(server()).post("/materials/vendors").send({
      code: "ACME", legalName: "Acme Pharma Pvt Ltd",
    })).expect(201);
    const vendorId = (vendorRes.body as { vendorId: string }).vendorId;

    await auth(request(server()).post(`/materials/vendors/${vendorId}/bank-change`).send({
      bank: { accountNo: "123456789012", ifsc: "HDFC0001234", bankName: "HDFC Bank" },
      note: "new account on letterhead",
    })).expect(201);

    // …and applying it before the OWNER has granted is a 409 with the module's code, not a 500.
    const changes0 = await auth(request(server()).get(`/materials/vendors/${vendorId}/bank-changes`)).expect(200);
    const changeId = (changes0.body as { changes: { id: string }[] }).changes[0]?.id ?? "";
    await auth(request(server()).post(`/materials/bank-changes/${changeId}/apply`).send({}))
      .expect(409).expect((r) => { expect(r.body.code).toBe("approval_not_granted"); });

    // The vendor read, the list, and the change LIST are all masked…
    const one = await auth(request(server()).get(`/materials/vendors/${vendorId}`)).expect(200);
    expect(JSON.stringify(one.body)).not.toContain("12345678");
    const many = await auth(request(server()).get("/materials/vendors")).expect(200);
    expect(JSON.stringify(many.body)).not.toContain("12345678");
    const changes = await auth(request(server()).get(`/materials/vendors/${vendorId}/bank-changes`)).expect(200);
    expect(JSON.stringify(changes.body)).toContain("9012");
    expect(JSON.stringify(changes.body)).not.toContain("12345678");
  });

  it("the expiring worklist is a READ route, and it is empty on a hospital with no stock", async () => {
    const { token } = await userWith([...ALL_PERMISSIONS]);
    const res = await request(server()).get("/materials/expiring")
      .set("Authorization", `Bearer ${token}`).expect(200);
    expect((res.body as { batches: unknown[] }).batches).toEqual([]);
  });

  /** DD13's read, mounted. Plan 15 calls exactly this to compose a discharge bill. */
  it("the consumptions read is mounted and answers for an encounter with nothing", async () => {
    const { token } = await userWith([...ALL_PERMISSIONS]);
    const res = await request(server()).get("/materials/consumptions?encounterId=enc-none")
      .set("Authorization", `Bearer ${token}`).expect(200);
    expect((res.body as { consumptions: unknown[] }).consumptions).toEqual([]);
    // …and it REQUIRES the parameter rather than silently answering for everything.
    await request(server()).get("/materials/consumptions")
      .set("Authorization", `Bearer ${token}`).expect(400);
  });
});
