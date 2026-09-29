import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { MON, seedPharmacyBase } from "../../../test/helpers/pharmacy";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { formularySalts, pharmacyPharmacistRegistrations } from "../../kernel/db/schema";
import { eq } from "drizzle-orm";
import { recordAdr } from "./adr";
import { recordIncident } from "./incidents";
import { createStore } from "../materials";
import { RETAIL_PHARMACY_STORE_CODE } from "./config";
import { NEED_SOURCES, buildNeeds, officeNeeds } from "./office-needs";
import type { NeedInputs } from "./office-needs";
import type { ControlledToday } from "./controlled-office";
import type { OfficePay, OfficeReturns, OfficeToday } from "./office";
import type { PharmacistView } from "./pharmacists";
import type { RetailLicenceState } from "./retail";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ GAP-CLOSURE B2 — THE OFFICE'S ONE RANKED LIST ═══
 *
 * `buildNeeds` is pure: every side's rows and the ranking are tested on the office's own shapes, one
 * side per source. `officeNeeds` on a real database proves the permission rule — a side the person does
 * not hold is ABSENT, and a person holding none gets an empty list rather than a refusal.
 */
const NOW = new Date("2026-09-28T06:10:00.000Z"); // 11:40 IST, Mon 28 Sep 2026

const po = (over: Record<string, unknown>) => ({
  id: "po-1", poNo: "PO-2026-014", status: "pending_approval", source: "manual", vendorId: "v1", vendorCode: "MED", vendorName: "Medplus Distributors",
  storeResourceId: "s", storeCode: "PHARM-OPD", expectedDate: "2026-09-30", subtotalPaise: 0, gstPaise: 0, totalPaise: 11_280_000, lineCount: 9,
  approvalId: "a", approvalTier: "owner", rejectionNote: null, createdBy: "u", createdAt: "2026-09-28T03:40:00.000Z", submittedAt: "2026-09-28T03:40:00.000Z",
  approvedBy: null, approvedAt: null, ...over,
});
const bill = (over: Record<string, unknown>) => ({
  id: "b1", billNo: "MSB2609020004", status: "accepted", vendorId: "v", vendorCode: "SUN", vendorName: "Sun Pharma Distributors", msme: true,
  vendorBillNo: "SP/991", billDate: "2026-08-19", fy: "2026-27", purchaseOrderId: null, interState: false, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0,
  igstPaise: 0, roundOffPaise: 0, totalPaise: 9_240_000, expectedTotalPaise: 9_240_000, paidPaise: 0, outstandingPaise: 9_240_000, heldReason: null,
  acceptanceDate: "2026-08-19", dueDate: "2026-10-02", differenceReason: null, createdBy: "u", createdAt: "2026-08-19T05:00:00.000Z", acceptedBy: null, acceptedAt: null,
  ageDays: 40, bucket: "31-45", overdueDays: 0, reservedPaise: 0, ...over,
});

const BUY = {
  awaitingYou: [po({})], drafts: [po({ id: "po-2", poNo: "PO-2026-015", status: "draft", source: "agent" })], waiting: [],
  toReceive: [po({ id: "po-3", poNo: "PO-2026-011", status: "part_received" })], overdue: [],
  shortages: [{ id: "sb", drugName: "Montair LC", itemId: null, qtyWanted: 30, notedAt: "2026-09-27T05:00:00.000Z", notedByName: "ph", storeResourceId: "s", status: "open" }],
  plan: { orders: 2, lines: 13, unassigned: 0, unmatched: 0, alreadyDrafted: 0 },
} as unknown as OfficeToday;

const PAY = {
  toMatch: [], drafts: [], matched: [],
  held: [bill({ id: "b9", billNo: "MSB2609270004", status: "held_for_match", vendorName: "Anand Medical Agencies", msme: false, totalPaise: 4_821_200, expectedTotalPaise: 4_700_000, createdAt: "2026-09-27T05:00:00.000Z" })],
  dueThisWeek: [bill({}), bill({ id: "b2", billNo: "MSB2609030011", vendorName: "Medplus Distributors", outstandingPaise: 5_860_000, dueDate: "2026-10-03" }),
    bill({ id: "b3", billNo: "MSB2609100001", vendorName: "Cipla", msme: false, outstandingPaise: 100_000, dueDate: "2026-10-01" })],
  overdue: [],
  runs: [{ id: "r1", runNo: "MPR2609280001", status: "pending_authorisation", source: "agent", totalPaise: 17_585_000, vendorCount: 3, billCount: 3, approvalId: "x",
    rejectionNote: null, createdBy: "u", createdAt: "2026-09-28T04:00:00.000Z", submittedAt: "2026-09-28T04:10:00.000Z", authorisedBy: null, authorisedAt: null, completedAt: null }],
  outstandingPaise: 0, overduePaise: 0,
  plan: { vendors: 3, bills: 3, totalPaise: 17_585_000, blocked: 0, until: "2026-10-04", creditPaise: 845_000, covered: 0 },
} as unknown as OfficePay;

