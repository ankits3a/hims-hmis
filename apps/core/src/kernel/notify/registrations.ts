import { eq, inArray } from "drizzle-orm";
import { notifyTemplateRegistrations } from "../db/schema";
import { appendEvent } from "../events/append";
import { templateRegistrationRecorded } from "./events";
import { templateByKey } from "./templates";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../db/client";

/**
 * ═══ PHARMACY P6 (patient messages) — THE PROVIDER'S IDS FOR A TEMPLATE, RECORDED ═══
 *
 * The only writer of `notify_template_registrations`. The pump reads a row at send time and hands it
 * to the adapter, which refuses without it (a live DLT gateway needs the content-template id; WhatsApp
 * needs the approved name). A person records them, from what the DLT portal and Meta issued — the
 * caller checks WHO may (a module's own permission) and the SHAPE (a module's own route schema).
 */
export type TemplateRegistration = { templateKey: string; dltTemplateId: string | null; whatsappTemplateName: string | null; updatedAt: Date };

export async function templateRegistrationsOf(exec: Db | Tx, keys: readonly string[]): Promise<Map<string, TemplateRegistration>> {
  if (keys.length === 0) return new Map();
  const rows = await exec.select().from(notifyTemplateRegistrations).where(inArray(notifyTemplateRegistrations.templateKey, [...keys]));
  return new Map(rows.map((r) => [r.templateKey, { templateKey: r.templateKey, dltTemplateId: r.dltTemplateId, whatsappTemplateName: r.whatsappTemplateName, updatedAt: r.updatedAt }]));
}

export async function recordTemplateRegistration(
  tx: Tx,
  actor: Actor,
  templateKey: string,
  ids: { dltTemplateId: string | null; whatsappTemplateName: string | null },
  now: Date,
): Promise<TemplateRegistration> {
  templateByKey(templateKey); // throws on a key the registry does not hold
  if (actor.type !== "user") throw new Error("recordTemplateRegistration: a person records what a portal issued");
  const values = { dltTemplateId: ids.dltTemplateId, whatsappTemplateName: ids.whatsappTemplateName, updatedBy: actor.id, updatedAt: now };
  await tx.insert(notifyTemplateRegistrations).values({ templateKey, ...values })
    .onConflictDoUpdate({ target: notifyTemplateRegistrations.templateKey, set: values });
  await appendEvent(tx, templateRegistrationRecorded.make({ occurredAt: now, actor, payload: { templateKey, ...ids } }));
  const row = (await tx.select().from(notifyTemplateRegistrations).where(eq(notifyTemplateRegistrations.templateKey, templateKey)))[0]!;
  return { templateKey, dltTemplateId: row.dltTemplateId, whatsappTemplateName: row.whatsappTemplateName, updatedAt: row.updatedAt };
}
