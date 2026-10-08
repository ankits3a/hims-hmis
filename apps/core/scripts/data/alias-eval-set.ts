/**
 * THE HELD-OUT SET FOR THE MEDICINE-ALIAS PIPELINE (`scripts/eval-aliases.ts`, 2026-10-08;
 * decision 0051: "a held-out set of at least 200 labelled terms; zero wrong at the confidence line
 * is the target; the measured numbers are stated first").
 *
 * Each item is a term a doctor in a north-Indian OPD could type or say, and what it means:
 *
 *   want: "<moieties>|<strengths>|<form class>"  — `compositionKey` of the right catalogue product
 *         (`modules/opd/alias-pipeline.ts`). ANY row with that composition is right: the brand the
 *         doctor named and the generic of the same composition are one answer to a prescriber.
 *   want: null — the pipeline must ABSTAIN: not a medicine, ambiguous as written, or a controlled
 *         medicine (Schedule H1 / X / NDPS) that no alias may ever point at. An answer is WRONG.
 *
 * THE LABELS ARE THE AUTHOR'S, NOT A PHARMACIST'S, and they are STRICT: a term that names no
 * strength for a medicine sold in several is labelled null even where a doctor "usually" means one,
 * and an error-prone abbreviation (MTX, ASA) is labelled null whatever it most likely means. Every
 * non-null label was checked to exist in the staging catalogue copy (`--dry` prints the misses).
 *
 * NONE OF THESE MAY EVER BECOME AN EXAMPLE shown to a model — not in the chooser's or reviewer's
 * instructions, not in an option's description, not in a learned list. The pipeline's instructions
 * carry no examples at all; keep it that way or this set stops measuring anything.
 */
export type AliasEvalCategory = "brand" | "spoken" | "generic" | "misspelling" | "abbreviation" | "lookalike" | "none" | "controlled";
export type AliasEvalItem = { term: string; cat: AliasEvalCategory; want: string | null };

const k = (salts: string, strength: string, form = "oral_solid"): string => `${salts}|${strength}|${form}`;
const PCM = "paracetamol";
const AMOXCLAV = "amoxicillin+clavulanic acid";

const brand: [string, string | null][] = [
  ["dolo 650", k(PCM, "650mg")], ["crocin 500", k(PCM, "500mg")], ["calpol 650", k(PCM, "650mg")], ["pan 40", k("pantoprazole", "40mg")],
  ["pantop 40", k("pantoprazole", "40mg")], ["rantac 150", k("ranitidine", "150mg")], ["omez 20", k("omeprazole", "20mg")],
  ["razo 20", k("rabeprazole", "20mg")], ["nexpro 40", k("esomeprazole", "40mg")], ["azithral 500", k("azithromycin", "500mg")],
  ["azee 250", k("azithromycin", "250mg")], ["cifran 500", k("ciprofloxacin", "500mg")], ["metrogyl 400", k("metronidazole", "400mg")],
  ["allegra 120", k("fexofenadine", "120mg")], ["allegra 180", k("fexofenadine", "180mg")], ["cetzine 10", k("cetirizine", "10mg")],
  ["montair 10", k("montelukast", "10mg")], ["glycomet 500", k("metformin", "500mg")], ["amaryl 1", k("glimepiride", "1mg")],
  ["amaryl 2", k("glimepiride", "2mg")], ["januvia 100", k("sitagliptin", "100mg")], ["telma 40", k("telmisartan", "40mg")],
  ["telma 80", k("telmisartan", "80mg")], ["amlong 5", k("amlodipine", "5mg")], ["stamlo 5", k("amlodipine", "5mg")],
  ["losar 50", k("losartan", "50mg")], ["concor 5", k("bisoprolol", "5mg")], ["atorva 10", k("atorvastatin", "10mg")],
  ["storvas 20", k("atorvastatin", "20mg")], ["rosuvas 10", k("rosuvastatin", "10mg")], ["ecosprin 75", k("aspirin", "75mg")],
  ["ecosprin 150", k("aspirin", "150mg")], ["clopilet 75", k("clopidogrel", "75mg")], ["thyronorm 50", k("levothyroxine", "0.05mg")],
  ["eltroxin 100", k("levothyroxine", "0.1mg")], ["brufen 400", k("ibuprofen", "400mg")], ["voveran 50", k("diclofenac", "50mg")],
  ["emeset 4", k("ondansetron", "4mg")], ["domstal 10", k("domperidone", "10mg")], ["drotin 40", k("drotaverine", "40mg")],
  ["lasix 40", k("furosemide", "40mg")], ["zyloric 100", k("allopurinol", "100mg")], ["folvite 5", k("folic acid", "5mg")],
  ["augmentin 625", k(AMOXCLAV, "125mg+500mg")], ["clavam 625", k(AMOXCLAV, "125mg+500mg")], ["lanoxin 0.25", k("digoxin", "0.25mg")],
  ["aldactone 25", k("spironolactone", "25mg")], ["hcqs 200", k("hydroxychloroquine", "200mg")], ["gabapin 300", k("gabapentin", "300mg")],
  ["levipil 500", k("levetiracetam", "500mg")], ["nexito 10", k("escitalopram", "10mg")], ["febutaz 40", k("febuxostat", "40mg")],
  ["dytor 10", k("torasemide", "10mg")], ["calpol 250 syp", k(PCM, "250mg", "oral_liquid")], ["pan 40 inj", k("pantoprazole", "40mg", "injection")],
];

