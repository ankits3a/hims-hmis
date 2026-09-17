import type { TherapeuticClassEntry } from "../../src/modules/formulary";

/**
 * ═══ THE CLINICAL MASTER'S DUPLICATE-THERAPY GROUPS, AS MOIETY CLASSES ═══
 *
 * Source: `hmis_clinical_master` (the owner's Drive bundle, 2026-09-17), table
 * `therapeutic_subclass_groups`: five groups, each "max_allowed_agents = 1". Each group's members are
 * completed with every moiety of that class in the national release (names checked against the
 * rehearsal database `hmis_formulary_prodlike`, 2026-09-17). Where the book departs from the source:
 *
 * - `SUB_NSAID` names seven non-selective NSAIDs. The duplication a doctor makes in an Indian OPD is
 *   as often a coxib beside diclofenac, so the selective and preferential COX-2 inhibitors are
 *   members here. Aspirin is not listed: the starter seed already classes it `nsaid` (the allergy
 *   path needs that), and the check does not flag it, because low-dose aspirin is an antiplatelet.
 *   Flupirtine is not an NSAID.
 * - Spellings the release does not hold as moieties (candesartan cilexetil, olmesartan medoxomil,
 *   enalaprilat, ilaprazole) are left out; their moieties are listed by their release names.
 */
export const THERAPEUTIC_CLASS_BOOK_2026_09_17: readonly TherapeuticClassEntry[] = [
  {
    drugClass: "ppi", rule: "therapeutic_subclass_groups#SUB_PPI",
    moieties: ["pantoprazole", "omeprazole", "rabeprazole", "esomeprazole", "lansoprazole", "dexlansoprazole", "dexrabeprazole"],
  },
  {
    drugClass: "ace_inhibitor", rule: "therapeutic_subclass_groups#SUB_ACEI",
    moieties: [
      "ramipril", "enalapril", "lisinopril", "perindopril", "captopril", "fosinopril", "trandolapril", "benazepril",
      "quinapril", "imidapril", "zofenopril", "moexipril", "cilazapril",
    ],
  },
  {
    drugClass: "arb", rule: "therapeutic_subclass_groups#SUB_ARB",
    moieties: [
      "telmisartan", "losartan", "olmesartan", "candesartan", "valsartan", "irbesartan", "azilsartan medoxomil",
      "eprosartan", "fimasartan",
    ],
  },
  {
    drugClass: "statin", rule: "therapeutic_subclass_groups#SUB_STATIN",
    moieties: ["atorvastatin", "rosuvastatin", "simvastatin", "pravastatin", "pitavastatin", "fluvastatin", "lovastatin"],
  },
  {
    drugClass: "nsaid", rule: "therapeutic_subclass_groups#SUB_NSAID",
    moieties: [
      "ibuprofen", "dexibuprofen", "diclofenac", "aceclofenac", "naproxen", "piroxicam", "mefenamic acid", "tolfenamic acid",
      "ketorolac", "tenoxicam", "lornoxicam", "indometacin", "ketoprofen", "dexketoprofen", "flurbiprofen", "fenoprofen",
      "diflunisal", "celecoxib", "etoricoxib", "parecoxib", "valdecoxib", "nimesulide", "meloxicam", "etodolac", "nabumetone",
    ],
  },
];
