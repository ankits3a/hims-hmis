import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { cdsDeskRoutingOutcomes, opdComplaintConcepts, opdComplaintTerms, opdEncounters } from "../../kernel/db/schema";
import { OpdVisitsController } from "./opd-visits.controller";
import { applyRouting, createTriageMemo, isHoldout, PRIOR_LEAD_N } from "./desk-routing";
import type { Db } from "../../kernel/db/client";
import type { TriageResult } from "./triage";

/**
 * #614 (plan P3) — the desk's department suggestion is linked to the visit it became, and the
 * hospital's own completed visits start to answer it: by rule first (red flag, child), the prior
 * after. Through the ROUTE, because the zod body is where an unknown `triageId` would be stripped.
 */

const CONFIG = {
  triage: { baseUrl: null, apiKey: null, model: "none", timeoutMs: 1 },
  triageChooserOrder: [],
  triageChoice: { minConfidence: 0.8, model: "none" },
  decisions: { model: "none" },
  openaiKeyFile: null,
} as never;

describe("desk routing — link, child rule, prior", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let medId: string;
  let pedId: string;
  let patientId: string;
  let ctl: OpdVisitsController;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    medId = m.deptId;
    pedId = m.dept2Id;
    dra = await mkDoctor(db, { username: "dra", departmentId: medId, roomId: m.roomId });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    patientId = (await mkPatient(db, clerk.actor)).id;
    ctl = new OpdVisitsController(db, CONFIG);
    await db.insert(opdComplaintConcepts).values({ key: "itch", label: "Itching", createdBy: "t", updatedBy: "t" });
    await db.insert(opdComplaintTerms).values({ id: "t-itch", conceptKey: "itch", term: "khujli", script: "hinglish", source: "seed", createdBy: "t" });
  });

  const triage = (text: string, ageYears?: number, names?: string[]) =>
    ctl.triage({ text, ...(ageYears === undefined ? {} : { ageYears }), ...(names === undefined ? {} : { names }) }) as Promise<TriageResult & { triageId?: string }>;

  const walkIn = (extra: Record<string, unknown>) =>
    ctl.walkInRoute(clerk.actor, { patient: { existingId: patientId }, departmentId: medId, doctorId: dra.doctorId, ...extra });

  /** `count` earlier adult routings of `conceptKey` whose visit completed in `deptId`. */
  async function history(conceptKey: string, count: number, opts: { holdout?: boolean; source?: "keywords" | "model" | "prior" } = {}) {
    const res = await walkIn({});
    await db.update(opdEncounters).set({ status: "completed" }).where(eq(opdEncounters.id, res.encounter.id));
    await db.insert(cdsDeskRoutingOutcomes).values(Array.from({ length: count }, (_, i) => ({
      id: `h-${res.encounter.id}-${String(i)}`, triageId: `ht-${res.encounter.id}-${String(i)}`,
      encounterId: res.encounter.id, conceptKey, band: "adult", holdout: opts.holdout ?? false,
      suggested: [], source: opts.source ?? "keywords", pickedDepartmentId: medId,
    })));
  }

  it("a triage answer carries a triageId, and the walk-in that sends it back writes ONE outcome row", async () => {
    const t = await triage("khujli", 30);
    expect(typeof t.triageId).toBe("string");
    const res = await walkIn({ triageId: t.triageId });
    const rows = await db.select().from(cdsDeskRoutingOutcomes);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      triageId: t.triageId, encounterId: res.encounter.id, appointmentId: null, conceptKey: "itch",
      band: "adult", pickedDepartmentId: medId, source: t.source,
    });
    expect(rows[0]!.suggested).toEqual(t.suggestions.map((s) => s.departmentId));
    // a replay of the same id writes nothing more
    await walkIn({ triageId: t.triageId });
    expect(await db.select().from(cdsDeskRoutingOutcomes)).toHaveLength(1);
  });

  it("an unknown triageId opens the visit as before and records nothing", async () => {
    const res = await walkIn({ triageId: "never-issued" });
    expect(res.encounter.id).toBeTruthy();
    expect(await db.select().from(cdsDeskRoutingOutcomes)).toHaveLength(0);
  });

  it("a booking that carries the triageId is linked by its appointment", async () => {
    const t = await triage("khujli", 40);
    let slotStart: string | undefined;
    for (let d = 1; d <= 7 && slotStart === undefined; d++) {
      const date = new Date(Date.now() + d * 24 * 3600 * 1000 + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
      slotStart = (await ctl.slots({ doctorId: dra.doctorId, date })).slots[0]?.start.toISOString();
    }
    expect(slotStart).toBeDefined();
    const booked = await ctl.book(clerk.actor, { patientId, doctorId: dra.doctorId, slotStart, triageId: t.triageId });
    const rows = await db.select().from(cdsDeskRoutingOutcomes);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ appointmentId: booked.appointment.id, encounterId: null, pickedDepartmentId: medId });
  });

  it("stores no words: a name typed in the complaint never reaches the row", async () => {
    const t = await triage("Ramesh ko khujli", 30, ["Ramesh Kumar"]);
    await walkIn({ triageId: t.triageId });
    const [row] = await db.select().from(cdsDeskRoutingOutcomes);
    expect(JSON.stringify(row)).not.toMatch(/ramesh|khujli/i);
    expect(row!.conceptKey).toBe("itch");
  });

  it("a red flag answers with no triageId and no suggestion, whatever the prior says", async () => {
    await history("itch", PRIOR_LEAD_N);
    const t = await triage("saans nahi aa rahi", 40);
    expect(t.redFlag).toBeDefined();
    expect(t.suggestions).toEqual([]);
    expect(t.triageId).toBeUndefined();
  });

  it(`the prior answers first at n >= ${String(PRIOR_LEAD_N)} for an adult`, async () => {
    await history("itch", PRIOR_LEAD_N);
    const t = await triage("khujli", 35);
    expect(t.source).toBe("prior");
    expect(t.suggestions[0]!.departmentId).toBe(medId);
  });

  it("below the count, held-out rows, a negation or an unknown age: the prior stays silent", async () => {
    await history("itch", PRIOR_LEAD_N - 1);
    await history("itch", 30, { holdout: true });
    expect((await triage("khujli", 35)).source).not.toBe("prior");
    await history("itch", 1);
    expect((await triage("khujli", 35)).source).toBe("prior");
    expect((await triage("khujli nahi", 35)).source).not.toBe("prior");
    expect((await triage("khujli")).source).not.toBe("prior");
  });

  /* The prior learns from the desk's own choices: a routing the prior itself led would feed it back to itself. */
  it("a routing the prior led is not evidence for the prior", async () => {
    await history("itch", PRIOR_LEAD_N - 1);
    await history("itch", 30, { source: "prior" });
    expect((await triage("khujli", 35)).source).not.toBe("prior");
    await history("itch", 1, { source: "model" });
    expect((await triage("khujli", 35)).source).toBe("prior");
  });

  it("a visit that did not complete is not evidence", async () => {
    const res = await walkIn({});
    await db.insert(cdsDeskRoutingOutcomes).values(Array.from({ length: 25 }, (_, i) => ({
      id: `o-${String(i)}`, triageId: `ot-${String(i)}`, encounterId: res.encounter.id, conceptKey: "itch",
      band: "adult", holdout: false, suggested: [], source: "keywords", pickedDepartmentId: medId,
    })));
    expect((await triage("khujli", 35)).source).not.toBe("prior");
  });

  it("a child goes to Paediatrics first and the prior is never asked", async () => {
    await history("itch", PRIOR_LEAD_N);
    const t = await triage("khujli", 6);
    expect(t.source).not.toBe("prior");
    expect(t.suggestions[0]!.departmentId).toBe(pedId);
  });
});

