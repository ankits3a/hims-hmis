import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import {
  appendRegulatedPrice, createService, listServices, resolveRegulatedPrices, updateService,
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
});
