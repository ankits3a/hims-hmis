import { hasPermission } from "../../kernel/auth/permissions";
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
