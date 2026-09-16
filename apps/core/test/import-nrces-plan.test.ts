import { COMPOSITION_COLUMNS, GENERIC_COLUMNS, SUBSTANCE_COLUMNS, planImport, renderReport } from "../scripts/import-nrces-formulary";

/**
 * ═══ THE LOADER'S AUTO-LINK, WHICH IS ITS WHOLE SAFETY ARGUMENT AND HAD NO TEST ═══
 *
 * `import-nrces-formulary.ts` decides, for each of the release's 3,283 substances, whether to link
 * it to an existing moiety or leave it `pending` for a pharmacist. Its header calls that
 * distinction "the whole safety argument", and until this file the only thing tested in that script
 * was its CSV parser. `planImport` is pure — three CSV strings in, a plan out — so there was never
 * a cost reason for the gap.
 *
 * ═══ WHAT THESE PIN ═══
 *
 * The loader's stated premise is that matching "Ibuprofen" to the moiety `ibuprofen` "INVENTS
 * NOTHING — it is the same word". That is true of a moiety a PHARMACIST curated. It is not true of
 * a moiety a LOADER wrote: then it is the same word because it is the same ROW, and the link
 * asserts a clinical equivalence nobody made.
 *
 * That is not hypothetical. `import-cds-catalogue.ts` loads the same national release's substances
 * straight into `formulary_salts`, and measured on the loaded catalogue all 3,283 rows carry a
 * `source_ref` — the release, verbatim. Unguarded, this arm would match all 3,283 substances to the
 * rows that ARE those substances and empty the pharmacist's worklist before anyone opened it.
 */
const csv = (columns: string[], rows: Record<string, string>[]): string =>
  [columns.join(","), ...rows.map((r) => columns.map((c) => JSON.stringify(r[c] ?? "")).join(","))].join("\n");

const substancesCsv = (rows: { sctid: string; name: string; synonyms?: string }[]): string =>
  csv(SUBSTANCE_COLUMNS, rows.map((r) => ({
    substance_sctid: r.sctid, substance_name: r.name, synonyms: r.synonyms ?? "", active: "1",
  })));

const NO_GENERICS = csv(GENERIC_COLUMNS, []);
const NO_COMPOSITIONS = csv(COMPOSITION_COLUMNS, []);

const plan = (
  subs: { sctid: string; name: string; synonyms?: string }[],
  salts: { id: string; name: string; sourceRef: string | null }[],
): ReturnType<typeof planImport> =>
  planImport(substancesCsv(subs), NO_GENERICS, NO_COMPOSITIONS, salts, new Set(), new Set(), "nrces-test");

/** Real: ibuprofen is a moiety; 387207008 is its SNOMED concept id. */
const IBUPROFEN_SCTID = "387207008";

describe("the NRCeS loader's auto-link", () => {
  /**
   * THE PIN THAT STOPS THE FIX BEING A BLANKET DISABLE. A moiety a pharmacist curated — no
   * `source_ref` — is still a legitimate match target, and the loader must still link to it. Without
   * this case, deleting the auto-link entirely would pass just as well as guarding it.
   */
  it("links a substance to a CURATED moiety of the same name", () => {
    const p = plan(
      [{ sctid: IBUPROFEN_SCTID, name: "Ibuprofen" }],
      [{ id: "S1", name: "ibuprofen", sourceRef: null }],
    );
    expect(p.substances[0]?.saltId).toBe("S1");
    expect(p.withheldReleaseImage).toBe(0);
  });

  /**
   * THE CASE THIS CHANGE EXISTS FOR. The same name, the same substance — but the moiety row is
   * itself an image of a published release, so "the same word" is "the same row" and linking them
   * records a clinical decision no human made.
   */
  it("withholds a substance whose only same-named moiety is a release image", () => {
    const p = plan(
      [{ sctid: IBUPROFEN_SCTID, name: "Ibuprofen" }],
      [{ id: "S1", name: "ibuprofen", sourceRef: IBUPROFEN_SCTID }],
    );
    expect(p.substances[0]?.saltId).toBeNull();
    expect(p.withheldReleaseImage).toBe(1);
  });

  /**
   * THE SYNONYM ARM IS A SEPARATE LOOP, so a fix aimed at the name arm closes only the name arm.
   * Real: verapamil hydrochloride is sold as Ipoveratril hydrochloride, which the release carries
   * as a synonym.
   */
  it("withholds on the SYNONYM arm too, not only the name arm", () => {
    const p = plan(
      [{ sctid: "372913009", name: "Verapamil hydrochloride", synonyms: "Ipoveratril hydrochloride" }],
      [{ id: "S1", name: "Ipoveratril hydrochloride", sourceRef: "372913009" }],
    );
    expect(p.substances[0]?.saltId).toBeNull();
  });

  it("still links on the synonym arm when the moiety is curated", () => {
    const p = plan(
      [{ sctid: "372913009", name: "Verapamil hydrochloride", synonyms: "Ipoveratril hydrochloride" }],
      [{ id: "S1", name: "Ipoveratril hydrochloride", sourceRef: null }],
    );
    expect(p.substances[0]?.saltId).toBe("S1");
  });

  /**
   * A worklist that stays full must say WHY. An operator who sees 3,283 pending and no explanation
   * concludes the import failed; one who sees the withheld count knows it did exactly what it meant
   * to. This is the difference between a silence and a report.
   */
  it("reports what it withheld, rather than leaving an empty worklist unexplained", () => {
    const p = plan(
      [{ sctid: IBUPROFEN_SCTID, name: "Ibuprofen" }],
      [{ id: "S1", name: "ibuprofen", sourceRef: IBUPROFEN_SCTID }],
    );
    const report = renderReport(p, false);
    expect(report).toContain("withheld");
    expect(report).toMatch(/withheld\s+1\b/);
    expect(report).toContain("release images");
  });

  /** Mixed vocabulary: the guard is per-row, not per-import. */
  it("withholds only the release images, and links the curated ones beside them", () => {
    const p = plan(
      [
        { sctid: IBUPROFEN_SCTID, name: "Ibuprofen" },
        { sctid: "387517004", name: "Paracetamol" },
      ],
      [
        { id: "S1", name: "ibuprofen", sourceRef: IBUPROFEN_SCTID },
        { id: "S2", name: "paracetamol", sourceRef: null },
      ],
    );
    expect(p.substances.map((s) => s.saltId)).toEqual([null, "S2"]);
    expect(p.withheldReleaseImage).toBe(1);
  });
});
