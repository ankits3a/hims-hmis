import type { ProductSpec } from "../formulary";

/**
 * ═══ WHAT EACH REGIMEN LINE IS, AS A COMPOSITION — SO THE FILL CAN CARRY A REAL MEDICINE ═══
 *
 * The owner's bundle names drugs the way a doctor writes them on a slip: "Amoxicillin and
 * Clavulanic Acid 625mg", "Levocetirizine 5mg + Ambroxol 60mg". Those strings resolve to nothing in
 * the formulary (DD2 is exact), so a regimen-filled line reached issue with no `medicineId` and the
 * checks that key on a resolution had nothing to check (production, 2026-09-23).
 *
 * Parsing the label at run time was the alternative and it is wrong in the one place it matters:
 * "625mg" is the SUM of 500 mg amoxicillin and 125 mg clavulanate, and "228.5mg/5ml" is 200 + 28.5.
 * A parser would read one strength where the product has two. So each label is stated here ONCE,
 * by hand, keyed by the bundle's exact text — 41 labels and the single-product substitutes, small
 * enough to read in one sitting. `products.test.ts` pins that every drug label in `knowledge.json`
 * is either here or in `UNSPECIFIED` with a reason, so a new bundle release cannot add a line that
 * silently fills as free text again.
 *
 * Moiety names are the catalogue's (`formulary_salts.name`): `guaifenesin`, not the bundle's
 * `guaiphenesin`. The formulary matches them by name, then alias.
 */
const tab = (form: ProductSpec["form"], ...components: [string, number][]): ProductSpec => ({
  form, components: components.map(([moiety, mg]) => ({ moiety, mg })),
});
const liquid = (perMl: number, ...components: [string, number][]): ProductSpec => ({
  form: "oral_liquid", components: components.map(([moiety, mg]) => ({ moiety, mg, perMl })),
});
const mr = (spec: ProductSpec): ProductSpec => ({ ...spec, modifiedRelease: true });

