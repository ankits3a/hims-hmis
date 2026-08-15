import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events, tariffVersions } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, createRole } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { approvalFlowDefinition } from "../../kernel/approvals/flow";
import { registerApprovalType } from "../../kernel/approvals/types";
import { approveRequest } from "../../kernel/approvals/decisions";
import { createDraft, activateDefinition } from "../../kernel/workflow/definitions";
import { createService } from "./services";
import {
  TARIFF_REVISION_APPROVAL_TYPE,
  activateVersion,
  createDraftVersion,
  setTariffItem,
  submitVersion,
} from "./versions";
import type { Pool } from "pg";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * Audit A2 (CRITICAL test gap): the shipped cross-version race test asserts one winner, one
 * activated row, one event and a typed loser — and migration 0008's partial unique index
 * enforces every one of those with the serializer reverted OR deleted outright (both mutants
 * passed 10/10 isolated). Three layers of verification measured something that cannot tell the
 * implementations apart. This suite observes the LOCK itself instead of the invariant the index
 * backstops: with an external session holding a row that only the serializer's ordered set lock
 * reaches, a real activateVersion MUST still be waiting; a serializer-less one settles
 * immediately.
 * Riding along is m8 — the forced interleave is the only path that gets a loser as far as the
 * in-transaction monotonicity re-check, where `ne(id, versionId)` lives.
 */
