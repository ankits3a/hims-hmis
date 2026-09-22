import type { AllergyClassEntry } from "../../src/modules/formulary";

/**
 * ═══ THE ALLERGY CLASSES OF THE OWNER'S CLINICAL MASTER, AS MOIETY MEMBERSHIPS ═══
 *
 * Source: `hmis_clinical_master` (the owner's Drive bundle, 2026-09-17; sha256 in
 * `/opt/hmis-context/cds-bundle/SHA256SUMS`), table `allergy_cross_reactivity_rules` (6 rules). Each
 * rule's allergen and "blocked molecules" become the moieties of one class, expanded to every moiety
 * of that class in the national release (names checked against the rehearsal database
 * `hmis_formulary_prodlike`, 2026-09-17). Where the source over-reaches, the membership follows the
 * standard reference, and the change is written here:
 *
 * - `#1` Penicillins: the source lists cephalexin and cefadroxil, whose side chain is amoxicillin's.
 *   Kept, and joined by cefaclor and cefprozil, which share an aminopenicillin side chain for the same
 *   reason. Later-generation cephalosporins are not in the penicillin class.
 * - `#2` Sulfonamides: the source lists furosemide, hydrochlorothiazide and celecoxib. Non-antibiotic
 *   sulfonamides do not meaningfully cross-react with sulfonamide antibiotics (Strom et al., NEJM
 *   2003), so they are NOT members; the class is the sulfonamide antibiotics. Dapsone (a sulfone) is
 *   left out.
 * - `#3` NSAIDs (AERD): the class is the COX-1 inhibitors the source names, plus the other
 *   non-selective ones sold here. Selective and preferential COX-2 inhibitors (celecoxib,
 *   etoricoxib, nimesulide, meloxicam, etodolac, nabumetone) are what an AERD patient is offered
 *   instead, so they are not members.
 * - `#4` Opioids: the source lists tramadol, fentanyl and pethidine beside morphine and codeine. A
 *   reaction to morphine or codeine is usually histamine release, shared across the MORPHINANS
 *   (phenanthrenes). The phenylpiperidines (fentanyl, pethidine) and tramadol are the standard
 *   alternatives, so they are not members. The key says so: `opioid_morphinan`.
 * - `#5` Ester local anaesthetics: as the source, with oxybuprocaine (an ester used in Indian eye
 *   clinics). Amides (lidocaine, bupivacaine) are the alternative. Cocaine is left out.
 * - `#6` Statins: the source's reaction is muscle symptoms, an intolerance rather than an allergy.
 *   Adopted all the same, because a doctor who records "Statins" means to be told.
 * - `hospital#1` Cephalosporins: not in the source. It is the hospital's own class, because every
 *   Indian hospital allergy list carries it and doctors type it.
 */
export const ALLERGY_CLASS_BOOK_2026_09_17: readonly AllergyClassEntry[] = [
  {
    classKey: "penicillin", rule: "allergy_cross_reactivity_rules#1",
    moieties: [
      "amoxicillin", "ampicillin", "bacampicillin", "benzylpenicillin", "procaine benzylpenicillin", "phenoxymethylpenicillin",
      "cloxacillin", "dicloxacillin", "flucloxacillin", "oxacillin", "nafcillin", "piperacillin", "ticarcillin", "mezlocillin",
      "carindacillin", "pivmecillinam",
      "cefalexin", "cefadroxil", "cefaclor", "cefprozil",
    ],
  },
  {
    classKey: "sulfonamide_antibiotic", rule: "allergy_cross_reactivity_rules#2",
    moieties: [
      "sulfamethoxazole", "sulfadiazine", "silver sulfadiazine", "sulfasalazine", "sulfadoxine", "sulfacetamide",
      "sulfafurazole", "sulfamethizole", "sulfanilamide", "sulfathiazole", "sulfaguanidine", "sulfalene", "sulfabenzamide",
      "mafenide",
    ],
  },
  {
    classKey: "nsaid", rule: "allergy_cross_reactivity_rules#3",
    moieties: [
      "aspirin", "ibuprofen", "dexibuprofen", "diclofenac", "aceclofenac", "naproxen", "mefenamic acid", "tolfenamic acid",
      "ketorolac", "piroxicam", "tenoxicam", "lornoxicam", "indometacin", "ketoprofen", "dexketoprofen", "flurbiprofen",
      "fenoprofen", "diflunisal",
    ],
  },
  {
    classKey: "opioid_morphinan", rule: "allergy_cross_reactivity_rules#4",
    moieties: [
      "morphine", "codeine", "diamorphine", "dihydrocodeine", "hydrocodone", "hydromorphone", "oxycodone", "oxymorphone",
      "buprenorphine", "nalbuphine", "butorphanol", "levorphanol",
    ],
  },
  {
    classKey: "ester_local_anaesthetic", rule: "allergy_cross_reactivity_rules#5",
    moieties: ["procaine", "benzocaine", "tetracaine", "proxymetacaine", "oxybuprocaine"],
  },
  {
    classKey: "statin", rule: "allergy_cross_reactivity_rules#6",
    moieties: ["atorvastatin", "simvastatin", "rosuvastatin", "pravastatin", "pitavastatin", "fluvastatin", "lovastatin"],
  },
  {
    classKey: "cephalosporin", rule: "hospital#1",
    moieties: [
      "cefalexin", "cefadroxil", "cefradine", "cefazolin", "cefalotin", "cefapirin", "cefatrizine",
      "cefaclor", "cefprozil", "cefuroxime", "cefamandole", "cefoxitin", "cefotetan", "cefmetazole",
      "cefixime", "cefpodoxime", "cefdinir", "cefditoren", "ceftibuten", "cefotaxime", "ceftriaxone", "ceftizoxime",
      "ceftazidime", "cefoperazone", "cefepime", "cefpirome", "ceftaroline fosamil", "ceftobiprole",
    ],
  },
];
