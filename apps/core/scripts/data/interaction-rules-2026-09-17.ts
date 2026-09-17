import type { InteractionRule } from "../../src/modules/formulary";

/**
 * ═══ THE DRUG–DRUG RULES OF THE OWNER'S CLINICAL MASTER, AS PAIRS OF MOIETIES ═══
 *
 * Source: `hmis_clinical_master` (the owner's Drive bundle, 2026-09-17; sha256 in
 * `/opt/hmis-context/cds-bundle/SHA256SUMS`), tables `ddi_rules` (10 class-level rules) and
 * `cyp450_interaction_matrix` (5 rules). Each class-level rule is expanded to the named moieties an
 * Indian hospital stocks. Each pair was checked against the standard references before it was
 * listed. Where the source was wrong, the pair follows the reference, and the change is written
 * here:
 *
 * - `ddi_rules#2` paracetamol × isoniazid: the source says RED. The references rate the
 *   hepatotoxicity risk moderate, so it is `moderate` (a notice, not a gate).
 * - `ddi_rules#5` macrolides × statins: the source names azithromycin. Azithromycin is not a
 *   meaningful CYP3A4 inhibitor, and the source's own CYP table lists only clarithromycin. The
 *   macrolide pairs (clarithromycin, erythromycin) are already in the starter seed, so this rule
 *   adds the other strong CYP3A4 inhibitors from `cyp450#CYP_3A4_STAT` instead.
 * - `ddi_rules#9` beta-blockers × non-dihydropyridine CCBs: verapamil is `severe`. Diltiazem is
 *   `moderate`, because the combination is used under monitoring.
 * - `ddi_rules#8` names "iodinated radiocontrast media": the three contrast agents in the national
 *   release stand for it.
 *
 * Severity: the source's RED is `severe` (a hard warning the prescriber clears with a reason) and
 * AMBER is `moderate` (a notice). NSAID and quinolone pairs are `systemic_only`: a gel or an eye
 * drop does not carry the risk.
 */
const pairs = (
  rule: string, as: readonly string[], bs: readonly string[], severity: InteractionRule["severity"], note: string,
  routeScope: InteractionRule["routeScope"] = null,
): InteractionRule[] => as.flatMap((a) => bs.map((b) => ({ rule, a, b, severity, note, routeScope })));

const ACE_INHIBITORS = ["enalapril", "ramipril", "lisinopril", "perindopril", "captopril"];
const ARBS = ["telmisartan", "losartan", "olmesartan", "valsartan", "candesartan"];
const POTASSIUM_RETAINING = ["spironolactone", "eplerenone", "amiloride", "triamterene", "potassium chloride"];
const NSAIDS = ["ibuprofen", "diclofenac", "aceclofenac", "naproxen", "ketorolac", "mefenamic acid", "piroxicam", "indometacin"];
const ANTICOAGULANTS = ["warfarin", "acenocoumarol", "apixaban", "rivaroxaban", "dabigatran etexilate"];
const DOACS = ["apixaban", "rivaroxaban", "dabigatran etexilate"];
const QUINOLONES = ["ciprofloxacin", "levofloxacin", "ofloxacin", "norfloxacin", "moxifloxacin"];
// The release's spellings: "aluminium hydroxide", and "calcium" (the moiety of every calcium salt,
// carbonate included). "aluminum hydroxide" and "calcium carbonate" resolved to nothing and their 10
// pairs were skipped (found 2026-09-17 against the rehearsal database).
const CATION_BINDERS = ["aluminium hydroxide", "magnesium hydroxide", "calcium", "ferrous sulfate", "ferrous fumarate"];
const BETA_BLOCKERS = ["propranolol", "atenolol", "metoprolol", "bisoprolol", "carvedilol", "nebivolol"];
const CONTRAST = ["iohexol", "iopamidol", "iodixanol"];

export const INTERACTION_RULES_2026_09_17: readonly InteractionRule[] = [
  ...pairs("ddi_rules#1", ["paracetamol"], ["warfarin"], "moderate",
    "Regular paracetamol (over 2 g a day for several days) can raise the INR — check the INR when it is taken regularly."),
  ...pairs("ddi_rules#2", ["paracetamol"], ["isoniazid"], "moderate",
    "Isoniazid can add to paracetamol's liver toxicity — keep paracetamol to the lowest dose and short courses; watch liver function."),
  ...pairs("ddi_rules#3", [...ACE_INHIBITORS, ...ARBS], POTASSIUM_RETAINING, "severe",
    "Risk of dangerous hyperkalaemia — check potassium and creatinine within a week of starting them together."),
  ...pairs("ddi_rules#4", NSAIDS, ANTICOAGULANTS, "severe",
    "An NSAID with an anticoagulant raises the risk of serious bleeding — avoid; use paracetamol, or add gastric protection if it cannot be avoided.",
    "systemic_only"),
  ...pairs("ddi_rules#5", ["ketoconazole", "itraconazole", "ritonavir"], ["simvastatin", "atorvastatin"], "severe",
    "Strong CYP3A4 inhibition raises the statin level — rhabdomyolysis risk. Withhold the statin during the course."),
  ...pairs("ddi_rules#6", QUINOLONES, CATION_BINDERS, "moderate",
    "Antacids, calcium and iron bind the quinolone and block its absorption — give the quinolone 2 hours before or 6 hours after.",
    "systemic_only"),
  ...pairs("ddi_rules#7", ["omeprazole", "esomeprazole"], ["clopidogrel"], "moderate",
    "Omeprazole and esomeprazole reduce clopidogrel's activation — use pantoprazole instead."),
  ...pairs("ddi_rules#8", ["metformin"], CONTRAST, "severe",
    "Contrast can impair kidney function and metformin may then accumulate (lactic acidosis) — withhold metformin from the scan until kidney function is confirmed normal, usually 48 hours."),
  ...pairs("ddi_rules#9", BETA_BLOCKERS, ["verapamil"], "severe",
    "Verapamil with a beta-blocker can cause severe bradycardia, heart block and hypotension — avoid the combination."),
  ...pairs("ddi_rules#9", BETA_BLOCKERS, ["diltiazem"], "moderate",
    "Diltiazem with a beta-blocker slows the heart and AV conduction — monitor pulse, blood pressure and ECG."),
  ...pairs("ddi_rules#10", ["escitalopram", "citalopram", "paroxetine", "fluvoxamine"], ["tramadol"], "severe",
    "Serotonin syndrome and seizure risk — avoid, or choose another analgesic."),
  ...pairs("cyp450#CYP_3A4_DOAC", ["rifampicin", "carbamazepine", "phenytoin"], DOACS, "severe",
    "A strong enzyme inducer lowers the anticoagulant level — risk of stroke or clot. Avoid; choose another anticoagulant."),
  ...pairs("cyp450#CYP_2D6_TAMOX", ["fluoxetine", "paroxetine", "bupropion"], ["tamoxifen"], "severe",
    "Blocks tamoxifen's activation and may weaken its effect against breast cancer — choose another antidepressant (for example venlafaxine)."),
  ...pairs("cyp450#CYP_2C9_WARF", ["amiodarone"], ["warfarin"], "severe",
    "Amiodarone slows warfarin's clearance for months — the INR rises; reduce the warfarin dose and check the INR weekly."),
];
