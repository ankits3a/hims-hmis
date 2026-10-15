import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { eq, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { PERMISSION_KEY } from "../../kernel/auth/decorators";
import { formularyGenericSubstances, formularyGenerics, formularyReferenceLabels, formularyReferenceNames, formularySubstances } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { chosenLabelIds, chosenLabelLines } from "../../../scripts/import-fda-labels";
import { FormularyController } from "./formulary.controller";
import { importReferenceLabels, planReferenceImport, referenceForGeneric, referenceSectionsOf } from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * #604-style done means for #616 (decision 0051, plan 2026-10-07 §11): US FDA label text as a labelled REFERENCE layer.
 * Fixtures are synthetic and tiny (`test/fixtures/fda/`); nothing here downloads.
 */

jest.setTimeout(120_000);

const FIX = join(__dirname, "..", "..", "..", "test", "fixtures", "fda");
const CHOICES = readFileSync(join(FIX, "choices-sample.json"), "utf8");
const LABELS = readFileSync(join(FIX, "labels-sample.jsonl"), "utf8");
const OWNER: Actor = { type: "user", id: "01HOWNER000000000000000001" };
const SOURCE = "openFDA drug/label bulk export";

describe("#616 FDA label reference layer", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  const run = (apply: boolean, labels = LABELS, retrievedOn = "2026-10-07") =>
    importReferenceLabels(db, OWNER, { choicesJson: CHOICES, labelsJsonl: labels, source: SOURCE, retrievedOn, apply });

  it("maps openFDA fields to the reference sections, prescription and over-the-counter alike", () => {
    const rx = referenceSectionsOf(JSON.parse(LABELS.split("\n")[0]!) as Record<string, unknown>);
    expect(Object.keys(rx).sort()).toEqual([
      "boxed_warning", "children", "contraindications", "directions", "elderly", "interactions", "lactation", "overdose", "patient_information",
      "pregnancy", "side_effects", "storage", "uses", "warnings",
    ].sort());
    expect(rx.warnings).toContain("Warnings.");
    expect(rx.warnings).toContain("Precautions.");
    const otc = referenceSectionsOf(JSON.parse(LABELS.split("\n")[3]!) as Record<string, unknown>);
    expect(otc.warnings).toContain("Do not use.");
    expect(otc.warnings).toContain("Stop use.");
    expect(otc.uses).toContain("Uses.");
  });

  it("plans only the chosen labels and names a chosen label the files do not hold", () => {
    const plan = planReferenceImport(CHOICES, LABELS);
    expect(plan.rows.map((r) => [r.refKey, r.labelId, r.product, r.effectiveDate]).sort()).toEqual([
      ["acetaminophen", "fake-label-0001", "Fakeamol", "2025-01-01"],
      ["amoxicillin", "fake-label-0002", "Fakemox", "2024-06-15"],
      ["amoxicillin + clavulanate", "fake-label-0003", "Fakmentin", "2023-03-01"],
      ["cetirizine", "fake-label-0004", "Fakecool", "2020-01-01"],
    ].sort());
    expect(plan.missing).toEqual(["lost"]);
    expect(plan.names).toContainEqual({ name: "paracetamol", refKey: "acetaminophen" });
    expect(plan.names).toContainEqual({ name: "potassium clavulanate", refKey: "clavulanate" });
  });

  it("the script keeps only the chosen labels, from a published bulk file or JSON lines", () => {
    const wanted = chosenLabelIds(CHOICES);
    const records = LABELS.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as unknown);
    const published = JSON.stringify({ meta: { results: { total: records.length } }, results: records });
    const ids = (lines: string[]) => lines.map((l) => (JSON.parse(l) as { id: string }).id).sort();
    const four = ["fake-label-0001", "fake-label-0002", "fake-label-0003", "fake-label-0004"];
    expect(ids(chosenLabelLines(published, wanted))).toEqual(four);
    expect(ids(chosenLabelLines(LABELS, wanted))).toEqual(four);
  });

  it("a dry run writes nothing; apply writes each row with its source and retrieval date; a re-run changes nothing; a new version retires the old row", async () => {
    const dry = await run(false);
    expect(dry).toMatchObject({ applied: false, labels: { added: 4, changed: 0, unchanged: 0, missing: 1 } });
    expect(await db.select().from(formularyReferenceLabels)).toHaveLength(0);
    expect(await db.select().from(formularyReferenceNames)).toHaveLength(0);
    await run(true);
    const rows = await db.select().from(formularyReferenceLabels);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.source === SOURCE && r.retrievedOn === "2026-10-07" && r.retiredAt === null)).toBe(true);
    expect(await run(true)).toMatchObject({ labels: { added: 0, changed: 0, unchanged: 4 } });
    const v8 = LABELS.replace('"id": "fake-label-0002", "set_id": "fake-set-0002", "version": "7"', '"id": "fake-label-0012", "set_id": "fake-set-0002", "version": "8"');
    const choices8 = CHOICES.replace('"label_id": "fake-label-0002"', '"label_id": "fake-label-0012"');
    const out = await importReferenceLabels(db, OWNER, { choicesJson: choices8, labelsJsonl: v8, source: SOURCE, retrievedOn: "2026-11-07", apply: true });
    expect(out.labels).toMatchObject({ added: 0, changed: 1, unchanged: 3 });
    const amox = await db.select().from(formularyReferenceLabels).where(eq(formularyReferenceLabels.refKey, "amoxicillin"));
    // [label, live, retrieved]: the old version is kept, retired; the new one is live with its own retrieval date.
    expect(amox.map((r) => [r.labelId, r.retiredAt === null, r.retrievedOn]).sort()).toEqual([
      ["fake-label-0002", false, "2026-10-07"], ["fake-label-0012", true, "2026-11-07"],
    ]);
    expect(await db.select().from(formularyReferenceLabels).where(isNull(formularyReferenceLabels.retiredAt))).toHaveLength(4);
  });

  it("a bad retrieval date or a file that is not the coverage shape refuses and writes nothing", async () => {
    await expect(run(true, LABELS, "07-10-2026")).rejects.toThrow();
    await expect(importReferenceLabels(db, OWNER, { choicesJson: "{}", labelsJsonl: LABELS, source: SOURCE, retrievedOn: "2026-10-07", apply: true })).rejects.toThrow();
    expect(await db.select().from(formularyReferenceLabels)).toHaveLength(0);
  });

  describe("the read for a generic", () => {
    const sub = new Map<string, string>();
    const generic = async (sctid: string, names: string[]) => {
      const id = newId();
      await db.insert(formularyGenerics).values({
        id, sctid, name: names.join(" + "), nameNormalized: names.join(" + ").toLowerCase(), doseForm: "Oral tablet", routeOfAdministration: "Oral route",
        source: "test", createdBy: OWNER.id, updatedBy: OWNER.id,
      });
      for (const n of names) {
        if (!sub.has(n)) {
          const sid = newId();
          await db.insert(formularySubstances).values({ id: sid, sctid: `s-${n}`, name: n, source: "test", createdBy: OWNER.id, updatedBy: OWNER.id });
          sub.set(n, sid);
        }
        await db.insert(formularyGenericSubstances).values({ genericId: id, substanceId: sub.get(n)!, strength: "500", unit: "mg" });
      }
    };
    beforeEach(async () => {
      sub.clear();
      await run(true);
      await generic("g-para", ["Paracetamol"]);
      await generic("g-coamox", ["Amoxicillin trihydrate", "Potassium clavulanate"]);
      await generic("g-acepara", ["Aceclofenac", "Paracetamol"]);
      await generic("g-orni", ["Ornidazole"]);
    });

    it("a single substance shows its label with product, effective date, source and retrieval date", async () => {
      const r = await referenceForGeneric(db, "g-para");
      expect(r).toMatchObject({ status: "label", combination: false, missing: [] });
      expect(r!.entries).toHaveLength(1);
      expect(r!.entries[0]).toMatchObject({
        refKey: "acetaminophen", product: "Fakeamol", effectiveDate: "2025-01-01", source: SOURCE, retrievedOn: "2026-10-07", setId: "fake-set-0001", version: "3",
      });
      expect(r!.entries[0]!.sections.uses).toContain("Uses.");
    });

    it("a combination with its own label shows that label", async () => {
      const r = await referenceForGeneric(db, "g-coamox");
      expect(r).toMatchObject({ status: "label", combination: true });
      expect(r!.entries.map((e) => e.refKey)).toEqual(["amoxicillin + clavulanate"]);
    });

    it("a combination without its own label shows each component's and names the missing ones", async () => {
      const r = await referenceForGeneric(db, "g-acepara");
      expect(r).toMatchObject({ status: "components", combination: true, missing: ["aceclofenac"] });
      expect(r!.entries.map((e) => e.refKey)).toEqual(["acetaminophen"]);
    });

    it("nothing on file reads as none; an unknown generic is undefined", async () => {
      expect(await referenceForGeneric(db, "g-orni")).toMatchObject({ status: "none", entries: [], missing: ["ornidazole"] });
      expect(await referenceForGeneric(db, "no-such")).toBeUndefined();
    });
  });

  it("the route needs formulary.read (reference text, no new permission)", () => {
    const fn = (FormularyController.prototype as unknown as Record<string, object>).fdaReference!;
    expect((Reflect.getMetadata(PERMISSION_KEY, fn) as { permission: string }).permission).toBe("formulary.read");
  });

  it("reference only: no file outside the formulary module's reference reader touches the table (never a dose or a safety check)", () => {
    const src = join(__dirname, "..", "..");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f) && /formularyReference(Labels|Names)|formulary_reference_/.test(readFileSync(p, "utf8"))) hits.push(relative(src, p));
      }
    };
    walk(src);
    expect(hits.sort()).toEqual(["kernel/db/schema/formulary.ts", "modules/formulary/reference-labels.ts"]);
  });
});
