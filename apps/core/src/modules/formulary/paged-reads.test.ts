import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { CursorError, encodeCursor } from "../../kernel/db/page";
import { addInteraction, addMedicine, addSalt, updateInteraction, updateMedicine, updateSalt } from "./masters";
import { pageInteractions, pageMedicines, pageSalts } from "./reads";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE PAGED READERS ═══
 *
 * `reads.test.ts` pins the id-keyed readers. This pins the paged ones, and it exists because a
 * review of the first version of them found four defects that every other suite was green over:
 *
 *   1. `pageMedicines({ activeOnly: true })` was asserted by NOTHING. The two assertions that used
 *      to pin `listMedicines(db, { activeOnly: true })` were replaced during the refactor by a
 *      `catalogueCensus` count — which is a DIFFERENT SQL statement with its own `where active`. So
 *      the filter that serves `GET /formulary/medicines?active=true` could be deleted or inverted
 *      and the whole suite stayed green. An assertion was not weakened here; it was lost, which is
 *      the quieter version of the same thing.
 *   2. `%` and `_` typed by a pharmacist were live LIKE wildcards.
 *   3. A search ranked purely alphabetically made a real moiety UNREACHABLE.
 *   4. A cursor naming a deleted row answered an empty page, which a client reads as "the end".
 *
 * Fixtures are real Indian pharmacology, per the house rule: a suite green over invented drugs
 * proves the plumbing and nothing else.
 */
const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000001" };

