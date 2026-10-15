import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkOtPatient, seedOtBase } from "../../../test/helpers/ot";
import { withTx } from "../../kernel/db/client";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { createUser } from "../../kernel/auth/identity";
import { orgDepartments, otCases, printJobs, rosterHolidays, users } from "../../kernel/db/schema";
import { renderDocument } from "../../kernel/printing/render";
import { bookCase, registerOtDutyEvidence } from "../ot";
import { seedOrgDepartments, seedRosterPositions } from "./masters";
import { seedUnits, teamByCode } from "./teams";
import { seedRosterRules } from "./rules";
import { addMembership } from "./memberships";
import { assign, draftPeriod, publishPeriod } from "./periods";
import { recordAbsence } from "./absences";
import { RosterError } from "./errors";
import { dutyEvidence, evidencePeople } from "./evidence";
import { printDutyEvidence, registerRosterEvidencePrinting, renderEvidenceHtml } from "./evidence-print";
import type { OtBaseFixture } from "../../../test/helpers/ot";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * 20-U U8 — THE DUTY-EVIDENCE REPORT (RU-3). Four legs, each a property the owner ruled:
 *
 *   1. **it states facts** — the rostered duty, theatre wheel-in/out from the OT record, approved
 *      leave and a declared holiday, day by day, and "no other record held" where there is none;
 *   2. **it draws no conclusion** — not one word of the sheet says a person was or was not at work;
 *   3. **what it never carries** — a phone (the person's or the patient's), a leave's reason or
 *      kind, the patient, the procedure;
 *   4. **who may run it** — publish at the PERSON's department; a head of another department is
 *      refused, and the print job re-asks the act as its requester at claim time.
 */
jest.setTimeout(60_000);

/** Words that would turn a fact into a verdict, in English and in Hindi. */
export const VERDICT_WORDS = /present|absent|attendance|attended|उपस्थित|अनुपस्थित|हाज़िर|हाजिर|गैरहाजिर|ग़ैरहाज़िर|गैर-हाजिर/i;

