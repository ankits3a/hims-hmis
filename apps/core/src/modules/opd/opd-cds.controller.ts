import { Controller, Get, Inject, Query } from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { getPatient, listAllergies } from "../patients";
import { buildRegimen, cardsFor, rankSyndromes, toRxDraft } from "../cds";
import type { BuiltLine, BuiltRegimen, Card, PatientFacts, RxDraftLine, SyndromeHit } from "../cds";
import { getEncounter } from "./encounters";
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
  suggest(@Query() query: unknown): { items: SyndromeHit[] } {
    const q = parsed(suggestQuery, query);
    return { items: rankSyndromes(q.complaint) };
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
      const allergies = (await listAllergies(this.db, encounter.patientId))
        .filter((a) => a.status === "active")
        .map((a) => a.substance);

      const pregnant = q.pregnant === undefined ? null : q.pregnant === "true";
      const facts: PatientFacts = { ageYears, weightKg, allergies, pregnant: pregnant === true };
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
