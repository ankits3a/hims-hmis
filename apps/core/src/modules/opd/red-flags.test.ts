import { redFlagFor, RED_FLAG_COUNT } from "./red-flags";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE BRAKE — WRITTEN BECAUSE OF WHO IS TYPING
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-17: *"my front desk staff are non medico background and so they would rely on the
 * operating system to suggest them doctor/department… just by typing 1-2 chief complaint."*
 *
 * That sentence is the reason this file exists. A doctor overrides a bad suggestion; a clerk with no
 * clinical training follows it, because following it is the entire point of giving them the tool.
 * The routing layer that helps them is therefore also the layer that can hurt them, and before this
 * there was no brake anywhere: a search of the triage path and the whole CDS library found no
 * handling of emergencies at all, and `DEFAULT_DEPARTMENTS` has no Casualty.
 *
 * So a clerk typing "seene mein dard" got the best possible OPD answer — *"Cardiology, next slot
 * 11:40"* — for a patient who may be having a myocardial infarction.
 *
 * ═══ THE THREE PROPERTIES THESE TESTS PIN ═══
 *
 * 1. IT IS DETERMINISTIC. No model, no network, no configuration. A brake that can fail to arrive
 *    because a provider is slow is not a brake.
 * 2. IT RUNS FIRST AND IT STOPS. It does not rank Casualty above Cardiology — ranking invites a
 *    clerk to choose. It refuses to route at all.
 * 3. IT IS DELIBERATELY SHORT. Every phrase here suppresses an appointment, so a list that flagged
 *    everything would be ignored within a week — the alert-fatigue failure, arriving through the
 *    one door where it is fatal.
 */
