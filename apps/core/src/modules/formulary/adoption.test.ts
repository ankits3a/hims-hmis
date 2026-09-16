import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { events, formularySubstances } from "../../kernel/db/schema";
import { adoptDecisions } from "./adoption";
import { attestSubstance, pageMappingWorklist, writeProposals } from "./mapping";
import { addSalt } from "./masters";
import { catalogueCensus } from "./reads";
import { normalizeDrugName } from "./resolve";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { AdoptionItem } from "./adoption";

/**
 * ═══ ADOPTION: EVERY PENDING SUBSTANCE DECIDED UNDER ONE NAMED RESOLUTION (phase-3 doc §1) ═══
 *
 * The fixtures are true statements from the release: amoxicillin trihydrate IS amoxicillin, and
 * warfarin sodium IS warfarin.
 */
const OWNER: Actor = { type: "user", id: "01HOWNER00000000000000001" };
const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000001" };
const RESOLUTION = "owner-resolution-2026-09-16";

const SCT = {
  amoxicillin: "372687004",
  amoxTrihydrate: "96068000",
  warfarinSodium: "63167009",
  sodiumChloride: "387390002",
  eggPhospholipid: "226913003",
  metoprololTartrate: "386866009",
  metoprololSuccinate: "108609000",
} as const;

