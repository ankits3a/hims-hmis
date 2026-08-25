import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { registrationConfig } from "../../kernel/db/schema";
import { membershipInstances, membershipPlans } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { patientsManifest, registerPatient } from "../patients";
import { membershipManifest } from "./manifest";
import { instrumentSearchProvider } from "./search-providers";
import { parseSearchQuery } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { SearchProviderResult } from "../../kernel/search/types";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 09 T3 — the `membership.instrument` provider. CRITICAL tier: Book rows C1 and C5 are built
 * as mutants beside this file and the isolation lines are quoted in the task report.
 *
 * ═══ EVERY CODE, NAME AND CARD NUMBER BELOW IS INVENTED HERE (DD3 / owner ruling O-9) ═══
 *
 * The out-of-git partner book may never be quoted into a tracked file, and a fixture is a tracked
 * file. Each of these tests is about a CLASS — a sealed holder, a Devanagari-stored holder, a
 * holder linked to nobody — and a class does not care which invented name carries it.
 */
const clerk: Actor = { type: "user", id: "clerk-1" };

const PLAN_ID = "01HTESTPLAN00000000000001";
const AT = new Date("2026-09-01T06:00:00Z");

describe("membership instrument search provider", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
    await db.insert(membershipPlans).values({
      id: PLAN_ID, code: "INV-PLAN-A", title: "Invented Card", kind: "card",
      benefits: [], entitlements: {}, validityDays: 365, createdBy: "test",
    });
  });

  function registry(): ModuleRegistry {
    const r = new ModuleRegistry();
    r.install(patientsManifest);
    r.install(membershipManifest);
    return r;
  }

  async function userHolding(permissions: string[]): Promise<string> {
    const reg = registry();
    await syncPermissions(db, reg);
    const suffix = Math.random().toString(36).slice(2, 9);
    const { id } = await createUser(db, { username: `u${suffix}`, fullName: "Desk", password: "correct horse battery" });
    if (permissions.length > 0) {
      const roleKey = `r${suffix}`;
      await createRole(db, roleKey, "Test role");
      for (const p of permissions) await grantPermissionToRole(db, reg, roleKey, p);
      await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    }
    return id;
  }

  async function issueCard(args: { id: string; cardCode: string; holderName: string; holderPhone?: string; patientId?: string }): Promise<void> {
    await db.insert(membershipInstances).values({
      id: args.id,
      planId: PLAN_ID,
      cardCode: args.cardCode,
      holderName: args.holderName,
      holderPhone: args.holderPhone,
      patientId: args.patientId,
      validFrom: new Date("2026-01-01T00:00:00Z"),
      validTo: new Date("2026-12-31T00:00:00Z"),
      status: "active",
      origin: "import",
    });
  }

  async function run(userId: string, text: string, limit = 10): Promise<SearchProviderResult> {
    return instrumentSearchProvider.run({
      db,
      actor: { type: "user", id: userId },
      query: parseSearchQuery(text, limit),
      limit,
      signal: new AbortController().signal,
      now: AT,
    });
  }

  it("declares its permission rather than checking one inside `run` (the 11h seam's own rule)", () => {
    expect(instrumentSearchProvider.entity).toBe("instrument");
    expect(instrumentSearchProvider.permission).toBe("membership.instrument.read");
    expect(membershipManifest.permissions).toContain(instrumentSearchProvider.permission);
    expect(membershipManifest.search?.map((p) => p.key)).toEqual(["membership.instrument"]);
  });

  it("finds a card by its CODE, case-insensitively, and by the holder's phone", async () => {
    await issueCard({ id: "01HCARD0000000000000001", cardCode: "AZ-4471", holderName: "Nilima Barua", holderPhone: "9700000001" });
    const userId = await userHolding(["membership.instrument.read"]);

    expect((await run(userId, "az-44")).hits.map((h) => h.title)).toEqual(["AZ-4471"]);
    expect((await run(userId, "AZ-44")).hits.map((h) => h.title)).toEqual(["AZ-4471"]);
    expect((await run(userId, "97000")).hits.map((h) => h.title)).toEqual(["AZ-4471"]);
  });

  it("LIKE metacharacters are literal — `a%` matches nobody", async () => {
    await issueCard({ id: "01HCARD0000000000000001", cardCode: "AZ-4471", holderName: "Nilima Barua" });
    const userId = await userHolding(["membership.instrument.read"]);
    const res = await run(userId, "a%");
    expect(res.hits).toEqual([]);
    expect(res.total).toBe(0);
  });

  /**
   * ═══ BOOK ROW C5 — BOTH SCRIPTS, BOTH DIRECTIONS ═══
   *
   * The mutant is "remove the transliteration leg", and the two legs fail in OPPOSITE directions,
   * which is why one assertion could not have caught it: folding only the QUERY finds a
   * Latin-stored holder from Devanagari and misses a Devanagari-stored one from Latin; matching
   * only the RAW query does the reverse.
   */
  it("C5 — a DEVANAGARI-stored holder is found by a LATIN query", async () => {
    await issueCard({ id: "01HCARD0000000000000002", cardCode: "BQ-1180", holderName: "कमल" });
    const userId = await userHolding(["membership.instrument.read"]);

    const res = await run(userId, "kamal");
    expect(res.hits.map((h) => h.subtitle)).toEqual(["कमल · Invented Card"]);
    expect(res.total).toBe(1);
  });

  it("C5 — …and a LATIN-stored holder is found by a DEVANAGARI query", async () => {
    await issueCard({ id: "01HCARD0000000000000003", cardCode: "BQ-1181", holderName: "Kamal Sethi" });
    const userId = await userHolding(["membership.instrument.read"]);

    const res = await run(userId, "कमल");
    expect(res.hits.map((h) => h.subtitle)).toEqual(["Kamal Sethi · Invented Card"]);
    expect(res.total).toBe(1);
  });

  it("C5 — a Devanagari query still finds a Devanagari-stored holder (the 11h MAJOR-4 regression)", async () => {
    await issueCard({ id: "01HCARD0000000000000004", cardCode: "BQ-1182", holderName: "कमल" });
    const userId = await userHolding(["membership.instrument.read"]);
    expect((await run(userId, "कमल")).hits.map((h) => h.title)).toEqual(["BQ-1182"]);
  });

  /**
   * ═══ BOOK ROW C1 — THE SEALED GATE IS IN THE SQL, AND `total` IS COUNTED BY THE SAME QUERY ═══
   *
   * The assertion that carries the weight is the EQUIVALENCE: a caller without
   * `patients.confidential.read` must get the byte-identical answer they would get from a database
   * that never held the sealed row at all — hits AND total. A count computed without the gate
   * still passes a hits-only assertion, which is exactly how 11h's leak survived its own review.
   */
  it("C1 — a sealed patient's card is absent from hits AND from total", async () => {
    const open = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Nilima Barua", sex: "female", phone: "9700000001" }));
    const sealed = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Nilima Sealed", sex: "female", phone: "9700000002", isConfidential: true, alias: "Guest N" }));
    await issueCard({ id: "01HCARD0000000000000005", cardCode: "CX-9001", holderName: "Nilima Barua", patientId: open.patient.id });
    await issueCard({ id: "01HCARD0000000000000006", cardCode: "CX-9002", holderName: "Nilima Sealed", patientId: sealed.patient.id });

    const desk = await userHolding(["membership.instrument.read"]);
    const gated = await run(desk, "CX-90");
    expect(gated.hits.map((h) => h.title)).toEqual(["CX-9001"]);
    expect(gated.total).toBe(1);

    // …and the holder of the confidential permission sees both, so the gate is a DECISION rather
    // than a query that happens to find one row.
    const confidential = await userHolding(["membership.instrument.read", "patients.confidential.read"]);
    const ungated = await run(confidential, "CX-90");
    expect(ungated.hits.map((h) => h.title).sort()).toEqual(["CX-9001", "CX-9002"]);
    expect(ungated.total).toBe(2);
  });

  it("C1 — the sealed answer is byte-identical to a database that never held the row", async () => {
    const open = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Nilima Barua", sex: "female", phone: "9700000001" }));
    const sealed = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Nilima Sealed", sex: "female", phone: "9700000002", isConfidential: true, alias: "Guest N" }));
    await issueCard({ id: "01HCARD0000000000000005", cardCode: "CX-9001", holderName: "Nilima Barua", patientId: open.patient.id });
    await issueCard({ id: "01HCARD0000000000000006", cardCode: "CX-9002", holderName: "Nilima Sealed", patientId: sealed.patient.id });
    const desk = await userHolding(["membership.instrument.read"]);
    const withSealedRow = await run(desk, "CX-90");

    // The row is REMOVED rather than the caller's permission changed: the equivalence being
    // asserted is "as if the database never held it", which is what a leaking count breaks.
    await db.delete(membershipInstances).where(eq(membershipInstances.id, "01HCARD0000000000000006"));
    const withoutSealedRow = await run(desk, "CX-90");

    expect(withSealedRow.hits.map((h) => h.title)).toEqual(withoutSealedRow.hits.map((h) => h.title));
    expect(withSealedRow.total).toBe(withoutSealedRow.total);
  });

  it("C1 — the patient CHIP lane is gated too: an id is not a capability", async () => {
    const sealed = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Nilima Sealed", sex: "female", phone: "9700000002", isConfidential: true, alias: "Guest N" }));
    await issueCard({ id: "01HCARD0000000000000007", cardCode: "CX-9003", holderName: "Nilima Sealed", patientId: sealed.patient.id });

    const desk = await userHolding(["membership.instrument.read"]);
    const res = await run(desk, `@p:${sealed.patient.id}`);
    expect(res.hits).toEqual([]);
    expect(res.total).toBe(0);
  });

  it("an UNLINKED holder-book row is visible — there is no patient's confidentiality to protect yet", async () => {
    await issueCard({ id: "01HCARD0000000000000008", cardCode: "DD-2200", holderName: "Unlinked Holder" });
    const desk = await userHolding(["membership.instrument.read"]);
    const res = await run(desk, "DD-22");
    expect(res.hits.map((h) => h.title)).toEqual(["DD-2200"]);
    expect(res.total).toBe(1);
  });

  it("no hit carries a money field — E-32's guardrail, asserted on the shape", async () => {
    await issueCard({ id: "01HCARD0000000000000009", cardCode: "EE-3300", holderName: "Nilima Barua" });
    const desk = await userHolding(["membership.instrument.read"]);
    const res = await run(desk, "EE-33");
    const meta = res.hits[0]?.meta ?? {};
    expect(Object.keys(meta).sort()).toEqual(["origin", "status", "validTo"]);
    expect(JSON.stringify(res.hits)).not.toMatch(/paise|amount|price|rupee/i);
  });
});
