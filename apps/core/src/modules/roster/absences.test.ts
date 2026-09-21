import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  events, permissions, roleAssignments, rolePermissions, roles, staffAbsences, users,
} from "../../kernel/db/schema";
import { RosterError } from "./errors";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import {
  absentUserIds, approveAbsence, attendanceProjection, cancelAbsence, listAbsences,
  markAebasEntered, recordAbsence, recordAbsences, redactReason, rejectAbsence, requestAbsence,
} from "./absences";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PHASE R (R4) — absence, for every member of staff.
 *
 * The three legs a reviewer should read first:
 *
 *   · **a junior resident can have one.** Before this table the only leave in the building was
 *     `opd_doctor_leaves`, keyed on an OPD doctor — so most of the people a roster is about could
 *     not be recorded as away at all (stress test S3);
 *   · **the reason is the approver's, and nobody else's** (D6) — redacted in the READ, so the
 *     caller that forgets cannot be the one that renders it on a noticeboard;
 *   · **the person who asks is not the person who allows**, which is how a ward stops discovering
 *     at 20:00 that it is empty.
 */
describe("roster — absence, and who may read the reason (R4)", () => {
  const HOD = "01USER0000000000000000HOD";
  const JR = "01USER00000000000000000JR";
  const NURSE = "01USER00000000000000NURSE";
  const CLERK = "01USER000000000000000CLRK";
  const hod: Actor = { type: "user", id: HOD };
  const jr: Actor = { type: "user", id: JR };
  const nurse: Actor = { type: "user", id: NURSE };
  const clerk: Actor = { type: "user", id: CLERK };

  let db: Db;
  let teardown: () => Promise<void>;

  const at = (s: string): Date => new Date(`${s}:00+05:30`);
  const WINDOW = { startsAt: at("2026-10-12T00:00"), endsAt: at("2026-10-15T00:00") };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values([
      { key: "medical_superintendent", title: "Medical Superintendent" },
      { key: "opd_admin", title: "OPD admin" },
    ]);
    await db.insert(permissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })),
    );
    await db.insert(rolePermissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })),
    );
    await db.insert(rolePermissions).values({ roleKey: "opd_admin", permission: ROSTER_MANAGE });
    for (const [id, username] of [[HOD, "r.prasad"], [JR, "sandeep.yadav"], [NURSE, "asha.kumari"], [CLERK, "m.singh"]] as const) {
      await db.insert(users).values({ id, username, fullName: username, staffCode: `EMP-${id.slice(-4)}`, passwordHash: "x" });
    }
    await db.insert(roleAssignments).values([
      { id: "RA-HOD", userId: HOD, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null },
      { id: "RA-CLERK", userId: CLERK, roleKey: "opd_admin", scopeType: "hospital", scopeId: null },
    ]);
  });

  const refusal = async (p: Promise<unknown>): Promise<RosterError> => {
    const e = await p.then(() => null, (err: unknown) => err);
    if (!(e instanceof RosterError)) throw new Error(`expected a RosterError, got: ${String(e)}`);
    return e;
  };

  const ask = (actor: Actor, over: Partial<Parameters<typeof requestAbsence>[2]> = {}) =>
    withTx(db, (tx) => requestAbsence(tx, actor, {
      userId: actor.id, kind: "CL", reason: "my father is in ICU at Patna", ...WINDOW, ...over,
    }));

  /* ═══════════════════ S3 — everybody can be away ═══════════════════ */

  it("a JUNIOR RESIDENT, holding nothing and with no OPD doctor row, can file their own absence", async () => {
    const { absenceId } = await ask(jr);
    const [row] = await db.select().from(staffAbsences).where(eq(staffAbsences.id, absenceId));
    expect(row!.userId).toBe(JR);
    expect(row!.status).toBe("requested");
    expect(row!.requestedBy).toBe(JR);
    // ...and so can a nurse, who has no row in any doctor table either.
    await expect(ask(nurse)).resolves.toBeDefined();
  });

  it("filing SOMEBODY ELSE's needs the manage permission, and a clerk who holds it may", async () => {
    const e = await refusal(ask(jr, { userId: NURSE }));
    expect(e.code).toBe("not_permitted");
    expect(e.detail).toMatchObject({ permission: ROSTER_MANAGE });
    await expect(ask(clerk, { userId: NURSE })).resolves.toBeDefined();
  });

  it("no machine files an absence for anybody", async () => {
    for (const type of ["system", "agent"] as const) {
      const e = await refusal(withTx(db, (tx) => requestAbsence(tx, { type, id: HOD }, {
        userId: JR, kind: "CL", ...WINDOW,
      })));
      expect(`${type}: ${e.code}`).toBe(`${type}: act_not_available_to_actor`);
    }
  });

  it("a person's own COPILOT does not file it either — the reason is the most sensitive string here", async () => {
    // The cell is `never` in the matrix (policy.ts): a leave reason is "my father is in ICU", and
    // a copilot that files one has to handle it. The person can file it themselves in as many taps.
    const e = await refusal(withTx(db, (tx) => requestAbsence(
      tx, jr, { userId: JR, kind: "CL", ...WINDOW }, "copilot",
    )));
    expect(e.code).toBe("act_not_available_to_actor");
  });

  /* ═══════════════════ deciding ═══════════════════ */

  it("the person who ASKS is not the person who ALLOWS", async () => {
    const { absenceId } = await ask(jr);
    // the HOD holds publish and may decide
    await expect(withTx(db, (tx) => approveAbsence(tx, hod, absenceId))).resolves.toBeUndefined();

    const second = await ask(hod);
    // ...but not their own, even holding everything
    expect((await refusal(withTx(db, (tx) => approveAbsence(tx, hod, second.absenceId)))).code)
      .toBe("absence_self_approval");
  });

  it("deciding twice is refused, and the decision carries a decider and a DATABASE instant", async () => {
    const { absenceId } = await ask(jr);
    const before = new Date();
    await withTx(db, (tx) => approveAbsence(tx, hod, absenceId));
    const [row] = await db.select().from(staffAbsences).where(eq(staffAbsences.id, absenceId));
    expect(row!.status).toBe("approved");
    expect(row!.approvedBy).toBe(HOD);
    expect(row!.decidedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 60_000);

    expect((await refusal(withTx(db, (tx) => rejectAbsence(tx, hod, absenceId)))).code)
      .toBe("absence_already_decided");
  });

  it("approving needs the publish permission — the manage permission is not enough", async () => {
    const { absenceId } = await ask(jr);
    expect((await refusal(withTx(db, (tx) => approveAbsence(tx, clerk, absenceId)))).code).toBe("not_permitted");
  });

  it("cancelling an APPROVED absence keeps the record of who approved it", async () => {
    // The leg `absences.test.ts` did not have, and the OPD projection test found: cancelling only a
    // REQUESTED absence never exercises a row that already carries a decision, and the CHECK
    // written the obvious way refused exactly that update.
    const { absenceId } = await ask(jr);
    await withTx(db, (tx) => approveAbsence(tx, hod, absenceId));
    await withTx(db, (tx) => cancelAbsence(tx, jr, absenceId));
    const [row] = await db.select().from(staffAbsences).where(eq(staffAbsences.id, absenceId));
    expect(row!.status).toBe("cancelled");
    expect(row!.approvedBy).toBe(HOD);      // the approval HAPPENED, and the record of it is the point
    expect(row!.decidedAt).not.toBeNull();
    // ...and they are no longer counted as away
    expect(await absentUserIds(db, WINDOW.startsAt, WINDOW.endsAt)).toEqual([]);
  });

  it("the taker may cancel their own; a stranger may not", async () => {
    const { absenceId } = await ask(jr);
    expect((await refusal(withTx(db, (tx) => cancelAbsence(tx, nurse, absenceId)))).code).toBe("not_permitted");
    await withTx(db, (tx) => cancelAbsence(tx, jr, absenceId));
    const [row] = await db.select().from(staffAbsences).where(eq(staffAbsences.id, absenceId));
    expect(row!.status).toBe("cancelled");
  });

  /* ═══════════════════ D6 — the reason ═══════════════════ */

  it("only the person, the requester and the approver read the reason; everybody else gets null", async () => {
    const { absenceId } = await ask(jr);
    await withTx(db, (tx) => approveAbsence(tx, hod, absenceId));
    const reason = "my father is in ICU at Patna";

    const own = await listAbsences(db, jr, { userId: JR });
    expect(own[0]!.reason).toBe(reason);
    const approver = await listAbsences(db, hod, { userId: JR });
    expect(approver[0]!.reason).toBe(reason);

    // The senior resident drawing next month's rota has no business with it.
    const stranger = await listAbsences(db, nurse, { userId: JR });
    expect(stranger[0]!.reason).toBeNull();
    expect(stranger[0]!.id).toBe(absenceId); // they still see that the person is AWAY

    // ...and so does a machine, which is the reader that would put it in front of a model.
    const machine = await listAbsences(db, { type: "system", id: "roster-proposer" }, { userId: JR });
    expect(machine[0]!.reason).toBeNull();
  });

  it("redactReason is the one place that decides, and it is pure", async () => {
    const { absenceId } = await ask(jr);
    const [row] = await db.select().from(staffAbsences).where(eq(staffAbsences.id, absenceId));
    expect(redactReason(row!, JR).reason).not.toBeNull();
    expect(redactReason(row!, NURSE).reason).toBeNull();
    expect(redactReason(row!, null).reason).toBeNull();
    // and it does not mutate the row it was given
    expect(row!.reason).not.toBeNull();
  });

  it("NO event carries the reason", async () => {
    const { absenceId } = await ask(jr);
    await withTx(db, (tx) => approveAbsence(tx, hod, absenceId));
    const rows = await db.select().from(events);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain("ICU at Patna");
    expect(rows.map((r) => r.name).sort()).toEqual(["roster.absence_approved", "roster.absence_requested"]);
  });

  /* ═══════════════════ the overlap constraint ═══════════════════ */

  it("nobody is on two APPROVED absences at once — and overlapping REQUESTS are ordinary", async () => {
    const a = await ask(jr);
    const b = await ask(jr, { startsAt: at("2026-10-13T00:00"), endsAt: at("2026-10-16T00:00") });
    // two overlapping requests: normal, and the second is what happens after the first is refused
    await withTx(db, (tx) => approveAbsence(tx, hod, a.absenceId));
    const e = await withTx(db, (tx) => approveAbsence(tx, hod, b.absenceId)).then(() => null, (err: unknown) => err);
    expect(String(e)).toContain("staff_absences_no_overlap_excl");
  });

  /* ═══════════════════ bulk, and the AEBAS mark ═══════════════════ */

  it("a strike is filed for a list of people in one transaction, through the same checked path", async () => {
    const { absenceIds } = await withTx(db, (tx) => recordAbsences(tx, hod, [JR, NURSE], {
      kind: "abstaining", ...WINDOW,
    }));
    expect(absenceIds).toHaveLength(2);
    expect(await absentUserIds(db, WINDOW.startsAt, WINDOW.endsAt)).toEqual([JR, NURSE].sort());
    // the clerk, who holds manage but not publish, cannot
    expect((await refusal(withTx(db, (tx) => recordAbsences(tx, clerk, [JR], { kind: "deputation", ...WINDOW })))).code)
      .toBe("not_permitted");
  });

  it("the AEBAS mark records who filed it and when, and never half", async () => {
    const { absenceId } = await withTx(db, (tx) => recordAbsence(tx, hod, { userId: JR, kind: "EL", ...WINDOW }));
    await withTx(db, (tx) => markAebasEntered(tx, hod, absenceId));
    const [row] = await db.select().from(staffAbsences).where(eq(staffAbsences.id, absenceId));
    expect(row!.aebasEnteredBy).toBe(HOD);
    expect(row!.aebasEnteredAt).not.toBeNull();
  });

  /* ═══════════════════ the projection — a FINDING, never a refusal ═══════════════════ */

  it("projects attendance over the whole term, clipped to it, and never refuses anything", async () => {
    const termStart = at("2026-04-01T00:00");
    const termEnd = at("2027-04-01T00:00");
    // 36 days away inside a 365-day term: ~90 %, above the 80 % bar
    await withTx(db, (tx) => recordAbsence(tx, hod, {
      userId: JR, kind: "EL", startsAt: at("2026-06-01T00:00"), endsAt: at("2026-07-07T00:00"),
    }));
    const ok = await attendanceProjection(db, JR, termStart, termEnd);
    expect(ok.belowThreshold).toBe(false);
    expect(ok.projectedFraction).toBeGreaterThan(0.85);

    // a long absence straddling the term's start counts only the part INSIDE it
    await withTx(db, (tx) => recordAbsence(tx, hod, {
      userId: NURSE, kind: "ML", startsAt: at("2026-01-01T00:00"), endsAt: at("2026-05-01T00:00"),
    }));
    const clipped = await attendanceProjection(db, NURSE, termStart, termEnd);
    expect(Math.round(clipped.absentHours / 24)).toBe(30); // April only, not four months

    // ...and somebody genuinely short is a FINDING: the call still returns, it does not throw
    await withTx(db, (tx) => recordAbsence(tx, hod, {
      userId: NURSE, kind: "ML", startsAt: at("2026-05-01T00:00"), endsAt: at("2026-09-01T00:00"),
    }));
    const short = await attendanceProjection(db, NURSE, termStart, termEnd);
    expect(short.belowThreshold).toBe(true);
    expect(short.thresholdFraction).toBe(0.8);
  });

  /* ═══════════════════ the unchecked writer's call-site census ═══════════════════ */

  it("`recordAbsenceUnchecked` has exactly ONE call site in the tree, and it is the OPD leave seam", async () => {
    // The name is the control, and this is what keeps a second one from appearing quietly. It walks
    // the source rather than trusting a grep in a comment.
    const SRC = resolve(__dirname, "..", "..");
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        const body = readFileSync(full, "utf8");
        // the definition and the re-export live in the roster; a CALL is `(`-suffixed with a `tx`
        if (/recordAbsenceUnchecked\(\s*tx/.test(body)) callers.push(full.slice(SRC.length + 1));
      }
    };
    walk(SRC);
    // TWO, and both are named: the CHECKED front door `recordAbsence`, which is what everything
    // inside the roster uses, and the ONE seam that has its own authority. A third entry appearing
    // here is somebody routing round `requireRosterAct`, which is the whole reason this pins a list
    // rather than a count.
    expect(callers.sort()).toEqual(["modules/opd/leaves.ts", "modules/roster/absences.ts"]);
  });
});
