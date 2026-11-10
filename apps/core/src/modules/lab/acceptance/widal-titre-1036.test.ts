import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { withTx } from "../../../kernel/db/client";
import {
  labAnalytes, labOrderableAnalytes, labOrderables, labReferenceRanges, patients, registrationConfig, services,
} from "../../../kernel/db/schema";
import { QuickEntryError, saveQuickResults, startQuick } from "../quick";
import { LAB_CATALOGUE_STANDARD_DATA } from "../../../../scripts/data/lab-catalogue-standard";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1036, spec docs/specs/1036-widal-titre.md (owner APPROVED 2026-11-06): the server half.
 * A positive Widal read as negative: O and H carried the range "Negative" and a titre was never flagged.
 */
const ACTOR: Actor = { type: "user", id: "01USER0000000000000000001" } as Actor;
const PATIENT = "01PATIENT0000000000000001";
const WIDAL = "01SERVICE0000000000000001";
const NOW = new Date("2026-11-06T06:00:00Z");
const CODES = ["WIDAL_TO", "WIDAL_TH", "WIDAL_AH", "WIDAL_BH"] as const;

describe("#1036 — Widal titres (server)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const ids: Record<string, string> = {};

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await db.insert(patients).values({
      id: PATIENT, uhid: "HMS-00000001-5", name: "Test Patient", sex: "female", administrativeGender: "female",
      dob: new Date("1990-01-01T00:00:00Z"), createdBy: ACTOR.id, updatedBy: ACTOR.id,
    });
    await db.insert(services).values({
      id: WIDAL, code: "WIDAL", name: "Widal test", category: "investigation", createdBy: ACTOR.id, updatedBy: ACTOR.id,
    });
    await db.insert(labOrderables).values({
      serviceId: WIDAL, code: "WIDAL", nameEn: "Widal test", discipline: "serology",
      specimenType: "serum", container: "sst", tatMinutesRoutine: 480, createdBy: ACTOR.id, updatedBy: ACTOR.id,
    });
    for (const code of CODES) ids[code] = newId();
    await db.insert(labAnalytes).values(CODES.map((code) => ({
      id: ids[code]!, code, nameEn: code === "WIDAL_TO" ? "Widal — S. typhi O" : code, resultType: "text",
      createdBy: ACTOR.id, updatedBy: ACTOR.id,
    })));
    await db.insert(labOrderableAnalytes).values(CODES.map((code, i) => ({ serviceId: WIDAL, analyteId: ids[code]!, position: i + 1 })));
    await db.insert(labReferenceRanges).values(CODES.map((code) => ({
      id: newId(), analyteId: ids[code]!, sex: "any" as const, ageMinDays: 0, ageMaxDays: 36500, text: "Non-Reactive",
      source: "test", effectiveFrom: "2026-01-01", createdBy: ACTOR.id,
    })));
  });

  const save = async (values: Partial<Record<(typeof CODES)[number], string>>) => {
    const row = await withTx(db, (tx) => startQuick(tx, ACTOR, {
      patientId: PATIENT, encounterNo: "V2611060001", serviceIds: [WIDAL], bloodCollected: true,
    }, NOW));
    return withTx(db, (tx) => saveQuickResults(tx, ACTOR, {
      id: row.id, summary: "", lines: Object.entries(values).map(([code, value]) => ({ analyteId: ids[code]!, value: value! })),
    }, NOW));
  };

  it("spec #1036 D1: the standard catalogue and the production correction give every Widal antigen 'Non-Reactive'", () => {
    const ranges = LAB_CATALOGUE_STANDARD_DATA.referenceRanges.filter((r) => (CODES as readonly string[]).includes(r.analyteCode));
    expect(ranges.map((r) => [r.analyteCode, r.text, r.low, r.high]).sort()).toEqual(
      [...CODES].sort().map((c) => [c, "Non-Reactive", null, null]),
    );
    const dir = join(__dirname, "../../../../drizzle");
    const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(join(dir, f), "utf8"))
      .find((s) => s.includes("'Non-Reactive'"));
    expect(sql).toBeDefined();
    for (const c of CODES) expect(sql).toContain(`'${c}'`);
  });

  it("spec #1036 D2: O, AH and BH are flagged A from 1:80, H from 1:160; lower titres and Non-Reactive are N", async () => {
    const high = await save({ WIDAL_TO: "1:80", WIDAL_TH: "1:160", WIDAL_AH: "1:80", WIDAL_BH: "Non-Reactive" });
    expect(high.lines.map((l) => [l.code, l.value, l.flag, l.refText])).toEqual([
      ["WIDAL_TO", "1:80", "A", "Non-Reactive"],
      ["WIDAL_TH", "1:160", "A", "Non-Reactive"],
      ["WIDAL_AH", "1:80", "A", "Non-Reactive"],
      ["WIDAL_BH", "Non-Reactive", "N", "Non-Reactive"],
    ]);
    const low = await save({ WIDAL_TO: "1:40", WIDAL_TH: "1:80", WIDAL_BH: "1:20" });
    expect(low.lines.map((l) => l.flag)).toEqual(["N", "N", "N"]);
  });

  it("spec #1036 D5: a Widal value that is not a titre or Non-Reactive is refused; '1;80', 'NEGATIVE' and 'nr' are normalised", async () => {
    const ok = await save({ WIDAL_TO: "1;80", WIDAL_TH: "NEGATIVE", WIDAL_AH: "nr" });
    expect(ok.lines.map((l) => [l.value, l.flag])).toEqual([["1:80", "A"], ["Non-Reactive", "N"], ["Non-Reactive", "N"]]);
    const refused = await save({ WIDAL_TO: "positive" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(QuickEntryError);
    expect((refused as QuickEntryError).code).toBe("value_not_titre");
    expect((refused as QuickEntryError).message).toContain("S. typhi O");
  });
});