const RETURNS = {
  expiring: { expired: 0, d30: 2, d60: 6, d90: 14, expiredValuePaise: 0, d30ValuePaise: 1, d60ValuePaise: 1, d90ValuePaise: 2_390_000 },
  plan: { vendors: 3, lines: 9, taxablePaise: 1_470_000, toDestroy: 5, toDestroyValuePaise: 920_000 },
  drafts: [], toDispatch: [], writeOffsAwaiting: [], writeOffsToPost: [], openRecalls: [], creditPaise: 0,
  awaitingCredit: [{ id: "ret1", returnNo: "MRT1", status: "dispatched", source: "agent", vendorId: "v", vendorCode: "CIP", vendorName: "Cipla", recallId: null, lineCount: 4,
    interState: false, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 845_000, creditedPaise: 0, debitNoteNo: "MDN2609150002", debitNoteDate: "2026-09-15",
    createdBy: "u", createdAt: "2026-09-14T05:00:00.000Z", approvedBy: "h", approvedAt: "x", dispatchedBy: "p", dispatchedAt: "2026-09-15T05:00:00.000Z" }],
} as unknown as OfficeReturns;

const RETAIL: RetailLicenceState = {
  storeCode: "PHARM-RETAIL", storePresent: true, state: "current", daysLeft: 6,
  licence: { id: "lic", form20No: "F20-RJ-2231", form21No: "F21-RJ-2231", validFrom: "2021-10-05", validTo: "2026-10-04", pharmacistInCharge: "K Joshi", note: null, recordedBy: "o", recordedAt: "x" },
};

const CABINET = {
  storePresent: true, storeId: "nd", checkedToday: null, discrepancies: [], custodianPairHeld: true,
  pending: { grns: [], transfers: [], writeOffs: [], adjustments: [] },
  licences: {
    ndps_rmi: { kind: "ndps_rmi", name: "RMI", state: "current", daysLeft: 211, renewalDue: false, licence: null },
    schedule_x: { kind: "schedule_x", name: "X", state: "current", daysLeft: 40, renewalDue: true,
      licence: { id: "x1", kind: "schedule_x", licenceNo: "20F-77", form: "20F", issuingAuthority: "FDA", holderName: "H", responsiblePerson: "K Joshi",
        validFrom: "2021-11-07", validUntil: "2026-11-07", documentRef: null, note: null, recordedBy: "o", recordedAt: "x" } },
  },
  needsYou: [{ key: "licence_renewal", params: { name: "X", until: "2026-11-07", days: 40 } }, { key: "checkNotDone", params: { day: "2026-09-28" } }],
} as unknown as ControlledToday;

const PHARMACISTS = [
  { userId: "u-kj", username: "kavita.joshi", fullName: "Kavita Joshi", active: true, renewalDueInDays: null, history: [],
    current: { id: "r", userId: "u-kj", council: "Rajasthan Pharmacy Council", registrationNo: "TRIAL-KJ-0001", validUntil: null, recordedBy: "o", recordedAt: new Date(), endedAt: null, endedBy: null, endReason: null } },
  { userId: "u-ok", username: "ph.ok", fullName: "Fine", active: true, renewalDueInDays: null, history: [],
    current: { id: "r2", userId: "u-ok", council: "RPC", registrationNo: "RPC-1234", validUntil: "2027-06-30", recordedBy: "o", recordedAt: new Date(), endedAt: null, endedBy: null, endReason: null } },
] as unknown as PharmacistView[];

