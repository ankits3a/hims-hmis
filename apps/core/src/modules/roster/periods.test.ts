import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { events, rosterAssignments, rosterPeriods, users } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { rosterManifest } from "./manifest";
import { assign, draftPeriod, periodWithAssignments, presenceClashes, publishPeriod, unassign } from "./periods";
import { RosterError } from "./errors";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { AssignInput } from "./periods";

/** An IST wall-clock time as an instant. The roster stores instants; the tests THINK in IST, as a ward does. */
const ist = (s: string): Date => new Date(`${s}:00+05:30`);

describe("the roster's periods and its publication gate (Plan 20 T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let sr: Actor; // drafts: holds manage, NOT publish
  let head: Actor; // publishes: holds both
  let nurse: Actor; // holds neither
  let kavita: string;
  let verma: string;

  const OCT = { startsAt: ist("2026-10-01T00:00"), endsAt: ist("2026-11-01T00:00") };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    registry.install(rosterManifest);
    await syncPermissions(db, registry);
    for (const role of ["senior_resident", "unit_head", "junior_resident", "consultant_oncall", "staff_nurse"]) await ensureRole(db, role);
    await grantPermissionToRole(db, registry, "senior_resident", "roster.periods.manage");
    for (const p of rosterManifest.permissions) await grantPermissionToRole(db, registry, "unit_head", p);
    ({ actor: sr } = await mkUser(db, "pooja.mishra", ["senior_resident"]));
    ({ actor: head } = await mkUser(db, "rk.verma", ["unit_head"]));
    ({ actor: nurse } = await mkUser(db, "sr.mary", ["staff_nurse"]));
    ({ id: kavita } = await mkUser(db, "kavita.rao", ["junior_resident"]));
    verma = head.id;
  });

  const draft = (title = "October 2026 — Orthopaedics Unit II", scopeId = "ORTHO-U2", copyFromPeriodId?: string) =>
    withTx(db, (tx) => draftPeriod(tx, sr, { scopeType: "unit", scopeId, title, ...OCT, copyFromPeriodId }));
  const put = (periodId: string, input: Partial<AssignInput> & Pick<AssignInput, "startsAt" | "endsAt">, by: Actor = sr) =>
    withTx(db, (tx) => assign(tx, by, periodId, { userId: kavita, roleKey: "junior_resident", ...input }));
  const publish = (periodId: string, by: Actor = head) => withTx(db, (tx) => publishPeriod(tx, by, periodId));
  const refusal = async (p: Promise<unknown>): Promise<RosterError> => {
    const e = await p.then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(RosterError);
    return e as RosterError;
  };
  const effectiveRows = async (periodId: string) =>
    (await db.select().from(rosterAssignments).where(and(eq(rosterAssignments.periodId, periodId), eq(rosterAssignments.effective, true)))).length;

  /* ═══════════════════ who may ═══════════════════ */

  it("lets the SR draft and fill, and refuses her the publish — two strings, two people", async () => {
    const { periodId, version } = await draft();
    expect(version).toBe(1);
    await put(periodId, { startsAt: ist("2026-10-12T20:00"), endsAt: ist("2026-10-13T08:00") });
    const e = await refusal(publish(periodId, sr));
    expect(e.code).toBe("not_permitted");
    expect(e.detail).toEqual({ permission: "roster.periods.publish" });
  });

  it("refuses somebody who holds neither string, and a system actor, before touching a row", async () => {
    expect((await refusal(withTx(db, (tx) => draftPeriod(tx, nurse, { scopeType: "hospital", title: "x", ...OCT })))).code).toBe("not_permitted");
    expect((await refusal(withTx(db, (tx) => draftPeriod(tx, { type: "system", id: "scheduler" }, { scopeType: "hospital", title: "x", ...OCT })))).code).toBe("not_permitted");
    expect(await db.select().from(rosterPeriods)).toHaveLength(0);
  });

  /* ═══════════════════ windows, not days (D7) ═══════════════════ */

  it("keeps the night of the 31st as ONE duty that ends in November", async () => {
    const { periodId } = await draft();
    await put(periodId, { startsAt: ist("2026-10-31T20:00"), endsAt: ist("2026-11-01T08:00") });
    const { assignments } = await periodWithAssignments(db, periodId);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.endsAt.toISOString()).toBe(ist("2026-11-01T08:00").toISOString());
  });

  it("refuses a duty that STARTS outside its period, on either side", async () => {
    const { periodId } = await draft();
    expect((await refusal(put(periodId, { startsAt: ist("2026-09-30T20:00"), endsAt: ist("2026-10-01T08:00") }))).code).toBe("outside_period");
    // the period's end is EXCLUSIVE: midnight on 1 November belongs to November's roster
    expect((await refusal(put(periodId, { startsAt: ist("2026-11-01T00:00"), endsAt: ist("2026-11-01T08:00") }))).code).toBe("outside_period");
  });

  it("refuses a window that ends at or before it starts, and a 'shift' that is really a wrong date", async () => {
    const { periodId } = await draft();
    expect((await refusal(put(periodId, { startsAt: ist("2026-10-12T20:00"), endsAt: ist("2026-10-12T20:00") }))).code).toBe("invalid_window");
    // 12 Oct 20:00 → 13 NOV 08:00: somebody picked the wrong month
    const e = await refusal(put(periodId, { startsAt: ist("2026-10-12T20:00"), endsAt: ist("2026-11-13T08:00") }));
    expect(e.code).toBe("invalid_window");
    expect(e.message).toContain("typing mistake");
    // …but a week of on-call is a real thing in a one-unit department
    await put(periodId, { userId: verma, roleKey: "consultant_oncall", mode: "call", startsAt: ist("2026-10-05T08:00"), endsAt: ist("2026-10-12T08:00") });
  });

  it("names the person when they have left the hospital, and refuses an unknown role", async () => {
    const { periodId } = await draft();
    await db.update(users).set({ active: false, fullName: "Dr. Kavita Rao" }).where(eq(users.id, kavita));
    const gone = await refusal(put(periodId, { startsAt: ist("2026-10-12T20:00"), endsAt: ist("2026-10-13T08:00") }));
    expect(gone.code).toBe("unknown_user");
    expect(gone.message).toContain("Dr. Kavita Rao no longer works here");
    expect((await refusal(put(periodId, { userId: verma, roleKey: "registrar_of_nothing", startsAt: ist("2026-10-12T20:00"), endsAt: ist("2026-10-13T08:00") }))).code).toBe("unknown_role");
  });

  /* ═══════════════════ the gate (D3) ═══════════════════ */

  it("a draft answers nothing: no row is effective until somebody publishes", async () => {
    const { periodId } = await draft();
    await put(periodId, { startsAt: ist("2026-10-12T20:00"), endsAt: ist("2026-10-13T08:00") });
    expect(await effectiveRows(periodId)).toBe(0);
    const out = await publish(periodId);
    expect(out).toEqual({ version: 1, assignmentCount: 1, supersededPeriodId: null });
    expect(await effectiveRows(periodId)).toBe(1);
    const { period } = await periodWithAssignments(db, periodId);
    expect(period.status).toBe("published");
    expect(period.publishedBy).toBe(head.id);
  });

  it("refuses to publish an EMPTY roster — it would make the answer to 'who is on?' nobody", async () => {
    const { periodId } = await draft();
    const e = await refusal(publish(periodId));
    expect(e.code).toBe("empty_period");
    expect((await periodWithAssignments(db, periodId)).period.status).toBe("draft");
  });

  it("never edits what people are working to: assign and unassign are refused once published", async () => {
    const { periodId } = await draft();
    const { assignmentId } = await put(periodId, { startsAt: ist("2026-10-12T20:00"), endsAt: ist("2026-10-13T08:00") });
    await publish(periodId);
    const add = await refusal(put(periodId, { startsAt: ist("2026-10-15T20:00"), endsAt: ist("2026-10-16T08:00") }));
    expect(add.code).toBe("period_not_draft");
    expect(add.message).toContain("draft a new version");
    expect((await refusal(withTx(db, (tx) => unassign(tx, sr, assignmentId)))).code).toBe("period_not_draft");
    expect((await refusal(publish(periodId))).code).toBe("period_not_draft");
    expect(await effectiveRows(periodId)).toBe(1);
  });

  it("a draft is scratch paper: a duty can be taken off it", async () => {
    const { periodId } = await draft();
    const { assignmentId } = await put(periodId, { startsAt: ist("2026-10-12T20:00"), endsAt: ist("2026-10-13T08:00") });
    await withTx(db, (tx) => unassign(tx, sr, assignmentId));
    expect((await periodWithAssignments(db, periodId)).assignments).toHaveLength(0);
  });

  /* ═══════════════════ v2 supersedes v1, whole, in one transaction ═══════════════════ */

  it("amends by copy: v2 starts as v1, takes over at publish, and v1 is kept exactly as it was", async () => {
    const v1 = await draft();
    await put(v1.periodId, { startsAt: ist("2026-10-12T20:00"), endsAt: ist("2026-10-13T08:00") });
    await put(v1.periodId, { startsAt: ist("2026-10-15T20:00"), endsAt: ist("2026-10-16T08:00") });
    await publish(v1.periodId);

    const v2 = await draft("October 2026 — Orthopaedics Unit II", "ORTHO-U2", v1.periodId);
    expect(v2).toMatchObject({ version: 2, copiedAssignments: 2 });
    // while v2 is a draft, v1 still answers — the SAME person in the SAME windows, twice, and no clash
    expect(await effectiveRows(v1.periodId)).toBe(2);
    expect(await effectiveRows(v2.periodId)).toBe(0);

    const out = await publish(v2.periodId);
    expect(out).toEqual({ version: 2, assignmentCount: 2, supersededPeriodId: v1.periodId });
    expect(await effectiveRows(v1.periodId)).toBe(0);
    expect(await effectiveRows(v2.periodId)).toBe(2);

    const old = await periodWithAssignments(db, v1.periodId);
    expect(old.period.status).toBe("superseded");
    expect(old.period.supersededByPeriodId).toBe(v2.periodId);
    expect(old.period.publishedAt).not.toBeNull(); // when it WAS the answer is never lost
    expect(old.assignments).toHaveLength(2); // and neither is what it said

    const published = (await db.select().from(events).where(eq(events.name, "roster.period_published")))
      .map((e) => e.payload as { periodId: string; supersededPeriodId: string | null });
    expect(published).toEqual([
      expect.objectContaining({ periodId: v1.periodId, supersededPeriodId: null }),
      expect.objectContaining({ periodId: v2.periodId, supersededPeriodId: v1.periodId }),
    ]);
  });

  it("a failed publish of v2 leaves v1 answering — the supersede and the takeover are one act", async () => {
    const v1 = await draft();
    await put(v1.periodId, { startsAt: ist("2026-10-12T20:00"), endsAt: ist("2026-10-13T08:00") });
    await publish(v1.periodId);
    const v2 = await draft("October 2026 — Orthopaedics Unit II", "ORTHO-U2", v1.periodId);
    // v2 puts Kavita in theatre while she is still on that night: one body, two rooms
    await put(v2.periodId, { startsAt: ist("2026-10-13T07:00"), endsAt: ist("2026-10-13T14:00") });
    expect((await refusal(publish(v2.periodId))).code).toBe("presence_overlap");
    expect((await periodWithAssignments(db, v1.periodId)).period.status).toBe("published");
    expect(await effectiveRows(v1.periodId)).toBe(1);
    expect(await effectiveRows(v2.periodId)).toBe(0);
  });

  it("refuses a copy from a different roster", async () => {
    const ortho = await draft();
    const e = await refusal(draft("October 2026 — Medicine Unit I", "MED-U1", ortho.periodId));
    expect(e.code).toBe("invalid_window");
  });

  /* ═══════════════════ one body, two rooms ═══════════════════ */

  it("on call AND in OPD is not double-booked — that is what on call means", async () => {
    const { periodId } = await draft();
    await put(periodId, { userId: verma, roleKey: "consultant_oncall", mode: "call", startsAt: ist("2026-10-05T08:00"), endsAt: ist("2026-10-06T08:00") });
    await put(periodId, { userId: verma, roleKey: "unit_head", mode: "presence", startsAt: ist("2026-10-05T09:00"), endsAt: ist("2026-10-05T14:00") });
    expect(await presenceClashes(db, periodId)).toEqual([]);
    await publish(periodId);
    expect(await effectiveRows(periodId)).toBe(2);
  });

  it("back-to-back is not overlap: a night that ends at 08:00 and a day that starts at 08:00", async () => {
    const { periodId } = await draft();
    await put(periodId, { startsAt: ist("2026-10-12T20:00"), endsAt: ist("2026-10-13T08:00") });
    await put(periodId, { startsAt: ist("2026-10-13T08:00"), endsAt: ist("2026-10-13T14:00") });
    expect(await presenceClashes(db, periodId)).toEqual([]);
    await publish(periodId); // whether she SHOULD work that morning is the validator's question (20-U U3), not this gate's
  });

  it("names the person and both windows when one roster has them in two places", async () => {
    await db.update(users).set({ fullName: "Dr. Kavita Rao" }).where(eq(users.id, kavita));
    const { periodId } = await draft();
    await put(periodId, { startsAt: ist("2026-10-12T20:00"), endsAt: ist("2026-10-13T08:00") });
    await put(periodId, { startsAt: ist("2026-10-13T07:30"), endsAt: ist("2026-10-13T14:00") });
    const e = await refusal(publish(periodId));
    expect(e.code).toBe("presence_overlap");
    expect(e.message).toContain("Dr. Kavita Rao would have to be in two places at once — twice in this roster");
    expect((e.detail as { clashes: unknown[] }).clashes).toHaveLength(1);
  });

  it("catches the borrowed resident: a clash with ANOTHER unit's live roster", async () => {
    await db.update(users).set({ fullName: "Dr. Kavita Rao" }).where(eq(users.id, kavita));
    const u2 = await draft();
    await put(u2.periodId, { startsAt: ist("2026-10-12T20:00"), endsAt: ist("2026-10-13T08:00") });
    await publish(u2.periodId);

    const u3 = await draft("October 2026 — Orthopaedics Unit III", "ORTHO-U3");
    await put(u3.periodId, { startsAt: ist("2026-10-12T22:00"), endsAt: ist("2026-10-13T06:00") });
    expect(await presenceClashes(db, u3.periodId)).toHaveLength(1); // visible while still a draft
    const e = await refusal(publish(u3.periodId));
    expect(e.code).toBe("presence_overlap");
    expect(e.message).toContain('here and in "October 2026 — Orthopaedics Unit II"');
    expect(await effectiveRows(u2.periodId)).toBe(1); // Unit II's roster is untouched
  });

  it("two DRAFTS may hold the same person in the same window; only live rows collide", async () => {
    const a = await draft();
    const b = await draft("October 2026 — Orthopaedics Unit III", "ORTHO-U3");
    await put(a.periodId, { startsAt: ist("2026-10-12T20:00"), endsAt: ist("2026-10-13T08:00") });
    await put(b.periodId, { startsAt: ist("2026-10-12T20:00"), endsAt: ist("2026-10-13T08:00") });
    expect(await presenceClashes(db, a.periodId)).toEqual([]);
    await publish(a.periodId);
    expect((await refusal(publish(b.periodId))).code).toBe("presence_overlap");
  });
});
