import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { ROLE_MODEL } from "../../../../scripts/seed-roles";
import { grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { authManifest } from "../../../kernel/auth/manifest";
import { withTx } from "../../../kernel/db/client";
import { ipdBedProposals, ipdDepositAlerts } from "../../../kernel/db/schema";
import { loadDesk } from "../../../kernel/desk/registry";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { KERNEL_RESOURCE_KINDS, changeResourceStatus } from "../../../kernel/resources";
import { patientsManifest } from "../../patients";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkDischargeWorld } from "../../../../test/helpers/ipd";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import {
  IPD_BED_FLOW_QUERIES, IPD_CLINICAL_ROLES, assignBed, blockBed, cancelAdmission, declareFit, ipdManifest, readBedFlow, requestAdmission,
  reserveBed,
} from "../index";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { DeskCard, DeskProviderCtx } from "../../../kernel/desk/types";
import type { DischargeWorld } from "../../../../test/helpers/ipd";

/**
 * E5.1 (#738) NOW CARDS and E5.2 (#739) BED FLOW T0 — "DONE MEANS" (plan E5.1, E5.2; spec SPEC-ipd-core §4.8, §4.9 A;
 * decisions 0058, 0072). Every instant is relative to the real clock (minutes back), passed explicitly; no date is pinned.
 *
 *   (i)   Bed Flow proposes only rule-valid beds — never a bed any rule refuses, even when no valid bed is left
 *   (ii)  a stale proposal withdraws (bed blocked, bed taken, request cancelled)
 *   (iii) acceptance and override are logged per proposal and counted per week
 *   (iv)  each card type has its own provider and permission
 *   (v)   a stable patient makes no card
 *   (vi)  a doctor sees no money card (decision 0058)
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();
const NOW = new Date();
const ago = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);
const CARD_KEYS = ["ipd.bed_proposal", "ipd.discharge_blocked", "ipd.deposit_low", "ipd.cleaning_overdue"] as const;
const M4_CARD_KEYS = ["due_dose", "overdue_vitals", "new_order", "ews_rising", "handover_pending", "assessment_due"];

describe("E5.1 Now cards + E5.2 Bed Flow — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: DischargeWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkDischargeWorld(db); });

  const SETUP: Actor = { type: "system", id: "test-now-cards" };
  const request = async (patientId: string, at: Date, over: Record<string, unknown> = {}) => (await requestAdmission(db, w.doctor, {
    idempotencyKey: key(), patientId, source: "direct", consultantId: w.doctor.id, requestedClass: "general", isolation: "none",
    provisionalDiagnosis: "Synthetic fever", mlc: false, department: "MED", ...over,
  }, { now: at })).admissionId;
  const flowFor = async (admissionId: string, at = NOW) => (await readBedFlow(db, w.admitDesk, at)).find((e) => e.admission.id === admissionId)?.proposal ?? null;
  const proposalRows = (admissionId: string) => db.select().from(ipdBedProposals).where(eq(ipdBedProposals.admissionId, admissionId));
  const block = (bedId: string, at = NOW) => blockBed(db, w.dutyManager, {
    idempotencyKey: key(), bedId, reason: "maintenance", note: "Synthetic leak", expectedReturnAt: new Date(at.getTime() + 86_400_000).toISOString(),
  }, { now: at });
  const ctxFor = (actor: Actor, now = NOW): DeskProviderCtx => ({ db, actor, reader: actor, date: "", now });
  const provider = (k: string) => ipdManifest.desk!.find((p) => p.key === k)!;

  it("(i) proposes only beds that pass every bed rule; with none valid, it proposes nothing", async () => {
    const male = await w.patient("male", 40, "Synthetic Ramesh");
    const female = await w.patient("female", 35);
    // Every way a bed can be wrong for a 40-year-old man asking for a general bed:
    await w.bed("T-F1", { genderRule: "female" });                        // gender
    await w.bed("T-ICU1", { class: "icu", icu: true });                   // class + ICU
    await w.bed("T-PED1", { genderRule: "paediatric" });                  // age
    await w.bed("T-OV1", { class: "overflow", overflow: true });          // overflow: the duty manager's own act
    const twinA = await w.bed("T-R1", {}, "room");
    await w.bed("T-R2", {}, "room");                                      // twin room, its other bed held for a woman
    const blocked = await w.bed("T-BL1");
    await block(blocked, ago(30));
    const valid = await w.bed("T-M1", { genderRule: "male" });
    // The twin room's first holder fixes its gender: a woman's request holds T-R1.
    const her = await request(female, ago(50));
    await reserveBed(db, w.admitDesk, { idempotencyKey: key(), admissionId: her, bedId: twinA, patientId: female, need: { requestedClass: "general", isolation: "none", icu: false } }, { now: ago(45) });

    const his = await request(male, ago(40));
    const p = await flowFor(his);
    expect(p).toMatchObject({ bedCode: "T-M1", bedId: valid, admissionId: his, patientId: male });
    expect(p!.reasons).toEqual(expect.arrayContaining(["General ward bed — as requested", "Male bay", "MED ward"]));
    // The held request is not waiting for a bed.
    expect(await flowFor(her)).toBeNull();

    // No valid bed left: Bed Flow proposes nothing rather than the "least wrong" bed.
    await block(valid);
    expect(await flowFor(his)).toBeNull();
    // A bed that becomes valid (an any-gender bed in an ordinary ward) is proposed, and Confirm (reserve_bed) takes it.
    const plain = await w.bed("T-A1");
    const again = await flowFor(his);
    expect(again).toMatchObject({ bedId: plain });
    await expect(reserveBed(db, w.admitDesk, {
      idempotencyKey: key(), admissionId: his, bedId: again!.bedId, patientId: again!.patientId, need: again!.need,
    })).resolves.toMatchObject({ state: "reserved", bedId: plain });
  });

  it("(i b) tie-break: the admitting department's ward before another; the oldest request gets a contested bed", async () => {
    const sur = await w.bed2("T-S1");             // SUR ward, created first (free longer)
    const med = await w.bed("T-MED1");            // MED ward
    const a1 = await request(await w.patient("male"), ago(90), { department: "SUR" });
    const a2 = await request(await w.patient("male"), ago(60));                         // MED
    const a3 = await request(await w.patient("male"), ago(30));                         // MED, youngest
    const flow = await readBedFlow(db, w.admitDesk, NOW);
    const of = (id: string) => flow.find((e) => e.admission.id === id)!.proposal;
    expect([of(a1)?.bedId, of(a2)?.bedId, of(a3)]).toEqual([sur, med, null]);
    // Same answer on the next read: an open, still-valid proposal is kept.
    expect((await flowFor(a2))!.proposalId).toBe(of(a2)!.proposalId);
  });

  it("(ii) a stale proposal withdraws: its bed blocked, its bed taken, its request cancelled", async () => {
    const p = await w.patient("female", 30);
    const a = await request(p, ago(60));
    const bedA = await w.bed("T-W1");
    const bedB = await w.bed("T-W2");
    const first = await flowFor(a, ago(50));
    expect(first?.bedId).toBe(bedA);

    await block(bedA, ago(40));
    const second = await flowFor(a, ago(39));
    expect(second?.bedId).toBe(bedB);
    expect((await proposalRows(a)).find((r) => r.id === first!.proposalId)).toMatchObject({ outcome: "withdrawn", withdrawReason: "bed_blocked" });

    // Another patient is placed on bed B (the E1.1 bed act with a bare request reference).
    const other = await w.patient("male", 50);
    await assignBed(db, w.admitDesk, {
      idempotencyKey: key(), admissionId: newId(), bedId: bedB, patientId: other, need: { requestedClass: "general", isolation: "none", icu: false },
    }, { now: ago(30) });
    expect(await flowFor(a, ago(29))).toBeNull();
    expect((await proposalRows(a)).find((r) => r.id === second!.proposalId)).toMatchObject({ outcome: "withdrawn", withdrawReason: "bed_taken" });

    const bedC = await w.bed("T-W3");
    const third = await flowFor(a, ago(20));
    expect(third?.bedId).toBe(bedC);
    await cancelAdmission(db, w.admitDesk, { idempotencyKey: key(), admissionId: a, reason: "patient_declined" }, { now: ago(10) });
    expect((await proposalRows(a)).find((r) => r.id === third!.proposalId)).toMatchObject({ outcome: "withdrawn", withdrawReason: "admission_cancelled" });
    expect(await db.select().from(ipdBedProposals).where(and(eq(ipdBedProposals.admissionId, a), isNull(ipdBedProposals.endedAt)))).toEqual([]);
  });

  it("(iii) accepted vs overridden is logged per proposal and counted per week", async () => {
    const x = await w.bed("T-X1");
    const y = await w.bed("T-X2");
    const z = await w.bed("T-X3");
    const pa = await w.patient("male");
    const pb = await w.patient("male");
    const a = await request(pa, ago(60));
    const b = await request(pb, ago(50));
    const flow = await readBedFlow(db, w.admitDesk, ago(40));
    const propA = flow.find((e) => e.admission.id === a)!.proposal!;
    const propB = flow.find((e) => e.admission.id === b)!.proposal!;
    expect([propA.bedId, propB.bedId]).toEqual([x, y]);

    // A: Confirm — the proposed bed. B: the desk chose another bed.
    await reserveBed(db, w.admitDesk, { idempotencyKey: key(), admissionId: a, bedId: propA.bedId, patientId: pa, need: propA.need }, { now: ago(30) });
    await reserveBed(db, w.admitDesk, { idempotencyKey: key(), admissionId: b, bedId: z, patientId: pb, need: propB.need }, { now: ago(20) });
    expect((await proposalRows(a))[0]).toMatchObject({ outcome: "accepted", outcomeBedId: x, bedId: x });
    expect((await proposalRows(b))[0]).toMatchObject({ outcome: "overridden", outcomeBedId: z, bedId: y });

    const window = { from: ago(7 * 24 * 60), to: new Date(NOW.getTime() + 60_000) };
    const accepted = await IPD_BED_FLOW_QUERIES.BF1!.run(db, window);
    const overridden = await IPD_BED_FLOW_QUERIES.BF2!.run(db, window);
    expect(accepted).toMatchObject({ status: "measured", value: 50, numerator: 1, denominator: 2 });
    expect(overridden).toMatchObject({ status: "measured", value: 50, numerator: 1, denominator: 2 });
    // The goal's own split is the IST week.
    expect(accepted.status === "measured" && accepted.breakdown!.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.key))).toBe(true);
    // An empty window is no evidence, never 0.
    expect(await IPD_BED_FLOW_QUERIES.BF1!.run(db, { from: ago(60 * 24 * 60), to: ago(59 * 24 * 60) })).toMatchObject({ value: null });
  });

  it("(iv) each card type has its own provider and its own declared permission; the M4 types are not stubbed", async () => {
    const desk = ipdManifest.desk ?? [];
    const perms = CARD_KEYS.map((k) => desk.find((p) => p.key === k)?.permission);
    expect(perms.every((p) => p !== undefined && ipdManifest.permissions!.includes(p))).toBe(true);
    expect(new Set(perms).size).toBe(CARD_KEYS.length);
    expect(Object.fromEntries(CARD_KEYS.map((k, i) => [k, perms[i]]))).toEqual({
      "ipd.bed_proposal": "ipd.beds.manage", "ipd.discharge_blocked": "ipd.discharge.view",
      "ipd.deposit_low": "ipd.billdesk.view", "ipd.cleaning_overdue": "ipd.beds.clean",
    });
    for (const m4 of M4_CARD_KEYS) expect(desk.some((p) => p.key.endsWith(m4))).toBe(false);

    // Each provider answers with ITS card when its fact is present — with the patient's name, UHID and bed.
    const waiting = await w.patient("male", 40, "Synthetic Waiting");
    await w.bed("T-N1");
    await request(waiting, ago(45));
    const { admissionId: fit } = await w.admitAt("general", ago(400));
    await declareFit(db, w.doctor, { idempotencyKey: key(), admissionId: fit, when: "today", disposition: "home" }, { now: ago(200) });
    const { admissionId: owing } = await w.admitAt("general", ago(500));
    await db.insert(ipdDepositAlerts).values({
      id: randomUUID(), admissionId: owing, level: "escalate", thresholdBp: 9_000, usedBp: 9_400, patientPayablePaise: 940_000,
      depositHeldPaise: 1_000_000, firedAt: ago(100),
    });
    const dirty = await w.bed("T-CL1");
    await withTx(db, (tx) => changeResourceStatus(tx, SETUP, KERNEL_RESOURCE_KINDS, dirty, "cleaning", { at: ago(95), reason: "clean:routine" }));

    const cards: Record<string, DeskCard[]> = {};
    for (const k of CARD_KEYS) cards[k] = await provider(k).load(ctxFor(w.dutyManager));
    for (const k of CARD_KEYS) expect([k, cards[k]!.map((c) => c.key)]).toEqual([k, [k]]);
    expect(cards["ipd.bed_proposal"]![0]!.rows![0]).toMatchObject({ id: expect.any(String), title: "Synthetic Waiting", subtitle: expect.stringMatching(/^.+ · Bed T-N1 · waiting 45 min$/), severity: "hot" });
    expect(cards["ipd.discharge_blocked"]![0]!.rows![0]).toMatchObject({ id: fit, subtitle: expect.stringMatching(/C-GENERAL-\d+ · Waiting: .+ · 200 min$/), severity: "hot" });
    expect(cards["ipd.deposit_low"]![0]!.rows![0]).toMatchObject({ id: owing, subtitle: expect.stringMatching(/C-GENERAL-\d+ · 94 % of deposit used$/), severity: "hot" });
    expect(cards["ipd.cleaning_overdue"]![0]!.rows![0]).toMatchObject({ id: dirty, title: "T-CL1", severity: "warn" });
  });

  it("(v) a stable patient makes no card", async () => {
    // Admitted, in a bed, not waiting, not fit for discharge, no live deposit rung; every bed free and clean.
    await w.admitAt("general", ago(600));
    await w.bed("T-FREE1");
    for (const k of CARD_KEYS) expect([k, await provider(k).load(ctxFor(w.dutyManager))]).toEqual([k, []]);
  });

  it("(vi) a doctor sees no money card; the bill desk does (decision 0058)", async () => {
    const { admissionId } = await w.admitAt("general", ago(500));
    await db.insert(ipdDepositAlerts).values({
      id: randomUUID(), admissionId, level: "top_up", thresholdBp: 7_500, usedBp: 8_000, patientPayablePaise: 800_000,
      depositHeldPaise: 1_000_000, firedAt: ago(60),
    });
    // Static: no doctor, nurse or other clinical role of the role model holds the money card's permission.
    const money = provider("ipd.deposit_low").permission;
    const clinical = ROLE_MODEL.filter((r) => /doctor|nurse/.test(r.roleKey) || IPD_CLINICAL_ROLES.includes(r.roleKey));
    expect(clinical.map((r) => r.roleKey)).toEqual(expect.arrayContaining(["doctor", "ot_nurse"]));
    expect(clinical.filter((r) => r.permissions.includes(money)).map((r) => r.roleKey)).toEqual([]);

    // Runtime: a person holding every IPD permission the seeded doctor role holds gets no deposit_low card.
    const registry = new ModuleRegistry();
    registry.install(authManifest);
    registry.install(patientsManifest);
    registry.install(ipdManifest);
    await syncPermissions(db, registry);
    await ensureRole(db, "t_seed_doctor");
    const doctorIpd = ROLE_MODEL.find((r) => r.roleKey === "doctor")!.permissions.filter((p) => ipdManifest.permissions!.includes(p));
    expect(doctorIpd.length).toBeGreaterThan(0);
    for (const p of doctorIpd) await grantPermissionToRole(db, registry, "t_seed_doctor", p);
    const doc = (await mkUser(db, "now.doctor", ["t_seed_doctor"])).actor;
    const deskOf = async (actor: Actor) => (await loadDesk(ipdManifest.desk!, ctxFor(actor))).cards.map((c) => c.key);
    expect(await deskOf(doc)).not.toContain("ipd.deposit_low");
    await ensureRole(db, "t_cashier_desk");
    await grantPermissionToRole(db, registry, "t_cashier_desk", money);
    const cashier = (await mkUser(db, "now.cashier", ["t_cashier_desk"])).actor;
    expect(await deskOf(cashier)).toContain("ipd.deposit_low");
  });
});