const GRNS = [
  { id: "g1", grnNo: "GRN2609280001", challanNo: "OPENING/3fa9c01b2e", vendorName: "Opening stock", lines: 120, createdAt: "2026-09-28T03:00:00.000Z" },
  { id: "g2", grnNo: "GRN2609280002", challanNo: "OPENING/3fa9c01b2e", vendorName: "Opening stock", lines: 92, createdAt: "2026-09-28T03:05:00.000Z" },
  { id: "g3", grnNo: "GRN2609270009", challanNo: "CH-5561", vendorName: "Anand Medical Agencies", lines: 7, createdAt: "2026-09-27T09:00:00.000Z" },
];

const ALL: NeedInputs = { buy: BUY, pay: PAY, returns: RETURNS, grns: GRNS, retail: RETAIL, cabinet: CABINET, pharmacists: PHARMACISTS, adr: null, incidents: null, cold: null, steward: null };

/** Stage D1 — three reports not yet sent to PvPI: serious and 20 days old, serious and 3 days old, not serious and 30 days old. */
const ADR: NonNullable<NeedInputs["adr"]> = [
  { id: "adr-late", no: "ADR-000001", seriousness: "hospitalisation", onsetDate: "2026-09-06", createdAt: "2026-09-08T05:00:00.000Z", suspects: ["Augmentin 625"] },
  { id: "adr-new", no: "ADR-000002", seriousness: "life_threatening", onsetDate: "2026-09-24", createdAt: "2026-09-25T05:00:00.000Z", suspects: ["Ceftriaxone 1 g", "Diclofenac 75"] },
  { id: "adr-mild", no: "ADR-000003", seriousness: "not_serious", onsetDate: "2026-08-28", createdAt: "2026-08-29T05:00:00.000Z", suspects: ["Metformin 500"] },
];

describe("buildNeeds — the office's one ranked list (gap-closure B2)", () => {
  it("has at least one row from every source, each with a clock, a ref and its facts", () => {
    const { rows, sides } = buildNeeds(ALL, NOW);
    expect(sides).toEqual([...NEED_SOURCES]);
    for (const s of NEED_SOURCES) expect({ s, n: rows.filter((r) => r.source === s).length > 0 }).toEqual({ s, n: true });
    const byKind = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byKind["law:retail"]).toMatchObject({ kind: "retail_licence_lapsing", clock: { code: "days_left", n: 6, tone: "rd" }, ref: { kind: "retailLicence", id: "lic" } });
    expect(byKind["pay:msme"]).toMatchObject({ kind: "pay_msme_due", params: { count: 2, total: 15_100_000, days: 4 }, clock: { code: "days_left", n: 4, tone: "gd" } });
    // The MSME row nets the copilot's credit, as the board's run does.
    expect(byKind["pay:msme"]!.facts.slice(-2)).toEqual([{ k: "lessCredit", v: -845_000, as: "money" }, { k: "payable", v: 14_255_000, as: "money" }]);
    expect(byKind["buy:po:po-1"]).toMatchObject({ kind: "po_approve", clock: { code: "waited", n: 150 }, ref: { kind: "po", id: "po-1" } });
    expect(byKind["pay:bill:b9"]).toMatchObject({ kind: "bill_held", params: { over: 121_200 } });
    expect(byKind["return:ret1"]).toMatchObject({ kind: "credit_awaited", clock: { code: "days_ago", n: 13 } });
    expect(byKind["stock:expiry"]).toMatchObject({ kind: "expiry", params: { count: 14, returnable: 9, destroy: 5 } });
    expect(byKind["people:u-kj"]).toMatchObject({ kind: "pharmacist_trial", params: { no: "TRIAL-KJ-0001" } });
    expect(byKind["people:u-ok"]).toBeUndefined();
    // The opening-stock sheet's two GRNs are ONE row; a delivery's GRN is its own.
    expect(byKind["stock:opening:OPENING/3fa9c01b2e"]).toMatchObject({ kind: "opening_qc", params: { count: 2, lines: 212 }, ref: { kind: "grn", id: "g1" } });
    expect(byKind["stock:grn:g3"]).toMatchObject({ kind: "grn_qc", clock: { code: "days_ago", n: 1 } });
    expect(byKind["law:cabinet:schedule_x"]).toMatchObject({ kind: "cabinet_licence_renewal", params: { licence: "schedule_x", days: 40 } });
  });

  it("ranks law lapses and money deadlines first, then what waits on this person, then the rest", () => {
    const ids = buildNeeds(ALL, NOW).rows.map((r) => r.id);
    expect(ids.slice(0, 5)).toEqual(["law:retail", "law:cabinet:schedule_x", "pay:msme", "buy:po:po-1", "pay:run:r1"]);
    const at = (id: string): number => ids.indexOf(id);
    expect(at("pay:bill:b9")).toBeLessThan(at("return:ret1"));
    expect(at("return:ret1")).toBeLessThan(at("stock:expiry"));
    expect(at("stock:expiry")).toBeLessThan(at("people:u-kj"));
    expect(at("people:u-kj")).toBeLessThan(at("stock:opening:OPENING/3fa9c01b2e"));
    expect(ids.at(-1)).toBe("buy:shortages");
  });

  it("a lapsed or missing licence outranks one lapsing, and overdue money outranks money due", () => {
    const lapsed = buildNeeds({ ...ALL, retail: { ...RETAIL, state: "lapsed", daysLeft: -2 },
      pay: { ...PAY, overdue: [bill({ id: "late", billNo: "MSB2607010001", overdueDays: 12, dueDate: "2026-09-16" })] } as OfficePay }, NOW).rows.map((r) => [r.id, r.kind]);
    expect(lapsed.slice(0, 4)).toEqual([
      ["law:retail", "retail_licence_lapsed"], ["law:cabinet:schedule_x", "cabinet_licence_renewal"], ["pay:overdue", "pay_overdue"], ["pay:msme", "pay_msme_due"],
    ]);
    const missing = buildNeeds({ ...ALL, retail: { ...RETAIL, state: "missing", licence: null, daysLeft: null } }, NOW).rows[0]!;
    expect(missing).toMatchObject({ id: "law:retail", kind: "retail_licence_missing", clock: { code: "missing", tone: "rd" } });
  });

  it("a side not read is absent — no rows, not listed, no money pill, no copilot plan", () => {
    const out = buildNeeds({ ...ALL, pay: null, buy: null }, NOW);
    expect(out.rows.some((r) => r.source === "PAY" || r.source === "BUY")).toBe(false);
    expect(out.sides).toEqual(["RETURN", "STOCK", "LAW", "PEOPLE"]);
    expect(out.money).toBeNull();
    expect(out.copilot).toEqual({ po: null, pay: null, returns: RETURNS.plan });
  });
});