const SPECS: Readonly<Record<string, ProductSpec>> = {
  // ── SYN_URI_01 ──
  "Paracetamol Tablets 650mg": tab("tablet", ["paracetamol", 650]),
  "Amoxicillin and Clavulanic Acid 625mg": tab("tablet", ["amoxicillin", 500], ["clavulanic acid", 125]),
  "Levocetirizine 5mg + Ambroxol 60mg": tab("tablet", ["levocetirizine", 5], ["ambroxol", 60]),
  "Pantoprazole 40mg": tab("tablet", ["pantoprazole", 40]),
  "Paracetamol Oral Suspension 250mg/5ml": liquid(5, ["paracetamol", 250]),
  "Amoxicillin and Clavulanate Syrup 228.5mg/5ml": liquid(5, ["amoxicillin", 200], ["clavulanic acid", 28.5]),
  // ── SYN_BRONCH_04 ──
  "Ambroxol 30mg + Guaiphenesin 100mg + Terbutaline 2.5mg Syrup":
    liquid(5, ["ambroxol", 30], ["guaifenesin", 100], ["terbutaline", 2.5]),
  "Amoxicillin-Clavulanic Acid 625mg": tab("tablet", ["amoxicillin", 500], ["clavulanic acid", 125]),
  "Paracetamol 500mg": tab("tablet", ["paracetamol", 500]),
  "Amoxicillin-Clavulanate Syrup 228.5mg/5ml": liquid(5, ["amoxicillin", 200], ["clavulanic acid", 28.5]),
  // ── SYN_GERD_03 ──
  "Pantoprazole 40mg + Domperidone 30mg SR": mr(tab("capsule", ["pantoprazole", 40], ["domperidone", 30])),
  "Sucralfate 1000mg/5ml Suspension": liquid(5, ["sucralfate", 1000]),
  "Pantoprazole 20mg Dispersible Tab": tab("dispersible_tablet", ["pantoprazole", 20]),
  // ── SYN_GE_02 ──
  "Ofloxacin 200mg + Ornidazole 500mg": tab("tablet", ["ofloxacin", 200], ["ornidazole", 500]),
  "Racecadotril Capsules 100mg": tab("capsule", ["racecadotril", 100]),
  "Ondansetron 4mg": tab("tablet", ["ondansetron", 4]),
  "Ondansetron Syrup 2mg/5ml": liquid(5, ["ondansetron", 2]),
  // ── SYN_HTN_05 ──
  "Telmisartan 40mg Tablets": tab("tablet", ["telmisartan", 40]),
  "Amlodipine 5mg Tablets": tab("tablet", ["amlodipine", 5]),
  "Amlodipine 2.5mg Tablets": tab("tablet", ["amlodipine", 2.5]),
  // ── SYN_ASTHMA_06 ──
  "Budesonide 200mcg + Formoterol 6mcg Inhaler": tab("inhaler", ["budesonide", 0.2], ["formoterol", 0.006]),
  "Prednisolone 20mg Tablets": tab("tablet", ["prednisolone", 20]),
  "Montelukast 10mg + Levocetirizine 5mg": tab("tablet", ["montelukast", 10], ["levocetirizine", 5]),
  "Montelukast 4mg Chewable Tablets": tab("chewable_tablet", ["montelukast", 4]),
  "Prednisolone Syrup 5mg/5ml": liquid(5, ["prednisolone", 5]),
  // ── SYN_MSK_07 ──
  "Aceclofenac 100mg + Paracetamol 325mg + Thiocolchicoside 4mg":
    tab("tablet", ["aceclofenac", 100], ["paracetamol", 325], ["thiocolchicoside", 4]),
  // ── SYN_UTI_08 ──
  "Nitrofurantoin 100mg SR Tablets": mr(tab("tablet", ["nitrofurantoin", 100])),
  "Cefixime Oral Suspension 100mg/5ml": liquid(5, ["cefixime", 100]),

  // ── substitutes that name ONE product (an allergy swap is exactly where the checks matter most) ──
  "Famotidine 40mg at bedtime": tab("tablet", ["famotidine", 40]),
  "Azithromycin 500mg OD x 3 Days": tab("tablet", ["azithromycin", 500]),
  "Azithromycin Tablets 500mg (1-0-0 AC x 3 Days)": tab("tablet", ["azithromycin", 500]),
  "Azithromycin 100mg/5ml Suspension (7 mL Day 1, then 3.5 mL Days 2-5)": liquid(5, ["azithromycin", 100]),
  "Azithromycin Oral Suspension 100mg/5ml (7 mL Day 1, then 3.5 mL Days 2-5)": liquid(5, ["azithromycin", 100]),
  "Cefixime Oral Suspension 100mg/5ml (4 mL BD x 5 Days)": liquid(5, ["cefixime", 100]),
  "Cefixime 100mg/5ml": liquid(5, ["cefixime", 100]),
  "Ranitidine Syrup 75mg/5ml": liquid(5, ["ranitidine", 75]),
  "Amlodipine 2.5mg": tab("tablet", ["amlodipine", 2.5]),
  "Paracetamol 650mg + Tramadol 37.5mg (1-0-1 PC x 5 Days)": tab("tablet", ["paracetamol", 650], ["tramadol", 37.5]),
};

/**
 * The bundle's drug labels that get NO product, each with the reason. They fill as free text and
 * the screen marks them for the doctor to pick — which is the honest state for every one of them.
 */
export const UNSPECIFIED: Readonly<Record<string, string>> = {
  "Salbutamol + Budesonide Inhaler with Spacer & Mask": "no strength stated",
  "Ambroxol + Terbutaline Pediatric Syrup": "no strength stated",
  "Levocetirizine + Ambroxol Pediatric Syrup": "no strength stated",
  "Magaldrate + Simethicone Oral Suspension": "no strength stated",
  "Antacid Gel Pediatric": "a class, not a composition",
  "Oral Rehydration Salts (ORS)": "a four-salt WHO formula the catalogue splits many ways; pick the product",
  "Oral Rehydration Salts (ORS) Pediatric": "a four-salt WHO formula the catalogue splits many ways; pick the product",
  "Zinc Sulfate Syrup 20mg/5ml": "20 mg is ELEMENTAL zinc, not zinc sulfate — the catalogue's strength would not agree",
  "Racecadotril Sachet 15mg": "the pediatric granule's catalogue form varies (sachet / granules / powder); pick the product",
  "Diclofenac Diethylamine + Methyl Salicylate Gel": "no strength stated",
  "Disodium Hydrogen Citrate Syrup": "no strength stated",
  "Cold Compress / Rest / Ice": "not a drug",
  "Oral Fluids Hydration": "not a drug",
};

export function productSpecFor(drugLabel: string): ProductSpec | null {
  return SPECS[drugLabel] ?? null;
}

/** For the census test only. */
export const SPECIFIED_LABELS: readonly string[] = Object.keys(SPECS);
