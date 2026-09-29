import { findFoetalSexDisclosures } from "./foetal-sex";

/**
 * PLAN 18-S RS7 T1 — the guard's two sides. Every TRUE POSITIVE is a sentence that has been written
 * in an Indian obstetric report; every FALSE-POSITIVE GUARD is one a sonologist writes every day and
 * must be able to sign.
 */
const ob = (t: string) => findFoetalSexDisclosures(t, { obstetric: true });
const any = (t: string) => findFoetalSexDisclosures(t, { obstetric: false });

describe("foetal-sex disclosure guard — true positives (refused)", () => {
  it.each([
    "Single live intrauterine male foetus of 20 weeks.",
    "Single live intrauterine FEMALE FETUS.",
    "female single live intrauterine foetus",
    "The foetus appears to be female.",
    "Fetal gender: male",
    "Foetal sex - F",
    "Sex of the foetus is male.",
    "fœtus is male",
    "Twin B female, twin A cephalic.",
    "It's a boy!",
    "baby girl, active movements",
    "Male genitalia seen.",
    "Scrotum and penis visualised.",
    "Turtle sign seen.",
    "sex: M",
    "लिंग: पुरुष",
    "शिशु का लिंग पुरुष है",
    "लड़का है",
    "लडकी",
    "ladka hai",
    "the foetus is not male",
  ])("obstetric: %s", (text) => {
    expect(ob(text).length).toBeGreaterThan(0);
  });

  it.each([
    "Incidental note: a live male foetus of about 18 weeks in the pelvis.",
    "FETAL SEX: FEMALE",
    "embryo — female",
  ])("any report, strictly foetal nouns: %s", (text) => {
    expect(any(text).length).toBeGreaterThan(0);
  });

  it("names the words it refused and classifies them", () => {
    const [hit] = ob("Single live intrauterine male foetus.");
    expect(hit).toMatchObject({ rule: "sex_beside_foetus", matched: "male foetus" });
    expect(ob("sex: F")[0]).toMatchObject({ rule: "sex_as_value" });
    expect(ob("A boy.")[0]).toMatchObject({ rule: "obstetric_term", matched: "boy" });
  });
});

describe("foetal-sex disclosure guard — false-positive guards (allowed)", () => {
  it.each([
    "28-year-old female, G2P1L1, with a single live intrauterine foetus of 20 weeks.",
    "Female patient. Single live intrauterine foetus in cephalic presentation.",
    "28 y, female, single live intrauterine foetus",
    "Maternal kidneys normal. The mother is anxious.",
    "Serum beta hCG correlated.",
    "Sex of the foetus has not been disclosed (PCPNDT).",
    "I declare that while conducting ultrasonography on this patient, I have neither detected nor disclosed the sex of her foetus to anybody in any manner.",
    "मैं घोषणा करता/करती हूँ कि इस रोगी की अल्ट्रासोनोग्राफी करते समय मैंने न तो उसके गर्भस्थ शिशु के लिंग का पता लगाया है और न ही किसी को किसी भी प्रकार से बताया है।",
    "Placenta posterior, upper segment. AFI 12 cm. FHR 148 bpm.",
    "Femur length 33 mm. Boyle's law aside, cervix 35 mm.",
    "Female pelvis: uterus anteverted.",
  ])("obstetric: %s", (text) => {
    expect(ob(text)).toEqual([]);
  });

  it.each([
    "45-year-old male, chest PA view. No focal consolidation.",
    "Female baby, 3 days old: cranial ultrasound normal.",
    "A 7-year-old boy with right iliac fossa pain. Scrotum normal.",
    "Testes normal in size and echotexture.",
  ])("non-obstetric: %s", (text) => {
    expect(any(text)).toEqual([]);
  });
});
