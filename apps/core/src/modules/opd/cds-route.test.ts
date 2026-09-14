import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { addAllergy } from "../patients";
import { withTx } from "../../kernel/db/client";
import { openVisit } from "./encounters";
import { OpdCdsController } from "./opd-cds.controller";
import { recordVitals } from "./vitals";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE CO-PILOT READS THE RECORD, NOT ITS CALLER ═══
 *
 * The dose is a multiplication and one of its operands is a child's weight. If that operand can
 * arrive in a query string, then a stale tab, a copied URL or a bug upstream can put millilitres in
 * a child's mouth — so the route takes an encounter id and reads the weight off that encounter's
 * own chart. These tests pin the wiring: the same syndrome, the same patient, DIFFERENT charted
 * weights, different millilitres, with nothing about the weight in the request.
 */
const NOW = new Date("2026-08-17T04:00:00.000Z");
const adultOk = { heightCm: 165, weightKg: 62, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

describe("GET /opd/cds — suggest and regimen", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let ctl: OpdCdsController;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    deptId = m.deptId;
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: m.roomId });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    ctl = new OpdCdsController(db);
  });

  async function visitFor(weightKg: number, ageYears: number, name = "Asha Devi", phone = "9876543210") {
    /* D-31 / DPDP §9: a known minor cannot be registered without a guardian. The rule is the
       system's and it is right; the fixture supplies one rather than working around it. */
    const guardian = ageYears < 18 ? { guardian: { name: "Sunita Devi", relationship: "mother" as const, phone } } : {};
    const patient = await mkPatient(db, clerk.actor, { name, ageYears, phone, ...guardian });
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, NOW);
    /* A child's chart requires MUAC (the paediatric nutrition measure) — again the system's rule,
       again supplied rather than worked around. */
    const peds = ageYears < 18 ? { muacCm: 14.5 } : {};
    await recordVitals(db, vd.actor, opened.encounter.id, { ...adultOk, weightKg, ...peds }, NOW);
    return { patientId: patient.id, encounterId: opened.encounter.id };
  }

  it("C1: the complaint the owner wrote on the whiteboard ranks URI first, with no patient involved", () => {
    const { items } = ctl.suggest({ complaint: "Fever + Sore Throat + Dry Cough" });
    expect(items[0]!.key).toBe("SYN_URI_01");
    expect(items[0]!.matched).toContain("sore throat");
  });

  it("C2: the millilitres follow the CHARTED weight — 14 kg and 7 kg differ, and neither was sent by the caller", async () => {
    const big = await visitFor(14, 3);
    const small = await visitFor(7, 1, "Ravi Kumar", "9811100022");

    const a = await ctl.regimen(dra.actor, { syndromeKey: "SYN_URI_01", encounterId: big.encounterId });
    const b = await ctl.regimen(dra.actor, { syndromeKey: "SYN_URI_01", encounterId: small.encounterId });

    expect(a.facts.weightKg).toBe(14);
    expect(b.facts.weightKg).toBe(7);
    const paraOf = (r: typeof a) => r.regimen.lines.find((l) => l.drugLabel.startsWith("Paracetamol"))!;
    expect(paraOf(a).dose).toMatchObject({ state: "computed", mg: 175, ml: 3.5 });
    expect(paraOf(b).dose).toMatchObject({ state: "computed", mg: 87.5, ml: 2 });
    expect(a.regimen.band).toBe("pediatric");
  });

  it("C3: an adult's regimen is the adult band, and the allergy on file rewrites it", async () => {
    const v = await visitFor(62, 34);
    await withTx(db, (tx) => addAllergy(tx, clerk.actor, v.patientId, { substance: "Penicillin", severity: "severe", source: "registration" }));

    const r = await ctl.regimen(dra.actor, { syndromeKey: "SYN_URI_01", encounterId: v.encounterId });
    expect(r.regimen.band).toBe("adult");
    expect(r.facts.allergies).toContain("Penicillin");
    expect(r.regimen.lines.some((l) => /amoxicillin/i.test(l.drugLabel))).toBe(false);
    expect(r.cards.find((c) => c.kind === "allergy")!.severity).toBe("red");
  });

  it("C4: pregnancy is UNANSWERED unless the doctor answers it, and the card says which", async () => {
    const v = await visitFor(55, 27);
    const silent = await ctl.regimen(dra.actor, { syndromeKey: "SYN_MSK_07", encounterId: v.encounterId });
    expect(silent.facts.pregnant).toBeNull();
    expect(silent.cards.some((c) => c.kind === "pregnancy_unknown")).toBe(true);

    const answered = await ctl.regimen(dra.actor, { syndromeKey: "SYN_MSK_07", encounterId: v.encounterId, pregnant: "true" });
    expect(answered.facts.pregnant).toBe(true);
    expect(answered.cards.some((c) => c.kind === "pregnancy_unknown")).toBe(false);
    expect(answered.cards.some((c) => c.kind === "pregnancy" && c.severity === "red")).toBe(true);
  });

  it("C5: a chart with no weight yields no dose rather than a default, and says so on a card", async () => {
    const patient = await mkPatient(db, clerk.actor, { name: "Baby Kumar", ageYears: 2, phone: "9811100033", guardian: { name: "Meena Kumar", relationship: "mother", phone: "9811100033" } });
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, NOW);

    const r = await ctl.regimen(dra.actor, { syndromeKey: "SYN_URI_01", encounterId: opened.encounter.id });
    expect(r.facts.weightKg).toBeNull();
    expect(r.regimen.lines.every((l) => l.dose.state !== "computed")).toBe(true);
    expect(r.cards.find((c) => c.kind === "pediatric")!.title).toContain("No weight on file");
  });

  it("C6: an unknown encounter and an unknown syndrome both answer 404, never a 500", async () => {
    const v = await visitFor(62, 34);
    await expect(ctl.regimen(dra.actor, { syndromeKey: "SYN_URI_01", encounterId: "nope" })).rejects.toMatchObject({ status: 404 });
    await expect(ctl.regimen(dra.actor, { syndromeKey: "SYN_NOPE", encounterId: v.encounterId })).rejects.toMatchObject({ status: 404 });
  });
});
