import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { issuePaidInvoice, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { idempotencyKeys, imagingStudies, invoices, opdEncounters, phiAccessLog, resources } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { approveRequest } from "../../kernel/approvals/decisions";
import { billingManifest, previewInvoice } from "../billing";
import { activateVersion, createDraftVersion, setTariffItem, submitVersion, upsertGstCategory } from "../tariff";
import { DESK_COLLECT_ROUTE, arriveAtDesk, collectAtDesk, deskVisitsToday, proposeSlot, walkInNow } from "./desk";
import { scheduleStudy } from "./schedule";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { DeskCollectInput } from "./desk";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * #1078 (IM2) — the imaging desk's acts beyond the spec's done-means (those are
 * `acceptance/imaging-desk-counter-1078.test.ts`): a replay after success charges nothing, an earlier
 * bill is linked rather than charged twice, the amount the desk showed is checked, a paid study is not
 * the desk's to bill, each act checks its own permissions, one refusal at arrival does not stop the
 * others, and the door's visit read. Every instant is passed in.
 */
const DAY = "2026-08-31";
const NOW = new Date("2026-08-31T06:07:00.000Z");
const PRICES: [string, number][] = [["USG-ABDO", 120_000], ["CT-HEAD", 250_000], ["XR-CHEST", 30_000], ["MRI-BRAIN", 600_000]];
const DESK_RADIOLOGY = ["radiology.schedule", "radiology.checkin", "radiology.bill_decisions.manage"];
const DESK_BILLING = ["billing.invoice.issue", "billing.receipt.record", "billing.session.own"];

