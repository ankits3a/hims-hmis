import { sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { approveRequest } from "../../kernel/approvals/decisions";
import { assignRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { setHalt } from "../../kernel/copilot/halt";
import { withTx } from "../../kernel/db/client";
import { orgDepartments } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { KERNEL_RESOURCE_KINDS } from "../../kernel/resources/kinds";
import { createResource } from "../../kernel/resources/registry";
import {
  MaterialsError, activateVendor, addVendorDocument, applyBankChange, captureGrn, createPurchaseOrder, decidePurchaseOrder, registerMaterialsApprovalTypes,
  registerVendor, requestBankChange, sendPurchaseOrder, setStockLevel, setVendorRates, submitPurchaseOrder,
} from "../materials";
import { storesManifest } from "./manifest";
import {
  StoresError, agentProposals, approvePurchaseRequest, approveSupplierCategory, confirmGroupingProposal, confirmPoDraft, confirmQuoteLine, confirmRfqDraft,
  createShelf, draftPo, draftRfq, groupRequests, listCategories, raisePurchaseRequest, readQuotePdf, registerStoresItem, runBuyerNight, seedStoresMasters,
  sendRfq, sendStoresPo, signStoresQc, postStoresGrn, submitStoresPo, supplierScorecard, advanceBuyException, decidePoAdvance, departmentBudget, enterQuote,
  makePoFromGroup, overBudgetList, payTermsOf, refuseBuyException, requestBuyException, requestPoAdvance, sendOwnerOverBudgetList, setDepartmentBudget,
  storesAwardSignDesk, storesPurchaseApproveDesk, getBuyException, createRfq, proposeAward, getBuyGroup,
} from "./index";
import { nightOf, runBuyerNightIfDue } from "./buyer-agent";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";
import type { InferenceClient } from "../../kernel/inference/types";

/**
 * #1115 (S5c) — beyond the done-means: what decision 0101 Q4 and Q7, decision 15 and the spec's "Notices" ask of the
 * buying desk that S5a and S5b left open. Every intent is handed its clock; a PO's approval instant comes from the
 * approvals kernel's own clock, so the budget month is read back from the row, never pinned.
 */
describe("Stores S5c: the gaps S5a/S5b left — the night clock and shortfall, the reader without a model, single source and emergency, advances, PO value in the budget, the owner's list, the Now cards (#1115)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  type Who = { id: string; actor: Actor };
  let head: Who;
  let buyer: Who;
  let keeper: Who;
  let bme: Who;
  let owner: Who;
  let inA: Who;
  let hodA: Who;
  let ms: Who;
  let deptA: { id: string; code: string };
  let genMain: string;
  let shelfA: string;
  let chair: string;
  let table: string;
  let monitor: string;
  let printer: string;
  let gloves: string;
  let v1: string;
  let v2: string;
  let v3: string;
  let vCan: string;
  let cats: Map<string, string>;
  let registry: ModuleRegistry;

  /** 12:00 IST on 2026-11-10. */
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
      owner: ["stores.budget.manage", "stores.audit.read", "approvals.requests.decide", "approvals.requests.read", "materials.stock.read"],
      department_store_incharge: ["stores.shelf.read", "stores.shelf.work", "stores.purchase.request"],
      department_head: ["stores.shelf.read", "stores.indents.approve", "stores.purchase.request", "stores.award.sign"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    head = await mkUser(db, "stores.head", ["materials_head"]);
    buyer = await mkUser(db, "buyer.a", ["purchase_officer"]);
    keeper = await mkUser(db, "keeper.a", ["storekeeper"]);
    bme = await mkUser(db, "bme.a", ["biomedical_engineer"]);
    owner = await mkUser(db, "the.owner", ["owner"]);
    inA = await mkUser(db, "incharge.a", []);
    hodA = await mkUser(db, "hod.a", []);
    await ensureRole(db, "medical_superintendent");
    ms = await mkUser(db, "ms.a", ["medical_superintendent"]);

    deptA = await anOrgDept("ICU", "ICU");
    await assignRole(db, { userId: inA.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptA.id });
    await assignRole(db, { userId: hodA.id, roleKey: "department_head", scopeType: "department", scopeId: deptA.id });

    const floor1 = (await withTx(db, (tx) => createResource(tx, head.actor, KERNEL_RESOURCE_KINDS, { kind: "floor", code: "F1", name: "First floor" }))).resourceId;
    ({ centralStoreId: genMain } = await seedStoresMasters(db, head.actor));
    cats = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
    const item = async (code: string, name: string, categoryCode: string, trackMode: "tagged" | "durable" | "shelf", klass = "asset", gst = 1800): Promise<string> =>
      (await registerStoresItem(db, head.actor, { code, name, class: klass, baseUom: "piece", categoryId: cats.get(categoryCode)!, trackMode, gstRateBps: gst })).itemId;
    chair = await item("FU-CHR-0001", "Visitor chair", "FUR", "durable");
    table = await item("FU-TBL-0001", "Office table", "FUR", "durable");
    monitor = await item("ME-MON-0001", "Patient monitor", "MEQ", "tagged", "asset", 1200);
    printer = await item("IT-PRN-0001", "Label printer", "ITP", "durable");
    gloves = await item("HK-GLV-0001", "Household gloves", "HSK", "shelf", "consumable");
    ({ shelfId: shelfA } = await createShelf(db, head.actor, { code: "ICU-F1", name: "ICU shelf", floorId: floor1, departmentId: deptA.id, suppliedBy: genMain }));
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
  async function aVendor(code: string, legalName: string, pan: string): Promise<string> {
    const { vendorId: v } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code, legalName, pan, gstin: `10${pan}1Z5` }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, v, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, v, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, v, at(-200 * DAY)));
    return v;
  }
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
  const count = async (q: ReturnType<typeof sql>): Promise<number> => Number(((await db.execute(q)).rows[0] as { n: number }).n);
  async function refusal(p: Promise<unknown>): Promise<string> {
    try { await p; } catch (e) {
      if (e instanceof StoresError || e instanceof MaterialsError) return e.code;
      throw e;
    }
    throw new Error("expected a refusal");
  }
  const buyingRows = async () => ({
    rfqs: await count(sql`select count(*)::int as n from stores_rfqs`),
    pos: await count(sql`select count(*)::int as n from purchase_orders`),
    awards: await count(sql`select count(*)::int as n from stores_awards`),
    groups: await count(sql`select count(*)::int as n from stores_buy_groups`),
    quotes: await count(sql`select count(*)::int as n from stores_quotes`),
  });
  const actsOf = (userId: string, tool: string) =>
    count(sql`select count(*)::int as n from copilot_acts where actor_id = ${userId} and tool = ${tool}`);

  /** A one-page PDF whose page carries `lines` as text (uncompressed content stream), the shape a supplier's software writes. */
  function aPdf(lines: readonly string[]): Buffer {
    const esc = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`);
    const content = `BT /F1 11 Tf 50 780 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let body = "%PDF-1.4\n";
    const offs: number[] = [];
    objs.forEach((o, i) => { offs.push(body.length); body += `${String(i + 1)} 0 obj\n${o}\nendobj\n`; });
    const xref = body.length;
    body += `xref\n0 ${String(objs.length + 1)}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    body += `trailer\n<< /Size ${String(objs.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
    return Buffer.from(body, "latin1");
  }
  const memoryStore = (): DocumentStore & { keys: () => string[] } => {
    const m = new Map<string, Buffer>();
    return {
      put: async (k, b) => { m.set(k, b); }, get: async (k) => m.get(k)!, remove: async (k) => { m.delete(k); }, keys: () => [...m.keys()],
    };
  };

  const NIGHT = new Date("2026-11-10T16:30:00.000Z"); // 22:00 IST
  const store = memoryStore;
  const night = async (when: Date) => runBuyerNight(db, when);

  it("the night clock: 22:00 IST to 07:00 runs the night once (the minute sweep's due check), nothing by day", async () => {
    expect(nightOf(NOW)).toBeNull();
    expect(nightOf(NIGHT)).toBe("2026-11-10");
    expect(nightOf(new Date("2026-11-11T00:30:00.000Z"))).toBe("2026-11-10"); // 06:00 IST the next morning
    expect(await runBuyerNightIfDue(db, NOW)).toBeNull();
    const first = await runBuyerNightIfDue(db, new Date(NIGHT.getTime() + 5 * MIN));
    expect(first).not.toBeNull();
    expect(await runBuyerNightIfDue(db, new Date(NIGHT.getTime() + 6 * MIN))).toBeNull();
    expect(await runBuyerNightIfDue(db, new Date("2026-11-11T00:30:00.000Z"))).toBeNull();
    expect(await runBuyerNightIfDue(db, new Date(NIGHT.getTime() + DAY * MIN + MIN))).not.toBeNull();
    expect(await count(sql`select count(*)::int as n from events where name = 'stores.act_recorded' and payload->>'act' = 'agent_night'`)).toBe(2);
  });

  it("the central shortfall: an item at or under reorder, less what is on order or already asked, becomes one central request for the materials head; an item with no price is left out", async () => {
    await setStockLevel(db, head.actor, { itemId: gloves, storeResourceId: genMain, minBase: 50, reorderBase: 100, maxBase: 500 }, at(-10));
    await setStockLevel(db, head.actor, { itemId: table, storeResourceId: genMain, minBase: 1, reorderBase: 2, maxBase: 4 }, at(-10));
    await setVendorRates(db, head.actor, v1, [{ itemId: gloves, ratePaise: 4_000, uom: "piece" }], { now: at(-60) });
    const run = await night(NIGHT);
    expect(run.shortfall.noPrice).toEqual([table]);
    const [pr] = (await db.execute(sql`select id, source, raised_by from stores_purchase_requests where id = ${run.shortfall.prId}`)).rows as { id: string; source: string; raised_by: string }[];
    expect(pr).toMatchObject({ source: "central", raised_by: "stores-buyer-agent" });
    expect((await db.execute(sql`select item_id, qty_base from stores_purchase_request_lines where pr_id = ${pr!.id}`)).rows).toEqual([{ item_id: gloves, qty_base: 500 }]);
    // The materials head is told; the request waits for them (Now card + waiting line).
    expect(await count(sql`select count(*)::int as n from alerts where user_id = ${head.id} and title = 'Purchase to approve'`)).toBe(1);
    const waiting = await storesPurchaseApproveDesk.waiting!({ db, actor: head.actor, now: at(DAY) } as never);
    expect(waiting).toEqual([expect.objectContaining({ kind: "stores.purchaseToApprove", count: 1 })]);
    // The next night asks nothing twice.
    const again = await night(new Date(NIGHT.getTime() + DAY * MIN));
    expect(again.shortfall.prId).toBeNull();
  });

  it("the PDF reader works with the model off (the rules), drops a number not in its line, keeps an unreadable PDF as an empty draft, and stops when the agent is halted", async () => {
    const pr = await centralPr([{ itemId: printer, qtyBase: 2, estimatePaise: 1_500_000 }], 0);
    const g = await groupRequests(db, buyer.actor, { lines: allLines(pr) }, at(5));
    const rfq = await createRfq(db, buyer.actor, { groupId: g.id, replyBy: at(2 * DAY), vendorIds: [v1, v2, v3] }, at(6));
    await sendRfq(db, buyer.actor, rfq.id, { channel: "print" }, at(7));
    const pdf = aPdf(["Quote", "Label printer (IT-PRN-0001) Rate: 14,250.50 Discount 2.5% IGST 18%"]);
    const byRules = await readQuotePdf(db, { store: store(), inference: null }, buyer.actor, { rfqId: rfq.id, vendorId: v2, pdf }, at(10));
    expect(byRules.reader).toBe("rules");
    expect(byRules.lines[0]).toMatchObject({ ratePaise: 1_425_050, discountBps: 250, gstRateBps: 1800, source: { page: 1 } });
    expect(await count(sql`select count(*)::int as n from copilot_asks where intent = 'stores.quote_read' and route = 'none' and masked_question is null`)).toBe(1);

    // A model that names a rate the line does not carry: the rate is left for the person to type.
    const liar = { complete: async () => ({ text: JSON.stringify({ lines: [{ item: 1, page: 1, text: "Label printer (IT-PRN-0001) Rate: 14,250.50 Discount 2.5% IGST 18%", rate: "9999", gst: "18" }] }) }) };
    const read = await readQuotePdf(db, { store: store(), inference: liar }, buyer.actor, { rfqId: rfq.id, vendorId: v3, pdf }, at(11));
    expect(read.reader).toBe("model");
    expect(read.lines[0]).toMatchObject({ ratePaise: null, gstRateBps: 1800 });
    expect(await count(sql`select count(*)::int as n from copilot_asks where intent = 'stores.quote_read' and route = 'model' and cost_micro_inr > 0`)).toBe(1);

    // A scan (no text): an empty draft, the PDF kept; every line dropped closes it with no quote.
    const scan = aPdf([]);
    const empty = await readQuotePdf(db, { store: store(), inference: liar }, buyer.actor, { rfqId: rfq.id, vendorId: v1, pdf: scan }, at(12));
    expect(empty.readable).toBe(false);
    expect(empty.lines[0]).toMatchObject({ ratePaise: null, source: null });
    const dropped = await confirmQuoteLine(db, buyer.actor, empty.id, { lineIdx: 0, drop: true }, at(13));
    expect(dropped.quote).toBeNull();
    expect(dropped.proposal.status).toBe("dismissed");
    expect(await refusal(readQuotePdf(db, { store: store(), inference: null }, buyer.actor, { rfqId: rfq.id, vendorId: v1, pdf: Buffer.from("not a pdf") }, at(14)))).toBe("not_a_pdf");
    await setHalt(db, owner.actor, "draft", "test");
    expect(await refusal(readQuotePdf(db, { store: store(), inference: null }, buyer.actor, { rfqId: rfq.id, vendorId: v1, pdf }, at(15)))).toBe("agent_paused");
  });

  it("single source (ruling 0101 Q4): a reason, the user HOD's certificate, the materials head's approval up to ₹5 lakh; then the one supplier's quote and Make PO, no other supplier", async () => {
    const pr = await deptPr([{ itemId: printer, qtyBase: 2, estimatePaise: 1_500_000 }], 0);
    const g = await groupRequests(db, buyer.actor, { lines: allLines(pr) }, at(5));
    expect(g.band).toBe("B");
    expect(await refusal(makePoFromGroup(db, buyer.actor, g.id, {}, at(6)))).toBe("rfq_needed");
    const e = await requestBuyException(db, buyer.actor, { kind: "single_source", groupId: g.id, vendorId: v1, reason: "Only the maker's spare fits" }, at(7));
    expect(e).toMatchObject({ status: "waiting_certificate", needsOwner: false });
    expect(await count(sql`select count(*)::int as n from alerts where user_id = ${hodA.id} and title = 'Single source to certify'`)).toBe(1);
    expect(await refusal(advanceBuyException(db, head.actor, e.id, at(8)))).toBe("not_your_seat");
    expect(await refusal(advanceBuyException(db, buyer.actor, e.id, at(8)))).toBe("own_proposal");
    expect((await advanceBuyException(db, hodA.actor, e.id, at(9))).status).toBe("waiting_approval");
    expect(await refusal(advanceBuyException(db, hodA.actor, e.id, at(10)))).toBe("not_your_seat");
    expect((await advanceBuyException(db, head.actor, e.id, at(11))).status).toBe("approved");
    // Only the named supplier's one quote is taken.
    expect(await refusal(enterQuote(db, buyer.actor, { groupId: g.id, vendorId: v2, lines: [{ itemId: printer, ratePaise: 1_400_000 }] }, at(12)))).toBe("rfq_needed");
    await enterQuote(db, buyer.actor, { groupId: g.id, vendorId: v1, lines: [{ itemId: printer, ratePaise: 1_450_000 }] }, at(13));
    const made = await makePoFromGroup(db, buyer.actor, g.id, {}, at(14));
    expect(made.award).toMatchObject({ band: "B", status: "approved" });
    expect(made.award.reason).toContain("Single source");
    expect(made.pos).toEqual([expect.objectContaining({ vendorId: v1, status: "draft" })]);
    // A refused one ends it; nothing else moves.
    const pr2 = await deptPr([{ itemId: printer, qtyBase: 3, estimatePaise: 1_500_000 }], 30);
    const g2 = await groupRequests(db, buyer.actor, { lines: allLines(pr2) }, at(31));
    const e2 = await requestBuyException(db, buyer.actor, { kind: "single_source", groupId: g2.id, vendorId: v2, reason: "Proprietary" }, at(32));
    expect((await refuseBuyException(db, hodA.actor, e2.id, "Two makers supply it", at(33))).status).toBe("refused");
  });

  it("emergency one quote (ruling 0101 Q4): only an emergency request; the superintendent approves, the owner confirms within 72 hours (past it: overdue)", async () => {
    const routine = await deptPr([{ itemId: printer, qtyBase: 2, estimatePaise: 1_500_000 }], 0);
    const gr = await groupRequests(db, buyer.actor, { lines: allLines(routine) }, at(2));
    expect(await refusal(requestBuyException(db, buyer.actor, { kind: "emergency", groupId: gr.id, vendorId: v1, reason: "Ventilator down" }, at(3)))).toBe("not_emergency");
    const pr = await deptPr([{ itemId: printer, qtyBase: 2, estimatePaise: 1_500_000 }], 10, "emergency");
    const g = await groupRequests(db, buyer.actor, { lines: allLines(pr) }, at(12));
    const e = await requestBuyException(db, buyer.actor, { kind: "emergency", groupId: g.id, vendorId: v1, reason: "Ventilator down" }, at(13));
    expect(await count(sql`select count(*)::int as n from alerts where user_id = ${ms.id} and title = 'Emergency buy to approve'`)).toBe(1);
    expect(await refusal(advanceBuyException(db, head.actor, e.id, at(14)))).toBe("not_your_seat");
    const ok = await advanceBuyException(db, ms.actor, e.id, at(15));
    expect(ok.status).toBe("approved");
    expect(ok.confirmBy).toBe(new Date(at(15).getTime() + 72 * 60 * MIN).toISOString());
    await enterQuote(db, buyer.actor, { groupId: g.id, vendorId: v1, lines: [{ itemId: printer, ratePaise: 1_450_000 }] }, at(16));
    expect((await makePoFromGroup(db, buyer.actor, g.id, {}, at(17))).pos).toHaveLength(1);
    expect((await getBuyException(db, e.id, at(15 + 73 * 60))).status).toBe("overdue");
    expect((await advanceBuyException(db, owner.actor, e.id, at(15 + 73 * 60))).status).toBe("confirmed");
  });

  it("advances (ruling 0101 Q7): only on an equipment PO, at most 30 %, against a bank guarantee that covers it, approved by the owner; every other PO is pay after GRN", async () => {
    const pr = await deptPr([{ itemId: monitor, qtyBase: 1, estimatePaise: 900_000, equipment: ANSWERS }], 0);
    const g = await groupRequests(db, buyer.actor, { lines: allLines(pr) }, at(5));
    const e = await requestBuyException(db, buyer.actor, { kind: "single_source", groupId: g.id, vendorId: v1, reason: "Maker's own module" }, at(6));
    expect(e.needsOwner).toBe(true);
    await advanceBuyException(db, hodA.actor, e.id, at(7));
    expect(await refusal(advanceBuyException(db, head.actor, e.id, at(8)))).toBe("not_your_seat");
    await advanceBuyException(db, owner.actor, e.id, at(9));
    await enterQuote(db, buyer.actor, { groupId: g.id, vendorId: v1, lines: [{ itemId: monitor, ratePaise: 900_000 }] }, at(10));
    const [po] = (await makePoFromGroup(db, buyer.actor, g.id, {}, at(11))).pos;
    const bg = { guaranteeNo: "BG-1", guaranteeBank: "A bank", guaranteeValidTo: "2027-06-30" };
    expect(await payTermsOf(db, po!.id)).toEqual({ kind: "after_grn" });
    expect(await refusal(requestPoAdvance(db, buyer.actor, po!.id, { ...bg, pctBps: 4000, guaranteePaise: 1_000_000 }, at(12)))).toBe("advance_over_limit");
    expect(await refusal(requestPoAdvance(db, buyer.actor, po!.id, { ...bg, pctBps: 3000, guaranteePaise: 100 }, at(12)))).toBe("guarantee_short");
    const adv = await requestPoAdvance(db, buyer.actor, po!.id, { ...bg, pctBps: 3000, guaranteePaise: 1_000_000 }, at(13));
    expect(adv).toMatchObject({ status: "requested", amountPaise: Math.round(po!.totalPaise * 0.3) });
    expect(await refusal(decidePoAdvance(db, head.actor, adv.id, { approve: true }, at(14)))).toBe("not_your_seat");
    expect((await decidePoAdvance(db, owner.actor, adv.id, { approve: true }, at(15))).status).toBe("approved");
    expect(await payTermsOf(db, po!.id)).toEqual({ kind: "advance", pctBps: 3000, amountPaise: adv.amountPaise, advanceId: adv.id });
    // A chair is not equipment; a pharmacy-style PO with no award is not a Stores PO.
    const cp = await deptPr([{ itemId: chair, qtyBase: 1, estimatePaise: 400_000 }], 30);
    const cg = await groupRequests(db, buyer.actor, { lines: allLines(cp) }, at(31));
    await enterQuote(db, buyer.actor, { groupId: cg.id, vendorId: v1, lines: [{ itemId: chair, ratePaise: 400_000 }] }, at(32));
    const [chairPo] = (await makePoFromGroup(db, buyer.actor, cg.id, {}, at(33))).pos;
    expect(await refusal(requestPoAdvance(db, buyer.actor, chairPo!.id, { ...bg, pctBps: 1000, guaranteePaise: 1_000_000 }, at(34)))).toBe("advance_not_allowed");
    const plain = await createPurchaseOrder(db, buyer.actor, { vendorId: v1, storeResourceId: genMain, lines: [{ itemId: chair, uom: "piece", qtyPacks: 1, ratePaise: 400_000, gstRateBps: 1800 }] }, { now: at(35) });
    expect(await refusal(requestPoAdvance(db, buyer.actor, plain.id, { ...bg, pctBps: 1000, guaranteePaise: 1_000_000 }, at(36)))).toBe("not_stores_po");
  });

  it("a department's spent counts its Stores POs at PO value once approved (GST in, equipment apart, minus what was delivered); past the budget it is on the owner's monthly list, told once", async () => {
    const pr = await deptPr([{ itemId: chair, qtyBase: 2, estimatePaise: 400_000 }], 0);
    const g = await groupRequests(db, buyer.actor, { lines: allLines(pr) }, at(5));
    await enterQuote(db, buyer.actor, { groupId: g.id, vendorId: v1, lines: [{ itemId: chair, ratePaise: 400_000 }] }, at(6));
    const [po] = (await makePoFromGroup(db, buyer.actor, g.id, {}, at(7))).pos;
    await submitStoresPo(db, buyer.actor, po!.id, at(8));
    await decidePurchaseOrder(db, head.actor, po!.id, "approve", "ok", at(9));
    const [{ m }] = (await db.execute(sql`select to_char(approved_at at time zone 'Asia/Kolkata', 'YYYY-MM') as m from purchase_orders where id = ${po!.id}`)).rows as [{ m: string }];
    await setDepartmentBudget(db, owner.actor, { departmentId: deptA.id, month: m, amountPaise: 900_000 }, at(10));
    const b = await departmentBudget(db, deptA.id, m);
    expect(b.committedPaise).toBe(2 * 400_000 + Math.floor((2 * 400_000 * 1800 + 5_000) / 10_000));
    expect(b.spentPaise).toBe(b.committedPaise);
    const list = await overBudgetList(db, owner.actor, m);
    expect(list.departments.map((d) => [d.departmentId, d.committedPaise])).toEqual([[deptA.id, b.committedPaise]]);
    expect(await refusal(overBudgetList(db, inA.actor, m))).toBe("not_permitted");
    const [y, mo] = m.split("-").map(Number) as [number, number];
    const next = new Date(`${mo === 12 ? String(y + 1) : String(y)}-${String(mo === 12 ? 1 : mo + 1).padStart(2, "0")}-02T06:30:00.000Z`);
    expect(await sendOwnerOverBudgetList(db, next)).toBe(1);
    expect(await sendOwnerOverBudgetList(db, new Date(next.getTime() + MIN))).toBe(0);
  });

  it("Now cards: 'Purchase to approve' is the HOD's waiting line; 'Award to sign' is the materials head's on a band B award", async () => {
    const pr = await raisePurchaseRequest(db, inA.actor, { source: "department", departmentId: deptA.id, shelfId: shelfA, priority: "routine", lines: [{ itemId: printer, qtyBase: 2, estimatePaise: 1_500_000 }] }, at(0));
    expect(await storesPurchaseApproveDesk.waiting!({ db, actor: hodA.actor, now: at(1) } as never)).toEqual([expect.objectContaining({ kind: "stores.purchaseToApprove", count: 1 })]);
    expect(await storesPurchaseApproveDesk.waiting!({ db, actor: inA.actor, now: at(1) } as never)).toEqual([]);
    await approvePurchaseRequest(db, hodA.actor, pr.id, at(2));
    const g = await groupRequests(db, buyer.actor, { lines: allLines(pr) }, at(3));
    const rfq = await createRfq(db, buyer.actor, { groupId: g.id, replyBy: at(DAY), vendorIds: [v1, v2, v3] }, at(4));
    await sendRfq(db, buyer.actor, rfq.id, { channel: "email" }, at(5));
    for (const [i, v] of [v1, v2, v3].entries()) await enterQuote(db, buyer.actor, { rfqId: rfq.id, vendorId: v, lines: [{ itemId: printer, ratePaise: 1_400_000 + i * 10_000 }] }, at(10 + i));
    await proposeAward(db, buyer.actor, { rfqId: rfq.id, vendorId: v1 }, at(20));
    expect(await storesAwardSignDesk.waiting!({ db, actor: head.actor, now: at(21) } as never)).toEqual([expect.objectContaining({ kind: "stores.awardToSign", count: 1 })]);
    expect((await getBuyGroup(db, g.id, at(21))).status).toBe("awarded");
  });
});