const spoken: [string, string | null][] = [
  ["pan forty", k("pantoprazole", "40mg")], ["dolo six fifty", k(PCM, "650mg")], ["augmentin six two five", k(AMOXCLAV, "125mg+500mg")],
  ["crocin five hundred", k(PCM, "500mg")], ["calpol six fifty", k(PCM, "650mg")], ["telma forty", k("telmisartan", "40mg")],
  ["telma eighty", k("telmisartan", "80mg")], ["amlong five", k("amlodipine", "5mg")], ["atorva ten", k("atorvastatin", "10mg")],
  ["atorva twenty", k("atorvastatin", "20mg")], ["ecosprin seventy five", k("aspirin", "75mg")], ["ecosprin one fifty", k("aspirin", "150mg")],
  ["glycomet five hundred", k("metformin", "500mg")], ["glycomet ek gram", k("metformin", "1000mg", "oral_solid_mr")], ["thyronorm fifty", k("levothyroxine", "0.05mg")],
  ["thyronorm twenty five", k("levothyroxine", "0.025mg")], ["thyronorm hundred", k("levothyroxine", "0.1mg")], ["azithral five hundred", k("azithromycin", "500mg")],
  ["azee two fifty", k("azithromycin", "250mg")], ["cifran paanch sau", k("ciprofloxacin", "500mg")], ["metrogyl char sau", k("metronidazole", "400mg")],
  ["allegra one twenty", k("fexofenadine", "120mg")], ["allegra one eighty", k("fexofenadine", "180mg")], ["montair das", k("montelukast", "10mg")],
  ["rantac one fifty", k("ranitidine", "150mg")], ["omez bees", k("omeprazole", "20mg")], ["razo twenty", k("rabeprazole", "20mg")],
  ["brufen four hundred", k("ibuprofen", "400mg")], ["losar pachas", k("losartan", "50mg")], ["concor dhai", k("bisoprolol", "2.5mg")],
  ["lasix chalis", k("furosemide", "40mg")], ["zyloric sau", k("allopurinol", "100mg")], ["dolo sade chhe sau", k(PCM, "650mg")],
  ["calpol dhai sau syrup", k(PCM, "250mg", "oral_liquid")], ["pantop chalis", k("pantoprazole", "40mg")], ["emeset char", k("ondansetron", "4mg")],
  ["clopilet pachattar", k("clopidogrel", "75mg")], ["nexpro forty", k("esomeprazole", "40mg")], ["rosuvas ten", k("rosuvastatin", "10mg")],
  ["voveran fifty", k("diclofenac", "50mg")], ["januvia hundred", k("sitagliptin", "100mg")], ["folvite paanch", k("folic acid", "5mg")],
  ["dolo six fifty ki goli", k(PCM, "650mg")], ["pan forty subah khali pet", null],
];

