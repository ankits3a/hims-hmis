import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  coveredMembers, entitlementCounters, entitlementMovements, events, lapsedRestoreChecks, membershipInstances,
  membershipPlans, patientMatchQueue, patients, registrationConfig, roles,
} from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { createUser } from "../../../kernel/auth/identity";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { patientsManifest, registerPatient } from "../../patients";
import { MembershipError } from "../errors";
import { membershipManifest } from "../manifest";
import {
  compareCandidate, dismissMatch, findPatientCandidates, listLapsedRestores, listMatchQueue, maskMobile,
  markLapsedRestoreChecked, resolveMatch,
} from "./match-queue";
import { consumeEntitlements } from "../entitlements";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * PLAN 09 T5 — the reconcile queue. E3's ruling lives in the IMPORTER (it never links); this file
 * is about the other half — the human who does, and everything that constrains them.
 *
 * Every plan code, card, person and note below is INVENTED HERE (DD3 / owner ruling O-9).
 */
const clerk: Actor = { type: "user", id: "clerk-t5q" };
const PLAN_ID = "01HPLANQ0000000000000T5Q";
const INSTANCE_ID = "01HINSTQ000000000000T5Q1";
const AT = new Date("2026-09-01T06:00:00Z");

describe("reconcile queue", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
    await db.insert(membershipPlans).values({
      id: PLAN_ID, code: "PL-INV-Q", title: "Invented queue plan", kind: "card",
      benefits: [], entitlements: {}, validityDays: 365, createdBy: "test",
    });
    await db.insert(membershipInstances).values({
      id: INSTANCE_ID, planId: PLAN_ID, cardCode: "QR-990", holderName: "Sunanda Phatak",
      validFrom: AT, validTo: new Date("2027-09-01T00:00:00Z"), status: "active",
      origin: "import", verified: true, importRowNo: 2,
    });
  });

  function registry(): ModuleRegistry {
    const r = new ModuleRegistry();
    r.install(patientsManifest);
    r.install(membershipManifest);
    return r;
  }

  async function userHolding(permissions: string[]): Promise<Actor> {
    const reg = registry();
    await syncPermissions(db, reg);
    const suffix = Math.random().toString(36).slice(2, 9);
    const { id } = await createUser(db, { username: `u${suffix}`, fullName: "Desk", password: "correct horse battery" });
    if (permissions.length > 0) {
      const roleKey = `r${suffix}`;
      await createRole(db, roleKey, "Test role");
      for (const p of permissions) await grantPermissionToRole(db, reg, roleKey, p);
      await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    }
    void roles;
    return { type: "user", id };
  }

  async function register(name: string, phone: string, opts: { confidential?: boolean } = {}): Promise<string> {
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, {
        name, sex: "female", phone,
        isConfidential: opts.confidential ?? false,
        alias: opts.confidential === true ? "Guest Q" : undefined,
      }));
    return patient.id;
  }

  async function enqueue(candidates: { patientId: string; score: number; why: string }[], reason = "fuzzy_match"): Promise<string> {
    const id = `01HQUEUE00000000000${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    await db.insert(patientMatchQueue).values({
      id, instanceId: INSTANCE_ID, reason, candidates, state: "open",
    });
    return id;
  }

  // ── candidate discovery ─────────────────────────────────────────────────────────────────────

  it("finds a registered patient one edit from the holder, and scores what it found", async () => {
    const near = await register("Sunandaa Phatak", "9700000301");
    await register("Bhalchandra Ketkar", "9700000302"); // nobody's near-match — the negative control
    const found = await findPatientCandidates(db, "Sunanda Phatak");
    expect(found.map((c) => c.patientId)).toEqual([near]);
    expect(found[0]!.score).toBeGreaterThan(0.3);
    /**
     * INDEPENDENT REVIEW, MINOR 3 — the stored reason must NOT carry the matched patient's name.
     * It once read `… resembles registered patient "Sunandaa Phatak"`, which denormalised a
     * confidential fact into another module's table; the reader re-reads names through its own
     * gated map, so the name was redundant as well as leaky. The HOLDER's name (from the partner's
     * file, not from a patient record) stays.
     */
    expect(found[0]!.why).toContain("Sunanda Phatak"); // the holder, from the drop
    expect(found[0]!.why).not.toContain("Sunandaa Phatak"); // the PATIENT, never persisted
  });

  it("folds SCRIPT, so a Devanagari holder finds a Latin-registered patient", async () => {
    const id = await register("Kamala Borakar", "9700000303");
    const found = await findPatientCandidates(db, "कमला बोरकर");
    expect(found.map((c) => c.patientId)).toEqual([id]);
  });

  it("a merged-away patient is not a candidate — linking a card to nobody is worse than not linking", async () => {
    const loser = await register("Sunandaa Phatak", "9700000304");
    const winner = await register("Sunandaa Phatak", "9700000305");
    // The merged state as `resolvePatientId` reads it (the recognition.test.ts precedent): two
    // columns, shaped rather than driven, because the merge API is not on the patients index.
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: winner }).where(eq(patients.id, loser));
    const found = await findPatientCandidates(db, "Sunanda Phatak");
    expect(found.map((c) => c.patientId)).toEqual([winner]);
  });

  // ── the gate ────────────────────────────────────────────────────────────────────────────────

  it("a CONFIDENTIAL candidate is hidden from a reconciler who may not see confidential records", async () => {
    const hidden = await register("Sunandaa Phatak", "9700000306", { confidential: true });
    await enqueue([{ patientId: hidden, score: 0.9, why: "invented" }]);

    const plain = await userHolding(["membership.reconcile.operate"]);
    const [item] = await listMatchQueue(db, plain);
    // The item is still WORK — the holder is real and unlinked — but the candidate is not shown.
    expect(item!.cardCode).toBe("QR-990");
    expect(item!.candidates).toEqual([]);

    const sealed = await userHolding(["membership.reconcile.operate", "patients.confidential.read"]);
    const [seen] = await listMatchQueue(db, sealed);
    expect(seen!.candidates.map((c) => c.patientId)).toEqual([hidden]);
    expect(seen!.candidates[0]!.patientName).toBe("Sunandaa Phatak");
  });

  it("shows the open worklist in arrival order and nothing that is already decided", async () => {
    const p = await register("Sunandaa Phatak", "9700000307");
    const first = await enqueue([{ patientId: p, score: 0.9, why: "invented" }]);
    const second = await enqueue([], "cap_overflow");
    const operator = await userHolding(["membership.reconcile.operate", "patients.confidential.read"]);

    expect((await listMatchQueue(db, operator)).map((i) => i.id)).toEqual([first, second]);
    await dismissMatch(db, operator, { queueItemId: first, note: "a coincidence of names" }, AT);
    expect((await listMatchQueue(db, operator)).map((i) => i.id)).toEqual([second]);
    expect((await listMatchQueue(db, operator, { state: "dismissed" })).map((i) => i.id)).toEqual([first]);
  });

  // ── the decision ────────────────────────────────────────────────────────────────────────────

  it("a HUMAN links the holder, and the link and the decision are recorded together", async () => {
    const p = await register("Sunandaa Phatak", "9700000308");
    const itemId = await enqueue([{ patientId: p, score: 0.87, why: "invented" }]);
    const operator = await userHolding(["membership.reconcile.operate", "patients.confidential.read"]);

    const out = await resolveMatch(db, operator, { queueItemId: itemId, patientId: p, note: "same person" }, AT);
    expect(out).toEqual({ queueItemId: itemId, instanceId: INSTANCE_ID, patientId: p });

    const linked = await db
      .select({ patientId: membershipInstances.patientId })
      .from(membershipInstances)
      .where(eq(membershipInstances.id, INSTANCE_ID));
    expect(linked[0]!.patientId).toBe(p);

    const row = await db.select().from(patientMatchQueue).where(eq(patientMatchQueue.id, itemId));
    expect(row[0]).toMatchObject({
      state: "resolved", resolvedPatientId: p, resolvedBy: operator.id, note: "same person",
    });
    expect(row[0]!.resolvedAt).toEqual(AT);

    const appended = await db.select().from(events).where(eq(events.name, "instrument.holder_linked"));
    expect(appended).toHaveLength(1);
    expect(appended[0]!.payload).toEqual({
      queueItemId: itemId, instanceId: INSTANCE_ID, patientId: p, reason: "fuzzy_match",
    });
  });

  it("refuses a patient the queue row never offered — the client cannot name its own", async () => {
    const offered = await register("Sunandaa Phatak", "9700000309");
    const other = await register("Devyani Ranadive", "9700000310");
    const itemId = await enqueue([{ patientId: offered, score: 0.87, why: "invented" }]);
    const operator = await userHolding(["membership.reconcile.operate", "patients.confidential.read"]);

    await expect(resolveMatch(db, operator, { queueItemId: itemId, patientId: other }, AT))
      .rejects.toMatchObject({ code: "match_candidate_unknown" });
    const still = await db
      .select({ patientId: membershipInstances.patientId })
      .from(membershipInstances)
      .where(eq(membershipInstances.id, INSTANCE_ID));
    expect(still[0]!.patientId).toBeNull();
  });

  it("refuses a candidate this reconciler may not see, even when the row offers it", async () => {
    const hidden = await register("Sunandaa Phatak", "9700000311", { confidential: true });
    const itemId = await enqueue([{ patientId: hidden, score: 0.9, why: "invented" }]);
    const plain = await userHolding(["membership.reconcile.operate"]);
    await expect(resolveMatch(db, plain, { queueItemId: itemId, patientId: hidden }, AT))
      .rejects.toMatchObject({ code: "match_candidate_unknown" });
  });

  it("DD11 — the link follows the merge chain to the SURVIVOR, not to the record that was merged away", async () => {
    const loser = await register("Sunandaa Phatak", "9700000312");
    const winner = await register("Sunandaa Phatak", "9700000313");
    // The candidate was recorded BEFORE the merge; merge never rewrites another module's rows.
    const itemId = await enqueue([{ patientId: loser, score: 0.9, why: "invented" }]);
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: winner }).where(eq(patients.id, loser));
    const operator = await userHolding(["membership.reconcile.operate", "patients.confidential.read"]);

    // The loser is no longer `active`, so the gate refuses it — fail-closed, and the reconciler is
    // told rather than silently given a card pointed at nobody.
    await expect(resolveMatch(db, operator, { queueItemId: itemId, patientId: loser }, AT))
      .rejects.toMatchObject({ code: "match_candidate_unknown" });
  });

  it("a second decision on the same item is refused rather than overwriting the first", async () => {
    const p = await register("Sunandaa Phatak", "9700000314");
    const itemId = await enqueue([{ patientId: p, score: 0.9, why: "invented" }]);
    const operator = await userHolding(["membership.reconcile.operate", "patients.confidential.read"]);
    await resolveMatch(db, operator, { queueItemId: itemId, patientId: p }, AT);
    await expect(resolveMatch(db, operator, { queueItemId: itemId, patientId: p }, AT))
      .rejects.toMatchObject({ code: "match_already_resolved" });
    await expect(dismissMatch(db, operator, { queueItemId: itemId, note: "changed my mind" }, AT))
      .rejects.toThrow(MembershipError);
  });

  it("an unknown queue item is a 404-shaped refusal, never a silent no-op", async () => {
    const operator = await userHolding(["membership.reconcile.operate"]);
    await expect(resolveMatch(db, operator, { queueItemId: "01HNOSUCH00000000000T5Q1", patientId: "x" }, AT))
      .rejects.toMatchObject({ code: "match_candidate_unknown" });
  });

  it("an item whose subject is a COVERED MEMBER links the member, never the instance", async () => {
    const p = await register("Sulochana Wagle", "9700000315");
    const memberId = "01HMEMBERQ0000000000T5Q1";
    await db.insert(coveredMembers).values({
      id: memberId, instanceId: INSTANCE_ID, memberNo: 2, name: "Sulochana Wagle", honoured: true, sourceRowNo: 2,
    });
    const id = `01HQUEUEM0000000000${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    await db.insert(patientMatchQueue).values({
      id, instanceId: INSTANCE_ID, memberId, reason: "fuzzy_match",
      candidates: [{ patientId: p, score: 0.95, why: "invented" }], state: "open",
    });
    const operator = await userHolding(["membership.reconcile.operate", "patients.confidential.read"]);
    await resolveMatch(db, operator, { queueItemId: id, patientId: p }, AT);

    const member = await db.select({ patientId: coveredMembers.patientId }).from(coveredMembers).where(eq(coveredMembers.id, memberId));
    expect(member[0]!.patientId).toBe(p);
    const instance = await db.select({ patientId: membershipInstances.patientId }).from(membershipInstances).where(eq(membershipInstances.id, INSTANCE_ID));
    expect(instance[0]!.patientId).toBeNull(); // the card still belongs to nobody
  });

  // ── DD9 / C5 — the lapsed restore is a FLAG, and this reader is what surfaces it ─────────────

  it("surfaces T4's lapsed restores from the flag, newest first, and ignores ordinary restores", async () => {
    const counterId = "01HCOUNTERQ000000000T5Q1";
    await db.insert(entitlementCounters).values({
      id: counterId, instanceId: INSTANCE_ID, benefitKey: "consult-visits", grantedQty: 2,
      validFrom: AT, validTo: new Date("2027-09-01T00:00:00Z"),
    });
    await db.insert(entitlementMovements).values([
      { id: "01HMOVEQ00000000000T5Q1", counterId, delta: -1, kind: "consume", actorId: "cashier-1" },
      { id: "01HMOVEQ00000000000T5Q2", counterId, delta: 1, kind: "restore", actorId: "cashier-1" },
      { id: "01HMOVEQ00000000000T5Q3", counterId, delta: 1, kind: "restore", lapsedRestore: true, actorId: "cashier-1" },
    ]);
    const shown = await listLapsedRestores(db);
    expect(shown.map((l) => ({ id: l.movementId, card: l.cardCode, key: l.benefitKey }))).toEqual([
      { id: "01HMOVEQ00000000000T5Q3", card: "QR-990", key: "consult-visits" },
    ]);
  });

  // ── UX-AUDIT 2026-09-28 · BOARD — the card beside each patient ──────────────────────────────

  it("BOARD — each candidate carries its side of the comparison, the mobile masked, and a band in words", async () => {
    await db.update(membershipInstances).set({ holderPhone: "9812300127" }).where(eq(membershipInstances.id, INSTANCE_ID));
    const same = await register("Sunanda Phatak", "9812300127");
    const other = await register("Sunita Patil", "9700000401");
    await db.update(patients).set({ district: "Jaipur", dob: new Date("1974-03-14") }).where(eq(patients.id, same));
    await enqueue([
      { patientId: same, score: 0.95, why: "invented" },
      { patientId: other, score: 0.31, why: "invented" },
    ]);
    const operator = await userHolding(["membership.reconcile.operate", "patients.confidential.read"]);
    const [item] = await listMatchQueue(db, operator);
    expect(item!.holder).toMatchObject({ subjectName: "Sunanda Phatak", mobileMasked: "98\u2022\u2022\u2022 \u2022\u2022127", dob: null, sex: null });
    const [a, b] = item!.candidates;
    expect(a).toMatchObject({ district: "Jaipur", dob: "1974-03-14", sex: "female", mobileMasked: "98\u2022\u2022\u2022 \u2022\u2022127", lastVisit: null });
    // The card carries no DOB or sex, so the best a name + mobile can reach is Possible, 2 of 4.
    expect(a!.comparison).toEqual({ name: "agrees", dob: "not_on_card", sex: "not_on_card", mobile: "agrees", agrees: 2, strength: "possible" });
    expect(b!.comparison).toMatchObject({ name: "differs", mobile: "differs", agrees: 0, strength: "weak" });
    // The full number never leaves the server.
    expect(JSON.stringify(item)).not.toContain("9812300127");
  });

  it("BOARD — the band: Strong needs name, DOB and mobile; a differing sex or DOB makes it Weak", () => {
    const card = { name: "Suresh Kumar Yadav", dob: "1974-03-14", sex: "male", phone: "9812300127" };
    expect(compareCandidate(card, { name: "Suresh Kumar Yadav", dob: "1974-03-14", sex: "male", phone: "9812300127" }, 1).strength).toBe("strong");
    expect(compareCandidate(card, { name: "Suresh Yadav", dob: "1997-07-02", sex: "male", phone: "9700000550" }, 0.4))
      .toMatchObject({ name: "agrees", dob: "differs", strength: "weak", agrees: 2 });
    expect(compareCandidate({ ...card, dob: null }, { name: "Suresh Yadav", dob: null, sex: "male", phone: null }, 0.4))
      .toMatchObject({ name: "agrees", mobile: "not_on_record", strength: "possible" });
    expect(maskMobile("+91 98123 00127")).toBe("98\u2022\u2022\u2022 \u2022\u2022127");
    expect(maskMobile(null)).toBeNull();
  });

  it("BOARD — a WEAK link is refused without a stated proof and a confirm, and the proof is saved with the link", async () => {
    const weak = await register("Devyani Ranadive", "9700000402");
    const itemId = await enqueue([{ patientId: weak, score: 0.31, why: "invented" }]);
    const operator = await userHolding(["membership.reconcile.operate", "patients.confidential.read"]);
    await expect(resolveMatch(db, operator, { queueItemId: itemId, patientId: weak }, AT))
      .rejects.toMatchObject({ code: "match_weak_needs_proof" });
    await expect(resolveMatch(db, operator, { queueItemId: itemId, patientId: weak, note: "Saw an ID at the counter" }, AT))
      .rejects.toMatchObject({ code: "match_weak_needs_proof" });
    const unlinked = await db.select({ patientId: membershipInstances.patientId }).from(membershipInstances).where(eq(membershipInstances.id, INSTANCE_ID));
    expect(unlinked[0]!.patientId).toBeNull();

    await resolveMatch(db, operator, {
      queueItemId: itemId, patientId: weak, note: "Saw an ID at the counter — name misspelt by the partner", confirmWeak: true,
    }, AT);
    const row = await db.select().from(patientMatchQueue).where(eq(patientMatchQueue.id, itemId));
    expect(row[0]).toMatchObject({ state: "resolved", note: "Saw an ID at the counter — name misspelt by the partner" });
  });

  it("BOARD — None of these: a preset reason stands alone, \"other\" needs words, and the code is stored", async () => {
    const p = await register("Sunandaa Phatak", "9700000403");
    const first = await enqueue([{ patientId: p, score: 0.9, why: "invented" }]);
    const second = await enqueue([{ patientId: p, score: 0.9, why: "invented" }]);
    const operator = await userHolding(["membership.reconcile.operate", "patients.confidential.read"]);
    await dismissMatch(db, operator, { queueItemId: first, reason: "different_people" }, AT);
    await expect(dismissMatch(db, operator, { queueItemId: second, reason: "other", note: "  " }, AT))
      .rejects.toMatchObject({ code: "match_dismiss_needs_reason" });
    await dismissMatch(db, operator, { queueItemId: second, reason: "other", note: "holder abroad, partner told" }, AT);
    const rows = await db.select().from(patientMatchQueue);
    expect(rows.map((r) => [r.id === first ? "first" : "second", r.dismissReason, r.note]).sort()).toEqual([
      ["first", "different_people", null],
      ["second", "other", "holder abroad, partner told"],
    ]);
  });

  it("BOARD — a lapsed restore reads in words, and Mark checked takes it off the queue once", async () => {
    await db.update(membershipPlans).set({
      benefits: [{ benefitKey: "consult-visits", title: "Free OPD consultation", kind: "percent_bps", value: 10000 }],
    }).where(eq(membershipPlans.id, PLAN_ID));
    const counterId = "01HCOUNTERQ000000000T5Q2";
    await db.insert(entitlementCounters).values({
      id: counterId, instanceId: INSTANCE_ID, benefitKey: "consult-visits", grantedQty: 2,
      validFrom: AT, validTo: new Date("2027-09-01T00:00:00Z"),
    });
    await db.insert(entitlementMovements).values([
      { id: "01HMOVEQ00000000000T5Q4", counterId, delta: 1, kind: "restore", actorId: "cashier-1" },
      { id: "01HMOVEQ00000000000T5Q5", counterId, delta: 1, kind: "restore", lapsedRestore: true, actorId: "cashier-1", reason: "consult cancelled" },
    ]);
    const [shown] = await listLapsedRestores(db);
    expect(shown).toMatchObject({
      movementId: "01HMOVEQ00000000000T5Q5", benefitTitle: "Free OPD consultation", invoiceNo: null,
      givenBackBy: "cashier-1", givenBackReason: "consult cancelled",
    });
    expect(shown!.cardEndedOn).toEqual(new Date("2027-09-01T00:00:00Z"));

    const operator = await userHolding(["membership.reconcile.operate"]);
    await expect(markLapsedRestoreChecked(db, operator, { movementId: "01HMOVEQ00000000000T5Q4" }, AT))
      .rejects.toMatchObject({ code: "lapsed_restore_unknown" }); // an ordinary restore is not a flag
    await markLapsedRestoreChecked(db, operator, { movementId: "01HMOVEQ00000000000T5Q5" }, AT);
    expect(await listLapsedRestores(db)).toEqual([]);
    await expect(markLapsedRestoreChecked(db, operator, { movementId: "01HMOVEQ00000000000T5Q5" }, AT))
      .rejects.toMatchObject({ code: "match_already_resolved" });
    const checks = await db.select().from(lapsedRestoreChecks);
    expect(checks).toEqual([{ movementId: "01HMOVEQ00000000000T5Q5", checkedBy: operator.id, checkedAt: AT }]);
  });

  it("OWNER RULING 28-Sep (pin) — a unit given back to an ENDED card cannot be used while the card stays ended", async () => {
    const counterId = "01HCOUNTERQ000000000T5Q3";
    await db.insert(entitlementCounters).values({
      id: counterId, instanceId: INSTANCE_ID, benefitKey: "consult-visits", grantedQty: 1,
      validFrom: AT, validTo: new Date("2026-09-10T00:00:00Z"),
    });
    await db.insert(entitlementMovements).values([
      { id: "01HMOVEQ00000000000T5Q6", counterId, delta: -1, kind: "consume", actorId: "cashier-1" },
      { id: "01HMOVEQ00000000000T5Q7", counterId, delta: 1, kind: "restore", lapsedRestore: true, reversalOfId: "01HMOVEQ00000000000T5Q6", actorId: "cashier-1" },
    ]);
    await expect(withTx(db, (tx) => consumeEntitlements(tx, clerk, {
      invoiceId: "01HINVQ0000000000000T5Q1", at: new Date("2026-09-20T06:00:00Z"),
      consumes: [{ instanceId: INSTANCE_ID, benefitKey: "consult-visits", invoiceLineId: "01HLINEQ000000000000T5Q1", amountPaise: 0 }],
    }))).rejects.toMatchObject({ code: "counter_lapsed" });
  });
});
