# Triage emergencies — clinician sign-off sheet

**Generated 2026-09-17** from the owner-supplied triage bundle
(`clinical_syndromes_data.mjs`, sha256 `aa1b186270e309e2b00c27d62e27a2186f853a4c57cc63c50b2ea6a5559beb05`) by
`apps/core/scripts/harvest-triage-book.mjs`.

## Why this sheet exists

The bundle marks **26 syndromes as EMERGENCY (RED)**. In this system an emergency does not
merely colour a badge — `red-flags.ts` **refuses to book the appointment at all** and tells the
clerk to walk the patient to the emergency room. That is the correct behaviour for a front desk
staffed by non-clinicians, and it is exactly why the list cannot be taken on a language model's
word.

Two failure directions, and they are not symmetric:

- **Too many entries** and the brake is ignored within a week. The bundle's own engine returns
  EMERGENCY (RED) for *"mera mobile kho gaya"* — that is what a diluted red badge looks like.
- **Too few** and somebody is booked an 11:40 slot for a myocardial infarction.

So none of these has been merged into the brake. `red-flags.ts` still carries only the ten rules
written against the owner's own brief, and its test caps the list deliberately.

## What a reviewing doctor is being asked

For each row: is this an emergency that should **stop an OPD booking** at a front desk in *this*
hospital? Tick one box. Nothing here is merged until a row is ticked and initialled.

Please also name **where these patients go** — the system currently says "the emergency room"
because it has not been told the name of the place.

**Reviewed by:** ______________________  **Reg. no:** ______________  **Date:** ____________

---

### 1. Acute Chest Pain / Angina / Acute Coronary Syndrome (ACS)

- **code:** `CC_CHEST_PAIN`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Radiating pain to left arm/jaw, diaphoresis, shortness of breath, syncope. Order STAT ECG.
- **vital triggers (as supplied):** SBP < 90 or > 180, HR > 110 or < 50, SpO2 < 94%
- **example phrasings:** `seene me dard`, `sine me dard`, `seena me dard`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 2. Hypertensive Urgency / Severe High BP / Low BP / Giddiness

- **code:** `CC_HYPERTENSION_BP_CRISIS`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** BP > 180/120 mmHg with severe headache, blurred vision, chest pain, or dyspnea.
- **vital triggers (as supplied):** SBP > 180 mmHg or DBP > 120 mmHg, SBP < 90 mmHg
- **example phrasings:** `bp badh gaya hai`, `high bp`, `low bp`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 3. Congestive Heart Failure / Pedal Edema / Orthopnea / PND

- **code:** `CC_HEART_FAILURE_EDEMA`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Bilateral pitting pedal edema, unable to lie flat (orthopnea), waking up gasping at night (PND), SpO2 < 90%.
- **vital triggers (as supplied):** SpO2 < 92%, SBP > 180 or < 85, Respiratory Rate > 28
- **example phrasings:** `pair me sujan aur saans phoolna`, `pair phool gaya hai dabane par gaddha`, `letne par saans ghutna`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 4. Acute Dyspnea / Breathlessness / Asthma / COPD Exacerbation

- **code:** `CC_BREATHLESSNESS`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Stridor, central cyanosis, SpO2 < 90%, inability to speak in sentences.
- **vital triggers (as supplied):** SpO2 < 92%, Respiratory Rate > 28, HR > 120
- **example phrasings:** `saans phoolna`, `saans lene me takleef`, `dam ghutna`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 5. Hemoptysis / Coughing Up Blood

- **code:** `CC_HEMOPTYSIS`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Massive hemoptysis (> 100 mL blood), hemodynamic instability, choking sensation.
- **vital triggers (as supplied):** SpO2 < 92%, SBP < 90 mmHg, HR > 110 bpm
- **example phrasings:** `khansi me khoon aana`, `balgam me khoon`, `coughing blood`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 6. Acute Gastroenteritis / Diarrhea & Vomiting / Food Poisoning