const generic: [string, string | null][] = [
  ["paracetamol 650", k(PCM, "650mg")], ["paracetamol 500 tab", k(PCM, "500mg")], ["pantoprazole 40", k("pantoprazole", "40mg")],
  ["amoxicillin 500", k("amoxicillin", "500mg")], ["azithromycin 500", k("azithromycin", "500mg")], ["metformin 500", k("metformin", "500mg")],
  ["amlodipine 5", k("amlodipine", "5mg")], ["telmisartan 40", k("telmisartan", "40mg")], ["atorvastatin 10", k("atorvastatin", "10mg")],
  ["cetirizine 10", k("cetirizine", "10mg")], ["ibuprofen 400", k("ibuprofen", "400mg")], ["ondansetron 4", k("ondansetron", "4mg")],
  ["omeprazole 20", k("omeprazole", "20mg")], ["ranitidine 150", k("ranitidine", "150mg")], ["domperidone 10", k("domperidone", "10mg")],
  ["aspirin 75", k("aspirin", "75mg")], ["clopidogrel 75", k("clopidogrel", "75mg")], ["furosemide 40", k("furosemide", "40mg")],
  ["levothyroxine 50 mcg", k("levothyroxine", "0.05mg")], ["amoxyclav 625", k(AMOXCLAV, "125mg+500mg")], ["pcm 650", k(PCM, "650mg")],
  ["pcm 500", k(PCM, "500mg")], ["hcq 200", k("hydroxychloroquine", "200mg")], ["rosuvastatin 10", k("rosuvastatin", "10mg")],
  ["montelukast 10", k("montelukast", "10mg")], ["paracetamol paanch sau", k(PCM, "500mg")],
];

const misspelling: [string, string | null][] = [
  ["paracetmol 650", k(PCM, "650mg")], ["paracitamol 500", k(PCM, "500mg")], ["pantaprazole 40", k("pantoprazole", "40mg")],
  ["pantoprazol 40", k("pantoprazole", "40mg")], ["azithromicin 500", k("azithromycin", "500mg")], ["azythromycin 250", k("azithromycin", "250mg")],
  ["amoxycillin 500", k("amoxicillin", "500mg")], ["cetrizine 10", k("cetirizine", "10mg")], ["metformine 500", k("metformin", "500mg")],
  ["amlodipin 5", k("amlodipine", "5mg")], ["telmisartn 40", k("telmisartan", "40mg")], ["atorvastatine 10", k("atorvastatin", "10mg")],
  ["ibuprofin 400", k("ibuprofen", "400mg")], ["ondensetron 4", k("ondansetron", "4mg")], ["omeprazol 20", k("omeprazole", "20mg")],
  ["ranitidin 150", k("ranitidine", "150mg")], ["domperidon 10", k("domperidone", "10mg")], ["clopidogril 75", k("clopidogrel", "75mg")],
  ["frusemide 40", k("furosemide", "40mg")], ["levothyroxin 50 mcg", k("levothyroxine", "0.05mg")], ["dollo 650", k(PCM, "650mg")],
  ["crosin 500", k(PCM, "500mg")], ["calpal 650", k(PCM, "650mg")], ["augmentine 625", k(AMOXCLAV, "125mg+500mg")],
  ["azithrl 500", k("azithromycin", "500mg")], ["glycomate 500", k("metformin", "500mg")], ["telme 40", k("telmisartan", "40mg")],
  ["amlog 5", k("amlodipine", "5mg")], ["ecospirin 75", k("aspirin", "75mg")], ["thyronrom 50", k("levothyroxine", "0.05mg")],
  ["alegra 120", k("fexofenadine", "120mg")], ["montare 10", k("montelukast", "10mg")], ["rantec 150", k("ranitidine", "150mg")],
  ["omiz 20", k("omeprazole", "20mg")], ["ziloric 100", k("allopurinol", "100mg")], ["lasiks 40", k("furosemide", "40mg")],
  ["brufin 400", k("ibuprofen", "400mg")], ["voveron 50", k("diclofenac", "50mg")],
];

const abbreviation: [string, string | null][] = [
  ["pcm", null], ["mtx", null], ["mtx 7.5", null], ["asa", null], ["asa 75", null], ["hcq", null], ["nsaid", null], ["ppi", null],
  ["abx", null], ["mvi", null], ["ors", null], ["ntg", null], ["kcl", null], ["b12", null], ["d3", null], ["ifa", null],
  ["pred 10", null], ["dexa 4", null], ["glim 1", null], ["tt inj", null],
  ["hctz 12.5", k("hydrochlorothiazide", "12.5mg")], ["amox 500", k("amoxicillin", "500mg")], ["azi 500", k("azithromycin", "500mg")],
  ["cipro 500", k("ciprofloxacin", "500mg")], ["metro 400", k("metronidazole", "400mg")],
];

