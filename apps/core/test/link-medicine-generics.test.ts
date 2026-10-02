import { brandGenericPairs } from "../scripts/link-medicine-generics";

/** The bundle's own line shape (`cds-bundle.sql`, table `medicines_brands`), with the column order it really has. */
const COLS = "(medicine_sctid, medicine_name, brand_name, brand_sctid, generic_name, generic_sctid, manufacturer_name, manufacturer_sctid)";
const BUNDLE = [
  "CREATE TABLE medicines_brands (medicine_sctid TEXT PRIMARY KEY);",
  `INSERT OR REPLACE INTO medicines_brands ${COLS} VALUES ('2596251000189106', 'Levomil (levofloxacin) 500 mg oral tablet', 'Levomil', '2570931000189103', 'Levofloxacin 500 mg oral tablet', '324634001', 'Indian Drug Distributors Private Limited', '1185421000189101');`,
  `INSERT OR REPLACE INTO medicines_brands ${COLS} VALUES ('111', 'Doctor''s Own, (mixture) 5 mg', 'Doctor''s Own', '222', 'A name, with a comma and a ) in it', '333444', 'Maker', '555');`,
  `INSERT OR REPLACE INTO medicines_brands ${COLS} VALUES ('666', 'No generic named', 'Orphan', '777', NULL, NULL, 'Maker', '555');`,
  `INSERT OR REPLACE INTO medicines_brands ${COLS} VALUES ('888', 'Empty generic', 'Orphan', '777', '', '', 'Maker', '555');`,
  `INSERT OR REPLACE INTO generics (generic_sctid, generic_name) VALUES ('324634001', 'Levofloxacin 500 mg oral tablet');`,
].join("\n");

describe("link-medicine-generics: the bundle's brand → generic pairs", () => {
  it("reads each brand's own id and its generic's id, through quotes and commas in the names, and leaves out a brand with no generic", () => {
    expect(brandGenericPairs(BUNDLE)).toEqual([
      { medicineSctid: "2596251000189106", genericSctid: "324634001" },
      { medicineSctid: "111", genericSctid: "333444" },
    ]);
  });
});