- **code:** `CC_ACUTE_DIARRHEA_VOMITING`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Sunken eyes, lethargy, skin pinch > 2 seconds, no urine output > 8 hours, cholera-like rice water stools.
- **vital triggers (as supplied):** SBP < 85 mmHg, HR > 120 bpm, SBP unrecordable
- **example phrasings:** `ulti aur dast`, `loose motion vomiting`, `dast lagatar ho raha hai`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 7. Upper GI Bleed / Hematemesis / Melena (Black Tarry Stools)

- **code:** `CC_UPPER_GI_BLEED`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Active vomiting of fresh red blood, coffee ground vomitus, pitch-black smelly stools, postural hypotension.
- **vital triggers (as supplied):** SBP < 90 mmHg, HR > 115 bpm, Hemoglobin < 7 g/dL
- **example phrasings:** `khoon ki ulti hui hai`, `hematemesis`, `kali latrine ho rahi hai damar jaisi`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 8. Acute Appendicitis / Gallbladder Stones (Cholelithiasis) / Acute Colic

- **code:** `CC_SURGICAL_COLIC_STONE_APPENDIX`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Right lower quadrant McBurney point tenderness with fever, Murphy's sign positive, signs of peritonitis.
- **vital triggers (as supplied):** Temperature > 101 F, HR > 115 bpm, TLC > 14,000/mcL
- **example phrasings:** `appendix ka dard`, `pitte me pathri gallstone`, `pasli ke niche dahine dard cholecystitis`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 9. Traumatic Brain Injury / Acute Head Trauma / Concussion / Skull Fracture

- **code:** `CC_HEAD_INJURY_CONCUSSION`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** GCS < 13, loss of consciousness > 5 mins, post-traumatic vomiting > 2 episodes, ear/nose clear fluid (CSF leak), unequal pupils.
- **vital triggers (as supplied):** Cushing triad: SBP > 180 mmHg with bradycardia (HR < 50 bpm) and irregular breathing
- **example phrasings:** `sar me chot lag gayi accident`, `head injury trauma`, `bike accident sar par laga ulti`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 10. Acute Ischemic / Hemorrhagic Stroke / Hemiplegia / TIA

- **code:** `CC_STROKE_PARALYSIS`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Facial droop, arm weakness, slurred speech (FAST positive) within last 4.5 hours. STAT Code Stroke.
- **vital triggers (as supplied):** SBP > 220 or DBP > 120, SBP < 90, SpO2 < 92%
- **example phrasings:** `lakwa maar diya hai`, `paralysis ho gaya`, `falij gir gaya`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 11. Epilepsy / Status Epilepticus / Generalized Tonic-Clonic Seizures (Mirgi)

- **code:** `CC_SEIZURE_EPILEPSY`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Seizure lasting > 5 minutes, back-to-back seizures without regaining consciousness (Status Epilepticus - STAT IV Benzodiazepines).
- **vital triggers (as supplied):** SpO2 < 90% post-ictal, Temperature > 103 F in children
- **example phrasings:** `mirgi ka daura`, `seizure fits`, `daura pad raha hai`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 12. Trauma / Bone Fracture / Dislocation / Road Traffic Accident (RTA)

- **code:** `CC_TRAUMA_FRACTURE`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Bone piercing through skin (Open Compound Fracture), absent distal peripheral pulse, cold clammy limb, compartment syndrome.
- **vital triggers (as supplied):** Capillary refill time > 3 seconds, severe deformity, SBP < 90 mmHg
- **example phrasings:** `haddi toot gayi hai`, `fracture ho gaya`, `plaster lagwana hai`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 13. Thermal / Chemical / Electrical Burns / Scalds Injury

