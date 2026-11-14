import { eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture } from "../../../../test/helpers/radiology";
import { openSessionFor, seedBillingBase } from "../../../../test/helpers/billing";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { imagingStudies, invoiceLines, invoices, opdEncounters, patients, resources } from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { createResource } from "../../../kernel/resources/registry";
import { registerEncounterResolver } from "../../../kernel/episodes/encounter-resolvers";
import { billingManifest, previewInvoice } from "../../billing";
import { activateVersion, createDraftVersion, setTariffItem, submitVersion, upsertGstCategory } from "../../tariff";
import * as radiology from "../index";
import * as money from "../money";
import { counterView } from "../counter";
import { handleOrderPlaced } from "../consumers";
import { placeImagingOrder } from "../place";
import { scheduleStudy } from "../schedule";
import { RADIOLOGY_RESOURCE_KINDS } from "../kinds";
import type { RadiologyFixture } from "../../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1078, spec docs/specs/1078-imaging-desk-counter.md (owner APPROVED 2026-11-14): the
 * imaging desk's three server acts and its slot proposal, the core half (D1–D6).
 *
 * The desk user holds exactly the five strings the spec names (`radiology.schedule`, `radiology.checkin`,
 * `radiology.bill_decisions.manage`, `billing.invoice.issue`, `billing.receipt.record`) plus the drawer's
 * own `billing.session.own`, as `radiology_receptionist` does in production, and has an open cash drawer.
 * The imaging services are priced on a real tariff version, so the invoice is billing's own.
 *
 * Every instant is written by hand and passed in; nothing here reads the clock. The acts are looked up on
 * the module's public index, so before the build each check fails on its own line, not on an import.
 */

type Fn = (...args: never[]) => Promise<unknown>;
function act<T extends Fn>(name: string): T {
  const fn = (radiology as Record<string, unknown>)[name];
  expect({ name, type: typeof fn }).toEqual({ name, type: "function" });
  return fn as T;
}

type Arrival = {
  checkedIn: { studyId: string; gates: string[] }[];
  refused: { studyId: string; code: string }[];
};
type ArriveAtDesk = (db: Db, actor: Actor, input: { encounterNo: string; now?: Date }) => Promise<Arrival>;
type CollectInput = {
  encounterNo: string;
  studyIds: string[];
  addOns?: { studyId: string; kind: "film" | "cd" }[];
  tender: { mode: "cash" | "upi" | "card"; amountPaise: number; refText?: string };
};
type CollectAtDesk = (db: Db, actor: Actor, input: CollectInput, idempotencyKey: string, now?: Date) => Promise<unknown>;
type WalkInNow = (db: Db, actor: Actor, input: { studyId: string; now?: Date }) => Promise<{ deviceResourceId: string }>;
type ProposeSlot = (db: Db, actor: Actor, input: { studyId: string; now?: Date }) =>
  Promise<{ deviceResourceId: string; scheduledAt: Date } | null>;

const DAY = "2026-08-31";
/** 11:37 IST on the fixture's service day. The next quarter hour is 06:15 UTC. */
const NOW = new Date("2026-08-31T06:07:00.000Z");
const at = (iso: string): Date => new Date(iso);
/** A second order of the same study type, placed (after the first) a day later so the 24-hour duplicate window is not the subject. */
const LATER = new Date(NOW.getTime() + 25 * 3_600_000);

const PRICES: [string, number][] = [["USG-ABDO", 120_000], ["CT-HEAD", 250_000], ["XR-CHEST", 30_000], ["MRI-BRAIN", 600_000]];
const DESK_RADIOLOGY = ["radiology.schedule", "radiology.checkin", "radiology.bill_decisions.manage"];
const DESK_BILLING = ["billing.invoice.issue", "billing.receipt.record", "billing.session.own"];