describe("applyRouting — the rules without a database", () => {
  const depts = [{ id: "A", name: "General Medicine" }, { id: "B", name: "ENT" }, { id: "P", name: "Paediatrics" }];
  const ranked: TriageResult = { suggestions: [{ departmentId: "B", reason: "x", reasonKey: "opdTriage.reason.keywords" }, { departmentId: "A", reason: "y", reasonKey: "opdTriage.reason.keywords" }], source: "keywords" };

  it("n 10–19 only swaps the top two when the prior's department is second", () => {
    const out = applyRouting(ranked, { departments: depts, ageYears: 40, prior: { departmentId: "A", n: 12, share: 0.9 } });
    expect(out.suggestions.map((s) => s.departmentId)).toEqual(["A", "B"]);
    expect(out.source).toBe("prior");
    const not = applyRouting(ranked, { departments: depts, ageYears: 40, prior: { departmentId: "P", n: 12, share: 0.9 } });
    expect(not.suggestions.map((s) => s.departmentId)).toEqual(["B", "A"]);
    expect(not.source).toBe("keywords");
  });

  it("a share below 0.8 or an inactive department is ignored", () => {
    expect(applyRouting(ranked, { departments: depts, ageYears: 40, prior: { departmentId: "A", n: 50, share: 0.7 } }).source).toBe("keywords");
    expect(applyRouting(ranked, { departments: depts, ageYears: 40, prior: { departmentId: "Z", n: 50, share: 1 } }).source).toBe("keywords");
  });

  it("never empties a list it was given, and a child keeps the specialty in slot two", () => {
    const child = applyRouting(ranked, { departments: depts, ageYears: 5, prior: { departmentId: "A", n: 50, share: 1 } });
    expect(child.suggestions.map((s) => s.departmentId)).toEqual(["P", "B", "A"]);
    const noPaeds = applyRouting(ranked, { departments: depts.slice(0, 2), ageYears: 5, prior: null });
    expect(noPaeds.suggestions).toHaveLength(2);
  });

  it("the holdout is stable and about three in ten", () => {
    expect(isHoldout("khujli")).toBe(isHoldout("khujli"));
    const n = Array.from({ length: 1000 }, (_, i) => isHoldout(`complaint ${String(i)}`)).filter(Boolean).length;
    expect(n).toBeGreaterThan(240);
    expect(n).toBeLessThan(360);
  });

  it("the memo hands an id out once and forgets it after two hours", () => {
    let now = 0;
    const memo = createTriageMemo(() => now);
    const memoOf = { suggested: [], source: "keywords" as const, conceptKey: null, band: "adult" as const, holdout: false };
    const a = memo.issue(memoOf);
    expect(memo.take(a)).not.toBeNull();
    expect(memo.take(a)).toBeNull();
    const b = memo.issue(memoOf);
    now = 2 * 60 * 60 * 1000 + 1;
    expect(memo.take(b)).toBeNull();
  });
});
