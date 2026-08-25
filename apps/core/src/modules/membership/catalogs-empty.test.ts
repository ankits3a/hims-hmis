import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { PgTable } from "drizzle-orm/pg-core";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  attributionIds, counterparties, couponDefinitions, membershipInstances, membershipPlans,
  partnerAgreements, partnerRefMap,
} from "../../kernel/db/schema";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 09 / DD3 — EVERY CATALOG IS DATA, AND THIS IS THE CHECK THAT KEEPS THE OUT-OF-GIT PARTNER
 * BOOK OUT OF A PUBLIC REPOSITORY.
 *
 * The owner's standing instruction is that no partner name, partner code, plan code, coupon code,
 * rate, price, card number or sample person from the two out-of-git context files may reach a
 * tracked file. The obvious guard — grep the tree for the forbidden values — CANNOT BE WRITTEN,
 * because writing it would require committing the forbidden values, which is precisely the thing
 * being forbidden.
 *
 * So the enforced property is the one that can be stated WITHOUT them, and it is stronger than a
 * grep would be: **a freshly migrated database has empty catalogs, and no seed script fills them.**
 * A hard-coded plan, coupon, partner or agreement cannot survive it whatever it is called, whatever
 * values it carries, and whether or not anybody remembered to add it to a list of forbidden words.
 *
 * THE SIX CATALOG TABLES, and why each is one:
 *   `membership_plans`, `coupon_definitions` — the plan and coupon codes and their terms.
 *   `counterparties`, `partner_agreements`   — the partner codes and the commission rates.
 *   `partner_ref_map`                        — a partner's own reference space.
 *   `membership_instances`                   — the holder book itself: card numbers and people.
 * `covered_members` needs no check of its own: `instance_id` is NOT NULL with a foreign key, so an
 * empty `membership_instances` makes an inhabited `covered_members` impossible. That is an argument
 * from the schema rather than from vigilance, which is why it is written down instead of padded out
 * into a seventh assertion.
 *
 * §2.49 — NEITHER LEG MAY PASS VACUOUSLY, and each has a leg that CAN fail:
 *   - the readers are shown to SEE rows (insert one into each, read them back) before they are
 *     asserted to see none — six readers broken in the same way would otherwise agree with this
 *     test for ever;
 *   - the script scanner is driven against a synthetic seed that DOES write to a catalog and is
 *     asserted to catch it, and it THROWS rather than returning `[]` on a directory that has
 *     stopped looking like `scripts/`.
 */
const SCRIPTS_DIR = resolve(__dirname, "..", "..", "..", "scripts");
/** A directory with no `.ts` files at all — the negative control for the scanner's own staleness check. */
const NOT_A_SCRIPTS_DIR = resolve(__dirname, "..", "..", "..", "drizzle", "meta");

type Catalog = { identifier: string; sqlName: string; table: PgTable };

/** The six, by their drizzle identifier and their SQL name — the scanner needs both spellings. */
const CATALOGS: Catalog[] = [
  { identifier: "membershipPlans", sqlName: "membership_plans", table: membershipPlans },
  { identifier: "couponDefinitions", sqlName: "coupon_definitions", table: couponDefinitions },
  { identifier: "membershipInstances", sqlName: "membership_instances", table: membershipInstances },
  { identifier: "counterparties", sqlName: "counterparties", table: counterparties },
  { identifier: "partnerAgreements", sqlName: "partner_agreements", table: partnerAgreements },
  { identifier: "partnerRefMap", sqlName: "partner_ref_map", table: partnerRefMap },
];

/** Does a source NAME a catalog table, by either spelling? */
function catalogsNamedIn(source: string): string[] {
  return CATALOGS.filter(
    ({ identifier, sqlName }) =>
      new RegExp(`\\b${identifier}\\b`).test(source) || new RegExp(`\\b${sqlName}\\b`).test(source),
  ).map((c) => c.sqlName);
}

/**
 * Every `scripts/*.ts` that so much as NAMES a catalog table.
 *
 * Deliberately an over-approximation: it flags a mention rather than proving an insert. In Phase 1
 * no seed script has any business naming these tables at all, so the false-positive rate is zero
 * and the false-NEGATIVE rate is the one that matters — a scanner that tried to recognise
 * `db.insert(...)` precisely would miss a raw `sql` write, a helper, or a loop over a table map.
 *
 * THROWS on a directory it does not recognise: a scanner that silently reads zero files agrees
 * with this test for ever.
 */
function scriptsNamingCatalogs(dir: string): { script: string; table: string }[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  if (files.length < 5) {
    throw new Error(
      `${dir}: found ${files.length} .ts scripts — this scanner is stale, and a scanner that reads ` +
        `nothing passes this test vacuously`,
    );
  }
  const hits: { script: string; table: string }[] = [];
  for (const file of files) {
    for (const table of catalogsNamedIn(readFileSync(resolve(dir, file), "utf8"))) {
      hits.push({ script: file, table });
    }
  }
  return hits;
}

