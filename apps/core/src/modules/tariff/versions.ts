import { and, desc, eq, lte, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { tariffItems, tariffVersions } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApproval } from "../../kernel/approvals/worklist";
import { assertPaise } from "./money";
import { TariffError } from "./errors";
import { tariffRevisionApplied } from "./events";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * Registered as DATA at go-live (runbook, T10 docs); tests register it inline, exactly the
 * merge.ts precedent (§11.5). v1 registers a single approver role "owner" — the shipped flow
 * builder supports exactly one approver role; the §10.4 two-key (owner + Medical
 * Superintendent) upgrade is definition-data at go-live, not code (D5).
 */
export const TARIFF_REVISION_APPROVAL_TYPE = "tariff_revision";

export type TariffVersionRow = typeof tariffVersions.$inferSelect;
export type TariffItemRow = typeof tariffItems.$inferSelect;

/** A revision is always a new draft, optionally seeded from a prior version's items (new ids, D5). */
export async function createDraftVersion(
  tx: Tx,
  actor: Actor,
  input?: { notes?: string; copyFromVersionId?: string },
): Promise<{ versionId: string; versionNo: number }> {
  const latest = await tx
    .select({ versionNo: tariffVersions.versionNo })
    .from(tariffVersions)
    .orderBy(desc(tariffVersions.versionNo))
    .limit(1);
  const versionNo = (latest[0]?.versionNo ?? 0) + 1;
  const versionId = newId();
  // tariff_versions_no_ux is the race backstop — a raw 23505 escaping this read-then-write
  // is acceptable under concurrent drafting (services.ts precedent).
  await tx.insert(tariffVersions).values({
    id: versionId,
    versionNo,
    status: "draft",
    notes: input?.notes ?? null,
    createdBy: actor.id,
  });

  if (input?.copyFromVersionId !== undefined) {
    const sourceItems = await tx
      .select()
      .from(tariffItems)
      .where(eq(tariffItems.versionId, input.copyFromVersionId));
    if (sourceItems.length > 0) {
      await tx.insert(tariffItems).values(
        sourceItems.map((item) => ({
          id: newId(),
          versionId,
          serviceId: item.serviceId,
          pricePaise: item.pricePaise,
          updatedBy: actor.id,
        })),
      );
    }
  }

  return { versionId, versionNo };
}

/** Writable only while draft (D5) — any other status refuses with not_draft. */
export async function setTariffItem(
  tx: Tx,
  actor: Actor,
  versionId: string,
  serviceId: string,
  pricePaise: number,
): Promise<void> {
  assertPaise(pricePaise, "pricePaise");
  const rows = await tx
    .select({ status: tariffVersions.status })
    .from(tariffVersions)
    .where(eq(tariffVersions.id, versionId));
  const version = rows[0];
  if (!version) throw new TariffError("unknown_version", `unknown tariff version ${versionId}`);
  if (version.status !== "draft") {
    throw new TariffError(
      "not_draft",
      `version ${versionId} is ${version.status}, not draft — items are writable only while draft`,
    );
  }

  await tx
    .insert(tariffItems)
    .values({ id: newId(), versionId, serviceId, pricePaise, updatedBy: actor.id })
    .onConflictDoUpdate({
      target: [tariffItems.versionId, tariffItems.serviceId],
      set: { pricePaise, updatedBy: actor.id, updatedAt: new Date() },
    });
}

/**
 * Class-A per §11.11: requires >=1 item (empty_version, checked BEFORE the flip so a refused
 * submit leaves the version untouched), flips draft -> submitted with a conditional UPDATE,
 * then requestApproval on the SAME tx (request-on-submit, D5).
 */
export async function submitVersion(
  tx: Tx,
  actor: Actor,
  versionId: string,
  requestNote?: string,
): Promise<{ approvalId: string; instanceId: string }> {
  const rows = await tx.select().from(tariffVersions).where(eq(tariffVersions.id, versionId));
  const version = rows[0];
  if (!version) throw new TariffError("unknown_version", `unknown tariff version ${versionId}`);
  if (version.status !== "draft") {
    throw new TariffError("not_draft", `version ${versionId} is ${version.status}, not draft`);
  }

  const items = await tx.select({ id: tariffItems.id }).from(tariffItems).where(eq(tariffItems.versionId, versionId));
  if (items.length === 0) throw new TariffError("empty_version", `version ${versionId} has no tariff items`);

  const claimed = await tx
    .update(tariffVersions)
    .set({ status: "submitted", submittedBy: actor.id, submittedAt: new Date() })
    .where(and(eq(tariffVersions.id, versionId), eq(tariffVersions.status, "draft")))
    .returning({ id: tariffVersions.id });
  if (claimed.length === 0) throw new TariffError("not_draft", `version ${versionId} changed concurrently`);

  const { approvalId, instanceId } = await requestApproval(tx, actor, {
    typeKey: TARIFF_REVISION_APPROVAL_TYPE,
    subject: { type: "tariff_version", id: versionId },
    requestNote,
  });

  // approval_id is plain text with NO FK — the patient_merge_requests §3.12 precedent (the
  // tariff tables form one self-contained TRUNCATE group).
  await tx.update(tariffVersions).set({ approvalId }).where(eq(tariffVersions.id, versionId));

  return { approvalId, instanceId };
}

