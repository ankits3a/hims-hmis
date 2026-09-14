import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { opdAdviceTemplates } from "../../kernel/db/schema";
import { OpdError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ THE ADVICE LIBRARY ═══
 *
 * Owner, 2026-09-14: *"a prefilled template saved as a module"*, in a shared library with the
 * doctor's own favourites on top, and the doctor choosing the LANGUAGE per template.
 *
 * This is the one field the patient reads. It prints on the e-Rx verbatim, so whichever script the
 * doctor taps is the script that reaches the person it is written for.
 */
export type AdviceTemplate = {
  id: string;
  title: string;
  /** Either may be null and at least one is not — the table's own CHECK. */
  textEn: string | null;
  textHi: string | null;
  /** True when this doctor saved it; the screen groups on this and the list is sorted by it. */
  mine: boolean;
};

export type NewAdviceTemplate = { title: string; textEn?: string | null; textHi?: string | null };

/**
 * The doctor's own templates first, then the hospital's. One query, ordered in SQL so every caller
 * gets the same order — a list re-sorted in a browser is a list that is sorted differently on the
 * next screen that reads it.
 */
export async function listAdviceTemplates(db: Db, actor: Actor): Promise<AdviceTemplate[]> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "the advice library is a desk surface");
  const rows = await db
    .select()
    .from(opdAdviceTemplates)
    .where(and(
      eq(opdAdviceTemplates.active, true),
      or(isNull(opdAdviceTemplates.ownerUserId), eq(opdAdviceTemplates.ownerUserId, actor.id)),
    ))
    .orderBy(sql`(${opdAdviceTemplates.ownerUserId} is null) asc`, asc(opdAdviceTemplates.title));
  return rows.map((r) => ({
    id: r.id, title: r.title, textEn: r.textEn, textHi: r.textHi,
    mine: r.ownerUserId === actor.id,
  }));
}

/**
 * Save one of the doctor's own. `owner_user_id` is taken from the ACTOR and is never a parameter:
 * a body that could name an owner is a body that could write into another doctor's library, or
 * into the hospital's.
 */
export async function saveAdviceTemplate(
  tx: Tx, actor: Actor, input: NewAdviceTemplate, now: Date = new Date(),
): Promise<{ templateId: string }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "the advice library is a desk surface");
  const title = input.title.trim();
  const en = (input.textEn ?? "").trim();
  const hi = (input.textHi ?? "").trim();
  /* A title with no text in EITHER script is not a template. One script is enough; none is not. */
  if (title === "" || (en === "" && hi === "")) {
    throw new OpdError("advice_template_incomplete", "a template needs a title and text in at least one script");
  }
  const id = newId();
  await tx.insert(opdAdviceTemplates).values({
    id, ownerUserId: actor.id, title, textEn: en === "" ? null : en, textHi: hi === "" ? null : hi,
    createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now,
  });
  return { templateId: id };
}

/**
 * Retire one of the doctor's OWN. Deactivated rather than deleted — a template that printed on a
 * patient's slip last week is part of why that slip says what it says.
 *
 * A doctor cannot retire the hospital's rows: this is a library, not a shared document, and one
 * doctor removing an entry every other doctor uses is the failure mode a seat-level surface has.
 * The `owner_user_id = actor.id` in the WHERE is the enforcement; the count is what reports it.
 */
export async function retireAdviceTemplate(
  tx: Tx, actor: Actor, templateId: string, now: Date = new Date(),
): Promise<void> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "the advice library is a desk surface");
  const rows = await tx
    .update(opdAdviceTemplates)
    .set({ active: false, updatedBy: actor.id, updatedAt: now })
    .where(and(
      eq(opdAdviceTemplates.id, templateId),
      eq(opdAdviceTemplates.ownerUserId, actor.id),
      eq(opdAdviceTemplates.active, true),
    ))
    .returning({ id: opdAdviceTemplates.id });
  if (rows.length === 0) {
    /* Not found and not-yours answer the same, so this cannot be used to probe whose row an id is. */
    throw new OpdError("unknown_advice_template", `no template of your own with id ${templateId}`);
  }
}