describe("redFlagFor — the emergencies a non-medico clerk must not book", () => {
  it.each([
    ["seene mein dard"], ["seene me dard"], ["chest pain"], ["छाती में दर्द"],
    ["saans nahi aa rahi"], ["saans phool rahi hai"], ["breathless"], ["सांस नहीं आ रही"],
    ["behosh"], ["unconscious"], ["बेहोश"],
    ["bahut khoon beh raha hai"], ["heavy bleeding"],
    ["daura pad raha hai"], ["convulsion"], ["fits aa rahe hain"],
    ["zeher kha liya"], ["poisoning"],
    ["accident hua hai"], ["major trauma"],
    ["muh tedha ho gaya"], ["stroke"], ["weakness on one side"],
    ["bachcha neela pad gaya"], ["baby is blue"],
  ])("flags %s", (complaint: string) => {
    expect(redFlagFor(complaint, null)).not.toBeNull();
  });

  /**
   * ═══ THE FIVE PROMOTED FROM THE OWNER'S BUNDLE, 2026-09-18 ═══
   *
   * The bundle marked 26 syndromes EMERGENCY (RED). Promoting all 26 would have been the easy
   * reading of "go ahead" and the wrong one: every entry here SUPPRESSES AN APPOINTMENT, and a
   * brake that fires on "bukhar", "pet dard" and "pair me sujan" — which several of the 26 reduce
   * to at a front desk — is a brake nobody obeys by Friday.
   *
   * The test applied to each row was not "is this serious?" but "**should a non-clinical clerk stop
   * and walk this patient to Casualty instead of booking an OPD slot?**". Five passed it. Each is
   * rare at a registration counter, unmistakable in the words a patient actually uses, and costly
   * to miss within hours.
   */
  it.each([
    // Hemoptysis / haematemesis / melena — bundle rows 5 and 7. Distinct from visible bleeding.
    ["khoon ki ulti"], ["khansi me khoon aa raha hai"], ["kala pakhana"], ["vomiting blood"],
    // Burns — bundle row 13. "jal gaya" is unmistakable and nothing else says it.
    ["garam pani se jal gaya"], ["bijli se jal gaya"], ["burn injury"],
    // Snakebite / scorpion — bundle row 16. The one the owner's own region needed most.
    ["saap kaat liya hai"], ["bichhu ne kaat liya"], ["snake bite"],
    // Testicular torsion — bundle row 24. A six-hour window; missing it costs the testicle.
    ["ande me tez dard"], ["testicular pain sudden"],
  ])("flags %s", (complaint: string) => {
    expect(redFlagFor(complaint, 30)).not.toBeNull();
  });

  /**
   * Neonatal jaundice — bundle row 19 — and the ONLY promotion that is age-gated, because the same
   * words mean different things. A yellow newborn risks kernicterus and permanent brain damage
   * within days; a yellow adult has hepatitis and belongs in a Medicine clinic this week.
   */
  it("flags a yellow NEWBORN", () => {
    expect(redFlagFor("naya bachcha peela pad gaya", 0)).not.toBeNull();
  });

  it("does not flag jaundice in an adult", () => {
    expect(redFlagFor("peeliya ho gaya", 40)).toBeNull();
    expect(redFlagFor("aankh peeli hai", 35)).toBeNull();
  });

  /** Aluminium phosphide and organophosphate — what rural poisoning in UP and Bihar actually is. */
  it.each([["celphos kha liya"], ["sulphas kha liya"], ["keetnashak pi liya"]])(
    "flags %s as poisoning", (complaint: string) => {
      expect(redFlagFor(complaint, 25)).not.toBeNull();
    },
  );

  /**
   * ═══ THE TWENTY-ONE THAT WERE NOT PROMOTED, ASSERTED SO NOBODY QUIETLY PROMOTES THEM ═══
   *
   * Each of these is a real condition the bundle called an emergency, and each reduces at a
   * registration counter to a phrase that is among the commonest in an Indian OPD. Flagging them
   * would stop dozens of correct bookings a day and spend the red badge until it meant nothing.
   *
   *   high/low BP (row 2)        "bp high hai"       — the single commonest walk-in there is
   *   pedal edema / CHF (3)      "pair me sujan"     — routine; the breathlessness IS flagged
   *   gastroenteritis (6)        "loose motion"      — bread and butter
   *   acute abdomen (8)          "pet dard"          — severity is the signal and clerks cannot type it
   *   DVT (15)                   "pair me sujan"     — indistinguishable from the routine case
   *   paediatric fever (18)      "bachche ko bukhar" — the commonest paediatric visit of all
   *   CKD / puffiness (20)       "muh par sujan"     — chronic
   *   corneal injury (23)        "aankh me kuch"     — same-day Eye OPD, not Casualty
   *
   * Where a genuine emergency hides behind one of these, it reaches the brake by its OWN words:
   * a septic patient is unconscious or breathless, both flagged.
   */
  it.each([
    ["bp high hai"], ["pair me sujan"], ["loose motion ho raha hai"], ["pet dard"],
    ["bachche ko bukhar"], ["muh par sujan"], ["aankh me kuch chala gaya"],
    ["neel pad gaye hain"], ["kamzori lagti hai"],
  ])("does NOT flag %s — it would spend the red badge on an ordinary day", (complaint: string) => {
    expect(redFlagFor(complaint, 35)).toBeNull();
  });

  it("names WHY, because a clerk has to say something to the patient", () => {
    const flag = redFlagFor("seene mein dard", 55);
    expect(flag?.reasonKey).toMatch(/^opdTriage\.redFlag\./);
  });

  /**
   * ═══ THE ORDINARY OPD DAY MUST NOT TRIP IT ═══
   *
   * If a Tuesday morning of coughs and knee pain sets off the emergency brake, the brake is gone by
   * Friday. These are the complaints that make up most walk-ins and NONE of them may flag.
   */
  it.each([
    ["bukhar"], ["khansi"], ["ghutne mein dard"], ["aankh me dard"], ["daant me dard"],
    ["khujli"], ["sugar bp check karana hai"], ["kamar dard"], ["pet dard"],
    ["neend nahi aati"], ["baccha ko teeka"], ["gala kharab hai"], ["kaan me dard"],
  ])("does not flag %s", (complaint: string) => {
    expect(redFlagFor(complaint, 35)).toBeNull();
  });

  it("does not flag an empty complaint", () => {
    expect(redFlagFor("", null)).toBeNull();
    expect(redFlagFor("   ", 40)).toBeNull();
  });

  /**
   * ═══ AGE MODULATES TWO OF THEM, AND ONLY TWO ═══
   *
   * Chest pain in an adult is cardiac until proven otherwise. In a small child it is almost never,
   * and flagging it would send every chesty six-year-old to Casualty — which is how a brake gets
   * ignored. The rule is narrow and stated rather than clever.
   */
  it("treats chest pain as an emergency in an adult", () => {
    expect(redFlagFor("seene mein dard", 55)).not.toBeNull();
    expect(redFlagFor("seene mein dard", 30)).not.toBeNull();
  });

  it("does not treat chest pain in a small child as a cardiac emergency", () => {
    expect(redFlagFor("seene mein dard", 6)).toBeNull();
  });

  it("flags chest pain when the age is unknown — the safe direction", () => {
    // Unknown age must fail SAFE. Over-triage costs a walk down the corridor.
    expect(redFlagFor("seene mein dard", null)).not.toBeNull();
  });

  /**
   * Breathlessness is the counter-example and stays flagged at every age: a breathless child is
   * MORE urgent than a breathless adult, not less.
   */
  it("flags breathlessness at every age", () => {
    for (const age of [2, 9, 30, 80, null]) {
      expect(redFlagFor("saans nahi aa rahi", age)).not.toBeNull();
    }
  });

  /**
   * ═══ THE LIST STAYS SHORT, AND THIS TEST IS THE ONLY THING THAT KEEPS IT SO ═══
   *
   * Every entry suppresses an appointment. Growth here is not free the way growth in the routing
   * table is free, so a census makes somebody argue for each addition in a pull request.
   */
  it("is a short list on purpose", () => {
    expect(RED_FLAG_COUNT).toBeLessThanOrEqual(16);
  });

  it("matches on a phrase inside a longer sentence", () => {
    expect(redFlagFor("kal raat se seene mein dard ho raha hai", 50)).not.toBeNull();
  });
});