- **code:** `CC_BURNS_SCALDS`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Burns > 15% TBSA in adults or > 10% in children, facial/inhalation burns (singed nasal hairs, soot in sputum), circumferential burns.
- **vital triggers (as supplied):** TBSA > 15%, SpO2 < 93% in face burns, HR > 120 bpm
- **example phrasings:** `haath jal gaya hai garam tel se`, `aag se jhulas gaya burns`, `garam pani se bachha jal gaya scald`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 14. Peripheral Artery Disease / Intermittent Claudication / Gangrene

- **code:** `CC_PERIPHERAL_ARTERIAL_DISEASE`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Rest pain waking patient at night, black cold mummified toes (Dry Gangrene), absent dorsalis pedis / popliteal pulses.
- **vital triggers (as supplied):** Ankle-Brachial Index (ABI) < 0.5, capillary refill absent
- **example phrasings:** `pair ki ungli kali pad gayi dry gangrene`, `thoda chalne par pindli me tez dard claudication`, `pair thanda pad gaya hai pulse nahi mil rahi`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 15. Deep Vein Thrombosis (DVT) / Acute Calf Swelling & Tenderness

- **code:** `CC_DEEP_VEIN_THROMBOSIS`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Sudden unilateral painful calf swelling, calf circumference > 3 cm asymmetry, new-onset dyspnea or hemoptysis (Pulmonary Embolism).
- **vital triggers (as supplied):** HR > 100 bpm, SpO2 < 93%
- **example phrasings:** `ek pair achanak phool gaya sujan`, `dvt deep vein thrombosis`, `pindli me asahya dard aur sujan`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 16. Snakebite Envenomation / Scorpion Sting / Venomous Bite

- **code:** `CC_SNAKE_BITE_ENVENOMATION`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Fang marks, bilateral ptosis, inability to open mouth, spontaneous bleeding from gums/urine, swelling extending up limb.
- **vital triggers (as supplied):** 20WBCT uncoagulated at 20 min, SpO2 < 90%, SBP < 85 mmHg
- **example phrasings:** `saap kaat liya hai snake bite`, `krait krait saap kata`, `asv injection anti snake venom`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 17. Acute Poisoning / Organophosphate / Celphos / Drug Overdose

- **code:** `CC_POISONING_OVERDOSE`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Pinpoint pupils, copious salivation, garlic odor, altered mental status, ingestion of celphos (aluminum phosphide - high mortality).
- **vital triggers (as supplied):** Pinpoint pupils, HR < 50 bpm or > 140 bpm, SBP < 80 mmHg, SpO2 < 88%
- **example phrasings:** `zehar khaa liya hai poisoning`, `keetnashak dawai pee li organophosphate`, `celphos kha liya wheat tablets`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 18. Acute Pediatric Illness / High Fever / Dehydration / Pneumonia

- **code:** `CC_PEDIATRIC_ILLNESS`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Inability to breastfeed, chest indrawing (pasli chalna), lethargy/unconsciousness, grunting.
- **vital triggers (as supplied):** Child RR > 50 bpm (2-11 mo) or > 40 bpm (1-5 yr), SpO2 < 92%, Temp > 103 F
- **example phrasings:** `bachwa rowat ba band naikhe hot`, `bachhe ko tez bukhar`, `sukhandi rog bacha sukhta ja raha`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 19. Neonatal Hyperbilirubinemia / Newborn Jaundice / Kernicterus Risk

- **code:** `CC_NEONATAL_JAUNDICE`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Jaundice appearing within first 24 hours of life, deep yellow soles and palms, high-pitched cry, lethargy (Kernicterus risk).
- **vital triggers (as supplied):** Total serum bilirubin > 15 mg/dL in term infant
- **example phrasings:** `navjaat bachhe ka chehra peela pad gaya`, `newborn jaundice neonatal`, `bachhe ko phototherapy lagwana`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 20. Chronic Kidney Disease (CKD) / Acute Kidney Injury / Facial Puffiness

