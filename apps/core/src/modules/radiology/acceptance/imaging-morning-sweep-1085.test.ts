import { and, eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { acquireStudy, placeAndCreateStudy, setupRadiologyFixture, studyTypeRow } from "../../../../test/helpers/radiology";
import { openSessionFor, seedBillingBase } from "../../../../test/helpers/billing";
import { PCPNDT_PERMISSIONS } from "../../../../test/helpers/pcpndt";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import {
  doseRegister, events, imagingDefinitions, imagingMediaRequests, imagingStudies, invoices, notifications,
} from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { billingManifest, previewInvoice } from "../../billing";
import { activateVersion, createDraftVersion, setTariffItem, submitVersion, upsertGstCategory } from "../../tariff";
import { addMachine, addPerson, createRegistration, openFormF, recordFormF, verifyFormF } from "../../pcpndt";
import * as radiology from "../index";
import { checkIn } from "../checkin";
import { acknowledgeCritical } from "../criticals";
import { overrideGate, requireStudyGate, satisfyGate, waiveGate, evaluateReadiness } from "../gates";
import { authorisationOf } from "../money";
import { northStar } from "../north-star";
import { placeImagingOrder } from "../place";
import { signReport } from "../report-signature";
import { scheduleStudy } from "../schedule";
import { recordAcquired, startAcquisition } from "../acquisition";
import type { RadiologyFixture } from "../../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1085, spec docs/specs/1085-imaging-morning-sweep.md (owner APPROVED 2026-11-14): the
 * imaging morning sweep, the core half (D1, D3–D12). D2 is the desk's screen, in the web acceptance folder.
 *
 * Every instant is written by hand and passed in; nothing here reads the clock for a rule it asserts. The run
 * is 08:00 IST on 31 August (02:30 UTC); "yesterday" is 30 August IST and "tomorrow" 1 September IST. The new
 * acts are looked up on the module's public index, so before the build each check fails on its own line.
 */

type Fn = (...args: never[]) => Promise<unknown>;
function act<T extends Fn>(name: string): T {
  const fn = (radiology as Record<string, unknown>)[name];
  expect({ name, type: typeof fn }).toEqual({ name, type: "function" });
  return fn as T;
}
type Sweep = (db: Db, now: Date) => Promise<unknown>;
type Switch = (tx: Tx, actor: Actor, input: { kind: string; enabled: boolean; reason: string; now?: Date }) => Promise<unknown>;
type Gap = { kind: string; accessionNo: string; studyId: string };
type Completeness = (db: Db, input: { day: string }) => Promise<{ day: string; gaps: Gap[] }>;
type MediaQueue = (db: Db) => Promise<{ rows: { requestId: string }[] }>;

/** The automation's actor, as the spec names it. */
const AUTOMATION: Actor = { type: "system", id: "radiology-automation" };

const DAY = "2026-08-31";
const YESTERDAY = "2026-08-30";
/** 08:00 IST on the run day. */
const RUN = new Date("2026-08-31T02:30:00.000Z");
const at = (iso: string): Date => new Date(iso);
const PRICES: [string, number][] = [["USG-ABDO", 120_000], ["CT-HEAD", 250_000], ["XR-CHEST", 30_000], ["MRI-BRAIN", 600_000]];

describe("spec #1085 — the imaging morning sweep", () => {
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
  afterEach(() => { fx.unregister(); jest.restoreAllMocks(); });

  const study = async (studyId: string) => (await db.select().from(imagingStudies).where(eq(imagingStudies.id, studyId)))[0]!;
  /** Books a study on its machine, the booking itself made at `bookedAt`. */
  const book = (studyId: string, device: string, slot: Date, bookedAt: Date) =>
    withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, { studyId, deviceResourceId: device, scheduledAt: slot, now: bookedAt } as never));
  const runRows = async (kind: string, day: string) =>
    (await db.execute(sql`select kind, day::text as day, counts from imaging_automation_runs where kind = ${kind} and day = ${day}`)).rows as
      { kind: string; day: string; counts: Record<string, unknown> }[];

  /* ─────────────────────────────── D1 ─────────────────────────────── */

  it("spec #1085 D1: the sweep marks yesterday's never-arrived booking a no-show by the automation actor with a booking-changed event, and leaves a checked-in one alone", async () => {
    const sweepNoShows = act<Sweep>("sweepNoShows");
    const absent = await placeAndCreateStudy(db, fx, "CT-HEAD", "d1-a", at("2026-08-29T04:00:00.000Z"));
    const came = await placeAndCreateStudy(db, fx, "XR-CHEST", "d1-b", at("2026-08-29T04:10:00.000Z"));
    await book(absent.studyId, fx.devices.ct!, at("2026-08-30T05:00:00.000Z"), at("2026-08-29T05:00:00.000Z"));
    await book(came.studyId, fx.devices.xray!, at("2026-08-30T06:00:00.000Z"), at("2026-08-29T05:05:00.000Z"));
    await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: came.studyId, now: at("2026-08-30T05:50:00.000Z") }));

    await sweepNoShows(db, RUN);

    expect((await study(absent.studyId)).status).toBe("no_show");
    expect((await study(came.studyId)).status).toBe("checked_in");
    const changed = await db.select().from(events).where(and(
      eq(events.name, "imaging.booking_changed"), sql`${events.payload}->>'studyId' = ${absent.studyId}`,
    ));
    expect(changed.map((e) => ({ actorType: e.actorType, actorId: e.actorId, act: (e.payload as { act: string }).act })))
      .toEqual([{ actorType: "system", actorId: "radiology-automation", act: "no_show" }]);
    expect((changed[0]!.payload as { reason: string }).reason).toBe("not arrived");
    const untouched = await db.select().from(events).where(and(
      eq(events.name, "imaging.booking_changed"), sql`${events.payload}->>'studyId' = ${came.studyId}`,
    ));
    expect(untouched).toHaveLength(0);
  });

  /* ─────────────────────────────── D3 / D4 ─────────────────────────────── */

  const reminders = async (studyId: string) => (await db.select().from(notifications).where(and(
    eq(notifications.templateKey, "imaging_appointment_reminder"), eq(notifications.refId, studyId),
  )));
  /** A slot at 10:30 IST tomorrow, booked three days ago. */
  const bookedThreeDaysAhead = async (key: string) => {
    const s = await placeAndCreateStudy(db, fx, "CT-HEAD", key, at("2026-08-27T04:00:00.000Z"));
    await book(s.studyId, fx.devices.ct!, at("2026-09-01T05:00:00.000Z"), at("2026-08-28T05:00:00.000Z"));
    return s;
  };

  it("spec #1085 D3: with reminders on, the sweep queues exactly one reminder for a slot tomorrow booked three days ago; a second run queues none", async () => {
    const switchAutomation = act<Switch>("switchAutomation");
    const sendPatientReminders = act<Sweep>("sendPatientReminders");
    const s = await bookedThreeDaysAhead("d3");
    await withTx(db, (tx) => switchAutomation(tx, fx.radiologist, {
      kind: "patient_reminders", enabled: true, reason: "templates approved at Meta and DLT", now: at("2026-08-30T10:00:00.000Z"),
    }));

    await sendPatientReminders(db, RUN);
    expect(await reminders(s.studyId)).toHaveLength(1);
    await sendPatientReminders(db, RUN);
    expect(await reminders(s.studyId)).toHaveLength(1);
  });

  it("spec #1085 D4: with reminders off, the sweep queues none", async () => {
    const sendPatientReminders = act<Sweep>("sendPatientReminders");
    const s = await bookedThreeDaysAhead("d4");

    await sendPatientReminders(db, RUN);
    expect(await reminders(s.studyId)).toHaveLength(0);
    expect(await db.select().from(notifications).where(eq(notifications.templateKey, "imaging_appointment_reminder"))).toHaveLength(0);
  });

  /* ─────────────────────────────── D5 / D6 ─────────────────────────────── */

  it("spec #1085 D5: running the digest twice for one day leaves one digest row", async () => {
    const sendHodDigest = act<Sweep>("sendHodDigest");
    await sendHodDigest(db, RUN);
    await sendHodDigest(db, new Date(RUN.getTime() + 5 * 60_000));
    expect(await runRows("hod_digest", DAY)).toHaveLength(1);
  });

  it("spec #1085 D6: the digest's per-modality counts equal the north-star read for that day, and the row has no patient name or UHID", async () => {
    const sendHodDigest = act<Sweep>("sendHodDigest");
    await placeAndCreateStudy(db, fx, "CT-HEAD", "d6-ct", at("2026-08-30T04:00:00.000Z"));
    await placeAndCreateStudy(db, fx, "XR-CHEST", "d6-xr", at("2026-08-30T05:00:00.000Z"));
    await placeAndCreateStudy(db, fx, "USG-ABDO", "d6-us", at("2026-08-30T06:00:00.000Z"));

    await sendHodDigest(db, RUN);

    const north = await northStar(db, { from: YESTERDAY, to: YESTERDAY, now: RUN });
    expect(north.rows.length).toBeGreaterThanOrEqual(3);
    const row = (await runRows("hod_digest", DAY))[0];
    expect(row).toBeDefined();
    const digest = (row!.counts as { modalities?: { modality: string; source: string; ordered: number }[] }).modalities ?? [];
    const key = (r: { modality: string; source: string; ordered: number }) => `${r.modality}|${r.source}|${String(r.ordered)}`;
    expect(digest.map(key).sort()).toEqual(north.rows.map(key).sort());
    const text = JSON.stringify(row);
    expect(text).not.toContain("Asha Devi");
    expect(text).not.toContain("HMS-00000001-5");
  });

  /* ─────────────────────────────── D7 ─────────────────────────────── */

  describe("Form F completeness", () => {
    let incharge: Actor;
    const FULL = {
      relative_name: "Manoj Kumar", living_children: { sons: 0, daughters: 1 }, lmp: "2026-04-13",
      patient_declaration: { obtained_at: "2026-08-30T04:00:00.000Z", language: "hi" },
    };
    beforeEach(async () => {
      const registry = new ModuleRegistry();
      registry.install({ key: "pcpndt", title: "PCPNDT", menu: [], permissions: [...PCPNDT_PERMISSIONS], subscriptions: [] });
      await syncPermissions(db, registry);
      await ensureRole(db, "pcpndt_incharge");
      for (const p of PCPNDT_PERMISSIONS) await grantPermissionToRole(db, registry, "pcpndt_incharge", p);
      for (const p of ["pcpndt.form_f.write", "pcpndt.form_f.read"]) await grantPermissionToRole(db, registry, "radiographer", p);
      ({ actor: incharge } = await mkUser(db, "pndt.sweep", ["pcpndt_incharge"]));
      const row = (code: string, over: Record<string, unknown>) => studyTypeRow({ code, service_id: fx.services[code]!, ...over });
      await db.update(imagingDefinitions).set({
        body: {
          types: [
            row("USG-ABDO", { modality: "usg", body_part: "obstetric", pcpndt_applicable: true }),
            row("XR-CHEST", { modality: "xray", ionising: true }),
            row("CT-HEAD", { modality: "ct", ionising: true }),
            row("MRI-BRAIN", { modality: "mri" }),
          ],
        },
      }).where(eq(imagingDefinitions.kind, "study_types"));
      const { registrationId } = await withTx(db, (tx) => createRegistration(tx, incharge, {
        site: "Main", registrationNo: "PNDT/JSR/2025/0042", validFrom: "2026-01-01", validTo: "2030-03-31",
      }));
      await withTx(db, (tx) => addMachine(tx, incharge, {
        registrationId, deviceResourceId: fx.devices.usg!, make: "GE", model: "Voluson", serial: "VE8-1",
      }));
      await withTx(db, (tx) => addPerson(tx, incharge, { registrationId, userId: fx.radiographer.id, qualification: "MD" }));
    });

    /** A PCPNDT scan acquired at `when` (yesterday, IST), its Form F recorded with `sections`. */
    const scanned = async (key: string, placedAt: Date, when: Date, sections: Record<string, unknown>, verify: boolean) => {
      const s = await placeAndCreateStudy(db, fx, "USG-ABDO", key, placedAt);
      await book(s.studyId, fx.devices.usg!, when, placedAt);
      const checked = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: s.studyId, now: when }));
      const opened = await withTx(db, (tx) => openFormF(tx, fx.radiographer, {
        studyId: s.studyId, patientId: fx.patientId, deviceResourceId: fx.devices.usg!,
        indicationCode: "ii", applicability: "pregnant", now: when,
      }));
      const evidence: Record<string, unknown> = {
        identity_two_factor: { secondIdentifier: "uhid", value: "HMS-00000001-5", nameStated: true },
        pregnancy_screen: { declared: true, lmpDate: new Date(when.getTime() - 10 * 86_400_000).toISOString() },
        laterality_confirm: { patientStated: "na" },
        chaperone_present: { chaperoneUserId: fx.doctor.id },
      };
      for (const kind of checked.gates) {
        const gate = await requireStudyGate(db, s.studyId, kind);
        await withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, evidence[kind] ?? {}, when));
      }
      await withTx(db, (tx) => evaluateReadiness(tx, s.studyId));
      await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, s.studyId));
      await withTx(db, (tx) => recordFormF(tx, fx.radiographer, {
        formFId: opened.formFId, sections, declaration: { signature_kind: "signature" }, referral: { self_referral: true },
      }));
      if (verify) await withTx(db, (tx) => verifyFormF(tx, incharge, opened.formFId));
      await withTx(db, (tx) => startAcquisition(tx, fx.radiographer, fx.decls, { studyId: s.studyId, now: when }));
      await withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, { studyId: s.studyId, imageSource: "no_pacs_images", now: when }));
      return s;
    };

    it("spec #1085 D7: a Form F study acquired yesterday whose form lacks a field is listed as a gap; a complete one is not", async () => {
      const registerCompleteness = act<Completeness>("registerCompleteness");
      const complete = await scanned("d7-ok", at("2026-08-28T04:00:00.000Z"), at("2026-08-30T05:00:00.000Z"), FULL, true);
      const lacking = await scanned("d7-gap", at("2026-08-29T05:00:00.000Z"), at("2026-08-30T06:00:00.000Z"), { relative_name: "Sanjay" }, true);

      const result = await registerCompleteness(db, { day: YESTERDAY });

      const listed = result.gaps.map((g) => g.accessionNo);
      expect(listed).toContain(lacking.accessionNo);
      expect(listed).not.toContain(complete.accessionNo);
    });
  });

  /* ─────────────────────────────── D8 ─────────────────────────────── */

  it("spec #1085 D8: an ionising study acquired yesterday with no dose row is listed as a gap", async () => {
    const registerCompleteness = act<Completeness>("registerCompleteness");
    const lost = await acquireStudy(db, fx, {
      serviceCode: "XR-CHEST", deviceKey: "xray", idemKey: "d8-xr", dose: true,
      now: at("2026-08-30T05:00:00.000Z"), slot: at("2026-08-30T05:00:00.000Z"),
    });
    const kept = await acquireStudy(db, fx, {
      serviceCode: "CT-HEAD", deviceKey: "ct", idemKey: "d8-ct", dose: true,
      now: at("2026-08-30T06:00:00.000Z"), slot: at("2026-08-30T06:00:00.000Z"),
    });
    /** The register row of the X-ray is lost; the CT keeps its own. */
    await db.delete(doseRegister).where(and(eq(doseRegister.source, "imaging"), eq(doseRegister.sourceRef, lost.studyId)));

    const result = await registerCompleteness(db, { day: YESTERDAY });

    const doseGaps = result.gaps.filter((g) => g.studyId === lost.studyId || g.studyId === kept.studyId).map((g) => g.accessionNo);
    expect(doseGaps).toEqual([lost.accessionNo]);
  });

  /* ─────────────────────────────── D9 ─────────────────────────────── */

  it("spec #1085 D9: turning no_show_sweep off with a reason makes the next sweep mark nothing and appends the switch event", async () => {
    const switchAutomation = act<Switch>("switchAutomation");
    const sweepNoShows = act<Sweep>("sweepNoShows");
    const absent = await placeAndCreateStudy(db, fx, "CT-HEAD", "d9", at("2026-08-29T04:00:00.000Z"));
    await book(absent.studyId, fx.devices.ct!, at("2026-08-30T05:00:00.000Z"), at("2026-08-29T05:00:00.000Z"));

    await withTx(db, (tx) => switchAutomation(tx, fx.radiologist, {
      kind: "no_show_sweep", enabled: false, reason: "the desk marks no-shows by hand this week", now: at("2026-08-30T12:00:00.000Z"),
    }));
    await sweepNoShows(db, RUN);

    expect((await study(absent.studyId)).status).toBe("scheduled");
    const switched = await db.select().from(events).where(eq(events.name, "imaging.automation_switched"));
    expect(switched.map((e) => e.payload)).toEqual([
      expect.objectContaining({ kind: "no_show_sweep", enabled: false, reason: "the desk marks no-shows by hand this week" }),
    ]);
  });

  /* ─────────────────────────────── D10 ─────────────────────────────── */

  it("spec #1085 D10: the automation actor is refused by gate satisfy, waive and override, by sign, by critical acknowledge and by placing an order", async () => {
    const s = await placeAndCreateStudy(db, fx, "CT-HEAD", "d10", at("2026-08-31T02:00:00.000Z"));
    await book(s.studyId, fx.devices.ct!, at("2026-08-31T04:00:00.000Z"), at("2026-08-31T02:05:00.000Z"));
    const checked = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: s.studyId, now: RUN }));
    const gate = await requireStudyGate(db, s.studyId, checked.gates[0]!);
    const refused = { code: "automation_refused" };

    await expect(withTx(db, (tx) => satisfyGate(tx, AUTOMATION, gate.id, { secondIdentifier: "uhid", value: "HMS-00000001-5" }, RUN)))
      .rejects.toMatchObject(refused);
    await expect(withTx(db, (tx) => waiveGate(tx, AUTOMATION, gate.id, "the machine decided it was fine")))
      .rejects.toMatchObject(refused);
    await expect(withTx(db, (tx) => overrideGate(tx, AUTOMATION, gate.id, "the machine decided it was urgent")))
      .rejects.toMatchObject(refused);
    await expect(withTx(db, (tx) => signReport(tx, AUTOMATION, {
      studyId: s.studyId, reportId: "01REPORT00000000000000001", secondFactorAt: RUN, now: RUN,
    }))).rejects.toMatchObject(refused);
    await expect(withTx(db, (tx) => acknowledgeCritical(tx, AUTOMATION, {
      criticalId: "01CRITICAL0000000000000001", acknowledgedByClinicianId: fx.doctor.id, readBack: "read back", now: RUN,
    }))).rejects.toMatchObject(refused);
    await expect(placeImagingOrder(db, AUTOMATION, fx.decls, {
      patientId: fx.patientId, encounterNo: fx.visitNo, serviceDate: fx.serviceDate, indication: "automated", protocolRef: "sweep",
      items: [{ serviceId: fx.services["MRI-BRAIN"]! }], placedAt: RUN,
    } as never, "d10-place", RUN)).rejects.toMatchObject(refused);
    expect((await db.select().from(imagingStudies)).map((r) => r.studyTypeCode).sort()).toEqual(["CT-HEAD"]);
  });

  /* ─────────────────────────────── D11 ─────────────────────────────── */

  it("spec #1085 D11: the media queue returns unprinted requests oldest first and omits printed ones", async () => {
    const mediaQueue = act<MediaQueue>("mediaQueue");
    const s = await placeAndCreateStudy(db, fx, "XR-CHEST", "d11", at("2026-08-30T04:00:00.000Z"));
    const request = (id: string, kind: string, requestedAt: string, printed: boolean) => ({
      id, studyId: s.studyId, kind, quantity: 1, included: false, requestedBy: fx.radiographer.id, requestedAt: at(requestedAt),
      ...(printed ? { printedBy: fx.radiographer.id, printedAt: at("2026-08-30T09:00:00.000Z") } : {}),
    });
    await db.insert(imagingMediaRequests).values([
      request("01MEDIA0000000000000000003", "cd", "2026-08-30T08:00:00.000Z", false),
      request("01MEDIA0000000000000000002", "film", "2026-08-30T07:00:00.000Z", true),
      request("01MEDIA0000000000000000001", "film", "2026-08-30T06:00:00.000Z", false),
    ]);

    const queue = await mediaQueue(db);

    expect(queue.rows.map((r) => r.requestId)).toEqual(["01MEDIA0000000000000000001", "01MEDIA0000000000000000003"]);
  });

  /* ─────────────────────────────── D12 ─────────────────────────────── */

  it("spec #1085 D12: a paid study marked no-show by the sweep and rebooked within 30 days is authorised by its original invoice and raises no new invoice", async () => {
    const sweepNoShows = act<Sweep>("sweepNoShows");
    const collectAtDesk = act<(db: Db, actor: Actor, input: unknown, key: string, now?: Date) => Promise<{ linked: { invoiceLineId: string }[] }>>("collectAtDesk");

    /* the house's prices, a desk user and an open drawer — the desk counter's own fixture (#1078) */
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
    await approveRequest(db, base.owner, { approvalId: submitted.approvalId, note: "morning sweep fixture" });
    await activateVersion(db, base.activator, draft.versionId, new Date("2026-02-01T00:00:00Z"));
    const registry = new ModuleRegistry();
    const deskRadiology = ["radiology.schedule", "radiology.checkin", "radiology.bill_decisions.manage"];
    registry.install(billingManifest);
    registry.install({ key: "radiology", title: "Rad", menu: [], permissions: deskRadiology, subscriptions: [] });
    await syncPermissions(db, registry);
    await ensureRole(db, "radiology_receptionist");
    for (const p of [...deskRadiology, "billing.invoice.issue", "billing.receipt.record", "billing.session.own"]) {
      await grantPermissionToRole(db, registry, "radiology_receptionist", p);
    }
    const desk = (await mkUser(db, "desk.sweep", ["radiology_receptionist"])).actor;
    await openSessionFor(db, { id: desk.id }, 0);

    /* paid on the 28th, booked for yesterday, never came */
    const paidAt = at("2026-08-28T04:30:00.000Z");
    const first = await placeAndCreateStudy(db, fx, "CT-HEAD", "d12-first", at("2026-08-28T04:00:00.000Z"));
    const priced = await previewInvoice(db, {
      encounterId: fx.visitNo, lines: [{ lineId: `study-${first.studyId}`, serviceId: fx.services["CT-HEAD"]!, qty: 1 }],
    }, paidAt);
    const paid = await collectAtDesk(db, desk, {
      encounterNo: fx.visitNo, studyIds: [first.studyId], addOns: [],
      tender: { mode: "cash", amountPaise: priced.totals.netPayablePaise },
    }, "d12-collect", paidAt);
    const line = paid.linked[0]!.invoiceLineId;
    await book(first.studyId, fx.devices.ct!, at("2026-08-30T05:00:00.000Z"), at("2026-08-28T04:40:00.000Z"));
    await sweepNoShows(db, RUN);
    expect((await study(first.studyId)).status).toBe("no_show");

    /* rebooked the same day: the same study, ordered again */
    const again = await placeAndCreateStudy(db, fx, "CT-HEAD", "d12-again", at("2026-08-31T05:00:00.000Z"));

    const rebooked = await study(again.studyId);
    expect(rebooked.invoiceLineId).toBe(line);
    expect(authorisationOf(rebooked, { intendedPayer: "self" })).toBe("invoice");
    await expect(collectAtDesk(db, desk, {
      encounterNo: fx.visitNo, studyIds: [again.studyId], addOns: [],
      tender: { mode: "cash", amountPaise: priced.totals.netPayablePaise },
    }, "d12-collect-again", at("2026-08-31T05:10:00.000Z"))).rejects.toMatchObject({ code: "not_collectable" });
    expect(await db.select().from(invoices).where(eq(invoices.patientId, fx.patientId))).toHaveLength(1);
  });
});
