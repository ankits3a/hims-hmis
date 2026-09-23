/**
 * ═══ THE BRANDS AN INDIAN OPD COUNTER ACTUALLY STOCKS ═══
 *
 * BASIS: common OPD brands in North-Indian corporate hospital practice — a REVIEWED LIST, NOT MARKET
 * DATA (coordinator's correction to PR #294, 2026-09-22). The owner's ruling asks that the pharmacist see
 * the brand doctors actually write: "Dolo 650", "Pan 40", "Telma 40" — not whichever brand of the right
 * molecule a manufacturer-rank rule happened to reach. No sales figure is claimed for any line.
 *
 * Each entry is one generic + strength + form, with the preferred brand first and one or two fallbacks.
 * Every brand is written as the catalogue's FULL `formulary_medicines.brand_name` string (checked
 * against the 103,383-row catalogue on 2026-09-22), so the composition, strength and form are part of
 * the match and a brand of the right name but the wrong strength cannot be picked. The first brand the
 * target database holds wins; an entry none of whose brands is held is REPORTED by the starter-list
 * builder, never silently replaced.
 *
 * Entries whose brands the catalogue does not hold at all (measured 2026-09-22) are kept, so the report
 * names them: Becosules, Zincovit, Limcee, Shelcal 500 tablet, Calcimax, Livogen, Evion 400, Nurokind.
 * Ranitidine is deliberately absent — withdrawn in India.
 */
export type OpdCommonBrand = {
  /** What a pharmacist calls it, e.g. "Paracetamol 650 mg tablet". */
  label: string;
  /** Catalogue brand_name strings, preferred first. */
  brands: readonly string[];
};