describe("spec #1078 — the imaging desk counter's server acts", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let desk: Actor;
  let unregister: () => void = () => undefined;

  jest.setTimeout(120_000);
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    const base = await seedBillingBase(db);

    /** The imaging services on a second tariff version, exempt healthcare like the house's own investigations. */
    await withTx(db, (tx) => upsertGstCategory(tx, base.drafter, {
      category: "investigation", sacCode: "999316", exempt: true, rateBps: 0, specialRule: null, thresholdPaise: null,
    }));
    const draft = await withTx(db, async (tx) => {
      const d = await createDraftVersion(tx, base.drafter, { copyFromVersionId: base.tariffVersionId });
      for (const [code, paise] of PRICES) await setTariffItem(tx, base.drafter, d.versionId, fx.services[code]!, paise);
      return d;
    });
    const submitted = await withTx(db, (tx) => submitVersion(tx, base.drafter, draft.versionId));
    await approveRequest(db, base.owner, { approvalId: submitted.approvalId, note: "imaging desk fixture" });
    await activateVersion(db, base.activator, draft.versionId, new Date("2026-02-01T00:00:00Z"));

    const registry = new ModuleRegistry();
    registry.install(billingManifest);
    registry.install({ key: "radiology", title: "Rad", menu: [], permissions: DESK_RADIOLOGY, subscriptions: [] });
    await syncPermissions(db, registry);
    await ensureRole(db, "radiology_receptionist");
    for (const p of [...DESK_RADIOLOGY, ...DESK_BILLING]) await grantPermissionToRole(db, registry, "radiology_receptionist", p);
    desk = (await mkUser(db, "desk.rani", ["radiology_receptionist"])).actor;
    await openSessionFor(db, { id: desk.id }, 0);
  });
  afterEach(() => { unregister(); unregister = () => undefined; fx.unregister(); jest.restoreAllMocks(); });

  const book = (studyId: string, device: string, when: Date) =>
    withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, { studyId, deviceResourceId: device, scheduledAt: when }));
  const study = async (studyId: string) =>
    (await db.select().from(imagingStudies).where(eq(imagingStudies.id, studyId)))[0]!;
  /** What the desk would be shown and asked to collect, priced by billing itself. */
  const quote = async (studyIds: string[]) => {
    const rows = await db.select({ id: imagingStudies.id, serviceId: imagingStudies.serviceId })
      .from(imagingStudies).where(inArray(imagingStudies.id, studyIds));
    const priced = await previewInvoice(db, {
      encounterId: fx.visitNo, lines: rows.map((r) => ({ lineId: `study-${r.id}`, serviceId: r.serviceId, qty: 1 })),
    }, NOW);
    return priced.totals.netPayablePaise;
  };
  const cash = async (studyIds: string[]): Promise<CollectInput> => ({
    encounterNo: fx.visitNo, studyIds, addOns: [], tender: { mode: "cash", amountPaise: await quote(studyIds) },
  });

  /* ─────────────────────────────── D1 ─────────────────────────────── */

  it("spec #1078 D1: arriveAtDesk checks in both of today's studies and returns each gate list; tomorrow's stays scheduled", async () => {
    const usg = await placeAndCreateStudy(db, fx, "USG-ABDO", "d1-usg", NOW);
    const ct = await placeAndCreateStudy(db, fx, "CT-HEAD", "d1-ct", NOW);
    const xr = await placeAndCreateStudy(db, fx, "XR-CHEST", "d1-xr", NOW);
    await book(usg.studyId, fx.devices.usg!, at("2026-08-31T08:00:00.000Z"));
    await book(ct.studyId, fx.devices.ct!, at("2026-08-31T09:00:00.000Z"));
    /** 11:30 IST on 1 September: the next IST day. */
    await book(xr.studyId, fx.devices.xray!, at("2026-09-01T06:00:00.000Z"));

    const arriveAtDesk = act<ArriveAtDesk>("arriveAtDesk");
    const arrival = await arriveAtDesk(db, desk, { encounterNo: fx.visitNo, now: NOW });

    const gates = Object.fromEntries(arrival.checkedIn.map((c) => [c.studyId, [...c.gates].sort()]));
    expect(gates).toEqual({
      [usg.studyId]: ["identity_two_factor"],
      [ct.studyId]: ["identity_two_factor", "pregnancy_screen"],
    });
    expect(arrival.refused).toEqual([]);
    expect((await study(usg.studyId)).status).toBe("checked_in");
    expect((await study(ct.studyId)).status).toBe("checked_in");
    expect((await study(xr.studyId)).status).toBe("scheduled");
  });

  /* ─────────────────────────────── D2 ─────────────────────────────── */

  it("spec #1078 D2: collectAtDesk for two self-pay studies issues one invoice, links both lines, and both are authorised by invoice", async () => {
    const usg = await placeAndCreateStudy(db, fx, "USG-ABDO", "d2-usg", NOW);
    const ct = await placeAndCreateStudy(db, fx, "CT-HEAD", "d2-ct", NOW);
    const collectAtDesk = act<CollectAtDesk>("collectAtDesk");

    await collectAtDesk(db, desk, await cash([usg.studyId, ct.studyId]), "d2-key", NOW);

    const issued = await db.select().from(invoices);
    expect(issued).toHaveLength(1);
    const lines = await db.select({ id: invoiceLines.id }).from(invoiceLines).where(eq(invoiceLines.invoiceId, issued[0]!.id));
    const linked = [(await study(usg.studyId)).invoiceLineId, (await study(ct.studyId)).invoiceLineId];
    expect(linked.every((l) => l !== null)).toBe(true);
    expect(new Set(linked).size).toBe(2);
    expect(linked.every((l) => lines.some((x) => x.id === l))).toBe(true);
    expect((await counterView(db, desk, usg.studyId, NOW)).authorisation).toBe("invoice");
    expect((await counterView(db, desk, ct.studyId, NOW)).authorisation).toBe("invoice");
  });

  /* ─────────────────────────────── D3 ─────────────────────────────── */

  it("spec #1078 D3: after a forced failure between issue and link, the same call with the same key leaves one invoice and both studies linked", async () => {
    const usg = await placeAndCreateStudy(db, fx, "USG-ABDO", "d3-usg", NOW);
    const ct = await placeAndCreateStudy(db, fx, "CT-HEAD", "d3-ct", NOW);
    const collectAtDesk = act<CollectAtDesk>("collectAtDesk");
    const input = await cash([usg.studyId, ct.studyId]);

    jest.spyOn(money, "linkInvoiceLine").mockRejectedValueOnce(new Error("forced: the link fell over after the issue"));
    await expect(collectAtDesk(db, desk, input, "d3-key", NOW)).rejects.toThrow("forced: the link fell over after the issue");
    jest.restoreAllMocks();

    await collectAtDesk(db, desk, input, "d3-key", NOW);

    const issued = await db.select().from(invoices);
    expect(issued).toHaveLength(1);
    const lines = await db.select({ id: invoiceLines.id }).from(invoiceLines).where(eq(invoiceLines.invoiceId, issued[0]!.id));
    const linked = [(await study(usg.studyId)).invoiceLineId, (await study(ct.studyId)).invoiceLineId];
    expect(new Set(linked).size).toBe(2);
    expect(linked.every((l) => lines.some((x) => x.id === l))).toBe(true);
  });

  /* ─────────────────────────────── D4 ─────────────────────────────── */

  it("spec #1078 D4: collectAtDesk naming a study of another patient is refused and issues no invoice", async () => {
    /** A second patient on their own visit, with a study the doctor really ordered for them. */
    const OTHER = "01PATIENT0000000000000002";
    const OTHER_VISIT = "V2608310002";
    await db.insert(patients).values({
      id: OTHER, uhid: "HMS-00000002-3", name: "Ravi Kumar", sex: "male", administrativeGender: "male",
      dob: new Date(Date.UTC(1980, 0, 1)), createdBy: "t", updatedBy: "t",
    });
    await db.insert(opdEncounters).values({
      id: newId(), visitNo: OTHER_VISIT, patientId: OTHER, status: "registered", workflowInstanceId: newId(),
      serviceDate: DAY, visitType: "new", openedBy: "t", updatedBy: "t",
    });
    fx.unregister();
    unregister = registerEncounterResolver("V", async (exec, no) => {
      const [row] = await exec.select({ patientId: opdEncounters.patientId }).from(opdEncounters).where(eq(opdEncounters.visitNo, no));
      return row === undefined ? null : { patientId: row.patientId, intendedPayer: "self" };
    });
    const placed = await placeImagingOrder(db, fx.doctor, fx.decls, {
      patientId: OTHER, encounterNo: OTHER_VISIT, serviceDate: DAY, orderingClinicianId: "dr-consultant",
      indication: "pain abdomen", items: [{ serviceId: fx.services["USG-ABDO"]! }], placedAt: NOW,
    } as never, "d4-other", NOW);
    const [theirs] = await withTx(db, (tx) => handleOrderPlaced(tx, {
      orderId: placed.orderId, orderNo: placed.orderNo, kind: "imaging", patientId: OTHER, encounterNo: OTHER_VISIT,
      groupId: placed.orderId, itemIds: placed.itemIds,
    }));
    const mine = await placeAndCreateStudy(db, fx, "CT-HEAD", "d4-mine", NOW);
    const collectAtDesk = act<CollectAtDesk>("collectAtDesk");

    await expect(collectAtDesk(db, desk, {
      encounterNo: fx.visitNo, studyIds: [mine.studyId, theirs!.studyId], addOns: [],
      tender: { mode: "cash", amountPaise: 370_000 },
    }, "d4-key", NOW)).rejects.toMatchObject({ code: "study_not_on_visit" });

    expect(await db.select().from(invoices)).toEqual([]);
    expect((await study(mine.studyId)).invoiceLineId).toBeNull();
    expect((await study(theirs!.studyId)).invoiceLineId).toBeNull();
  });

  /* ─────────────────────────────── D5 ─────────────────────────────── */

  it("spec #1078 D5: walkInNow books the first free machine and checks the study in; with no machine available it refuses and the study is unchanged", async () => {
    /** Two ultrasound machines, the first in the list busy right now. */
    const { resourceId: usg2 } = await withTx(db, (tx) => createResource(tx, fx.rso, RADIOLOGY_RESOURCE_KINDS, {
      kind: "device", code: "DEV-USG-2", name: "usg machine 2", attributes: { modality: "usg" },
    }));
    const walk = await placeAndCreateStudy(db, fx, "USG-ABDO", "d5-walk", NOW);
    const busy = await placeAndCreateStudy(db, fx, "USG-ABDO", "d5-busy", LATER);
    await book(busy.studyId, fx.devices.usg!, NOW);

    const walkInNow = act<WalkInNow>("walkInNow");
    const done = await walkInNow(db, desk, { studyId: walk.studyId, now: NOW });

    expect(done.deviceResourceId).toBe(usg2);
    const row = await study(walk.studyId);
    expect({ status: row.status, device: row.deviceResourceId, at: row.scheduledAt })
      .toEqual({ status: "checked_in", device: usg2, at: NOW });

    /** The only X-ray machine is down. */
    await db.update(resources).set({ status: "down" }).where(eq(resources.id, fx.devices.xray!));
    const xr = await placeAndCreateStudy(db, fx, "XR-CHEST", "d5-xr", NOW);
    const before = await study(xr.studyId);
    await expect(walkInNow(db, desk, { studyId: xr.studyId, now: NOW })).rejects.toMatchObject({ code: "device_unavailable" });
    expect(await study(xr.studyId)).toEqual(before);
  });

  /* ─────────────────────────────── D6 ─────────────────────────────── */

  it("spec #1078 D6: proposeSlot skips an occupied slot and an unlicensed ionising machine", async () => {
    /** A CT that sorts ahead of the licensed one and has no AERB licence on file. */
    await withTx(db, (tx) => createResource(tx, fx.rso, RADIOLOGY_RESOURCE_KINDS, {
      kind: "device", code: "DEV-AA-CT", name: "ct machine, unlicensed", attributes: { modality: "ct" },
    }));
    /** The licensed CT is busy 06:15–06:35 UTC (a 20-minute block). */
    const ct = await placeAndCreateStudy(db, fx, "CT-HEAD", "d6-ct", NOW);
    const busy = await placeAndCreateStudy(db, fx, "CT-HEAD", "d6-busy", LATER);
    await book(busy.studyId, fx.devices.ct!, at("2026-08-31T06:15:00.000Z"));

    const proposeSlot = act<ProposeSlot>("proposeSlot");
    const proposal = await proposeSlot(db, desk, { studyId: ct.studyId, now: NOW });

    expect(proposal).toMatchObject({ deviceResourceId: fx.devices.ct, scheduledAt: at("2026-08-31T06:45:00.000Z") });
    /** A proposal books nothing. */
    expect((await study(ct.studyId)).scheduledAt).toBeNull();
  });
});
