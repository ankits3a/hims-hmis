import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { counterparties, holderBookImports } from "../../kernel/db/schema";
import {
  MEMBER_BENEFITS_ARMED_WITHOUT_BOOK, warnIfBenefitsArmedWithoutBook,
} from "./boot-check";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE ONE STATE NOTHING COULD SEE: benefits armed over an empty holder book ═══
 *
 * `boot-check.ts` carries the reasoning for why this is at boot rather than in the readiness census
 * or in the importer. What this suite pins is the property that makes it worth having at all:
 * **it is silent on every path except the failure.** A boot advisory that printed on a healthy
 * hospital would be ignored within a week, and one that printed on a partnerless hospital would be
 * ignored on day one — membership is optional and off by default.
 */
describe("membership boot check — benefits armed with no holder book", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const said: string[] = [];
  const log = { warn: (m: string) => { said.push(m); } };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); said.length = 0; });

  const anImport = async (): Promise<void> => {
    const counterpartyId = newId();
    await db.insert(counterparties).values({
      id: counterpartyId, code: "ACME", name: "Acme Steel", payeeClass: "channel_partner",
      createdBy: "t",
    });
    await db.insert(holderBookImports).values({
      id: newId(), counterpartyId, fileName: "acme-2026.csv", fileHash: "h1",
      columnMapVersion: "v1", rowsTotal: 10, rowsAccepted: 10, rowsQuarantined: 0,
      importedBy: "t", finishedAt: new Date(),
    });
  };

  /**
   * THE KILL. This is the only combination that is wrong, and before this check nothing anywhere
   * reported it: every member presents a card and is billed at full price.
   */
  it("warns when the flag is ON and no book has ever been imported", async () => {
    expect(await warnIfBenefitsArmedWithoutBook(db, true, log)).toBe(true);

    expect(said).toEqual([MEMBER_BENEFITS_ARMED_WITHOUT_BOOK]);
    /** The message must name the way out, both of them — a warning with no fix is a riddle (D9). */
    expect(said[0]).toContain("import-holder-book");
    expect(said[0]).toContain("MEMBER_BENEFITS_ENABLED=false");
  });

  /**
   * ═══ THE HALF THAT KEEPS IT CREDIBLE — silent in every hospital that has no partners ═══
   *
   * `MEMBER_BENEFITS_ENABLED` defaults to `false`, so this is the state MOST deployments are in
   * permanently. A warning here would be the "permanent red that trains its reader to ignore reds"
   * one module over, and it is the reason this is not a readiness-census row.
   */
  it("is silent when the flag is OFF, even with no book at all", async () => {
    expect(await warnIfBenefitsArmedWithoutBook(db, false, log)).toBe(false);
    expect(said).toEqual([]);
  });

  /** And silent once a book exists — the correctly commissioned hospital hears nothing. */
  it("is silent when the flag is ON and a book has been imported", async () => {
    await anImport();

    expect(await warnIfBenefitsArmedWithoutBook(db, true, log)).toBe(false);
    expect(said).toEqual([]);
  });

  /**
   * IT ASKS WHETHER AN IMPORT EVER HAPPENED, NOT WHETHER MEMBERS EXIST. A book whose every line
   * quarantined still ran, and the operator needs the quarantine report rather than this warning —
   * telling them "no book has ever been imported" when one was would send them to the wrong page.
   */
  it("counts an import that accepted rows and one that accepted none alike", async () => {
    const counterpartyId = newId();
    await db.insert(counterparties).values({
      id: counterpartyId, code: "ACME2", name: "Acme Steel", payeeClass: "channel_partner",
      createdBy: "t",
    });
    await db.insert(holderBookImports).values({
      id: newId(), counterpartyId, fileName: "all-bad.csv", fileHash: "h2",
      columnMapVersion: "v1", rowsTotal: 10, rowsAccepted: 0, rowsQuarantined: 10,
      importedBy: "t", finishedAt: new Date(),
    });

    expect(await warnIfBenefitsArmedWithoutBook(db, true, log)).toBe(false);
    expect(said).toEqual([]);
  });
});