describe("the paged formulary reads", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  const salt = async (name: string, drugClass?: string): Promise<string> =>
    (await withTx(db, (tx) => addSalt(tx, PHARMACIST, drugClass === undefined ? { name } : { name, drugClass }))).saltId;

  const medicine = async (brandName: string, saltId: string, strengthLabel?: string): Promise<string> =>
    (await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName, form: "tablet", routeClass: "systemic",
      strengthLabel: strengthLabel ?? null, salts: [{ saltId }],
    }))).medicineId;

  describe("activeOnly", () => {
    /**
     * THE ASSERTION THE REFACTOR LOST. Deactivating a brand is how a hospital withdraws it, and
     * `GET /formulary/medicines?active=true` is what a curator asks to see the live catalogue. With
     * this case absent, inverting the filter served withdrawn brands to that curator and nothing in
     * the repository objected.
     */
    it("excludes a deactivated medicine, and the unfiltered read still returns it", async () => {
      const para = await salt("paracetamol");
      const crocin = await medicine("Crocin 500", para, "500 mg");
      const withdrawn = await medicine("Disprin Plus", para, "500 mg");
      await withTx(db, (tx) => updateMedicine(tx, PHARMACIST, withdrawn, { active: false }));

      expect((await pageMedicines(db, { activeOnly: true })).items.map((m) => m.id)).toEqual([crocin]);
      expect((await pageMedicines(db, {})).items.map((m) => m.id).sort()).toEqual([crocin, withdrawn].sort());
    });

    it("excludes a deactivated moiety, and the unfiltered read still returns it", async () => {
      const live = await salt("amoxicillin");
      const retired = await salt("rosiglitazone"); // withdrawn in India, 2010
      await withTx(db, (tx) => updateSalt(tx, PHARMACIST, retired, { active: false }));

      expect((await pageSalts(db, { activeOnly: true })).items.map((s) => s.id)).toEqual([live]);
      expect((await pageSalts(db, {})).items.map((s) => s.id).sort()).toEqual([live, retired].sort());
    });

    /** `pageInteractions`' filter is new behaviour and arrived with no test at all. */
    it("excludes a deactivated interaction pair", async () => {
      const warfarin = await salt("warfarin");
      const aspirin = await salt("aspirin");
      const amox = await salt("amoxicillin");
      const live = await withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
        saltAId: warfarin, saltBId: aspirin, severity: "severe", note: "bleeding risk", source: "seed-2026-08",
      }));
      const retired = await withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
        saltAId: warfarin, saltBId: amox, severity: "moderate", note: "INR rise", source: "seed-2026-08",
      }));
      await withTx(db, (tx) => updateInteraction(tx, PHARMACIST, retired.interactionId, { active: false }));

      expect((await pageInteractions(db, { activeOnly: true })).items.map((i) => i.id))
        .toEqual([live.interactionId]);
      expect((await pageInteractions(db, {})).items).toHaveLength(2);
    });
  });

  describe("the moiety search", () => {
    /**
     * `%` IS A CHARACTER A PHARMACIST CAN TYPE. Unescaped it matches everything, and the picker
     * presents the first twenty as though they answered what was typed — so the composition gets
     * chosen off a shortlist that is not the answer to the question.
     */
    it("treats % and _ as literal characters, not as wildcards", async () => {
      await salt("amlodipine");
      await salt("amoxicillin");
      await salt("atorvastatin");

      expect((await pageSalts(db, { q: "%" })).items).toEqual([]);
      expect((await pageSalts(db, { q: "a_l" })).items).toEqual([]);
      // and the escaping did not break ordinary matching
      expect((await pageSalts(db, { q: "aml" })).items.map((s) => s.name)).toEqual(["amlodipine"]);
    });

    /**
     * MEASURED ON THE REAL CATALOGUE: "sodium" matches 180 active moieties and 130 of them sort
     * before the one actually named `Sodium`, so a twenty-row picker ordered alphabetically could
     * never show it — and no substring of "sodium" did any better. A search must be able to find the
     * thing it names.
     */
    it("ranks an exact match first, then a prefix, then a match anywhere", async () => {
      await salt("Calcium sodium edetate");
      await salt("Diclofenac sodium");
      await salt("Sodium");
      await salt("Sodium chloride");

      expect((await pageSalts(db, { q: "sodium" })).items.map((s) => s.name)).toEqual([
        "Sodium",                 // exact
        "Sodium chloride",        // prefix
        "Calcium sodium edetate", // anywhere, alphabetical from here
        "Diclofenac sodium",
      ]);
    });

    /**
     * A ranked order is not a keyset, so paging it would skip and repeat rows silently. Refused
     * rather than served wrongly — the only caller is a typeahead that takes one page.
     */
    it("refuses to page a search rather than paging a ranked order wrongly", async () => {
      const first = await salt("amlodipine");
      await expect(pageSalts(db, { q: "aml", cursor: encodeCursor(first) }))
        .rejects.toBeInstanceOf(CursorError);
    });
  });

  describe("cursors", () => {
    it("walks the whole list in pages without skipping or repeating a row", async () => {
      const para = await salt("paracetamol");
      const names = ["Calpol 500", "Crocin 500", "Dolo 650", "Metacin 500", "Pacimol 500"];
      for (const n of names) await medicine(n, para, "500 mg");

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const page: Awaited<ReturnType<typeof pageMedicines>> = await pageMedicines(db, { limit: 2, cursor });
        seen.push(...page.items.map((m) => m.brandName));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      expect(seen).toEqual(names);          // every row, in order, exactly once
      expect(cursor).toBeNull();            // and it terminated rather than running the guard out
    });

    /**
     * A CURSOR NAMING A DELETED ROW MUST REFUSE. The keyset predicate compares against that row's
     * own values read back in SQL; when the row is gone the comparison is NULL and the page comes
     * back EMPTY — which a client reads as "the end of the list", stopping silently in the middle
     * and reporting the catalogue as shorter than it is.
     */
    it("refuses a cursor whose row is no longer there, rather than answering an empty page", async () => {
      const para = await salt("paracetamol");
      const crocin = await medicine("Crocin 500", para, "500 mg");
      await medicine("Dolo 650", para, "650 mg");

      const page = await pageMedicines(db, { limit: 1 });
      expect(page.nextCursor).not.toBeNull();

      await truncateAll(db);
      await expect(pageMedicines(db, { limit: 1, cursor: page.nextCursor }))
        .rejects.toBeInstanceOf(CursorError);
      expect(crocin).not.toBe("");
    });

    /**
     * The cursor is a ROW ID, not the sort value, and this is what keeps it bounded. The national
     * release carries brand names of 384 and 413 bytes; as sort-value cursors those encoded to 523
     * and 562 characters against a 512-character cap, so the server issued cursors it then refused.
     */
    it("issues a cursor that stays short however long the name it pages past", async () => {
      const para = await salt("paracetamol");
      const long = `Crocin ${"Extra Advance Rapid Relief ".repeat(16)}500`;
      expect(long.length).toBeGreaterThan(400);
      await medicine(long, para, "500 mg");
      await medicine("Zzz Last 500", para, "500 mg");

      const page = await pageMedicines(db, { limit: 1 });
      expect(page.items[0]?.brandName).toBe(long);
      expect(page.nextCursor).not.toBeNull();
      expect((page.nextCursor ?? "").length).toBeLessThan(80);

      // and it is a usable cursor, not merely a short one
      const next = await pageMedicines(db, { limit: 1, cursor: page.nextCursor });
      expect(next.items[0]?.brandName).toBe("Zzz Last 500");
    });
  });
});
