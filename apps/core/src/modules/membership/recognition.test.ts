import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  couponDefinitions, events, membershipInstances, membershipPlans, patients, registrationConfig, roles,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { approveRequest } from "../../kernel/approvals/decisions";
import { requestApproval } from "../../kernel/approvals/requests";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { patientsManifest, registerPatient } from "../patients";
import { registerMembershipApprovalTypes } from "./approval-types";
import { MembershipError } from "./errors";
import { membershipManifest } from "./manifest";
import {
  GRACE_HONOR_APPROVAL_TYPE, GRACE_HONOR_SUBJECT_TYPE, MEMBERSHIP_DISCLOSURE, graceHonor,
  recogniseForActor, resolveInstruments,
} from "./recognition";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 09 T3 — recognition. CRITICAL tier: Book row C4 (grace-honor requires an approval) is built
 * as a mutant beside this file and its isolation line is quoted in the task report.
 *
 * ═══ EVERY PLAN CODE, CARD NUMBER AND PERSON BELOW IS INVENTED HERE (DD3 / O-9) ═══
 * The out-of-git partner book may never be quoted into a tracked file. These fixtures test CLASSES
 * — a merged patient's card, a card the book does not know, a coupon out of its window — and a
 * class does not care which invented name carries it.
 */
const clerk: Actor = { type: "user", id: "clerk-1" };

const PLAN_ID = "01HTESTPLAN00000000000001";
const AT = new Date("2026-09-01T06:00:00Z"); // 11:30 IST — a working morning

/** A benefit term as a commissioning file would carry it: a shape this repo fixes, values invented. */
const PLAN_BENEFITS = [
  { benefitKey: "consult-off", title: "Consultation discount", kind: "percent_bps", value: 1_000, capPaise: 50_000, scope: { serviceCategories: ["consultation"], serviceIds: null } },
];

