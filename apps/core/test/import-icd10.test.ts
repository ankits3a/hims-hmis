import { chapterNoOf, generalityOf, parseCatalogue, parseTuple } from "../scripts/import-icd10-catalogue";

/**
 * The ICD-10 loader's pure halves. No database: these are the three functions that decide what the
 * catalogue MEANS, and each of them has a failure mode that leaves a green run behind it.
 */
describe("parseTuple — positional SQLite VALUES", () => {
  it("P1: keeps a comma INSIDE a quoted description instead of splitting on it", () => {
    // The real row. A split(",") parser reads 9 columns here and misaligns every one after the 5th,
    // which is the defect #186 found in import-item-master, in a different file format.
    const t = parseTuple("2, 'A00.0', 'A000', 1, 'Cholera due to Vibrio cholerae 01, biovar cholerae', 'Cholera due to Vibrio cholerae 01, biovar cholerae', 'Chapter 1: Certain infectious and parasitic diseases (A00-B99)'");
    expect(t).toHaveLength(7);
    expect(t[4]).toBe("Cholera due to Vibrio cholerae 01, biovar cholerae");
  });

  it("P2: reads '' as one literal apostrophe and does not end the string there", () => {
    const t = parseTuple("1, 'X00', 'X00', 1, 'Crohn''s disease', 'Crohn''s disease', 'Chapter 11: Diseases of the digestive system (K00-K95)'");
    expect(t[4]).toBe("Crohn's disease");
    expect(t).toHaveLength(7);
  });

  it("P3: an unterminated string throws rather than returning a short row", () => {
    expect(() => parseTuple("1, 'A00")).toThrow(/unterminated/);
  });
});

describe("chapterNoOf", () => {
  it("C1: reads the number out of the chapter label", () => {
    expect(chapterNoOf("Chapter 19: Injury, poisoning and external causes (S00-T88)")).toBe(19);
    expect(chapterNoOf("Chapter 1: Certain infectious and parasitic diseases (A00-B99)")).toBe(1);
  });
  it("C2: refuses a label it cannot read rather than defaulting to a chapter", () => {
    expect(() => chapterNoOf("Infectious diseases")).toThrow(/unparseable/);
  });
});

/**
 * Every expectation below is a code from the real catalogue, and each pair is one that was MEASURED
 * ranking the wrong way round before this function existed.
 */
describe("generalityOf — why an OPD's code floats up", () => {
  it("G1: the residual code outranks a severity-qualified sibling (asthma)", () => {
    // Measured: "Mild intermittent asthma, uncomplicated" ranked above "Unspecified asthma,
    // uncomplicated" because both carry `uncomplicated` and the first has a shorter code.
    expect(generalityOf("J45.909", "Unspecified asthma, uncomplicated"))
      .toBeGreaterThan(generalityOf("J45.20", "Mild intermittent asthma, uncomplicated"));
  });

  it("G2: a three-character billable code is a whole category (I10)", () => {
    expect(generalityOf("I10", "Essential (primary) hypertension")).toBe(3);
  });

  it("G3: the 7th character is an EPISODE, so only the initial encounter keeps its score", () => {
    const init = generalityOf("S02.109A", "Fracture of base of skull, unspecified side, init");
    for (const ext of ["B", "D", "G", "K"]) {
      expect(generalityOf(`S02.109${ext}`, "Fracture of base of skull, unspecified side")).toBeLessThan(init);
    }
  });

  it("G4: a six-character code ending in a letter is NOT an episode extension", () => {
    // The demotion is keyed to length 7 exactly. A shorter code that happens to end in a letter
    // (S02.30XA is 7; S02.3XX is not a real shape) must not be caught by it.
    expect(generalityOf("M54.50", "Low back pain, unspecified")).toBe(generalityOf("M54.5A", "Low back pain, unspecified"));
  });

  it("G5: scores nothing for a plain specific code", () => {
    expect(generalityOf("A01.03", "Typhoid pneumonia")).toBe(0);
  });
});

describe("parseCatalogue", () => {
  const LINES = [
    "PRAGMA journal_mode = WAL;",
    "INSERT INTO icd10_catalog VALUES (1, 'A00', 'A00', 0, 'Cholera', 'Cholera', 'Chapter 1: Certain infectious and parasitic diseases (A00-B99)');",
    "INSERT INTO icd10_catalog VALUES (2, 'A00.0', 'A000', 1, 'Cholera due to Vibrio cholerae 01, biovar cholerae', 'Cholera due to Vibrio cholerae 01, biovar cholerae', 'Chapter 1: Certain infectious and parasitic diseases (A00-B99)');",
    "INSERT INTO medicines_brands (medicine_sctid, medicine_name) VALUES ('x', 'Not an ICD row');",
  ].join("\n");

  it("R1: reads only the icd10_catalog rows, with billable as a boolean", () => {
    const rows = parseCatalogue(LINES);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ code: "A00", billable: false, chapterNo: 1, orderNumber: 1 });
    expect(rows[1]).toMatchObject({ code: "A00.0", rawCode: "A000", billable: true });
  });

  it("R2: a row with the wrong arity ABORTS — positional format has no other structural check", () => {
    const short = "INSERT INTO icd10_catalog VALUES (1, 'A00', 'A00', 0, 'Cholera');";
    expect(() => parseCatalogue(short)).toThrow(/expected 7 columns, got 5/);
  });
});
