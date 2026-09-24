import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { permissionCheckFor, runTool } from "../../kernel/copilot/catalog";
import { pharmacyShortBook } from "../../kernel/db/schema";
import { pharmacyCopilotTools, shortTermOf } from "./copilot-tools";
import { addShortBookEntry } from "./short-book";
import type { Actor } from "@hmis/contracts";
import type { CopilotToolCtx, CopilotToolDecl } from "../../kernel/copilot/types";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PARITY P1 — THE COUNTER AGENT DRAFTS A SHORT-BOOK LINE; A PERSON CONFIRMS IT ═══
 *
 * "Pan 40 khatam" / "out of Pan 40" → a DRAFT the desk shows as a card. The tool writes nothing —
 * the plan's rule is `draft_*`, never `post_*` — and it runs with the asker's permissions, the
 * confirming act's own (`pharmacy.dispense.place`), so a clerk's F2 cannot draft what the clerk
 * could not note.
 */
describe("shortTermOf — the drug an 'out of X' sentence names", () => {
  it.each([
    ["Pan 40 khatam", "pan 40"],
    ["pan 40 khatam ho gaya", "pan 40"],
    ["out of Pan 40", "pan 40"],
    ["Dolo 650 out of stock hai", "dolo 650"],
    ["short book mein Montair LC likh do", "montair lc"],
    ["khatam ho gaya", ""],
  ])("%s → %s", (question: string, term: string) => {
    expect(shortTermOf(question)).toBe(term);
  });
});

describe("draft_short_book_entry (parity P1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); });
  afterEach(() => { fx.unregister(); });

  const tool = (): CopilotToolDecl => pharmacyCopilotTools.find((t) => t.intent === "draft_short_book_entry")!;
  const ask = (question: string, actor: Actor = fx.pharmacist.actor) => {
    const c: CopilotToolCtx = { db, actor, subject: null, serviceDate: "2026-08-17", question };
    return runTool(tool(), c, permissionCheckFor(c));
  };

  it("drafts a drug the counter knows, by its item, and writes nothing", async () => {
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-1", expiryDate: "2028-01-31", qtyBase: 4 });
    const a = await ask("calpol khatam");
    expect(a).toMatchObject({
      key: "copilot.answer.shortBookDraft",
      params: { name: "Calpol 500" },
      payload: { kind: "short_book_draft", itemId: fx.item.calpol, drugName: "Calpol 500", alreadyOpen: false },
    });
    expect(await db.select().from(pharmacyShortBook)).toHaveLength(0);
  });

  it("drafts a drug the hospital has never stocked by the name as said", async () => {
    expect(await ask("out of Pan 40")).toMatchObject({
      key: "copilot.answer.shortBookDraft", params: { name: "Pan 40" },
      payload: { kind: "short_book_draft", itemId: null, drugName: "Pan 40", alreadyOpen: false },
    });
  });

  it("says when the shortage is already in the book, and still writes nothing", async () => {
    await addShortBookEntry(db, fx.pharmacist.actor, { drugName: "Pan 40", source: "desk" }, MON);
    expect(await ask("pan 40 khatam")).toMatchObject({ key: "copilot.answer.shortBookAlready", payload: { alreadyOpen: true } });
    expect(await db.select().from(pharmacyShortBook)).toHaveLength(1);
  });

  it("asks for the name when none was said, and refuses a login without the counter's act", async () => {
    expect(await ask("khatam ho gaya")).toEqual({ key: "copilot.answer.shortBookNeedName", params: {} });
    expect(await ask("pan 40 khatam", fx.clerk.actor)).toEqual({ key: "copilot.answer.notPermitted", params: {} });
  });
});
