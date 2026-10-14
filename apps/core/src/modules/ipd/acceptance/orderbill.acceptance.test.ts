import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  imagingBillDecisions, imagingStudies, invoices, ipdAdmissions, ipdChargeExceptions, ipdChargeLines, ipdDepositAlerts, ipdFinalBills,
  labAnalytes, labItems, labReflexRules, orderItems, patients, services,
} from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { collectOrderKinds } from "../../../kernel/orders/kinds";
import { ordersManifest } from "../../../kernel/orders/manifest";
import { ORDERS_PLACE } from "../../../kernel/orders/place";
import { createResource } from "../../../kernel/resources/registry";
import { activateDefinition, approveDefinition, createDraft } from "../../../kernel/workflow/definitions";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkRoundsWorld } from "../../../../test/helpers/ipd";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { seedActiveStudyTypes, studyTypeRow } from "../../../../test/helpers/radiology";
import { seedLabCatalogue, serviceIdForLabCode } from "../../../../scripts/seed-lab-catalogue";
import { activateVersion, createDraftVersion, setTariffItem, submitVersion, upsertGstCategory } from "../../tariff";
import {
  activateLabDefinitions, cancelLabItem, collect, deskOrder, enterResult, labManifest, previewDeskOrder, printLabels, receive, verifyResult,
} from "../../lab";
import { issueInvoice, setFeeSwitch } from "../../billing";
import {
  RADIOLOGY_RESOURCE_KINDS, RADIOLOGY_WORKFLOW_DEFINITIONS, cancelStudy, checkIn, evaluateReadiness, handleOrderPlaced,
  radiologyManifest, recordAcquired, requireStudyGate, satisfyGate, scheduleStudy, startAcquisition,
} from "../../radiology";
import { orderTests } from "../../ordering";
import {
  IpdRefusal, composeFinalBill, depositPosition, keepOrderCharge, lockIpdOrderStanding, placeIpOrder, postIpdOrderCharges, readBillDesk,
  readInterimBill, registerIpdEncounterResolver, registerIpdOrderChargeSink, retryFromBillDesk, reverseChargeLine,
} from "../index";
import { ipdManifest } from "../manifest";
import type { Db } from "../../../kernel/db/client";
import type { OrderKindDecl } from "../../../kernel/orders/kinds";
import type { RoundsWorld } from "../../../../test/helpers/ipd";
import type { Actor } from "@hmis/contracts";

/**
 * #785 — LAB AND IMAGING ORDERS ON THE IPD RUNNING BILL. Each `it` is one "done means" of the issue, against the REAL lab
 * and radiology departments (no door stub). Explicit IST instants; the tariff version every admission here locks is the
 * one this suite activates on 2026-01-04 (lab tests ₹300, imaging ₹800 / ₹2,500). 2026-03-11 is a Wednesday.
 */