describe("Plan 09 DD3 — a freshly migrated database has EMPTY catalogs", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("every catalog reader returns [] — no plan, coupon, partner, agreement, mapping or card", async () => {
    for (const { sqlName, table } of CATALOGS) {
      const rows = await db.select().from(table);
      // The table name rides the assertion because the failure a reader wants to see is WHICH
      // catalog was inhabited, not that some catalog was.
      expect({ [sqlName]: rows.length }).toEqual({ [sqlName]: 0 });
    }
  });

  it("…and every one of those readers can SEE a row, so the emptiness above is a measurement", async () => {
    // THE LEG THAT CAN FAIL (§2.49). Every value below is invented HERE (O-9): this test is about
    // a CLASS — "the catalog is inhabited" — and a class does not care which invented name carries
    // it. Nothing is transcribed from anywhere.
    const at = new Date("2026-09-01T00:00:00.000Z");
    await db.insert(counterparties).values({
      id: "01HPARTNER00000000000TEST", code: "TEST-CP-1", name: "Invented Referral House",
      payeeClass: "channel_partner", createdBy: "test",
    });
    await db.insert(partnerAgreements).values({
      id: "01HAGREEMENT000000000TEST", counterpartyId: "01HPARTNER00000000000TEST", versionNo: 1,
      effectiveFrom: at, terms: { note: "invented" }, createdBy: "test",
    });
    await db.insert(attributionIds).values({
      id: "01HATTRIB00000000000TEST1", code: "TEST-ATTR-1",
      counterpartyId: "01HPARTNER00000000000TEST", issuedBy: "test",
    });
    await db.insert(partnerRefMap).values({
      id: "01HREFMAP00000000000TEST1", counterpartyId: "01HPARTNER00000000000TEST",
      partnerRef: "INVENTED-REF-1", attributionId: "01HATTRIB00000000000TEST1", mappedBy: "test",
    });
    await db.insert(membershipPlans).values({
      id: "01HPLAN0000000000000TEST1", code: "TEST-PLAN-1", title: "Invented Plan",
      kind: "membership", counterpartyId: "01HPARTNER00000000000TEST", benefits: {},
      entitlements: {}, validityDays: 365, createdBy: "test",
    });
    await db.insert(couponDefinitions).values({
      id: "01HCOUPON000000000000TEST", code: "TEST-COUPON-1", title: "Invented Coupon",
      benefit: {}, scope: {}, validFrom: at, validTo: at, createdBy: "test",
    });
    await db.insert(membershipInstances).values({
      id: "01HINSTANCE0000000000TEST", planId: "01HPLAN0000000000000TEST1", cardCode: "TEST-CARD-1",
      holderName: "Invented Holder", validFrom: at, validTo: at, origin: "import",
    });

    for (const { sqlName, table } of CATALOGS) {
      const rows = await db.select().from(table);
      expect({ [sqlName]: rows.length }).toEqual({ [sqlName]: 1 });
    }
  });

  it("no seed script under scripts/ writes to any catalog table", () => {
    // The other half of DD3, and the half a fresh-database assertion cannot reach: a catalog is
    // only DATA if nothing in the repository FILLS it either. `seed:membership` (T3) registers an
    // approval TYPE and seeds no catalog; the holder book arrives through `import-holder-book`
    // (T5), an operator command run against a partner drop, deliberately absent from every deploy
    // path (§6.0 S14) — an import is not configuration and a deploy that imported one would be
    // importing data nobody asked it for.
    expect(scriptsNamingCatalogs(SCRIPTS_DIR)).toEqual([]);
  });

  it("…and the scanner CATCHES a seed that does name one, by either spelling", () => {
    // The failing leg for the scanner. Exercised against synthetic sources rather than a written
    // file, which is the discipline `seed-roles.test.ts` applies to its own README parsers.
    expect(
      catalogsNamedIn(
        'import { membershipPlans } from "../src/kernel/db/schema";\n' +
          "await db.insert(membershipPlans).values({ id, code, title });\n",
      ),
    ).toEqual(["membership_plans"]);
    // The raw-SQL spelling is caught too, which is why the scanner carries both names: a seed that
    // wrote through `sql` would otherwise be invisible to it.
    expect(catalogsNamedIn("await db.execute(sql`insert into coupon_definitions values (1)`);"))
      .toEqual(["coupon_definitions"]);
    // …and an ordinary seed that touches no catalog is not flagged, so the check above is not
    // merely "every script is a hit".
    expect(catalogsNamedIn('import { services } from "../src/kernel/db/schema";\n')).toEqual([]);
  });

  it("the scanner THROWS on a directory that is not scripts/, never returns []", () => {
    expect(() => scriptsNamingCatalogs(NOT_A_SCRIPTS_DIR)).toThrow(/this scanner is stale/);
  });
});
