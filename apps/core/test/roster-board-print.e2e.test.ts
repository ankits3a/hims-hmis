import { writeFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedRosterDemo } from "../scripts/seed-roster-demo";
import {
  opdDepartments, opdDoctors, permissions, printJobs, roleAssignments, rolePermissions, roles, rosterBoardPrints, users,
} from "../src/kernel/db/schema";
import { createAgent } from "../src/kernel/auth/agents";
import { claimPrintJobs, reportPrinted } from "../src/kernel/printing/claim";
import { renderDocument } from "../src/kernel/printing/render";
import {
  BOARD_PRINT_DESTINATION, ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ, boardPrintDocument, boardSlotAtOrBefore,
  lastBoardPrint, nextBoardSlot, printBoardIfDue, registerRosterPrinting, seedOrgDepartments, seedRosterPositions,
  seedRosterRules, seedUnits,
} from "../src/modules/roster";
import type { Db } from "../src/kernel/db/client";

/**
 * 20-U infra (owner 2026-10-04, board "When the screens are dark", plan D5) — **THE BOARD PRINTS
 * ITSELF AT 20:00 AND 08:00 IST, AND THE CARD SAYS ONLY WHAT THE RECORD SAYS.**
 *
 * The legs: the two instants (and the catch-up window); one row per instant however often the job
 * ticks; with no relay granted the board's destination, nothing is queued and the record says so;
 * with one, exactly one job, and "copies" moves only when the relay reports paper; the relay's
 * claim prints the STORED sheet and refuses a stale one; phone numbers only for the people in the
 * building (D6).
 */