jest.setTimeout(300_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = () => randomUUID();
const LAB_PRICE = 30_000;
const USG_PRICE = 80_000;
const MRI_PRICE = 250_000;

type World = RoundsWorld & {
  decls: OrderKindDecl[];
  labDesk: Actor;
  bench: Actor;
  pathologist: Actor;
  radiographer: Actor;
  usg: string; mri: string; ct: string;
  usgDevice: string;
};

async function mkOrderBillWorld(db: Db): Promise<World> {
  const w = await mkRoundsWorld(db);
  const registry = new ModuleRegistry();
  registry.install(ordersManifest);
  registry.install(labManifest);
  registry.install(radiologyManifest);
  registry.install(ipdManifest);
  await syncPermissions(db, registry);
  await grantPermissionToRole(db, registry, "t_bill_desk", "ipd.billdesk.view");
  for (const p of [ORDERS_PLACE, "lab.orders.place", "radiology.orders.place"]) await grantPermissionToRole(db, registry, "doctor", p);
  for (const role of ["lab_reception", "lab_technician", "phlebotomist", "radiographer"]) await ensureRole(db, role);
  for (const p of [ORDERS_PLACE, "lab.orders.place", "lab.desk.operate", "orders.cancel", "lab.collection.operate", "lab.accession.operate", "lab.catalogue.manage", "lab.catalogue.read"]) {
    await grantPermissionToRole(db, registry, "lab_reception", p);
  }
  for (const p of ["lab.collection.operate", "lab.accession.operate", "orders.read"]) {
    await grantPermissionToRole(db, registry, "lab_technician", p);
    await grantPermissionToRole(db, registry, "phlebotomist", p);
  }
  for (const role of ["pathologist"]) await ensureRole(db, role);
  for (const p of ["lab.results.enter", "lab.results.read"]) await grantPermissionToRole(db, registry, "lab_technician", p);
  for (const p of ["lab.results.verify", "lab.results.read", "lab.results.enter", ORDERS_PLACE, "lab.orders.place"]) {
    await grantPermissionToRole(db, registry, "pathologist", p);
  }
  const labDesk = (await mkUser(db, "ob.labdesk", ["lab_reception"])).actor;
  const pathologist = (await mkUser(db, "ob.pathologist", ["pathologist"])).actor;
  const bench = (await mkUser(db, "ob.bench", ["lab_technician", "phlebotomist"])).actor;
  const radiographer = (await mkUser(db, "ob.radiographer", ["radiographer"])).actor;
  const drafter = (await mkUser(db, "ob.drafter", ["owner"])).actor;

  // The lab catalogue and its definitions; the imaging services, their study-type book and workflow definitions.
  await seedLabCatalogue(db, labDesk);
  await activateLabDefinitions(db, w.tariffActivator);
  await withTx(db, (tx) => upsertGstCategory(tx, w.tariffDrafter, {
    category: "investigation", sacCode: "999316", exempt: true, rateBps: 0, specialRule: null, thresholdPaise: null,
  }));
  const imaging: Record<string, string> = {};
  for (const code of ["USG-ABDO", "MRI-BRAIN", "CT-HEAD"]) {
    imaging[code] = newId();
    await db.insert(services).values({ id: imaging[code]!, code: `RAD-${code}`, name: `Imaging ${code}`, category: "investigation", createdBy: "t", updatedBy: "t" });
  }
  await seedActiveStudyTypes(db, [
    studyTypeRow({ code: "USG-ABDO", service_id: imaging["USG-ABDO"]!, modality: "usg", body_part: "abdomen", ionising: false }),
    studyTypeRow({ code: "MRI-BRAIN", service_id: imaging["MRI-BRAIN"]!, modality: "mri", body_part: "head", ionising: false }),
    studyTypeRow({ code: "CT-HEAD", service_id: imaging["CT-HEAD"]!, modality: "ct", body_part: "head", ionising: true }),
  ], new Date("2026-01-01T00:00:00Z"));
  for (const definition of RADIOLOGY_WORKFLOW_DEFINITIONS) {
    const draft = await createDraft(db, drafter, definition);
    await approveDefinition(db, w.owner, { definitionId: draft.definitionId, roleKey: "owner", note: "fixture" });
    await approveDefinition(db, w.ms, { definitionId: draft.definitionId, roleKey: "medical_superintendent", note: "fixture" });
    await activateDefinition(db, w.owner, draft.definitionId);
  }
  const { resourceId: usgDevice } = await withTx(db, (tx) => createResource(tx, w.owner, RADIOLOGY_RESOURCE_KINDS, {
    kind: "device", code: "DEV-OB-USG", name: "usg machine", attributes: { modality: "usg" },
  }));

  // The tariff every admission below locks: lab tests and two scans priced; TROPI and CT-HEAD deliberately not.
  const version = await withTx(db, async (tx) => {
    const d = await createDraftVersion(tx, w.tariffDrafter, { copyFromVersionId: w.versionId });
    for (const code of ["CBC", "LFT", "TSH", "RFT", "LIPID", "GLUF", "CRP"]) await setTariffItem(tx, w.tariffDrafter, d.versionId, serviceIdForLabCode(code), LAB_PRICE);
    await setTariffItem(tx, w.tariffDrafter, d.versionId, serviceIdForLabCode("ESR"), 0); // a ₹0 item is a missing rate
    await setTariffItem(tx, w.tariffDrafter, d.versionId, imaging["USG-ABDO"]!, USG_PRICE);
    await setTariffItem(tx, w.tariffDrafter, d.versionId, imaging["MRI-BRAIN"]!, MRI_PRICE);
    return d;
  });
  const submitted = await withTx(db, (tx) => submitVersion(tx, w.tariffDrafter, version.versionId));
  await approveRequest(db, w.owner, { approvalId: submitted.approvalId, note: "orderbill fixture tariff" });
  await activateVersion(db, w.tariffActivator, version.versionId, new Date("2026-01-04T00:00:00Z"));

  return {
    ...w, decls: collectOrderKinds(registry), labDesk, bench, pathologist, radiographer,
    usg: imaging["USG-ABDO"]!, mri: imaging["MRI-BRAIN"]!, ct: imaging["CT-HEAD"]!, usgDevice,
  };
}

describe("#785 — lab and imaging orders post to the IPD running bill", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: World;
  const off: (() => void)[] = [];

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkOrderBillWorld(db);
    off.push(registerIpdEncounterResolver(), registerIpdOrderChargeSink());
  });
  afterEach(() => { while (off.length > 0) off.pop()!(); });

  const admit = async (at = ist("2026-03-10T10:00:00")) => {
    const done = await w.admitMed(at);
    const a = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, done.admissionId)))[0]!;
    return { ...done, admissionNo: a.admissionNo! };
  };
  const order = (admissionId: string, kind: "lab" | "imaging", serviceIds: string[], at: Date) => placeIpOrder(db, w.consultant, {
    idempotencyKey: key(), admissionId, kind, tests: { serviceIds, indication: "Fever under evaluation" },
  }, { now: at, orderKinds: w.decls });
  const orderLines = async (admissionId: string) => db.select().from(ipdChargeLines)
    .where(and(eq(ipdChargeLines.admissionId, admissionId), inArray(ipdChargeLines.source, ["ipd.order", "ipd.reversal"])));
  const invoicesOf = async (patientId: string) => db.select().from(invoices).where(eq(invoices.patientId, patientId));
  const door = (admissionNo: string, patientId: string, serviceIds: string[], at: Date) => orderTests(db, w.consultant, w.decls, {
    patientId, encounterNo: admissionNo, serviceDate: "2026-03-11", orderingClinicianId: w.consultant.id, serviceIds, indication: "Pain abdomen",
  }, at);
  const refusal = async (p: Promise<unknown>): Promise<string> => {
    try { await p; } catch (e) { if (e instanceof IpdRefusal) return e.code; throw e; }
    throw new Error("expected a refusal");
  };

  it("done 1+2 — a lab and an imaging order from rounds post one priced line per item to the running bill, marked with order and service; no invoice", async () => {
    const { admissionId, patientId } = await admit();
    const at = ist("2026-03-11T09:30:00");
    await order(admissionId, "lab", [serviceIdForLabCode("CBC"), serviceIdForLabCode("LFT")], at);
    await order(admissionId, "imaging", [w.usg], at);
    const lines = await orderLines(admissionId);
    const items = await db.select().from(orderItems).where(inArray(orderItems.id, lines.map((l) => l.orderItemId!)));
    expect(lines.map((l) => [l.component, l.serviceId, l.netPaise, l.serviceDate]).sort()).toEqual([
      ["imaging", w.usg, USG_PRICE, "2026-03-11"],
      ["lab", serviceIdForLabCode("CBC"), LAB_PRICE, "2026-03-11"],
      ["lab", serviceIdForLabCode("LFT"), LAB_PRICE, "2026-03-11"],
    ].sort());
    // Each line names the department order and the order item it charges; the item is for the line's service.
    for (const l of lines) {
      const item = items.find((i) => i.id === l.orderItemId)!;
      expect([l.source, l.orderId, item.serviceId]).toEqual(["ipd.order", item.orderId, l.serviceId]);
    }
    // Priced from the admission's locked version (the one in force at admission).
    const a = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]!;
    expect(new Set(lines.map((l) => l.tariffVersionId))).toEqual(new Set([a.tariffVersionId]));
    // NO held invoice, no invoice line on the lab items.
    expect(await invoicesOf(patientId)).toEqual([]);
    const labRows = await db.select().from(labItems).where(inArray(labItems.orderItemId, lines.map((l) => l.orderItemId!)));
    expect(labRows.map((r) => [r.invoiceId, r.invoiceLineId])).toEqual([[null, null], [null, null]]);
    // The department still runs: the lab items wait for collection; the imaging order made its study.
    expect(labRows).toHaveLength(2);
  });

  it("done 1+5 — the other doors (ordering door, lab desk) post to the running bill too, and raise no invoice of their own", async () => {
    const { admissionId, patientId, admissionNo } = await admit();
    const at = ist("2026-03-11T11:00:00");
    const viaDoor = await door(admissionNo, patientId, [serviceIdForLabCode("TSH"), w.mri], at);
    expect(viaDoor.skipped).toEqual([]);
    expect(viaDoor.lab!.invoice).toBeNull();
    await withTx(db, (tx) => deskOrder(tx, w.labDesk, w.decls, {
      patientId, encounterNo: admissionNo, serviceDate: "2026-03-11", orderingClinicianId: w.consultant.id,
      items: [{ serviceId: serviceIdForLabCode("RFT") }], credit: { reason: "ward sample" },
    }, at));
    const lines = await orderLines(admissionId);
    expect(lines.map((l) => [l.component, l.serviceId]).sort()).toEqual([
      ["imaging", w.mri], ["lab", serviceIdForLabCode("RFT")], ["lab", serviceIdForLabCode("TSH")],
    ].sort());
    expect(await invoicesOf(patientId)).toEqual([]);
  });

  it("done 3 — the lines are on the interim and final bill, go through the payer split, and the deposit ladder counts them", async () => {
    const { admissionId } = await admit();
    await order(admissionId, "lab", [serviceIdForLabCode("CBC")], ist("2026-03-11T09:30:00"));
    await order(admissionId, "imaging", [w.usg], ist("2026-03-11T09:31:00"));
    const lines = await orderLines(admissionId);
    const interim = await readInterimBill(db, w.billDesk, admissionId);
    const shown = interim.days.flatMap((d) => d.lines).filter((l) => l.source === "ipd.order");
    expect(shown.map((l) => [l.component, l.netPaise]).sort()).toEqual([["imaging", USG_PRICE], ["lab", LAB_PRICE]]);
    expect(interim.byComponent.filter((c) => c.component === "lab" || c.component === "imaging"))
      .toEqual([{ component: "lab", netPaise: LAB_PRICE }, { component: "imaging", netPaise: USG_PRICE }]);
    const a = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]!;
    const bill = await composeFinalBill(db, a);
    expect(bill.live.filter((x) => x.line.source === "ipd.order").map((x) => x.line.id).sort()).toEqual(lines.map((l) => l.id).sort());
    const split = bill.split.lines.filter((s) => lines.some((l) => l.id === s.lineId));
    expect(split.map((s) => s.payerPaise + s.patientPaise).sort()).toEqual([LAB_PRICE, USG_PRICE].sort());
    const pos = await depositPosition(db, a);
    expect(pos.patientPayablePaise).toBeGreaterThanOrEqual(LAB_PRICE + USG_PRICE);
    expect(pos.split.lines.filter((s) => lines.some((l) => l.id === s.lineId))).toHaveLength(2);
  });

  it("done 4 (lab) — cancelled before the sample is taken posts a reversal; cancelled after it posts nothing", async () => {
    const { admissionId, patientId } = await admit();
    const at = ist("2026-03-11T09:30:00");
    await order(admissionId, "lab", [serviceIdForLabCode("CBC")], at);
    await order(admissionId, "lab", [serviceIdForLabCode("LFT")], at);
    const [cbc, lft] = ["CBC", "LFT"].map((c) => serviceIdForLabCode(c));
    const lineOf = async (serviceId: string) => (await orderLines(admissionId)).find((l) => l.serviceId === serviceId && l.source === "ipd.order")!;
    // CBC: never drawn → reversal line, negated, naming the line.
    const cbcLine = await lineOf(cbc!);
    await withTx(db, (tx) => cancelLabItem(tx, w.labDesk, w.decls, { orderItemId: cbcLine.orderItemId!, reason: "Wrong patient" }, at));
    // LFT: drawn (labelled and collected) → cancelled → no reversal.
    const lftLine = await lineOf(lft!);
    const uhid = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.uhid;
    const groupId = (await db.select().from(orderItems).where(eq(orderItems.id, lftLine.orderItemId!)))[0]!.orderId;
    const { specimens } = await printLabels(db, w.bench, { orderGroupId: groupId, scannedUhid: uhid });
    for (const s of specimens) await withTx(db, (tx) => collect(tx, w.bench, { specimenId: s.specimenId, wristbandScanned: true }));
    await withTx(db, (tx) => cancelLabItem(tx, w.labDesk, w.decls, { orderItemId: lftLine.orderItemId!, reason: "Doctor changed plan" }, at));
    const after = await orderLines(admissionId);
    const reversals = after.filter((l) => l.source === "ipd.reversal");
    expect(reversals.map((r) => [r.reversalOf, r.netPaise, r.orderItemId])).toEqual([[cbcLine.id, -LAB_PRICE, cbcLine.orderItemId]]);
    expect(after.filter((l) => l.id === lftLine.id)).toHaveLength(1);
    expect(await invoicesOf(patientId)).toEqual([]);
  });

  it("done 4 (imaging) — a study cancelled before it is on the machine posts a reversal", async () => {
    const { admissionId, admissionNo, patientId } = await admit();
    const at = ist("2026-03-11T09:30:00");
    const placed = await door(admissionNo, patientId, [w.usg], at);
    const [study] = await withTx(db, (tx) => handleOrderPlaced(tx, {
      orderId: placed.imaging!.orderId, orderNo: placed.imaging!.orderNo, kind: "imaging", patientId, encounterNo: admissionNo,
      groupId: placed.imaging!.orderId, itemIds: placed.imaging!.itemIds,
    }));
    await withTx(db, (tx) => scheduleStudy(tx, w.radiographer, { studyId: study!.studyId, deviceResourceId: w.usgDevice, scheduledAt: ist("2026-03-11T12:00:00") }));
    await withTx(db, (tx) => cancelStudy(tx, w.consultant, w.decls, { studyId: study!.studyId, reason: "Patient shifted to ICU" }));
    const lines = await orderLines(admissionId);
    const original = lines.find((l) => l.source === "ipd.order")!;
    expect(lines.filter((l) => l.source === "ipd.reversal").map((r) => [r.reversalOf, r.netPaise])).toEqual([[original.id, -USG_PRICE]]);
  });

  it("done 5 — no double charge: an inpatient's scan reaches the machine and the counter gets no acquired-unbilled decision; a retried round order posts once", async () => {
    const { admissionId, admissionNo, patientId } = await admit();
    const at = ist("2026-03-11T09:30:00");
    const placed = await door(admissionNo, patientId, [w.usg], at);
    const [study] = await withTx(db, (tx) => handleOrderPlaced(tx, {
      orderId: placed.imaging!.orderId, orderNo: placed.imaging!.orderNo, kind: "imaging", patientId, encounterNo: admissionNo,
      groupId: placed.imaging!.orderId, itemIds: placed.imaging!.itemIds,
    }));
    const studyId = study!.studyId;
    await withTx(db, (tx) => scheduleStudy(tx, w.radiographer, { studyId, deviceResourceId: w.usgDevice, scheduledAt: ist("2026-03-11T12:00:00") }));
    const checked = await withTx(db, (tx) => checkIn(tx, w.radiographer, { studyId, now: at }));
    const uhid = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.uhid;
    const evidence: Record<string, unknown> = {
      identity_two_factor: { secondIdentifier: "uhid", value: uhid }, laterality_confirm: { patientStated: "na" },
      pregnancy_screen: { declared: true, lmpDate: new Date(at.getTime() - 10 * 86_400_000).toISOString() },
    };
    for (const kind of checked.gates) {
      const gate = await requireStudyGate(db, studyId, kind);
      await withTx(db, (tx) => satisfyGate(tx, w.radiographer, gate.id, evidence[kind] ?? {}, at));
    }
    await withTx(db, (tx) => evaluateReadiness(tx, studyId));
    await withTx(db, (tx) => startAcquisition(tx, w.radiographer, w.decls, { studyId, now: at }));
    await withTx(db, (tx) => recordAcquired(tx, w.radiographer, w.decls, { studyId, imageSource: "no_pacs_images", now: at }));
    const s = (await db.select().from(imagingStudies).where(eq(imagingStudies.id, studyId)))[0]!;
    expect([s.status, s.authorisedBy, s.invoiceLineId]).toEqual(["acquired", "ipd_admission", null]);
    expect((await db.select().from(imagingBillDecisions).where(eq(imagingBillDecisions.studyId, studyId))).map((d) => d.kind)).toEqual([]);
    expect((await orderLines(admissionId)).map((l) => [l.source, l.serviceId])).toEqual([["ipd.order", w.usg]]);
    expect(await invoicesOf(patientId)).toEqual([]);

    // A retried rounds act (same idempotency key) asks no department again and posts nothing new.
    const body = { idempotencyKey: key(), admissionId, kind: "lab", tests: { serviceIds: [serviceIdForLabCode("GLUF")], indication: "Sugar" } };
    await placeIpOrder(db, w.consultant, body, { now: at, orderKinds: w.decls });
    await placeIpOrder(db, w.consultant, body, { now: at, orderKinds: w.decls });
    expect((await orderLines(admissionId)).filter((l) => l.serviceId === serviceIdForLabCode("GLUF"))).toHaveLength(1);
  });

  it("done 6 / review 10 — an absent item or switched-off service raises rate_missing (never a silent ₹0); an explicit ₹0 item posts ₹0; Retry posts it once priced", async () => {
    const { admissionId, admissionNo, patientId } = await admit();
    const at = ist("2026-03-11T09:30:00");
    await order(admissionId, "lab", [serviceIdForLabCode("TROPI")], at); // no item on the locked version
    await order(admissionId, "lab", [serviceIdForLabCode("ESR")], at); // an EXPLICIT ₹0 item: a ₹0 line (review item 10)
    await door(admissionNo, patientId, [w.ct], at); // no item either
    await db.update(services).set({ active: false }).where(eq(services.id, serviceIdForLabCode("LIPID")));
    await order(admissionId, "lab", [serviceIdForLabCode("LIPID")], at); // priced, but switched off
    expect((await orderLines(admissionId)).map((l) => [l.serviceId, l.netPaise])).toEqual([[serviceIdForLabCode("ESR"), 0]]);
    const open = await db.select().from(ipdChargeExceptions).where(eq(ipdChargeExceptions.admissionId, admissionId));
    expect(open.map((x) => [x.reason, x.component, x.resolvedAt]).sort()).toEqual([
      ["rate_missing", "imaging", null], ["rate_missing", "lab", null], ["rate_missing", "lab", null],
    ]);
    const desk = await readBillDesk(db, w.billDesk, ist("2026-03-11T10:00:00"));
    expect(desk.rows.some((r) => r.admissionId === admissionId)).toBe(true);
    // The billing office switches the service on; Retry posts the line and closes its exception.
    await db.update(services).set({ active: true }).where(eq(services.id, serviceIdForLabCode("LIPID")));
    await retryFromBillDesk(db, w.billDesk, admissionId, ist("2026-03-11T10:05:00"));
    const lines = await orderLines(admissionId);
    expect(lines.map((l) => [l.serviceId, l.netPaise]).sort()).toEqual([[serviceIdForLabCode("ESR"), 0], [serviceIdForLabCode("LIPID"), LAB_PRICE]].sort());
    const still = (await db.select().from(ipdChargeExceptions).where(eq(ipdChargeExceptions.admissionId, admissionId)))
      .filter((x) => x.resolvedAt === null && (x.component === "lab" || x.component === "imaging"));
    expect(still.map((x) => x.component).sort()).toEqual(["imaging", "lab"]);
  });

  it("done 7 — an order on an admission that has ended is refused: rounds by the state guard, the other doors as encounter_closed", async () => {
    const { admissionId, admissionNo, patientId } = await admit();
    await w.discharge(admissionId, ist("2026-03-12T11:00:00"));
    const at = ist("2026-03-12T15:00:00");
    expect(await refusal(order(admissionId, "lab", [serviceIdForLabCode("CBC")], at))).toBe("admission_wrong_state");
    expect(await refusal(order(admissionId, "imaging", [w.usg], at))).toBe("admission_wrong_state");
    const viaDoor = await door(admissionNo, patientId, [serviceIdForLabCode("CBC"), w.usg], at);
    expect(viaDoor.skipped.map((s) => [s.department, s.code]).sort()).toEqual([["imaging", "encounter_closed"], ["lab", "encounter_closed"]]);
    expect(await orderLines(admissionId)).toEqual([]);
    expect(await invoicesOf(patientId)).toEqual([]);
  });

  // ═══════════════════════════ review of 47cd79f5 ═══════════════════════════

  const study = async (admissionNo: string, patientId: string, serviceId: string, at: Date) => {
    const placed = await door(admissionNo, patientId, [serviceId], at);
    const [st] = await withTx(db, (tx) => handleOrderPlaced(tx, {
      orderId: placed.imaging!.orderId, orderNo: placed.imaging!.orderNo, kind: "imaging", patientId, encounterNo: admissionNo,
      groupId: placed.imaging!.orderId, itemIds: placed.imaging!.itemIds,
    }));
    return st!.studyId;
  };
  const toMachine = async (studyId: string, patientId: string, at: Date) => {
    await withTx(db, (tx) => scheduleStudy(tx, w.radiographer, { studyId, deviceResourceId: w.usgDevice, scheduledAt: new Date(at.getTime() + 3_600_000) }));
    const checked = await withTx(db, (tx) => checkIn(tx, w.radiographer, { studyId, now: at }));
    const uhid = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.uhid;
    const evidence: Record<string, unknown> = {
      identity_two_factor: { secondIdentifier: "uhid", value: uhid }, laterality_confirm: { patientStated: "na" },
      pregnancy_screen: { declared: true, lmpDate: new Date(at.getTime() - 10 * 86_400_000).toISOString() },
    };
    for (const kind of checked.gates) {
      const gate = await requireStudyGate(db, studyId, kind);
      await withTx(db, (tx) => satisfyGate(tx, w.radiographer, gate.id, evidence[kind] ?? {}, at));
    }
    await withTx(db, (tx) => evaluateReadiness(tx, studyId));
    await withTx(db, (tx) => startAcquisition(tx, w.radiographer, w.decls, { studyId, now: at }));
  };
  /** A settled final bill covering the given lines (the discharge lane's settle, written directly as `w.discharge` is). */
  const settleBillOver = async (admissionId: string, lineIds: string[], at: Date) => {
    const id = newId();
    await db.insert(ipdFinalBills).values({
      id, admissionId, billVersion: lineIds.length, totalPaise: 0, payerPaise: 0, patientPaise: 0, depositAppliedPaise: 0, paidPaise: 0,
      refundPaise: 0, duesPaise: 0, settlement: "paid", split: {}, settledBy: w.billDesk.id, settledAt: at, kind: "final", seq: 0, lineIds,
    } as never);
    return id;
  };
  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try { await p; } catch (e) { return (e as { code?: string }).code ?? String(e); }
    throw new Error("expected a refusal");
  };

  it("review 1 — a scan ordered in the stay and done AFTER discharge: not refused for payment, never invoiced, no acquired-unbilled", async () => {
    const { admissionId, admissionNo, patientId } = await admit();
    const studyId = await study(admissionNo, patientId, w.usg, ist("2026-03-11T09:30:00"));
    await w.discharge(admissionId, ist("2026-03-11T11:00:00"));
    const at = ist("2026-03-11T15:00:00");
    await toMachine(studyId, patientId, at);
    await withTx(db, (tx) => recordAcquired(tx, w.radiographer, w.decls, { studyId, imageSource: "no_pacs_images", now: at }));
    const s = (await db.select().from(imagingStudies).where(eq(imagingStudies.id, studyId)))[0]!;
    expect([s.status, s.authorisedBy, s.invoiceLineId]).toEqual(["acquired", "ipd_admission", null]);
    expect((await db.select().from(imagingBillDecisions).where(eq(imagingBillDecisions.studyId, studyId))).map((d) => d.kind)).toEqual([]);
    // Billing refuses any invoice against the admission number, ended or not.
    expect(await codeOf(issueInvoice(db, w.billingManager, {
      draftId: newId(), patientId, encounterId: admissionNo, lines: [{ lineId: newId(), serviceId: w.usg, qty: 1 }],
    }))).toBe("ipd_running_bill");
    expect(await invoicesOf(patientId)).toEqual([]);
  });

  it("review 2 — the lab desk on a running-bill admission refuses a tender by code; its preview says 'running bill' with nothing to collect", async () => {
    const { patientId, admissionNo } = await admit();
    const at = ist("2026-03-11T11:00:00");
    expect(await codeOf(withTx(db, (tx) => deskOrder(tx, w.labDesk, w.decls, {
      patientId, encounterNo: admissionNo, serviceDate: "2026-03-11", orderingClinicianId: w.consultant.id,
      items: [{ serviceId: serviceIdForLabCode("CBC") }], receipt: { tenders: [{ mode: "cash", amountPaise: LAB_PRICE }] },
    }, at)))).toBe("ipd_running_bill");
    const preview = await previewDeskOrder(db, { patientId, encounterNo: admissionNo, serviceIds: [serviceIdForLabCode("CBC")] });
    expect([preview.runningBill, preview.totals.netPayablePaise, preview.lines]).toEqual([true, 0, []]);
    expect(await invoicesOf(patientId)).toEqual([]);
  });

  it("review 3 — decision 0067 is not OPD-only: a scan ordered while the imaging fee is off posts a ₹0 line", async () => {
    const { admissionId, admissionNo, patientId } = await admit();
    await setFeeSwitch(db, w.owner, "imaging", true, ist("2026-03-11T08:00:00"));
    await door(admissionNo, patientId, [w.usg], ist("2026-03-11T09:30:00"));
    expect((await orderLines(admissionId)).map((l) => [l.component, l.serviceId, l.netPaise])).toEqual([["imaging", w.usg, 0]]);
  });

  it("review 4 — cancelled before the sample but already on a settled bill: no reversal behind it; a bill-desk decision names the order; a reversal after the void closes it", async () => {
    const { admissionId } = await admit();
    const at = ist("2026-03-11T09:30:00");
    await order(admissionId, "lab", [serviceIdForLabCode("CBC")], at);
    const line = (await orderLines(admissionId))[0]!;
    const billId = await settleBillOver(admissionId, [line.id], ist("2026-03-11T10:00:00"));
    const out = await withTx(db, (tx) => cancelLabItem(tx, w.labDesk, w.decls, { orderItemId: line.orderItemId!, reason: "Not needed" }, at));
    expect(out.refund.runningBill).toBe("billed");
    expect((await orderLines(admissionId)).filter((l) => l.source === "ipd.reversal")).toEqual([]);
    const open = (await db.select().from(ipdChargeExceptions).where(eq(ipdChargeExceptions.admissionId, admissionId))).filter((x) => x.resolvedAt === null);
    expect(open.map((x) => [x.reason, x.component, x.key.split(":")[3]])).toEqual([["order_cancelled_after_bill", "lab", line.orderItemId]]);
    const deskRow = (await readBillDesk(db, w.billDesk, at)).rows.find((r) => r.admissionId === admissionId)!;
    expect(deskRow.reasons).toContain("order_cancelled_after_bill");
    expect(deskRow.orderCancels?.map((c) => [c.chargeLineId, c.reason])).toEqual([[line.id, "order_cancelled_after_bill"]]);
    // Billing voids the bill (#763) and reverses the line: the decision closes.
    await db.update(ipdFinalBills).set({ voidedAt: ist("2026-03-11T12:00:00"), voidedBy: w.billDesk.id, voidReason: "Fixture void", voidApprovalId: "fixture" } as never).where(eq(ipdFinalBills.id, billId));
    await reverseChargeLine(db, w.billDesk, { chargeLineId: line.id, reason: "Test cancelled before sample" }, { now: ist("2026-03-11T12:05:00") });
    const after = (await db.select().from(ipdChargeExceptions).where(eq(ipdChargeExceptions.admissionId, admissionId))).filter((x) => x.resolvedAt === null);
    expect(after).toEqual([]);
  });

  it("review 5 — a Retry racing a cancel never leaves a live line on a cancelled test", async () => {
    for (let round = 0; round < 3; round += 1) {
      const { admissionId } = await admit(ist(`2026-03-10T1${String(round)}:00:00`));
      const at = ist("2026-03-11T09:30:00");
      await db.update(services).set({ active: false }).where(eq(services.id, serviceIdForLabCode("LIPID")));
      await order(admissionId, "lab", [serviceIdForLabCode("LIPID")], at);
      const itemId = (await db.select().from(ipdChargeExceptions).where(eq(ipdChargeExceptions.admissionId, admissionId)))[0]!.key.split(":")[3]!;
      await db.update(services).set({ active: true }).where(eq(services.id, serviceIdForLabCode("LIPID")));
      await Promise.all([
        retryFromBillDesk(db, w.billDesk, admissionId, ist("2026-03-11T10:00:00")),
        withTx(db, (tx) => cancelLabItem(tx, w.labDesk, w.decls, { orderItemId: itemId, reason: "Duplicate" }, ist("2026-03-11T10:00:00"))),
      ]);
      const lines = (await orderLines(admissionId)).filter((l) => l.orderItemId === itemId);
      expect(lines.reduce((t, l) => t + l.netPaise, 0)).toBe(0);
      const open = (await db.select().from(ipdChargeExceptions).where(eq(ipdChargeExceptions.admissionId, admissionId)))
        .filter((x) => x.resolvedAt === null && x.component === "lab");
      expect(open).toEqual([]);
    }
  });

  it("review 6 — an order posted after the final bill settled goes to the supplementary bill, standing read under the lock", async () => {
    const { admissionId, admissionNo } = await admit();
    const at = ist("2026-03-11T09:30:00");
    await order(admissionId, "lab", [serviceIdForLabCode("CBC")], at);
    const first = (await orderLines(admissionId))[0]!;
    await settleBillOver(admissionId, [first.id], ist("2026-03-11T10:00:00"));
    await w.discharge(admissionId, ist("2026-03-11T10:30:00"));
    // The department checked while live; the admission ended before its posting took the lock.
    const item = (await db.select().from(orderItems).where(eq(orderItems.id, first.orderItemId!)))[0]!;
    const res = await withTx(db, async (tx) => ({
      standing: await lockIpdOrderStanding(tx, admissionNo),
      post: await postIpdOrderCharges(tx, w.consultant, {
        encounterNo: admissionNo, department: "lab", at: ist("2026-03-11T10:45:00"),
        items: [{ orderId: item.orderId, orderItemId: newId(), serviceId: serviceIdForLabCode("TSH") }],
      }),
    }));
    expect([res.standing, res.post.supplementary, res.post.posted.length]).toEqual(["ended", true, 1]);
    const a = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0]!;
    const unbilled = await composeFinalBill(db, a, (l) => l.id !== first.id);
    expect(unbilled.live.map((x) => x.line.serviceId)).toEqual([serviceIdForLabCode("TSH")]);
  });

  it("review 7 — fail closed: with no running bill registered, an IP-number order is refused by code and nothing is invoiced", async () => {
    const { admissionNo, patientId, admissionId } = await admit();
    while (off.length > 1) off.pop()!(); // unregister the sink, keep the encounter resolver
    const viaDoor = await door(admissionNo, patientId, [serviceIdForLabCode("CBC"), w.usg], ist("2026-03-11T09:30:00"));
    expect(viaDoor.skipped.map((x) => [x.department, x.code]).sort()).toEqual([["imaging", "running_bill_unavailable"], ["lab", "running_bill_unavailable"]]);
    expect(await invoicesOf(patientId)).toEqual([]);
    expect(await orderLines(admissionId)).toEqual([]);
  });

  it("review 8 — a lab test cancelled after the sample was taken raises a bill-desk decision; billing keeps the line and the decision closes", async () => {
    const { admissionId, patientId } = await admit();
    const at = ist("2026-03-11T09:30:00");
    await order(admissionId, "lab", [serviceIdForLabCode("LFT")], at);
    const line = (await orderLines(admissionId))[0]!;
    const uhid = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.uhid;
    const groupId = (await db.select().from(orderItems).where(eq(orderItems.id, line.orderItemId!)))[0]!.orderId;
    const { specimens } = await printLabels(db, w.bench, { orderGroupId: groupId, scannedUhid: uhid });
    for (const sp of specimens) await withTx(db, (tx) => collect(tx, w.bench, { specimenId: sp.specimenId, wristbandScanned: true }));
    const out = await withTx(db, (tx) => cancelLabItem(tx, w.labDesk, w.decls, { orderItemId: line.orderItemId!, reason: "Plan changed" }, at));
    expect(out.refund.runningBill).toBe("work_done");
    const open = (await db.select().from(ipdChargeExceptions).where(eq(ipdChargeExceptions.admissionId, admissionId))).filter((x) => x.resolvedAt === null);
    expect(open.map((x) => [x.reason, x.key.split(":")[3]])).toEqual([["order_cancelled_after_work", line.orderItemId]]);
    expect(await keepOrderCharge(db, w.billDesk, { chargeLineId: line.id, reason: "Sample was processed" }, { now: at })).toEqual({ resolved: 1 });
    expect((await db.select().from(ipdChargeExceptions).where(eq(ipdChargeExceptions.admissionId, admissionId))).filter((x) => x.resolvedAt === null)).toEqual([]);
  });

  it("review 11 — rounds and the lab desk ordering for one admission at once both land; neither waits on the other for ever", async () => {
    const { admissionId, admissionNo, patientId } = await admit();
    const at = ist("2026-03-11T09:30:00");
    await Promise.all([
      order(admissionId, "lab", [serviceIdForLabCode("CBC")], at),
      withTx(db, (tx) => deskOrder(tx, w.labDesk, w.decls, {
        patientId, encounterNo: admissionNo, serviceDate: "2026-03-11", orderingClinicianId: w.consultant.id,
        items: [{ serviceId: serviceIdForLabCode("LFT") }],
      }, at)),
      order(admissionId, "imaging", [w.usg], at),
    ]);
    expect((await orderLines(admissionId)).map((l) => l.component).sort()).toEqual(["imaging", "lab", "lab"]);
  });

  it("review 14 — a reflex test from a sample taken in the stay, signed after discharge, goes on the running bill and is never invoiced", async () => {
    const { admissionId, admissionNo, patientId } = await admit();
    const at = ist("2026-03-11T09:30:00");
    const tsh = (await db.select({ id: labAnalytes.id }).from(labAnalytes).where(eq(labAnalytes.code, "TSH")))[0]!;
    await db.update(labReflexRules).set({ active: true, addsServiceId: serviceIdForLabCode("CRP") }).where(eq(labReflexRules.analyteId, tsh.id));
    const placed = await withTx(db, (tx) => deskOrder(tx, w.labDesk, w.decls, {
      patientId, encounterNo: admissionNo, serviceDate: "2026-03-11", orderingClinicianId: w.consultant.id,
      items: [{ serviceId: serviceIdForLabCode("TSH") }], reflexConsent: true,
    }, at));
    const uhid = (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.uhid;
    const { specimens } = await printLabels(db, w.bench, { orderGroupId: placed.orderGroupId, scannedUhid: uhid }, at);
    for (const sp of specimens) {
      await withTx(db, (tx) => collect(tx, w.bench, { specimenId: sp.specimenId, wristbandScanned: true }, at));
      await withTx(db, (tx) => receive(tx, w.bench, w.decls, { specimenNo: sp.specimenNo }, at));
    }
    const entered = await enterResult(db, w.bench, { orderItemId: placed.itemIds[0]!, analyteId: tsh.id, value: "9.0", entryMode: "manual" }, at);
    await w.discharge(admissionId, ist("2026-03-11T11:00:00"));
    const out = await verifyResult(db, w.pathologist, w.decls, { resultId: entered.resultId }, ist("2026-03-11T12:00:00"));
    expect(out.reflex.map((r) => [r.addedServiceId, r.invoiceId])).toEqual([[serviceIdForLabCode("CRP"), null]]);
    expect((await orderLines(admissionId)).map((l) => [l.serviceId, l.netPaise]).sort())
      .toEqual([[serviceIdForLabCode("CRP"), LAB_PRICE], [serviceIdForLabCode("TSH"), LAB_PRICE]].sort());
    expect(await invoicesOf(patientId)).toEqual([]);
  });

  it("gap — the deposit ladder re-checks the moment an order posts", async () => {
    const { admissionId } = await admit();
    await db.update(ipdAdmissions).set({ depositRequiredPaise: 100_000, depositExemption: null, payerKind: "cash" } as never).where(eq(ipdAdmissions.id, admissionId));
    await order(admissionId, "imaging", [w.mri], ist("2026-03-11T09:30:00"));
    expect((await db.select().from(ipdDepositAlerts).where(eq(ipdDepositAlerts.admissionId, admissionId))).length).toBeGreaterThan(0);
  });
});
