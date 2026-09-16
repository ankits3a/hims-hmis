import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from "@hmis/contracts";
import { CursorError, decodeCursor, encodeCursor, finishPage, pageLimit } from "./page";

/**
 * `page.ts` is pure arithmetic and string handling, so this suite needs no database and no test
 * lock — which matters, because these four laws are the ones every future paged list inherits and
 * a law nobody can afford to run is a law nobody runs.
 *
 * The three sections below are the three ways paging goes wrong in the field, and each one fails
 * SILENTLY in production: an unclamped limit is a client that can ask for the whole table, a
 * cursor that falls back to page one is a client that pages the same three screens for ever, and
 * a `nextCursor` derived from the row count is a client that follows a cursor off the end of a
 * full last page. None of the three raises an error anywhere; only a test sees them.
 */

describe("pageLimit", () => {
  it("defaults when the caller names no limit", () => {
    expect(pageLimit(undefined)).toBe(PAGE_LIMIT_DEFAULT);
  });

  /**
   * CLAMPED, NOT REJECTED — the ruling is written in `@hmis/contracts`'s `pageQuery`: a screen
   * that 400s on a stray query parameter is a screen that stops working for a reason its user
   * cannot see. Asking for the catalogue gets you a page of it.
   */
  it("clamps a greedy limit down to the maximum", () => {
    expect(pageLimit(10_000)).toBe(PAGE_LIMIT_MAX);
    expect(pageLimit(PAGE_LIMIT_MAX + 1)).toBe(PAGE_LIMIT_MAX);
  });

  /**
   * A limit of 0 is the dangerous end: `finishPage` slices to it, so a page of zero items with a
   * cursor pointing at itself is an infinite loop that never advances. The floor is 1.
   */
  it("clamps zero and negatives up to one", () => {
    expect(pageLimit(0)).toBe(1);
    expect(pageLimit(-5)).toBe(1);
  });

  it("truncates a float rather than carrying it into a LIMIT clause", () => {
    expect(pageLimit(10.9)).toBe(10);
    expect(pageLimit(0.9)).toBe(1); // trunc to 0, then the floor lifts it
  });

  it("falls back to the default on a number that is not one", () => {
    expect(pageLimit(Number.NaN)).toBe(PAGE_LIMIT_DEFAULT);
    expect(pageLimit(Number.POSITIVE_INFINITY)).toBe(PAGE_LIMIT_DEFAULT);
  });
});

describe("encodeCursor / decodeCursor", () => {
  it("round-trips an ordinary sort value", () => {
    expect(decodeCursor(encodeCursor("amlodipine"))).toBe("amlodipine");
  });

  /**
   * Both of these are REAL sort values. `pageSalts` sorts on `lower(name)` and `pageMedicines` on
   * `lower(brand_name)`, and an Indian catalogue carries Devanagari salt names and brand names
   * full of the punctuation that base64 and JSON both care about. A cursor that mangles `+` or `/`
   * (plain base64's alphabet) or a quote (JSON's) skips or repeats rows at exactly one page
   * boundary — the hardest kind of bug to see and the easiest kind to pin here.
   */
  it("round-trips a non-ASCII sort value", () => {
    expect(decodeCursor(encodeCursor("पैरासिटामोल"))).toBe("पैरासिटामोल");
  });

  it("round-trips characters that are significant in base64 or in JSON", () => {
    const brand = 'b-complex "forte" 50/500+b12 \\ 100%';
    const encoded = encodeCursor(brand);
    expect(encoded).not.toMatch(/[+/=]/); // base64url, so it is safe in a query string unescaped
    expect(decodeCursor(encoded)).toBe(brand);
  });

  /**
   * THE ONLY INPUTS THAT MAY ANSWER `null`. "No cursor" means "start at the beginning", and it is
   * how every first page is requested. Everything else throws; see the block below for why.
   */
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["the empty string", ""],
  ])("reads %s as 'start at the beginning'", (_label, raw) => {
    expect(decodeCursor(raw)).toBeNull();
  });
});

/**
 * ═══ THE REFUSAL, SIX WAYS ═══
 *
 * The law is in `page.ts`'s header: a malformed cursor means the client and the server disagree
 * about what a cursor is, and answering page one is the friendly-looking response that never
 * terminates — the client believes it advanced, asks for the next page, is handed page two, and
 * pages the same three screens for ever with no error anywhere.
 *
 * Each case asserts `CursorError` BY CLASS, not merely that something threw. The class is the
 * whole mechanism: a controller maps `CursorError` to 400 (the client's cursor is wrong) and
 * anything else to 500 (we are wrong). A `toThrow()` with no class would pass just as happily if
 * the helper started throwing `TypeError` from a null dereference, which is a 500.
 */
