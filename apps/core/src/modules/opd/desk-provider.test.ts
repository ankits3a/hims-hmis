import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, openOpdVisit, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { opdDeskProvider } from "./desk-provider";
import type { DeskProviderCtx } from "../../kernel/desk/types";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 07c T1/T2/T3 — OPD's desk cards and its slice of the daily report.
 *
 * The report is the half that leaves the building. A card shows a number and leaks nothing; a
 * report LISTS PEOPLE and becomes a CSV somebody mails to themselves, so the alias rule that
 * governs every desk surface has to hold in the file too — and the kernel cannot enforce it,
 * because it does not know which column of which provider's rows is a name.
 */
const T0 = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST
const DATE = "2026-08-17";

describe("opd desk provider (07c)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let other: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    other = await mkUser(db, "clerk2", ["front_office_t"]);
  });

  const ctxFor = (u: Awaited<ReturnType<typeof mkUser>>): DeskProviderCtx =>
    ({ db, actor: u.actor, reader: u.actor, date: DATE, now: T0 });

  it("the hall card counts the hall and names no patient", async () => {
    const p = await mkPatient(db, clerk.actor, { phone: "9876540002" });
    await openOpdVisit(db, { clerk: clerk.actor, patientId: p.id, departmentId: deptId, doctorId: dra.doctorId }, T0);

    const cards = await opdDeskProvider.load(ctxFor(clerk));
    const hall = cards.find((c) => c.key === "opd.hall");
    expect(hall).toBeDefined();
    // Counts only. A queue of names on a home screen is the surface the token board was built without.
    expect(JSON.stringify(hall)).not.toContain("Asha");
  });

  /**
   * PLAN 07c T4 A2 — EVERY FIGURE IS A DOOR, AND THE PROVIDER IS WHAT DECIDES WHERE IT OPENS.
   *
   * The client renders `href` and knows nothing about OPD; if this provider stops emitting one, the
   * figure silently becomes decoration and the screen has no way to notice. So the pairing is
   * asserted HERE, where the knowledge is — and the two `myVisits` figures go to DIFFERENT places
   * on purpose: "opened" is the person's own day (`/my-day`), "still here" is work in the hall.
   */
  it("A2: every stat carries the drill target its rows actually live behind", async () => {
    const cards = await opdDeskProvider.load(ctxFor(clerk));
    const byKey = new Map(cards.flatMap((c) => c.stats ?? []).map((s) => [s.key, s.href]));
    expect(Object.fromEntries(byKey)).toEqual({
      "desk.opd.waiting": "/opd/desk",
      "desk.opd.withVitals": "/opd/vitals",
      "desk.opd.sessionsOpen": "/opd/desk",
      "desk.opd.opened": "/my-day",
      "desk.opd.stillHere": "/opd/desk",
    });
  });

  /**
   * PLAN 07c T4 A3 / DD11 — the card names the topics that make it stale, because the kernel cannot.
   * Every one must sit in the `queue` space, which is gated on this provider's own permission: a
   * topic from another module's space would be refused by the gateway and the card would quietly
   * never refresh.
   */
  it("A3: the hall card declares a queue topic per doctor, all inside its own topic space", async () => {
    const hall = (await opdDeskProvider.load(ctxFor(clerk))).find((c) => c.key === "opd.hall");
    expect(hall?.topics).toEqual([`queue:${dra.doctorId}:${DATE}`]);
    expect(hall?.topics?.every((t) => t.startsWith("queue:"))).toBe(true);
  });

  it("my-visits counts only what THIS person opened", async () => {
    const a = await mkPatient(db, clerk.actor, { phone: "9876540003" });
    const b = await mkPatient(db, other.actor, { phone: "9876540004" });
    await openOpdVisit(db, { clerk: clerk.actor, patientId: a.id, departmentId: deptId, doctorId: dra.doctorId }, T0);
    await openOpdVisit(db, { clerk: other.actor, patientId: b.id, departmentId: deptId, doctorId: dra.doctorId }, T0);

    const mine = (await opdDeskProvider.load(ctxFor(clerk))).find((c) => c.key === "opd.myVisits");
    expect(mine?.stats?.find((s) => s.key === "desk.opd.opened")?.value).toBe("1");
  });

  /**
   * THE ASSERTION THIS WHOLE TASK RESTS ON — with one honest correction the mutant forced.
   *
   * The `not.toContain(realName)` half does NOT discriminate: `getPatientSummaries` already returns
   * `name: null` for a restricted row, so no line in this provider could put the real name in the
   * file. The half that DOES discriminate is `toContain(alias)` — the mutant that drops the
   * `restricted` branch prints `—` where a person should be. Both are kept: the first documents the
   * property, the second is what actually fails when it breaks.
   */
  it("T3: a confidential patient appears in the report by ALIAS, never by name", async () => {
    const sealed = await mkPatient(db, clerk.actor, {
      name: "Asha Confidential", phone: "9111111111", isConfidential: true, alias: "Guest One",
    });
    await openOpdVisit(db, { clerk: clerk.actor, patientId: sealed.id, departmentId: deptId, doctorId: dra.doctorId }, T0);

    const [section] = await opdDeskProvider.report!(ctxFor(clerk));
    expect(section!.rows).toHaveLength(1);
    const flat = section!.rows.flat().join("|");
    expect(flat).toContain("Guest One");
    expect(flat).not.toContain("Asha Confidential");
  });

  it("an ordinary patient appears by name, with the visit number and the time", async () => {
    const p = await mkPatient(db, clerk.actor, { name: "Ramesh Kale", phone: "9876540005" });
    const { encounterId } = await openOpdVisit(
      db, { clerk: clerk.actor, patientId: p.id, departmentId: deptId, doctorId: dra.doctorId }, T0,
    );
    expect(encounterId).toBeTruthy();

    const [section] = await opdDeskProvider.report!(ctxFor(clerk));
    const row = section!.rows[0]!;
    expect(row).toContain("Ramesh Kale");
    expect(row[0]).toBe("09:30"); // T0 in IST — the report is cut on the hospital's clock, not UTC
    expect(section!.totals?.[5]).toBe("1");
  });

  it("a day with nothing on it is an empty section, not an error", async () => {
    const [section] = await opdDeskProvider.report!({ ...ctxFor(clerk), date: "2026-09-30" });
    expect(section!.rows).toEqual([]);
    expect(section!.totals?.[5]).toBe("0");
  });
});
