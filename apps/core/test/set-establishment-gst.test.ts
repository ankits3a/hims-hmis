import { setupTestDb, truncateAll } from "./helpers/db";
import { seedOpdBase } from "./helpers/opd";
import { withTx } from "../src/kernel/db/client";
import { loadOpdConfig } from "../src/modules/opd/config";
import { setLetterheadTaxIdentity } from "../scripts/set-establishment-gst";
import { runCensus } from "../scripts/standup-check";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * 2026-09-17 — the registered person behind the letterhead: the trust's legal name and GSTIN, put
 * on the ONE letterhead by one command, and a census row that is red until it is.
 */
const ADMIN: Actor = { type: "user", id: "01HOPDADMIN000000000000001" };

describe("set-establishment-gst", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
  });

  const row = async (): Promise<string | undefined> =>
    (await runCensus(db, "hospital")).find((r) => r.code === "supplier_gstin_on_invoice")?.verdict;

  it("adds the legal name and GSTIN to the letterhead, keeps its name and address, and turns the census row green", async () => {
    const before = (await loadOpdConfig(db)).letterhead;
    expect(await row()).toBe("RED");
    const result = await withTx(db, (tx) => setLetterheadTaxIdentity(tx, ADMIN, { gstin: " 10aaatl6484h1zp ", legalName: " LEELAWATI DEVI EDUCATIONAL TRUST " }));
    expect(result.before).toEqual(before);
    expect(result.after).toEqual({ ...before, legalName: "LEELAWATI DEVI EDUCATIONAL TRUST", gstin: "10AAATL6484H1ZP" });
    expect((await loadOpdConfig(db)).letterhead).toEqual(result.after);
    expect(await row()).toBe("ok");
  });

  it("refuses a mistyped GSTIN and a blank legal name, and changes nothing", async () => {
    const before = (await loadOpdConfig(db)).letterhead;
    await expect(withTx(db, (tx) => setLetterheadTaxIdentity(tx, ADMIN, { gstin: "10AAATL6484H1ZQ", legalName: "LEELAWATI DEVI EDUCATIONAL TRUST" })))
      .rejects.toThrow(/not a valid GSTIN/);
    await expect(withTx(db, (tx) => setLetterheadTaxIdentity(tx, ADMIN, { gstin: "10AAATL6484H1ZP", legalName: "  " })))
      .rejects.toThrow(/legal name/);
    expect((await loadOpdConfig(db)).letterhead).toEqual(before);
    expect(await row()).toBe("RED");
  });
});
