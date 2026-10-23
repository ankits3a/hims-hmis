import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../../kernel/db/client";
import { formularyReferenceInteractions, opdPrescriptions } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, openOpdVisit, seedOpdBase, seedOpdMasters,
} from "../../../../test/helpers/opd";
import { runRxChecks } from "../../opd";
import {
  addInteraction, addMedicine, addSalt, updateInteraction,
  DDINTER_LICENCE, DDINTER_SOURCE, REFERENCE_INTERACTION_LABEL, ddinterReferenceEnabled,
  importDdinterInteractions, replayReferenceInteractions,
} from "../index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { RxLine } from "../../opd";

/**
 * ACCEPTANCE — issue #617, spec docs/specs/617-ddinter-reference.md (design: decision 0052; licence confirmed
 * by the owner 2026-10-23). DDInter 2.0 MAJOR pairs as a labelled reference layer beside the curated book,
 * behind `DDINTER_REFERENCE_ENABLED` (ships OFF), with a replay before anyone turns it on.
 *
 * The CSV is synthetic and tiny (`test/fixtures/ddinter/`), in DDInter's export shape; nothing here downloads.
 * The pairs are real pharmacology (warfarin + aspirin, clarithromycin + simvastatin, methotrexate + trimethoprim
 * are well-known major interactions), because a fixture that lies about pharmacology makes the check meaningless.
 */
jest.setTimeout(120_000);

const CSV = readFileSync(join(__dirname, "..", "..", "..", "..", "test", "fixtures", "ddinter", "ddinter-sample.csv"), "utf8");
const OWNER: Actor = { type: "user", id: "01HOWNER000000000000000617" };
const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000617" };
const MON = new Date("2026-08-17T04:00:00.000Z");
const FLAG = "DDINTER_REFERENCE_ENABLED";

const rx = (drug: string, medicineId: string): RxLine => ({
  drug, medicineId, dose: "1 tab", route: "oral", frequency: "OD", durationDays: 5, instructions: null, noSubstitution: false,
});

