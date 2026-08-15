import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { regulatedPrices } from "../../kernel/db/schema";
import {
  appendRegulatedPrice, createService, listRegulatedPrices, listServices, resolveRegulatedPrices, updateService,
} from "./services";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const actor: Actor = { type: "user", id: "u1" };

describe("service master + regulated prices", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => truncateAll(db));

  test("createService + listServices round-trip (regulated flag persisted)", async () => {
    const { serviceId } = await withTx(db, (tx) =>
      createService(tx, actor, { code: "SVC-1", name: "Consultation", category: "consultation", regulated: true }),
    );
    const rows = await listServices(db);
    const row = rows.find((r) => r.id === serviceId);
    expect(row).toBeDefined();
    expect(row?.code).toBe("SVC-1");
    expect(row?.name).toBe("Consultation");
    expect(row?.regulated).toBe(true);
  });

  test("duplicate service code is rejected", async () => {
    await withTx(db, (tx) => createService(tx, actor, { code: "SVC-1", name: "Consultation", category: "consultation" }));
    await expect(
      withTx(db, (tx) => createService(tx, actor, { code: "SVC-1", name: "Other", category: "pharmacy" })),
    ).rejects.toMatchObject({ code: "duplicate_service_code" });
  });

  test("updateService patch changes name/active and bumps updatedBy", async () => {
    const { serviceId } = await withTx(db, (tx) =>
      createService(tx, actor, { code: "SVC-2", name: "Old Name", category: "procedure" }),
    );
    const editor: Actor = { type: "user", id: "u2" };
    await withTx(db, (tx) => updateService(tx, editor, serviceId, { name: "New Name", active: false }));
    const rows = await listServices(db);
    const row = rows.find((r) => r.id === serviceId);
    expect(row?.name).toBe("New Name");
    expect(row?.active).toBe(false);
    expect(row?.updatedBy).toBe("u2");
  });

  test("appendRegulatedPrice rejects missing bounds and invalid paise", async () => {
    const { serviceId } = await withTx(db, (tx) =>
      createService(tx, actor, { code: "SVC-3", name: "Drug", category: "pharmacy", regulated: true }),
    );
    await expect(
      withTx(db, (tx) => appendRegulatedPrice(tx, actor, { serviceId, effectiveFrom: new Date("2026-01-01T00:00:00Z") })),
    ).rejects.toMatchObject({ code: "regulated_bounds_missing" });
    await expect(
      withTx(db, (tx) =>
        appendRegulatedPrice(tx, actor, { serviceId, mrpPaise: -1, effectiveFrom: new Date("2026-01-01T00:00:00Z") }),
      ),
    ).rejects.toMatchObject({ code: "invalid_paise" });
    await expect(
      withTx(db, (tx) =>
        appendRegulatedPrice(tx, actor, { serviceId, mrpPaise: 1.5, effectiveFrom: new Date("2026-01-01T00:00:00Z") }),
      ),
    ).rejects.toMatchObject({ code: "invalid_paise" });
  });

  test("resolveRegulatedPrices picks the latest row effective at-or-before the query date (boundary included)", async () => {
    const { serviceId } = await withTx(db, (tx) =>
      createService(tx, actor, { code: "SVC-4", name: "Drug B", category: "pharmacy", regulated: true }),
    );
    await withTx(db, (tx) =>
      appendRegulatedPrice(tx, actor, { serviceId, mrpPaise: 10000, effectiveFrom: new Date("2026-01-01T00:00:00Z") }),
    );
    await withTx(db, (tx) =>
      appendRegulatedPrice(tx, actor, { serviceId, mrpPaise: 9000, effectiveFrom: new Date("2026-03-01T00:00:00Z") }),
    );

    const beforeAny = await resolveRegulatedPrices(db, new Date("2025-12-31T00:00:00Z"));
    expect(beforeAny[serviceId]).toBeUndefined();

    const midway = await resolveRegulatedPrices(db, new Date("2026-02-01T00:00:00Z"));
    expect(midway[serviceId]?.mrpPaise).toBe(10000);

    const onBoundary = await resolveRegulatedPrices(db, new Date("2026-03-01T00:00:00Z"));
    expect(onBoundary[serviceId]?.mrpPaise).toBe(9000);
  });

  test("resolveRegulatedPrices returns only services with an effective regulated_prices row", async () => {
    const { serviceId: regulatedId } = await withTx(db, (tx) =>
      createService(tx, actor, { code: "SVC-5", name: "Drug C", category: "pharmacy", regulated: true }),
    );
    await withTx(db, (tx) =>
      createService(tx, actor, { code: "SVC-6", name: "Consult", category: "consultation", regulated: false }),
    );
    await withTx(db, (tx) =>
      appendRegulatedPrice(tx, actor, { serviceId: regulatedId, ceilingPaise: 5000, effectiveFrom: new Date("2026-01-01T00:00:00Z") }),
    );

    const map = await resolveRegulatedPrices(db, new Date("2026-06-01T00:00:00Z"));
    expect(Object.keys(map)).toEqual([regulatedId]);
  });

  test("a same-date gazette CORRECTION wins: resolution is last-inserted, never heap order", async () => {
    const { serviceId } = await withTx(db, (tx) =>
      createService(tx, actor, { code: "SVC-7", name: "Drug D", category: "pharmacy", regulated: true }),
    );
    const gazetteDate = new Date("2026-04-01T00:00:00Z");
    await withTx(db, (tx) =>
      appendRegulatedPrice(tx, actor, { serviceId, mrpPaise: 10000, ceilingPaise: 8000, effectiveFrom: gazetteDate, gazetteRef: "GZ-1" }),
    );
    // The correction path C2 is about: same gazette date, corrected ceiling, appended as a new row
    // (the table is append-only by design — an UPDATE is forbidden by the change-control trail).
    await withTx(db, (tx) =>
      appendRegulatedPrice(tx, actor, { serviceId, mrpPaise: 10000, ceilingPaise: 6000, effectiveFrom: gazetteDate, gazetteRef: "GZ-1-corr" }),
    );
    const map = await resolveRegulatedPrices(db, new Date("2026-05-01T00:00:00Z"));
    expect(map[serviceId]).toEqual({ mrpPaise: 10000, ceilingPaise: 6000 });
  });

  test("listRegulatedPrices: one service's full history, newest first, same-date correction before its original", async () => {
    const { serviceId: a } = await withTx(db, (tx) =>
      createService(tx, actor, { code: "SVC-8", name: "Drug E", category: "pharmacy", regulated: true }),
    );
    const { serviceId: b } = await withTx(db, (tx) =>
      createService(tx, actor, { code: "SVC-9", name: "Drug F", category: "pharmacy", regulated: true }),
    );
    const r1 = await withTx(db, (tx) =>
      appendRegulatedPrice(tx, actor, { serviceId: a, mrpPaise: 10000, effectiveFrom: new Date("2026-01-01T00:00:00Z") }),
    );
    const r2 = await withTx(db, (tx) =>
      appendRegulatedPrice(tx, actor, { serviceId: a, mrpPaise: 9000, effectiveFrom: new Date("2026-04-01T00:00:00Z") }),
    );
    const r3 = await withTx(db, (tx) =>
      appendRegulatedPrice(tx, actor, { serviceId: a, mrpPaise: 8500, effectiveFrom: new Date("2026-04-01T00:00:00Z") }),
    );
    await withTx(db, (tx) =>
      appendRegulatedPrice(tx, actor, { serviceId: b, mrpPaise: 7000, effectiveFrom: new Date("2026-01-01T00:00:00Z") }),
    );
    // Heap agitation (audit B2): an UPDATE relocates r2's live tuple to the end of the heap, so
    // physical order ≠ insertion order and "fresh-table heap luck" cannot save an implementation
    // that dropped the tie-break.
    await db.update(regulatedPrices).set({ gazetteRef: "agitated" }).where(eq(regulatedPrices.id, r2.id));
    const history = await listRegulatedPrices(db, a);
    // Scoped to one service; newest gazette date first; within the same date, last-inserted first.
    expect(history.map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);
  });

  test("bulk same-date corrigenda: the correction wins for EVERY service, even when minted in the same millisecond", async () => {
    // The A1 reproduction as a test: gazette row then same-date corrigendum, back to back inside
    // ONE transaction — the bulk-import shape (audit A1: 6/200 resolved to the superseded row).
    const N = 60;
    const gazetteDate = new Date("2026-06-01T00:00:00Z");
    const serviceIds = await withTx(db, async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < N; i++) {
        const { serviceId } = await createService(tx, actor, {
          code: `BULK-${i}`, name: `Bulk drug ${i}`, category: "pharmacy", regulated: true,
        });
        ids.push(serviceId);
      }
      for (const serviceId of ids) {
        await appendRegulatedPrice(tx, actor, { serviceId, ceilingPaise: 99900, effectiveFrom: gazetteDate, gazetteRef: "GZ-BULK" });
        await appendRegulatedPrice(tx, actor, { serviceId, ceilingPaise: 45000, effectiveFrom: gazetteDate, gazetteRef: "GZ-BULK-corr" });
      }
      return ids;
    });

    const map = await resolveRegulatedPrices(db, new Date("2026-07-01T00:00:00Z"));
    for (const serviceId of serviceIds) {
      expect(map[serviceId]).toEqual({ mrpPaise: null, ceilingPaise: 45000 });
    }
    // Structural pin: inside one transaction, seq allocation order IS insertion order.
    const history = await listRegulatedPrices(db, serviceIds[0]!);
    expect(history).toHaveLength(2);
    expect(history[0]!.ceilingPaise).toBe(45000);
    expect(history[0]!.seq).toBeGreaterThan(history[1]!.seq);
  });
});
