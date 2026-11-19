import { sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { seedSodPairs } from "../../../kernel/auth/sod";
import { withTx } from "../../../kernel/db/client";
import { orgDepartments } from "../../../kernel/db/schema";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../../kernel/modules/manifests";
import { KERNEL_RESOURCE_KINDS } from "../../../kernel/resources/kinds";
import { createResource } from "../../../kernel/resources/registry";
import {
  MaterialsError, activateVendor, addVendorDocument, applyBankChange, blacklistVendor, captureGrn, createPurchaseOrder, createStore,
  decidePurchaseOrder, getPurchaseOrder, registerItem, registerMaterialsApprovalTypes, registerVendor, requestBankChange, setVendorRates,
  submitPurchaseOrder, updatePurchaseOrder,
} from "../../materials";
import { storesManifest } from "../manifest";
import {
  StoresError, admitLateQuote, approveAward, approveAwardAndPo, approvePurchaseRequest, approveSupplierCategory, buyNow, bulkApprove,
  comparativeStatement, createRfq, createShelf, inviteSuppliers, delegateApprovals, enterQuote, getAward, getBuyGroup, getTicket, groupRequests,
  listCategories, makePoFromAward, makePoFromGroup, markTechnical, moveGroupLine, objectAward, postStoresGrn, proposeAward,
  purchaseDeliveries, raisePurchaseRequest, registerStoresItem, seedStoresMasters, sendRfq, sendStoresPo, setCommitteeSeat, signStoresQc,
  storesAuditPack, submitStoresPo,
} from "../index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1115, spec docs/specs/1115-stores-buying-desk.md (owner APPROVED 2026-11-19, decision 0100):
 * Stores S5b, the buying desk by hand. One test per done-means id the build notes give S5b's core: D8 (Buy now and the
 * buyer's own grouping), D9 (band A's one quote and the 2 % check), D10 (the RFQ and its send), D11 (sealed quotes and a
 * late quote), D12 (the comparative to the paisa), D13 (award reasons, KYC, negotiation with L1 only), D14 (the
 * committee), D15 (PO from award; pharmacy unchanged), D16 (one sheet, two stamps; bulk), D17 (the delivery ticket) and
 * D18 (audit). D19 and D20 are the web's (apps/web/src/screens/acceptance/stores-buying-1115.test.tsx).
 *
 * Every intent is handed the clock it runs on. A bank change's cooling-off runs from the approval's own (real) instant,
 * so the fixture that makes a supplier "KYC complete" sets the vendor's first-payment instant before the test's clock.
 */
