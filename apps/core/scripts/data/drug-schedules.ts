/**
 * ═══ THE STATUTORY DRUG SCHEDULES — H1, X AND H — AS THE LAW PRINTS THEM ═══
 *
 * Consumed by `scripts/set-schedule-flags.ts` to derive `formulary_medicines.schedule_flag`. Read on
 * 2026-09-22. Nothing here is inferred from a drug's class, a brand's label or a model's memory: every
 * entry is transcribed from a Government of India text, and an entry that could not be read with
 * confidence is marked `UNSURE` in its note rather than silently corrected.
 *
 * ═══ SOURCES ═══
 *
 *  1. THE CONSOLIDATED RULES (primary for all three schedules, since it carries every amendment):
 *     "The Drugs Rules, 1945" as updated by CDSCO to September 2024 —
 *     https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2022/drug_rules/Drugs%20Rules%201945_2024%2009.pdf
 *     sha256 fb5b7675a9a0e9cb539fa0131875922f1bdd290389a192aa1a67d0b9d871eeb7 (963 pages; the
 *     schedules are on pp. 502–509 (H, H1) and 847–848 (X); amendment history in footnotes 1108–1127,
 *     1286–1289, 1336, 1341).
 *  2. THE H1 NOTIFICATION ITSELF, cross-checked entry by entry against (1): G.S.R. 588(E), 30 August
 *     2013, Drugs and Cosmetics (Fourth Amendment) Rules, 2013. CDSCO's copy
 *     (https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2022/drug_rules/DR_G.S.R.%20588(E)%20dt_30.08.2013_Amendment%20Rule%2065,%20Rule%2097_Inclusion%20of%20Sch%20H1,%20Labelling%20requirements,%20Sch%20H%20list.pdf,
 *     sha256 cae43c3b5997…) is an image-only scan with no text layer; the entries were read from a
 *     text-layer copy of the same Gazette pages
 *     (https://thehealthmaster.com/wp-content/uploads/2020/10/GSR-No.-588E-Dt-30-08-2013-Schedule-H1-Drugs-DC-fourth-Amendment-Rules-2013.pdf).
 *     Where (1) and (2) disagree on a spelling the Gazette wins: (1) prints "Cerdinir" and
 *     "Tniacetazone", the Gazette "Cefdinir" and "Thiacetazone".
 *
 * ═══ HOW IT WAS TRANSCRIBED ═══
 *
 * `pdftotext -layout`, then a two-column parser keyed on the printed serial numbers, then a check that
 * the serials run 1..552 with no gap. Every "[***]" (an entry OMITTED by a later amendment) is dropped
 * and its footnote read: 30 omissions, 26 of them the moves to H1 by G.S.R. 588(E), plus
 * chlorpheniramine and dextromethorphan (G.S.R. 602(E), 2010), ketamine (moved to X, G.S.R. 724(E),
 * 2013) and oxytocin (moved to H1, G.S.R. 795(E), 2018). 552 − 30 = 522 live Schedule H entries.
 *
 * `name` is the text AS PRINTED, typos included ("Aliopurinol", "Linezplid", "Pantopiazole") — so the
 * entry can be found in the source by searching for it. The real spelling is in `aliases`, in the
 * formulary's own spelling where `formulary_salts` carries the substance (checked against the 3,705
 * names in the 103,383-row catalogue). One scan artefact is corrected in `name` itself: "Clopidogre!"
 * is printed with an exclamation mark for the final "l".
 *
 * ═══ THE RULE THE CONSUMER APPLIES ═══
 *
 *  - A product takes the STRICTEST schedule any of its ingredients carries: X > H1 > H.
 *  - An ingredient matches an entry by NORMALISED name — lowercase, and salt/ester words
 *    (hydrochloride, sodium, potassium, sulphate/sulfate, maleate, besylate, tartrate, acetate, …)
 *    stripped by the consumer, not here — against `name` and every alias. Whole-name equality, never a
 *    substring: "glutethimide" (X) is inside "aminoglutethimide" (H).
 *  - A `qualified: true` entry is NOT a plain substance: a class ("Antibiotics", "Corticosteroids",
 *    "Narcotic Drugs listed in the NDPS Act"), a restriction to one preparation ("Iron Preparation for
 *    Parenteral use"), a combination, a vaccine or a device. Its `note` says which. A name match on it
 *    is not enough to classify a product, and a consumer must not pretend it is — those rows stay
 *    unclassified unless something else classifies them.
 *  - Preparation scope (topical/external exclusions) is in the `*_SCOPE` strings below, verbatim. The
 *    consumer decides what to do with a topical product; it is not encoded per entry.
 *
 * Schedule H is PRESCRIPTION-ONLY ("Schedule H — Prescription drug — Caution"). There is no statutory
 * "OTC" list in these Rules; a product whose ingredients appear on none of the three is NOT thereby OTC.
 */
export type ScheduleEntry = { name: string; aliases?: readonly string[]; qualified?: boolean; note?: string };

export const SCHEDULE_H1_SOURCE = {
  instrument: "G.S.R. 588(E), 30 August 2013 (Drugs and Cosmetics (Fourth Amendment) Rules, 2013); items 47–50 added by G.S.R. 795(E) 2018, G.S.R. 258(E) 2021 and G.S.R. 95(E) 2024",
  url: "https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2022/drug_rules/Drugs%20Rules%201945_2024%2009.pdf",
  /** CDSCO's footnotes give w.e.f. 27 February 2014 (the Gazette: "six months after publication"). */
  effective: "2014-02-27",
} as const;

export const SCHEDULE_H1_SCOPE =
  "Preparations containing the above drug substances and their salts excluding those intended for topical or external use " +
  "(except ophthalmic and ear or nose preparations) containing above substances are also covered by this Schedule.";