describe("buildNeeds — the ADR side of LAW (pharmacy stage D1)", () => {
  it("a serious ADR past PvPI's 15 days is red and first; inside them it counts down; a non-serious one waits with the rest", () => {
    const out = buildNeeds({ ...ALL, adr: ADR }, NOW);
    const byId = Object.fromEntries(out.rows.map((r) => [r.id, r]));
    expect(byId["law:adr:adr-late"]).toMatchObject({ source: "LAW", kind: "adr_pvpi_overdue", clock: { code: "days_late", n: 5, tone: "rd" }, ref: { kind: "adr", id: "adr-late" }, tier: 0 });
    expect(byId["law:adr:adr-new"]).toMatchObject({ kind: "adr_pvpi_serious", clock: { code: "days_left", n: 12, tone: "gd" }, tier: 1, params: { no: "ADR-000002", drugs: "Ceftriaxone 1 g · Diclofenac 75" } });
    expect(byId["law:adr:adr-mild"]).toMatchObject({ kind: "adr_pvpi", clock: { code: "days_ago", n: 30, tone: "no" }, tier: 5 });
    expect(out.rows[0]!.id).toBe("law:adr:adr-late");
    // Codes and drug names only: no patient on the office list.
    expect(JSON.stringify(byId["law:adr:adr-late"])).not.toMatch(/patient|uhid/i);
  });

  it("the ADR side alone is enough to list LAW", () => {
    const out = buildNeeds({ buy: null, pay: null, returns: null, grns: null, retail: null, cabinet: null, pharmacists: null, adr: [], incidents: null, cold: null, steward: null }, NOW);
    expect(out.sides).toEqual(["LAW"]);
    expect(out.rows).toEqual([]);
  });
});