describe("Stores S5b: grouping, RFQ, quotes, comparative, award, committee, PO from award, delivery, audit (spec #1115)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  type Who = { id: string; actor: Actor };
  let head: Who;
  let deputy: Who;
  let buyer: Who;
  let keeper: Who;
  let bme: Who;
  let pharmacist: Who;
  let acct: Who;
  let ms: Who;
  let owner: Who;
  let inA: Who;
  let hodA: Who;
  let deptA: { id: string; code: string };
  let genMain: string;
  let shelfA: string;
  let chair: string;
  let table: string;
  let monitor: string;
  let printer: string;
  let gloves: string;
  let crocin: string;
  let pharmStore: string;
  let v1: string;
  let v2: string;
  let v3: string;
  let vCan: string;
  let cats: Map<string, string>;
  let registry: ModuleRegistry;

  /** 12:00 IST on 2026-11-10 — inside GEN-MAIN's 09:00–17:00. */
  const NOW = new Date("2026-11-10T06:30:00.000Z");
  const MIN = 60_000;
  const DAY = 24 * 60;
  const at = (m: number): Date => new Date(NOW.getTime() + m * MIN);
  const ANSWERS = { why: "Old one failed", replacesTag: null, usePerDay: "8 patients" };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS.filter((x) => x.key !== "stores")) registry.install(m);
    registry.install(storesManifest);
    await syncPermissions(db, registry);
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    const grants: Record<string, string[]> = {
      materials_head: [
        "stores.masters.manage", "stores.shelf.read", "stores.buying.manage", "stores.grn.qc", "stores.award.sign", "materials.items.read",
        "materials.stock.read", "materials.vendors.manage", "materials.po.raise", "materials.grn.capture", "approvals.requests.decide",
        "approvals.requests.read",
      ],
      purchase_officer: ["stores.buying.manage", "materials.po.raise", "materials.stock.read"],
      storekeeper: ["materials.stock.read", "materials.stock.issue", "materials.stock.receive", "materials.grn.capture"],
      biomedical_engineer: ["stores.grn.qc", "stores.award.sign"],
      pharmacy: ["materials.po.raise", "materials.stock.read", "materials.grn.qc"],
      accounts_officer: ["stores.budget.manage", "stores.award.sign"],
      medical_superintendent: ["stores.award.sign", "stores.indents.approve"],
      owner: ["stores.budget.manage", "stores.audit.read", "approvals.requests.decide", "approvals.requests.read", "materials.stock.read"],
      department_store_incharge: ["stores.shelf.read", "stores.shelf.work", "stores.purchase.request"],
      department_head: ["stores.shelf.read", "stores.indents.approve", "stores.purchase.request", "stores.award.sign"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    head = await mkUser(db, "stores.head", ["materials_head"]);
    deputy = await mkUser(db, "stores.deputy", []);
    buyer = await mkUser(db, "buyer.a", ["purchase_officer"]);
    keeper = await mkUser(db, "keeper.a", ["storekeeper"]);
    bme = await mkUser(db, "bme.a", ["biomedical_engineer"]);
    pharmacist = await mkUser(db, "pharm.a", ["pharmacy"]);
    acct = await mkUser(db, "accounts.a", ["accounts_officer"]);
    ms = await mkUser(db, "ms.a", ["medical_superintendent"]);
    owner = await mkUser(db, "the.owner", ["owner"]);
    inA = await mkUser(db, "incharge.a", []);
    hodA = await mkUser(db, "hod.a", []);

    deptA = await anOrgDept("ICU", "ICU");
    await assignRole(db, { userId: inA.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptA.id });
    await assignRole(db, { userId: hodA.id, roleKey: "department_head", scopeType: "department", scopeId: deptA.id });

    const floor1 = await aFloor("F1", "First floor");
    ({ centralStoreId: genMain } = await seedStoresMasters(db, head.actor));
    cats = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
    const item = async (code: string, name: string, categoryCode: string, trackMode: "tagged" | "durable" | "shelf", klass = "asset", gst = 1800): Promise<string> =>
      (await registerStoresItem(db, head.actor, { code, name, class: klass, baseUom: "piece", categoryId: cats.get(categoryCode)!, trackMode, gstRateBps: gst })).itemId;
    chair = await item("FU-CHR-0001", "Visitor chair", "FUR", "durable");
    table = await item("FU-TBL-0001", "Office table", "FUR", "durable");
    monitor = await item("ME-MON-0001", "Patient monitor", "MEQ", "tagged");
    printer = await item("IT-PRN-0001", "Label printer", "ITP", "durable");
    gloves = await item("HK-GLV-0001", "Household gloves", "HSK", "shelf", "consumable");
    ({ shelfId: shelfA } = await createShelf(db, head.actor, { code: "ICU-F1", name: "ICU shelf", floorId: floor1, departmentId: deptA.id, suppliedBy: genMain }));
    ({ resourceId: pharmStore } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" })));
    ({ itemId: crocin } = await withTx(db, (tx) => registerItem(tx, head.actor, {
      code: "CROC", name: "Crocin 500", class: "consumable", baseUom: "tablet", batchTracked: true, gstRateBps: 1200,
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true }],
    })));
    v1 = await kycComplete(await aVendor("V-ONE", "Supplier One", "AAAAA1111A"));
    v2 = await kycComplete(await aVendor("V-TWO", "Supplier Two", "BBBBB2222B"));
    v3 = await kycComplete(await aVendor("V-THREE", "Supplier Three", "CCCCC3333C"));
    vCan = await aVendor("V-CAN", "Can Quote Only", "DDDDD4444D");
  });

  /* ─────────────────────────────── fixtures ─────────────────────────────── */

  async function anOrgDept(code: string, name: string): Promise<{ id: string; code: string }> {
    const id = newId();
    await db.insert(orgDepartments).values({ id, code, name, kind: "clinical", opdDepartmentId: null, createdBy: "t", updatedBy: "t" });
    return { id, code };
  }
  async function aFloor(code: string, name: string): Promise<string> {
    return (await withTx(db, (tx) => createResource(tx, head.actor, KERNEL_RESOURCE_KINDS, { kind: "floor", code, name }))).resourceId;
  }
  /** A supplier that "can quote": PAN, GSTIN, its papers, active. No bank. */
  async function aVendor(code: string, legalName: string, pan: string | null): Promise<string> {
    const { vendorId: v } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code, legalName, pan, gstin: pan === null ? "10ZZZZZ9999Z1Z9" : `10${pan}1Z5` }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, v, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, v, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, v, at(-200 * DAY)));
    return v;
  }
  /** "KYC complete": the owner-approved bank (its cooling-off set before the test's clock), every category approved. */
  async function kycComplete(v: string): Promise<string> {
    const { changeId, approvalId } = await withTx(db, (tx) => requestBankChange(tx, head.actor, v, { accountNo: "123456789012", ifsc: "SBIN0000001" }));
    await approveRequest(db, owner.actor, { approvalId, note: "Verified by call-back" });
    await withTx(db, (tx) => applyBankChange(tx, head.actor, changeId, new Date()));
    await db.execute(sql`update vendors set first_payment_allowed_at = ${at(-30 * DAY)} where id = ${v}`);
    for (const c of ["FUR", "ITP", "MEQ", "HSK"]) await approveSupplierCategory(db, head.actor, v, cats.get(c)!, at(-30 * DAY));
    return v;
  }
  async function deptPr(lines: Parameters<typeof raisePurchaseRequest>[2]["lines"], when: number, priority: "routine" | "urgent" | "emergency" = "routine") {
    const pr = await raisePurchaseRequest(db, inA.actor, { source: "department", departmentId: deptA.id, shelfId: shelfA, priority, lines }, at(when));
    return approvePurchaseRequest(db, hodA.actor, pr.id, at(when + 1));
  }
  async function centralPr(lines: Parameters<typeof raisePurchaseRequest>[2]["lines"], when: number) {
    const pr = await raisePurchaseRequest(db, buyer.actor, { source: "central", priority: "routine", lines }, at(when));
    return approvePurchaseRequest(db, head.actor, pr.id, at(when + 1));
  }
  const allLines = (pr: { id: string; lines: { lineIdx: number }[] }) => pr.lines.map((l) => ({ prId: pr.id, lineIdx: l.lineIdx }));
  type QuoteLine = { itemId: string; ratePaise: number; discountBps?: number; gstRateBps?: number };
  const quote = (rfqId: string, vendorId: string, lines: QuoteLine[], when: number, extra: { freightPaise?: number; otherPaise?: number; deliveryDays?: number } = {}) =>
    enterQuote(db, buyer.actor, { rfqId, vendorId, supplierRef: `Q-${vendorId.slice(-4)}`, lines, ...extra }, at(when));
  /** A routine central request for `qty` of `itemId`, grouped, an RFQ to v1, v2, v3 sent, and their quotes in. */
  async function quotedRfq(itemId: string, qty: number, estimate: number, rates: [number, number, number], when: number) {
    const pr = await centralPr([{ itemId, qtyBase: qty, estimatePaise: estimate }], when);
    const g = await groupRequests(db, buyer.actor, { lines: allLines(pr) }, at(when + 2));
    const rfq = await createRfq(db, buyer.actor, { groupId: g.id, replyBy: at(when + 2 * DAY), deliveryDate: "2026-11-30", vendorIds: [v1, v2, v3] }, at(when + 3));
    await sendRfq(db, buyer.actor, rfq.id, { channel: "email" }, at(when + 4));
    for (const [i, v] of [v1, v2, v3].entries()) await quote(rfq.id, v, [{ itemId, ratePaise: rates[i]! }], when + 10 + i);
    return { pr, group: g, rfq };
  }
  const count = async (q: ReturnType<typeof sql>): Promise<number> => Number(((await db.execute(q)).rows[0] as { n: number }).n);
  const actsNamed = (act: string): Promise<number> =>
    count(sql`select count(*)::int as n from events where name = 'stores.act_recorded' and payload->>'act' = ${act}`);
  const noticesTo = (userId: string, title: string): Promise<number> =>
    count(sql`select count(*)::int as n from alerts where user_id = ${userId} and title = ${title}`);
  async function refusal(p: Promise<unknown>): Promise<string> {
    try { await p; } catch (e) {
      if (e instanceof StoresError || e instanceof MaterialsError) return e.code;
      throw e;
    }
    throw new Error("expected a refusal");
  }
  async function refusalDetail(p: Promise<unknown>): Promise<{ code: string; detail: Record<string, unknown> | undefined }> {
    try { await p; } catch (e) {
      if (e instanceof StoresError) return { code: e.code, detail: e.detail };
      throw e;
    }
    throw new Error("expected a refusal");
  }
  /** What the comparative must say, computed here from the typed lines: net = rate less the discount, half up per unit. */
  const net = (rate: number, bps = 0): number => Math.floor((rate * (10_000 - bps) + 5_000) / 10_000);
  const gstOf = (taxable: number, bps: number): number => Math.floor((taxable * bps + 5_000) / 10_000);

  /* ─────────────────────────────── D8–D18 ─────────────────────────────── */

  it("spec #1115 D8: an approved urgent or emergency request is on Buy now in the next read with no job run; the buyer's group takes the highest band of its lines and moving a line recomputes it", async () => {
    const urgent = await deptPr([{ itemId: chair, qtyBase: 1, estimatePaise: 300_000 }], 0, "urgent");
    const routine = await deptPr([{ itemId: table, qtyBase: 1, estimatePaise: 200_000 }], 5);
    const now1 = (await buyNow(db, buyer.actor, at(3))).map((r) => r.prId);
    expect(now1).toContain(urgent.id);
    expect(now1).not.toContain(routine.id);

    // Band A (₹10,000 of chairs) and band B (₹30,000 of printers, another category: no split sum) in one group: B.
    const a = await centralPr([{ itemId: chair, qtyBase: 2, estimatePaise: 500_000 }], 10);
    const b = await centralPr([{ itemId: printer, qtyBase: 1, estimatePaise: 3_000_000 }], 20);
    expect([a.band, b.band]).toEqual(["A", "B"]);
    const g = await groupRequests(db, buyer.actor, { lines: [...allLines(a), ...allLines(b)] }, at(30));
    expect(g.band).toBe("B");
    expect(g.estimatePaise).toBe(1_000_000 + 3_000_000);
    expect(g.lines.map((l) => l.prId).sort()).toEqual([a.id, b.id].sort());

    // Moving the printer out leaves a band A group.
    await moveGroupLine(db, buyer.actor, { prId: b.id, lineIdx: 0, toGroupId: null }, at(31));
    const after = await getBuyGroup(db, g.id, at(32));
    expect(after.band).toBe("A");
    expect(after.lines.map((l) => l.prId)).toEqual([a.id]);
  });

  it("spec #1115 D9: band A: Make PO with no quote is refused (quote_needed); a quote more than 2 % above the last price needs a reason (reason_required); a live rate-contract line needs no quote", async () => {
    // The last price of a chair: ₹4,000 a piece, received and posted.
    const capture = (itemId: string, unitCostPaise: number) => withTx(db, (tx) => captureGrn(tx, keeper.actor, {
      vendorId: v3, source: "challan", storeResourceId: genMain, challanNo: `CH-${newId().slice(-6)}`, challanDate: "2026-11-01",
      invoiceNo: `INV-${newId().slice(-6)}`, invoiceDate: "2026-11-01", lines: [{ itemId, uom: "piece", qtyInUom: 1, unitCostPaise }], now: at(-5 * DAY),
    }));
    const last = await capture(chair, 400_000);
    await signStoresQc(db, bme.actor, last.grnId, at(-5 * DAY + 1));
    await postStoresGrn(db, bme.actor, last.grnId, at(-5 * DAY + 2));

    const pr = await centralPr([{ itemId: chair, qtyBase: 3, estimatePaise: 400_000 }], 0);
    const g = await groupRequests(db, buyer.actor, { lines: allLines(pr) }, at(5));
    expect(g.band).toBe("A");
    const posBefore = await count(sql`select count(*)::int as n from purchase_orders`);
    expect(await refusal(makePoFromGroup(db, buyer.actor, g.id, {}, at(6)))).toBe("quote_needed");

    // One quote, 5 % above the last price: refused without a reason, made with one.
    await enterQuote(db, buyer.actor, { groupId: g.id, vendorId: v1, supplierRef: "Q-11", lines: [{ itemId: chair, ratePaise: 420_000 }] }, at(7));
    expect(await refusal(makePoFromGroup(db, buyer.actor, g.id, {}, at(8)))).toBe("reason_required");
    expect(await count(sql`select count(*)::int as n from purchase_orders`)).toBe(posBefore);
    const made = await makePoFromGroup(db, buyer.actor, g.id, { reason: "Older model discontinued" }, at(9));
    expect(made.pos).toHaveLength(1);
    expect(made.pos[0]).toMatchObject({ vendorId: v1, status: "draft", subtotalPaise: 3 * 420_000 });
    expect(made.pos[0]!.note).toContain("Older model discontinued");

    // A line on a live rate contract orders against that contract with no quote.
    await setVendorRates(db, head.actor, v2, [{ itemId: printer, ratePaise: 2_000_000, uom: "piece" }], { now: at(-60) });
    const p = await centralPr([{ itemId: printer, qtyBase: 1 }], 20);
    const gp = await groupRequests(db, buyer.actor, { lines: allLines(p) }, at(21));
    const viaContract = await makePoFromGroup(db, buyer.actor, gp.id, {}, at(22));
    expect(viaContract.pos.map((po) => [po.vendorId, po.subtotalPaise])).toEqual([[v2, 2_000_000]]);
  });

  it("spec #1115 D10: a band B RFQ with two invitees is refused (three_quotes_needed); a blacklisted invitee and one without PAN are refused; a 'can quote' invitee is accepted; one PDF per invitee is queued and the send is recorded with sender and channel", async () => {
    const pr = await centralPr([{ itemId: table, qtyBase: 2, estimatePaise: 2_000_000 }], 0);
    const g = await groupRequests(db, buyer.actor, { lines: allLines(pr) }, at(2));
    expect(g.band).toBe("B");
    const rfq = await createRfq(db, buyer.actor, { groupId: g.id, replyBy: at(2 * DAY), deliveryDate: "2026-11-30", vendorIds: [v1, v2] }, at(3));
    expect(await refusal(sendRfq(db, buyer.actor, rfq.id, { channel: "email" }, at(4)))).toBe("three_quotes_needed");

    const black = await aVendor("V-BLACK", "Blacklisted", "EEEEE5555E");
    await withTx(db, (tx) => blacklistVendor(tx, head.actor, black, "quality_failure", at(-DAY)));
    const noPan = await aVendor("V-NOPAN", "No PAN", null);
    expect(await refusal(inviteSuppliers(db, buyer.actor, rfq.id, [black], at(5)))).toBe("cannot_quote");
    expect(await refusal(inviteSuppliers(db, buyer.actor, rfq.id, [noPan], at(5)))).toBe("cannot_quote");

    // A supplier that can quote (no bank yet) is invited; three invitees: sent, one PDF each, sender and channel recorded.
    const ok = await inviteSuppliers(db, buyer.actor, rfq.id, [vCan], at(6));
    expect(ok.status).toBe("drafted");
    expect(ok.invitees.map((i) => i.vendorId).sort()).toEqual([v1, v2, vCan].sort());
    expect(await count(sql`select count(*)::int as n from print_jobs where document = 'stores_rfq'`)).toBe(0); // nothing goes out without the tap
    const sent = await sendRfq(db, buyer.actor, ok.id, { channel: "email" }, at(7));
    expect(sent.status).toBe("sent");
    expect(sent.sent).toMatchObject({ by: { id: buyer.id }, channel: "email" });
    expect(sent.rfqNo).toMatch(/^RFQ261110\d{4}$/);
    expect(await count(sql`select count(*)::int as n from print_jobs where document = 'stores_rfq' and params->>'rfqId' = ${ok.id}`)).toBe(3);
    const [act] = (await db.execute(sql`select actor_id, payload from events where name = 'stores.act_recorded' and payload->>'act' = 'send_rfq'`)).rows as { actor_id: string; payload: { after: { channel: string; vendorIds: string[] } } }[];
    expect(act?.actor_id).toBe(buyer.id);
    expect(act?.payload.after.channel).toBe("email");
    expect(act?.payload.after.vendorIds.sort()).toEqual([v1, v2, vCan].sort());
  });

  it("spec #1115 D11: before the reply-by date with 2 of 3 quotes in, the comparative says only '2 of 3 received'; after it, ranks; a late quote is Late and out of the ranks until the materials head admits it", async () => {
    const pr = await centralPr([{ itemId: table, qtyBase: 2, estimatePaise: 2_000_000 }], 0);
    const g = await groupRequests(db, buyer.actor, { lines: allLines(pr) }, at(2));
    const rfq = await createRfq(db, buyer.actor, { groupId: g.id, replyBy: at(2 * DAY), deliveryDate: "2026-11-30", vendorIds: [v1, v2, v3] }, at(3));
    await sendRfq(db, buyer.actor, rfq.id, { channel: "print" }, at(4));
    await quote(rfq.id, v1, [{ itemId: table, ratePaise: 1_900_000 }], DAY);
    await quote(rfq.id, v2, [{ itemId: table, ratePaise: 1_800_000 }], DAY + 5);

    const sealed = await comparativeStatement(db, buyer.actor, rfq.id, at(DAY + 10));
    expect(sealed).toMatchObject({ sealed: true, received: 2, invited: 3 });
    expect(sealed.suppliers).toEqual([]);
    expect(sealed.lines).toEqual([]);

    const open = await comparativeStatement(db, buyer.actor, rfq.id, at(2 * DAY + 1));
    expect(open.sealed).toBe(false);
    expect(open.suppliers.map((s) => [s.vendorId, s.wholeRank])).toEqual(expect.arrayContaining([[v2, 1], [v1, 2]]));

    // The third arrives late: Late, unranked, until the materials head admits it with a reason.
    const late = await quote(rfq.id, v3, [{ itemId: table, ratePaise: 1_700_000 }], 2 * DAY + 30);
    expect(late.late).toBe(true);
    let c = await comparativeStatement(db, buyer.actor, rfq.id, at(2 * DAY + 31));
    expect(c.suppliers.find((s) => s.vendorId === v3)).toMatchObject({ late: true, admitted: false, wholeRank: null });
    expect(c.suppliers.find((s) => s.vendorId === v2)?.wholeRank).toBe(1);
    expect(await refusal(admitLateQuote(db, buyer.actor, late.id, "Courier delay", at(2 * DAY + 32)))).toBe("not_permitted");
    expect(await refusal(admitLateQuote(db, head.actor, late.id, " ", at(2 * DAY + 32)))).toBe("reason_required");
    await admitLateQuote(db, head.actor, late.id, "Courier receipt shows it was sent on time", at(2 * DAY + 33));
    c = await comparativeStatement(db, buyer.actor, rfq.id, at(2 * DAY + 34));
    expect(c.suppliers.find((s) => s.vendorId === v3)).toMatchObject({ late: true, admitted: true, wholeRank: 1 });
  });

  it("spec #1115 D12: each supplier's comparative total equals Σ (rate × qty − discount) + GST + freight + other to the paisa, and L1 has the lowest landed total among the technically compliant", async () => {
    const pr = await centralPr([{ itemId: table, qtyBase: 3, estimatePaise: 1_500_000 }, { itemId: chair, qtyBase: 10, estimatePaise: 300_000 }], 0);
    const g = await groupRequests(db, buyer.actor, { lines: allLines(pr) }, at(2));
    expect(g.band).toBe("B");
    const rfq = await createRfq(db, buyer.actor, { groupId: g.id, replyBy: at(2 * DAY), deliveryDate: "2026-11-30", vendorIds: [v1, v2, v3] }, at(3));
    await sendRfq(db, buyer.actor, rfq.id, { channel: "email" }, at(4));
    const typed: Record<string, { lines: (QuoteLine & { qty: number })[]; freight: number; other: number }> = {
      [v1]: { lines: [{ itemId: table, qty: 3, ratePaise: 1_500_000, discountBps: 500, gstRateBps: 1800 }, { itemId: chair, qty: 10, ratePaise: 300_000, gstRateBps: 1800 }], freight: 50_000, other: 10_000 },
      [v2]: { lines: [{ itemId: table, qty: 3, ratePaise: 1_450_000, gstRateBps: 1800 }, { itemId: chair, qty: 10, ratePaise: 310_000, discountBps: 1000, gstRateBps: 1800 }], freight: 0, other: 0 },
      [v3]: { lines: [{ itemId: table, qty: 3, ratePaise: 1_600_000, gstRateBps: 1200 }, { itemId: chair, qty: 10, ratePaise: 280_001, gstRateBps: 1200 }], freight: 100_000, other: 0 },
    };
    let t = 10;
    for (const [v, q] of Object.entries(typed)) {
      await quote(rfq.id, v, q.lines.map(({ qty: _q, ...l }) => l), t++, { freightPaise: q.freight, otherPaise: q.other });
    }
    const c = await comparativeStatement(db, buyer.actor, rfq.id, at(3 * DAY));
    expect(c.sealed).toBe(false);
    const expected = new Map<string, number>();
    for (const [v, q] of Object.entries(typed)) {
      let taxable = 0; let gst = 0; let gross = 0;
      for (const l of q.lines) {
        const tx = l.qty * net(l.ratePaise, l.discountBps ?? 0);
        taxable += tx; gross += l.qty * l.ratePaise; gst += gstOf(tx, l.gstRateBps ?? 0);
      }
      const s = c.suppliers.find((x) => x.vendorId === v)!;
      expect(s.totals.discountPaise).toBe(gross - taxable);
      expect(s.totals.gstPaise).toBe(gst);
      expect(s.totals.beforeGstPaise).toBe(taxable + q.freight + q.other);
      expect(s.totals.landedPaise).toBe(gross - (gross - taxable) + gst + q.freight + q.other);
      expected.set(v, s.totals.landedPaise);
      // Per line, the landed cells add up to the supplier's total (freight and other spread by value).
      expect(c.lines.reduce((a, l) => a + (l.cells.find((x) => x.vendorId === v)?.landedPaise ?? 0), 0)).toBe(s.totals.landedPaise);
    }
    const l1 = [...expected.entries()].sort((a, b) => a[1] - b[1])[0]![0];
    expect(c.suppliers.find((s) => s.wholeRank === 1)?.vendorId).toBe(l1);

    // Equipment: the HOD and biomedical mark technical compliance; a No (with its reason) takes the cheapest out of the ranks.
    const mon = await deptPr([{ itemId: monitor, qtyBase: 1, estimatePaise: 12_000_000, equipment: ANSWERS }], 100);
    const gm = await groupRequests(db, buyer.actor, { lines: allLines(mon) }, at(102));
    expect(gm.band).toBe("C");
    const rm = await createRfq(db, buyer.actor, { groupId: gm.id, replyBy: at(2 * DAY), deliveryDate: "2026-11-30", vendorIds: [v1, v2, v3] }, at(103));
    await sendRfq(db, buyer.actor, rm.id, { channel: "email" }, at(104));
    await quote(rm.id, v1, [{ itemId: monitor, ratePaise: 11_000_000 }], 110);
    await quote(rm.id, v2, [{ itemId: monitor, ratePaise: 11_500_000 }], 111);
    await quote(rm.id, v3, [{ itemId: monitor, ratePaise: 12_000_000 }], 112);
    // Before the technical marks nothing is ranked.
    expect((await comparativeStatement(db, buyer.actor, rm.id, at(113))).suppliers.every((s) => s.wholeRank === null)).toBe(true);
    expect(await refusal(markTechnical(db, bme.actor, { rfqId: rm.id, vendorId: v1, compliant: false }, at(114)))).toBe("reason_required");
    for (const v of [v1, v2, v3]) await markTechnical(db, hodA.actor, { rfqId: rm.id, vendorId: v, compliant: true }, at(115));
    await markTechnical(db, bme.actor, { rfqId: rm.id, vendorId: v1, compliant: false, reason: "No ETCO2 module" }, at(116));
    for (const v of [v2, v3]) await markTechnical(db, bme.actor, { rfqId: rm.id, vendorId: v, compliant: true }, at(117));
    const cm = await comparativeStatement(db, buyer.actor, rm.id, at(118));
    expect(cm.suppliers.find((s) => s.vendorId === v1)).toMatchObject({ technical: "no", wholeRank: null });
    expect(cm.suppliers.find((s) => s.wholeRank === 1)?.vendorId).toBe(v2);
  });

  it("spec #1115 D13: an award to a supplier that is not L1 needs a reason; one that is not KYC complete is refused (kyc_incomplete); after unsealing L2 cannot revise, and L1's lower revision is stored as Negotiated beside the first", async () => {
    const pr = await centralPr([{ itemId: table, qtyBase: 2, estimatePaise: 1_500_000 }], 0);
    const g = await groupRequests(db, buyer.actor, { lines: allLines(pr) }, at(2));
    const rfq = await createRfq(db, buyer.actor, { groupId: g.id, replyBy: at(2 * DAY), deliveryDate: "2026-11-30", vendorIds: [vCan, v1, v2] }, at(3));
    await sendRfq(db, buyer.actor, rfq.id, { channel: "hand" }, at(4));
    const first = await quote(rfq.id, vCan, [{ itemId: table, ratePaise: 1_400_000 }], 10);
    await quote(rfq.id, v1, [{ itemId: table, ratePaise: 1_450_000 }], 11);
    await quote(rfq.id, v2, [{ itemId: table, ratePaise: 1_500_000 }], 12);
    // Every invitee has quoted: unsealed before the date. L1 vCan, L2 v1, L3 v2.
    const c = await comparativeStatement(db, buyer.actor, rfq.id, at(13));
    expect(c.suppliers.map((s) => [s.vendorId, s.wholeRank]).sort()).toEqual([[vCan, 1], [v1, 2], [v2, 3]].sort());

    // L1 cannot quote its way into an award without its KYC.
    const k = await refusalDetail(proposeAward(db, buyer.actor, { rfqId: rfq.id, vendorId: vCan }, at(14)));
    expect(k.code).toBe("kyc_incomplete");
    expect(k.detail?.missing).toEqual(expect.arrayContaining(["bank", "category"]));
    // Not L1 without a reason: refused; nothing written.
    expect(await refusal(proposeAward(db, buyer.actor, { rfqId: rfq.id, vendorId: v2 }, at(15)))).toBe("reason_required");
    expect(await count(sql`select count(*)::int as n from stores_awards`)).toBe(0);

    // Negotiation: L2 cannot revise; L1 revises downward, stored as a new "Negotiated" version, the first kept.
    expect(await refusal(quote(rfq.id, v1, [{ itemId: table, ratePaise: 1_300_000 }], 16))).toBe("only_l1_negotiates");
    expect(await refusal(quote(rfq.id, vCan, [{ itemId: table, ratePaise: 1_420_000 }], 17))).toBe("negotiation_upward");
    const nego = await quote(rfq.id, vCan, [{ itemId: table, ratePaise: 1_380_000 }], 18);
    expect(nego).toMatchObject({ kind: "negotiated", version: 2, vendorId: vCan });
    const versions = (await db.execute(sql`select version, kind from stores_quotes where rfq_id = ${rfq.id} and vendor_id = ${vCan} order by version`)).rows;
    expect(versions).toEqual([{ version: 1, kind: "quote" }, { version: 2, kind: "negotiated" }]);
    expect(first.version).toBe(1);

    const ok = await proposeAward(db, buyer.actor, { rfqId: rfq.id, vendorId: v2, reason: "L1 cannot supply before month end" }, at(19));
    expect(ok).toMatchObject({ status: "proposed", band: "B", reason: "L1 cannot supply before month end" });
    expect(ok.lines.map((l) => [l.vendorId, l.rank])).toEqual([[v2, 3]]);
  });

  it("spec #1115 D14: a band C award is not approved with a seat unsigned or without the owner; the proposer cannot sign; a proposal with an empty seat is refused (committee_seat_empty); an objection sends it back and writes one row", async () => {
    const mon = await deptPr([{ itemId: monitor, qtyBase: 1, estimatePaise: 12_000_000, equipment: ANSWERS }], 0);
    const g = await groupRequests(db, buyer.actor, { lines: allLines(mon) }, at(2));
    const rfq = await createRfq(db, buyer.actor, { groupId: g.id, replyBy: at(2 * DAY), deliveryDate: "2026-11-30", vendorIds: [v1, v2, v3] }, at(3));
    await sendRfq(db, buyer.actor, rfq.id, { channel: "email" }, at(4));
    for (const [i, v] of [v1, v2, v3].entries()) await quote(rfq.id, v, [{ itemId: monitor, ratePaise: 11_000_000 + i * 500_000 }], 10 + i);
    for (const v of [v1, v2, v3]) {
      await markTechnical(db, hodA.actor, { rfqId: rfq.id, vendorId: v, compliant: true }, at(20));
      await markTechnical(db, bme.actor, { rfqId: rfq.id, vendorId: v, compliant: true }, at(21));
    }
    // Three seats set by the materials head; biomedical still empty.
    for (const [seat, who] of [["materials_head", head], ["accounts_head", acct], ["medical_superintendent", ms]] as const) {
      await setCommitteeSeat(db, head.actor, { seat, userId: who.id, from: at(-DAY) }, at(22));
    }
    const empty = await refusalDetail(proposeAward(db, head.actor, { rfqId: rfq.id, vendorId: v1 }, at(23)));
    expect(empty).toMatchObject({ code: "committee_seat_empty", detail: { seat: "biomedical" } });
    expect(await count(sql`select count(*)::int as n from stores_awards`)).toBe(0);
    await setCommitteeSeat(db, head.actor, { seat: "biomedical", userId: bme.id, from: at(-DAY) }, at(24));

    // The proposer's own signature is refused; an objection sends it back with one row.
    const first = await proposeAward(db, head.actor, { rfqId: rfq.id, vendorId: v1 }, at(25));
    expect(first.band).toBe("C");
    expect(await noticesTo(acct.id, "Award to sign")).toBe(1);
    expect(await refusal(approveAward(db, head.actor, first.id, at(26)))).toBe("own_proposal");
    const before = await count(sql`select count(*)::int as n from stores_award_signatures where award_id = ${first.id}`);
    expect(await refusal(objectAward(db, acct.actor, first.id, " ", at(27)))).toBe("reason_required");
    await objectAward(db, acct.actor, first.id, "Warranty only one year", at(27));
    expect(await count(sql`select count(*)::int as n from stores_award_signatures where award_id = ${first.id}`)).toBe(before + 1);
    expect((await getAward(db, first.id, at(28))).status).toBe("sent_back");
    expect(await refusal(approveAward(db, ms.actor, first.id, at(28)))).toBe("award_not_open");

    // A fresh proposal is a new row. The head proposed it, so the head's seat signs through a dated delegate.
    const second = await proposeAward(db, head.actor, { rfqId: rfq.id, vendorId: v1 }, at(30));
    expect(second.id).not.toBe(first.id);
    await delegateApprovals(db, head.actor, { toUserId: deputy.id, scope: "committee_seat", seat: "materials_head", from: at(30), to: at(5 * DAY) }, at(30));
    const d = await approveAward(db, deputy.actor, second.id, at(31));
    expect(d.seats.find((s) => s.seat === "materials_head")).toMatchObject({ signedBy: { id: deputy.id }, onBehalfOf: { id: head.id } });
    for (const who of [acct, ms, hodA]) await approveAward(db, who.actor, second.id, at(32));
    // One seat (biomedical) unsigned: not approved, and the owner cannot sign yet.
    expect((await getAward(db, second.id, at(33))).status).toBe("proposed");
    expect(await refusal(approveAward(db, owner.actor, second.id, at(33)))).toBe("awaiting_seats");
    await approveAward(db, bme.actor, second.id, at(34));
    // Every seat signed, the owner not yet: still not approved.
    expect((await getAward(db, second.id, at(35))).status).toBe("proposed");
    const done = await approveAward(db, owner.actor, second.id, at(36));
    expect(done.status).toBe("approved");
  });

  it("spec #1115 D15: a PO from an award copies its supplier and rates; a changed rate or supplier is refused at submit (po_differs_from_award); a pharmacy PO with no award is created, submitted and approved as before", async () => {
    const { rfq } = await quotedRfq(table, 2, 1_500_000, [1_450_000, 1_500_000, 1_550_000], 0);
    const award = await proposeAward(db, buyer.actor, { rfqId: rfq.id, vendorId: v1 }, at(20));
    await approveAward(db, head.actor, award.id, at(21));
    const { pos } = await makePoFromAward(db, buyer.actor, award.id, {}, at(22));
    expect(pos).toHaveLength(1);
    const po = pos[0]!;
    expect(po).toMatchObject({ vendorId: v1, storeResourceId: genMain, status: "draft" });
    expect(po.lines.map((l) => [l.itemId, l.qtyPacks, l.ratePaise])).toEqual([[table, 2, 1_450_000]]);
    expect(po.terms).toContain("Pay after GRN");

    // A changed rate is refused at submit; so is a changed supplier.
    await updatePurchaseOrder(db, buyer.actor, po.id, { lines: [{ itemId: table, qtyPacks: 2, ratePaise: 1_460_000 }] }, at(23));
    expect(await refusal(submitPurchaseOrder(db, buyer.actor, po.id, at(24)))).toBe("po_differs_from_award");
    await updatePurchaseOrder(db, buyer.actor, po.id, { vendorId: v2, lines: [{ itemId: table, qtyPacks: 2, ratePaise: 1_450_000 }] }, at(25));
    expect(await refusal(submitPurchaseOrder(db, buyer.actor, po.id, at(26)))).toBe("po_differs_from_award");
    await updatePurchaseOrder(db, buyer.actor, po.id, { vendorId: v1, lines: [{ itemId: table, qtyPacks: 3, ratePaise: 1_450_000 }] }, at(27));
    expect(await refusal(submitPurchaseOrder(db, buyer.actor, po.id, at(28)))).toBe("po_differs_from_award");
    await updatePurchaseOrder(db, buyer.actor, po.id, { lines: [{ itemId: table, qtyPacks: 2, ratePaise: 1_450_000 }] }, at(29));
    expect((await submitStoresPo(db, buyer.actor, po.id, at(30))).status).toBe("pending_approval");

    // A pharmacy PO, no award link: the same statuses, tier and refusals as before S5.
    const ph = await createPurchaseOrder(db, pharmacist.actor, { vendorId: v3, storeResourceId: pharmStore, lines: [{ itemId: crocin, qtyPacks: 10, ratePaise: 25_000 }] }, { now: at(40) });
    expect([ph.status, ph.totalPaise]).toEqual(["draft", 280_000]);
    const sub = await submitPurchaseOrder(db, pharmacist.actor, ph.id, at(41));
    expect([sub.status, sub.approvalTier]).toEqual(["pending_approval", "head"]);
    expect(await refusal(submitPurchaseOrder(db, pharmacist.actor, ph.id, at(42)))).toBe("po_wrong_status");
    await expect(decidePurchaseOrder(db, pharmacist.actor, ph.id, "approve", "ok", at(43))).rejects.toThrow();
    const ok = await decidePurchaseOrder(db, head.actor, ph.id, "approve", "Rates checked", at(44));
    expect(ok.status).toBe("approved");
  });

  it("spec #1115 D16: approveAwardAndPo by the materials head on a band B award with a ₹40,000 PO writes the award stamp and the PO approval; with a ₹60,000 PO it leaves the PO for the owner; bulk approves 5 POs and refuses an award", async () => {
    const small = await quotedRfq(table, 2, 1_700_000, [1_700_000, 1_750_000, 1_800_000], 0);
    const a1 = await proposeAward(db, buyer.actor, { rfqId: small.rfq.id, vendorId: v1 }, at(20));
    const [po1] = (await makePoFromAward(db, buyer.actor, a1.id, {}, at(21))).pos;
    await submitStoresPo(db, buyer.actor, po1!.id, at(22));
    expect(po1!.totalPaise).toBe(3_400_000 + 612_000); // ₹40,120
    const awardActs = await actsNamed("approve_award");
    const poEvents = await count(sql`select count(*)::int as n from events where name = 'purchase_order.approved'`);
    const one = await approveAwardAndPo(db, head.actor, { awardId: a1.id, poId: po1!.id }, at(23));
    expect(one.award.status).toBe("approved");
    expect(one.po.status).toBe("approved");
    expect(await actsNamed("approve_award")).toBe(awardActs + 1);
    expect(await count(sql`select count(*)::int as n from events where name = 'purchase_order.approved'`)).toBe(poEvents + 1);

    const big = await quotedRfq(table, 3, 1_700_000, [1_700_000, 1_750_000, 1_800_000], 100);
    const a2 = await proposeAward(db, buyer.actor, { rfqId: big.rfq.id, vendorId: v1 }, at(120));
    const [po2] = (await makePoFromAward(db, buyer.actor, a2.id, {}, at(121))).pos;
    await submitStoresPo(db, buyer.actor, po2!.id, at(122));
    const two = await approveAwardAndPo(db, head.actor, { awardId: a2.id, poId: po2!.id }, at(123));
    expect(two.award.status).toBe("approved");
    expect([two.po.status, two.po.approvalTier]).toEqual(["pending_approval", "owner"]);
    expect(await noticesTo(owner.id, "PO to approve")).toBe(1);

    // Bulk: five POs in one tap, five approvals; never an award.
    const five: string[] = [];
    for (let i = 0; i < 5; i++) {
      const po = await createPurchaseOrder(db, buyer.actor, { vendorId: v2, storeResourceId: genMain, lines: [{ itemId: gloves, qtyPacks: 10 + i, ratePaise: 4_000 }] }, { now: at(200 + i) });
      await submitPurchaseOrder(db, buyer.actor, po.id, at(206 + i));
      five.push(po.id);
    }
    const granted = await count(sql`select count(*)::int as n from approvals where status = 'granted'`);
    const bulk = await bulkApprove(db, head.actor, { kind: "po", ids: five }, at(220));
    expect(bulk.map((p) => p.status)).toEqual(Array(5).fill("approved"));
    expect(await count(sql`select count(*)::int as n from approvals where status = 'granted'`)).toBe(granted + 5);
    expect(await refusal(bulkApprove(db, head.actor, { kind: "award", ids: [a2.id] }, at(221)))).toBe("bulk_not_allowed");
  });

  it("spec #1115 D17: when a department request's goods pass QC, one ticket for the requester's shelf carries its lines with no approval pending and names the request; one 'In store' notice; a second GRN raises a ticket only for what was not ticketed", async () => {
    const pr = await deptPr([{ itemId: chair, qtyBase: 2, estimatePaise: 400_000 }], 0);
    const g = await groupRequests(db, buyer.actor, { lines: allLines(pr) }, at(5));
    await enterQuote(db, buyer.actor, { groupId: g.id, vendorId: v1, supplierRef: "Q-1", lines: [{ itemId: chair, ratePaise: 400_000 }] }, at(6));
    const [po] = (await makePoFromGroup(db, buyer.actor, g.id, {}, at(7))).pos;
    await submitStoresPo(db, buyer.actor, po!.id, at(8));
    await decidePurchaseOrder(db, head.actor, po!.id, "approve", "ok", at(9));
    await sendStoresPo(db, buyer.actor, po!.id, at(10));
    expect(await noticesTo(inA.id, "Ordered")).toBe(1);

    const receive = async (qty: number, t: number): Promise<void> => {
      const { grnId } = await withTx(db, (tx) => captureGrn(tx, keeper.actor, {
        vendorId: v1, source: "challan", storeResourceId: genMain, purchaseOrderId: po!.id, challanNo: `CH-${newId().slice(-6)}`, challanDate: "2026-11-10",
        invoiceNo: `INV-${newId().slice(-6)}`, invoiceDate: "2026-11-10", lines: [{ itemId: chair, uom: "piece", qtyInUom: qty, unitCostPaise: 400_000 }], now: at(t),
      }));
      await signStoresQc(db, bme.actor, grnId, at(t + 1));
      await postStoresGrn(db, bme.actor, grnId, at(t + 2));
    };
    await receive(1, 20);
    let deliveries = await purchaseDeliveries(db, pr.id);
    expect(deliveries.map((d) => [d.lineIdx, d.qtyBase])).toEqual([[0, 1]]);
    const t1 = await getTicket(db, deliveries[0]!.indentId, at(25));
    expect(t1?.shelf.id).toBe(shelfA);
    expect(t1?.lines.map((l) => [l.itemId, l.qtyBase])).toEqual([[chair, 1]]);
    expect(t1?.approval.state).toBe("not_needed");
    expect(await noticesTo(inA.id, "In store")).toBe(1);
    const [act] = (await db.execute(sql`select payload from events where name = 'stores.act_recorded' and payload->>'act' = 'raise_ticket' and payload->>'refId' = ${deliveries[0]!.indentId}`)).rows as { payload: { after: { prId: string } } }[];
    expect(act?.payload.after.prId).toBe(pr.id);

    await receive(1, 40);
    deliveries = await purchaseDeliveries(db, pr.id);
    expect(deliveries.map((d) => d.qtyBase)).toEqual([1, 1]);
    expect(await count(sql`select count(*)::int as n from stores_ticket_details where shelf_id = ${shelfA}`)).toBe(2);
  });

  it("spec #1115 D18: every S5 act appends one event; quotes, quote lines and award signatures refuse UPDATE and DELETE; the audit pack of a request lists request → approval → RFQ → quotes → award → PO → GRN → QC → delivery ticket in seq order with actor and roles", async () => {
    const pr = await deptPr([{ itemId: gloves, qtyBase: 1000, estimatePaise: 4_000 }], 0);
    expect(pr.band).toBe("B");
    const g = await groupRequests(db, buyer.actor, { lines: allLines(pr) }, at(5));
    const rfq = await createRfq(db, buyer.actor, { groupId: g.id, replyBy: at(2 * DAY), deliveryDate: "2026-11-30", vendorIds: [v1, v2, v3] }, at(6));
    await sendRfq(db, buyer.actor, rfq.id, { channel: "email" }, at(7));
    for (const [i, v] of [v1, v2, v3].entries()) await quote(rfq.id, v, [{ itemId: gloves, ratePaise: 3_800 + i * 100 }], 10 + i);
    const award = await proposeAward(db, buyer.actor, { rfqId: rfq.id, vendorId: v1 }, at(20));
    const [po] = (await makePoFromAward(db, buyer.actor, award.id, {}, at(21))).pos;
    await submitStoresPo(db, buyer.actor, po!.id, at(22));
    await approveAwardAndPo(db, head.actor, { awardId: award.id, poId: po!.id }, at(23));
    await sendStoresPo(db, buyer.actor, po!.id, at(24));
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, keeper.actor, {
      vendorId: v1, source: "challan", storeResourceId: genMain, purchaseOrderId: po!.id, challanNo: "CH-9001", challanDate: "2026-11-10",
      invoiceNo: "INV-9001", invoiceDate: "2026-11-10", lines: [{ itemId: gloves, uom: "piece", qtyInUom: 1000, unitCostPaise: 3_800 }], now: at(30),
    }));
    await signStoresQc(db, bme.actor, grnId, at(31));
    await postStoresGrn(db, bme.actor, grnId, at(32));
    expect((await getPurchaseOrder(db, head.actor, po!.id)).status).toBe("received");

    // One event per act.
    for (const [act, n] of [
      ["group_requests", 1], ["create_rfq", 1], ["send_rfq", 1], ["enter_quote", 3], ["propose_award", 1], ["approve_award", 1],
      ["po_from_award", 1], ["submit_po", 1], ["send_po", 1], ["grn_qc", 1], ["grn_post", 1],
    ] as const) expect([act, await actsNamed(act)]).toEqual([act, n]);

    // Append-only in the database.
    for (const table_ of ["stores_quotes", "stores_quote_lines", "stores_award_signatures"]) {
      await expect(db.execute(sql.raw(`update ${table_} set id = id`))).rejects.toThrow();
      await expect(db.execute(sql.raw(`delete from ${table_}`))).rejects.toThrow();
    }

    const pack = await storesAuditPack(db, owner.actor, { prId: pr.id, from: at(-60), to: at(60) }, at(61));
    const what = pack.rows.map((r) => r.what);
    const chain = ["raise_purchase_request", "approve_purchase_request", "create_rfq", "send_rfq", "enter_quote", "propose_award", "po_from_award",
      "approve_award", "purchase_order.approved", "send_po", "grn_qc", "grn_post", "raise_ticket"];
    let from = -1;
    for (const step of chain) {
      const i = what.indexOf(step, from + 1);
      expect([step, i > from]).toEqual([step, true]);
      from = i;
    }
    const seqs = pack.rows.map((r) => r.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(pack.rows.find((r) => r.what === "approve_award")?.actor).toMatchObject({ id: head.id, roles: ["materials_head"] });
    expect(pack.rows.find((r) => r.what === "send_rfq")?.actor).toMatchObject({ id: buyer.id, roles: ["purchase_officer"] });
  });
});