export const OPD_COMMON_BRANDS: readonly OpdCommonBrand[] = [
  // ── analgesics, antipyretics ──
  { label: "Paracetamol 650 mg tablet", brands: ["Dolo (paracetamol) 650 mg oral tablet", "Crocin (paracetamol) 650 mg oral tablet", "Calpol (paracetamol) 650 mg oral tablet"] },
  { label: "Paracetamol 500 mg tablet", brands: ["Crocin (paracetamol) 500 mg oral tablet", "Calpol (paracetamol) 500 mg oral tablet", "Dolo (paracetamol) 500 mg oral tablet"] },
  { label: "Paracetamol 250 mg/5 mL suspension", brands: ["Calpol (paracetamol) 250 mg/5 mL oral suspension", "Dolo (paracetamol) 250 mg/5 mL oral suspension"] },
  { label: "Paracetamol 120 mg/5 mL suspension", brands: ["Crocin (paracetamol) 120 mg/5 mL oral suspension", "Calpol (paracetamol) 120 mg/5 mL oral suspension"] },
  { label: "Paracetamol 100 mg/mL drops", brands: ["Crocin Baby Drops (paracetamol) 100 mg/1 mL oral suspension", "Calpol Paediatric Drops (paracetamol) 100 mg/1 mL oral suspension"] },
  { label: "Ibuprofen 400 mg tablet", brands: ["Brufen (ibuprofen) 400 mg oral tablet"] },
  { label: "Ibuprofen + paracetamol 400/325 mg tablet", brands: ["Combiflam (ibuprofen and paracetamol) 400 mg + 325 mg oral tablet"] },
  { label: "Ibuprofen + paracetamol suspension", brands: ["Combiflam (ibuprofen and paracetamol) 100 mg/5 mL + 162.5 mg/5 mL oral suspension", "Brufen P Junior (ibuprofen and paracetamol) 100 mg/5 mL + 162.5 mg/5 mL oral suspension"] },
  { label: "Aceclofenac + paracetamol 100/325 mg tablet", brands: ["Zerodol-P (aceclofenac and paracetamol) 100 mg + 325 mg oral tablet", "Hifenac-P (aceclofenac and paracetamol) 100 mg + 325 mg oral tablet"] },
  { label: "Aceclofenac 100 mg tablet", brands: ["Zerodol (aceclofenac) 100 mg oral tablet", "Hifenac (aceclofenac) 100 mg oral tablet"] },
  { label: "Diclofenac sodium 50 mg tablet", brands: ["Voveran (diclofenac sodium) 50 mg oral tablet"] },
  { label: "Diclofenac gel", brands: ["Voveran Emulgel (diclofenac diethylammonium) 11.6 mg/1 g cutaneous gel"] },
  { label: "Mefenamic acid 500 mg tablet", brands: ["Meftal (mefenamic acid) 500 mg oral tablet"] },
  { label: "Dicyclomine + mefenamic acid 10/250 mg tablet", brands: ["Meftal-Spas (dicycloverine hydrochloride and mefenamic acid) 10 mg + 250 mg oral tablet", "Cyclopam MF (dicycloverine hydrochloride and mefenamic acid) 10 mg + 250 mg oral tablet"] },
  { label: "Dicyclomine + paracetamol 20/500 mg tablet", brands: ["Cyclopam (dicycloverine hydrochloride and paracetamol) 20 mg + 500 mg oral tablet"] },
  { label: "Tramadol + paracetamol 37.5/325 mg tablet", brands: ["Ultracet (paracetamol and tramadol) 325 mg + 37.5 mg oral tablet"] },
  // ── gastro ──
  { label: "Pantoprazole 40 mg tablet", brands: ["Pan (pantoprazole sodium) 40 mg gastro-resistant oral tablet", "Pantocid (pantoprazole sodium) 40 mg gastro-resistant oral tablet"] },
  { label: "Pantoprazole + domperidone SR capsule", brands: ["Pan-D (domperidone and pantoprazole sodium) 30 mg + 40 mg gastro-resistant and prolonged-release oral capsule", "Pantocid DSR (domperidone and pantoprazole sodium) 30 mg + 40 mg gastro-resistant and prolonged-release oral capsule"] },
  { label: "Rabeprazole 20 mg tablet", brands: ["Razo (rabeprazole sodium) 20 mg gastro-resistant oral tablet", "Rablet (rabeprazole sodium) 20 mg gastro-resistant oral tablet"] },
  { label: "Rabeprazole + domperidone SR capsule", brands: ["Razo-D (domperidone and rabeprazole sodium) 30 mg + 20 mg gastro-resistant and prolonged-release oral capsule", "Rablet D (domperidone and rabeprazole sodium) 30 mg + 20 mg gastro-resistant and prolonged-release oral capsule"] },
  { label: "Omeprazole 20 mg capsule", brands: ["Omez (omeprazole) 20 mg gastro-resistant oral capsule", "Omez (omeprazole) 20 mg oral capsule"] },
  { label: "Ondansetron 4 mg tablet", brands: ["Emeset (ondansetron hydrochloride) 4 mg oral tablet", "Ondem (ondansetron hydrochloride) 4 mg oral tablet"] },
  { label: "Ondansetron 4 mg mouth-dissolving tablet", brands: ["Ondem -MD (ondansetron hydrochloride) 4 mg orodispersible tablet", "Emeset (ondansetron hydrochloride) 4 mg orodispersible tablet"] },
  { label: "Ondansetron 2 mg/5 mL syrup", brands: ["Emeset (ondansetron) 2 mg/5 mL oral solution", "Ondem (ondansetron) 2 mg/5 mL oral solution"] },
  { label: "Domperidone 10 mg tablet", brands: ["Domstal (domperidone maleate) 10 mg oral tablet"] },
  { label: "Domperidone 1 mg/mL suspension", brands: ["Domstal (domperidone) 1 mg/1 mL oral suspension"] },
  { label: "Metronidazole 400 mg tablet", brands: ["Metrogyl (metronidazole) 400 mg oral tablet", "Flagyl (metronidazole) 400 mg oral tablet"] },
  { label: "Metronidazole 200 mg/5 mL suspension", brands: ["Metrogyl (metronidazole benzoate) 200 mg/5 mL oral suspension", "Flagyl (metronidazole benzoate) 200 mg/5 mL oral suspension"] },
  { label: "Ofloxacin + ornidazole 200/500 mg tablet", brands: ["O2 (ofloxacin and ornidazole) 200 mg + 500 mg oral tablet"] },
  { label: "ORS sachet (WHO)", brands: ["Electral (glucose and potassium chloride and sodium chloride and sodium citrate) 13.5 g/1 sachet + 1.5 g/1 sachet + 2.6 g/1 sachet + 2.9 g/1 sachet powder for oral solution", "Ors (glucose and potassium chloride and sodium chloride and sodium citrate) 13.5 g/1 sachet + 1.5 g/1 sachet + 2.6 g/1 sachet + 2.9 g/1 sachet powder for oral solution"] },
  { label: "Antacid gel", brands: ["Digene (carmellose sodium and dried aluminium hydroxide gel and magnesium hydroxide and simeticone) 100 mg/10 mL + 830 mg/10 mL + 185 mg/10 mL + 50 mg/10 mL oral gel", "Gelusil MPS (aluminium hydroxide and dimeticone and magnesium hydroxide and sorbitol) 250 mg/5 ml + 50 mg/5 ml + 250 mg/5 ml + 1.25 g/5 ml oral gel"] },
  { label: "Antacid chewable tablet", brands: ["Gelusil MPS (activated attapulgite and aluminium hydroxide and magnesium hydroxide and simeticone) 50 mg + 250 mg + 250 mg + 50 mg chewable tablet"] },
  { label: "Lactulose solution", brands: ["Duphalac (lactulose) 3.335 g/5 mL oral solution"] },
  { label: "Bisacodyl 5 mg tablet", brands: ["Dulcolax (bisacodyl) 5 mg oral tablet"] },
  { label: "Ursodeoxycholic acid 300 mg tablet", brands: ["Udiliv (ursodeoxycholic acid) 300 mg oral tablet"] },
  // ── anti-infectives ──
  { label: "Azithromycin 500 mg tablet", brands: ["Azithral (azithromycin) 500 mg oral tablet", "Azee (azithromycin) 500 mg oral tablet"] },
  { label: "Azithromycin 250 mg tablet", brands: ["Azithral (azithromycin) 250 mg oral tablet", "Azee (azithromycin) 250 mg oral tablet"] },
  { label: "Azithromycin 200 mg/5 mL syrup", brands: ["Azithral (azithromycin) 200 mg/5 mL oral syrup", "Azee (azithromycin) 200 mg/5 mL oral syrup"] },
  { label: "Amoxicillin + clavulanate 625 mg tablet", brands: ["Augmentin DUO (amoxicillin and clavulanate potassium) 500 mg + 125 mg oral tablet", "Moxikind-CV (amoxicillin and clavulanate potassium) 500 mg + 125 mg oral tablet"] },
  { label: "Amoxicillin + clavulanate 228.5 mg/5 mL dry syrup", brands: ["Moxikind-CV (amoxicillin and clavulanic acid) 200 mg/5 ml + 28.5 mg/5 ml powder for oral syrup", "Novamox-CV (amoxicillin and clavulanic acid) 200 mg/5 ml + 28.5 mg/5 ml powder for oral syrup"] },
  { label: "Amoxicillin 500 mg capsule", brands: ["Mox (amoxicillin) 500 mg oral capsule", "Novamox (amoxicillin) 500 mg oral capsule"] },
  { label: "Cefixime 200 mg tablet", brands: ["Taxim-O (cefixime) 200 mg oral tablet", "Zifi (cefixime) 200 mg oral tablet"] },
  { label: "Cefixime 50 mg/5 mL suspension", brands: ["Taxim O (cefixime) 50 mg/5 ml oral suspension", "Zifi (cefixime) 50 mg/5 mL oral suspension"] },
  { label: "Ciprofloxacin 500 mg tablet", brands: ["Ciplox (ciprofloxacin hydrochloride) 500 mg oral tablet"] },
  { label: "Clotrimazole 1% cream", brands: ["Candid (clotrimazole) 10 mg/1 g cutaneous cream"] },
  { label: "Mupirocin 2% ointment", brands: ["T-Bact (mupirocin) 20 mg/1 g cutaneous ointment"] },
  { label: "Silver sulfadiazine 1% cream", brands: ["Silverex (silver sulfadiazine) 10 mg/1 g cutaneous cream"] },
  { label: "Povidone iodine 5% ointment", brands: ["Betadine (povidone iodine) 50 mg/1 g cutaneous ointment"] },
  // ── allergy, respiratory, cough ──
  { label: "Cetirizine 10 mg tablet", brands: ["Cetzine (cetirizine hydrochloride) 10 mg oral tablet", "Okacet (cetirizine hydrochloride) 10 mg oral tablet"] },
  { label: "Cetirizine 5 mg/5 mL syrup", brands: ["Cetzine (cetirizine) 5 mg/5 mL oral syrup", "Okacet (cetirizine) 5 mg/5 mL oral syrup"] },
  { label: "Levocetirizine 5 mg tablet", brands: ["Levocet (levocetirizine dihydrochloride) 5 mg oral tablet", "Xyzal (levocetirizine dihydrochloride) 5 mg oral tablet"] },
  { label: "Montelukast + levocetirizine 10/5 mg tablet", brands: ["Montair LC (levocetirizine dihydrochloride and montelukast sodium) 5 mg + 10 mg oral tablet", "Levocet M (levocetirizine dihydrochloride and montelukast sodium) 5 mg + 10 mg oral tablet"] },
  { label: "Montelukast + levocetirizine kid syrup", brands: ["Montair LC Kid (levocetirizine dihydrochloride and montelukast sodium) 2.5 mg/5 ml + 4 mg/5 ml oral syrup", "Levocet M (levocetirizine dihydrochloride and montelukast sodium) 2.5 mg/5 ml + 4 mg/5 ml oral syrup"] },
  { label: "Fexofenadine 120 mg tablet", brands: ["Allegra (fexofenadine) 120 mg oral tablet"] },
  { label: "Salbutamol 100 mcg inhaler", brands: ["Asthalin (salbutamol sulfate) 100 mcg/actuation pressurized suspension for inhalation"] },
  { label: "Budesonide + formoterol 200/6 inhaler", brands: ["Foracort (budesonide and formoterol fumarate) 200 mcg/actuation + 6 mcg/actuation pressurized solution for inhalation"] },
  { label: "Levosalbutamol + ambroxol + guaifenesin syrup (adult)", brands: ["Ascoril LS (ambroxol hydrochloride and guaifenesin and levosalbutamol sulfate) 30 mg/5 ml + 50 mg/5 ml + 1 mg/5 ml oral syrup", "Grilinctus-LS (ambroxol hydrochloride and guaifenesin and levosalbutamol sulfate) 30 mg/5 ml + 50 mg/5 ml + 1 mg/5 ml oral syrup", "Alex LS (ambroxol hydrochloride and guaifenesin and levosalbutamol sulfate) 30 mg/5 ml + 50 mg/5 ml + 1 mg/5 ml oral syrup"] },
  { label: "Levosalbutamol + ambroxol + guaifenesin junior syrup", brands: ["Ascoril LS Junior (ambroxol hydrochloride and guaifenesin and levosalbutamol sulfate) 15 mg/5 ml + 50 mg/5 ml + 500 mcg/5 ml oral syrup"] },
  { label: "Ambroxol + guaifenesin syrup", brands: ["Benadryl CR (ambroxol hydrochloride and guaifenesin) 15 mg/5 ml + 100 mg/5 ml oral syrup"] },
  { label: "Dextromethorphan + chlorphenamine syrup", brands: ["Grilinctus DX (chlorphenamine maleate and dextromethorphan hydrobromide) 2 mg/5 ml + 10 mg/5 ml oral syrup"] },
  { label: "Xylometazoline 0.1% nasal drops", brands: ["Otrivin-Adult (xylometazoline hydrochloride) 1 mg/1 mL nasal drops"] },
  // ── cardio-metabolic ──
  { label: "Telmisartan 40 mg tablet", brands: ["Telma (telmisartan) 40 mg oral tablet"] },
  { label: "Telmisartan + amlodipine 40/5 mg tablet", brands: ["Telma-AM (amlodipine besilate and telmisartan) 5 mg + 40 mg oral tablet"] },
  { label: "Telmisartan + hydrochlorothiazide 40/12.5 mg tablet", brands: ["Telma-H (hydrochlorothiazide and telmisartan) 12.5 mg + 40 mg oral tablet", "Telma H (hydrochlorothiazide and telmisartan) 12.5 mg + 40 mg oral tablet"] },
  { label: "Amlodipine 5 mg tablet", brands: ["Amlong (amlodipine besilate) 5 mg oral tablet", "Amlokind (amlodipine besilate) 5 mg oral tablet", "Amlodac (amlodipine besilate) 5 mg oral tablet"] },
  { label: "Losartan 50 mg tablet", brands: ["Losar (losartan potassium) 50 mg oral tablet"] },
  { label: "Metoprolol succinate 25 mg ER tablet", brands: ["Met XL (metoprolol succinate) 25 mg prolonged-release oral tablet"] },
  { label: "Atorvastatin 10 mg tablet", brands: ["Atorva (atorvastatin calcium) 10 mg oral tablet", "Lipvas (atorvastatin calcium) 10 mg oral tablet", "Storvas (atorvastatin calcium) 10 mg oral tablet"] },
  { label: "Atorvastatin 20 mg tablet", brands: ["Atorva (atorvastatin calcium) 20 mg oral tablet", "Lipvas (atorvastatin calcium) 20 mg oral tablet"] },
  { label: "Rosuvastatin 10 mg tablet", brands: ["Rosuvas (rosuvastatin calcium) 10 mg oral tablet"] },
  { label: "Clopidogrel 75 mg tablet", brands: ["Clopilet (clopidogrel bisulfate) 75 mg oral tablet"] },
  { label: "Aspirin 75 mg EC tablet", brands: ["Ecosprin (aspirin) 75 mg gastro-resistant oral tablet", "Ecosprin (aspirin) 75 mg oral tablet"] },
  { label: "Metformin 500 mg tablet", brands: ["Glycomet (metformin hydrochloride) 500 mg oral tablet", "Glyciphage (metformin hydrochloride) 500 mg oral tablet"] },
  { label: "Metformin 500 mg SR tablet", brands: ["Glycomet SR (metformin hydrochloride) 500 mg prolonged-release oral tablet", "Glyciphage SR (metformin hydrochloride) 500 mg prolonged-release oral tablet"] },
  { label: "Glimepiride 1 mg tablet", brands: ["Amaryl (glimepiride) 1 mg oral tablet", "Glimisave (glimepiride) 1 mg oral tablet"] },
  { label: "Glimepiride 2 mg tablet", brands: ["Amaryl (glimepiride) 2 mg oral tablet", "Glimisave (glimepiride) 2 mg oral tablet"] },
  { label: "Levothyroxine 50 mcg tablet", brands: ["Thyronorm (levothyroxine sodium) 50 mcg oral tablet", "Eltroxin (levothyroxine sodium) 50 mcg oral tablet"] },
  { label: "Levothyroxine 25 mcg tablet", brands: ["Thyronorm (levothyroxine sodium) 25 mcg oral tablet", "Eltroxin (levothyroxine sodium) 25 mcg oral tablet"] },
  { label: "Prednisolone 10 mg tablet", brands: ["Wysolone (prednisolone) 10 mg oral tablet", "Omnacortil-MD (prednisolone) 10 mg oral tablet"] },
  // ── vitamins, minerals, neuro ──
  { label: "Vitamin B-complex capsule", brands: ["Becosules (vitamin b complex and ascorbic acid) oral capsule"] },
  { label: "Multivitamin + zinc tablet", brands: ["Zincovit (multivitamin and multimineral) oral tablet"] },
  { label: "Vitamin C 500 mg chewable tablet", brands: ["Limcee (ascorbic acid) 500 mg chewable tablet"] },
  { label: "Calcium carbonate + vitamin D3 500 mg tablet", brands: ["Shelcal (calcium carbonate and colecalciferol) 500 mg + 250 iu oral tablet", "Calcimax (calcium carbonate and colecalciferol) 500 mg + 250 iu oral tablet"] },
  { label: "Vitamin D3 60,000 IU", brands: ["Tayo-60K (colecalciferol) 60000 IU oral tablet"] },
  { label: "Iron + folic acid (+ B12) capsule", brands: ["Livogen (ferrous fumarate and folic acid) oral tablet", "Autrin (cyanocobalamin and ferrous fumarate and folic acid) 15 mcg + 300 mg + 1.5 mg oral capsule"] },
  { label: "Folic acid 5 mg tablet", brands: ["Folvite (folic acid) 5 mg oral tablet"] },
  { label: "Vitamin E 400 mg capsule", brands: ["Evion (vitamin e) 400 mg oral capsule"] },
  { label: "Neurobion Forte tablet", brands: ["Neurobion Forte (thiamine and riboflavin and pyridoxine and nicotinamide and cyanocobalamin) 10 mg + 10 mg + 3 mg + 45 mg + 15 mcg oral tablet"] },
  { label: "Methylcobalamin 500 mcg tablet", brands: ["Nurokind (mecobalamin) 500 mcg oral tablet", "Methycobal (mecobalamin) 500 mcg oral tablet"] },
  { label: "Betahistine 16 mg tablet", brands: ["Vertin (betahistine dihydrochloride) 16 mg oral tablet"] },
  { label: "Pregabalin 75 mg capsule", brands: ["Pregabid (pregabalin) 75 mg oral capsule", "Lyrica (pregabalin) 75 mg oral capsule"] },
  { label: "Carboxymethylcellulose 0.5% eye drops", brands: ["Refresh Tears (carmellose sodium) 5 mg/1 mL eye drops", "Lubrex (carmellose sodium) 5 mg/1 mL eye drops"] },
];