/** Schedule H1 — 46 substances as notified in 2013, and the four inserted since. */
export const SCHEDULE_H1: readonly ScheduleEntry[] = [
  { name: "Alprazolam" }, // 1
  { name: "Balofloxacin" }, // 2
  { name: "Buprenorphine" }, // 3
  { name: "Capreomycin" }, // 4
  { name: "Cefdinir" }, // 5 — the consolidated text misprints "Cerdinir"
  { name: "Cefditoren" }, // 6
  { name: "Cefepime" }, // 7
  { name: "Cefetamet" }, // 8
  { name: "Cefixime" }, // 9
  { name: "Cefoperazone" }, // 10
  { name: "Cefotaxime" }, // 11
  { name: "Cefpirome" }, // 12
  { name: "Cefpodoxime" }, // 13
  { name: "Ceftazidime" }, // 14
  { name: "Ceftibuten" }, // 15
  { name: "Ceftizoxime" }, // 16
  { name: "Ceftriaxone" }, // 17
  { name: "Chlordiazepoxide" }, // 18
  { name: "Clofazimine" }, // 19
  { name: "Codeine" }, // 20
  { name: "Cycloserine" }, // 21
  { name: "Diazepam" }, // 22
  { name: "Diphenoxylate" }, // 23
  { name: "Doripenem" }, // 24
  { name: "Ertapenem" }, // 25
  { name: "Ethambutol Hydrochloride", aliases: ["ethambutol"] }, // 26
  { name: "Ethionamide" }, // 27
  { name: "Feropenem", aliases: ["faropenem"] }, // 28 — printed "Feropenem"; the INN is faropenem
  { name: "Gemifloxacin" }, // 29
  { name: "Imipenem" }, // 30
  { name: "Isoniazid" }, // 31
  { name: "Levofloxacin" }, // 32
  { name: "Meropenem" }, // 33
  { name: "Midazolam" }, // 34
  { name: "Moxifloxacin" }, // 35
  { name: "Nitrazepam" }, // 36
  { name: "Pentazocine" }, // 37
  { name: "Prulifloxacin" }, // 38
  { name: "Pyrazinamide" }, // 39
  { name: "Rifabutin" }, // 40
  { name: "Rifampicin", aliases: ["rifampin"] }, // 41
  { name: "Sodium Para-aminosalicylate", aliases: ["para-aminosalicylic acid", "aminosalicylic acid", "pas - para-aminosalicylic acid"] }, // 42
  { name: "Sparfloxacin" }, // 43
  { name: "Thiacetazone", aliases: ["thioacetazone"] }, // 44 — the consolidated text misprints "Tniacetazone"
  { name: "Tramadol" }, // 45
  { name: "Zolpidem" }, // 46
  { name: "Oxytocin", note: "inserted by G.S.R. 795(E), 21 August 2018 (w.e.f. 1 September 2018); omitted from Schedule H by the same" }, // 47
  { name: "Tapentadol", note: "inserted by G.S.R. 258(E), 7 April 2021 (w.e.f. 1 November 2021)" }, // 48
  { name: "Oseltamivir", note: "inserted by G.S.R. 95(E), 5 February 2024" }, // 49
  { name: "Zanamivir", note: "inserted by G.S.R. 95(E), 5 February 2024" }, // 50
];

export const SCHEDULE_X_SOURCE = {
  instrument: "Drugs and Cosmetics Rules, 1945, Schedule X (ins. G.S.R. 462(E), 22 June 1982), as amended by G.S.R. 673(E) 1993, G.S.R. 647(E) 1998 and G.S.R. 724(E) 2013",
  url: "https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2022/drug_rules/Drugs%20Rules%201945_2024%2009.pdf",
  effective: "1982-06-22",
} as const;

export const SCHEDULE_X_SCOPE =
  "1. Any stereoisomeric form of the substance specified in this Schedule, any salt of the substance and preparation containing " +
  "such substances are also covered by this Schedule. 2. Preparations containing the above substances are also covered by this " +
  "Schedule: Provided, however, preparations containing Meprobamate in combination with other drugs may be exempted by the " +
  "Licensing Authority specified in clause (b) of rule 21, from the provisions of this Schedule, if satisfactory evidence is " +
  "adduced that these preparations are not liable to be misused.";

/** Schedule X — sixteen substances, in the order printed (three columns read row by row). */
export const SCHEDULE_X: readonly ScheduleEntry[] = [
  { name: "Amobarbital" },
  { name: "Phencyclidine" },
  { name: "Dexamphetamine", aliases: ["dexamfetamine", "dextroamphetamine"] },
  { name: "Glutethimide" },
  { name: "Barbital" },
  { name: "Methylphenidate" },
  { name: "Pentobarbital" },
  { name: "Methamphetamine", aliases: ["metamfetamine"] },
  { name: "Secobarbital" },
  { name: "Ketamine hydrochloride", aliases: ["ketamine"], note: "inserted by G.S.R. 724(E), 7 November 2013 (omitted from Schedule H by the same)" },
  { name: "Phenometrazine", aliases: ["phenmetrazine"] },
  { name: "Ethclorvynol", aliases: ["ethchlorvynol"] },
  { name: "Cyclobarbital" },
  { name: "Methylphenobarbital" },
  { name: "Amphetamine", aliases: ["amfetamine"] },
  {
    name: "Meprobamate", qualified: true,
    note: "a meprobamate COMBINATION may be exempted by the Licensing Authority (Note 2) — single-ingredient meprobamate is X; a combination is X unless exempted, which this list cannot know",
  },
];

export const SCHEDULE_H_SOURCE = {
  instrument: "Drugs and Cosmetics Rules, 1945, Schedule H (subs. G.S.R. 160(E), 16 March 2006) as amended to September 2024",
  url: "https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2022/drug_rules/Drugs%20Rules%201945_2024%2009.pdf",
  effective: "2006-03-16",
} as const;

export const SCHEDULE_H_SCOPE =
  "1. Preparations exempted under proviso to para 2 of Note to Schedule X shall also be covered by this Schedule. 2. The salts, " +
  "esters, derivatives and preparations containing the above substances excluding those intended for topical or external use " +
  "(except ophthalmic and ear/nose preparations containing antibiotics and/or steroids) are also covered by this Schedule. " +
  "4. The salts, esters, derivatives and preparations containing steroids or Hydroquinone for topical or external use shall also " +
  "be covered under this Schedule.";

