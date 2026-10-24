import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mciTagProposal } from "@hmis/contracts";
import { erMciTags } from "../../../kernel/db/schema";
import { mkUser } from "../../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkErWorld } from "../../../../test/helpers/emergency";
import {
  declareMci, listErBays, mciTag, mintMciPacks, openSurgeBays, placeInBay, registerArrival, registerMciArrival, standDownMci,
} from "../index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { ErWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 8 (#815) — THE CODE YELLOW RULES (spec §4.8): only the MS or the duty manager commands it, one event at a time;
 * a pack is used once; START / JumpSTART proposals from the findings; a Black re-tag needs its reason and every tag is
 * kept; surge bays are overflow beds opened for the running event only.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();

describe("ER lane 8 er-mci — the rules", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErWorld;
  let dm: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErWorld(db);
    dm = (await mkUser(db, "er.mci.dm", ["duty_manager"])).actor;
  });

  it("only the MS or the duty manager declares; one Code Yellow at a time; a pack is used once", async () => {
    await expect(declareMci(db, w.erNurse, { idempotencyKey: key(), name: "Fire" })).rejects.toMatchObject({ code: "mci_role_needed" });
    await expect(mintMciPacks(db, w.erDoctor, { idempotencyKey: key(), count: 2 })).rejects.toMatchObject({ code: "mci_role_needed" });
    const m = await declareMci(db, w.ms, { idempotencyKey: key(), name: "Fire" });
    await expect(declareMci(db, dm, { idempotencyKey: key(), name: "Second" })).rejects.toMatchObject({ code: "mci_active" });
    const { packs } = await mintMciPacks(db, dm, { idempotencyKey: key(), count: 2 });
    expect(packs.map((p) => p.packNo)).toEqual([expect.stringMatching(/^MCI\d{2}-001$/), expect.stringMatching(/^MCI\d{2}-002$/)]);
    const first = await registerMciArrival(db, w.erDesk, { idempotencyKey: key(), packNo: packs[0]!.packNo });
    await expect(registerMciArrival(db, w.erDesk, { idempotencyKey: key(), packNo: packs[0]!.packNo })).rejects.toMatchObject({ code: "pack_used" });
    await expect(registerMciArrival(db, w.erDesk, { idempotencyKey: key(), packNo: "MCI26-777" })).rejects.toMatchObject({ code: "pack_not_found" });
    await standDownMci(db, dm, { idempotencyKey: key(), mciId: m.mciId });
    await expect(standDownMci(db, w.ms, { idempotencyKey: key(), mciId: m.mciId })).rejects.toMatchObject({ code: "mci_stood_down" });
    await expect(mciTag(db, w.erNurse, { idempotencyKey: key(), episodeId: first.episodeId, tag: "red" })).rejects.toMatchObject({ code: "mci_not_active" });
  });

  it("START and JumpSTART propose from the findings; a Black re-tag needs its reason; every tag is kept", async () => {
    expect(mciTagProposal("start", { walking: true, breathing: true })).toBe("green");
    expect(mciTagProposal("start", { walking: false, breathing: false })).toBe("black");
    expect(mciTagProposal("start", { walking: false, breathing: false, breathingAfterAirway: true })).toBe("red");
    expect(mciTagProposal("start", { walking: false, breathing: true, respRate: 34 })).toBe("red");
    expect(mciTagProposal("start", { walking: false, breathing: true, respRate: 22, radialPulse: true, followsCommands: true })).toBe("yellow");
    expect(mciTagProposal("jumpstart", { walking: false, breathing: false, radialPulse: true, breathingAfterRescue: true })).toBe("red");
    expect(mciTagProposal("jumpstart", { walking: false, breathing: true, respRate: 12 })).toBe("red");
    expect(mciTagProposal("jumpstart", { walking: false, breathing: true, respRate: 30, radialPulse: true, avpu: "A" })).toBe("yellow");

    await declareMci(db, dm, { idempotencyKey: key(), name: "Bus collision" });
    const p = await w.patient("male", 30, "Tag Patient");
    const a = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in" });
    const t1 = await mciTag(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, tag: "black", findings: { walking: false, breathing: false } });
    expect(t1).toMatchObject({ tag: "black", proposal: "black", previous: null });
    await expect(mciTag(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, tag: "red" })).rejects.toMatchObject({ code: "retag_needs_reason" });
    const t2 = await mciTag(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, tag: "red", reason: "Breathing on re-check" });
    expect(t2).toMatchObject({ tag: "red", previous: "black" });
    const rows = await db.select().from(erMciTags).where(eq(erMciTags.episodeId, a.episodeId)).orderBy(erMciTags.taggedAt);
    expect(rows.map((r) => [r.tag, r.previous, r.reason])).toEqual([["black", null, null], ["red", "black", "Breathing on re-check"]]);
  });

  it("surge bays: overflow beds the duty manager opened, for the running event only", async () => {
    const overflow = await w.bed("OVF-1", { class: "overflow", overflow: true });
    const general = await w.bed("GEN-9", { class: "general" });
    const m = await declareMci(db, dm, { idempotencyKey: key(), name: "Collapse" });
    const p = await w.patient("female", 52, "Surge Patient");
    const a = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in" });
    await expect(placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: overflow })).rejects.toMatchObject({ code: "bay_not_emergency" });
    await expect(openSurgeBays(db, w.erNurse, { idempotencyKey: key(), mciId: m.mciId, bedIds: [overflow] })).rejects.toMatchObject({ code: "mci_role_needed" });
    await expect(openSurgeBays(db, dm, { idempotencyKey: key(), mciId: m.mciId, bedIds: [general] })).rejects.toMatchObject({ code: "surge_bed_not_overflow" });
    expect((await openSurgeBays(db, dm, { idempotencyKey: key(), mciId: m.mciId, bedIds: [overflow] })).opened).toEqual([{ bedId: overflow, code: "OVF-1" }]);
    expect((await listErBays(db, w.erNurse)).map((b) => b.code)).toContain("OVF-1");
    expect(await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: overflow })).toMatchObject({ bayCode: "OVF-1" });

    const overflow2 = await w.bed("OVF-2", { class: "overflow", overflow: true });
    await openSurgeBays(db, dm, { idempotencyKey: key(), mciId: m.mciId, bedIds: [overflow2] });
    await standDownMci(db, dm, { idempotencyKey: key(), mciId: m.mciId });
    const q = await w.patient("male", 61, "After Patient");
    const b = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: q, arrivalMode: "walk_in" });
    await expect(placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: b.episodeId, bedId: overflow2 })).rejects.toMatchObject({ code: "bay_not_emergency" });
  });
});