describe("roster — the duty-evidence report (20-U U8)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let f: OtBaseFixture;
  let SUR: string;
  let MED: string;
  let ms: Actor;
  let hodSur: Actor;
  let hodMed: Actor;
  let reader: Actor;
  const ist = (s: string): Date => new Date(`${s}:00+05:30`);
  const ASK = (who: string) => ({ userIds: [who], from: "2026-09-01", to: "2026-09-05" });
  const NOW = ist("2026-09-10T10:00");

  let unwireOt: () => void;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); unwireOt = registerOtDutyEvidence(); });
  afterAll(async () => { unwireOt(); await teardown(); });

  const mk = async (username: string): Promise<Actor> => {
    const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
    return { type: "user", id };
  };

  beforeEach(async () => {
    await truncateAll(db);
    f = await seedOtBase(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    await createRole(db, "roster_head", "publishes rosters");
    for (const p of ["roster.read", "roster.periods.manage", "roster.periods.publish"]) await grantPermissionToRole(db, registry, "roster_head", p);
    await createRole(db, "roster_reader", "reads rosters");
    await grantPermissionToRole(db, registry, "roster_reader", "roster.read");
    for (const key of ["doctor", "duty_manager", "radiologist", "pathologist", "pharmacy"]) await createRole(db, key, key).catch(() => undefined);
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    await seedUnits(db);
    await seedRosterRules(db, "t");
    const depts = await db.select().from(orgDepartments);
    SUR = depts.find((d) => d.code === "SUR")!.id;
    MED = depts.find((d) => d.code === "MED")!.id;

    ms = await mk("evidence.ms");
    await assignRole(db, { userId: ms.id, roleKey: "roster_head", scopeType: "hospital" });
    hodSur = await mk("hod.surgery");
    await assignRole(db, { userId: hodSur.id, roleKey: "roster_head", scopeType: "department", scopeId: SUR });
    await assignRole(db, { userId: hodSur.id, roleKey: "roster_reader", scopeType: "hospital" });
    hodMed = await mk("hod.medicine");
    await assignRole(db, { userId: hodMed.id, roleKey: "roster_head", scopeType: "department", scopeId: MED });
    await assignRole(db, { userId: hodMed.id, roleKey: "roster_reader", scopeType: "hospital" });
    reader = await mk("ward.reader");
    await assignRole(db, { userId: reader.id, roleKey: "roster_reader", scopeType: "hospital" });

    // The surgeon is a senior resident of a surgical unit, with a phone on file.
    await assignRole(db, { userId: f.surgeon.id, roleKey: "doctor", scopeType: "hospital" });
    await db.update(users).set({ phone: "9876501234", fullName: "Dr. Kavita Sinha" }).where(eq(users.id, f.surgeon.id));
    const team = (await teamByCode(db, "SUR-U1"))!.id;
    await withTx(db, (tx) => addMembership(tx, ms, {
      teamId: team, userId: f.surgeon.id, positionKey: "unit_sr", grade: "senior_resident", roleInTeam: "senior_resident",
      kind: "parent", startsAt: ist("2026-01-01T00:00"),
    }));
    const { periodId } = await withTx(db, (tx) => draftPeriod(tx, ms, {
      scopeType: "team", scopeId: team, departmentId: SUR, teamId: team, title: "September", coversPositions: ["unit_sr"],
      startsAt: ist("2026-09-01T00:00"), endsAt: ist("2026-10-01T00:00"),
    }));
    for (const day of ["2026-09-02", "2026-09-03"]) {
      await withTx(db, (tx) => assign(tx, ms, periodId, {
        userId: f.surgeon.id, positionKey: "unit_sr", departmentId: SUR, teamId: team, mode: "presence", kind: "duty",
        startsAt: ist(`${day}T09:00`), endsAt: ist(`${day}T17:00`),
      }));
    }
    await withTx(db, (tx) => publishPeriod(tx, ms, periodId));

    // The theatre: one case on the 2nd, wheeled in 09:12 and out 11:40 — with a patient who must
    // never reach the sheet.
    const patientId = await mkOtPatient(db, f.coordinator, "Sunita Devi", { phone: "9800001111" });
    const r = await bookCase(db, f.coordinator, {
      patientId, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id, listDate: "2026-09-02", payerClass: "self_pay",
    });
    await db.update(otCases).set({ wheelIn: ist("2026-09-02T09:12"), wheelOut: ist("2026-09-02T11:40") }).where(eq(otCases.id, r.caseId));

    // Approved medical leave on the 4th, with a reason only its approver may read.
    await withTx(db, (tx) => recordAbsence(tx, ms, {
      userId: f.surgeon.id, kind: "ML", reason: "piles surgery at Patna", startsAt: ist("2026-09-04T00:00"), endsAt: ist("2026-09-05T00:00"),
    }));
    // A gazetted holiday on the 5th.
    await db.insert(rosterHolidays).values({ istDate: "2026-09-05", kind: "gazetted", declaredBy: ms.id, createdBy: ms.id, updatedBy: ms.id });
  });

  const refusal = async (p: Promise<unknown>): Promise<RosterError> => {
    const e = await p.then(() => null, (err: unknown) => err);
    if (!(e instanceof RosterError)) throw new Error(`expected a RosterError, got: ${String(e)}`);
    return e;
  };

  it("states, per day, the rostered duty and what the records show — and 'no other record held' where there is none", async () => {
    const r = await dutyEvidence(db, ms, ASK(f.surgeon.id), NOW);
    const days = r.people[0]!.days;
    expect(days.map((d) => d.istDate)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]);
    expect(days[1]!.theatre.map((t) => [t.role, t.wheelIn.toISOString(), t.wheelOut?.toISOString()]))
      .toEqual([["surgeon", ist("2026-09-02T09:12").toISOString(), ist("2026-09-02T11:40").toISOString()]]);
    expect(days.map((d) => [d.rostered.length, d.approvedLeave, d.holiday])).toEqual([
      [0, false, null], [1, false, null], [1, false, null], [0, true, null], [0, false, "gazetted"],
    ]);

    const html = renderEvidenceHtml(r).html;
    const row = (day: string): string => html.split(`data-day="${day}"`)[1]!.split("</tr>")[0]!;
    expect(row("2026-09-01")).toContain("No duty rostered");
    expect(row("2026-09-01")).toContain("No other record held for this day");
    expect(row("2026-09-02")).toContain("Unit senior resident");
    expect(row("2026-09-02")).toContain("09:00\u2060–\u206017:00"); // word-joined: a time range never breaks across lines
    expect(row("2026-09-02")).toContain("surgeon: wheeled in 09:12, wheeled out 11:40");
    expect(row("2026-09-03")).toContain("No other record held for this day");
    expect(row("2026-09-04")).toContain("Approved leave or deputation on record");
    expect(row("2026-09-05")).toContain("Hospital gazetted holiday");
    // A4, letterhead, QR carrying the reference.
    expect(renderEvidenceHtml(r).page).toEqual({ widthMm: 210, heightMm: 297 });
    expect(html).toContain("size: A4 portrait");
    expect(html).toContain("<svg");
    expect(html).toContain(r.ref);
    // The sheet names the records it read, theatre among them.
    expect(r.sources).toEqual(["roster", "leave", "holidays", "theatre"]);
    expect(html).toContain("theatre wheel-in and wheel-out times");
  });

  it("a source that is not wired is not on the sheet's list of what was read — never a silent 'nothing'", async () => {
    unwireOt();
    try {
      const r = await dutyEvidence(db, ms, ASK(f.surgeon.id), NOW);
      expect(r.sources).toEqual(["roster", "leave", "holidays"]);
      expect(renderEvidenceHtml(r).html).not.toContain("theatre wheel-in");
    } finally { unwireOt = registerOtDutyEvidence(); }
  });

  it("draws no conclusion: not one word of the sheet says a person was or was not at work (en + hi)", async () => {
    const html = renderEvidenceHtml(await dutyEvidence(db, ms, ASK(f.surgeon.id), NOW)).html;
    // Read as TEXT — the words a person reads — and as markup, so a class name cannot hide one either.
    const text = html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ");
    expect(text.match(VERDICT_WORDS)).toBeNull();
    expect(html.match(VERDICT_WORDS)).toBeNull();
  });

  it("never carries a phone, the leave's reason or kind, the patient or the procedure", async () => {
    const r = await dutyEvidence(db, ms, ASK(f.surgeon.id), NOW);
    const html = renderEvidenceHtml(r).html;
    const wire = JSON.stringify(r);
    for (const secret of ["9876501234", "9800001111", "piles", "Patna", "Sunita", "GYN-DNC", "gynae", "Medical leave", "\"ML\""]) {
      expect({ secret, inSheet: html.includes(secret), onWire: wire.includes(secret) }).toEqual({ secret, inSheet: false, onWire: false });
    }
  });

  it("who may run it: publish at the PERSON's department, the MS anywhere; a reader and another department's head are refused", async () => {
    expect((await dutyEvidence(db, hodSur, ASK(f.surgeon.id), NOW)).people).toHaveLength(1);
    expect((await refusal(dutyEvidence(db, hodMed, ASK(f.surgeon.id), NOW))).code).toBe("not_permitted");
    expect((await refusal(dutyEvidence(db, reader, ASK(f.surgeon.id), NOW))).code).toBe("not_permitted");
    // The picker offers only what the server would allow.
    const people = (a: Actor) => evidencePeople(db, a, NOW).then((ds) => ds.flatMap((d) => d.people.map((p) => p.userId)));
    expect(await people(hodSur)).toContain(f.surgeon.id);
    expect(await people(hodMed)).not.toContain(f.surgeon.id);
    expect(await people(reader)).toEqual([]);
  });

  it("prints through the server-side rail: one job to the office's A4, a second press queues nothing, the claim re-asks as the requester", async () => {
    const unregister = registerRosterEvidencePrinting();
    try {
      const first = await printDutyEvidence(db, hodSur, ASK(f.surgeon.id), NOW);
      expect(first.queued).toBe(true);
      expect((await printDutyEvidence(db, hodSur, ASK(f.surgeon.id), NOW)).queued).toBe(false);
      const jobs = await db.select().from(printJobs);
      expect(jobs.map((j) => [j.document, j.destination, j.dedupeKey])).toEqual([["roster_duty_evidence", "office_a4", `evidence:${first.ref}`]]);
      // Identifiers only on the queue row.
      expect(JSON.stringify(jobs[0]!.params)).not.toMatch(/Kavita|9876501234|surgeon/);

      const printed = await renderDocument(db, "roster_duty_evidence", jobs[0]!.params as Record<string, unknown>, new Date(), hodSur);
      expect(printed?.html).toContain("wheeled in 09:12");
      // The same job claimed for somebody who may not certify Surgery renders nothing (advisory, R7).
      expect(await renderDocument(db, "roster_duty_evidence", jobs[0]!.params as Record<string, unknown>, new Date(), hodMed)).toBeNull();
      // A refused ask queues nothing at all.
      expect((await refusal(printDutyEvidence(db, hodMed, ASK(f.surgeon.id), NOW))).code).toBe("not_permitted");
      expect(Number(((await db.execute(sql`select count(*)::int as n from print_jobs`)).rows[0] as { n: number }).n)).toBe(1);
    } finally { unregister(); }
  });

  it("refuses a range that is not one, or longer than a month", async () => {
    expect((await refusal(dutyEvidence(db, ms, { userIds: [f.surgeon.id], from: "2026-09-05", to: "2026-09-01" }, NOW))).code).toBe("invalid_window");
    expect((await refusal(dutyEvidence(db, ms, { userIds: [f.surgeon.id], from: "2026-09-01", to: "2026-10-15" }, NOW))).code).toBe("invalid_window");
    expect((await refusal(dutyEvidence(db, ms, { userIds: [], from: "2026-09-01", to: "2026-09-02" }, NOW))).code).toBe("invalid_window");
  });
});
