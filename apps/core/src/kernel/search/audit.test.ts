import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events, searchAudit } from "../db/schema";
import { parseSearchQuery } from "@hmis/contracts";
import { pruneSearchAudit, recordOpen, recordSearch } from "./audit";
import type { Actor, SearchResponse } from "@hmis/contracts";
import type { Db } from "../db/client";

const desk: Actor = { type: "user", id: "user-1" };
const other: Actor = { type: "user", id: "user-2" };

function response(over: Partial<SearchResponse> = {}): SearchResponse {
  return { groups: [], tookMs: 12, skipped: [], ...over };
}

const hit = (id: string, restricted = false): Record<string, unknown> => ({
  entity: "patient", id, title: `P${id}`,
  ...(restricted ? { restricted: { reason: "out of scope", breakGlass: true } } : {}),
});

describe("search audit", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  const rows = async (): Promise<(typeof searchAudit.$inferSelect)[]> => db.select().from(searchAudit);
  const eventRows = async (): Promise<{ name: string }[]> => db.select({ name: events.name }).from(events);

  it("A ZERO-HIT SEARCH IS RECORDED — a log that only remembers successes cannot show fishing", async () => {
    await recordSearch(db, { actor: desk, query: parseSearchQuery("sharma", 20), response: response() });

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ actorId: "user-1", rawQuery: "sharma", totalHits: 0, source: "text" });
    expect(all[0]?.entityCounts).toEqual({});
  });

  it("records one row per call, with per-entity counts and never the results themselves", async () => {
    await recordSearch(db, {
      actor: desk,
      query: parseSearchQuery("asha", 20),
      response: response({
        groups: [
          { entity: "patient", provider: "patients.patient", hits: [hit("a"), hit("b")] as never, total: 2, timedOut: false, errored: false },
          { entity: "invoice", provider: "billing.invoice", hits: [hit("c")] as never, total: 1, timedOut: false, errored: false },
        ],
      }),
    });

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]?.entityCounts).toEqual({ patient: 2, invoice: 1 });
    expect(all[0]?.totalHits).toBe(3);
    // The COUNTS are the record; the identifiers are not. A log of who-saw-which-row would be a
    // second copy of the data it exists to police.
    expect(JSON.stringify(all[0])).not.toContain('"a"');
  });

  it("AN ORDINARY SEARCH APPENDS NO EVENT; a restricted one appends exactly one", async () => {
    for (let i = 0; i < 5; i += 1) {
      await recordSearch(db, { actor: desk, query: parseSearchQuery(`q${i}`, 20), response: response({
        groups: [{ entity: "patient", provider: "patients.patient", hits: [hit(`x${i}`)] as never, total: 1, timedOut: false, errored: false }],
      }) });
    }
    expect(await eventRows()).toEqual([]);

    await recordSearch(db, { actor: desk, query: parseSearchQuery("vip", 20), response: response({
      groups: [{ entity: "patient", provider: "patients.patient", hits: [hit("y", true)] as never, total: 1, timedOut: false, errored: false }],
    }) });

    const evs = await eventRows();
    expect(evs.map((e) => e.name)).toEqual(["search.restricted_surfaced"]);
    expect((await rows()).filter((r) => r.restrictedSurfaced)).toHaveLength(1);
  });

  it("the query hash normalises case and surrounding space, so repeat searches are countable", async () => {
    await recordSearch(db, { actor: desk, query: parseSearchQuery("  Asha  ", 20), response: response() });
    await recordSearch(db, { actor: desk, query: parseSearchQuery("asha", 20), response: response() });

    const all = await rows();
    expect(all[0]?.queryHash).toBe(all[1]?.queryHash);
    // ...while the RAW text is kept as typed, because an enquiry asks what was typed.
    expect(all.map((r) => r.rawQuery).sort()).toEqual(["  Asha  ", "asha"]);
  });

  describe("the open", () => {
    it("records which record was taken", async () => {
      const { auditId } = await recordSearch(db, { actor: desk, query: parseSearchQuery("asha", 20), response: response() });

      expect(await recordOpen(db, { auditId, actor: desk, entity: "patient", id: "p1" })).toEqual({ recorded: true });

      const all = await rows();
      expect(all[0]).toMatchObject({ openedEntity: "patient", openedId: "p1" });
      expect(all[0]?.openedAt).not.toBeNull();
    });

    it("an actor may only annotate their OWN search", async () => {
      const { auditId } = await recordSearch(db, { actor: desk, query: parseSearchQuery("asha", 20), response: response() });

      expect(await recordOpen(db, { auditId, actor: other, entity: "patient", id: "p1" })).toEqual({ recorded: false });
      expect((await rows())[0]?.openedAt).toBeNull();
    });

    it("is first-write-wins — a re-render must not rewrite which record was taken", async () => {
      const { auditId } = await recordSearch(db, { actor: desk, query: parseSearchQuery("asha", 20), response: response() });
      await recordOpen(db, { auditId, actor: desk, entity: "patient", id: "p1" });

      expect(await recordOpen(db, { auditId, actor: desk, entity: "patient", id: "p2" })).toEqual({ recorded: false });
      expect((await rows())[0]?.openedId).toBe("p1");
    });
  });

  describe("retention", () => {
    const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

    it("deletes past the window and keeps everything inside it", async () => {
      await recordSearch(db, { actor: desk, query: parseSearchQuery("old", 20), response: response(), now: daysAgo(91) });
      await recordSearch(db, { actor: desk, query: parseSearchQuery("fresh", 20), response: response(), now: daysAgo(89) });

      expect(await pruneSearchAudit(db)).toBe(1);
      expect((await rows()).map((r) => r.rawQuery)).toEqual(["fresh"]);
    });

    it("an explicit window overrides the default", async () => {
      await recordSearch(db, { actor: desk, query: parseSearchQuery("x", 20), response: response(), now: daysAgo(10) });
      expect(await pruneSearchAudit(db, { retainDays: 5 })).toBe(1);
      expect(await rows()).toHaveLength(0);
    });
  });
});

describe("retention at volume (independent reviewer, MAJOR 3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("MORE EXPIRED ROWS THAN ONE BATCH ARE ALL REMOVED — a window that only deletes 500 a night is not a window", async () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const rows = Array.from({ length: 120 }, (_, i) => ({
      id: `AUD${String(i).padStart(23, "0")}`,
      actorId: "user-1", rawQuery: `q${i}`, queryHash: "h", entityCounts: {},
      totalHits: 0, tookMs: 1, source: "text", restrictedSurfaced: false, at: old,
    }));
    await db.insert(searchAudit).values(rows);

    // A batch size smaller than the backlog is the whole point: one statement cannot finish.
    let deleted = 0;
    for (let i = 0; i < 10; i += 1) {
      const n = await pruneSearchAudit(db, { retainDays: 90, batchSize: 50 });
      deleted += n;
      if (n < 50) break;
    }

    expect(deleted).toBe(120);
    expect(await db.select().from(searchAudit)).toHaveLength(0);
  });
});