describe("officeNeeds — each side only under its own grant (gap-closure B2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await withTx(db, (tx) => createStore(tx, { type: "user", id: "01HMATERIALSHEAD00000000001" }, { code: RETAIL_PHARMACY_STORE_CODE, name: "Walk-in retail pharmacy" }));
    // A pharmacist on a trial number — the PEOPLE side's row.
    await db.insert(pharmacyPharmacistRegistrations).values({
      id: newId(), userId: fx.incharge.id, council: "Rajasthan Pharmacy Council", registrationNo: "TRIAL-KJ-0001", validUntil: null, recordedBy: fx.pharmacist.id, recordedAt: MON,
    });
  });
  afterEach(() => { fx.unregister(); });

  it("somebody holding none of the sides' grants gets an empty list, not a refusal", async () => {
    const out = await officeNeeds(db, fx.clerk.actor, NOW);
    expect(out).toEqual({ rows: [], sides: [], money: null, copilot: { po: null, pay: null, returns: null } });
  });

  it("the pharmacist sees PEOPLE and the cabinet's LAW, and no BUY, PAY, RETURN or the retail licence they do not manage", async () => {
    const out = await officeNeeds(db, fx.pharmacist.actor, NOW);
    expect(out.sides).toEqual(["LAW", "PEOPLE"]);
    expect(out.rows.find((r) => r.source === "PEOPLE")).toMatchObject({ kind: "pharmacist_trial", params: { no: "TRIAL-KJ-0001" } });
    expect(out.rows.some((r) => r.id === "law:retail")).toBe(false);
    expect(out.rows.some((r) => ["BUY", "PAY", "RETURN", "STOCK"].includes(r.source))).toBe(false);
  });

  it("pharmacy.adr.manage brings the ADR side: a report not sent to PvPI is a LAW row; the pharmacist without it sees none (stage D1)", async () => {
    await grantPermissionToRole(db, fx.registry, "pharmacy", "pharmacy.adr.record");
    const saltRow = (await db.select({ id: formularySalts.id }).from(formularySalts).where(eq(formularySalts.name, "Paracetamol")))[0]!;
    const { reportId } = await recordAdr(db, fx.pharmacist.actor, {
      patientId: fx.patient.id, reaction: "Rash", onsetDate: "2026-09-26", seriousness: "hospitalisation", outcome: "recovering",
      dechallenge: "yes", rechallenge: "na", suspects: [{ saltId: saltRow.id }],
    }, NOW);
    await ensureRole(db, "adr_manager");
    await grantPermissionToRole(db, fx.registry, "adr_manager", "pharmacy.adr.manage");
    const ms = await mkUser(db, "the.ms", ["adr_manager"]);
    const out = await officeNeeds(db, ms.actor, NOW);
    expect(out.sides).toEqual(["LAW"]);
    expect(out.rows.map((r) => [r.id, r.kind])).toEqual([[`law:adr:${reportId}`, "adr_pvpi_serious"]]);
    expect((await officeNeeds(db, fx.pharmacist.actor, NOW)).rows.some((r) => r.id.startsWith("law:adr:"))).toBe(false);
  });

  it("pharmacy.incidents.review brings the incident side: an unreviewed near miss is a LAW row; a recorder without review sees none (stage D2)", async () => {
    await grantPermissionToRole(db, fx.registry, "pharmacy", "pharmacy.incidents.record");
    const { incidentId } = await recordIncident(db, fx.pharmacist.actor, {
      kind: "near_miss", stage: "dispensing", type: "wrong_strength", category: "B", whatHappened: "650 picked for 500; caught at the check",
    }, NOW);
    await ensureRole(db, "incident_reviewer");
    await grantPermissionToRole(db, fx.registry, "incident_reviewer", "pharmacy.incidents.review");
    const ms = await mkUser(db, "the.reviewer", ["incident_reviewer"]);
    const out = await officeNeeds(db, ms.actor, NOW);
    expect(out.sides).toEqual(["LAW"]);
    expect(out.rows.map((r) => [r.id, r.kind])).toEqual([[`law:incident:${incidentId}`, "incident_review"]]);
    expect((await officeNeeds(db, fx.pharmacist.actor, NOW)).rows.some((r) => r.id.startsWith("law:incident:"))).toBe(false);
  });

  it("the grant that manages the retail licence brings its row, ranked first while no licence is on file", async () => {
    await ensureRole(db, "retail_owner");
    await grantPermissionToRole(db, fx.registry, "retail_owner", "pharmacy.retail.manage");
    const owner = await mkUser(db, "the.owner", ["retail_owner"]);
    const out = await officeNeeds(db, owner.actor, NOW);
    expect(out.sides).toEqual(["LAW"]);
    expect(out.rows.map((r) => [r.id, r.kind])).toEqual([["law:retail", "retail_licence_missing"]]);
  });
});