describe("adopting the release's decisions under a resolution (phase 3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function releaseSubstance(sctid: string, released: string, image: string | null): Promise<{ id: string; image: string }> {
    const id = newId();
    await db.execute(sql`
      insert into formulary_substances (id, sctid, name, synonyms, mapping_status, source, created_by, updated_by)
      values (${id}, ${sctid}, ${released}, '[]'::jsonb, 'pending', 'nrces-2026-09', 'nrces-test', 'nrces-test')
    `);
    const imageId = newId();
    if (image !== null) {
      await db.execute(sql`
        insert into formulary_salts (id, name, aliases, source_ref, created_by, updated_by)
        values (${imageId}, ${image}, '[]'::jsonb, ${sctid}, 'cds-import', 'cds-import')
      `);
    }
    return { id, image: imageId };
  }

  async function catalogueProduct(brand: string, parts: { salt: string; sctid: string }[]): Promise<string> {
    const id = newId();
    await db.execute(sql`
      insert into formulary_medicines (id, brand_name, name_normalized, form, route_class, source_ref, created_by, updated_by)
      values (${id}, ${brand}, ${normalizeDrugName(brand)}, 'tablet', 'systemic', ${`brand:${id}`}, 'cds-import', 'cds-import')
    `);
    for (const p of parts) {
      await db.execute(sql`
        insert into formulary_medicine_salts (medicine_id, salt_id, strength, source, derived_from)
        values (${id}, ${p.salt}, null, 'derived', ${p.sctid})
      `);
    }
    return id;
  }

  const adopt = (items: AdoptionItem[], actor: Actor = OWNER, resolution = RESOLUTION) =>
    withTx(db, (tx) => adoptDecisions(tx, actor, resolution, items));

  async function row(id: string): Promise<typeof formularySubstances.$inferSelect> {
    const rows = await db.select().from(formularySubstances).where(eq(formularySubstances.id, id));
    if (rows[0] === undefined) throw new Error(`no substance ${id}`);
    return rows[0];
  }

  async function saltName(id: string | null): Promise<string | null> {
    if (id === null) return null;
    const r = await db.execute<{ name: string }>(sql`select name from formulary_salts where id = ${id}`);
    return r.rows[0]?.name ?? null;
  }

  async function payloads(name: string): Promise<Record<string, unknown>[]> {
    const rows = await db.select({ payload: events.payload }).from(events).where(eq(events.name, name));
    return rows.map((r) => r.payload as Record<string, unknown>);
  }

  it("decides every pending substance, a salt after its base, and names the resolution on every row and event", async () => {
    const amox = await releaseSubstance(SCT.amoxicillin, "Amoxicillin", "Amoxicillin");
    const trihydrate = await releaseSubstance(SCT.amoxTrihydrate, "Amoxicillin trihydrate", "Amoxicillin trihydrate");
    const nacl = await releaseSubstance(SCT.sodiumChloride, "NaCl - Sodium chloride", null);
    const egg = await releaseSubstance(SCT.eggPhospholipid, "Egg phospholipid", null);
    const mox = await catalogueProduct("Mox 250", [{ salt: trihydrate.image, sctid: SCT.amoxTrihydrate }]);
    await withTx(db, (tx) => writeProposals(tx, "drafter:release@1", [
      { sctid: SCT.amoxTrihydrate, moietyName: "Amoxicillin", basis: "release_boss", evidence: { support: 3 } },
    ]));

    // The salt is listed FIRST: it must wait for its base, whose entry is not yet a moiety.
    const report = await adopt([
      { sctid: SCT.amoxTrihydrate, decision: "moiety", moietyName: "amoxicillin", reason: "trihydrate of amoxicillin (rule 1)" },
      { sctid: SCT.amoxicillin, decision: "moiety", moietyName: "amoxicillin", reason: "plain INN (rule 5)" },
      { sctid: SCT.sodiumChloride, decision: "moiety", moietyName: "sodium chloride", reason: "inorganic salt (rule 3)" },
      { sctid: SCT.eggPhospholipid, decision: "unmappable", reason: "emulsifier, not an active (rule 6)" },
    ]);

    expect(report).toMatchObject({
      resolution: RESOLUTION, mapped: 3, ruledUnmappable: 1, createdMoieties: 1, ownEntries: 1,
      redirected: [], agreedWithDraft: 1, disagreedWithDraft: 0, noDraft: 2,
      alreadyDecided: [], refused: [], pendingAfter: 0,
      projection: { rowsMoved: 1, medicinesMoved: 1, medicinesBlocked: 0 },
    });
    const decided = await Promise.all([amox, trihydrate, nacl, egg].map((s) => row(s.id)));
    expect(decided.map((d) => [d.mappingStatus, d.mappedBy, d.adoptedUnder])).toEqual([
      ["mapped", OWNER.id, RESOLUTION], ["mapped", OWNER.id, RESOLUTION],
      ["mapped", OWNER.id, RESOLUTION], ["unmappable", OWNER.id, RESOLUTION],
    ]);
    expect(await Promise.all(decided.map((d) => saltName(d.saltId))))
      .toEqual(["Amoxicillin", "Amoxicillin", "sodium chloride", null]);
    // The product moved to the moiety, and nothing is left unreviewed.
    const moved = await db.execute<{ salt_id: string }>(sql`select salt_id from formulary_medicine_salts where medicine_id = ${mox}`);
    expect(moved.rows.map((r) => r.salt_id)).toEqual([amox.image]);
    expect((await catalogueCensus(db)).unreviewedActiveMedicines).toBe(0);

    const mapped = await payloads("substance.mapped");
    expect(mapped.map((p) => p.adoptedUnder)).toEqual([RESOLUTION, RESOLUTION, RESOLUTION]);
    expect(mapped.find((p) => p.substanceId === trihydrate.id)).toMatchObject({ agreedWithProposal: true });
    expect((await payloads("substance.ruled_unmappable")).map((p) => [p.adoptedUnder, p.reason]))
      .toEqual([[RESOLUTION, "emulsifier, not an active (rule 6)"]]);
    // The worklist shows the mark on a decided row.
    const page = await pageMappingWorklist(db, { status: "mapped" });
    expect(page.items.map((i) => i.adoptedUnder)).toEqual([RESOLUTION, RESOLUTION, RESOLUTION]);
  });

  it("never overrides a decision someone already made, and says so", async () => {
    const { saltId: warfarin } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "warfarin" }));
    const sodium = await releaseSubstance(SCT.warfarinSodium, "Warfarin sodium", null);
    await withTx(db, (tx) => attestSubstance(tx, PHARMACIST, sodium.id, { saltId: warfarin }));

    const report = await adopt([
      { sctid: SCT.warfarinSodium, decision: "moiety", moietyName: "warfarin sodium", reason: "wrong on purpose" },
    ]);

    expect([report.mapped, report.alreadyDecided]).toEqual([0, [SCT.warfarinSodium]]);
    const kept = await row(sodium.id);
    expect([kept.saltId, kept.mappedBy, kept.adoptedUnder]).toEqual([warfarin, PHARMACIST.id, null]);
  });

  it("uses the moiety of a decided substance whose entry the draft named, and records the draft as disagreeing", async () => {
    const tartrate = await releaseSubstance(SCT.metoprololTartrate, "Metoprolol tartrate", "Metoprolol tartrate");
    const succinate = await releaseSubstance(SCT.metoprololSuccinate, "Metoprolol succinate", null);
    await withTx(db, (tx) => attestSubstance(tx, PHARMACIST, tartrate.id, { newMoiety: { name: "metoprolol" } }));
    // The release's garbled statement: "metoprolol tartrate (as metoprolol succinate)".
    await withTx(db, (tx) => writeProposals(tx, "drafter:release@1", [
      { sctid: SCT.metoprololSuccinate, moietyName: "Metoprolol tartrate", basis: "release_boss", evidence: { support: 1 } },
    ]));

    const report = await adopt([
      { sctid: SCT.metoprololSuccinate, decision: "moiety", moietyName: "Metoprolol tartrate", reason: "as drafted" },
    ]);

    expect(report.redirected).toEqual([{ sctid: SCT.metoprololSuccinate, named: "Metoprolol tartrate", used: "metoprolol" }]);
    expect(await saltName((await row(succinate.id)).saltId)).toBe("metoprolol");
    expect([report.agreedWithDraft, report.disagreedWithDraft]).toEqual([0, 1]);
  });

  it("refuses an item naming the entry of a substance nobody has decided and this adoption does not decide", async () => {
    await releaseSubstance(SCT.amoxicillin, "Amoxicillin", "Amoxicillin");
    const trihydrate = await releaseSubstance(SCT.amoxTrihydrate, "Amoxicillin trihydrate", null);

    const report = await adopt([
      { sctid: SCT.amoxTrihydrate, decision: "moiety", moietyName: "amoxicillin", reason: "trihydrate (rule 1)" },
    ]);

    expect(report.refused).toEqual([{
      sctid: SCT.amoxTrihydrate, moietyName: "amoxicillin",
      why: `"Amoxicillin" is the release entry of substance ${SCT.amoxicillin}, which is pending and not in this adoption`,
    }]);
    expect([report.mapped, report.pendingAfter]).toEqual([0, 2]);
    expect((await row(trihydrate.id)).mappingStatus).toBe("pending");
  });

  it("creates a new moiety once when two salts name it on a release-only database", async () => {
    const tartrate = await releaseSubstance(SCT.metoprololTartrate, "Metoprolol tartrate", null);
    const succinate = await releaseSubstance(SCT.metoprololSuccinate, "Metoprolol succinate", null);

    const report = await adopt([
      { sctid: SCT.metoprololTartrate, decision: "moiety", moietyName: "metoprolol", reason: "tartrate salt (rule 1)" },
      { sctid: SCT.metoprololSuccinate, decision: "moiety", moietyName: "Metoprolol", reason: "succinate salt (rule 1)" },
    ]);

    expect([report.mapped, report.createdMoieties]).toEqual([2, 1]);
    const [a, b] = await Promise.all([row(tartrate.id), row(succinate.id)]);
    expect(a.saltId).toBe(b.saltId);
  });

  it("a pharmacist's correction makes the decision theirs, and clears the mark", async () => {
    const nacl = await releaseSubstance(SCT.sodiumChloride, "NaCl - Sodium chloride", null);
    await adopt([{ sctid: SCT.sodiumChloride, decision: "moiety", moietyName: "sodium chlorid", reason: "typo on purpose" }]);

    await withTx(db, (tx) => attestSubstance(tx, PHARMACIST, nacl.id, { newMoiety: { name: "sodium chloride" } }, {
      correctionReason: "spelling",
    }));

    const corrected = await row(nacl.id);
    expect([corrected.mappedBy, corrected.adoptedUnder, await saltName(corrected.saltId)])
      .toEqual([PHARMACIST.id, null, "sodium chloride"]);
    expect((await payloads("substance.mapped")).map((p) => p.adoptedUnder)).toEqual([RESOLUTION, null]);
  });

  describe("what is refused before anything is written", () => {
    it("a machine does not adopt", async () => {
      await releaseSubstance(SCT.sodiumChloride, "NaCl - Sodium chloride", null);
      await expect(adopt(
        [{ sctid: SCT.sodiumChloride, decision: "moiety", moietyName: "sodium chloride", reason: "r" }],
        { type: "agent", id: "claude-opus-5" },
      )).rejects.toMatchObject({ code: "attester_not_user" });
    });

    it("an adoption names its resolution, each substance once, and a reason", async () => {
      await releaseSubstance(SCT.sodiumChloride, "NaCl - Sodium chloride", null);
      const item: AdoptionItem = { sctid: SCT.sodiumChloride, decision: "moiety", moietyName: "sodium chloride", reason: "r" };
      await expect(adopt([item], OWNER, "  ")).rejects.toMatchObject({ code: "invalid_adoption" });
      await expect(adopt([item, item])).rejects.toMatchObject({ code: "invalid_adoption" });
      await expect(adopt([{ ...item, reason: " " }])).rejects.toMatchObject({ code: "invalid_adoption" });
      await expect(adopt([{ ...item, moietyName: " " }])).rejects.toMatchObject({ code: "invalid_adoption" });
    });

    it("the database refuses a mark on a substance nobody has decided", async () => {
      const nacl = await releaseSubstance(SCT.sodiumChloride, "NaCl - Sodium chloride", null);
      await expect(db.execute(sql`update formulary_substances set adopted_under = ${RESOLUTION} where id = ${nacl.id}`))
        .rejects.toThrow(/formulary_substances_adopted_decided_ck/);
    });

    it("a file naming a substance this release does not hold writes nothing at all", async () => {
      const nacl = await releaseSubstance(SCT.sodiumChloride, "NaCl - Sodium chloride", null);
      await expect(adopt([
        { sctid: SCT.sodiumChloride, decision: "moiety", moietyName: "sodium chloride", reason: "r" },
        { sctid: "999999999", decision: "moiety", moietyName: "nothing", reason: "r" },
      ])).rejects.toMatchObject({ code: "unknown_substance" });
      expect((await row(nacl.id)).mappingStatus).toBe("pending");
    });
  });
});
