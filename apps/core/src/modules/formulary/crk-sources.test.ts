import { assertNoIdentifiers } from "../../kernel/copilot/mask";
import { CRK_MAX_SOURCES, chooseOpenFdaLabel, pubchemSourcesOf, fetchCrkSources, lookupNamesFor, plainSubstanceName, usNameOf } from "./crk-sources";
import type { FetchLike } from "./crk-sources";

/** #883 — how a catalogue substance name becomes the name openFDA and PubChem are asked for. No network, no database. */
describe("CRK source fetchers — names and limits", () => {
  it("drops the catalogue's tags and salt words, and maps Indian/INN names to US names", () => {
    expect(plainSubstanceName("Amlodipine besilate (substance)")).toBe("amlodipine");
    expect(plainSubstanceName("Midazolam (as midazolam maleate)")).toBe("midazolam");
    expect(plainSubstanceName("Sodium bicarbonate")).toBe("sodium bicarbonate");
    expect(usNameOf("Paracetamol (substance)")).toBe("acetaminophen");
    expect(usNameOf("Levosalbutamol sulfate (substance)")).toBe("levalbuterol");
    expect(usNameOf("Benflumetol")).toBe("lumefantrine");
    expect(usNameOf("Sodium valproate")).toBe("valproate sodium");
  });

  it("looks a generic up by its linked substances, else by its name before the strength", () => {
    expect(lookupNamesFor("Whatever 5 mg tablet", ["Telmisartan", "Amlodipine besilate (substance)"])).toEqual(["Telmisartan", "Amlodipine besilate (substance)"]);
    expect(lookupNamesFor("Amoxicillin 500 mg and clavulanic acid 125 mg oral tablet", [])).toEqual(["Amoxicillin"]);
    expect(lookupNamesFor("Paracetamol + caffeine tablet", [])).toEqual(["Paracetamol", "caffeine tablet"]);
  });

  it("a salt-named label matches its moiety; a combination never does", () => {
    const label = (generic: string, subs: string[]) => ({ openfda: { generic_name: [generic], substance_name: subs, product_type: ["HUMAN PRESCRIPTION DRUG"] }, indications_and_usage: ["x"] });
    expect(chooseOpenFdaLabel({ results: [label("AMLODIPINE BESYLATE", ["AMLODIPINE BESYLATE"])] }, "Amlodipine besilate (substance)")).not.toBeNull();
    expect(chooseOpenFdaLabel({ results: [label("AMLODIPINE AND TELMISARTAN", ["AMLODIPINE BESYLATE", "TELMISARTAN"])] }, "Amlodipine")).toBeNull();
    expect(chooseOpenFdaLabel({ results: [label("AMLODIPINEX", ["AMLODIPINEX"])] }, "Amlodipine")).toBeNull();
  });

  it("caps a draft's sources, and a fetch that throws is a missing source", async () => {
    const fetch: FetchLike = async (url) => {
      if (url.includes("fail")) throw new Error("network");
      return { ok: true, status: 200, json: async () => ({ results: [{ openfda: { generic_name: [decodeURIComponent(url).match(/"([^"]+)"/)![1]!.toUpperCase()], product_type: ["HUMAN PRESCRIPTION DRUG"] }, indications_and_usage: ["uses"] }] }) };
    };
    const names = Array.from({ length: CRK_MAX_SOURCES + 3 }, (_, i) => `drug${String(i)}`);
    const got = await fetchCrkSources([...names, "fail"], { fetch, retrievedOn: "2026-10-23" });
    expect(got).toHaveLength(CRK_MAX_SOURCES);
    expect(new Set(got.map((s) => s.ref)).size).toBe(CRK_MAX_SOURCES);
  });

  it("a PubChem source's title passes the identifier check whatever the compound id (titles are sent unmasked)", () => {
    const record = { Record: { RecordNumber: 135398513, Section: [{ TOCHeading: "LiverTox Summary", Information: [{ ReferenceNumber: 1, Value: { StringWithMarkup: [{ String: "Rarely linked to liver injury." }] } }] }],
      Reference: [{ ReferenceNumber: 1, SourceName: "LiverTox" }] } };
    const [s] = pubchemSourcesOf(record, "1", "2026-10-23");
    expect(s).toBeDefined();
    expect(() => { assertNoIdentifiers(`--- source ref=${s!.ref} (${s!.kind}: ${s!.title}) ---\n${s!.text}`); }).not.toThrow();
    expect(s!.url).toContain("135398513");
  });
});