describe("decodeCursor refuses a cursor the server did not issue", () => {
  const cases: [string, string][] = [
    // Buffer's base64url decoder is lenient and drops characters outside the alphabet, so this
    // arrives at JSON.parse as the empty string rather than as a decode failure. Same refusal.
    ["not base64 at all", "%%% not a cursor %%%"],
    ["base64 of something that is not JSON", Buffer.from("amlodipine", "utf8").toString("base64url")],
    ["JSON that is not an array", Buffer.from('{"version":"1","value":"a"}', "utf8").toString("base64url")],
    ["an array of the wrong arity", Buffer.from('["1","amlodipine","extra"]', "utf8").toString("base64url")],
    // A cursor is a fact about the paging scheme held by a client that may reload days later. A
    // v0 cursor decoding to a plausible v1 value is the failure the version tag exists to prevent.
    ["a cursor from an older scheme", Buffer.from('["0","amlodipine"]', "utf8").toString("base64url")],
    ["a non-string sort value", Buffer.from('["1",42]', "utf8").toString("base64url")],
  ];

  it.each(cases)("throws CursorError on %s", (_label, raw) => {
    expect(() => decodeCursor(raw)).toThrow(CursorError);
  });

  it("names the version it rejected, so a support call can identify the old client", () => {
    const stale = Buffer.from('["0","amlodipine"]', "utf8").toString("base64url");
    expect(() => decodeCursor(stale)).toThrow(/v0/);
  });
});

describe("finishPage", () => {
  type Row = { name: string };
  const rows = (...names: string[]): Row[] => names.map((name) => ({ name }));
  const nameOf = (row: Row): string => row.name;

  it("returns a short page whole, with no cursor", () => {
    const page = finishPage(rows("amlodipine", "atenolol"), 5, nameOf);

    expect(page.items).toEqual(rows("amlodipine", "atenolol"));
    expect(page.nextCursor).toBeNull();
  });

  it("returns an empty page with no cursor", () => {
    expect(finishPage<Row>([], 5, nameOf)).toEqual({ items: [], nextCursor: null });
  });

  /**
   * ═══ LAW 2. THE MOST IMPORTANT ASSERTION IN THIS FILE. ═══
   *
   * The reader over-fetches by one, so `limit` rows coming back means there was no `limit + 1`th
   * row: this IS the last page, and it merely happens to be exactly full. A reader that derived
   * "there is more" from `items.length === limit` — which is the obvious implementation and the
   * one every author writes first — hands out a cursor here, and the client follows it into an
   * empty page and either blanks the screen or loops.
   *
   * Centralising Law 2 in `finishPage` is what makes that impossible to write twice; this test is
   * what makes it impossible to write once.
   */
  it("returns EXACTLY `limit` rows with no cursor — a full last page is still a last page", () => {
    const page = finishPage(rows("amlodipine", "atenolol", "atorvastatin"), 3, nameOf);

    expect(page.items).toHaveLength(3);
    expect(page.items).toEqual(rows("amlodipine", "atenolol", "atorvastatin"));
    expect(page.nextCursor).toBeNull();
  });

  /**
   * And the mirror: `limit + 1` rows means there IS more. The over-fetched row is dropped, and the
   * cursor must carry the sort value of the LAST RETURNED item — not of the row that was thrown
   * away, which would skip it for ever on the next page.
   */
  it("drops the over-fetched row and cursors from the LAST RETURNED item", () => {
    const page = finishPage(rows("amlodipine", "atenolol", "atorvastatin", "azithromycin"), 3, nameOf);

    expect(page.items).toEqual(rows("amlodipine", "atenolol", "atorvastatin"));
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor)).toBe("atorvastatin"); // not "azithromycin"
  });

  it("cursors correctly at a limit of one, where the two rows are adjacent", () => {
    const page = finishPage(rows("amlodipine", "atenolol"), 1, nameOf);

    expect(page.items).toEqual(rows("amlodipine"));
    expect(decodeCursor(page.nextCursor)).toBe("amlodipine");
  });
});
