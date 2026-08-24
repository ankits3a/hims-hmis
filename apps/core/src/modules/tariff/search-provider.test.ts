import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { services } from "../../kernel/db/schema";
import { newId, parseSearchQuery } from "@hmis/contracts";
import { serviceSearchProvider } from "./search-provider";
import type { Actor } from "@hmis/contracts";
import type { SearchProviderResult } from "../../kernel/search/types";
import type { Db } from "../../kernel/db/client";

const actor: Actor = { type: "user", id: "u1" };

describe("tariff service search provider", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function seed(): Promise<void> {
    await db.insert(services).values([
      { id: newId(), code: "CONS-NEW", name: "Consultation New", category: "consultation", createdBy: "t", updatedBy: "t" },
      { id: newId(), code: "XR-CHEST", name: "Chest X-Ray", category: "procedure", regulated: true, createdBy: "t", updatedBy: "t" },
      { id: newId(), code: "OLD", name: "Retired Service", category: "procedure", active: false, createdBy: "t", updatedBy: "t" },
    ]);
  }

  async function run(text: string, limit = 5): Promise<SearchProviderResult> {
    return serviceSearchProvider.run({ db, actor, query: parseSearchQuery(text, limit), limit, signal: new AbortController().signal });
  }

  it("matches on name or code, including a word that is not the first", async () => {
    await seed();
    expect((await run("chest")).hits.map((h) => h.title)).toEqual(["Chest X-Ray"]);
    expect((await run("xray")).hits).toEqual([]); // 'X-Ray' is not 'xray' — T7's trigram is what fixes this
    expect((await run("xr-")).hits.map((h) => h.title)).toEqual(["Chest X-Ray"]);
    expect((await run("consultation")).hits.map((h) => h.title)).toEqual(["Consultation New"]);
  });

  it("NO PRICE is returned — a service's price comes from the active tariff version, not the catalogue", async () => {
    await seed();
    const hit = (await run("chest")).hits[0]!;
    const serialised = JSON.stringify(hit);
    expect(serialised).not.toMatch(/paise|price|amount|₹/i);
    expect(hit.meta).toEqual({ regulated: "yes" });
  });

  it("an inactive service is not a search result", async () => {
    await seed();
    expect((await run("retired")).hits).toEqual([]);
  });

  it("LIKE metacharacters are literal", async () => {
    await seed();
    expect((await run("%")).hits).toEqual([]);
  });
});
