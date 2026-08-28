import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { otDefinitions, resources } from "../src/kernel/db/schema";
import {
  DAYCARE_RECOVERY_BAY_CLASS, OT_CONSIGNMENT_STORE_CODE, OT_RECOVERY_BAY_CODES, OT_THEATRE_CODE,
} from "../src/modules/ot/kinds";
import { ensureOtDefinitionDrafts, ensureOtUnit } from "../scripts/seed-ot";
import { parseDefinitionBody } from "../src/modules/ot";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 15 T2 / DD3 — the day-care unit's four registry rows, proved against a real database.
 *
 * This runs on EVERY deploy, so idempotence is the property the deploy path depends on — and it is
 * asserted the way `approval-types.test.ts` asserts its own: by running it TWICE and counting rows,
 * never by the absence of an exception. A second run that created a second theatre would not throw
 * (the unique index would, on the code) and a second run that UPDATED the row it found would
 * silently undo a rename or a `blocked` status the hospital had set — which is `seed-tariff.ts`'s
 * "a deploy must never overwrite a corrected value", applied to a place.
 */
const actor: Actor = { type: "user", id: "test-seed-ot" };

describe("seed:ot — the day-care unit (Plan 15 T2 / DD3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("creates one theatre, two recovery bays and one consignment store — and nothing else", async () => {
    const unit = await ensureOtUnit(db, actor);
    expect(unit.created).toEqual([OT_THEATRE_CODE, ...OT_RECOVERY_BAY_CODES, OT_CONSIGNMENT_STORE_CODE]);
    expect(unit.found).toEqual([]);

    const rows = await db.select().from(resources).orderBy(resources.code);
    expect(rows.map((r) => ({ kind: r.kind, code: r.code, status: r.status })))
      .toEqual([
        // `order by code`: OT-1 < OT-CONSIGN < RB-1 < RB-2.
        { kind: "theatre", code: "OT-1", status: "available" },
        { kind: "store", code: "OT-CONSIGN", status: "available" },
        { kind: "bed", code: "RB-1", status: "available" },
        { kind: "bed", code: "RB-2", status: "available" },
      ]);
  });

  /**
   * F1 — the bays are KERNEL `bed` rows. The brainstorm proposed claiming `bed` on the OT manifest;
   * a second declaration of a kernel kind is `duplicate_kind` at boot. This leg is the data-side
   * half of `kinds.test.ts`'s boot-side one: the rows exist and they are `bed`, with the kernel's
   * `cleaning`-on-release vocabulary rather than a private OT copy of it.
   */
  it("the two bays are KERNEL `bed` rows under the theatre, classed `daycare_recovery` (F1, R-3.9)", async () => {
    const unit = await ensureOtUnit(db, actor);
    const bays = await db.select().from(resources).where(eq(resources.kind, "bed"));
    expect(bays).toHaveLength(2);
    for (const bay of bays) {
      expect({
        code: bay.code, parent: bay.parentId, cls: (bay.attributes as { class?: string } | null)?.class,
      }).toEqual({ code: bay.code, parent: unit.theatreId, cls: DAYCARE_RECOVERY_BAY_CLASS });
    }
    // The consignment bin is a materials `store`, also under the theatre — and NOT a bay.
    const store = (await db.select().from(resources).where(eq(resources.kind, "store")))[0]!;
    expect({ code: store.code, parent: store.parentId }).toEqual({ code: OT_CONSIGNMENT_STORE_CODE, parent: unit.theatreId });
  });

  it("is IDEMPOTENT — a second run finds all four and creates none", async () => {
    const first = await ensureOtUnit(db, actor);
    const second = await ensureOtUnit(db, actor);
    expect(second.created).toEqual([]);
    expect(second.found).toEqual([OT_THEATRE_CODE, ...OT_RECOVERY_BAY_CODES, OT_CONSIGNMENT_STORE_CODE]);
    // The SAME rows, by id — a second run that created new ones under different ids would leave
    // every earlier case pointing at an orphan theatre.
    expect({ theatre: second.theatreId, bays: second.bayIds, store: second.consignmentStoreId })
      .toEqual({ theatre: first.theatreId, bays: first.bayIds, store: first.consignmentStoreId });
    expect(await db.select().from(resources)).toHaveLength(4);
  });

  /**
   * The half that matters more than the count: a deploy must not UNDO an operator's change. A
   * theatre the hospital has renamed, moved or blocked is the hospital's, and `ensureOtUnit` never
   * writes to a row it finds.
   */
  it("does NOT overwrite a theatre the hospital has since renamed or blocked", async () => {
    const first = await ensureOtUnit(db, actor);
    await db.update(resources)
      .set({ name: "Main OT (renamed by the unit)", status: "blocked" })
      .where(eq(resources.id, first.theatreId));

    await ensureOtUnit(db, actor);
    const theatre = (await db.select().from(resources).where(eq(resources.id, first.theatreId)))[0]!;
    expect({ name: theatre.name, status: theatre.status })
      .toEqual({ name: "Main OT (renamed by the unit)", status: "blocked" });
  });

  /** Every creation writes a history row: the registry's audit trail is not optional for a seed. */
  it("writes the registry's creation history for each of the four", async () => {
    await ensureOtUnit(db, actor);
    const history = (await db.execute(sql`
      select count(*)::int as "n" from resource_status_history
    `)).rows as { n: number }[];
    expect(history[0]!.n).toBe(4);
  });
  // ═══════════════════ DD6 — the drafts, and the fact that nothing activates ═══════════════════

  /**
   * DD6: *"a seed that activates a Class-B definition is the theatre the owner named."* This is the
   * mechanical form of that ruling. All three bodies are validated by their own schemas at draft
   * time, so a whitelist that would fail `criteriaBodySchema` cannot reach a deployment at all — and
   * `privileges` is deliberately absent, because a seed cannot know a real surgeon's user id.
   */
  it("drafts the three DD6 bodies, activates NONE of them, and drafts no privilege list", async () => {
    const actor = { type: "user" as const, id: "test-seed-ot" };
    const result = await ensureOtDefinitionDrafts(db, actor);
    expect(result).toEqual({ created: ["criteria", "deposit_policy", "pacu_thresholds"], skipped: [] });

    const rows = await db.select().from(otDefinitions);
    expect(rows.map((r) => ({ kind: r.kind, version: r.version, status: r.status })).sort((a, b) => (a.kind < b.kind ? -1 : 1)))
      .toEqual([
        { kind: "criteria", version: 1, status: "draft" },
        { kind: "deposit_policy", version: 1, status: "draft" },
        { kind: "pacu_thresholds", version: 1, status: "draft" },
      ]);
    // NOTHING is active — the property the whole ruling is about.
    expect(rows.filter((r) => r.status === "active")).toEqual([]);
    expect(rows.filter((r) => r.kind === "privileges")).toEqual([]);
  });

  /**
   * A re-run must not bury a real draft under a pile of identical ones, and must not resurrect a
   * kind whose v1 the MS has already published and superseded.
   */
  it("a second run drafts nothing new, and leaves a published version alone", async () => {
    const actor = { type: "user" as const, id: "test-seed-ot" };
    await ensureOtDefinitionDrafts(db, actor);
    const second = await ensureOtDefinitionDrafts(db, actor);
    expect(second).toEqual({ created: [], skipped: ["criteria", "deposit_policy", "pacu_thresholds"] });
    expect(await db.select().from(otDefinitions)).toHaveLength(3);

    // Simulate the MS having published `criteria` v1, then deploy again.
    await db.update(otDefinitions)
      .set({ status: "active", publishedBy: "ms", publishedAt: new Date() })
      .where(eq(otDefinitions.kind, "criteria"));
    const third = await ensureOtDefinitionDrafts(db, actor);
    expect(third.created).toEqual([]);
    const criteria = (await db.select().from(otDefinitions).where(eq(otDefinitions.kind, "criteria")));
    expect(criteria.map((r) => r.status)).toEqual(["active"]);
  });

  /** The seed bodies pass their OWN schemas — a draft that could not be published is a dead seed. */
  it("every seeded body validates against its kind's schema", async () => {
    const actor = { type: "user" as const, id: "test-seed-ot" };
    await ensureOtDefinitionDrafts(db, actor);
    for (const row of await db.select().from(otDefinitions)) {
      expect(() => parseDefinitionBody(row.kind as "criteria", row.body)).not.toThrow();
    }
    // And the whitelist really is R-3.18's twenty minus the two 15b owns.
    const criteria = parseDefinitionBody("criteria", (await db.select().from(otDefinitions)
      .where(eq(otDefinitions.kind, "criteria")))[0]!.body);
    expect(criteria.entries).toHaveLength(20);
    expect(criteria.entries.map((e) => e.procedureClass)).not.toContain("mtp");
  });
});