describe("recognition", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
    await db.insert(membershipPlans).values({
      id: PLAN_ID, code: "INV-PLAN-A", title: "Invented Card", kind: "card",
      benefits: PLAN_BENEFITS, entitlements: {}, validityDays: 365, queuePerk: true, createdBy: "test",
    });
  });

  function registry(): ModuleRegistry {
    const r = new ModuleRegistry();
    r.install(patientsManifest);
    r.install(membershipManifest);
    return r;
  }

  async function userHolding(permissions: string[], roleKeys: string[] = []): Promise<Actor> {
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
    for (const key of roleKeys) {
      await db.insert(roles).values({ key, title: key }).onConflictDoNothing();
      await assignRole(db, { userId: id, roleKey: key, scopeType: "hospital" });
    }
    return { type: "user", id };
  }

  async function issueCard(args: { id: string; cardCode: string; holderName: string; patientId?: string; status?: string; validTo?: Date }): Promise<void> {
    await db.insert(membershipInstances).values({
      id: args.id, planId: PLAN_ID, cardCode: args.cardCode, holderName: args.holderName,
      patientId: args.patientId,
      validFrom: new Date("2026-01-01T00:00:00Z"),
      validTo: args.validTo ?? new Date("2026-12-31T00:00:00Z"),
      status: args.status ?? "active", origin: "import",
    });
  }

  async function mkPatient(name: string, phone: string): Promise<string> {
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, { name, sex: "female", phone }));
    return patient.id;
  }

  // ── the seam T4 consumes ──────────────────────────────────────────────────────────────────

  it("resolves a patient's card and parses its configured benefit terms out of jsonb", async () => {
    const pid = await mkPatient("Nilima Barua", "9700000001");
    await issueCard({ id: "01HCARD0000000000000001", cardCode: "AZ-4471", holderName: "Nilima Barua", patientId: pid });

    const r = await resolveInstruments(db, { patientId: pid, at: AT });

    expect(r.patientId).toBe(pid);
    expect(r.memberships).toHaveLength(1);
    expect(r.memberships[0]).toMatchObject({ cardCode: "AZ-4471", planTitle: "Invented Card", status: "active" });
    expect(r.memberships[0]!.benefits).toEqual([
      {
        benefitKey: "consult-off", title: "Consultation discount", kind: "percent_bps", value: 1_000,
        capPaise: 50_000, scope: { serviceCategories: ["consultation"], serviceIds: null },
      },
    ]);
    // The COMPOSER owns the bill total (relay note 12); a recognition surface has no draft yet.
    expect(r.billGrossPaise).toBe(0);
  });

  it("a PRESENTED card code is recognised with no patient at all — the card is in the room", async () => {
    await issueCard({ id: "01HCARD0000000000000002", cardCode: "AZ-4472", holderName: "Unlinked Holder" });
    const r = await resolveInstruments(db, { presentedCodes: ["az-4472"], at: AT });
    expect(r.patientId).toBeNull();
    expect(r.memberships.map((m) => m.cardCode)).toEqual(["AZ-4472"]);
  });

  /**
   * DD11 — a merge NEVER re-links an instrument, so resolving only forwards would make the card go
   * dark at the counter on the day the hospital tidied its own duplicate records.
   */
  it("DD11 — a card issued to a MERGED-AWAY id is still found under the survivor", async () => {
    const winner = await mkPatient("Nilima Barua", "9700000001");
    const loser = await mkPatient("Nilima Baruah", "9700000002");
    await issueCard({ id: "01HCARD0000000000000003", cardCode: "AZ-4473", holderName: "Nilima Baruah", patientId: loser });
    await mergeApproved(loser, winner);

    const r = await resolveInstruments(db, { patientId: winner, at: AT });
    expect(r.memberships.map((m) => m.cardCode)).toEqual(["AZ-4473"]);

    // …and the loser's own id resolves to the same answer, because it resolves to the survivor.
    const viaLoser = await resolveInstruments(db, { patientId: loser, at: AT });
    expect(viaLoser.patientId).toBe(winner);
    expect(viaLoser.memberships.map((m) => m.cardCode)).toEqual(["AZ-4473"]);
  });

  it("a status the schema does not constrain reads as UNUSABLE, never as active", async () => {
    const pid = await mkPatient("Nilima Barua", "9700000001");
    await issueCard({ id: "01HCARD0000000000000004", cardCode: "AZ-4474", holderName: "Nilima Barua", patientId: pid, status: "frozen-by-a-later-lane" });
    const r = await resolveInstruments(db, { patientId: pid, at: AT });
    expect(r.memberships[0]!.status).toBe("cancelled");
  });

  it("an unreadable benefit blob is a REFUSAL, not a silently empty card", async () => {
    await db.update(membershipPlans).set({ benefits: [{ title: "no key" }] }).where(eq(membershipPlans.id, PLAN_ID));
    const pid = await mkPatient("Nilima Barua", "9700000001");
    await issueCard({ id: "01HCARD0000000000000005", cardCode: "AZ-4475", holderName: "Nilima Barua", patientId: pid });
    await expect(resolveInstruments(db, { patientId: pid, at: AT })).rejects.toThrow(MembershipError);
  });

  // ── the counter's own view ────────────────────────────────────────────────────────────────

  it("E-32 — the honouring response carries the disclosure line and NO money field", async () => {
    const pid = await mkPatient("Nilima Barua", "9700000001");
    await issueCard({ id: "01HCARD0000000000000006", cardCode: "AZ-4476", holderName: "Nilima Barua", patientId: pid });
    const desk = await userHolding(["membership.instrument.recognise", "membership.instrument.read"]);

    const view = await recogniseForActor(db, desk, { patientId: pid, at: AT });

    expect(view.disclosure).toBe(MEMBERSHIP_DISCLOSURE);
    expect(view.disclosure).toMatch(/not insurance/i);
    expect(view.memberships[0]).toMatchObject({ cardCode: "AZ-4476", usable: true, origin: "import", verified: false, queuePerk: true });
    expect(view.memberships[0]!.benefits).toEqual([{ benefitKey: "consult-off", title: "Consultation discount" }]);
    // The guardrail, on the SHAPE: nothing a cashier can read as a sales figure.
    expect(JSON.stringify(view)).not.toMatch(/paise|amount|price|commission|rupee/i);
  });

  it("C1 — a SEALED patient is invisible to the honouring surface too", async () => {
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Nilima Sealed", sex: "female", phone: "9700000009", isConfidential: true, alias: "Guest N" }));
    await issueCard({ id: "01HCARD0000000000000007", cardCode: "AZ-4477", holderName: "Nilima Sealed", patientId: patient.id });
    const desk = await userHolding(["membership.instrument.recognise", "membership.instrument.read"]);

    const view = await recogniseForActor(db, desk, { patientId: patient.id, at: AT });
    expect(view.patientId).toBeNull();
    expect(view.memberships).toEqual([]);

    const cleared = await userHolding(["membership.instrument.recognise", "patients.confidential.read"]);
    const seen = await recogniseForActor(db, cleared, { patientId: patient.id, at: AT });
    expect(seen.memberships.map((m) => m.cardCode)).toEqual(["AZ-4477"]);
  });

  it("a presented coupon carries its OWN CODE as the benefit key, and the reason it cannot be used", async () => {
    await db.insert(couponDefinitions).values({
      id: "01HCOUPON00000000000001", code: "INV-CPN-7", title: "Invented weekend coupon",
      benefit: { kind: "percent", title: "Invented weekend coupon", value: 500 },
      scope: { serviceCategories: null, serviceIds: null },
      minBillPaise: 0, capPaise: 20_000,
      validFrom: new Date("2026-01-01T00:00:00Z"), validTo: new Date("2026-12-31T00:00:00Z"),
      weekdayMask: 0, // no weekday at all — an invented "never" so the reason is deterministic
      createdBy: "test",
    });
    const r = await resolveInstruments(db, { presentedCodes: ["inv-cpn-7"], at: AT });
    expect(r.coupons[0]).toMatchObject({ code: "INV-CPN-7", instanceId: null });
    expect(r.coupons[0]!.benefit).toMatchObject({ benefitKey: "INV-CPN-7", kind: "percent_bps", value: 500, capPaise: 20_000 });

    const desk = await userHolding(["membership.instrument.recognise"]);
    const view = await recogniseForActor(db, desk, { presentedCodes: ["INV-CPN-7"], at: AT });
    expect(view.coupons.map((c) => c.unusableReason)).toEqual(["off_weekday"]);
  });

  // ── O-1 grace-honor ───────────────────────────────────────────────────────────────────────

  async function grantedGraceApproval(cardCode: string, patientId: string, requester: Actor, approver: Actor): Promise<string> {
    const filed = await withTx(db, (tx) =>
      requestApproval(tx, requester, {
        typeKey: GRACE_HONOR_APPROVAL_TYPE,
        subject: { type: GRACE_HONOR_SUBJECT_TYPE, id: cardCode },
        patientId,
        requestNote: "member insists the card is live; the book has not caught up",
      }),
    );
    await approveRequest(db, approver, { approvalId: filed.approvalId, note: "honour it, feed lag" });
    return filed.approvalId;
  }

  /** ═══ BOOK ROW C4 — GRACE-HONOR REQUIRES AN APPROVAL ═══ */
  it("C4 — with NO approvalId at all, the card is refused and no instance is written", async () => {
    const pid = await mkPatient("Nilima Barua", "9700000001");
    const desk = await userHolding(["membership.grace_honor.request"]);

    await expect(
      graceHonor(db, desk, { cardCode: "ZZ-0001", patientId: pid, planId: PLAN_ID, approvalId: "", reason: "feed lag", at: AT }),
    ).rejects.toMatchObject({ code: "grace_honor_approval_required" });

    expect(await db.select().from(membershipInstances)).toEqual([]);
  });

  it("C4 — an approval that is PENDING is refused just as loudly as none", async () => {
    const pid = await mkPatient("Nilima Barua", "9700000001");
    const desk = await userHolding(["membership.grace_honor.request"]);
    const approver = await userHolding([], ["billing_manager"]);
    await registerMembershipApprovalTypes(db, approver);
    const filed = await withTx(db, (tx) =>
      requestApproval(tx, desk, {
        typeKey: GRACE_HONOR_APPROVAL_TYPE,
        subject: { type: GRACE_HONOR_SUBJECT_TYPE, id: "ZZ-0002" },
        patientId: pid,
        requestNote: "asked, not yet decided",
      }),
    );

    await expect(
      graceHonor(db, desk, { cardCode: "ZZ-0002", patientId: pid, planId: PLAN_ID, approvalId: filed.approvalId, reason: "feed lag", at: AT }),
    ).rejects.toMatchObject({ code: "grace_honor_approval_required" });
    expect(await db.select().from(membershipInstances)).toEqual([]);
  });

  it("C4 — an approval granted for a DIFFERENT card does not honour this one", async () => {
    const pid = await mkPatient("Nilima Barua", "9700000001");
    const desk = await userHolding(["membership.grace_honor.request"]);
    const approver = await userHolding([], ["billing_manager"]);
    await registerMembershipApprovalTypes(db, approver);
    const approvalId = await grantedGraceApproval("ZZ-0003", pid, desk, approver);

    await expect(
      graceHonor(db, desk, { cardCode: "ZZ-0004", patientId: pid, planId: PLAN_ID, approvalId, reason: "feed lag", at: AT }),
    ).rejects.toMatchObject({ code: "approval_subject_mismatch" });
    expect(await db.select().from(membershipInstances)).toEqual([]);
  });

  it("O-1 — WITH a granted approval the card is honoured, `origin='grace'`, and it accrues nothing", async () => {
    const pid = await mkPatient("Nilima Barua", "9700000001");
    const desk = await userHolding(["membership.grace_honor.request"]);
    const approver = await userHolding([], ["billing_manager"]);
    await registerMembershipApprovalTypes(db, approver);
    const approvalId = await grantedGraceApproval("ZZ-0005", pid, desk, approver);

    const honoured = await graceHonor(db, desk, {
      cardCode: "ZZ-0005", patientId: pid, planId: PLAN_ID, approvalId, reason: "partner feed lag", at: AT,
    });

    const rows = await db.select().from(membershipInstances).where(eq(membershipInstances.id, honoured.instanceId));
    expect(rows[0]).toMatchObject({ cardCode: "ZZ-0005", origin: "grace", verified: false, status: "active", patientId: pid });
    // C-17 — verification, not honouring, is what gates T6's accrual. The row says so on its face.
    expect(rows[0]!.partnerSaleRef).toBeNull();
    expect(rows[0]!.counterpartyId).toBeNull();

    const spine = await db.select().from(events).where(eq(events.name, "instrument.grace_honored"));
    expect(spine).toHaveLength(1);
    expect(spine[0]!.payload).toMatchObject({
      instanceId: honoured.instanceId, cardCode: "ZZ-0005", patientId: pid, approvalId, reason: "partner feed lag",
    });

    // …and the honoured card is recognised at the counter from that moment on.
    const deskRead = await userHolding(["membership.instrument.recognise"]);
    const view = await recogniseForActor(db, deskRead, { patientId: pid, at: AT });
    expect(view.memberships.map((m) => ({ code: m.cardCode, origin: m.origin }))).toEqual([{ code: "ZZ-0005", origin: "grace" }]);
  });

  /**
   * The merged STATE, shaped in the two columns the resolution actually reads.
   *
   * DISCLOSED, because a shaped fixture is a claim: `resolvePatientId` and `listMergedLoserIds`
   * read exactly `patients.status = 'merged'` and `patients.merged_into_patient_id` and nothing
   * else, so this is the state a real `executeMerge` leaves and the code path under test is the
   * real one. It is shaped rather than driven because the module-isolation lint forbids this file
   * from importing `modules/patients/merge` (only a module's `index.ts` is importable, spec §4)
   * and the merge API is not on that index — the refunds.test.ts `shapeEncounter` precedent.
   */
  async function mergeApproved(loserId: string, winnerId: string): Promise<void> {
    await db.update(patients)
      .set({ status: "merged", mergedIntoPatientId: winnerId })
      .where(eq(patients.id, loserId));
  }
});