describe("spec #617 — DDInter major interactions as a reference layer", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let saved: string | undefined;
  const salt: Record<string, string> = {};
  const med: Record<string, string> = {};

  const withFlag = async <T>(value: string | undefined, fn: () => Promise<T>): Promise<T> => {
    const before = process.env[FLAG];
    if (value === undefined) delete process.env[FLAG]; else process.env[FLAG] = value;
    try { return await fn(); } finally { if (before === undefined) delete process.env[FLAG]; else process.env[FLAG] = before; }
  };
  const load = (apply: boolean, files: string[] = [CSV]) =>
    importDdinterInteractions(db, OWNER, { files, retrievedOn: "2026-10-23", apply });
  const checks = (lines: RxLine[]) => runRxChecks(db, "01HNOPATIENT00000000000617", lines, MON);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); saved = process.env[FLAG]; });
  afterAll(async () => { if (saved === undefined) delete process.env[FLAG]; else process.env[FLAG] = saved; await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    delete process.env[FLAG];
    const salts: [string, string, string[]][] = [
      ["warfarin", "warfarin", []], ["aspirin", "acetylsalicylic acid", ["aspirin"]], ["fluconazole", "fluconazole", []],
      ["clarithromycin", "clarithromycin", []], ["simvastatin", "simvastatin", []], ["methotrexate", "methotrexate", []],
      ["trimethoprim", "trimethoprim", []], ["paracetamol", "paracetamol", []],
    ];
    for (const [key, name, aliases] of salts) {
      salt[key] = (await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name, aliases }))).saltId;
    }
    const meds: [string, string, string, "systemic" | "topical"][] = [
      ["Warf 5", "warfarin", "tablet", "systemic"], ["Ecosprin 75", "aspirin", "tablet", "systemic"],
      ["Claribid 500", "clarithromycin", "tablet", "systemic"], ["Simvas 20", "simvastatin", "tablet", "systemic"],
      ["Folitrax 7.5", "methotrexate", "tablet", "systemic"], ["Trimopan 100", "trimethoprim", "tablet", "systemic"],
      ["Trimethoprim Eye Drops", "trimethoprim", "drops", "topical"], ["Crocin 650", "paracetamol", "tablet", "systemic"],
    ];
    for (const [brandName, key, form, routeClass] of meds) {
      med[brandName] = (await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
        brandName, form, routeClass, salts: [{ saltId: salt[key]! }],
      }))).medicineId;
    }
  });

  it("spec #617 D1 — loads Major pairs only, maps names, counts what it skips, dry run by default, idempotent", async () => {
    const dry = await load(false);
    expect(dry.major).toBe(5);
    expect(dry.skipped).toEqual({ moderate: 1, minor: 1, unknown: 1 });
    expect(dry.mapped).toBe(4);
    // The quoted comma is one name, not a shifted row.
    expect(dry.unmappedNames).toEqual([{ name: "sodium chloride, hypertonic", count: 1 }]);
    expect(dry.added).toBe(4);
    expect(await db.select().from(formularyReferenceInteractions)).toHaveLength(0);

    const first = await load(true);
    expect(first.added).toBe(4);
    const rows = await db.select().from(formularyReferenceInteractions);
    expect(rows).toHaveLength(4);
    // "Aspirin" reached the moiety named "acetylsalicylic acid" through its alias.
    expect(rows.some((r) => [r.saltAId, r.saltBId].includes(salt.aspirin!))).toBe(true);
    // Only Major: warfarin + paracetamol (Moderate in the file) is not loaded.
    expect(rows.some((r) => [r.saltAId, r.saltBId].includes(salt.paracetamol!))).toBe(false);

    const second = await load(true);
    expect({ added: second.added, retired: second.retired, unchanged: second.unchanged }).toEqual({ added: 0, retired: 0, unchanged: 4 });
    expect(await db.select().from(formularyReferenceInteractions)).toHaveLength(4);
  });

  it("spec #617 D2 — OFF by default: the check is unchanged with pairs loaded; a stray value is refused", async () => {
    await load(true);
    const lines = [rx("Claribid 500", med["Claribid 500"]!), rx("Simvas 20", med["Simvas 20"]!)];
    const off = await withFlag(undefined, () => checks(lines));
    const offExplicit = await withFlag("false", () => checks(lines));
    expect(off.interactions).toEqual([]);
    expect(offExplicit.interactions).toEqual([]);
    expect(ddinterReferenceEnabled({})).toBe(false);
    expect(ddinterReferenceEnabled({ [FLAG]: "false" })).toBe(false);
    expect(ddinterReferenceEnabled({ [FLAG]: "true" })).toBe(true);
    expect(() => ddinterReferenceEnabled({ [FLAG]: "yes" })).toThrow();
    expect(() => ddinterReferenceEnabled({ [FLAG]: "1" })).toThrow();
  });

  it("spec #617 D3 — ON: a reference pair is a severe, labelled, marked hit", async () => {
    await load(true);
    const lines = [rx("Claribid 500", med["Claribid 500"]!), rx("Simvas 20", med["Simvas 20"]!)];
    const on = await withFlag("true", () => checks(lines));
    expect(on.interactions).toHaveLength(1);
    const hit = on.interactions[0]!;
    expect(hit.severity).toBe("severe");
    expect(hit.note.startsWith(REFERENCE_INTERACTION_LABEL)).toBe(true);
    expect(REFERENCE_INTERACTION_LABEL).toBe("Reference interaction (DDInter)");
    expect(hit.note).toContain(DDINTER_SOURCE);
    expect(hit.reference).toBe("ddinter");
    expect([...hit.saltPair].sort()).toEqual([salt.clarithromycin!, salt.simvastatin!].sort());
  });

  it("spec #617 D4 — the curated book wins, active or retired", async () => {
    await withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
      saltAId: salt.warfarin!, saltBId: salt.aspirin!, severity: "severe",
      note: "bleeding risk — avoid or monitor INR closely", source: "seed-2026-08",
    }));
    const { interactionId } = await withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
      saltAId: salt.clarithromycin!, saltBId: salt.simvastatin!, severity: "severe",
      note: "myopathy risk", source: "seed-2026-08",
    }));
    await withTx(db, (tx) => updateInteraction(tx, PHARMACIST, interactionId, { active: false }));
    await load(true);

    const warf = await withFlag("true", () => checks([rx("Warf 5", med["Warf 5"]!), rx("Ecosprin 75", med["Ecosprin 75"]!)]));
    expect(warf.interactions).toHaveLength(1);
    expect(warf.interactions[0]).toMatchObject({ severity: "severe", note: "bleeding risk — avoid or monitor INR closely" });
    expect(warf.interactions[0]!.reference).toBeUndefined();

    const retired = await withFlag("true", () => checks([rx("Claribid 500", med["Claribid 500"]!), rx("Simvas 20", med["Simvas 20"]!)]));
    expect(retired.interactions).toEqual([]);
  });

  it("spec #617 D5 — the replay compares warning rates over stored prescriptions and writes nothing", async () => {
    await withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
      saltAId: salt.warfarin!, saltBId: salt.aspirin!, severity: "severe",
      note: "bleeding risk — avoid or monitor INR closely", source: "seed-2026-08",
    }));
    await load(true);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const { deptId, roomId } = await seedOpdMasters(db);
    const dr = await mkDoctor(db, { username: "dr617", departmentId: deptId, roomId });
    const clerk = await mkUser(db, "clerk617", ["front_office"]);

    // Stored as issued prescriptions are stored (one active row per visit); the replay reads rows, not the issue path.
    const issue = async (lines: RxLine[], minutes: number): Promise<void> => {
      const at = new Date(MON.getTime() + minutes * 60_000);
      const patient = await mkPatient(db, clerk.actor, {});
      const { encounterId } = await openOpdVisit(db, { clerk: clerk.actor, patientId: patient.id, departmentId: deptId, doctorId: dr.doctorId }, at);
      await db.insert(opdPrescriptions).values({
        id: newId(), encounterId, patientId: patient.id, doctorId: dr.doctorId, version: 1, lines, document: {},
        allergyOverrides: [], issuedBy: dr.userId, issuedAt: at,
      });
    };
    await issue([rx("Warf 5", med["Warf 5"]!), rx("Ecosprin 75", med["Ecosprin 75"]!)], 0);
    await issue([rx("Claribid 500", med["Claribid 500"]!), rx("Simvas 20", med["Simvas 20"]!)], 20);
    await issue([rx("Folitrax 7.5", med["Folitrax 7.5"]!), rx("Trimopan 100", med["Trimopan 100"]!)], 40);
    await issue([rx("Crocin 650", med["Crocin 650"]!)], 60);

    const count = async (): Promise<number> =>
      Number((await db.execute<{ n: string }>(sql`select (select count(*) from events) + (select count(*) from formulary_reference_interactions) + (select count(*) from opd_prescriptions) as n`)).rows[0]!.n);
    const before = await count();
    const r = await withFlag(undefined, () => replayReferenceInteractions(db, {
      since: new Date(MON.getTime() - 60 * 60_000), until: new Date(MON.getTime() + 24 * 60 * 60_000),
    }));
    expect(await count()).toBe(before);

    expect(r.prescriptions).toBe(4);
    expect(r.curatedOnly).toEqual({ prescriptionsWarned: 1, warnings: 1 });
    expect(r.withReference).toEqual({ prescriptionsWarned: 3, warnings: 3 });
    expect(r.ratio).toBeCloseTo(3);
    expect(r.moreThanDoubles).toBe(true);
  });

  it("spec #617 D6 — attribution on every row; a topical line never raises a reference pair", async () => {
    await load(true);
    const rows = await db.select().from(formularyReferenceInteractions);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.source).toBe(DDINTER_SOURCE);
      expect(row.licence).toBe(DDINTER_LICENCE);
      expect(row.retrievedOn).toBe("2026-10-23");
    }
    expect(DDINTER_SOURCE).toBe("DDInter 2.0");
    expect(DDINTER_LICENCE).toBe("CC BY-NC-SA 4.0");

    const systemic = await withFlag("true", () => checks([rx("Folitrax 7.5", med["Folitrax 7.5"]!), rx("Trimopan 100", med["Trimopan 100"]!)]));
    expect(systemic.interactions).toHaveLength(1);
    const topical = await withFlag("true", () => checks([
      rx("Folitrax 7.5", med["Folitrax 7.5"]!), rx("Trimethoprim Eye Drops", med["Trimethoprim Eye Drops"]!),
    ]));
    expect(topical.interactions).toEqual([]);
  });
});