const lookalike: [string, string | null][] = [
  ["hydroxyzine 25", k("hydroxyzine", "25mg")], ["hydralazine 25", k("hydralazine", "25mg")], ["glimepiride 2", k("glimepiride", "2mg")],
  ["glipizide 5", k("glipizide", "5mg")], ["metronidazole 400", k("metronidazole", "400mg")], ["azathioprine 50", k("azathioprine", "50mg")],
  ["azithromycin 250", k("azithromycin", "250mg")], ["lamotrigine 25", k("lamotrigine", "25mg")], ["lamivudine 150", k("lamivudine", "150mg")],
  ["carbamazepine 200", k("carbamazepine", "200mg")], ["oxcarbazepine 300", k("oxcarbazepine", "300mg")], ["amlodipine 10", k("amlodipine", "10mg")],
  ["losartan 50", k("losartan", "50mg")], ["levetiracetam 500", k("levetiracetam", "500mg")], ["sertraline 50", k("sertraline", "50mg")],
  ["gliclazide 80", k("gliclazide", "80mg")], ["glibenclamide 5", k("glibenclamide", "5mg")],
  ["glimipizide 5", null], ["chlorprom 100", null], ["carbazepine 200", null], ["lamivigine 100", null], ["predniso 10", null],
  ["amlodarone 5", null], ["hydrazine 25", null], ["glibenclazide 5", null], ["quinid 300", null], ["azathromycin 50", null],
  ["cetraline 10", null], ["metronidamin 500", null],
];

const none: [string, string | null][] = [
  ["bukhar", null], ["chai", null], ["xray chest", null], ["cbc", null], ["sugar test", null], ["bp check", null], ["paneer", null],
  ["pan", null], ["augmentin", null], ["telma", null], ["calpol", null], ["thyronorm", null], ["atorva", null], ["zorvex 40", null],
  ["multivitamin", null], ["antibiotic", null], ["pain killer", null], ["gas ki goli", null], ["neend ki dawa", null], ["sugar ki dawa", null],
  ["bp ki goli", null], ["khansi ka syrup", null], ["tonic", null], ["calcium", null], ["vitamin", null], ["eye drop", null], ["ointment", null],
  ["bandage", null], ["syringe 5 ml", null], ["glucose strip", null], ["thermometer", null], ["nebulizer", null], ["dressing", null],
  ["ecg", null], ["usg abdomen", null], ["lft", null], ["kft", null], ["dolo 400", null], ["pan 30", null], ["telma 60", null],
];

const controlled: [string, string | null][] = [
  ["alprax 0.5", null], ["alprax 0.25", null], ["alprax point two five", null], ["alprazolam 0.5", null], ["restyl 0.5", null],
  ["zolfresh 10", null], ["zolpidem 10", null], ["lonazep 0.5", null], ["rivotril 0.5", null], ["clonazepam 0.5", null], ["ativan 2", null],
  ["lorazepam 1", null], ["calmpose 5", null], ["diazepam 5", null], ["nitrazepam 10", null], ["tramadol 50", null], ["tramazac 50", null],
  ["ultracet", null], ["tapentadol 50", null], ["morphine 10", null], ["morcontin 10", null], ["fortwin inj", null], ["ketamine inj", null],
  ["midazolam inj", null], ["corex syrup", null], ["codeine 15", null], ["gardenal 60", null], ["phenobarbitone 30", null],
  ["methylphenidate 10", null], ["taxim o 200", null], ["zifi 200", null], ["cefixime 200", null], ["monocef 1 gm", null],
  ["ceftriaxone 1 gm inj", null], ["levoflox 500", null], ["levofloxacin 750", null], ["oflox 200", null], ["cefpodoxime 200", null],
  ["meropenem 1 gm", null],
];

const of = (cat: AliasEvalCategory, rows: [string, string | null][]): AliasEvalItem[] => rows.map(([term, want]) => ({ term, cat, want }));

export const ALIAS_EVAL: AliasEvalItem[] = [
  ...of("brand", brand), ...of("spoken", spoken), ...of("generic", generic), ...of("misspelling", misspelling),
  ...of("abbreviation", abbreviation), ...of("lookalike", lookalike), ...of("none", none), ...of("controlled", controlled),
];
