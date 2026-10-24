import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { withTx } from "../../../kernel/db/client";
import { erBands, erEpisodes, patients } from "../../../kernel/db/schema";
import { addAllergy, isValidUhid } from "../../patients";
import { executeMerge } from "../../patients/merge";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkErWorld } from "../../../../test/helpers/emergency";
import {
  linkIdentity, readErBoard, readErDesk, registerArrival, registerUnidentified, reprintErBand,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ErWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 1 (#808, decision 0076) — "DONE MEANS" FOR er-arrival (spec SPEC-emergency-2026-10-15 §7). Every check calls
 * the INTENT function, never a screen. Times are relative to the real clock, never a pinned date.
 */

jest.setTimeout(120_000);

const key = (): string => randomUUID();
const MIN = 60_000;

describe("ER lane 1 er-arrival — done means", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkErWorld(db); });

  const unknown = (over: Record<string, unknown> = {}, now?: Date) => registerUnidentified(db, w.erDesk, {
    idempotencyKey: key(), sex: "male", ageBand: "young_adult", arrivalMode: "ambulance_108", ...over,
  }, now === undefined ? {} : { now });

  it("(i) an unknown patient is registered with three answers and gets a real UHID, alias and band; a second unknown at the same minute gets a different alias", async () => {
    const now = new Date();
    const a = await unknown({}, now);
    const b = await unknown({ sex: "unknown", ageBand: "adult" }, now);

    // A REAL UHID: a patients row with a valid check digit, flagged unidentified, named by the alias.
    expect(isValidUhid(a.uhid)).toBe(true);
    const row = (await db.select().from(patients).where(eq(patients.id, a.patientId)))[0]!;
    expect(row).toMatchObject({ uhid: a.uhid, identityStatus: "unidentified", name: a.alias, status: "active", dob: null });
    expect(a.alias).toMatch(/^Unknown-\d{4,}$/);
    expect(a.aliasHi).toBe(a.alias.replace("Unknown-", "अज्ञात-"));

    // The band, printed at arrival: the ER number, the alias in both scripts, "Allergy: unknown" and "Unidentified" in words.
    expect(a.band.bandSerial).toBe(`${a.episodeNo}-1`);
    expect(a.band.band).toMatchObject({
      name: a.alias, nameHi: a.aliasHi, uhid: a.uhid, ageSex: "~30 y M", episodeNo: a.episodeNo,
      allergyWords: ["Allergy: unknown"], alertWords: ["Unidentified"], size: "adult", site: "wrist",
    });
    expect(a.band.band.qr).toContain(a.band.bandSerial);
    expect(a.episodeNo).toMatch(/^ER\d{2}-\d{6}$/);

    // The second unknown of the same minute: another alias, another UHID, another ER number.
    expect(b.alias).not.toBe(a.alias);
    expect(b.uhid).not.toBe(a.uhid);
    expect(b.episodeNo).not.toBe(a.episodeNo);
    expect(b.band.band.ageSex).toBe("~50 y U");
  });

  it("(ii) a merge of an unknown into the true record carries the episode and the band reprint", async () => {
    const u = await unknown();
    const trueId = await w.patient("male", 41, "Ramesh Kumar");
    await withTx(db, (tx) => addAllergy(tx, w.erDesk, trueId, { substance: "Penicillin", severity: "severe", source: "registration" }));

    // Identified by family: link_identity FILES the patient_merge request; nothing is merged yet.
    const link = await linkIdentity(db, w.mrd, {
      idempotencyKey: key(), episodeId: u.episodeId, truePatientId: trueId, how: "family", note: "Brother identified him",
    });
    expect(link.state).toBe("merge_requested");
    let desk = await readErDesk(db, w.erDesk);
    expect(desk.episodes.find((e) => e.episodeId === u.episodeId)).toMatchObject({
      name: u.alias, unidentified: true, identity: { stage: "waiting" }, band: { stale: false },
    });

    // The MS approves; the MRD executes — the existing merge, untouched.
    await approveRequest(db, w.ms, { approvalId: link.approvalId, note: "same person" });
    await executeMerge(db, w.mrd, link.mergeRequestId);

    // The episode is carried: it is found under the TRUE record — one open episode per PERSON.
    await expect(registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: trueId, arrivalMode: "walk_in" }))
      .rejects.toMatchObject({ code: "episode_already_open", detail: { episodeId: u.episodeId } });
    const board = await readErBoard(db, w.erDesk);
    const tile = board.waiting.find((t) => t.episodeId === u.episodeId)!;
    expect(tile.label).toBe("Ramesh Kumar");
    expect(tile.chips).not.toContain("unidentified");
    desk = await readErDesk(db, w.erDesk);
    const row = desk.episodes.find((e) => e.episodeId === u.episodeId)!;
    expect(row).toMatchObject({ name: "Ramesh Kumar", unidentified: false, identity: { stage: "merged" }, band: { stale: true } });

    // The band reprint prints the true name, the true UHID and the true record's allergy; the unknown's band is void.
    const trueUhid = (await db.select({ uhid: patients.uhid }).from(patients).where(eq(patients.id, trueId)))[0]!.uhid;
    const re = await reprintErBand(db, w.erDesk, { idempotencyKey: key(), episodeId: u.episodeId, reason: "identity_linked" });
    expect(re.band).toMatchObject({
      name: "Ramesh Kumar", nameHi: null, uhid: trueUhid, allergyWords: ["Allergy: Penicillin (severe)"], alertWords: [],
    });
    expect(re.bandSerial).toBe(`${u.episodeNo}-2`);
    const bands = await db.select().from(erBands).where(eq(erBands.episodeId, u.episodeId));
    expect(bands.map((b) => b.status).sort()).toEqual(["printed", "void"]);
    expect((await readErDesk(db, w.erDesk)).episodes.find((e) => e.episodeId === u.episodeId)!.band).toEqual({ serial: re.bandSerial, stale: false });
  });

  // The rest of "carries the episode, orders, bill, MLC" belongs to the lanes that file those under the unknown record.
  it.todo("(ii-b) ER orders filed under the unknown follow the merge — lane 3 er-care (orders on the ER episode)");
  it.todo("(ii-c) the ER bill filed under the unknown follows the merge — lane 6 er-bill (the ER charge sink)");
  it.todo("(ii-d) the MLC filed under the unknown follows the merge — lane 4 er-mlc (the MLC register)");

  it("(iii) arrived_at is the gate instant; a registration entered 15 min later does not change it", async () => {
    const now = new Date();
    const gate = new Date(now.getTime() - 15 * MIN);
    const p = await w.patient("female", 34, "Sunita Devi");
    const r = await registerArrival(db, w.erDesk, {
      idempotencyKey: key(), patientId: p, arrivalMode: "private_vehicle", arrivedAt: gate.toISOString(),
    }, { now });
    expect(r.arrivedAt).toBe(gate.toISOString());
    expect(r.registeredAt).toBe(now.toISOString());
    // Later acts (a band reprint) never move it; the board's clocks run from the gate.
    await reprintErBand(db, w.erDesk, { idempotencyKey: key(), episodeId: r.episodeId, reason: "damaged" }, { now: new Date(now.getTime() + 5 * MIN) });
    const row = (await db.select().from(erEpisodes).where(eq(erEpisodes.id, r.episodeId)))[0]!;
    expect(row.arrivedAt.toISOString()).toBe(gate.toISOString());
    const board = await readErBoard(db, w.erDesk, { now });
    expect(board.waiting[0]).toMatchObject({ episodeId: r.episodeId, arrivedAt: gate.toISOString() });
    // Door-to-triage (≤ 5 min) is due 5 minutes after the GATE — already 10 minutes late, not 5 minutes ahead.
    expect(board.waiting[0]!.triageDueAt).toBe(new Date(gate.getTime() + 5 * MIN).toISOString());
    expect(board.stats.longestTriageWaitMinutes).toBe(15);
  });
});
