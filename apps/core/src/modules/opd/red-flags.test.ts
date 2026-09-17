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