describe("roster — the board prints itself at 20:00 and 08:00 IST", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let unregister: () => void;
  const ist = (s: string): Date => new Date(`${s}:00+05:30`);
  const SLOT = ist("2026-10-04T20:00");
  const TICK = new Date(SLOT.getTime() + 30_000);
  const ON = { ROSTER_RESOLVER_ENABLED: "true" };
  const by = { createdBy: "t", updatedBy: "t" };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); unregister = registerRosterPrinting(); });
  afterAll(async () => { unregister(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values(["doctor", "medical_superintendent", "duty_manager", "pharmacy", "admin", "owner", "radiologist", "pathologist", "anaesthetist"]
      .map((key) => ({ key, title: key })));
    await db.insert(permissions).values([ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })));
    await db.insert(rolePermissions).values([ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })));
    await db.insert(opdDepartments).values(["MED", "SUR", "ENT"].map((code) => ({ id: `OPD-${code}`, code, name: code, ...by })));
    const people: [string, string, string[], string | null, string | null][] = [
      ["anand.rao", "Dr. Anand Rao", ["doctor", "medical_superintendent"], "MED", "9800000001"],
      ["ritu.singh", "Dr. Ritu Singh", ["doctor"], "MED", "9800000002"],
      ["sanjay.prasad", "Dr. Sanjay Prasad", ["doctor"], "MED", "9800000003"],
      ["kavya.shekhar", "Dr. Kavya Shekhar", ["doctor"], "SUR", null],
      ["rakesh.mahto", "Dr. Rakesh Mahto", ["doctor"], "SUR", null],
      ["shalini.pandey", "Dr. Shalini Pandey", ["doctor"], "ENT", null],
      ["vivek.thakur", "Dr. Vivek Thakur", ["doctor"], "ENT", "9800000007"],
      ["manoj.bhat", "Manoj Bhat", ["duty_manager"], null, "9800000008"],
      ["abhay.kumar", "Abhay Kumar", ["pharmacy"], null, null],
    ];
    for (const [username, fullName, roleKeys, opd, phone] of people) {
      const id = `U-${username}`;
      await db.insert(users).values({ id, username, fullName, staffCode: `EMP-${username}`, passwordHash: "x", phone });
      await db.insert(roleAssignments).values(roleKeys.map((roleKey) => ({ id: `RA-${username}-${roleKey}`, userId: id, roleKey, scopeType: "hospital", scopeId: null })));
      if (opd !== null) await db.insert(opdDoctors).values({ id: `D-${username}`, userId: id, displayName: fullName, code: `DR-${username}`, departmentId: `OPD-${opd}`, ...by });
    }
    await seedOrgDepartments(db);
    await seedRosterPositions(db);
    await seedUnits(db);
    await seedRosterRules(db);
    await seedRosterDemo(db, ist("2026-10-04T15:40"));
  });

  const jobs = async () => db.select().from(printJobs);

  it("prints at 08:00 and 20:00 IST — and within two hours of one, not after", async () => {
    expect(boardSlotAtOrBefore(ist("2026-10-05T03:10"))).toEqual(SLOT);
    expect(boardSlotAtOrBefore(ist("2026-10-05T08:00"))).toEqual(ist("2026-10-05T08:00"));
    expect(boardSlotAtOrBefore(ist("2026-10-05T07:59"))).toEqual(SLOT);
    expect(nextBoardSlot(TICK)).toEqual(ist("2026-10-05T08:00"));
    expect(nextBoardSlot(ist("2026-10-05T07:59"))).toEqual(ist("2026-10-05T08:00"));

    expect(await printBoardIfDue(db, ist("2026-10-04T22:01"), ON)).toBeNull();
    expect(await db.select().from(rosterBoardPrints)).toEqual([]);
    expect(await printBoardIfDue(db, ist("2026-10-04T21:59"), ON)).toMatchObject({ slotAt: SLOT });
  });

  it("with no relay granted the board's printer, the sheet is generated and recorded — and nothing is queued", async () => {
    const first = await printBoardIfDue(db, TICK, ON);
    expect(first).toMatchObject({ slotAt: SLOT, outcome: "no_printer", printJobIds: [] });
    // A second tick in the same minute, and the next one: still ONE row for the instant.
    expect(await printBoardIfDue(db, TICK, ON)).toBeNull();
    expect(await printBoardIfDue(db, new Date(TICK.getTime() + 60_000), ON)).toBeNull();
    expect(await db.select().from(rosterBoardPrints)).toHaveLength(1);
    expect(await jobs()).toEqual([]);

    const view = await lastBoardPrint(db, TICK);
    expect(view).toMatchObject({
      printId: first!.printId, outcome: "no_printer", destinations: [],
      copies: { queued: 0, printed: 0, waiting: 0, failed: 0 }, lastPrintedAt: null, nextAt: ist("2026-10-05T08:00"),
    });

    const doc = (await boardPrintDocument(db, first!.printId))!;
    expect(doc.page).toEqual({ widthMm: 297, heightMm: 210 });
    expect(doc.title).toBe("Who is on duty — Sun 04-Oct-2026 20:00 IST");
    expect(doc.html).toContain("CRK MEDICAL COLLEGE &amp; HOSPITAL");
    expect(doc.html).toContain("WHO IS ON DUTY");
    expect(doc.html).toContain("@page { size: A4 landscape");
    // D6 — the night JR is in the building at 20:00 and his number prints; the faculty on call
    // (Dr Anand Rao) and the day SR (gone home at 20:00) are on the sheet without one.
    expect(doc.html).toContain("Dr. Sanjay Prasad · <span class=\"ph num\">9800000003</span>");
    expect(doc.html).toContain("Dr. Anand Rao");
    expect(doc.html).not.toContain("9800000001");
    expect(doc.html).not.toContain("9800000002");
    // "Printed" is the database's clock at the moment the sheet was drawn (V6), and the sheet says
    // the instant it is AS AT separately.
    const row = (await db.select().from(rosterBoardPrints))[0]!;
    expect(Math.abs(row.renderedAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(doc.html).toContain("as at 20:00 IST · Sun 04-Oct-2026");
    expect(doc.html).toMatch(/Printed \w{3} \d{2}-\w{3}-\d{4} \d{2}:\d{2} IST by the HMIS · replaced at 08:00/);
    if (process.env.BOARD_PRINT_DUMP !== undefined) writeFileSync(process.env.BOARD_PRINT_DUMP, doc.html);
  });

  it("with a relay granted it, ONE job is queued, and a copy is counted only when the relay reports paper", async () => {
    const relay = await createAgent(db, "relay-site-1", { printDestinations: [BOARD_PRINT_DESTINATION] });
    const printed = (await printBoardIfDue(db, TICK, ON))!;
    expect(printed).toMatchObject({ outcome: "queued" });
    const queued = await jobs();
    expect(queued.map((j) => [j.document, j.destination, j.status, j.params])).toEqual([
      ["roster_board", "duty_board_a4", "queued", { printId: printed.printId }],
    ]);
    expect((await lastBoardPrint(db, TICK))!.copies).toEqual({ queued: 1, printed: 0, waiting: 1, failed: 0 });

    // The relay's claim draws the STORED sheet — the one the download serves.
    const [claimed] = await claimPrintJobs(db, { relayId: relay.id, destinations: [BOARD_PRINT_DESTINATION], limit: 5, now: TICK });
    const drawn = await renderDocument(db, claimed!.document, claimed!.params, TICK);
    expect(drawn).toEqual(await boardPrintDocument(db, printed.printId));
    expect((await lastBoardPrint(db, TICK))!.copies).toEqual({ queued: 1, printed: 0, waiting: 1, failed: 0 });

    const at = new Date(TICK.getTime() + 20_000);
    expect(await reportPrinted(db, claimed!.id, relay.id, at)).toBe(true);
    expect(await lastBoardPrint(db, TICK)).toMatchObject({ copies: { queued: 1, printed: 1, waiting: 0, failed: 0 }, lastPrintedAt: at, destinations: ["duty_board_a4"] });
  });

  it("a relay switched off holds nothing it can print late: a claim twelve hours after the instant draws nothing", async () => {
    await createAgent(db, "relay-site-1", { printDestinations: [BOARD_PRINT_DESTINATION] });
    const printed = (await printBoardIfDue(db, TICK, ON))!;
    expect(await renderDocument(db, "roster_board", { printId: printed.printId }, ist("2026-10-05T07:59"))).not.toBeNull();
    expect(await renderDocument(db, "roster_board", { printId: printed.printId }, ist("2026-10-05T08:01"))).toBeNull();
  });

  it("a killed relay is not a printer", async () => {
    const relay = await createAgent(db, "relay-site-1", { printDestinations: [BOARD_PRINT_DESTINATION] });
    await db.execute(sql`update agents set kill_switch = true where id = ${relay.id}`);
    expect(await printBoardIfDue(db, TICK, ON)).toMatchObject({ outcome: "no_printer" });
    expect(await jobs()).toEqual([]);
    expect((await db.select().from(rosterBoardPrints).where(eq(rosterBoardPrints.slotAt, SLOT)))).toHaveLength(1);
  });
});
