import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { setupRadiologyFixture, studyTypeRow } from "../../../test/helpers/radiology";
import { istDayString } from "../../kernel/approvals/cumulative";
import { handleOrderPlaced } from "./consumers";
import { placeImagingOrder } from "./place";
import { PCPNDT_PERMISSIONS } from "../../../test/helpers/pcpndt";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { imagingDefinitions, imagingStudies, pcpndtFormFSerials } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { addMachine, addPerson, createRegistration, openFormF, recordFormF, verifyFormF } from "../pcpndt";
import { recordAcquired, startAcquisition } from "./acquisition";
import { checkIn } from "./checkin";
import { evaluateReadiness, requireStudyGate, satisfyGate } from "./gates";
import { cancelStudy, scheduleStudy } from "./schedule";
import { formFRegister, istMonthWindow, monthlyReturn } from "./pcpndt-books";
import { closeFormFGate } from "./usg-room";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS7 T4 — the Form F register by serial and the monthly return, read from real rows.
 */
describe("the PCPNDT books: register by serial, monthly return (18-S RS7)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let incharge: Actor;

  /**
   * The REAL clock, deliberately. A Form F's opening instant is `pcpndt_form_f.created_at`, which
   * the database stamps (and the immutability trigger then freezes), so the register's month is the
   * wall clock's month. Every other instant in this suite is derived from the same `NOW`, so the
   * two cannot disagree (memory: fixed-date fixture + real clock = time bomb).
   */
  const NOW = new Date();
  const DAY = istDayString(NOW);
  const MONTH = DAY.slice(0, 7);
  const SLOT = new Date(NOW.getTime() + 3_600_000);
  const FULL_SECTIONS = {
    relative_name: "Manoj Kumar", living_children: { sons: 0, daughters: 1 }, lmp: "2026-04-13",
    patient_declaration: { obtained_at: NOW.toISOString(), language: "hi" },
  };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
    lastItem = null;
    const registry = new ModuleRegistry();
    registry.install({ key: "pcpndt", title: "PCPNDT", menu: [], permissions: [...PCPNDT_PERMISSIONS], subscriptions: [] });
    await syncPermissions(db, registry);
    await ensureRole(db, "pcpndt_incharge");
    for (const p of PCPNDT_PERMISSIONS) await grantPermissionToRole(db, registry, "pcpndt_incharge", p);
    for (const p of ["pcpndt.form_f.write", "pcpndt.form_f.read"]) await grantPermissionToRole(db, registry, "radiographer", p);
    ({ actor: incharge } = await mkUser(db, "pndt.books", ["pcpndt_incharge"]));
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
  afterEach(() => { fx.unregister(); });

  let seq = 0;
  let lastItem: string | null = null;
  /** One imaging order per call, at NOW; the second and later name the first as a deliberate repeat. */
  const place = async () => {
    const placed = await placeImagingOrder(db, fx.doctor, fx.decls, {
      patientId: fx.patientId, encounterNo: fx.visitNo, serviceDate: fx.serviceDate,
      orderingClinicianId: "dr-consultant", indication: "dating",
      items: [{
        serviceId: fx.services["USG-ABDO"]!,
        ...(lastItem === null ? {} : { duplicateOfItemId: lastItem, duplicateReason: "second patient slot in this suite" }),
      }],
      placedAt: NOW,
    } as never, `bk${String(seq)}`, NOW);
    lastItem = placed.itemIds[0]!;
    const created = await withTx(db, (tx) => handleOrderPlaced(tx, {
      orderId: placed.orderId, orderNo: placed.orderNo, kind: "imaging",
      patientId: fx.patientId, encounterNo: fx.visitNo, groupId: placed.orderId, itemIds: placed.itemIds,
    }));
    return { studyId: created[0]!.studyId };
  };
  /** A PCPNDT study on the ultrasound, checked in, with its Form F OPENED (the gate needs one). */
  const withOpenForm = async () => {
    seq += 1;
    const study = await place();
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices.usg!, scheduledAt: new Date(SLOT.getTime() + seq * 3_600_000),
    }));
    const checked = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    const opened = await withTx(db, (tx) => openFormF(tx, fx.radiographer, {
      studyId: study.studyId, patientId: fx.patientId, deviceResourceId: fx.devices.usg!,
      indicationCode: "ii", applicability: "pregnant", now: NOW,
    }));
    const evidence: Record<string, unknown> = {
      identity_two_factor: { secondIdentifier: "uhid", value: "HMS-00000001-5" },
      pregnancy_screen: { declared: true, lmpDate: new Date(NOW.getTime() - 10 * 86_400_000).toISOString() },
      laterality_confirm: { patientStated: "na" },
      chaperone_present: { chaperoneUserId: fx.doctor.id },
    };
    for (const kind of checked.gates) {
      const gate = await requireStudyGate(db, study.studyId, kind);
      await withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, evidence[kind] ?? {}, NOW));
    }
    await withTx(db, (tx) => evaluateReadiness(tx, study.studyId));
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    return { ...study, formFId: opened.formFId };
  };
  const record = (formFId: string, sections: Record<string, unknown> = FULL_SECTIONS) =>
    withTx(db, (tx) => recordFormF(tx, fx.radiographer, {
      formFId, sections, declaration: { signature_kind: "signature" }, referral: { self_referral: true },
    }));
  const scan = async (studyId: string) => {
    await withTx(db, (tx) => startAcquisition(tx, fx.radiographer, fx.decls, { studyId, now: NOW }));
    await withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, { studyId, imageSource: "no_pacs_images", now: NOW }));
  };

  it("the IST month window: 1 Sep 00:00 IST is 31 Aug 18:30 UTC", () => {
    const at = new Date("2026-08-31T06:00:00.000Z");
    const w = istMonthWindow("2026-09", at);
    expect(w.start.toISOString()).toBe("2026-08-31T18:30:00.000Z");
    expect(w.end.toISOString()).toBe("2026-09-30T18:30:00.000Z");
    expect(istMonthWindow(undefined, at).month).toBe("2026-08");
    /** 31 Aug 20:00 UTC is 1 Sep 01:30 IST — September's book. */
    expect(istMonthWindow(undefined, new Date("2026-08-31T20:00:00.000Z")).month).toBe("2026-09");
    expect(() => istMonthWindow("2026-13", at)).toThrow(/YYYY-MM/);
  });

  it("the register lists serials with state and missing fields — and NO patient field", async () => {
    const a = await withOpenForm();   // recorded + verified + scanned
    await record(a.formFId);
    await withTx(db, (tx) => verifyFormF(tx, incharge, a.formFId));
    await scan(a.studyId);
    const b = await withOpenForm();   // recorded, not verified, incomplete
    await record(b.formFId, { relative_name: "Sanjay" });
    const c = await withOpenForm();   // opened, then the study cancelled — serial kept
    await withTx(db, (tx) => cancelStudy(tx, fx.radiologist, fx.decls, { studyId: c.studyId, reason: "patient left" }));

    const book = await formFRegister(db, { month: MONTH, now: NOW });
    const byId = Object.fromEntries(book.rows.map((r) => [r.formFId, r]));
    expect(byId[a.formFId]).toMatchObject({ state: "verified", missing: [] });
    expect(byId[b.formFId]).toMatchObject({ state: "recorded" });
    expect(byId[b.formFId]!.missing).toEqual(["living_children", "lmp_or_weeks", "patient_declaration"]);
    expect(byId[c.formFId]).toMatchObject({ state: "cancelled" });
    expect(byId[c.formFId]!.serial).toMatch(new RegExp(`^[A-Z0-9-]+/${DAY.slice(0, 4)}/0003$`));
    const keys = new Set(book.rows.flatMap((r) => Object.keys(r)));
    for (const k of ["patientId", "patientName", "patientUhid", "name", "uhid", "age"]) expect(keys.has(k)).toBe(false);
    expect(book.serials).toEqual([expect.objectContaining({ year: Number(DAY.slice(0, 4)), minted: 3, gaps: [] })]);
  });

  it("the gap check names a serial the counter handed out with no row behind it", async () => {
    await withOpenForm();
    await db.update(pcpndtFormFSerials).set({ nextNo: 4 })
      .where(and(eq(pcpndtFormFSerials.deviceResourceId, fx.devices.usg!), eq(pcpndtFormFSerials.year, Number(DAY.slice(0, 4)))));
    const book = await formFRegister(db, { month: MONTH, now: NOW });
    expect(book.serials[0]).toMatchObject({ minted: 3, gaps: [2, 3] });
  });

  it("the monthly return counts per machine, lists the discrepancies, gives the 5th and a CSV", async () => {
    const a = await withOpenForm();
    await record(a.formFId);
    await withTx(db, (tx) => verifyFormF(tx, incharge, a.formFId));
    await scan(a.studyId);
    const b = await withOpenForm();
    await record(b.formFId);
    await scan(b.studyId);             // scanned; recorded, not verified
    await withOpenForm();              // opened, not scanned

    const ret = await monthlyReturn(db, { month: MONTH, now: NOW });
    const [y, m] = MONTH.split("-").map(Number) as [number, number];
    expect(ret.dueBy).toBe(m === 12 ? `${String(y + 1)}-01-05` : `${String(y)}-${String(m + 1).padStart(2, "0")}-05`);
    expect(ret.daysLeft).toBe(Math.round((Date.parse(`${ret.dueBy}T00:00:00Z`) - Date.parse(`${DAY}T00:00:00Z`)) / 86_400_000));
    const usg = ret.machines.find((m) => m.deviceResourceId === fx.devices.usg)!;
    expect(usg).toMatchObject({
      registrationNo: "PNDT/JSR/2025/0042", scans: 2, pcpndtScans: 2, short: 0,
      formF: { opened: 3, recorded: 2, verified: 1, open: 1, cancelled: 0 },
    });
    expect(ret.discrepancies.map((d) => d.kind).sort()).toEqual(["open_not_scanned", "recorded_not_verified"]);
    expect(ret.csv.split("\n")[0]).toMatch(/^month,machine,registration_no,ultrasound_scans/);
    expect(ret.csv).toMatch(/TOTAL,,2,2,3,2,1,1,0,0$/);
    const text = JSON.stringify(ret);
    expect(text).not.toMatch(/patient/i);
  });

  it("a PCPNDT scan acquired without a recorded form is a discrepancy the return names (a legacy row)", async () => {
    const a = await withOpenForm();
    /**
     * The acquisition path refuses this today (`assertFormFRecorded`); a study acquired before that
     * guard — or entered on paper during downtime — is what the return must still catch. The form
     * table is immutable, so the legacy state is written on the STUDY side.
     */
    await db.update(imagingStudies).set({ status: "acquired", acquiredAt: NOW, imageSource: "no_pacs_images" })
      .where(eq(imagingStudies.id, a.studyId));
    const ret = await monthlyReturn(db, { month: MONTH, now: NOW });
    expect(ret.totals.short).toBe(1);
    expect(ret.discrepancies.map((d) => d.kind)).toContain("scan_without_recorded_form");
  });

  /* ═══════════════════════ T3 — the room's one gate door ═══════════════════════ */

  it("the sonologist closes the form_f gate from the register — refused with no form, idempotent after", async () => {
    seq += 1;
    const study = await place();
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices.usg!, scheduledAt: SLOT,
    }));
    const checked = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    expect(checked.gates).toContain("form_f");
    const evidence: Record<string, unknown> = {
      identity_two_factor: { secondIdentifier: "uhid", value: "HMS-00000001-5" },
      pregnancy_screen: { declared: true, lmpDate: new Date(NOW.getTime() - 10 * 86_400_000).toISOString() },
      laterality_confirm: { patientStated: "na" },
      chaperone_present: { chaperoneUserId: fx.doctor.id },
    };
    for (const kind of checked.gates.filter((k) => k !== "form_f")) {
      const gate = await requireStudyGate(db, study.studyId, kind);
      await withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, evidence[kind] ?? {}, NOW));
    }
    /** The radiologist holds no `radiology.gates.satisfy`; this door is the form's own. */
    await expect(withTx(db, (tx) => closeFormFGate(tx, fx.radiologist, study.studyId, NOW)))
      .rejects.toMatchObject({ code: "form_f_missing" });
    await withTx(db, (tx) => openFormF(tx, fx.radiographer, {
      studyId: study.studyId, patientId: fx.patientId, deviceResourceId: fx.devices.usg!,
      indicationCode: "ii", applicability: "pregnant", now: NOW,
    }));
    const first = await withTx(db, (tx) => closeFormFGate(tx, fx.radiologist, study.studyId, NOW));
    expect(first).toMatchObject({ state: "ready", open: [] });
    await expect(withTx(db, (tx) => closeFormFGate(tx, fx.radiologist, study.studyId, NOW)))
      .resolves.toMatchObject({ open: [] });
  });
});