/**
 * Schedule H — the 522 live entries of the 552 printed serials, in serial order (the trailing comment
 * is the printed serial number). Omitted serials are absent; see the header.
 */
export const SCHEDULE_H: readonly ScheduleEntry[] = [
  { name: "Abacavir" }, // 1
  { name: "Abciximab" }, // 2
  { name: "Acamprosate Calcium" }, // 3
  { name: "Acebutol Hydrochloride", aliases: ["acebutolol"] }, // 4
  { name: "Aclarubicin" }, // 5
  { name: "Albendazole" }, // 6
  { name: "Alclometasone Dipropionate" }, // 7
  { name: "Actilyse", aliases: ["alteplase"] }, // 8
  { name: "Acyclovir" }, // 9
  { name: "Adenosine" }, // 10
  { name: "Adrenocorticotrophic Hormone (Acth)", aliases: ["corticotropin", "acth"] }, // 11
  { name: "Alendronate Sodium" }, // 12
  { name: "Aliopurinol", aliases: ["allopurinol"] }, // 13
  { name: "Alphachymotrypsin", aliases: ["chymotrypsin", "alpha-chymotrypsin"] }, // 14
  { name: "Alprostadil" }, // 16
  { name: "Amantadine Hydrochloride" }, // 17
  { name: "Amifostine" }, // 18
  { name: "Amikacin Sulphate" }, // 19
  { name: "Amiloride Hydrochloride" }, // 20
  { name: "Aminepline", aliases: ["amineptine"] }, // 21
  { name: "Aminoglu tethimide", aliases: ["aminoglutethimide"] }, // 22
  { name: "Aminosalicylic Acid", aliases: ["para-aminosalicylic acid"] }, // 23
  { name: "Amiodarone Hydrochloride" }, // 24
  { name: "Amitriptyline" }, // 25
  { name: "Amlodipine Besylate" }, // 26
  { name: "Amoscanate" }, // 27
  { name: "Amoxopine", aliases: ["amoxapine"] }, // 28
  { name: "Amrinone Lactate", aliases: ["amrinone", "inamrinone"] }, // 29
  { name: "Analgin", aliases: ["metamizole", "dipyrone"] }, // 30
  { name: "Androgenic Anabolic, Oestrogenic & Progestational Substances", qualified: true, note: "CLASS ENTRY: every androgenic, anabolic, oestrogenic and progestational substance — cannot be matched by one substance name" }, // 31
  { name: "Antibiotics", qualified: true, note: "CLASS ENTRY: every antibiotic — cannot be matched by one substance name" }, // 32
  { name: "Apraclonidine" }, // 33
  { name: "Aprotinin" }, // 34
  { name: "Organic Compound of Arsenic", qualified: true, note: "CLASS ENTRY: organic arsenicals" }, // 35
  { name: "Arteether", aliases: ["alpha/beta-arteether", "artemotil"] }, // 36
  { name: "Artemether" }, // 37
  { name: "Artesunate" }, // 38
  { name: "Articaine Hydrochloride" }, // 39
  { name: "Atenolol" }, // 40
  { name: "Atracurium Besylate Injection", aliases: ["atracurium"], qualified: true, note: "printed as the injection" }, // 41
  { name: "Atorvastatin" }, // 42
  { name: "Auranofin" }, // 43
  { name: "Azathioprine" }, // 44
  { name: "Aztreonam" }, // 45
  { name: "Bacampicillin" }, // 46
  { name: "Baclofen" }, // 47
  { name: "Balsalazide" }, // 48
  { name: "Bambuterol" }, // 49
  { name: "Barbituric Acid", qualified: true, note: "CLASS ENTRY as printed: barbituric acid (and, by Note 2, its salts and derivatives)" }, // 50
  { name: "Basiliximab" }, // 51
  { name: "Benazepril Hydrochloride" }, // 52
  { name: "Benidipine Hydrochloride" }, // 53
  { name: "Benserazide Hydrochloride" }, // 54
  { name: "Betahistine Dihydrochloride" }, // 55
  { name: "Bethanidine Sulphate" }, // 56
  { name: "Bezafibrate" }, // 57
  { name: "Bicalutamide" }, // 58
  { name: "Biclotymol" }, // 59
  { name: "Bifonazole" }, // 60
  { name: "Bimatoprost" }, // 61
  { name: "Biperiden Hydrochloride" }, // 62
  { name: "Biphenyl Acetic Acid", aliases: ["felbinac"] }, // 63
  { name: "Bitoscanate" }, // 64
  { name: "Bleomycin" }, // 65
  { name: "Primonidine Tartrate", aliases: ["brimonidine"] }, // 66
  { name: "Bromhexine Hydrochloride" }, // 67
  { name: "Bromocriptine Mesylate" }, // 68
  { name: "Budesomde", aliases: ["budesonide"] }, // 69
  { name: "Bulaquine" }, // 70
  { name: "Bupivacaine Hydrochloride" }, // 71
  { name: "Bupropion" }, // 72
  { name: "Buspirone" }, // 73
  { name: "Butenafine Hydrochloride" }, // 74
  { name: "Butorphanol Tartrate" }, // 75
  { name: "Cabergoline" }, // 76
  { name: "Calciumdobesilate", aliases: ["calcium dobesilate"] }, // 77
  { name: "Candesartan" }, // 78
  { name: "Capecitabine" }, // 79
  { name: "Captopril" }, // 80
  { name: "Carbidopa" }, // 81
  { name: "Carbocisteine" }, // 82
  { name: "Carboplatin" }, // 83
  { name: "Carboquone" }, // 84
  { name: "Carisoprodol" }, // 85
  { name: "L-Camitine", aliases: ["levocarnitine", "l-carnitine"] }, // 86
  { name: "Carteolol Hydrochloride" }, // 87
  { name: "Carvedilol" }, // 88
  { name: "Cefadroxyl", aliases: ["cefadroxil"] }, // 89
  { name: "Cefatoxime Sodium", aliases: ["cefotaxime"] }, // 90
  { name: "Cefazolin Sodium" }, // 91
  { name: "Cefuroxime" }, // 99
  { name: "Celecoxib" }, // 100
  { name: "Centchroman", aliases: ["ormeloxifene"] }, // 101
  { name: "Centbutindole" }, // 102
  { name: "Centpropazine" }, // 103
  { name: "Cetirizine Hydrochloride", aliases: ["cetirizine"] }, // 104
  { name: "Chlormezanone" }, // 106
  { name: "Chlorpromazine" }, // 108
  { name: "Chlorzoxazone" }, // 109
  { name: "Ciclopirox Olamine" }, // 110
  { name: "Cimetidine" }, // 111
  { name: "Cinnarizine" }, // 112
  { name: "Ciprofloxacin Hydrochloride Monohydrate / Lactate" }, // 113
  { name: "Cisplatin" }, // 114
  { name: "Citalopram Hydrobromide" }, // 115
  { name: "Clarithromycin" }, // 116
  { name: "Clavulanic Acid" }, // 117
  { name: "Clidinium Bromide" }, // 118
  { name: "Clindamycin" }, // 119
  { name: "Clobazam" }, // 120
  { name: "Clobetasol Propenate", aliases: ["clobetasol propionate", "clobetasol"] }, // 121
  { name: "Clobetasone 17-Butyrate", aliases: ["clobetasone butyrate"], qualified: true, note: "printed as the 17-butyrate ester" }, // 122
  { name: "Clofibrate" }, // 124
  { name: "Clonazepam" }, // 125
  { name: "Clonidine Hydrochloride" }, // 126
  { name: "Clopamide" }, // 127
  { name: "Clopidogrel Bisulphate", aliases: ["clopidogrel"] }, // 128
  { name: "Clostebol Acetate" }, // 129
  { name: "Clotrimazole" }, // 130
  { name: "Clozapine" }, // 131
  { name: "Colchicine" }, // 133
  { name: "Corticosteroids", qualified: true, note: "CLASS ENTRY: every corticosteroid — cannot be matched by one substance name" }, // 134
  { name: "Cotrimoxazole", aliases: ["co-trimoxazole"], qualified: true, note: "a COMBINATION (sulfamethoxazole + trimethoprim), not a single substance" }, // 135
  { name: "Cyclandelate" }, // 136
  { name: "Cyclosporins", aliases: ["ciclosporin", "cyclosporine"] }, // 137
  { name: "Daclizumab" }, // 138
  { name: "Danazole", aliases: ["danazol"] }, // 139
  { name: "Dapsone" }, // 140
  { name: "Desloratadine" }, // 141
  { name: "Desogestrol", aliases: ["desogestrel"] }, // 142
  { name: "Dexrazoxane" }, // 143
  { name: "Dextranomer" }, // 144
  { name: "Dextropropoxyphene" }, // 146
  { name: "Diazoxide" }, // 148
  { name: "Diclofenac Sodium/Potassium/Acid" }, // 149
  { name: "Dicyclomin Hydrochloride", aliases: ["dicycloverine", "dicyclomine"] }, // 150
  { name: "Didanosine" }, // 151
  { name: "Digoxine", aliases: ["digoxin"] }, // 152
  { name: "Dilazep Hydrochloride" }, // 153
  { name: "Diltiazem" }, // 154
  { name: "Dinoprostone" }, // 155
  { name: "Dipivefrin Hydrochloride", aliases: ["dipivefrine"] }, // 157
  { name: "Di-sodium Pamidronate" }, // 158
  { name: "Disopyramide" }, // 159
  { name: "Docetaxel" }, // 160
  { name: "Domperidone" }, // 161
  { name: "Donepezil Hydrochloride" }, // 162
  { name: "Dopamine Hydrochloride" }, // 163
  { name: "Dothiepin Hydrochloride", aliases: ["dosulepin"] }, // 164
  { name: "Doxapram Hydrochloride" }, // 165
  { name: "Doxazosin Mesylate" }, // 166
  { name: "Doxepin Hydrochloride" }, // 167
  { name: "Doxorubicin Hydrochloride" }, // 168
  { name: "Drotrecogin-Alpha", aliases: ["drotrecogin alfa"] }, // 169
  { name: "Ebastine" }, // 170
  { name: "Econozole", aliases: ["econazole"] }, // 171
  { name: "Efavirenz" }, // 172
  { name: "Enalapril Meleate", aliases: ["enalapril"] }, // 173
  { name: "Enfenamic Acid" }, // 174
  { name: "Epinephrine", aliases: ["adrenaline"] }, // 175
  { name: "Epirubicine", aliases: ["epirubicin"] }, // 176
  { name: "Eptifibatide" }, // 177
  { name: "Ergot, Alkaloids of whether Hydrogenated or not, their Homologoues, Salts", qualified: true, note: "CLASS ENTRY: ergot alkaloids, hydrogenated or not, their homologues and salts" }, // 178
  { name: "Esomeprazole" }, // 179
  { name: "Estradiol Succinate" }, // 180
  { name: "Estramustine Phosphate" }, // 181
  { name: "Etanercept" }, // 182
  { name: "Ethacridine Lactate" }, // 183
  { name: "Ethamsylate", aliases: ["etamsylate"] }, // 185
  { name: "Ethinyloestradiol", aliases: ["ethinylestradiol"] }, // 186
  { name: "Etidronate Disodium" }, // 188
  { name: "Etodolac" }, // 189
  { name: "Etomidate" }, // 190
  { name: "Etoposide" }, // 191
  { name: "Exemestane" }, // 192
  { name: "Famciclovir" }, // 193
  { name: "Famotidine" }, // 194
  { name: "Fenbendazole" }, // 195
  { name: "Fenofibrate" }, // 196
  { name: "Fexofenadine" }, // 197
  { name: "Finasteride" }, // 198
  { name: "Flavoxate Hydrochloride" }, // 199
  { name: "5-Fluorouracil", aliases: ["fluorouracil"] }, // 200
  { name: "Fludarabine" }, // 201
  { name: "Flufenamic Acids", aliases: ["flufenamic acid"] }, // 202
  { name: "Flunarizine Hydrochloride" }, // 203
  { name: "Fluoxetine Hydrochloride" }, // 204
  { name: "Flupenthixol", aliases: ["flupentixol"] }, // 205
  { name: "Fluphenazine Enanthate and Decanoate", aliases: ["fluphenazine enanthate", "fluphenazine decanoate"], qualified: true, note: "printed as two named esters" }, // 206
  { name: "Flurazepam" }, // 207
  { name: "Flurbiprofen" }, // 208
  { name: "Flutamide" }, // 209
  { name: "Fluticasone Propionate" }, // 210
  { name: "Fluvoxamine Maleate" }, // 211
  { name: "Formestane" }, // 212
  { name: "Fosfestril Sodium" }, // 213
  { name: "Fosinopril Sodium" }, // 214
  { name: "Fossphenytoin Sodium", aliases: ["fosphenytoin"] }, // 215
  { name: "Fotemustine" }, // 216
  { name: "Gabapentin" }, // 217
  { name: "Galanthamine Hydrobromide", aliases: ["galantamine"] }, // 218
  { name: "Gallamine, its Salts, its Quaternary Compound", qualified: true, note: "gallamine, its salts and quaternary compound" }, // 219
  { name: "Gancyclovir", aliases: ["ganciclovir"] }, // 220
  { name: "Ganirelix" }, // 221
  { name: "Gatifloxacin" }, // 222
  { name: "Gemcitabine" }, // 223
  { name: "Gemfibrozil" }, // 224
  { name: "Gemtuzumab" }, // 225
  { name: "Genodeoxycholic Acid", aliases: ["chenodeoxycholic acid"] }, // 226
  { name: "Gliclazide" }, // 227
  { name: "Glimepiride" }, // 228
  { name: "Glucagon" }, // 229
  { name: "Glycopyrrolate", aliases: ["glycopyrronium"] }, // 230
  { name: "Glydiazinamide", aliases: ["glipizide"] }, // 231
  { name: "Goserelin Acetate" }, // 232
  { name: "Granisetron" }, // 233
  { name: "Guanethidine" }, // 234
  { name: "Gugulipid", aliases: ["guggulipid"] }, // 235
  { name: "Halogenated Hydroxyquinolines", qualified: true, note: "CLASS ENTRY: halogenated hydroxyquinolines (e.g. clioquinol, iodoquinol)" }, // 236
  { name: "Haloperidol" }, // 237
  { name: "Heparin" }, // 238
  { name: "Hepatitis B. Vaccine", qualified: true, note: "a vaccine, not a small-molecule substance" }, // 239
  { name: "Hyaluronidase" }, // 240
  { name: "Hydrocorisone 17-Butyrate", aliases: ["hydrocortisone butyrate", "hydrocortisone 17-butyrate"], qualified: true, note: "printed as the 17-butyrate ester; hydrocortisone itself falls under entry 134 (Corticosteroids)" }, // 241
  { name: "Hydrotalcite" }, // 242
  { name: "Hydroxizine", aliases: ["hydroxyzine"] }, // 243
  { name: "Ibuprofen" }, // 244
  { name: "Idebenone" }, // 245
  { name: "Iindapamide", aliases: ["indapamide"] }, // 246
  { name: "Imipramine" }, // 247
  { name: "Indinavir Sulphate" }, // 248
  { name: "Indomethacin" }, // 249
  { name: "Insulin Human" }, // 250
  { name: "Interferon" }, // 251
  { name: "Intravenous Fat Emulsion", qualified: true, note: "restricted to the intravenous preparation" }, // 252
  { name: "Iobitridol" }, // 253
  { name: "Iohexol" }, // 254
  { name: "Iopamidol" }, // 255
  { name: "Iomeprol" }, // 256
  { name: "Iopromide" }, // 257
  { name: "Irbesartan" }, // 258
  { name: "Irinotecan Hydrochloride" }, // 259
  { name: "Iron Preparation for Parenteral use", qualified: true, note: "restricted to PARENTERAL iron preparations; oral iron is not covered by this entry" }, // 260
  { name: "Isepamicine", aliases: ["isepamicin"] }, // 261
  { name: "Isocarboxside", aliases: ["isocarboxazid"] }, // 262
  { name: "Isoflurane" }, // 263
  { name: "Isonicotnic Acid Hydrazine and other Hydragine Derivatives of Isonicotinic Acid", aliases: ["isoniazid"], qualified: true, note: "CLASS ENTRY: isonicotinic acid hydrazide and its hydrazine derivatives (isoniazid is also Schedule H1 since 2014)" }, // 264
  { name: "Isosorbide Dinitrate/Mononitrate", aliases: ["isosorbide dinitrate", "isosorbide mononitrate"] }, // 265
  { name: "Isotretinoin" }, // 266
  { name: "Isoxsuprine" }, // 267
  { name: "Itopride" }, // 268
  { name: "Ketoconazole" }, // 270
  { name: "Ketoprofen" }, // 271
  { name: "Ketorolac Tromethamine" }, // 272
  { name: "Labetalol Hydrochloride" }, // 273
  { name: "Lacidipine" }, // 274
  { name: "Lamivudine" }, // 275
  { name: "Lamotrigine" }, // 276
  { name: "Latanoprost" }, // 277
  { name: "Lefunomide", aliases: ["leflunomide"] }, // 278
  { name: "Lercanidipine Hydrochloride" }, // 279
  { name: "Letrozole" }, // 280
  { name: "Leuprolide Acetate" }, // 281
  { name: "Levamesole", aliases: ["levamisole"] }, // 282
  { name: "Levarterenol", aliases: ["norepinephrine", "noradrenaline"] }, // 283
  { name: "Levobunolol" }, // 284
  { name: "Levocetirizine" }, // 285
  { name: "Levodopa" }, // 286
  { name: "Levovist", note: "a proprietary ultrasound contrast agent (galactose microparticles); no INN" }, // 288
  { name: "Lidoflazine" }, // 289
  { name: "Linezplid", aliases: ["linezolid"] }, // 290
  { name: "Lithium Carbonate" }, // 291
  { name: "Lofepramine Decanoate" }, // 292
  { name: "Loperamide" }, // 293
  { name: "Lorazepam" }, // 294
  { name: "Losartan Potassium" }, // 295
  { name: "Loteprednol" }, // 296
  { name: "Lovastatin" }, // 297
  { name: "Loxapine" }, // 298
  { name: "Mebendazole" }, // 299
  { name: "Mebeverine Hydrochloride" }, // 300
  { name: "Medroxy Progesterone Acetate", aliases: ["medroxyprogesterone"] }, // 301
  { name: "Mefenamic Acid" }, // 302
  { name: "Mefloquine Hydrochloride" }, // 303
  { name: "Megestrol Acetate" }, // 304
  { name: "Meglumine Iocarmate" }, // 305
  { name: "Melagenina", note: "a placental-extract preparation (vitiligo); no INN" }, // 306
  { name: "Melitracen Hydrochloride" }, // 307
  { name: "Meloxicam" }, // 308
  { name: "Mephenesin, its Esters", qualified: true, note: "mephenesin and its esters" }, // 309
  { name: "Mephentermine" }, // 310
  { name: "Mesterolone" }, // 312
  { name: "Metaxalone" }, // 313
  { name: "Methicillin Sodium" }, // 314
  { name: "Methocarbamol" }, // 315
  { name: "Methotraxate", aliases: ["methotrexate"] }, // 316
  { name: "Metoclopramide" }, // 317
  { name: "Metoprolol Tartrate" }, // 318
  { name: "Metrizamide" }, // 319
  { name: "Metronidazole" }, // 320
  { name: "Mexiletine Hydrochloride" }, // 321
  { name: "Mianserin Hydrochloride" }, // 322
  { name: "Miconazole" }, // 323
  { name: "Mifepristone" }, // 325
  { name: "Milrinone Lactate" }, // 326
  { name: "Miltefosine" }, // 327
  { name: "Minocycline" }, // 328
  { name: "Minoxidil" }, // 329
  { name: "Mirtazapine" }, // 330
  { name: "Misoprostol" }, // 331
  { name: "Mitoxantrone Hydrochloride" }, // 332
  { name: "Mizolastine" }, // 333
  { name: "Moclobemide" }, // 334
  { name: "Mometasone Furoate" }, // 335
  { name: "Monteiukast Sodium", aliases: ["montelukast"] }, // 336
  { name: "Morphazinamide Hydrochloride" }, // 337
  { name: "Mosapride" }, // 338
  { name: "Mycophenolate Mofetil" }, // 340
  { name: "Nadifloxacin" }, // 341
  { name: "Nadolol" }, // 342
  { name: "Nafarelin Acetate" }, // 343
  { name: "Nalidixic Acid" }, // 344
  { name: "Naproxen" }, // 345
  { name: "Narcotic Drugs listed in Narcotic Drugs & Psychotropic Substances Act, 1985", qualified: true, note: "CLASS ENTRY: every narcotic drug listed under the NDPS Act 1985 — needs the NDPS list, not a name match" }, // 346
  { name: "Natamycin" }, // 347
  { name: "Nateglinide" }, // 348
  { name: "N-butyI-2-cyanoacrylate" }, // 349
  { name: "Nebivolol" }, // 350
  { name: "Nebumetone", aliases: ["nabumetone"] }, // 351
  { name: "Nelfinavir Mesilate" }, // 352
  { name: "Netilmicin Sulphate" }, // 353
  { name: "Nevirapine" }, // 354
  { name: "Nicergoline" }, // 355
  { name: "Nicorandil" }, // 356
  { name: "Nifedipine" }, // 357
  { name: "Nimesulide" }, // 358
  { name: "Nimustine Hydrochloride" }, // 359
  { name: "Nitroglycerin", aliases: ["glyceryl trinitrate"] }, // 361
  { name: "Noreth Isterone Enanthate", aliases: ["norethisterone enantate", "norethisterone"] }, // 362
  { name: "Norfloxacin" }, // 363
  { name: "Octylonium Biomiae", aliases: ["otilonium bromide", "otilonium"] }, // 364
  { name: "Ofloxacin" }, // 365
  { name: "Olanzapine" }, // 366
  { name: "Omeprazole" }, // 367
  { name: "Omidazole", aliases: ["ornidazole"] }, // 368
  { name: "Orphenadrine" }, // 369
  { name: "Orthoclone Sterile", aliases: ["muromonab-cd3"] }, // 370
  { name: "Oxazepam" }, // 371
  { name: "Oxazolidine" }, // 372
  { name: "Oxcarbazepine" }, // 373
  { name: "Oxethazaine Hydrochlorid", aliases: ["oxetacaine", "oxethazaine"] }, // 374
  { name: "Oxiconazole" }, // 375
  { name: "Oxolinic Acid" }, // 376
  { name: "Oxprenolol Hydrochloride" }, // 377
  { name: "Oxybutynin Chloride" }, // 378
  { name: "Oxyfedrine" }, // 379
  { name: "Oxymetazoline" }, // 380
  { name: "Oxyphenbutazone" }, // 381
  { name: "Ozothine", note: "a proprietary terpene/expectorant preparation; no INN" }, // 383
  { name: "Paclitaxel" }, // 384
  { name: "Pancuronium Bromide" }, // 385
  { name: "Pantopiazole", aliases: ["pantoprazole"] }, // 386
  { name: "Para-Amino Benzene Sulphonamide, its Salts & Derivatives", qualified: true, note: "CLASS ENTRY: sulfanilamide and its derivatives (the sulphonamides)" }, // 387
  { name: "Parp-Amino Salicylic Acid, its Salts, its Derivatives", aliases: ["para-aminosalicylic acid"], qualified: true, note: "CLASS ENTRY as printed (\"Parp-\" is the printed typo for \"Para-\"): para-aminosalicylic acid, its salts and derivatives" }, // 388
  { name: "Parecoxib" }, // 389
  { name: "Paroxetine Hydrochloride" }, // 390
  { name: "D-Penicillamine", aliases: ["penicillamine"] }, // 391
  { name: "Pentoxifylline" }, // 393
  { name: "Pepleomycin" }, // 394
  { name: "Phenelzineh Sulphate", aliases: ["phenelzine"] }, // 395
  { name: "Phenobarbital" }, // 396
  { name: "Phenothiazine, Derivatives of and Salts of its Derivatives", qualified: true, note: "CLASS ENTRY: phenothiazine derivatives (e.g. chlorpromazine, promethazine) — cannot be matched by one substance name" }, // 397
  { name: "Phenylbutazine", aliases: ["phenylbutazone"] }, // 398
  { name: "Pimozide" }, // 399
  { name: "Pindolol" }, // 400
  { name: "Pioglitazone Hydrochloride" }, // 401
  { name: "Piracetam" }, // 402
  { name: "Piroxicam" }, // 403
  { name: "Pituitary Gland, Active Principles of, not otherwise specified in this Schedule and their Salts", qualified: true, note: "CLASS ENTRY: pituitary active principles not otherwise specified" }, // 404
  { name: "Polidocanol" }, // 405
  { name: "Polyestradiol Phosphate" }, // 406
  { name: "Poractant Alfa" }, // 407
  { name: "Praziquantel" }, // 408
  { name: "Pred nimustine", aliases: ["prednimustine"] }, // 409
  { name: "Prednisolone Stearoylglycoiate", aliases: ["prednisolone steaglate"] }, // 410
  { name: "Prenoxdiazin Hydrochloride", aliases: ["prenoxdiazine"] }, // 411
  { name: "Promazine Hydrochloride" }, // 412
  { name: "Promegestone" }, // 413
  { name: "Propafenon Hydrochloride", aliases: ["propafenone"] }, // 414
  { name: "Propanolol Hydrochloride", aliases: ["propranolol"] }, // 415
  { name: "Propofol" }, // 416
  { name: "Protristyline Hydrochloride", aliases: ["protriptyline"] }, // 417
  { name: "Pyrvinium" }, // 419
  { name: "Quetiapine Fumerate", aliases: ["quetiapine"] }, // 420
  { name: "Quinapril" }, // 421
  { name: "Quiniaine Sulphate", aliases: ["quinidine sulfate", "quinidine"], note: "UNSURE: printed \"Quiniaine\" — read as quinidine sulphate (the nearest real substance; quinine is not otherwise in Schedule H); a person should confirm" }, // 422
  { name: "Rabeprazole" }, // 423
  { name: "Racecadotril" }, // 424
  { name: "Raloxifene Hydrochloride" }, // 425
  { name: "Ramipril Hydrochloride" }, // 426
  { name: "Ranitidine" }, // 427
  { name: "Rauwolfia, Alkaloids of, their Salts, Derivatives of the Alkaloids or Rauwolfia", aliases: ["rauwolfia alkaloid", "rauwolfia"], qualified: true, note: "CLASS ENTRY: rauwolfia alkaloids and their derivatives (e.g. reserpine)" }, // 428
  { name: "Reboxetine" }, // 429
  { name: "Repaglinide" }, // 430
  { name: "Reproterol Hydrochloride" }, // 431
  { name: "Rilmenidine" }, // 432
  { name: "Riluzone", aliases: ["riluzole"] }, // 433
  { name: "Risperidone" }, // 434
  { name: "Ritonavir" }, // 435
  { name: "Ritodrine hydrochloride" }, // 436
  { name: "Rituximab" }, // 437
  { name: "Rivastigmine" }, // 438
  { name: "Rocuronium bromide" }, // 439
  { name: "Ropinirole" }, // 440
  { name: "Rosoxacin", aliases: ["rosoxacin"] }, // 441
  { name: "Rosiglitazone meleate", aliases: ["rosiglitazone"] }, // 442
  { name: "Salbutamol sulphate" }, // 443
  { name: "Salicyl-azo-sulphapyridine", aliases: ["sulfasalazine", "sulphasalazine"] }, // 444
  { name: "Salmon calcitonin", aliases: ["calcitonin (salmon)", "calcitonin"] }, // 445
  { name: "Saquinavir" }, // 446
  { name: "Satranidazole" }, // 447
  { name: "Secnidazole" }, // 448
  { name: "Septopal beads & chains", qualified: true, note: "a device (gentamicin-PMMA beads), not a substance" }, // 449
  { name: "Serratiopeptidase", aliases: ["serrapeptase"] }, // 450
  { name: "Sertraline hydrochloride" }, // 451
  { name: "Sibutramine hydrochloride" }, // 452
  { name: "Sildenafil citrate" }, // 453
  { name: "Simvastatin" }, // 454
  { name: "Sirolimus" }, // 455
  { name: "Sisomicin sulphate" }, // 456
  { name: "S-neominophagen", note: "UNSURE: a proprietary glycyrrhizin preparation (\"Stronger Neo-Minophagen C\"); no INN — left unaliased" }, // 457
  { name: "Sodiumpico sulphate", aliases: ["sodium picosulfate"] }, // 458
  { name: "Sodium cromoglycate", aliases: ["cromoglicic acid", "cromoglicate sodium"] }, // 459
  { name: "Sodium hyaluronate" }, // 460
  { name: "Sodium valproate", aliases: ["valproic acid", "valproate"] }, // 461
  { name: "Sodium and maglumine iothalamates", aliases: ["iotalamic acid", "meglumine iotalamate", "sodium iotalamate"] }, // 462
  { name: "Somatostatin" }, // 463
  { name: "Somatotropin", aliases: ["somatropin"] }, // 464
  { name: "Sotalol" }, // 465
  { name: "Spectinomycin hydrochloride" }, // 467
  { name: "Spironolactone" }, // 468
  { name: "Stavudine" }, // 469
  { name: "Sucralfate" }, // 470
  { name: "Sulphadoxine", aliases: ["sulfadoxine"] }, // 471
  { name: "Sulphamethoxine", note: "UNSURE: printed \"Sulphamethoxine\" — no INN of that spelling; possibly sulfadimethoxine or sulfamethoxydiazine; left unaliased" }, // 472
  { name: "Sulphamethoxypyridazine", aliases: ["sulfamethoxypyridazine"] }, // 473
  { name: "Sulphaphenazole", aliases: ["sulfaphenazole"] }, // 474
  { name: "Sulpiride" }, // 475
  { name: "Sulprostone hydrochloride" }, // 476
  { name: "Sumatriptan" }, // 477
  { name: "Tacrine hydrochloride" }, // 478
  { name: "Tamsulosin hydrochloride" }, // 479
  { name: "Trapidil" }, // 480
  { name: "Tegaserod maleate" }, // 481
  { name: "Teicoplanin" }, // 482
  { name: "Telmisartan" }, // 483
  { name: "Temozolamide", aliases: ["temozolomide"] }, // 484
  { name: "Terazosin" }, // 485
  { name: "Terbutaline sulphate" }, // 486
  { name: "Terfenadine" }, // 487
  { name: "Terizidone" }, // 488
  { name: "Terlipressin" }, // 489
  { name: "Testosteroneun decoanoate", aliases: ["testosterone undecanoate"] }, // 490
  { name: "Teratolol hydrochloride", aliases: ["tertatolol"] }, // 491
  { name: "Thalidomide" }, // 492
  { name: "Thiocolchicoside" }, // 494
  { name: "Thiopropazate, its salts", qualified: true, note: "thiopropazate and its salts" }, // 495
  { name: "Thymogene", note: "a proprietary thymus preparation; no INN" }, // 496
  { name: "Thymosin-alpha1" }, // 497
  { name: "Tiaprofenic acid" }, // 498
  { name: "Tibolone" }, // 499
  { name: "Timolol maleate" }, // 500
  { name: "Tinidazole" }, // 501
  { name: "Tizanidine" }, // 502
  { name: "Tabramycin", aliases: ["tobramycin"] }, // 503
  { name: "Tolfenamic acid" }, // 504
  { name: "Topiramate" }, // 505
  { name: "Topotecan hydrochloride" }, // 506
  { name: "Tranexamic acid" }, // 508
  { name: "Tranylcypromine, its salts", qualified: true, note: "tranylcypromine and its salts" }, // 509
  { name: "Trazodone" }, // 510
  { name: "Tretinoin" }, // 511
  { name: "Trifluperazine", aliases: ["trifluoperazine"] }, // 512
  { name: "Trifluperidol hydrochloride" }, // 513
  { name: "Triflusal" }, // 514
  { name: "Trimetazidine dihydrochloride" }, // 515
  { name: "Trimipramine" }, // 516
  { name: "Tripotassium dicitrate bismuthate", aliases: ["tripotassium dicitratobismuthate", "bismuth subcitrate potassium"] }, // 517
  { name: "Tromantadine hydrochloride" }, // 518
  { name: "Urokinase" }, // 519
  { name: "Valsartan" }, // 520
  { name: "Vasopressin" }, // 521
  { name: "Vecuronium bromide" }, // 522
  { name: "Venlafaxine hydrochloride" }, // 523
  { name: "Verapamil hydrochloride" }, // 524
  { name: "Verteporfin" }, // 525
  { name: "Vincristine sulphate" }, // 526
  { name: "Vinblastine sulphate" }, // 527
  { name: "Vindesine sulphate" }, // 528
  { name: "Vinorelbine tatrate", aliases: ["vinorelbine"] }, // 529
  { name: "Xipamide" }, // 530
  { name: "Zidovudine hydrochloride" }, // 531
  { name: "Ziprasidone hydrochloride" }, // 532
  { name: "Zoledronic acid" }, // 533
  { name: "Zopiclone" }, // 535
  { name: "Zuclopenthixol" }, // 536
  { name: "Etizolam", note: "inserted by G.S.R. 303(E), 30 March 2017" }, // 537
  { name: "Alclometasone", note: "inserted by G.S.R. 277(E), 23 March 2018 (topical steroids)" }, // 538
  { name: "Beclomethasone", aliases: ["beclometasone"], note: "inserted by G.S.R. 277(E), 23 March 2018 (topical steroids)" }, // 539
  { name: "Betamethasone", note: "inserted by G.S.R. 277(E), 23 March 2018 (topical steroids)" }, // 540
  { name: "Desonide", note: "inserted by G.S.R. 277(E), 23 March 2018 (topical steroids)" }, // 541
  { name: "Desoximetasone", note: "inserted by G.S.R. 277(E), 23 March 2018 (topical steroids)" }, // 542
  { name: "Dexamethasone", note: "inserted by G.S.R. 277(E), 23 March 2018 (topical steroids)" }, // 543
  { name: "Diflorasone diacetate", note: "inserted by G.S.R. 277(E), 23 March 2018 (topical steroids)" }, // 544
  { name: "Fluocinonide", note: "inserted by G.S.R. 277(E), 23 March 2018 (topical steroids)" }, // 545
  { name: "Huocinolone acetonide", aliases: ["fluocinolone acetonide", "fluocinolone"], note: "inserted by G.S.R. 277(E), 23 March 2018 (topical steroids)" }, // 546
  { name: "Halobetasol propionate", note: "inserted by G.S.R. 277(E), 23 March 2018 (topical steroids)" }, // 547
  { name: "Halometasone", note: "inserted by G.S.R. 277(E), 23 March 2018 (topical steroids)" }, // 548
  { name: "Methylprednisone", aliases: ["methylprednisolone"], note: "UNSURE: printed \"Methylprednisone\" (no such INN) — aliased to methylprednisolone, the evident intent in the 2018 topical-steroid insertion; inserted by G.S.R. 277(E), 23 March 2018 (topical steroids)" }, // 549
  { name: "Prednicarbate", note: "inserted by G.S.R. 277(E), 23 March 2018 (topical steroids)" }, // 550
  { name: "Triamcinolone acetonide", note: "inserted by G.S.R. 277(E), 23 March 2018 (topical steroids)" }, // 551
  { name: "Acitretin", note: "inserted by G.S.R. 357(E), 18 May 2022 (w.e.f. 1 November 2022)" }, // 552
];