- **code:** `CC_RENAL_FAILURE_SWELLING`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Serum potassium > 6.5 mEq/L (Tall T waves), anuria < 100 mL/day, uremic encephalopathy or pericardial rub.
- **vital triggers (as supplied):** K+ > 6.0 mEq/L, Creatinine > 6 mg/dL, SpO2 < 90% (Pulmonary edema)
- **example phrasings:** `gurda kharab ho gaya hai`, `kidney fail creatinine badh gaya`, `dialysis karwana hai`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 21. Spontaneous Bleeding / Purpura / Thrombocytopenia / Hemophilia

- **code:** `CC_BLEEDING_PURPURA_COAGULATION`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Spontaneous oral mucosal bleeds, retinal hemorrhages, platelet count < 10,000/mcL, bleeding into joints (hemarthrosis).
- **vital triggers (as supplied):** Platelets < 20,000/mcL, INR > 3.0, active gum/urine bleed
- **example phrasings:** `sharir par neel pad jata hai bina chot purpura`, `chhoti chot se bhi khoon band nahi hota`, `platelet kam ho gaya hai dengue bleeding`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 22. Septic Shock / Severe Sepsis / Multi-Organ Dysfunction

- **code:** `CC_SEPSIS_SEPTIC_SHOCK`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Systolic BP < 90 mmHg despite 2L fluid resuscitation, lactate > 2 mmol/L, mottled extremities, anuria.
- **vital triggers (as supplied):** SBP < 85 mmHg, HR > 130 bpm, Temp > 103 F or < 96 F, RR > 30
- **example phrasings:** `septic shock bp gir gaya`, `infection pure sharir me phail gaya`, `sharir thanda pad gaya bukhar ke baad`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 23. Corneal Foreign Body / Welding Flash Burn / Corneal Ulcer

- **code:** `CC_CORNEAL_FOREIGN_BODY`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Rust ring on cornea, hypopyon (pus in anterior chamber), penetrating ocular perforation (Seidel test positive).
- **vital triggers (as supplied):** Severe blepharospasm, visual acuity reduction
- **example phrasings:** `aankh me welding ki roshni lag gayi`, `aankh me loha chala gaya welding particle`, `kankaad chala gaya aankh khul nahi rahi`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 24. Acute Testicular Torsion / Epididymo-Orchitis

- **code:** `CC_TESTICULAR_SCROTAL_PAIN`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Sudden onset unilateral severe testicular pain in adolescent, high-riding horizontal testis, absent cremasteric reflex (Torsion).
- **vital triggers (as supplied):** Severe scrotal agony, nausea, absent testicular vascularity on Doppler
- **example phrasings:** `andkosh me achanak asahya dard`, `testicular torsion fota mud gaya`, `fota me tez dard aur ulti`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 25. Mucormycosis (Black Fungus) / Invasive Rhino-Orbital Infection

- **code:** `CC_FUNGAL_BLACK_FUNGUS`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** Black eschar in nasal cavity or hard palate, facial numbness, proptosis, diabetic ketoacidosis history.
- **vital triggers (as supplied):** Facial swelling with numbness and vision drop in diabetic patient
- **example phrasings:** `black fungus mucormycosis`, `naak se kala peep aana`, `chehre par ek taraf sujan aur sunn pan`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove

### 26. Imperforate Anus / Congenital Anorectal Malformation (ARM)

- **code:** `CC_ANORECTAL_MALFORMATION_PEDS`
- **proposed urgency:** EMERGENCY (RED) — would STOP the booking
- **red flags (as supplied):** No anal opening at birth, meconium in urine, progressive abdominal distension in newborn.
- **vital triggers (as supplied):** Abdominal distension in newborn with no stool passage at 24 hours
- **example phrasings:** `navjaat bachhe ka latrine ka rasta nahi bana`, `imperforate anus shishu`, `bachhe ki tatti ka rasta band`

  - [ ] Correct as an emergency — add to the brake
  - [ ] Downgrade to URGENT (route, do not stop)
  - [ ] Wrong / remove
