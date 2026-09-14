import { Controller, Get, Inject, Query } from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { getPatient, listAllergies } from "../patients";
import { buildRegimen, cardsFor, matchesAKnownAllergen, rankSyndromes, searchAllergens, searchIcd10, toRxDraft } from "../cds";
import type { AllergenHit, BuiltLine, BuiltRegimen, Card, Icd10Hit, PatientFacts, RxDraftLine, SyndromeHit } from "../cds";
import { getEncounter } from "./encounters";
import { expandComplaintForMatching, suggestComplaints } from "./complaints";
import { doctorForUser } from "./masters";
import type { ComplaintSuggestion } from "./complaints";
import { OpdError } from "./errors";
import { parsed, toHttp } from "./opd-masters.controller";
import { ageYearsAt } from "./time";
import { listVitals } from "./vitals";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE CO-PILOT'S TWO READS — INSIDE THE CONSULTATION, UNDER THE CONSULTATION'S OWN GRANT ═══
 *
 * Owner, 2026-09-14: *"when doctor starts to write chief complaints, he don't need to type much,
 * just tap and select … lesser friction and faster consultancy."*
 *
 * `opd.consult` and no permission of its own: this is the doctor who is already writing the note,
 * and a second name for that authority would be a grant to keep in step forever (and a census pin
 * in `seed-roles.ts` to churn). The CDS library has no module and no screen — it lives here,
 * because that is where the doctor is.
 *
 * ═══ EVERY DOSING INPUT IS READ FROM THE RECORD, NOT TAKEN FROM THE CALLER ═══
 *
 * The weight that multiplies a mg/kg rate comes from the encounter's own vitals chart, through
 * `listVitals` — the reader that carries the PHI gate and writes the access-log row. A weight in a
 * query string is a number any bug or any tab can set, and it would arrive as millilitres in a
 * child's mouth. The allergy list is read the same way, and the age from the patient's own date of
 * birth.
 *
 * THE ONE THING THE CALLER MAY ASSERT IS PREGNANCY, because this hospital records it nowhere
 * (measured: no column on the encounter, the patient or the chart). It is the doctor answering a
 * question about the woman in front of them, which is a clinical act; `guardrails.ts` ASKS that
 * question rather than assuming the answer when it is absent.
 */
const suggestQuery = z.object({ complaint: z.string().max(500) });
const completeQuery = z.object({ q: z.string().max(120) });
const diagnosisQuery = z.object({ q: z.string().max(120), limit: z.coerce.number().int().min(1).max(25).optional() });
const regimenQuery = z.object({
  syndromeKey: z.string().min(1).max(64),
  encounterId: z.string().min(1).max(64),
  /** Tri-state on purpose: absent means UNANSWERED, which is not the same as `false`. */
  pregnant: z.enum(["true", "false"]).optional(),
});

