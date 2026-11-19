import { and, eq, sql } from "drizzle-orm";
import { COPILOT_ANSWER_KEYS, newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { assignRole, grantPermissionToRole, hasPermission, syncPermissions } from "../../../kernel/auth/permissions";
import { seedSodPairs } from "../../../kernel/auth/sod";
import { withTx } from "../../../kernel/db/client";
import { alerts, copilotActs, orgDepartments, stockLedger } from "../../../kernel/db/schema";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../../kernel/modules/manifests";
import { KERNEL_RESOURCE_KINDS } from "../../../kernel/resources/kinds";
import { createResource } from "../../../kernel/resources/registry";
import { collectCopilotIntents, collectCopilotTools, runTool } from "../../../kernel/copilot/catalog";
import { installCopilotIntents } from "../../../kernel/copilot/intents";
import { assertNoIdentifiers, maskQuestion, rehydrate } from "../../../kernel/copilot/mask";
import { routeQuestion } from "../../../kernel/copilot/router";
import { confirmProposal, issueProposal, proposalKey } from "../../../kernel/copilot/act";
import { setHalt } from "../../../kernel/copilot/halt";
import { istDayString } from "../../../kernel/approvals/cumulative";
import { createStore, raiseIndent, registerItem, registerMaterialsApprovalTypes } from "../../materials";
import { storesManifest } from "../manifest";
import {
  approveTicket, claimPicking, createShelf, deliverTicket, issueTicket, listCategories, myCustody, openShelf, openStore, raiseGatePass, raiseReturn,
  raiseTicket, receiveReturn, recordShelfUse, registerStoresItem, runStoresChaser, scanGatePass, seedStoresMasters, setShelfPar,
  storesStuckDesk, takeCustody, ticketTimeline, towerSummary, towerView,
} from "../index";
import type { ModuleManifest } from "../../../kernel/modules/manifest";
import type { CopilotAnswer, CopilotToolDecl } from "../../../kernel/copilot/types";
import type { DeskProviderCtx } from "../../../kernel/desk/types";
import type { Actor, WireTowerCard } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1113, spec docs/specs/1113-stores-control-tower.md (owner APPROVED 2026-11-18, ruling 0099):
 * Stores S3, the control tower (`towerView`), the owner's one line (`towerSummary`), the Stuck Now card, the
 * chaser, and the concierge — seven cue-routed intents, the masker knowing the indent number, one confirmed act.
 * One test per done-means id the server answers: D1–D14 here, D16 through the HTTP ask and confirm routes in
 * stores-s3-ledger-1113.e2e.test.ts. D15 and D17 (the screens) are the web half,
 * apps/web/src/screens/acceptance/stores-tower-1113.test.tsx.
 *
 * The tower, the chaser and the desk card are handed the clock they run on. The copilot's tools read the real
 * clock (a question is about now), so the tickets they are asked about are raised relative to `Date.now()`.
 */
const SEVEN = [
  "stores.where_is_ticket", "stores.my_tickets", "stores.waiting_for_me", "stores.where_is_item", "stores.shelf_low", "stores.stuck", "stores.reorder",
].sort();

/** The spec's table: intent → [permission, alsoAdmits]. */
const PERMISSIONS: Record<string, [string, string[]]> = {
  "stores.where_is_ticket": ["stores.shelf.read", ["stores.tower.read"]],
  "stores.my_tickets": ["stores.shelf.read", []],
  "stores.waiting_for_me": ["stores.indents.approve", ["materials.stock.issue", "stores.nightstore.issue", "stores.carry", "stores.shelf.work"]],
  "stores.where_is_item": ["stores.shelf.read", ["stores.tower.read"]],
  "stores.shelf_low": ["stores.shelf.read", []],
  "stores.stuck": ["stores.tower.read", []],
  "stores.reorder": ["stores.shelf.work", []],
};

/** D8 — the indent number a question carries, as a label prints it. */
const T = "MIN2611190007";

/** D8 — ten each in English, Hindi (Devanagari) and Hinglish. */
const PHRASES: { script: "en" | "hi-deva" | "hi-latn"; q: string; want: string }[] = [
  { script: "en", q: `where is ticket ${T} now`, want: "stores.where_is_ticket" },
  { script: "en", q: "what is waiting for me", want: "stores.waiting_for_me" },
  { script: "en", q: "show our department's open tickets", want: "stores.my_tickets" },
  { script: "en", q: "how many mop refills in the store", want: "stores.where_is_item" },
  { script: "en", q: "which items are low on my shelf", want: "stores.shelf_low" },
  { script: "en", q: "how many tickets are stuck", want: "stores.stuck" },
  { script: "en", q: "show the red cards", want: "stores.stuck" },
  { script: "en", q: "reorder my shelf", want: "stores.reorder" },
  { script: "en", q: "indents to approve", want: "stores.waiting_for_me" },
  { script: "en", q: "where do we have gloves", want: "stores.where_is_item" },
  { script: "hi-deva", q: `${T} कहाँ है`, want: "stores.where_is_ticket" },
  { script: "hi-deva", q: "मेरे इंडेंट दिखाओ", want: "stores.my_tickets" },
  { script: "hi-deva", q: "मुझे क्या करना है", want: "stores.waiting_for_me" },
  { script: "hi-deva", q: "स्टोर में दस्ताने कितने हैं", want: "stores.where_is_item" },
  { script: "hi-deva", q: "मेरे यहाँ क्या कम है", want: "stores.shelf_low" },
  { script: "hi-deva", q: "कितने इंडेंट अटके हैं", want: "stores.stuck" },
  { script: "hi-deva", q: "शेल्फ के लिए इंडेंट भेज दो", want: "stores.reorder" },
  { script: "hi-deva", q: "मेरा सामान कहाँ पहुँचा", want: "stores.where_is_ticket" },
  { script: "hi-deva", q: "मंज़ूरी के लिए कितने इंडेंट हैं", want: "stores.waiting_for_me" },
  { script: "hi-deva", q: "किस स्टोर में मॉप है", want: "stores.where_is_item" },
  { script: "hi-latn", q: `${T} kahan hai`, want: "stores.where_is_ticket" },
  { script: "hi-latn", q: "mere tickets dikhao", want: "stores.my_tickets" },
  { script: "hi-latn", q: "mujhe kya karna hai", want: "stores.waiting_for_me" },
  { script: "hi-latn", q: "store mein gloves kitne pade hain", want: "stores.where_is_item" },
  { script: "hi-latn", q: "mere yahan kya kam hai", want: "stores.shelf_low" },
  { script: "hi-latn", q: "kitne indent atke hain", want: "stores.stuck" },
  { script: "hi-latn", q: "saman mangwa do", want: "stores.reorder" },
  { script: "hi-latn", q: "mera saman kahan hai", want: "stores.where_is_ticket" },
  { script: "hi-latn", q: "approve karne wale indent", want: "stores.waiting_for_me" },
  { script: "hi-latn", q: "red card dikhao", want: "stores.stuck" },
];

const registryOf = (manifests: readonly ModuleManifest[]): ModuleRegistry => {
  const r = new ModuleRegistry();
  for (const m of manifests) r.install(m);
  return r;
};

function toolFor(intent: string): CopilotToolDecl {
  const t = (storesManifest.copilotTools ?? []).find((x) => x.intent === intent);
  if (t === undefined) throw new Error(`stores declares no copilot tool ${intent}`);
  return t;
}

const KEY = proposalKey(Buffer.from("spec-1113-acceptance-secret-key-0000000"));

/** Every key a card carries: no patient field, no money (D6). */
const CARD_KEYS = ["clock", "department", "floor", "holder", "id", "indentNo", "lane", "minutes", "priority"];

describe("Stores S3: the control tower, Now cards, concierge and chaser (spec #1113)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  type Who = { id: string; actor: Actor };
  let head: Who;
  let keeper: Who;
  let dm: Who;
  let owner: Who;
  let inA: Who;
  let hodA: Who;
  let inB: Who;
  let hodB: Who;
  let porter: Who;
  let guard: Who;
  let genMain: string;
  let shelfA: string;
  let shelfB: string;
  let deptA: string;
  let deptB: string;
  let mop: string;
  let gloves: string;

  /** 12:00 IST on 2026-11-10 — inside GEN-MAIN's 09:00–17:00. */
  const NOW = new Date("2026-11-10T06:30:00.000Z");
  const MIN = 60_000;
  const at = (m: number): Date => new Date(NOW.getTime() + m * MIN);
  /** The real clock, for the copilot's tools; ten seconds past a whole minute so a read a moment later rounds alike. */
  const ago = (m: number): Date => new Date(Date.now() - m * MIN - 10_000);

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    installCopilotIntents(collectCopilotIntents(registryOf(ALL_MANIFESTS)));
  });
  afterAll(async () => {
    installCopilotIntents(null);
    await teardown();
  });

  beforeEach(async () => {
    await truncateAll(db);
    const registry = registryOf(ALL_MANIFESTS);
    await syncPermissions(db, registry);
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    const grants: Record<string, string[]> = {
      materials_head: [
        "stores.masters.manage", "stores.shelf.read", "stores.audit.read", "stores.tower.read", "stores.spend.read",
        "materials.items.read", "materials.stock.read", "materials.stock.receive",
      ],
      storekeeper: ["materials.stock.read", "materials.stock.issue", "materials.stock.receive", "stores.gatepass.raise", "stores.tower.read"],
      duty_manager: ["stores.tower.read"],
      owner: ["stores.tower.read", "stores.spend.read"],
      department_store_incharge: ["stores.shelf.read", "stores.shelf.work"],
      department_head: ["stores.shelf.read", "stores.indents.approve"],
      support_staff: ["stores.carry"],
      security_guard: ["stores.gatepass.scan"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    head = await mkUser(db, "stores.head", ["materials_head"]);
    keeper = await mkUser(db, "keeper.a", ["storekeeper"]);
    dm = await mkUser(db, "duty.manager", ["duty_manager"]);
    owner = await mkUser(db, "the.owner", ["owner"]);
    porter = await mkUser(db, "porter.a", ["support_staff"]);
    guard = await mkUser(db, "guard.a", ["security_guard"]);
    inA = await mkUser(db, "incharge.a", []);
    hodA = await mkUser(db, "hod.a", []);
    inB = await mkUser(db, "incharge.b", []);
    hodB = await mkUser(db, "hod.b", []);

    deptA = await anOrgDept("HSK", "Housekeeping");
    deptB = await anOrgDept("OT", "Operation theatre");
    await assignRole(db, { userId: inA.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptA });
    await assignRole(db, { userId: hodA.id, roleKey: "department_head", scopeType: "department", scopeId: deptA });
    await assignRole(db, { userId: inB.id, roleKey: "department_store_incharge", scopeType: "department", scopeId: deptB });
    await assignRole(db, { userId: hodB.id, roleKey: "department_head", scopeType: "department", scopeId: deptB });

    const floor1 = await aFloor("F1", "First floor");
    const floor2 = await aFloor("F2", "Second floor");
    ({ centralStoreId: genMain } = await seedStoresMasters(db, head.actor));
    const cat = new Map((await listCategories(db)).map((c) => [c.code, c.id]));
    mop = (await registerStoresItem(db, head.actor, { code: "HK-MOP-0001", name: "Wet mop refill", class: "consumable", baseUom: "piece", categoryId: cat.get("HSK")!, trackMode: "shelf" })).itemId;
    gloves = (await registerStoresItem(db, head.actor, { code: "HK-GLV-0002", name: "Household gloves", class: "consumable", baseUom: "pair", categoryId: cat.get("HSK")!, trackMode: "shelf" })).itemId;
    await openStore(db, head.actor, "GEN-MAIN", [{ itemId: mop, qty: 500, unitCostPaise: 250 }, { itemId: gloves, qty: 500, unitCostPaise: 40 }], new Date(Math.min(at(-600).getTime(), Date.now() - 600 * MIN)));
    ({ shelfId: shelfA } = await createShelf(db, head.actor, { code: "HSK-F1", name: "Housekeeping F1", floorId: floor1, departmentId: deptA, suppliedBy: genMain }));
    ({ shelfId: shelfB } = await createShelf(db, head.actor, { code: "OT-F2", name: "OT F2", floorId: floor2, departmentId: deptB, suppliedBy: genMain }));
  });

  /* ─────────────────────────────── fixtures ─────────────────────────────── */

  async function anOrgDept(code: string, name: string): Promise<string> {
    const id = newId();
    await db.insert(orgDepartments).values({ id, code, name, kind: "support", opdDepartmentId: null, createdBy: "t", updatedBy: "t" });
    return id;
  }
  async function aFloor(code: string, name: string): Promise<string> {
    return (await withTx(db, (tx) => createResource(tx, head.actor, KERNEL_RESOURCE_KINDS, { kind: "floor", code, name }))).resourceId;
  }
  const raised = (who: Who, shelfId: string, when: Date, lines = [{ itemId: mop, qtyBase: 20 }]) =>
    raiseTicket(db, who.actor, { shelfId, lines, priority: "routine", channel: "phone" }, when);
  /** Raised at `t0`, approved a minute later, claimed and issued: on its way, in the keeper's hands. */
  async function issuedAt(t0: Date, who: Who = inA, shelfId = shelfA, hod: Who = hodA, lines = [{ itemId: mop, qtyBase: 20 }]) {
    const t = await raised(who, shelfId, t0, lines);
    await approveTicket(db, hod.actor, t.id, {}, new Date(t0.getTime() + MIN));
    await claimPicking(db, keeper.actor, t.id, new Date(t0.getTime() + 2 * MIN));
    return issueTicket(db, keeper.actor, t.id, {}, new Date(t0.getTime() + 3 * MIN));
  }
  const allCards = (v: { lanes: Record<string, WireTowerCard[]> }): WireTowerCard[] => Object.values(v.lanes).flat();
  const laneOf = (v: { lanes: Record<string, WireTowerCard[]> }, id: string): string[] =>
    Object.entries(v.lanes).filter(([, cards]) => cards.some((c) => c.id === id)).map(([lane]) => lane);

  /** The ask route minus HTTP: mask, route on the phrasebook alone, rehydrate, run as the asker. */
  async function askAs(who: Who, typed: string, want: string): Promise<{ answer: CopilotAnswer; subject: string | null; masked: string }> {
    const { masked, slots } = maskQuestion(typed);
    const routed = await routeQuestion(masked, slots, null, null);
    expect(routed?.intent).toBe(want);
    const subject = routed?.slot == null ? null : rehydrate(routed.slot, slots);
    const ctx = { db, actor: who.actor, subject, serviceDate: istDayString(new Date()), question: masked, typed };
    const answer = await runTool(toolFor(want), ctx, (p) => hasPermission(db, who.id, p, "hospital"));
    return { answer, subject, masked };
  }
  async function confirmAs(who: Who, option: { args: unknown; subject: string | null }) {
    const tools = collectCopilotTools(registryOf(ALL_MANIFESTS));
    const proposal = issueProposal(KEY, toolFor("stores.reorder"), who.actor, { args: option.args }, option.subject, new Date());
    if (proposal === null) throw new Error("stores.reorder refused its own args at propose");
    return await confirmProposal({ db, key: KEY, tools, halts: new Set(), now: new Date(), can: (p) => hasPermission(db, who.id, p, "hospital") }, who.actor, proposal);
  }
  const optionsOf = (a: CopilotAnswer): { args: Record<string, unknown>; subject: string | null }[] =>
    [...(a.proposeMany ?? []), ...(a.propose === undefined ? [] : [{ ...a.propose, subject: null }])] as { args: Record<string, unknown>; subject: string | null }[];
  const deskCtx = (who: Who, now: Date): DeskProviderCtx => ({ db, actor: who.actor, reader: who.actor, date: istDayString(now), now });

  /* ─────────────────────────────── D1–D6: the tower ─────────────────────────────── */

  it("spec #1113 D1: towerView puts each open ticket in exactly one lane; a ticket waiting 61 min for approval is Stuck with the clock 'approval, 61 min'", async () => {
    const waiting = await raised(inA, shelfA, at(0));
    const approved = await raised(inA, shelfA, at(5));
    await approveTicket(db, hodA.actor, approved.id, {}, at(10));
    const picking = await raised(inA, shelfA, at(6));
    await approveTicket(db, hodA.actor, picking.id, {}, at(11));
    await claimPicking(db, keeper.actor, picking.id, at(55));
    const moving = await issuedAt(at(20));
    await takeCustody(db, porter.actor, { code: moving.indentNo }, at(50));
    const fresh = await raised(inB, shelfB, at(40));

    const v = await towerView(db, head.actor, at(61));
    for (const c of allCards(v)) expect(laneOf(v, c.id)).toEqual([c.lane]);
    expect(laneOf(v, waiting.id)).toEqual(["stuck"]);
    const card = v.lanes.stuck.find((c) => c.id === waiting.id)!;
    expect(card.clock).toEqual({ kind: "approval", minutes: 61 });
    expect(laneOf(v, approved.id)).toEqual(["approved"]);
    expect(laneOf(v, picking.id)).toEqual(["picking"]);
    expect(laneOf(v, moving.id)).toEqual(["in_transit"]);
    expect(laneOf(v, fresh.id)).toEqual(["requested"]);
  });

  it("spec #1113 D2: an in-transit card shows the current holder and the minutes since the last hand-off, equal to the custody chain's", async () => {
    const t = await issuedAt(at(0));
    await takeCustody(db, porter.actor, { code: t.indentNo }, at(5));
    const now = at(17);
    const v = await towerView(db, head.actor, now);
    const card = v.lanes.in_transit.find((c) => c.id === t.id)!;
    const chain = (await myCustody(db, porter.actor, now)).find((r) => r.ticket.id === t.id)!;
    expect(card.holder).toEqual({ id: porter.id, name: chain.ticket.custody!.holder!.name });
    expect(card.minutes).toBe(chain.minutes);
    expect(card.minutes).toBe(12);
  });

  it("spec #1113 D3: in the floor map a department with a shelf item at 0 shows 'Out' under its floor; one with every item above reorder shows 'OK'", async () => {
    await setShelfPar(db, head.actor, { shelfId: shelfA, itemId: mop, minBase: 5, reorderBase: 10, maxBase: 40 });
    await setShelfPar(db, head.actor, { shelfId: shelfB, itemId: gloves, minBase: 2, reorderBase: 5, maxBase: 60 });
    await openShelf(db, inB.actor, shelfB, [{ itemId: gloves, qty: 50 }], at(0));
    const v = await towerView(db, head.actor, at(1));
    const f1 = v.floors.find((f) => f.code === "F1")!;
    const f2 = v.floors.find((f) => f.code === "F2")!;
    expect(f1.departments.find((d) => d.code === "HSK")?.status).toBe("out");
    expect(f2.departments.find((d) => d.code === "OT")?.status).toBe("ok");
    expect(f2.departments.some((d) => d.code === "HSK")).toBe(false);
  });

  it("spec #1113 D4: one stuck ticket, one open short and one overdue pass make three red cards, oldest first; never more than 8", async () => {
    const DAY = 24 * 60;
    // The overdue pass: out two days ago, due back yesterday.
    const pass = await raiseGatePass(db, keeper.actor, {
      kind: "returnable", storeId: genMain, purpose: "repair", party: "Sharma Electricals", dueBack: istDayString(at(-DAY)), lines: [{ itemId: gloves, qty: 2 }],
    }, at(-2 * DAY));
    await scanGatePass(db, guard.actor, { code: pass.passNo, act: "exit" }, at(-2 * DAY + 5));
    // The open short: delivered two and a half hours ago, 3 short.
    const shortT = await issuedAt(at(-200));
    await takeCustody(db, porter.actor, { code: shortT.indentNo }, at(-190));
    await deliverTicket(db, inA.actor, shortT.id, { lines: [{ lineIdx: 0, accepted: 17, short: 3 }] }, at(-150));
    // The stuck ticket: raised 61 minutes ago, not approved.
    const stuck = await raised(inB, shelfB, at(-61));

    const v = await towerView(db, head.actor, at(0));
    expect(v.redCards.map((c) => c.kind)).toEqual(["pass", "short", "stuck"]);
    expect(v.redCards.map((c) => c.indentId ?? c.passId)).toEqual([pass.id, shortT.id, stuck.id]);
    const since = v.redCards.map((c) => c.since);
    expect([...since].sort()).toEqual(since);

    for (let i = 0; i < 9; i += 1) await raised(inB, shelfB, at(-120 - i));
    const more = await towerView(db, head.actor, at(0));
    expect(more.redCards.length).toBe(8);
  });

  it("spec #1113 D5: the spend tile is present for a holder of stores.spend.read and absent for a storekeeper; a department's value is the month's receipts into its shelves less its returns, use excluded", async () => {
    const t = await issuedAt(at(-300), inA, shelfA, hodA, [{ itemId: mop, qtyBase: 20 }, { itemId: gloves, qtyBase: 10 }]);
    await deliverTicket(db, inA.actor, t.id, {}, at(-200));
    await recordShelfUse(db, inA.actor, { shelfId: shelfA, itemId: mop, qty: 3 }, at(-100));
    const [ret] = await raiseReturn(db, inA.actor, { shelfId: shelfA, lines: [{ itemId: mop, qtyBase: 2, reason: "unused" }] }, at(-90));
    await receiveReturn(db, keeper.actor, ret!.transferId, at(-80));

    const forHead = await towerView(db, head.actor, at(0));
    const forKeeper = await towerView(db, keeper.actor, at(0));
    expect("spend" in forHead).toBe(true);
    expect("spend" in forKeeper).toBe(false);
    expect(JSON.stringify(forKeeper)).not.toContain("chargePaise");
    const hsk = forHead.spend!.departments.find((d) => d.code === "HSK")!;
    // 20 mop × ₹2.50 + 10 gloves × ₹0.40 received; 2 mop returned; the 3 used are not counted again.
    expect(hsk.chargePaise).toBe(20 * 250 + 10 * 40 - 2 * 250);
    const consumed = await db.select({ n: sql<number>`count(*)::int` }).from(stockLedger).where(and(eq(stockLedger.resourceId, shelfA), eq(stockLedger.reason, "consume")));
    expect(consumed[0]!.n).toBeGreaterThan(0);
    expect((await towerView(db, owner.actor, at(0))).spend).toBeDefined();
  });

  it("spec #1113 D6: towerView never lists a drug item or a pharmacy store, and has no patient field (the key set is asserted)", async () => {
    const { resourceId: pharm } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" }));
    const { resourceId: main } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-MAIN", name: "Pharmacy main" }));
    const gauze = (await withTx(db, (tx) => registerItem(tx, head.actor, { code: "GAUZE", name: "Gauze", class: "consumable", baseUom: "piece", batchTracked: false }))).itemId;
    const pharmacyIndent = await raiseIndent(db, head.actor, { fromResourceId: pharm, toResourceId: main, lines: [{ itemId: gauze, qtyBase: 10 }] }, at(-70));
    const mine = await raised(inA, shelfA, at(-5));

    const v = await towerView(db, head.actor, at(0));
    const cards = allCards(v);
    expect(cards.map((c) => c.id)).toContain(mine.id);
    expect(cards.map((c) => c.id)).not.toContain(pharmacyIndent.id);
    expect(JSON.stringify(v)).not.toContain(pharmacyIndent.indentNo);
    expect(JSON.stringify(v)).not.toContain("PHARM-");
    for (const c of cards) expect(Object.keys(c).sort()).toEqual(CARD_KEYS);
    expect(Object.keys(v).sort()).toEqual(["at", "floors", "lanes", "numbers", "redCards", "spend"]);
    expect(JSON.stringify(v).toLowerCase()).not.toMatch(/patient|uhid|encounter/);
  });

  /* ─────────────────────────────── D7–D12: the concierge ─────────────────────────────── */

  it("spec #1113 D7: the boot collector lists the seven stores intents, each with a declared permission; the intents declared act are exactly stores.reorder", () => {
    const registry = registryOf(ALL_MANIFESTS);
    const tools = collectCopilotTools(registry).filter((t) => t.intent.startsWith("stores."));
    expect(tools.map((t) => t.intent).sort()).toEqual(SEVEN);
    expect(collectCopilotIntents(registry).filter((i) => i.module === "stores").map((i) => i.intent).sort()).toEqual(SEVEN);
    for (const t of tools) {
      expect(t.permission).not.toBeNull();
      expect([t.permission, [...(t.alsoAdmits ?? [])].sort()]).toEqual([PERMISSIONS[t.intent]![0], [...PERMISSIONS[t.intent]![1]].sort()]);
    }
    expect(tools.filter((t) => t.kind === "act").map((t) => t.intent)).toEqual(["stores.reorder"]);
    // Every key a stores intent may answer has a sentence.
    const keys = collectCopilotIntents(registry).filter((i) => i.module === "stores").flatMap((i) => i.decl.answerKeys);
    for (const k of keys) expect(COPILOT_ANSWER_KEYS).toContain(k);
  });

  it("spec #1113 D8: thirty phrases (ten each in English, Hindi and Hinglish) route to their intents by the phrasebook alone", async () => {
    expect(PHRASES.filter((p) => p.script === "en")).toHaveLength(10);
    expect(PHRASES.filter((p) => p.script === "hi-deva")).toHaveLength(10);
    expect(PHRASES.filter((p) => p.script === "hi-latn")).toHaveLength(10);
    expect(new Set(PHRASES.map((p) => p.want))).toEqual(new Set(SEVEN));
    const missed: string[] = [];
    for (const p of PHRASES) {
      const { masked, slots } = maskQuestion(p.q);
      const routed = await routeQuestion(masked, slots, null, null);
      if (routed?.intent !== p.want || routed.via !== "phrasebook") missed.push(`${p.q} -> ${String(routed?.intent)} (${String(routed?.via)})`);
    }
    expect(missed).toEqual([]);
  });

  it("spec #1113 D9: a question carrying an indent number is masked before routing, the ticket returns as the subject, and where_is_ticket answers the tower card's lane, holder and minutes", async () => {
    const t = await issuedAt(ago(40));
    await takeCustody(db, porter.actor, { code: t.indentNo }, ago(12));
    const label = `${t.indentNo.slice(0, 3)}-${t.indentNo.slice(3, 9)}-${t.indentNo.slice(9)}`;
    for (const typed of [`${t.indentNo} kahan hai?`, `${label} kahan hai?`]) {
      const { answer, subject, masked } = await askAs(inA, typed, "stores.where_is_ticket");
      expect(masked).not.toContain(t.indentNo.slice(3));
      expect(() => assertNoIdentifiers(masked)).not.toThrow();
      expect(subject).not.toBeNull();
      const card = allCards(await towerView(db, head.actor, new Date())).find((c) => c.id === t.id)!;
      expect(answer.key).toBe("copilot.answer.storesTicketWhere");
      expect(answer.params).toMatchObject({ ticket: t.indentNo, lane: card.lane, holder: card.holder!.name, minutes: card.minutes });
      expect(card.lane).toBe("in_transit");
      expect(card.minutes).toBe(12);
    }
  });

  it("spec #1113 D10: where_is_item answers per-place quantities whose sum equals the ledger balances of that item over the asker's visible places", async () => {
    const t = await issuedAt(ago(60), inA, shelfA, hodA, [{ itemId: mop, qtyBase: 20 }]);
    await deliverTicket(db, inA.actor, t.id, {}, ago(30));
    const moving = await issuedAt(ago(20), inB, shelfB, hodB, [{ itemId: mop, qtyBase: 7 }]);
    void moving;
    const { answer } = await askAs(inA, "how many mop refills in the store", "stores.where_is_item");
    expect(answer.key).toBe("copilot.answer.storesItemWhere");
    const rows = (answer.payload as { rows: { place: string; kind: string; qty: number }[] }).rows;
    // inA sees the stores, their own shelf and IN-TRANSIT; never the OT shelf.
    expect(rows.some((r) => r.place === "OT F2")).toBe(false);
    const visible = await db.execute(sql`
      select coalesce(sum(l.qty_delta), 0)::int as n from stock_ledger l join resources r on r.id = l.resource_id
      where l.item_id = ${mop} and (r.attributes->>'domain' = 'stores' and (r.attributes->>'kind' <> 'shelf' or r.id = ${shelfA}) or r.code = 'IN-TRANSIT')`);
    expect(rows.reduce((s, r) => s + r.qty, 0)).toBe(Number((visible.rows[0] as { n: number }).n));
    expect(rows.find((r) => r.place === "Housekeeping F1")?.qty).toBe(20);
    expect(rows.find((r) => r.kind === "transit")?.qty).toBe(7);
  });

  it("spec #1113 D11: waiting_for_me lists exactly an HOD's own department's pending approvals, and for a porter only the tickets the porter holds", async () => {
    const a1 = await raised(inA, shelfA, ago(10));
    const a2 = await raised(inA, shelfA, ago(9));
    await raised(inB, shelfB, ago(8));
    const carried = await issuedAt(ago(30));
    await takeCustody(db, porter.actor, { code: carried.indentNo }, ago(5));
    await issuedAt(ago(25), inB, shelfB, hodB);

    const hod = await askAs(hodA, "what is waiting for me", "stores.waiting_for_me");
    expect(hod.answer.key).toBe("copilot.answer.storesWaiting");
    expect(hod.answer.params).toMatchObject({ approve: 2, pick: 0, carry: 0, receive: 0 });
    expect((hod.answer.payload as { tickets: string[] }).tickets.sort()).toEqual([a1.indentNo, a2.indentNo].sort());
    const por = await askAs(porter, "mujhe kya karna hai", "stores.waiting_for_me");
    expect(por.answer.params).toMatchObject({ approve: 0, pick: 0, carry: 1, receive: 0 });
    expect((por.answer.payload as { tickets: string[] }).tickets).toEqual([carried.indentNo]);
  });

  it("spec #1113 D12: reorder — propose then confirm raises one ticket with the draft's lines and writes one act row; a reorder raised in between answers 'state changed' and raises nothing", async () => {
    await setShelfPar(db, head.actor, { shelfId: shelfA, itemId: mop, minBase: 5, reorderBase: 10, maxBase: 40 });
    const count = async (): Promise<number> => Number((await db.execute(sql`select count(*)::int as n from stores_ticket_details where shelf_id = ${shelfA}`)).rows[0]!.n);

    const first = await askAs(inA, "reorder my shelf", "stores.reorder");
    expect(first.answer.key).toBe("copilot.answer.storesReorderPick");
    const [opt] = optionsOf(first.answer);
    expect(opt!.args).toMatchObject({ shelfId: shelfA, lines: [{ itemId: mop, qtyBase: 40 }] });
    // Somebody raises a reorder for the shelf between propose and confirm.
    await raised(inA, shelfA, new Date(), [{ itemId: mop, qtyBase: 40 }]);
    const before = await count();
    const changed = await confirmAs(inA, opt!);
    expect(changed.outcome).toBe("stateChanged");
    expect(changed.answer.key).toBe("copilot.answer.storesStateChanged");
    expect(await count()).toBe(before);
    expect(await db.select().from(copilotActs)).toHaveLength(0);

    // On a shelf with no open ticket, the same two steps raise it.
    await setShelfPar(db, head.actor, { shelfId: shelfB, itemId: gloves, minBase: 2, reorderBase: 5, maxBase: 30 });
    const again = await askAs(inB, "reorder my shelf", "stores.reorder");
    const done = await confirmAs(inB, optionsOf(again.answer)[0]!);
    expect(done.outcome).toBe("done");
    expect(done.answer.key).toBe("copilot.answer.storesReorderSent");
    const acts = await db.select().from(copilotActs);
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ tool: "stores.reorder", actorId: inB.id, resultModule: "stores" });
    const ticket = (await db.execute(sql`select i.id, l.item_id, l.qty_base, d.channel from store_indents i join stores_ticket_details d on d.indent_id = i.id
      join store_indent_lines l on l.indent_id = i.id where i.id = ${acts[0]!.resultRowId}`)).rows;
    expect(ticket).toEqual([{ id: acts[0]!.resultRowId, item_id: gloves, qty_base: 30, channel: "copilot" }]);
  });

  /* ─────────────────────────────── D13–D14: the chaser, the halt ─────────────────────────────── */

  it("spec #1113 D13: the chaser sends one bell to the approvers at 45 min and none on the next sweep at 50; at 60 min the duty manager's Now card lists the ticket", async () => {
    const t = await raised(inA, shelfA, at(0));
    const bells = async (): Promise<number> =>
      (await db.select().from(alerts).where(eq(alerts.userId, hodA.id))).filter((a) => a.title === "Indent waiting 45 min").length;
    await runStoresChaser(db, at(44));
    expect(await bells()).toBe(0);
    await runStoresChaser(db, at(45));
    expect(await bells()).toBe(1);
    await runStoresChaser(db, at(50));
    expect(await bells()).toBe(1);
    const nudges = await db.execute(sql`select step from stores_nudges where indent_id = ${t.id}`);
    expect(nudges.rows).toEqual([{ step: "approval" }]);
    const before = await storesStuckDesk.load(deskCtx(dm, at(59)));
    expect(before.flatMap((c) => c.rows ?? []).some((r) => r.id === t.id)).toBe(false);
    const card = await storesStuckDesk.load(deskCtx(dm, at(60)));
    expect(card.flatMap((c) => c.rows ?? []).map((r) => r.id)).toContain(t.id);
  });

  it("spec #1113 D14: with the copilot halted for reads, or the model unavailable, towerView, the Now cards and the timeline still answer", async () => {
    const t = await raised(inA, shelfA, at(0));
    await setHalt(db, owner.actor, "read", "test");
    await setHalt(db, owner.actor, "global", "test");
    const v = await towerView(db, head.actor, at(61));
    expect(v.lanes.stuck.map((c) => c.id)).toContain(t.id);
    expect((await storesStuckDesk.load(deskCtx(dm, at(61)))).length).toBe(1);
    expect((await ticketTimeline(db, head.actor, t.id)).steps.length).toBeGreaterThan(0);
    expect(await towerSummary(db, owner.actor, at(61))).toEqual({ stuck: 1, places: ["F1"] });
    // The tool itself is halted; the screens are not.
    const halted = await runTool(toolFor("stores.stuck"), { db, actor: head.actor, subject: null, serviceDate: istDayString(new Date()), question: "red card" },
      (p) => hasPermission(db, head.id, p, "hospital"), new Set(["read"]));
    expect(halted.key).toBe("copilot.answer.paused");
  });

  /* ─────────────────────────────── D17: the owner's one line (its server half) ─────────────────────────────── */

  it("spec #1113 D17: towerSummary with three stuck tickets on two floors returns count 3 and those places, most stuck first", async () => {
    await raised(inA, shelfA, at(0));
    await raised(inA, shelfA, at(1));
    await raised(inB, shelfB, at(2));
    await raised(inB, shelfB, at(50));
    expect(await towerSummary(db, owner.actor, at(63))).toEqual({ stuck: 3, places: ["F1", "F2"] });
    const v = await towerView(db, owner.actor, at(63));
    expect(v.lanes.stuck).toHaveLength(3);
  });
});