describe("tariff versions — controlled contention: the serializer is observable (A2, m8)", () => {
  let db: Db;
  let pool: Pool;
  let teardown: () => Promise<void>;
  let drafter: Actor;
  let activator: Actor;
  let owner: Actor;
  let s1: string;
  let s2: string;

  beforeAll(async () => {
    ({ db, pool, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);

    // Two-step type registration — EXACTLY the go-live runbook flow (merge.test.ts precedent):
    // builder -> Plan 03 draft -> activate (Class C; drafter != activator SoD) -> registerApprovalType.
    const drafterUser = await createUser(db, { username: "drafter", fullName: "Drafter", password: "p1234567" });
    const activatorUser = await createUser(db, { username: "activator", fullName: "Activator", password: "p1234567" });
    const ownerUser = await createUser(db, { username: "owner_user", fullName: "Owner", password: "p1234567" });
    drafter = { type: "user", id: drafterUser.id };
    activator = { type: "user", id: activatorUser.id };
    owner = { type: "user", id: ownerUser.id };

    await createRole(db, "owner", "Owner");
    await assignRole(db, { userId: ownerUser.id, roleKey: "owner", scopeType: "hospital" });

    const def = approvalFlowDefinition({
      typeKey: TARIFF_REVISION_APPROVAL_TYPE,
      title: "Tariff Revision",
      approverRole: "owner",
      closureSlaMinutes: 1440,
    });
    const draftDef = await createDraft(db, drafter, def);
    await activateDefinition(db, activator, draftDef.definitionId);
    await registerApprovalType(db, activator, {
      typeKey: TARIFF_REVISION_APPROVAL_TYPE,
      title: "Tariff Revision",
      approverRole: "owner",
      urgencyClass: "routine",
      actFirstAllowed: false,
    });

    const svc1 = await withTx(db, (tx) =>
      createService(tx, drafter, { code: "SVC-1", name: "Consultation", category: "consultation" }),
    );
    const svc2 = await withTx(db, (tx) =>
      createService(tx, drafter, { code: "SVC-2", name: "X-Ray", category: "procedure" }),
    );
    s1 = svc1.serviceId;
    s2 = svc2.serviceId;
  });

  async function mkDraft(prices: [string, number][]): Promise<{ versionId: string; versionNo: number }> {
    return withTx(db, async (tx) => {
      const draft = await createDraftVersion(tx, drafter, {});
      for (const [serviceId, price] of prices) {
        await setTariffItem(tx, drafter, draft.versionId, serviceId, price);
      }
      return draft;
    });
  }

  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const SET_LOCK_SQL = "select id from tariff_versions where status in ('submitted', 'activated') order by id for update";

  it("the ordered set lock is REAL: an activation BLOCKS while another session holds it, and completes after release", async () => {
    const draft = await mkDraft([[s1, 10000]]);
    const submitted = await withTx(db, (tx) => submitVersion(tx, drafter, draft.versionId));
    await approveRequest(db, owner, { approvalId: submitted.approvalId, note: "approved" });

    // The held row must be one the SERIALIZER needs and a serializer-less activateVersion never
    // touches. Holding the TARGET's own row cannot discriminate: the single-winner conditional
    // UPDATE (`where id = versionId and status = 'submitted'`) takes an exclusive lock on that
    // same row in BOTH implementations, so both block and "pending" is true either way
    // (measured — Mutant A SURVIVED 5/5 against that shape). A SECOND submitted version sits
    // inside the serializer's `status in ('submitted','activated')` predicate and outside
    // everything the target's own activation reads or writes.
    const other = await mkDraft([[s2, 20000]]);
    const otherSubmitted = await withTx(db, (tx) => submitVersion(tx, drafter, other.versionId));
    await approveRequest(db, owner, { approvalId: otherSubmitted.approvalId, note: "approved" });

    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from tariff_versions where id = $1 for update", [other.versionId]);
      const p = activateVersion(db, activator, draft.versionId, new Date("2026-02-01T00:00:00Z"));
      p.catch(() => {}); // no unhandled rejection while unobserved
      // Audit A2's exact gap: the old race test could not see whether this lock exists. A
      // serializer-less activateVersion sails past a held lock and settles immediately; the
      // shipped one MUST still be waiting after 400 ms.
      const state = await Promise.race([p.then(() => "settled", () => "settled"), delay(400).then(() => "pending")]);
      expect(state).toBe("pending");
      await holder.query("commit");
      const result = await p;
      expect(result.versionNo).toBe(1);
    } finally {
      holder.release();
    }
    // Only the target ever activates — the second version stays submitted — so both invariants
    // still read exactly 1.
    const activatedRows = await db.select().from(tariffVersions).where(eq(tariffVersions.status, "activated"));
    expect(activatedRows).toHaveLength(1);
    const eventRows = await db.select().from(events).where(eq(events.name, "tariff.revision_applied"));
    expect(eventRows).toHaveLength(1);
  });

  it("forced same-version contention: both racers pass the pre-checks, the loser reaches the IN-TX arbiter and is typed not_submitted", async () => {
    const draft = await mkDraft([[s1, 10000]]);
    const submitted = await withTx(db, (tx) => submitVersion(tx, drafter, draft.versionId));
    await approveRequest(db, owner, { approvalId: submitted.approvalId, note: "approved" });
    const secondUser = await createUser(db, { username: "activator2", fullName: "Activator Two", password: "p1234567" });
    const second: Actor = { type: "user", id: secondUser.id };

    const holder = await pool.connect();
    // Initialized empty: TypeScript's definite-assignment analysis does not credit a try-block
    // assignment, and an aborted try then fails LOUDLY at the length assertion below.
    let results: PromiseSettledResult<{ versionNo: number; effectiveFrom: Date }>[] = [];
    try {
      await holder.query("begin");
      await holder.query(SET_LOCK_SQL);
      // Both racers pass the PRE-tx checks (the row is still 'submitted' — nobody can commit
      // while the lock is held) and queue on the serializer. The natural Promise.allSettled race
      // never reliably reaches this state: its loser usually dies at the pre-tx status check
      // (ledger §3.22 — the second racer systematically lags). This interleave is forced.
      const w = activateVersion(db, activator, draft.versionId, new Date("2026-02-01T00:00:00Z"));
      w.catch(() => {});
      await delay(150);
      const l = activateVersion(db, second, draft.versionId, new Date("2026-02-01T00:00:00Z"));
      l.catch(() => {});
      await delay(150);
      await holder.query("commit");
      results = await Promise.allSettled([w, l]);
    } finally {
      holder.release();
    }

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    expect(fulfilled).toHaveLength(1);
    expect(loser).toBeDefined();
    // The loser proceeds only after the winner COMMITTED, so its monotonicity re-check sees the
    // version's own row activated at the SAME date — and must exclude it (`ne(id, versionId)`,
    // §3.21's second half / audit m8) to fall through to the single-winner conditional UPDATE,
    // whose 0-row answer is the one honest loser code. Without the exclusion the loser dies
    // effective_from_not_monotone — this assertion is what makes the ne() clause undeletable.
    expect(loser!.reason.code).toBe("not_submitted");

    const activatedRows = await db.select().from(tariffVersions).where(eq(tariffVersions.status, "activated"));
    expect(activatedRows).toHaveLength(1);
    const eventRows = await db.select().from(events).where(eq(events.name, "tariff.revision_applied"));
    expect(eventRows).toHaveLength(1);
  });
});