/**
 * Check-on-execute (merge.ts:85-102 pattern): the approvals row is read at execution time,
 * never consumed as an event (no scheduled dispatch cycle until Plan 11). Gate order, exactly
 * D5: not_submitted -> approval_not_granted/approval_rejected -> sod_drafter_activator, THEN
 * inside withTx: serialize against other activations, re-check monotonicity, single-winner
 * conditional UPDATE, then tariff.revision_applied.
 */
export async function activateVersion(
  db: Db,
  actor: Actor,
  versionId: string,
  effectiveFrom: Date,
): Promise<{ versionNo: number; effectiveFrom: Date }> {
  const rows = await db.select().from(tariffVersions).where(eq(tariffVersions.id, versionId));
  const version = rows[0];
  if (!version) throw new TariffError("unknown_version", `unknown tariff version ${versionId}`);
  if (version.status !== "submitted") {
    throw new TariffError("not_submitted", `version ${versionId} is ${version.status}, not submitted`);
  }

  const approval = version.approvalId === null ? null : await getApproval(db, version.approvalId);
  if (!approval || approval.status === "pending") {
    throw new TariffError("approval_not_granted", `approval for version ${versionId} has not been granted yet`);
  }
  if (approval.status === "rejected") {
    // Belt update: marks the version terminal so a repeat attempt lands on not_submitted, not
    // a second approval_rejected — the same single-winner conditional-UPDATE grammar as below.
    await db
      .update(tariffVersions)
      .set({ status: "rejected" })
      .where(and(eq(tariffVersions.id, versionId), eq(tariffVersions.status, "submitted")));
    throw new TariffError("approval_rejected", `approval for version ${versionId} was rejected`);
  }

  // Direct SoD check (D5) — the activator must be neither the drafter nor the submitter.
  if (actor.id === version.createdBy || actor.id === version.submittedBy) {
    throw new TariffError(
      "sod_drafter_activator",
      `activator must not be the drafter or submitter of version ${versionId}`,
    );
  }

  return withTx(db, async (tx) => {
    // Serializes against any OTHER version's concurrent activation so the monotonicity
    // re-check below sees a consistent activated set (D5).
    await tx.execute(sql`select id from tariff_versions where status = 'activated' for update`);

    const activated = await tx
      .select({ effectiveFrom: tariffVersions.effectiveFrom })
      .from(tariffVersions)
      .where(eq(tariffVersions.status, "activated"));
    const notMonotone = activated.some((r) => r.effectiveFrom !== null && r.effectiveFrom >= effectiveFrom);
    if (notMonotone) {
      throw new TariffError(
        "effective_from_not_monotone",
        `effectiveFrom must be strictly greater than every previously-activated version's effectiveFrom`,
      );
    }

    const claimed = await tx
      .update(tariffVersions)
      .set({ status: "activated", activatedBy: actor.id, activatedAt: new Date(), effectiveFrom })
      .where(and(eq(tariffVersions.id, versionId), eq(tariffVersions.status, "submitted")))
      .returning({ versionNo: tariffVersions.versionNo });
    if (claimed.length === 0) {
      throw new TariffError("not_submitted", `version ${versionId} was activated or changed concurrently`);
    }

    const items = await tx.select({ id: tariffItems.id }).from(tariffItems).where(eq(tariffItems.versionId, versionId));

    await appendEvent(
      tx,
      tariffRevisionApplied.make({
        actor,
        correlationId: approval.instanceId, // §10.5: correlation = the backing workflow instance
        payload: {
          versionId,
          versionNo: claimed[0]!.versionNo,
          effectiveFrom: effectiveFrom.toISOString(),
          approvalId: version.approvalId!,
          itemCount: items.length,
        },
      }),
    );

    return { versionNo: claimed[0]!.versionNo, effectiveFrom };
  });
}

/** The lock (D5): the activated version with the greatest effectiveFrom <= at (equal included). */
export async function resolveActiveTariffVersion(
  db: Db,
  at: Date,
): Promise<{ versionId: string; versionNo: number } | null> {
  const rows = await db
    .select({ id: tariffVersions.id, versionNo: tariffVersions.versionNo })
    .from(tariffVersions)
    .where(and(eq(tariffVersions.status, "activated"), lte(tariffVersions.effectiveFrom, at)))
    .orderBy(desc(tariffVersions.effectiveFrom))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { versionId: row.id, versionNo: row.versionNo };
}

export async function getVersion(
  db: Db,
  versionId: string,
): Promise<{ version: TariffVersionRow; items: TariffItemRow[] } | null> {
  const rows = await db.select().from(tariffVersions).where(eq(tariffVersions.id, versionId));
  const version = rows[0];
  if (!version) return null;
  const items = await db.select().from(tariffItems).where(eq(tariffItems.versionId, versionId));
  return { version, items };
}

export async function listVersions(db: Db): Promise<TariffVersionRow[]> {
  return db.select().from(tariffVersions).orderBy(desc(tariffVersions.versionNo));
}
