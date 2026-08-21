import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { idempotencyKeys } from "../../kernel/db/schema";
import { sha256Hex } from "../../kernel/crypto";
import { BillingError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * SERVER-SIDE IDEMPOTENCY for the module's document-creating writes.
 *
 * `SubmitButton` (apps/web) makes a double click impossible inside one tab. It cannot help with a
 * page reload, a second tab, or a request the network duplicates after the client stopped waiting
 * — and none of those are exotic on a counter with one flaky uplink. Only the server can refuse to
 * do the same work twice, and only by remembering what it already did.
 *
 * THE CLAIM IS TAKEN BEFORE THE WORK. `INSERT ... ON CONFLICT DO NOTHING` is the arbiter (the
 * `daily_closes` precedent, D9): the request that wins the insert owns the work, and a CONCURRENT
 * duplicate loses it and never reaches the write path. Recording the key after the work would be
 * too late — by then both requests have already issued a document, which is the whole defect.
 *
 * A REPLAY RETURNS THE ORIGINAL RESULT, NOT A REFUSAL. A cashier who reloads mid-payment must see
 * the receipt she already took; answering 409 would tell her the payment failed when the hospital
 * has her money. `request_hash` is what makes that safe: the same key against a DIFFERENT body is
 * a client bug, and it is refused rather than silently answered with an unrelated document.
 *
 * WHAT THE REPLAY RETURNS IS THE SERIALIZED RESULT. `response` is jsonb, so a `Date` comes back as
 * its ISO string rather than a `Date`. At the HTTP boundary — the only place this is used — the
 * bytes are identical, because a fresh result is serialized the same way on its way out. Do not
 * call this helper from a service that consumes the value in-process and expects live types.
 *
 * NO KEY MEANS NO PROTECTION, DELIBERATELY. The header is optional: making it mandatory would be a
 * breaking API change for every existing caller and would have turned this into a flag day. The
 * cost is that protection depends on clients actually sending one, which is a §3.34 risk — so the
 * web client mints the key in ONE place and a test owns that, rather than thirteen call sites
 * remembering to.
 */

/** Stable JSON: object keys sorted at every depth, so key ORDER cannot change the hash. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** The hash a replay is checked against — exported so tests can pin the canonicalization. */
export function requestHashOf(body: unknown): string {
  return sha256Hex(canonical(body));
}

/**
 * Run `work` at most once per (actor, route, key).
 *
 * `key` is the caller's `Idempotency-Key` header. When it is absent the work simply runs — the
 * pre-existing behaviour, unchanged.
 */
export async function withIdempotency<T>(
  db: Db,
  scope: { actorId: string; route: string; key: string | undefined },
  body: unknown,
  work: () => Promise<T>,
  now: Date = new Date(),
): Promise<T> {
  const { actorId, route, key } = scope;
  if (key === undefined || key.trim() === "") return await work();

  const requestHash = requestHashOf(body);
  const claimId = newId();

  const claimed = await db
    .insert(idempotencyKeys)
    .values({ id: claimId, actorId, route, key, requestHash, state: "in_progress", claimedAt: now })
    .onConflictDoNothing({ target: [idempotencyKeys.actorId, idempotencyKeys.route, idempotencyKeys.key] })
    .returning({ id: idempotencyKeys.id });

  if (claimed.length === 0) return await replay(db, { actorId, route, key }, requestHash);

  try {
    const result = await work();
    await db
      .update(idempotencyKeys)
      .set({ state: "done", response: result as unknown, completedAt: now })
      .where(eq(idempotencyKeys.id, claimId));
    return result;
  } catch (e) {
    /*
     * A FAILED WRITE MUST NOT HOLD THE KEY. The cashier's next action after a refusal she can
     * correct (`pan_required`, `cash_threshold_blocked`, `over_cap`) is to fix the body and press
     * the same button — and the client reuses the key for a retry of the same attempt. Leaving the
     * claim would answer that corrected retry with `idempotency_key_reused` and strand her, which
     * is §3.44's "the fix becomes the next defect" exactly.
     */
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, claimId));
    throw e;
  }
}

/** The key already exists: serve the original result, or refuse if it is not the same request. */
async function replay<T>(
  db: Db,
  scope: { actorId: string; route: string; key: string },
  requestHash: string,
): Promise<T> {
  const [row] = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.actorId, scope.actorId),
        eq(idempotencyKeys.route, scope.route),
        eq(idempotencyKeys.key, scope.key),
      ),
    )
    .limit(1);

  if (row === undefined) {
    /*
     * The claim conflicted and then vanished — the owner's work failed and deleted it between our
     * INSERT and this SELECT. That is a genuine race with a correct outcome available: the work
     * was NOT done, so refusing is wrong and so is replaying. Ask the caller to retry.
     */
    throw new BillingError(
      "idempotency_key_in_progress",
      `the request holding Idempotency-Key ${scope.key} is still settling — retry with the same key`,
      { route: scope.route },
    );
  }

  if (row.requestHash !== requestHash) {
    throw new BillingError(
      "idempotency_key_reused",
      `Idempotency-Key ${scope.key} was already used on ${scope.route} with a different request body`,
      { route: scope.route, key: scope.key },
    );
  }

  if (row.state !== "done") {
    throw new BillingError(
      "idempotency_key_in_progress",
      `the request holding Idempotency-Key ${scope.key} has not finished — retry with the same key`,
      { route: scope.route },
    );
  }

  return row.response as T;
}
