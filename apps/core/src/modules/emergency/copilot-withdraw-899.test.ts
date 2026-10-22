import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ErEsiProposalCheckSchema, erIstHm } from "@hmis/contracts";
import { erEpisodes } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErWorld } from "../../../test/helpers/emergency";
import { checkEsiProposal, moveBay, placeInBay, readEsiProposal, reTriage, recordErVitals, recordLwbs, registerArrival, triage } from "./index";
import type { Db } from "../../kernel/db/client";
import type { ErWorld } from "../../../test/helpers/emergency";

/**
 * #899 (spec §6 edge 1) — a shown ESI proposal withdraws itself, with the reason, when the record it was read from moves
 * on: a person triages or re-triages, the patient is placed or moved, new vitals land, the complaint changes, the patient
 * leaves. The proposal carries its identity (`basis`: the latest triage entry, the bay, a digest); the check fails closed.
 */
jest.setTimeout(240_000);
const key = (): string => randomUUID();
const MIN = 60_000;

describe("ER copilot — a stale ESI proposal withdraws itself (#899)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkErWorld(db); });

  const arrive = async (now: Date) => {
    const p = await w.patient("male", 52, "Ramesh Prasad");
    return registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in", complaint: "chest pain since 1 hour" }, { now });
  };
  const emergency = { class: "emergency", genderRule: "any" };
  const check = async (episodeId: string, basis: string) => ErEsiProposalCheckSchema.parse(await checkEsiProposal(db, w.erNurse, episodeId, basis));

  it("an unchanged record keeps the proposal; reading it again gives the same basis", async () => {
    const a = await arrive(new Date(Date.now() - 10 * MIN));
    const p = await readEsiProposal(db, w.erNurse, a.episodeId);
    expect(p.basis).toMatch(/^v1\./);
    expect((await readEsiProposal(db, w.erNurse, a.episodeId)).basis).toBe(p.basis);
    expect(await check(a.episodeId, p.basis)).toEqual({ episodeId: a.episodeId, current: true, withdrawn: null });
  });

  it("new vitals withdraw it with the vital set's time, and a new proposal can be shown", async () => {
    const a = await arrive(new Date(Date.now() - 10 * MIN));
    const p = await readEsiProposal(db, w.erNurse, a.episodeId);
    const at = new Date(Date.now() - 2 * MIN);
    await recordErVitals(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, vitals: { pulse: 132, spo2: 89 } }, { now: at });
    const c = await check(a.episodeId, p.basis);
    expect(c.current).toBe(false);
    expect(c.withdrawn).toMatchObject({ reason: "new_vitals", fresh: true, text: `New vitals at ${erIstHm(at)}` });
    const fresh = await readEsiProposal(db, w.erNurse, a.episodeId);
    expect(fresh.basis).not.toBe(p.basis);
    expect((await check(a.episodeId, fresh.basis)).current).toBe(true);
  });

  it("a person's triage withdraws it with the level and time; a later re-triage says re-triaged", async () => {
    const a = await arrive(new Date(Date.now() - 20 * MIN));
    const p = await readEsiProposal(db, w.erNurse, a.episodeId);
    const t1 = new Date(Date.now() - 10 * MIN);
    await triage(db, w.erNurse, {
      idempotencyKey: key(), episodeId: a.episodeId, level: 2, decision: { lifeSaving: false, highRisk: true, resources: "many", dangerVitals: false },
    }, { now: t1 });
    expect((await check(a.episodeId, p.basis)).withdrawn).toMatchObject({ reason: "triaged", level: 2, fresh: false, text: `Triaged ESI 2 at ${erIstHm(t1)}` });
    const after = await readEsiProposal(db, w.erNurse, a.episodeId);
    const t2 = new Date(Date.now() - 2 * MIN);
    await reTriage(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, level: 1 }, { now: t2 });
    expect((await check(a.episodeId, after.basis)).withdrawn).toMatchObject({ reason: "re_triaged", level: 1, text: `Re-triaged ESI 1 at ${erIstHm(t2)}` });
  });

  it("placing or moving the patient withdraws it, naming the bay", async () => {
    const a = await arrive(new Date(Date.now() - 10 * MIN));
    const r1 = await w.bed("ER-R1", emergency);
    const r2 = await w.bed("ER-R2", emergency);
    const p = await readEsiProposal(db, w.erNurse, a.episodeId);
    await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: r1 });
    expect((await check(a.episodeId, p.basis)).withdrawn).toMatchObject({ reason: "moved", bayCode: "ER-R1", text: "Moved to ER-R1", fresh: true });
    const inBay = await readEsiProposal(db, w.erNurse, a.episodeId);
    await moveBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: r2 });
    expect((await check(a.episodeId, inBay.basis)).withdrawn).toMatchObject({ reason: "moved", text: "Moved to ER-R2" });
  });

  it("a changed complaint withdraws it; leaving the ER withdraws it for good", async () => {
    const gate = new Date(Date.now() - 90 * MIN);
    const a = await arrive(gate);
    const p = await readEsiProposal(db, w.erNurse, a.episodeId);
    await db.update(erEpisodes).set({ complaint: "prescription refill" }).where(eq(erEpisodes.id, a.episodeId));
    expect((await check(a.episodeId, p.basis)).withdrawn).toMatchObject({ reason: "details_changed", text: "Complaint or age changed" });
    const seen = new Date(gate.getTime() + 40 * MIN);
    await recordLwbs(db, w.erDesk, { idempotencyKey: key(), episodeId: a.episodeId, lastSeenAt: seen.toISOString() });
    expect((await check(a.episodeId, p.basis)).withdrawn).toMatchObject({ reason: "departed", fresh: false, text: `Left the ER at ${erIstHm(seen)}` });
  });

  it("fails closed: an unreadable basis, or one naming an entry this episode does not have, is out of date", async () => {
    const a = await arrive(new Date(Date.now() - 10 * MIN));
    const p = await readEsiProposal(db, w.erNurse, a.episodeId);
    for (const bad of ["garbage", "v1.-.-", "v2.-.-.abc", p.basis.replace(/^v1\.-\./, "v1.01JNOTANENTRY000000000000.")]) {
      expect((await check(a.episodeId, bad)).withdrawn).toMatchObject({ reason: "out_of_date", text: "Suggestion out of date" });
    }
    // The check needs the triage string, as the proposal does.
    await expect(checkEsiProposal(db, w.mrd, a.episodeId, p.basis)).rejects.toBeTruthy();
  });
});