@Controller("opd/cds")
export class OpdCdsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Chief complaint → ranked syndromes. NO PATIENT, NO PHI, NO MODEL: it is the bundle's own
   * keywords matched against what the doctor is typing, so it answers in microseconds and can be
   * called on every keystroke without a thought about cost.
   */
  @RequirePermission("opd.consult", "hospital")
  @Get("suggest")
  async suggest(@Query() query: unknown): Promise<{ items: SyndromeHit[] }> {
    const q = parsed(suggestQuery, query);
    /*
      ENRICHED FIRST. `rankSyndromes` matches English keywords, so a Hindi or romanised complaint
      reaches a syndrome only through its concept's English forms. The matcher itself is unchanged
      and still a pure function over words — see `expandComplaintForMatching`.
    */
    return { items: rankSyndromes(await expandComplaintForMatching(this.db, q.complaint)) };
  }

  /**
   * ═══ THE COMPLAINT FIELD'S OWN AUTOCOMPLETE — NO AI, NO PATIENT, NO STATE ═══
   *
   * Owner, 2026-09-14: the doctor types `fev`, sees `fever`, and either completes it with the
   * forward key or types their own words and presses enter. This route serves the first half; the
   * second half is the field's, and the field always wins — nothing here rewrites what was typed.
   *
   * It reads the hospital's own vocabulary (the syndromes' keywords and the bundle's symptom map),
   * so it answers in microseconds and is safe to call on a keystroke. `ghost` is the remainder of
   * the best PREFIX match and is null unless one exists, because an inline completion that inserts
   * letters BEFORE the cursor is a keystroke the doctor did not make.
   */
  @RequirePermission("opd.consult", "hospital")
  @Get("complete/complaint")
  async completeComplaint(
    @CurrentActor() actor: Actor, @Query() query: unknown,
  ): Promise<{ items: ComplaintSuggestion[]; ghost: string | null }> {
    const q = parsed(completeQuery, query);
    /*
      ═══ THE DOCTOR'S OWN HABITS RANK FIRST, WHICH IS WHY THIS READS WHO IS ASKING ═══

      A complaint field is a personal shorthand before it is a shared vocabulary. Resolving the
      doctor from the actor rather than taking a parameter keeps that honest: a caller cannot ask
      for somebody else's habits, and there is nothing to get wrong at the call site.

      A user who is not a doctor still gets the hospital's vocabulary — `doctorForUser` answering
      null is an ordinary state here, not a refusal.
    */
    const doctor = actor.type === "user" ? await doctorForUser(this.db, actor.id) : null;
    const items = await suggestComplaints(this.db, doctor?.id ?? null, q.q);
    const needle = q.q.trim().toLowerCase();
    /* The ghost is still only ever a PREFIX remainder — letters appearing behind the caret are a
       keystroke the doctor did not make. */
    const best = items.find((i) => i.term.toLowerCase().startsWith(needle) && i.term.toLowerCase() !== needle);
    return { items, ghost: best === undefined ? null : best.term.slice(needle.length) };
  }

  /**
   * ═══ THE DIAGNOSIS TYPEAHEAD — ICD-10, AND NOT GATED ON THE CO-PILOT ═══
   *
   * The owner's two rulings of 2026-09-14 draw their line in different places, and this route is on
   * the permissive side of it: *"Diagnosis, Advice and Advised investigations suggest only when the
   * AI co-pilot is enabled"*, but *"even though the doctor doesn't enable AI suggestion … auto
   * complete will work if doctor starts to type drug name."*
   *
   * Completing a word the doctor is TYPING against a published catalogue is the second kind — no
   * model, no patient, no inference, exactly what the drug field does. What the co-pilot gates is
   * proposing a diagnosis the doctor has NOT typed, inferred from the complaint; that is `suggest`
   * above, and it stays behind the switch.
   *
   * NO PATIENT AND NO PHI, so nothing here writes an access-log row: it reads a published
   * international standard, and the only thing it learns about the doctor is what they typed.
   */
  @RequirePermission("opd.consult", "hospital")
  @Get("complete/diagnosis")
  async completeDiagnosis(@Query() query: unknown): Promise<{ items: Icd10Hit[] }> {
    const q = parsed(diagnosisQuery, query);
    return { items: await searchIcd10(this.db, q.q, q.limit ?? 10) };
  }

  /**
   * ═══ THE ALLERGY FIELD'S OWN COMPLETION, AND IT IS A SAFETY ROUTE ═══
   *
   * The doctor could already TYPE an allergy in the room. What they could not do was pick one — and
   * `blockedBy` matches free text on tokens of five letters or more, so `pencilin` matches nothing
   * and the penicillin block stays silent for the life of that record. A picked allergen carries
   * its class and fires the rule by identity.
   *
   * `known` is the other half and is why the answer is not just a list: it says whether the text as
   * TYPED reaches any rule at all, using the same token test the guard itself uses. The field warns
   * on false — it never refuses. Free text is legal here and must stay so; a patient who says "the
   * red syrup gave him a rash" has told the doctor something worth keeping.
   */
  @RequirePermission("opd.consult", "hospital")
  @Get("complete/allergen")
  async completeAllergen(@Query() query: unknown): Promise<{ items: AllergenHit[]; known: boolean }> {
    const q = parsed(completeQuery, query);
    return { items: await searchAllergens(this.db, q.q), known: matchesAKnownAllergen(q.q) };
  }

  /**
   * A syndrome + the patient actually in the chair → the regimen with the doses computed for them,
   * and the danger cards. One call, because the screen needs both to render a single decision and
   * a doctor should not watch two spinners resolve at different times.
   */
  @RequirePermission("opd.consult", "hospital")
  @Get("regimen")
  async regimen(
    @CurrentActor() actor: Actor, @Query() query: unknown,
  ): Promise<{
    regimen: Omit<BuiltRegimen, "lines"> & { lines: (BuiltLine & { rx: RxDraftLine })[] };
    cards: Card[];
    facts: { weightKg: number | null; ageYears: number | null; allergies: string[]; pregnant: boolean | null };
  }> {
    const q = parsed(regimenQuery, query);
    try {
      const encounter = await getEncounter(this.db, q.encounterId);
      if (!encounter) throw new OpdError("unknown_encounter", `unknown encounter ${q.encounterId}`);

      /*
        THE NEWEST CHARTED WEIGHT, and `listVitals` is the one road to it: it applies the read gate
        and logs the access. A chart with no weight yields null, which `regimen.ts` turns into a
        refusal to compute rather than a default — the whole point.
      */
      const vitals = await listVitals(this.db, actor, encounter.id);
      const weightKg = [...vitals].reverse().find((v) => v.weightKg !== null)?.weightKg ?? null;

      const detail = await getPatient(this.db, actor, encounter.patientId);
      const dob = detail?.patient.dob ?? null;
      const ageYears = dob === null ? null : ageYearsAt(new Date(dob), new Date());
      const sex = detail?.patient.administrativeGender ?? null;
      const activeAllergies = (await listAllergies(this.db, encounter.patientId))
        .filter((a) => a.status === "active");
      const allergies = activeAllergies.map((a) => a.substance);
      /*
        THE CODED CLASSES RIDE BESIDE THE WORDS. An allergy the doctor PICKED carries its rule class
        and fires the block by identity; one that was typed is still matched by token exactly as
        before. Sending only the words is how `pencilin` silenced a penicillin block.
      */
      const allergenClasses = activeAllergies
        .map((a) => a.allergenClass)
        .filter((c): c is string => c !== null && c !== "");

      const pregnant = q.pregnant === undefined ? null : q.pregnant === "true";
      const facts: PatientFacts = { ageYears, weightKg, allergies, allergenClasses, pregnant: pregnant === true };
      const regimen = buildRegimen(q.syndromeKey, facts);
      if (regimen === null) throw new OpdError("unknown_syndrome", `unknown syndrome ${q.syndromeKey}`);
      /* The prescription draft rides the line it came from, so the screen fills a form rather than
         parsing prose in a browser — one implementation, under test, for every client. */
      const lines = regimen.lines.map((l) => ({ ...l, rx: toRxDraft(l) }));
      return { regimen: { ...regimen, lines }, cards: cardsFor(regimen, facts, sex), facts: { weightKg, ageYears, allergies, pregnant } };
    } catch (e) {
      toHttp(e);
    }
  }
}
