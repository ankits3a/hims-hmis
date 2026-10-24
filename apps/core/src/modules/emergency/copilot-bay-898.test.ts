import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ErBayProposalSchema } from "@hmis/contracts";
import { events } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErWorld } from "../../../test/helpers/emergency";
import { erBayZone, placeInBay, readBayProposal, registerArrival, triage } from "./index";
import type { ErEsiLevel } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ErWorld } from "../../../test/helpers/emergency";

/**
 * #898 — the T2 bay proposal: the copilot names one free bay by acuity (ESI 2 red and monitored, 3 yellow, 4–5 green;
 * a child a paeds bay first), a person places through `place_in_bay`. NEVER a resus or isolation bay; a bay whose zone
 * cannot be read is never proposed (fail closed). The placement logs whether the pick was the copilot's.
 */
jest.setTimeout(240_000);
const key = (): string => randomUUID();
const MIN = 60_000;

describe("erBayZone (pure)", () => {
  const bay = (code: string, attributes: Record<string, unknown> = {}, roomName: string | null = null) =>
    erBayZone({ code, name: code, roomCode: null, roomName, attributes: { class: "emergency", isolation: "none", ...attributes } });

  it("reads the zone from the bay's words or its erZone attribute", () => {
    expect(bay("YELLOW-01")).toBe("yellow");
    expect(bay("ER-07", {}, "Green zone")).toBe("green");
    expect(bay("FT-2", {}, "Fast track")).toBe("green");
    expect(bay("ER-08", { erZone: "red" })).toBe("red");
    expect(bay("ER-09", { genderRule: "paediatric" })).toBe("paeds");
  });

  it("resus and isolation win over every other reading; IPD attributes outrank words", () => {
    expect(bay("RED-01", {}, "Resus")).toBe("resus");
    expect(bay("GREEN-01", { isolation: "contact" })).toBe("isolation");
    expect(bay("GREEN-02", { negativePressure: true })).toBe("isolation");
    expect(bay("RED-03", { equipment: ["monitor", "ventilator_ready"] })).toBe("resus");
    expect(bay("YELLOW-03", { icu: true })).toBe("resus");
    expect(bay("ER-ISO-1")).toBe("isolation");
  });

  it("fails closed: no zone word, two zones, or an erZone it does not know", () => {
    expect(bay("ER-R1")).toBeNull();
    expect(bay("ER-B12", {}, "Bay 2")).toBeNull();
    expect(bay("RED-04", {}, "Yellow zone")).toBeNull();
    expect(bay("ER-10", { erZone: "purple" })).toBeNull();
    // "Fred" and "credit" are not "red": words only.
    expect(bay("FRED-1")).toBeNull();
  });
});

describe("ER copilot — the bay proposal (#898)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkErWorld(db); });

  const er = (attrs: Record<string, unknown> = {}) => ({ class: "emergency", genderRule: "any", ...attrs });
  const arrive = async (age: number, now: Date) => {
    const p = await w.patient("female", age, `Patient ${String(age)}`);
    return registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in", complaint: "pain" }, { now });
  };
  const tri = (episodeId: string, level: ErEsiLevel) => triage(db, w.erNurse, {
    idempotencyKey: key(), episodeId, level, reason: "test",
    decision: { lifeSaving: level === 1, highRisk: level <= 2, resources: level <= 3 ? "many" : "one", dangerVitals: false },
  });
  const propose = async (episodeId: string) => ErBayProposalSchema.parse(await readBayProposal(db, w.erNurse, episodeId));

  it("by acuity: ESI 3 → the lowest free yellow bay, never the isolation one; the person's placement logs it as taken", async () => {
    await w.bed("YELLOW-00", er({ isolation: "contact" }));
    const y1 = await w.bed("YELLOW-01", er());
    await w.bed("YELLOW-02", er());
    await w.bed("GREEN-01", er());
    const a = await arrive(40, new Date(Date.now() - 10 * MIN));
    expect(await propose(a.episodeId)).toMatchObject({ bay: null, none: "not_triaged", source: "rules" });
    await tri(a.episodeId, 3);
    const p = await propose(a.episodeId);
    expect(p).toMatchObject({ bay: { bedId: y1, code: "YELLOW-01", zone: "yellow" }, none: null, wanted: ["yellow"] });
    expect(p.reasons[0]).toBe("ESI 3: yellow zone");
    // A read: nothing placed.
    expect((await propose(a.episodeId)).bay?.bedId).toBe(y1);
    await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: y1 });
    const [ev] = await db.select().from(events).where(and(eq(events.name, "er.placed"), eq(events.correlationId, a.episodeId)));
    expect(ev!.payload).toMatchObject({ copilotBedId: y1, override: false });
    expect((await propose(a.episodeId)).none).toBe("in_bay");
  });

  it("a different bay chosen by the person is logged as an override", async () => {
    await w.bed("GREEN-01", er());
    const g2 = await w.bed("GREEN-02", er());
    const a = await arrive(40, new Date(Date.now() - 10 * MIN));
    await tri(a.episodeId, 4);
    expect((await propose(a.episodeId)).bay?.code).toBe("GREEN-01");
    await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: g2 });
    const [ev] = await db.select().from(events).where(and(eq(events.name, "er.placed"), eq(events.correlationId, a.episodeId)));
    expect(ev!.payload).toMatchObject({ override: true });
  });

  it("ESI 2 needs a monitored red bay; a resus-grade bed is not offered", async () => {
    await w.bed("RED-00", er({ equipment: ["monitor", "ventilator_ready"] }));
    await w.bed("RED-01", er({ equipment: [] }));
    const r2 = await w.bed("RED-02", er({ equipment: ["monitor"] }));
    const a = await arrive(40, new Date(Date.now() - 10 * MIN));
    await tri(a.episodeId, 2);
    expect((await propose(a.episodeId)).bay).toMatchObject({ bedId: r2, zone: "red" });
  });

  it("a child is offered a paeds bay first; an adult never is", async () => {
    await w.bed("PAEDS-01", er());
    await w.bed("GREEN-01", er());
    const child = await arrive(6, new Date(Date.now() - 10 * MIN));
    const adult = await arrive(40, new Date(Date.now() - 10 * MIN));
    await tri(child.episodeId, 4);
    await tri(adult.episodeId, 4);
    expect(await propose(child.episodeId)).toMatchObject({ bay: { code: "PAEDS-01", zone: "paeds" }, wanted: ["paeds", "green"] });
    expect(await propose(adult.episodeId)).toMatchObject({ bay: { code: "GREEN-01" }, wanted: ["green"] });
  });

  it("never resus or isolation, at any level: with only those (and unnamed bays) free, there is nothing to propose", async () => {
    await w.bed("RESUS-01", er());
    await w.bed("ISO-01", er());
    await w.bed("GREEN-03", er({ isolation: "droplet" }));
    await w.bed("YELLOW-03", er({ equipment: ["ventilator_ready"] }));
    await w.bed("ER-R1", er());
    for (const level of [1, 2, 3, 4, 5] as const) {
      const a = await arrive(40, new Date(Date.now() - 10 * MIN));
      await tri(a.episodeId, level);
      const p = await propose(a.episodeId);
      expect([level, p.bay]).toEqual([level, null]);
      expect(p.none).toBe(level === 1 ? "esi_1" : "no_bay");
    }
  });
});
