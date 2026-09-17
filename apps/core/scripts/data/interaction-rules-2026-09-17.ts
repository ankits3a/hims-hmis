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
 *
 * ═══ SECOND SOURCE (P21b, 2026-09-17 evening): THE OWNER'S CLINICAL MATRIX, 18 RULES ═══
 *
 * `hmis_ddi_rules.json` as the owner re-issued it (sha256 in
 * `/opt/hmis-context/clinical-matrix-2026-09-17b/SHA256SUMS`): 18 class rules with substance lists,
 * mechanism, action and a suggested switch. The `clinical_matrix#DDI_0xx` groups below add what the
 * ten rules above and the starter seed did not already hold, with each pair checked the same way.
 * The source's text is not copied; each note is ours. Departures from the source:
 *
 * - `DDI_002` calls every beta-blocker × non-DHP CCB "strictly contraindicated". Verapamil stays
 *   `severe` and diltiazem `moderate`, as ruled above.
 * - `DDI_005` lists spironolactone and diltiazem as potent P-glycoprotein inhibitors. They raise
 *   digoxin modestly (spironolactone also disturbs the assay), so they are `moderate`.
 * - `DDI_007` rates penicillins with methotrexate beside NSAIDs. The penicillin effect matters at
 *   high methotrexate doses, so it is `moderate`. NSAIDs stay `severe`, as the starter seed rules for
 *   ibuprofen.
 * - `DDI_009` puts dextromethorphan beside linezolid and the MAO-B inhibitors. Its serotonergic
 *   effect at cough doses is `moderate`. Tramadol with linezolid or rasagiline is added: the same
 *   mechanism the rule names.
 * - `DDI_001` lists etoricoxib among the NSAIDs. A COX-2-selective NSAID still raises the INR and the
 *   bleeding risk, but less, so it is `moderate`.
 * - `DDI_017` rates paracetamol × isoniazid RED again. It stays `moderate` (above).
 * - Names follow the national release: indometacin, glyceryl trinitrate, chlortalidone, lithium (for
 *   its salts), zinc (for zinc sulfate), sulfamethoxazole (for co-trimoxazole), aspirin.
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
// P21b — the clinical matrix's wider groups.
const SEROTONERGIC_ANTIDEPRESSANTS = ["escitalopram", "citalopram", "paroxetine", "fluvoxamine", "sertraline", "fluoxetine", "venlafaxine", "duloxetine"];
const OPIOIDS = ["morphine", "tramadol", "fentanyl", "codeine", "oxycodone", "buprenorphine", "tapentadol"];
const SEDATIVES = ["alprazolam", "clonazepam", "diazepam", "lorazepam", "midazolam", "zolpidem", "chlordiazepoxide"];
const PDE5_INHIBITORS = ["sildenafil", "tadalafil", "vardenafil", "avanafil"];
const NITRATES = ["glyceryl trinitrate", "isosorbide dinitrate", "isosorbide mononitrate", "nicorandil"];
const TETRACYCLINES = ["doxycycline", "tetracycline", "minocycline"];
const THIAZIDES = ["hydrochlorothiazide", "chlortalidone", "indapamide"];
const CYP3A4_STRONG = ["ketoconazole", "itraconazole", "ritonavir", "cobicistat", "clarithromycin", "erythromycin"];
const CYP2C9_WARFARIN = "Blocks the anticoagulant's breakdown (CYP2C9) — the INR can rise sharply within days; reduce the dose and check the INR within 3 days.";
const NSAID_BLEED = "An NSAID with an anticoagulant raises the risk of serious bleeding — avoid; use paracetamol, or add gastric protection if it cannot be avoided.";

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

  // ═══ P21b — the owner's clinical matrix (18 rules), what the book did not already hold ═══
  ...pairs("clinical_matrix#DDI_001", NSAIDS, ["edoxaban"], "severe", NSAID_BLEED, "systemic_only"),
  ...pairs("clinical_matrix#DDI_001", ["etoricoxib"], [...ANTICOAGULANTS, "edoxaban"], "moderate",
    "Even a COX-2-selective NSAID raises the INR and the bleeding risk with an anticoagulant — prefer paracetamol; if it must be used, monitor.",
    "systemic_only"),
  ...pairs("clinical_matrix#DDI_002", ["labetalol", "esmolol"], ["verapamil"], "severe",
    "Verapamil with a beta-blocker can cause severe bradycardia, heart block and hypotension — avoid the combination."),
  ...pairs("clinical_matrix#DDI_002", ["labetalol", "esmolol"], ["diltiazem"], "moderate",
    "Diltiazem with a beta-blocker slows the heart and AV conduction — monitor pulse, blood pressure and ECG."),
  ...pairs("clinical_matrix#DDI_003", [...ACE_INHIBITORS, ...ARBS], ["potassium citrate"], "severe",
    "Risk of dangerous hyperkalaemia — check potassium and creatinine within a week of starting them together."),
  ...pairs("clinical_matrix#DDI_004", CYP3A4_STRONG, ["lovastatin"], "severe",
    "Strong CYP3A4 inhibition raises the statin level — rhabdomyolysis risk. Withhold the statin during the course, or use rosuvastatin or pravastatin."),
  ...pairs("clinical_matrix#DDI_004", ["cobicistat"], ["simvastatin", "atorvastatin"], "severe",
    "Strong CYP3A4 inhibition raises the statin level — rhabdomyolysis risk. Withhold the statin, or use rosuvastatin or pravastatin."),
  ...pairs("clinical_matrix#DDI_005", ["digoxin"], ["clarithromycin", "itraconazole", "quinidine"], "severe",
    "Raises the digoxin level (P-glycoprotein) — toxicity. Halve the digoxin and check a trough level after 7–10 days."),
  ...pairs("clinical_matrix#DDI_005", ["digoxin"], ["diltiazem", "spironolactone"], "moderate",
    "May raise the digoxin level (spironolactone can also disturb the assay) — watch pulse and symptoms, and check the level if in doubt."),
  ...pairs("clinical_matrix#DDI_006", PDE5_INHIBITORS, NITRATES, "severe",
    "Profound, refractory hypotension — contraindicated. No nitrate within 24 hours of sildenafil or 48 hours of tadalafil."),
  ...pairs("clinical_matrix#DDI_007", ["methotrexate"], NSAIDS, "severe",
    "NSAIDs reduce methotrexate clearance — marrow and kidney toxicity. Avoid with high-dose methotrexate; with weekly low-dose, check blood counts and creatinine.",
    "systemic_only"),
  ...pairs("clinical_matrix#DDI_007", ["methotrexate"], ["amoxicillin", "ampicillin", "piperacillin"], "moderate",
    "Penicillins reduce methotrexate excretion — check blood counts, especially with higher methotrexate doses."),
  ...pairs("clinical_matrix#DDI_008", ["lithium"], NSAIDS, "severe",
    "NSAIDs reduce lithium clearance — toxicity. Use paracetamol; otherwise check lithium levels.", "systemic_only"),
  ...pairs("clinical_matrix#DDI_008", ["lithium"], THIAZIDES, "severe",
    "Thiazides raise the lithium level by a quarter or more — reduce the lithium dose and check levels weekly."),
  ...pairs("clinical_matrix#DDI_008", ["lithium"], [...ACE_INHIBITORS, ...ARBS], "severe",
    "ACE inhibitors and ARBs reduce lithium clearance — toxicity; check lithium levels weekly after starting."),
  ...pairs("clinical_matrix#DDI_009", ["sertraline", "fluoxetine", "venlafaxine", "duloxetine"], ["tramadol"], "severe",
    "Serotonin syndrome and seizure risk — avoid, or choose another analgesic."),
  ...pairs("clinical_matrix#DDI_009", SEROTONERGIC_ANTIDEPRESSANTS, ["linezolid", "selegiline", "rasagiline"], "severe",
    "Serotonin syndrome, which can be fatal — do not combine linezolid or an MAO-B inhibitor with an SSRI or SNRI."),
  ...pairs("clinical_matrix#DDI_009", ["tramadol"], ["linezolid", "rasagiline"], "severe",
    "Serotonin syndrome and seizures — avoid the combination."),
  ...pairs("clinical_matrix#DDI_009", SEROTONERGIC_ANTIDEPRESSANTS, ["dextromethorphan"], "moderate",
    "Dextromethorphan adds serotonergic effect — prefer another cough remedy, or watch for agitation, tremor and fever."),
  ...pairs("clinical_matrix#DDI_010", OPIOIDS, SEDATIVES, "severe",
    "An opioid with a benzodiazepine or a Z-drug — profound sedation and respiratory depression (boxed warning). Avoid; if unavoidable, lowest doses for the shortest time, and counsel the family on naloxone."),
  ...pairs("clinical_matrix#DDI_011", TETRACYCLINES, [...CATION_BINDERS, "zinc", "ferrous ascorbate"], "moderate",
    "Antacids, calcium, iron and zinc bind the tetracycline and block its absorption — give it 2 hours before or 4–6 hours after.",
    "systemic_only"),
  ...pairs("clinical_matrix#DDI_011", QUINOLONES, ["sucralfate", "zinc", "ferrous ascorbate"], "moderate",
    "Sucralfate, zinc and iron bind the quinolone and block its absorption — give the quinolone 2 hours before or 6 hours after.",
    "systemic_only"),
  ...pairs("clinical_matrix#DDI_013", ["theophylline", "aminophylline"], ["fluvoxamine"], "severe",
    "Fluvoxamine blocks theophylline clearance (CYP1A2) — toxicity and seizures. Avoid, or halve the dose and check levels."),
  ...pairs("clinical_matrix#DDI_013", ["aminophylline"], ["ciprofloxacin"], "severe",
    "Ciprofloxacin blocks theophylline clearance (CYP1A2) — toxicity and seizures. Avoid, or halve the dose and check levels."),
  ...pairs("clinical_matrix#DDI_014", ["warfarin", "acenocoumarol"], ["miconazole", "sulfamethoxazole"], "severe", CYP2C9_WARFARIN),
  ...pairs("clinical_matrix#DDI_014", ["acenocoumarol"], ["fluconazole", "metronidazole", "amiodarone"], "severe", CYP2C9_WARFARIN),
  ...pairs("clinical_matrix#DDI_015", ["allopurinol", "febuxostat"], ["azathioprine", "mercaptopurine"], "severe",
    "Xanthine oxidase inhibition blocks the breakdown of azathioprine and mercaptopurine — fatal marrow suppression. Avoid febuxostat; with allopurinol, give a quarter of the dose and check blood counts weekly."),
  ...pairs("clinical_matrix#DDI_016", ["paracetamol"], ["acenocoumarol"], "moderate",
    "Regular paracetamol (over 2 g a day for several days) can raise the INR — check the INR when it is taken regularly."),
  ...pairs("clinical_matrix#DDI_018", ["aspirin"], ["clopidogrel", "ticagrelor", "prasugrel"], "moderate",
    "Dual antiplatelet therapy adds bleeding risk — intended for a set time after a stent or an acute coronary syndrome; add gastric protection if the bleeding risk is high."),
];
