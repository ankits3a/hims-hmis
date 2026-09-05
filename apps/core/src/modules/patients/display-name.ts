import { hasPermission } from "../../kernel/auth/permissions";
/* FD-25 — `displayNameForRelease` asks the second of the two questions `getPatient` asks. A
   relative kernel import, exactly as `registration.ts` reaches for `activeBreakGlass`: the
   module-isolation rule (§4) is about reaching into another MODULE, and this file is inside
   `patients` already — an index round-trip through our own barrel would be a cycle. */
import { hasActiveBreakGlass } from "../../kernel/auth/break-glass";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 15 T8 / DD16 / F20 — **THE ONE PLACE A CONFIDENTIAL PATIENT'S NAME IS DECIDED.**
 *
 * §14 gives a confidential patient an `alias`, and registration REFUSES to flag one without it
 * (`alias_required`). What §14 did not have was a single function that applies the rule: `qr.ts`
 * open-coded it (`if (!canSee) name = resolved.alias ?? "—"`), and every future surface that
 * displayed a name would have open-coded it again. That is §2.54 with a VIP's legal name as the
 * fact that drifts — and the surface that got it wrong would be a public one, because public
 * surfaces are the only ones this rule is about.
 *
 * F20 asks for the helper and for a test that a confidential patient's legal name never reaches the
 * OT's list, board or recovery DTOs. This is the helper; `display-name.test.ts` and
 * `ot/lists.test.ts` are the test.
 *
 * ═══ KEYED ON THE PERMISSION, NOT ON A ROLE ═══
 *
 * DD16 wrote the signature as `displayName(patient, viewerRole)`. It is keyed on
 * `patients.confidential.read` instead, because that is what every other confidentiality check in
 * this system asks (`registration.ts` twice, `qr.ts`, `search-provider.ts`), and a helper that
 * asked about a ROLE would be a second authority on who may see a VIP's name — the one place the
 * answer must not be able to disagree with itself. Roles are granted and revoked; the permission is
 * the thing they are granted TO.
 *
 * ═══ THE FALLBACK IS A DASH, NEVER THE LEGAL NAME ═══
 *
 * A confidential patient with no alias cannot exist through registration, but a row written before
 * the constraint, or by a repair script, could. The safe direction is unambiguous: show nothing.
 * Falling back to `name` would mean the one row that slipped past the constraint is the one row
 * that leaks, which is exactly the shape of every confidentiality incident.
 */
export type NameablePatient = { name: string; alias: string | null; isConfidential: boolean };

export function displayName(patient: NameablePatient, canSeeConfidential: boolean): string {
  if (!patient.isConfidential) return patient.name;
  if (canSeeConfidential) return patient.name;
  return patient.alias ?? "—";
}

/**
 * The same rule with the permission looked up for one actor. A `system` actor NEVER sees through
 * the flag: a background job has no business rendering a VIP's legal name, and every existing
 * check in this module treats a non-user actor the same way (`registration.ts:349`).
 */