describe("the imaging desk's server acts (#1078)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let desk: Actor;
  let registry: ModuleRegistry;

  jest.setTimeout(120_000);
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    const base = await seedBillingBase(db);
    await withTx(db, (tx) => upsertGstCategory(tx, base.drafter, {
      category: "investigation", sacCode: "999316", exempt: true, rateBps: 0, specialRule: null, thresholdPaise: null,
    }));
    const draft = await withTx(db, async (tx) => {
      const d = await createDraftVersion(tx, base.drafter, { copyFromVersionId: base.tariffVersionId });
      for (const [code, paise] of PRICES) await setTariffItem(tx, base.drafter, d.versionId, fx.services[code]!, paise);
      return d;
    });
    const submitted = await withTx(db, (tx) => submitVersion(tx, base.drafter, draft.versionId));
    await approveRequest(db, base.owner, { approvalId: submitted.approvalId, note: "desk fixture" });
    await activateVersion(db, base.activator, draft.versionId, new Date("2026-02-01T00:00:00Z"));

    registry = new ModuleRegistry();
    registry.install(billingManifest);
    registry.install({ key: "radiology", title: "Rad", menu: [], permissions: DESK_RADIOLOGY, subscriptions: [] });
    await syncPermissions(db, registry);
    await ensureRole(db, "radiology_receptionist");
    for (const p of [...DESK_RADIOLOGY, ...DESK_BILLING]) await grantPermissionToRole(db, registry, "radiology_receptionist", p);
    desk = (await mkUser(db, "desk.rani", ["radiology_receptionist"])).actor;
    await openSessionFor(db, { id: desk.id }, 0);
  });
  afterEach(() => { fx.unregister(); });

  const study = async (id: string) => (await db.select().from(imagingStudies).where(eq(imagingStudies.id, id)))[0]!;
  const priceOf = async (serviceIds: string[]) => (await previewInvoice(db, {
    encounterId: fx.visitNo, lines: serviceIds.map((serviceId, i) => ({ lineId: `l${String(i)}`, serviceId, qty: 1 })),
  }, NOW)).totals.netPayablePaise;
  const cashFor = async (studyIds: string[], codes: string[]): Promise<DeskCollectInput> => ({
    encounterNo: fx.visitNo, studyIds, addOns: [],
    tender: { mode: "cash", amountPaise: await priceOf(codes.map((c) => fx.services[c]!)) },
  });

  it("a replay of a collect that succeeded charges nothing new and answers the same invoice", async () => {
    const s = await placeAndCreateStudy(db, fx, "USG-ABDO", "r1", NOW);
    const input = await cashFor([s.studyId], ["USG-ABDO"]);
    const first = await collectAtDesk(db, desk, input, "replay-key", NOW);
    const again = await collectAtDesk(db, desk, input, "replay-key", NOW);
    expect(again).toMatchObject({ invoiceId: first.invoiceId, invoiceNo: first.invoiceNo, adopted: false });
    expect(await db.select().from(invoices)).toHaveLength(1);
    expect((await study(s.studyId)).invoiceLineId).toBe(first.linked[0]!.invoiceLineId);
    expect(first).toMatchObject({ totalPaise: 120_000, receiptNo: expect.any(String) as unknown });
  });

  it("a FRESH key for a study already paid is refused `not_collectable`, and nothing is issued or held", async () => {
    const s = await placeAndCreateStudy(db, fx, "USG-ABDO", "r2", NOW);
    const input = await cashFor([s.studyId], ["USG-ABDO"]);
    await collectAtDesk(db, desk, input, "k-1", NOW);
    await expect(collectAtDesk(db, desk, input, "k-2", NOW)).rejects.toMatchObject({ code: "not_collectable" });
    expect(await db.select().from(invoices)).toHaveLength(1);
    /** The refused attempt leaves no claim behind (billing's own rule), so a corrected retry is not stranded. */
    expect((await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.route, DESK_COLLECT_ROUTE))).map((k) => k.key))
      .toEqual(["k-1"]);
  });

  it("an earlier bill at the main counter already charges the study: its line is linked and nothing is collected", async () => {
    const s = await placeAndCreateStudy(db, fx, "CT-HEAD", "r3", NOW);
    const earlier = await issuePaidInvoice(db, { id: desk.id, actor: desk }, {
      patientId: fx.patientId, serviceId: fx.services["CT-HEAD"]!, encounterId: fx.visitNo,
    }, NOW);
    const done = await collectAtDesk(db, desk, await cashFor([s.studyId], ["CT-HEAD"]), "k-adopt", NOW);
    expect(done).toMatchObject({ adopted: true, invoiceId: earlier.invoiceId, totalPaise: 0, receiptNo: null });
    expect(await db.select().from(invoices)).toHaveLength(1);
    expect((await study(s.studyId)).invoiceLineId).toBe(done.linked[0]!.invoiceLineId);
  });

  it("the amount the desk showed must be billing's price: otherwise `price_changed`, before anything is issued", async () => {
    const s = await placeAndCreateStudy(db, fx, "USG-ABDO", "r4", NOW);
    await expect(collectAtDesk(db, desk, {
      encounterNo: fx.visitNo, studyIds: [s.studyId], addOns: [], tender: { mode: "cash", amountPaise: 100_000 },
    }, "k-price", NOW)).rejects.toMatchObject({ code: "price_changed", detail: { netPayablePaise: 120_000 } });
    expect(await db.select().from(invoices)).toEqual([]);
  });

  it("a film the tariff does not carry is refused `not_collectable`", async () => {
    const s = await placeAndCreateStudy(db, fx, "USG-ABDO", "r5", NOW);
    await expect(collectAtDesk(db, desk, {
      ...(await cashFor([s.studyId], ["USG-ABDO"])), addOns: [{ studyId: s.studyId, kind: "film" }],
    }, "k-film", NOW)).rejects.toMatchObject({ code: "not_collectable" });
    expect(await db.select().from(invoices)).toEqual([]);
  });

  it("each act checks its own permissions: a desk without the link permission collects nothing", async () => {
    const s = await placeAndCreateStudy(db, fx, "USG-ABDO", "r6", NOW);
    await ensureRole(db, "cashier_only");
    for (const p of DESK_BILLING) await grantPermissionToRole(db, registry, "cashier_only", p);
    const cashier = (await mkUser(db, "cash.only", ["cashier_only"])).actor;
    await openSessionFor(db, { id: cashier.id }, 0);
    await expect(collectAtDesk(db, cashier, await cashFor([s.studyId], ["USG-ABDO"]), "k-perm", NOW))
      .rejects.toMatchObject({ code: "forbidden", detail: { permission: "radiology.bill_decisions.manage" } });
    await expect(arriveAtDesk(db, cashier, { encounterNo: fx.visitNo, now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    await expect(walkInNow(db, cashier, { studyId: s.studyId, now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    await expect(proposeSlot(db, cashier, { studyId: s.studyId, now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    expect(await db.select().from(invoices)).toEqual([]);
  });

  it("arrival: a study that refuses is reported and the visit's other study is still checked in", async () => {
    const good = await placeAndCreateStudy(db, fx, "USG-ABDO", "r7", NOW);
    const bad = await placeAndCreateStudy(db, fx, "CT-HEAD", "r8", NOW);
    for (const [s, dev, at] of [[good, fx.devices.usg!, "08:00"], [bad, fx.devices.ct!, "09:00"]] as const) {
      await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
        studyId: s.studyId, deviceResourceId: dev, scheduledAt: new Date(`${DAY}T${at}:00.000Z`),
      }));
    }
    /** The book no longer carries the type: check-in cannot derive the gate set and refuses. */
    await db.update(imagingStudies).set({ studyTypeCode: "CT-GONE" }).where(eq(imagingStudies.id, bad.studyId));
    const arrival = await arriveAtDesk(db, desk, { encounterNo: fx.visitNo, now: NOW });
    expect(arrival.checkedIn.map((c) => c.studyId)).toEqual([good.studyId]);
    expect(arrival.refused).toEqual([expect.objectContaining({ studyId: bad.studyId, code: "unknown_study_type" })]);
    expect((await study(good.studyId)).status).toBe("checked_in");
    expect((await study(bad.studyId)).status).toBe("scheduled");
  });

  it("proposeSlot answers null when no machine of the modality is available, and books nothing", async () => {
    const s = await placeAndCreateStudy(db, fx, "MRI-BRAIN", "r9", NOW);
    await db.update(resources).set({ status: "down" }).where(eq(resources.id, fx.devices.mri!));
    expect(await proposeSlot(db, desk, { studyId: s.studyId, now: NOW })).toBeNull();
  });

  it("proposeSlot on an idle machine is the next quarter hour", async () => {
    const s = await placeAndCreateStudy(db, fx, "USG-ABDO", "r10", NOW);
    expect(await proposeSlot(db, desk, { studyId: s.studyId, now: NOW }))
      .toMatchObject({ deviceResourceId: fx.devices.usg, code: "DEV-USG", scheduledAt: new Date("2026-08-31T06:15:00.000Z") });
  });

  it("the door's visit read: this patient's visits of the IST day, logged once for the desk", async () => {
    const visits = await deskVisitsToday(db, desk, { patientId: fx.patientId, now: NOW });
    expect(visits.map((v) => v.encounterNo)).toEqual([fx.visitNo]);
    expect(await deskVisitsToday(db, desk, { patientId: fx.patientId, now: new Date("2026-09-01T06:00:00.000Z") })).toEqual([]);
    const logged = await db.select().from(phiAccessLog).where(eq(phiAccessLog.patientId, fx.patientId));
    expect(logged.map((r) => r.surface)).toEqual(["imaging.worklist"]);
    expect((await db.select().from(opdEncounters))).toHaveLength(1);
  });
});
