import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events, tariffVersions } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, createRole } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { approvalFlowDefinition } from "../../kernel/approvals/flow";
import { registerApprovalType } from "../../kernel/approvals/types";
import { approveRequest, rejectRequest } from "../../kernel/approvals/decisions";
import { createDraft, activateDefinition } from "../../kernel/workflow/definitions";
import { createService } from "./services";
import {
  TARIFF_REVISION_APPROVAL_TYPE,
  activateVersion,
  createDraftVersion,
  getVersion,
  resolveActiveTariffVersion,
  setTariffItem,
  submitVersion,
} from "./versions";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

describe("tariff versions — draft/submit/activate via approvals, tariff-lock (D5, §11.11)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let drafter: Actor;
  let activator: Actor;
  let owner: Actor;
  let s1: string;
  let s2: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
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

  it("happy path end-to-end: draft -> items -> submit -> approve -> activate; exactly one event, exact payload", async () => {
    const draft = await mkDraft([
      [s1, 10000],
      [s2, 20000],
    ]);
    const submitted = await withTx(db, (tx) => submitVersion(tx, drafter, draft.versionId, "go-live v1"));
    const afterSubmit = await getVersion(db, draft.versionId);
    expect(afterSubmit!.version.status).toBe("submitted");

    await approveRequest(db, owner, { approvalId: submitted.approvalId, note: "approved for go-live" });

    const effectiveFrom = new Date("2026-02-01T00:00:00Z");
    const result = await activateVersion(db, activator, draft.versionId, effectiveFrom);
    expect(result.versionNo).toBe(1);
    expect(result.effectiveFrom).toEqual(effectiveFrom);

    const afterActivate = await getVersion(db, draft.versionId);
    expect(afterActivate!.version.status).toBe("activated");
    expect(afterActivate!.version.effectiveFrom).toEqual(effectiveFrom);

    const eventRows = await db.select().from(events).where(eq(events.name, "tariff.revision_applied"));
    expect(eventRows.length).toBe(1);
    expect(eventRows[0]!.payload).toEqual({
      versionId: draft.versionId,
      versionNo: 1,
      effectiveFrom: effectiveFrom.toISOString(),
      approvalId: submitted.approvalId,
      itemCount: 2,
    });
  });

  it("activate while pending -> approval_not_granted; after reject -> approval_rejected, version marked rejected", async () => {
    const draft = await mkDraft([[s1, 10000]]);
    const submitted = await withTx(db, (tx) => submitVersion(tx, drafter, draft.versionId));

    await expect(activateVersion(db, activator, draft.versionId, new Date("2026-02-01T00:00:00Z"))).rejects.toMatchObject({
      code: "approval_not_granted",
    });

    await rejectRequest(db, owner, { approvalId: submitted.approvalId, note: "not this cycle" });

    await expect(activateVersion(db, activator, draft.versionId, new Date("2026-02-01T00:00:00Z"))).rejects.toMatchObject({
      code: "approval_rejected",
    });

    const after = await getVersion(db, draft.versionId);
    expect(after!.version.status).toBe("rejected");
  });

  it("SoD separates from approval state: granted first, drafter blocked, a third eligible user succeeds", async () => {
    const draft = await mkDraft([[s1, 10000]]);
    const submitted = await withTx(db, (tx) => submitVersion(tx, drafter, draft.versionId));

    // Approval is GRANTED before the drafter's attempt — proves the refusal below is SoD, not
    // pending-approval state (§3.14b: the ordering IS the discriminator).
    await approveRequest(db, owner, { approvalId: submitted.approvalId, note: "approved" });

    await expect(activateVersion(db, drafter, draft.versionId, new Date("2026-02-01T00:00:00Z"))).rejects.toMatchObject({
      code: "sod_drafter_activator",
    });

    const result = await activateVersion(db, activator, draft.versionId, new Date("2026-02-01T00:00:00Z"));
    expect(result.versionNo).toBe(1);
    const after = await getVersion(db, draft.versionId);
    expect(after!.version.status).toBe("activated");
  });

  it("setTariffItem after submit -> not_draft; assertPaise rejects float and negative prices", async () => {
    const draft = await mkDraft([[s1, 10000]]);
    await withTx(db, (tx) => submitVersion(tx, drafter, draft.versionId));

    await expect(withTx(db, (tx) => setTariffItem(tx, drafter, draft.versionId, s2, 5000))).rejects.toMatchObject({
      code: "not_draft",
    });

    const draft2 = await withTx(db, (tx) => createDraftVersion(tx, drafter, {}));
    await expect(withTx(db, (tx) => setTariffItem(tx, drafter, draft2.versionId, s1, 1.5))).rejects.toMatchObject({
      code: "invalid_paise",
    });
    await expect(withTx(db, (tx) => setTariffItem(tx, drafter, draft2.versionId, s1, -1))).rejects.toMatchObject({
      code: "invalid_paise",
    });
  });

  it("submit with zero items -> empty_version, and the check precedes the flip (status stays draft)", async () => {
    const draft = await withTx(db, (tx) => createDraftVersion(tx, drafter, {}));
    await expect(withTx(db, (tx) => submitVersion(tx, drafter, draft.versionId))).rejects.toMatchObject({
      code: "empty_version",
    });
    const after = await getVersion(db, draft.versionId);
    expect(after!.version.status).toBe("draft");
  });

  it("monotone effectiveFrom: equal-or-earlier than an activated version is refused, strictly later succeeds", async () => {
    const v1 = await mkDraft([[s1, 10000]]);
    const sub1 = await withTx(db, (tx) => submitVersion(tx, drafter, v1.versionId));
    await approveRequest(db, owner, { approvalId: sub1.approvalId, note: "approved" });
    await activateVersion(db, activator, v1.versionId, new Date("2026-02-01T00:00:00Z"));

    const v2 = await mkDraft([[s1, 12000]]);
    const sub2 = await withTx(db, (tx) => submitVersion(tx, drafter, v2.versionId));
    await approveRequest(db, owner, { approvalId: sub2.approvalId, note: "approved" });

    await expect(activateVersion(db, activator, v2.versionId, new Date("2026-02-01T00:00:00Z"))).rejects.toMatchObject({
      code: "effective_from_not_monotone",
    });

    const result = await activateVersion(db, activator, v2.versionId, new Date("2026-03-01T00:00:00Z"));
    expect(result.versionNo).toBe(2);
  });

  it("resolution boundary: greatest effectiveFrom <= at (equal included); an old date still resolves the old version", async () => {
    const v1 = await mkDraft([[s1, 10000]]);
    const sub1 = await withTx(db, (tx) => submitVersion(tx, drafter, v1.versionId));
    await approveRequest(db, owner, { approvalId: sub1.approvalId, note: "approved" });
    await activateVersion(db, activator, v1.versionId, new Date("2026-02-01T00:00:00Z"));

    expect(await resolveActiveTariffVersion(db, new Date("2026-02-01T00:00:00Z"))).toEqual({
      versionId: v1.versionId,
      versionNo: 1,
    });
    expect(await resolveActiveTariffVersion(db, new Date("2026-01-31T00:00:00Z"))).toBeNull();

    const v2 = await mkDraft([[s1, 12000]]);
    const sub2 = await withTx(db, (tx) => submitVersion(tx, drafter, v2.versionId));
    await approveRequest(db, owner, { approvalId: sub2.approvalId, note: "approved" });
    await activateVersion(db, activator, v2.versionId, new Date("2026-03-01T00:00:00Z"));

    // The lock: an older date still resolves the older version even after a newer one activates.
    expect(await resolveActiveTariffVersion(db, new Date("2026-02-15T00:00:00Z"))).toEqual({
      versionId: v1.versionId,
      versionNo: 1,
    });
    expect(await resolveActiveTariffVersion(db, new Date("2026-03-01T00:00:00Z"))).toEqual({
      versionId: v2.versionId,
      versionNo: 2,
    });
  });

  it("copyFromVersionId copies items into the new draft with new item ids", async () => {
    const v1 = await mkDraft([
      [s1, 10000],
      [s2, 20000],
    ]);
    const v2 = await withTx(db, (tx) => createDraftVersion(tx, drafter, { copyFromVersionId: v1.versionId }));

    const v1Full = await getVersion(db, v1.versionId);
    const v2Full = await getVersion(db, v2.versionId);
    expect(v2Full!.items.length).toBe(2);
    expect(v2Full!.items.find((i) => i.serviceId === s1)?.pricePaise).toBe(10000);
    expect(v2Full!.items.find((i) => i.serviceId === s2)?.pricePaise).toBe(20000);

    const originalIds = new Set(v1Full!.items.map((i) => i.id));
    for (const item of v2Full!.items) expect(originalIds.has(item.id)).toBe(false);
  });

  it("activation race: exactly one fulfilled, loser carries not_submitted, one activated row, one event", async () => {
    const draft = await mkDraft([[s1, 10000]]);
    const submitted = await withTx(db, (tx) => submitVersion(tx, drafter, draft.versionId));
    await approveRequest(db, owner, { approvalId: submitted.approvalId, note: "approved" });

    const secondActivatorUser = await createUser(db, {
      username: "activator2",
      fullName: "Activator Two",
      password: "p1234567",
    });
    const secondActivator: Actor = { type: "user", id: secondActivatorUser.id };

    const effectiveFrom = new Date("2026-02-01T00:00:00Z");
    const results = await Promise.allSettled([
      activateVersion(db, activator, draft.versionId, effectiveFrom),
      activateVersion(db, secondActivator, draft.versionId, effectiveFrom),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;

    expect(fulfilled.length).toBe(1);
    expect(loser).toBeDefined();
    expect(loser!.reason.code).toBe("not_submitted");

    // Invariants — asserted on every path, no early bail.
    const activatedRows = await db.select().from(tariffVersions).where(eq(tariffVersions.status, "activated"));
    expect(activatedRows.length).toBe(1);
    const eventRows = await db.select().from(events).where(eq(events.name, "tariff.revision_applied"));
    expect(eventRows.length).toBe(1);
  });

  it("cross-version race at an EQUAL effectiveFrom: one winner, loser is effective_from_not_monotone, monotone set holds", async () => {
    const v1 = await mkDraft([[s1, 10000]]);
    const v2 = await mkDraft([[s2, 20000]]);
    const sub1 = await withTx(db, (tx) => submitVersion(tx, drafter, v1.versionId));
    const sub2 = await withTx(db, (tx) => submitVersion(tx, drafter, v2.versionId));
    await approveRequest(db, owner, { approvalId: sub1.approvalId, note: "approved" });
    await approveRequest(db, owner, { approvalId: sub2.approvalId, note: "approved" });

    // §3.21 trace discipline: the serializer's predicate (status in submitted/activated) matches
    // BOTH target rows in this starting state — a lock that locks something. The loser waits on
    // the ordered set lock, then re-reads the activated set and finds the winner's row at the
    // SAME date, never strictly greater — so its code is deterministic on EVERY interleaving.
    const effectiveFrom = new Date("2026-02-01T00:00:00Z");
    const results = await Promise.allSettled([
      activateVersion(db, activator, v1.versionId, effectiveFrom),
      activateVersion(db, activator, v2.versionId, effectiveFrom),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    expect(fulfilled.length).toBe(1);
    expect(loser).toBeDefined();
    expect(loser!.reason.code).toBe("effective_from_not_monotone");

    // Invariants — asserted on every path, no early bail (§3.13 lesson).
    const activatedRows = await db.select().from(tariffVersions).where(eq(tariffVersions.status, "activated"));
    expect(activatedRows.length).toBe(1);
    const eventRows = await db.select().from(events).where(eq(events.name, "tariff.revision_applied"));
    expect(eventRows.length).toBe(1);

    // The loser is untouched — still submitted — and re-activates cleanly at a LATER date.
    const loserId = activatedRows[0]!.id === v1.versionId ? v2.versionId : v1.versionId;
    expect((await getVersion(db, loserId))!.version.status).toBe("submitted");
    const retry = await activateVersion(db, activator, loserId, new Date("2026-03-01T00:00:00Z"));
    expect(retry.effectiveFrom).toEqual(new Date("2026-03-01T00:00:00Z"));
  });
});
