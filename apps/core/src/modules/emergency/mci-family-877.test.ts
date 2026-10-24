import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ER_MCI_PRESS_SCRIPT, mciFamilyStage } from "@hmis/contracts";
import { patients } from "../../kernel/db/schema";
import { mkUser } from "../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErWorld } from "../../../test/helpers/emergency";
import { declareMci, mciTag, mintMciPacks, openMlc, placeInBay, readMciFamilyDesk, registerArrival, registerMciArrival, standDownMci } from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ErWorld } from "../../../test/helpers/emergency";

/**
 * #877 item 3 — THE FAMILY INFORMATION DESK during a Code Yellow: per patient of the event, the name (or the pack alias
 * when unknown), a stage word and where — nothing clinical (no tag, no ESI, no complaint). MLC, sealed and confidential
 * patients are not listed (lane 9's family-surface rule); the desk sees only how many are withheld. The press / VIP script
 * is fixed text with no names.
 * Decision 0083 (owner 2026-10-23): Code Yellow PACK arrivals are listed although the pack rule opened their MLC; sealed
 * and confidential patients, and every MLC patient who is not a pack arrival, stay hidden and counted.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();

describe("#877 the family information desk list and the press script", () => {
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

  it("stage words from the record: open, decided and departed", () => {
    expect(mciFamilyStage({ state: "arrived", disposition: null, outcome: null })).toBe("Waiting");
    expect(mciFamilyStage({ state: "triaged", disposition: null, outcome: null })).toBe("Being seen");
    expect(mciFamilyStage({ state: "in_treatment", disposition: null, outcome: null })).toBe("Being seen");
    expect(mciFamilyStage({ state: "disposition_decided", disposition: "admit", outcome: null })).toBe("Admitting");
    expect(mciFamilyStage({ state: "disposition_decided", disposition: "refer_out", outcome: null })).toBe("Transfer arranged");
    expect(mciFamilyStage({ state: "departed", disposition: "admit", outcome: "admitted" })).toBe("Admitted");
    expect(mciFamilyStage({ state: "departed", disposition: "discharge", outcome: "discharged" })).toBe("Gone home");
    expect(mciFamilyStage({ state: "departed", disposition: null, outcome: "lama" })).toBe("Left the hospital");
    expect(mciFamilyStage({ state: "departed", disposition: null, outcome: "died" })).toBe("Please meet the duty doctor");
    expect(mciFamilyStage({ state: "brought_dead", disposition: null, outcome: null })).toBe("Please meet the duty doctor");
  });

  it("lists name or alias, stage and place only; MLC, sealed and confidential are withheld; the script has no names", async () => {
    const bay = await w.bed("ER-B1", { class: "emergency" });
    const m = await declareMci(db, dm, { idempotencyKey: key(), name: "Bus collision" });
    const { packs } = await mintMciPacks(db, dm, { idempotencyKey: key(), count: 1 });
    await registerMciArrival(db, w.erDesk, { idempotencyKey: key(), packNo: packs[0]!.packNo, tag: "red" }); // MLC by rule — listed (decision 0083)
    const named = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: await w.patient("female", 34, "Asha Family"), arrivalMode: "walk_in" });
    await mciTag(db, w.erNurse, { idempotencyKey: key(), episodeId: named.episodeId, tag: "yellow" });
    await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: named.episodeId, bedId: bay });
    const vipId = await w.patient("male", 50, "Vip Person");
    const vip = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: vipId, arrivalMode: "walk_in" });
    await db.update(patients).set({ isConfidential: true, alias: "Patient-88" }).where(eq(patients.id, vipId));
    await mciTag(db, w.erNurse, { idempotencyKey: key(), episodeId: vip.episodeId, tag: "green" });

    const desk = await readMciFamilyDesk(db, w.erDesk);
    expect(desk).toMatchObject({ mciId: m.mciId, name: "Bus collision", withheld: 1 });
    expect(desk.rows).toEqual([
      { label: packs[0]!.alias, packNo: packs[0]!.packNo, stage: "Waiting", where: "ER" },
      { label: "Asha Family", packNo: null, stage: "Waiting", where: "ER · ER-B1" },
    ]);
    expect(JSON.stringify(desk.rows)).not.toMatch(/red|Immediate|unknown_unconscious|mlc/i);
    expect(JSON.stringify(desk.rows)).not.toMatch(/yellow|Delayed|"esi"|Vip Person|Patient-88/i);
    expect(desk.script).toEqual([...ER_MCI_PRESS_SCRIPT]);
    expect(desk.script.join(" ")).not.toMatch(/Asha|Unknown-MCI/);

    // After the stand-down the desk still answers for the last event (families keep coming).
    await standDownMci(db, dm, { idempotencyKey: key(), mciId: m.mciId });
    expect((await readMciFamilyDesk(db, w.erDesk)).mciId).toBe(m.mciId);
    await expect(readMciFamilyDesk(db, w.mrd)).rejects.toMatchObject({ code: "er_forbidden" });
  });

  it("decision 0083: pack arrivals are listed although their MLC is by rule; a sealed pack arrival and a non-pack MLC are counted", async () => {
    await declareMci(db, dm, { idempotencyKey: key(), name: "Factory fire" });
    const { packs } = await mintMciPacks(db, dm, { idempotencyKey: key(), count: 2 });
    await registerMciArrival(db, w.erDesk, { idempotencyKey: key(), packNo: packs[0]!.packNo, tag: "yellow" });
    await registerMciArrival(db, w.erDesk, { idempotencyKey: key(), packNo: packs[1]!.packNo, tag: "green" });
    await db.update(patients).set({ sensitiveContext: true }).where(eq(patients.id, packs[1]!.patientId));
    const walkIn = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: await w.patient("male", 28, "Ravi Assault"), arrivalMode: "walk_in" });
    await mciTag(db, w.erNurse, { idempotencyKey: key(), episodeId: walkIn.episodeId, tag: "green" });
    await openMlc(db, w.erDoctor, { idempotencyKey: key(), episodeId: walkIn.episodeId, category: "assault" });

    const desk = await readMciFamilyDesk(db, w.erDesk);
    expect(desk.withheld).toBe(2);
    expect(desk.rows).toEqual([{ label: packs[0]!.alias, packNo: packs[0]!.packNo, stage: "Waiting", where: "ER" }]);
    expect(JSON.stringify(desk.rows)).not.toMatch(new RegExp(`Ravi Assault|${packs[1]!.alias}|${packs[1]!.packNo}|yellow|Delayed|assault`, "i"));
  });
});
