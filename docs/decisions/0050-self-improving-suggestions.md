---
type: decision
id: "0050"
title: "Suggestions learn from what doctors and staff do, per doctor; TypeSafe's Jev is the standard chooser"
description: "The system re-ranks its own suggestions from committed visits, personal first, hides what is crossed off, never adds anything itself; Jev chooses among our options with fallbacks; one point (no children's dose) awaits the owner's yes."
generated: { by: agent:claude, at: 2026-10-07 }
verified: []
status: draft
ruling: partly-open
tags: [opd, doctor, front-desk, copilot, formulary, learning]
supersedes: []
superseded_by: []
sources: []
---
# 0050 — Suggestions learn from what doctors and staff do, per doctor; TypeSafe's Jev is the standard chooser

- **Date:** 2026-10-07   **Status:** Ruled in direction; one point open (children's doses, below)
- **Area:** opd, doctor, front desk, copilot, formulary

## The owner's words (2026-10-07)

- "we need to build a system that auto improves, auto evolves based on actions of the doctor and
  staff. If any suggeston is crossed multiple times then it should be siliently discarded and a
  better suggestion should appear. If a web search is required by the agent then I will approve it."
- "we need brainstorm on list of chief complaints and combincation of chief complaints and then we
  need to improve our diagnosis suggestions and medicine suggestion and doses suggestions. We need to
  build a system that keep improving itself and personalised to that specific doctor who is
  prescribing. Highly personalised. A system that also helps front desk staff to point the patient to
  right department."
- "Typesafe's Jev is a decision model currently being used in front desk module. I want to improve
  it's decision by better feeding the initial data. Yes, each doctor be able to see and reset what the
  system has learned about them. Yes, Peer learning, acceptable for one doctor's suggestions to be
  influenced by colleagues' patterns, without names shown. Yes, comfortable with doses suggested from
  a doctor's own history, with the rule "no suggestion when evidence is thin""
- On aliases: "currently no one adds and no one approves. No body has anytime to do it and so I am
  looking this to be automated using advanced AI model." To the automated design (a model proposes,
  doctors approve by using it, hard rails): "Yes."
- On drug information: "go with our own bundle first."
- "I think Jev could be very important tool to in deciding to choose the best options available with
  fallback mechanism in many areas of HMIS." To the proposal to make Jev the standard chooser step:
  "yes. definitely."

## Ruled by the owner

1. Suggestions improve themselves from the actions of doctors and staff, personal to each doctor.
2. A suggestion crossed off several times is dropped silently and the next best takes its place.
3. Each doctor can see and reset what the system has learned about them.
4. A doctor's suggestions may be influenced by colleagues' patterns; no colleague is named.
5. A dose may be suggested from the doctor's own history; none is suggested when evidence is thin.
6. Hinglish aliases are learned automatically. Nobody adds or approves them by hand.
7. A web search by an agent needs the owner's approval each time.
8. TypeSafe's Jev is the standard "chooser" across HMIS, with fallbacks. Its first two new uses are
   matching Hinglish terms to our lists and normalising complaints.

## Decided by delegation (the owner did not rule on these; an independent review shaped them)

- **Learn from committed visits.** Ranking uses what was issued and recorded on completed visits.
  Taps and crosses only hide rejected items and measure the system.
- **Counts, not models.** No model ranks a diagnosis, medicine or dose, and none writes clinical text.
- **Nothing is added by itself.** Every suggestion is tapped; safety checks run on every line.
- **A real × on each suggestion.** An explicit cross counts against it; three hide it. It returns by
  decay, or at once when the doctor taps or types that item. Suggestions are never ranked by how often
  they are accepted.
- **Countable first.** Dose and frequency become structured (a closed frequency set, a parsed dose)
  before anything is learned from them.
- **No random "explore" slot.** The last slot is the department's best item not already listed.
- **Stewardship cap.** Personal habit never boosts Watch/Reserve antibiotics, Schedule H1/X, NDPS or
  systemic steroids above the department's pattern. Each doctor gets a private monthly number.
- **Adult dose rule.** Only the doctor's own usual line (dose, frequency, days) for that medicine and
  diagnosis, seen at least 5 times and holding at least 60%; never from a line that needed a safety
  override; refused for pregnancy, coded kidney or liver disease, high-alert and controlled medicines.
- **Alias trust.** A medicine alias is trusted only when it resolves to one medicine, at 3 different
  doctors and 10 taps, with no tap later edited to a different medicine; the full product name always
  shows; never for controlled medicines; a look-alike list must be sourced first.
- **Reset.** A doctor's reset clears their personal learning only; department and hospital patterns
  keep the lines without the doctor's name.
- **The chooser ladder.** Exact rule → the hospital's own counts → Jev → a second model → "not sure —
  please choose". Jev is never used where a rule or a count decides, never for doses or amounts, sees
  masked text only, and every use works when the vendor is down. Each use has its own measured test
  set and confidence line before it is trusted.
- **The clinical-master bundle is not drug information.** Measured 2026-10-07: its fields hold about
  6 distinct texts across 10,303 generics and 27 distinct FAQ answers. It is never shown as a
  medicine's facts and never fills a dose. A real source is chosen separately.
- **Not built:** a graph database, conversational memory, model-written clinical answers, scraping a
  third party's site without permission.

## Open — needs the owner's explicit yes

- **No dose suggestion for a child in the first version.** Decision 0009 rules that children's
  weight-based dosing comes from a licensed source signed by the pharmacy and therapeutics committee.
  A dose one doctor gave a 14 kg child is not evidence for a 7 kg child. For a child the system
  suggests the medicine and leaves the dose blank. This narrows ruling 5 above.

## Consequences / how to apply

- The plan is `docs/superpowers/plans/2026-10-07-self-improving-suggestions.md`; build it in its phases.
- Decision 0006 (a doctor's copilot toggles) and 0009 (consult engine ladder: usage → IDF → rules →
  model last) still bind. Decisions 0048 and 0049 bind every call to an outside service.
- Ruling 4 answers 0009's open point on a doctor's own entries: aggregate peer patterns may inform
  another doctor's suggestions; a doctor's name and own words are never shown to a colleague.
