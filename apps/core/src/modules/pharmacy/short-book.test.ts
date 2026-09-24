import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON, MON2, seedPharmacyBase } from "../../../test/helpers/pharmacy";
import { events, pharmacyShortBook } from "../../kernel/db/schema";
import { addShortBookEntry, listOpenShortBook, resolveShortBookEntry } from "./short-book";
import { PharmacyError } from "./errors";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P1 — THE SHORT BOOK ═══
 *
 * "Out of X", said at the counter (key `N`, a declined line's sheet, or the agent's draft confirmed
 * with one tap), kept with who and when, one open row per drug per store, and resolved once.
 */
describe("the short book (pharmacy P1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); });
  afterEach(() => { fx.unregister(); });

  it("notes a shortage by item, names it from the item, and says who noted it and when", async () => {
    const r = await addShortBookEntry(db, fx.pharmacist.actor, { itemId: fx.item.crocin, drugName: "whatever the screen said", qtyWanted: 30, source: "desk" }, MON);
    expect(r.created).toBe(true);
    expect(r.entry).toMatchObject({ itemId: fx.item.crocin, qtyWanted: 30, source: "desk", notedBy: fx.pharmacist.id, resolvedAt: null });
    expect(r.entry.drugName).not.toBe("whatever the screen said");
    const open = await listOpenShortBook(db);
    expect(open.map((e) => e.id)).toEqual([r.entry.id]);
    expect(open[0]!.notedByName).not.toBeNull();
    const ev = await db.select().from(events).where(eq(events.name, "short_book.noted"));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actorId).toBe(fx.pharmacist.id);
  });

  it("keeps a drug the hospital has never stocked by the name as said", async () => {
    const r = await addShortBookEntry(db, fx.pharmacist.actor, { drugName: "  Pan 40  ", source: "agent" }, MON);
    expect(r.entry).toMatchObject({ itemId: null, drugName: "Pan 40", source: "agent", qtyWanted: null });
  });

  it("does not double an open shortage — the second note is told it is already in the book", async () => {
    const a = await addShortBookEntry(db, fx.pharmacist.actor, { drugName: "Pan 40", source: "desk" }, MON);
    const b = await addShortBookEntry(db, fx.aide.actor, { drugName: "pan 40", source: "agent" }, MON2);
    expect(b.created).toBe(false);
    expect(b.entry.id).toBe(a.entry.id);
    const byItem = await addShortBookEntry(db, fx.pharmacist.actor, { itemId: fx.item.crocin, drugName: "Crocin", source: "desk" }, MON);
    const again = await addShortBookEntry(db, fx.aide.actor, { itemId: fx.item.crocin, drugName: "Crocin", source: "desk" }, MON2);
    expect(again).toMatchObject({ created: false, entry: { id: byItem.entry.id } });
    expect(await db.select().from(pharmacyShortBook)).toHaveLength(2);
  });

  it("resolves once, with how, and a resolved drug may be noted short again", async () => {
    const a = await addShortBookEntry(db, fx.pharmacist.actor, { drugName: "Pan 40", source: "desk" }, MON);
    const done = await resolveShortBookEntry(db, fx.pharmacist.actor, a.entry.id, "ordered", MON2);
    expect(done).toMatchObject({ resolution: "ordered", resolvedBy: fx.pharmacist.id });
    expect(await listOpenShortBook(db)).toEqual([]);
    await expect(resolveShortBookEntry(db, fx.pharmacist.actor, a.entry.id, "dismissed", MON2)).rejects.toMatchObject({ code: "short_book_resolved" });
    await expect(resolveShortBookEntry(db, fx.pharmacist.actor, "01HNOSUCHENTRY000000000000", "dismissed", MON2)).rejects.toMatchObject({ code: "unknown_short_book_entry" });
    const b = await addShortBookEntry(db, fx.pharmacist.actor, { drugName: "Pan 40", source: "desk" }, MON2);
    expect(b.created).toBe(true);
    expect((await db.select().from(events).where(eq(events.name, "short_book.resolved")))).toHaveLength(1);
  });

  it("refuses a name too short to act on, a zero quantity, and an unknown item", async () => {
    await expect(addShortBookEntry(db, fx.pharmacist.actor, { drugName: " x ", source: "desk" }, MON)).rejects.toBeInstanceOf(PharmacyError);
    await expect(addShortBookEntry(db, fx.pharmacist.actor, { drugName: "Pan 40", qtyWanted: 0, source: "desk" }, MON)).rejects.toMatchObject({ code: "invalid_short_book_entry" });
    await expect(addShortBookEntry(db, fx.pharmacist.actor, { itemId: "01HNOSUCHITEM0000000000000", drugName: "Pan 40", source: "desk" }, MON)).rejects.toMatchObject({ code: "unknown_item" });
  });
});
