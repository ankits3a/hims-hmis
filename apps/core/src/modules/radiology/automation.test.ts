import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, placeAndCreateStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import {
  alerts, creditNoteLines, creditNotes, doseRegister, events, imagingAutomationRuns, imagingFollowups, imagingReports,
  imagingStudies, notifications,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { approveRequest } from "../../kernel/approvals/decisions";
import { billingManifest, previewInvoice } from "../billing";
import { activateVersion, createDraftVersion, setTariffItem, submitVersion, upsertGstCategory } from "../tariff";
import { AUTOMATION_ACTOR } from "./automation-actor";
import { sendPatientReminders, sweepNoShows, switchAutomation } from "./automation";
import { CHASER_ACTOR } from "./chasers";
import { registerCompleteness, sweepRegisterCompleteness } from "./completeness";
import { collectAtDesk } from "./desk";
import { sendHodDigest } from "./digest";
import { runMorningSweep } from "./morning-sweep";
import { amendReport, cosignReport } from "./report-signature";
import { scheduleStudy } from "./schedule";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * #1085 (IM6c) — the morning sweep's edges, beside its locked acceptance checks: the switch's refusals, a
 * slot booked the day before gets no reminder, a follow-up due today does, the paid no-show's carry stops at
 * 30 days and at a refund, a dose above its level with no reason is a gap, the bells go to the register's
 * keepers, and the whole sweep run twice in a morning writes its rows once. Every instant is passed in.
 */
const DAY = "2026-08-31";
const RUN = new Date("2026-08-31T02:30:00.000Z");
const at = (iso: string): Date => new Date(iso);

describe("the imaging morning sweep (#1085)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  jest.setTimeout(120_000);
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: RUN });
  });
  afterEach(() => { fx.unregister(); });

  const book = (studyId: string, device: string, slot: Date, bookedAt: Date) =>
    withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, { studyId, deviceResourceId: device, scheduledAt: slot, now: bookedAt }));
  const study = async (id: string) => (await db.select().from(imagingStudies).where(eq(imagingStudies.id, id)))[0]!;
  const remindersOn = () => withTx(db, (tx) => switchAutomation(tx, fx.radiologist, {
    kind: "patient_reminders", enabled: true, reason: "templates approved", now: at("2026-08-30T10:00:00.000Z"),
  }));

  it("the switch: a person, a known automation and a reason; a switch that changes nothing writes nothing", async () => {
    await expect(withTx(db, (tx) => switchAutomation(tx, CHASER_ACTOR, { kind: "hod_digest", enabled: false, reason: "a machine asked" })))
      .rejects.toMatchObject({ code: "user_actor_required" });
    await expect(withTx(db, (tx) => switchAutomation(tx, fx.radiologist, { kind: "coffee", enabled: false, reason: "not a thing" })))
      .rejects.toMatchObject({ code: "evidence_invalid" });
    await expect(withTx(db, (tx) => switchAutomation(tx, fx.radiologist, { kind: "hod_digest", enabled: false, reason: "  " })))
      .rejects.toMatchObject({ code: "reason_required" });
    const same = await withTx(db, (tx) => switchAutomation(tx, fx.radiologist, { kind: "hod_digest", enabled: true, reason: "already on" }));
    expect(same.changed).toBe(false);
    expect(await db.select().from(events).where(eq(events.name, "imaging.automation_switched"))).toHaveLength(0);
  });

  it("the automation actor is refused by co-sign and amend too — every signature is a person's", async () => {
    await expect(withTx(db, (tx) => cosignReport(tx, AUTOMATION_ACTOR, { studyId: "x", reportId: "y", secondFactorAt: RUN, now: RUN })))
      .rejects.toMatchObject({ code: "automation_refused" });
    await expect(withTx(db, (tx) => amendReport(tx, AUTOMATION_ACTOR, {
      studyId: "x", secondFactorAt: RUN, reason: "the machine changed its mind", templateKey: "generic", body: {}, now: RUN,
    } as never))).rejects.toMatchObject({ code: "automation_refused" });
  });

  it("reminders: a slot tomorrow booked this morning (one day ahead) gets none; a follow-up due today gets one, naming nothing clinical", async () => {
    await remindersOn();
    const late = await placeAndCreateStudy(db, fx, "CT-HEAD", "r-late", at("2026-08-31T01:00:00.000Z"));
    await book(late.studyId, fx.devices.ct!, at("2026-09-01T05:00:00.000Z"), at("2026-08-31T01:30:00.000Z"));
    const reported = await placeAndCreateStudy(db, fx, "XR-CHEST", "r-fu", at("2026-02-20T04:00:00.000Z"));
    const reportId = newId();
    await db.insert(imagingReports).values({ id: reportId, studyId: reported.studyId, version: 1, templateKey: "generic", body: {} });
    const followupId = newId();
    await db.insert(imagingFollowups).values({
      id: followupId, studyId: reported.studyId, reportId, patientId: fx.patientId, source: "fleischner",
      recommendation: "CT at 6-12 months", intervalLabel: "6 months", dueOn: DAY, createdBy: fx.radiologist.id,
    });

    const result = await sendPatientReminders(db, RUN);

    expect(result).toMatchObject({ ran: true, appointments: 0, followups: 1 });
    const queued = await db.select().from(notifications).where(eq(notifications.patientId, fx.patientId));
    expect(queued.filter((n) => n.templateKey === "imaging_appointment_reminder")).toHaveLength(0);
    const due = queued.filter((n) => n.templateKey === "imaging_followup_due");
    expect(due.map((n) => [n.refType, n.refId, n.params])).toEqual([["imaging_followup", followupId, { dueOn: DAY }]]);
  });

  /* ── the paid no-show's carry: the desk counter's billing fixture (#1078) ── */
  const paidNoShow = async (key: string, slot: Date) => {
    const base = await seedBillingBase(db);
    await withTx(db, (tx) => upsertGstCategory(tx, base.drafter, {
      category: "investigation", sacCode: "999316", exempt: true, rateBps: 0, specialRule: null, thresholdPaise: null,
    }));
    const draft = await withTx(db, async (tx) => {
      const d = await createDraftVersion(tx, base.drafter, { copyFromVersionId: base.tariffVersionId });
      await setTariffItem(tx, base.drafter, d.versionId, fx.services["CT-HEAD"]!, 250_000);
      return d;
    });
    const submitted = await withTx(db, (tx) => submitVersion(tx, base.drafter, draft.versionId));
    await approveRequest(db, base.owner, { approvalId: submitted.approvalId, note: "sweep fixture" });
    await activateVersion(db, base.activator, draft.versionId, new Date("2026-02-01T00:00:00Z"));
    const registry = new ModuleRegistry();
    const deskRad = ["radiology.schedule", "radiology.checkin", "radiology.bill_decisions.manage"];
    registry.install(billingManifest);
    registry.install({ key: "radiology", title: "Rad", menu: [], permissions: deskRad, subscriptions: [] });
    await syncPermissions(db, registry);
    await ensureRole(db, "radiology_receptionist");
    for (const p of [...deskRad, "billing.invoice.issue", "billing.receipt.record", "billing.session.own"]) {
      await grantPermissionToRole(db, registry, "radiology_receptionist", p);
    }
    const desk: Actor = (await mkUser(db, `desk.${key}`, ["radiology_receptionist"])).actor;
    await openSessionFor(db, { id: desk.id }, 0);
    const placedAt = new Date(slot.getTime() - 2 * 86_400_000);
    const s = await placeAndCreateStudy(db, fx, "CT-HEAD", `${key}-first`, placedAt);
    const priced = await previewInvoice(db, {
      encounterId: fx.visitNo, lines: [{ lineId: `study-${s.studyId}`, serviceId: fx.services["CT-HEAD"]!, qty: 1 }],
    }, placedAt);
    const paid = await collectAtDesk(db, desk, {
      encounterNo: fx.visitNo, studyIds: [s.studyId], addOns: [], tender: { mode: "cash", amountPaise: priced.totals.netPayablePaise },
    }, `${key}-collect`, placedAt);
    await book(s.studyId, fx.devices.ct!, slot, new Date(placedAt.getTime() + 60_000));
    await sweepNoShows(db, new Date(slot.getTime() + 86_400_000));
    expect((await study(s.studyId)).status).toBe("no_show");
    return { study: s, line: paid.linked[0]!.invoiceLineId, invoiceId: paid.invoiceId };
  };

  it("a paid no-show's invoice carries once, with an event naming both studies — and not past 30 days", async () => {
    const missed = await paidNoShow("c30", at("2026-07-20T05:00:00.000Z"));
    const tooLate = await placeAndCreateStudy(db, fx, "CT-HEAD", "c30-late", at("2026-08-20T05:00:00.000Z"));
    expect((await study(tooLate.studyId)).invoiceLineId).toBeNull();
    expect((await study(missed.study.studyId)).invoiceLineId).toBe(missed.line);
    expect(await db.select().from(events).where(eq(events.name, "imaging.invoice_carried"))).toHaveLength(0);
  });

  it("a paid no-show carries within 30 days, the no-show gives the line up, and a second rebooking gets nothing", async () => {
    const missed = await paidNoShow("c1", at("2026-08-30T05:00:00.000Z"));
    const again = await placeAndCreateStudy(db, fx, "CT-HEAD", "c1-again", at("2026-08-31T05:00:00.000Z"));
    expect((await study(again.studyId)).invoiceLineId).toBe(missed.line);
    expect((await study(missed.study.studyId)).invoiceLineId).toBeNull();
    const carried = await db.select().from(events).where(eq(events.name, "imaging.invoice_carried"));
    expect(carried.map((e) => [e.actorId, e.payload])).toEqual([
      ["radiology-automation", { fromStudyId: missed.study.studyId, toStudyId: again.studyId, invoiceLineId: missed.line }],
    ]);
    const third = await placeAndCreateStudy(db, fx, "CT-HEAD", "c1-third", at("2026-09-02T05:00:00.000Z"));
    expect((await study(third.studyId)).invoiceLineId).toBeNull();
  });

  it("a refunded line is not carried: the money went back, and the rebooking is billed as usual", async () => {
    const missed = await paidNoShow("cr", at("2026-08-30T05:00:00.000Z"));
    const noteId = newId();
    await db.insert(creditNotes).values({
      id: noteId, creditNoteNo: "CN-TEST-1", invoiceId: missed.invoiceId, kind: "refund", reason: "no-show refunded at billing",
      issuedBy: fx.radiologist.id, issuedAt: at("2026-08-30T12:00:00.000Z"),
      grossPaise: 250_000, discountPaise: 0, taxableBasePaise: 250_000, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, netPaise: 250_000,
    });
    await db.insert(creditNoteLines).values({
      id: newId(), creditNoteId: noteId, invoiceLineId: missed.line, qty: 1,
      grossPaise: 250_000, discountPaise: 0, taxableBasePaise: 250_000, cgstPaise: 0, sgstPaise: 0,
    });
    const again = await placeAndCreateStudy(db, fx, "CT-HEAD", "cr-again", at("2026-08-31T05:00:00.000Z"));
    expect((await study(again.studyId)).invoiceLineId).toBeNull();
  });

  it("a dose above its reference level with no reason is a gap; the RSO is rung with a count, once", async () => {
    const ct = await acquireStudy(db, fx, {
      serviceCode: "CT-HEAD", deviceKey: "ct", idemKey: "drl", dose: true,
      now: at("2026-08-30T05:00:00.000Z"), slot: at("2026-08-30T05:00:00.000Z"),
    });
    await db.update(doseRegister).set({ drlQuantity: "dap", drlValue: "1.000", overDrl: true, drlReason: null })
      .where(and(eq(doseRegister.source, "imaging"), eq(doseRegister.sourceRef, ct.studyId)));

    const read = await registerCompleteness(db, { day: "2026-08-30" });
    expect(read.gaps).toEqual([{ kind: "drl_reason_missing", register: "aerb", studyId: ct.studyId, accessionNo: ct.accessionNo }]);

    const first = await sweepRegisterCompleteness(db, RUN);
    const second = await sweepRegisterCompleteness(db, RUN);
    expect([first.ran, second.ran]).toEqual([true, false]);
    const bells = await db.select().from(alerts).where(eq(alerts.kind, "imaging_register_gaps"));
    expect(bells.map((b) => [b.userId, b.title])).toEqual([[fx.rso.id, "AERB dose register · 2026-08-30"]]);
    expect(bells[0]!.body).not.toContain("Asha Devi");
  });

  it("the digest's bell goes to the HOD station's grant holders when the roster names no head", async () => {
    const registry = new ModuleRegistry();
    registry.install({ key: "radiology", title: "Rad", menu: [], permissions: ["radiology.definitions.manage"], subscriptions: [] });
    await syncPermissions(db, registry);
    await grantPermissionToRole(db, registry, "radiologist", "radiology.definitions.manage");

    const sent = await sendHodDigest(db, RUN);

    expect(sent).toMatchObject({ ran: true, bells: 1 });
    const bells = await db.select().from(alerts).where(eq(alerts.kind, "imaging_hod_digest"));
    expect(bells.map((b) => [b.userId, b.title])).toEqual([[fx.radiologist.id, "Imaging morning digest · 2026-08-30"]]);
  });

  it("the whole morning sweep run twice writes each automation's row once; reminders, off, write none", async () => {
    const absent = await placeAndCreateStudy(db, fx, "CT-HEAD", "all", at("2026-08-29T04:00:00.000Z"));
    await book(absent.studyId, fx.devices.ct!, at("2026-08-30T05:00:00.000Z"), at("2026-08-29T05:00:00.000Z"));

    const first = await runMorningSweep(db, RUN);
    await runMorningSweep(db, new Date(RUN.getTime() + 60_000));

    expect(first.noShows?.marked).toEqual([absent.studyId]);
    const rows = await db.select({ kind: imagingAutomationRuns.kind, day: imagingAutomationRuns.day }).from(imagingAutomationRuns)
      .orderBy(imagingAutomationRuns.kind);
    expect(rows).toEqual([
      { kind: "hod_digest", day: DAY }, { kind: "no_show_sweep", day: DAY }, { kind: "register_completeness", day: DAY },
    ]);
    const digest = (await db.select().from(imagingAutomationRuns).where(eq(imagingAutomationRuns.kind, "hod_digest")))[0]!;
    expect((digest.counts as { noShows: number }).noShows).toBe(1);
    expect(await db.execute(sql`select 1 from notifications where template_key = 'imaging_appointment_reminder'`)).toMatchObject({ rows: [] });
  });
});