export async function displayNameFor(
  exec: Db | Tx, actor: Actor, patient: NameablePatient,
): Promise<string> {
  if (!patient.isConfidential) return patient.name;
  const canSee = actor.type === "user"
    ? await hasPermission(exec as Db, actor.id, "patients.confidential.read", "hospital")
    : false;
  return displayName(patient, canSee);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 / OWNER RULING 2026-09-05 — THE SAME RULE, PLUS THE ROAD `getPatient` ALREADY OPENS.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The owner ruled on what a §14 patient's PRINTED SLIP shows: *"alias by default; the LEGAL NAME
 * prints only when the operator goes through the existing break-glass grant, which is already
 * logged."* `displayNameFor` above cannot answer that, and not by oversight — it decides on ONE
 * fact, `patients.confidential.read`, and BREAK-GLASS DOES NOT CONFER THAT PERMISSION. It writes a
 * row in `break_glass_grants`; `hasPermission` has never read that table. The two mechanisms meet
 * in exactly one place today, `registration.ts`'s `getPatient`, which asks them in turn.
 *
 * ═══ WHY THERE ARE NOW TWO, AND NOT ONE WIDENED ONE ═══
 *
 * Widening `displayNameFor` would have been one line and would have changed every surface that
 * calls it — `billing/worklist.ts`, `kernel/orders/read.ts`, the OT's lists and recovery board.
 * The owner ruled about PAPER. Widening who sees a sealed patient's legal name on a BILLING
 * WORKLIST is a different decision, nobody has taken it, and it would have travelled silently
 * inside a print fix. So the two questions get two functions:
 *
 *   · `displayNameFor`        — permission only. The DEFAULT, and what every screen still asks.
 *   · `displayNameForRelease` — permission OR an active break-glass grant for THAT patient. Asked
 *                               by surfaces that RELEASE a whole record or document to a requester
 *                               who has already been let through `getPatient`. Today that is
 *                               `kernel/printing/render.ts`, and nothing else.
 *
 * The naming is the invitation: a future surface that hands over a record — a discharge summary, a
 * records-department release, an export — finds this sibling here, beside the rule, instead of
 * open-coding a second break-glass test of its own. THAT is why the widening lives in this file and
 * not inside the printer: the printer reading `break_glass_grants` directly is exactly the §2.54
 * shape this whole module exists to prevent, with a VIP's legal name as the fact that drifts.
 *
 * ═══ THE WIDER ANSWER IS SAFE BECAUSE IT IS ACCOUNTABLE, NOT BECAUSE IT IS NARROW ═══
 *
 * A grant names one patient (or is explicitly hospital-wide, the shape a 2 a.m. emergency takes),
 * it EXPIRES, and taking one puts the holder on `pendingReviews` with their stated reason attached.
 * The disclosure is logged where it is made: `printing.controller.ts`'s reprint writes
 * `recordPhiAccess(..., reason: found.breakGlass?.reason)` — the justification, not merely the
 * fact. Without that trail this would be a widening; with it, it is a road with a toll booth.
 *
 * And the alternative was worse than wide. Before this, an operator who opened a sealed record
 * THROUGH break-glass — reading the legal name on `GET /patients/:id` at that very moment — was
 * handed paper saying "Patient A". Paper disagreeing with the screen beside it is not a narrower
 * seal; it is a second authority on one question, and the operator settles it by writing the legal
 * name onto the slip in pen, where nothing logs it at all.
 *
 * ═══ THE ACTOR'S TYPE IS CHECKED FIRST, AND NOT FOR THE REASON THIS COMMENT USED TO GIVE ═══
 *
 * **CORRECTED AT THE FD-25 CLOSE.** This paragraph asserted that `break_glass_grants.user_id` is
 * "plain text with no foreign key" and that an id-first check would therefore let a machine inherit
 * a person's justification. **The column carries a real FK to `users.id`** (`schema/auth.ts`), so a
 * grant row for an agent or a batch id cannot be inserted at all, and the close review that
 * repeated the claim inherited the error from here. A stated reason that is false is worse than no
 * reason: the next reader either builds on it or deletes the guard when they discover it.
 *
 * The order stays, on two reasons that ARE true. First, it is the SAME RULE `displayNameFor` states
 * one function above — a non-user actor never sees through the flag — and that is a policy about
 * who may read a VIP's name, not a shortcut: the print relay's agent credential is the one machine
 * credential that reaches a rendered document, and it must get the alias whatever any table says.
 * Second, a guard that leans on a constraint in ANOTHER table is a guard a migration can silently
 * remove; this one holds on its own. It also saves two reads for every machine-rendered document,
 * which is the least interesting thing about it.
 */
export async function displayNameForRelease(
  exec: Db | Tx, actor: Actor, patient: NameablePatient, patientId: string,
): Promise<string> {
  if (!patient.isConfidential) return patient.name;
  if (actor.type !== "user") return displayName(patient, false);
  /*
    Permission first, grant second — `getPatient` asks them in this order and for the same reason:
    the standing permission is the common case and costs one already-cached read, while the grants
    table is only worth touching for the operator who has none. `hasActiveBreakGlass` rather than
    `activeBreakGlass` because a NAME needs the answer, not the justification; the justification is
    read where the disclosure is LOGGED, which is the caller's job and not this rule's.
  */
  const canSee = await hasPermission(exec as Db, actor.id, "patients.confidential.read", "hospital")
    || await hasActiveBreakGlass(exec as Db, actor.id, patientId);
  return displayName(patient, canSee);
}
