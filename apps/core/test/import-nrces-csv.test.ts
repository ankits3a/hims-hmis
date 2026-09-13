import { parseCsv } from "../scripts/import-nrces-formulary";

/**
 * DEFECT #5 OF THE SPREADSHEET-LOADER DESIGN NOTE, PINNED.
 *
 * `import-item-master` parses CSV with `split(",")`. The design note's new rule 8 says why that is
 * not the shape to copy, and this file is the executable half of that sentence.
 *
 * ═══ WHY EVERY CASE HERE IS WRITTEN AGAINST `split(",")` AND NOT AGAINST A PARSER ═══
 *
 * The failure this guards is not "the parser throws". It is that the naive parser **returns a
 * well-formed row with the wrong cells in it** — same arity as far as anyone looks, no exception,
 * no empty result — so a `dose_form` column quietly receives half a drug name. A test that only
 * asserted "parseCsv returns 9 fields" would pass against `split(",")` on every row that happens to
 * contain no quoted comma, which is 79% of the real file.
 *
 * So each case below is chosen to DISCRIMINATE: the naive split and the real parser disagree about
 * it. `naiveSplit` is included and asserted against on purpose, because a guard that cannot state
 * what it is guarding against tends to drift into agreeing with the defect.
 */

/** What `import-item-master` does, reproduced here so the tests can prove it is different. */
function naiveSplit(line: string): string[] {
  return line.split(",").map((c) => c.trim());
}

describe("parseCsv — RFC4180, and the four things split(\",\") gets wrong", () => {
  it("keeps a quoted comma inside one field, where the naive split shatters the row", () => {
    // The real shape, from generics.csv: 2,116 of 10,303 rows look like this.
    const line =
      '2430351000189102,"Product containing precisely amikacin (as amikacin sulfate), 100 mg",Solution for injection,Intravenous route';
    const parsed = parseCsv(line);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual([
      "2430351000189102",
      "Product containing precisely amikacin (as amikacin sulfate), 100 mg",
      "Solution for injection",
      "Intravenous route",
    ]);

    // The defect, stated rather than implied: same input, one extra column, and the value that
    // lands in `dose_form` is a fragment of the drug name. Nothing throws.
    const naive = naiveSplit(line);
    expect(naive).toHaveLength(5);
    expect(naive[2]).toBe('100 mg"');
  });

  it('reads "" as one escaped quote rather than as a field boundary', () => {
    const parsed = parseCsv('1,"a ""quoted"" name",z');
    expect(parsed[0]).toEqual(["1", 'a "quoted" name', "z"]);
  });

  it("keeps an embedded newline inside a quoted field instead of starting a row", () => {
    const parsed = parseCsv('1,"line one\nline two",z\n2,plain,y');
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(["1", "line one\nline two", "z"]);
    expect(parsed[1]).toEqual(["2", "plain", "y"]);
  });

  it("strips a leading BOM, so the first column name is not silently corrupted", () => {
    // HONEST NOTE ON WHAT THIS CASE DOES AND DOES NOT PROVE. It survived the split(",") mutant,
    // because that mutant also calls `.trim()` and `String.trim()` treats U+FEFF as whitespace.
    // So this does not discriminate against the naive parser; it pins `parseCsv` being correct
    // STANDALONE, for a caller that does not trim. Three of these six cases go red against the
    // mutant (quoted comma, escaped quote, embedded newline) and three do not — recorded here
    // rather than left for a reader to discover that half the file is not load-bearing.
    const parsed = parseCsv("﻿substance_sctid,substance_name\n1,abacavir");
    expect(parsed[0]?.[0]).toBe("substance_sctid");
  });

  it("handles CRLF, and does not invent a trailing empty row for a trailing newline", () => {
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual([["a", "b"], ["c", "d"]]);
    // ...and a file that does NOT end in a newline still yields its last row.
    expect(parseCsv("a,b\r\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("preserves empty fields positionally — a blank is a column, not an absence", () => {
    // substances.csv is mostly blanks: molecular_weight is 0.3% populated. If empties collapsed,
    // every column after the first blank would shift and `active` would read a toxicity string.
    const parsed = parseCsv("14340003,Ipoveratril hydrochloride,,,,,,true,2002-01-31");
    expect(parsed[0]).toHaveLength(9);
    expect(parsed[0]?.[7]).toBe("true");
  });
});
