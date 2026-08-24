import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { useBreakGlass } from "../../kernel/auth/break-glass";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { loadConfig } from "../../kernel/config";
import { patientsManifest } from "./manifest";
import { registerPatient } from "./registration";
import { patientSearchProvider } from "./search-provider";
import { parseSearchQuery } from "@hmis/contracts";
import type { Actor, SearchHit } from "@hmis/contracts";
import type { SearchProviderResult } from "../../kernel/search/types";
import type { Db } from "../../kernel/db/client";

const clerk: Actor = { type: "user", id: "clerk-1" };

describe("patients search provider", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
  });

  function registry(): ModuleRegistry {
    const r = new ModuleRegistry();
    r.install(patientsManifest);
    return r;
  }

  /** A user holding exactly the permissions named, at hospital scope. */
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

  async function run(userId: string, text: string, limit = 5): Promise<SearchProviderResult> {
    return patientSearchProvider.run({
      db,
      actor: { type: "user", id: userId },
      query: parseSearchQuery(text, limit),
      limit,
      signal: new AbortController().signal,
    });
  }

  async function seed(): Promise<{ ashaUhid: string }> {
    const asha = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Asha Devi", sex: "female", phone: "9876543210" }),
    );
    await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Ashok Kumar", sex: "male", phone: "9876500000", altPhone: "8000000001" }),
    );
    return { ashaUhid: asha.patient.uhid };
  }

  async function seedConfidential(): Promise<void> {
    await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Asha Confidential", sex: "female", phone: "9111111111", isConfidential: true, alias: "Ashwin Guest" }),
    );
  }

  it("matches on the same three branches as the desk route — name, phone, alt-phone, UHID", async () => {
    const { ashaUhid } = await seed();
    const userId = await userHolding(["patients.read"]);

    expect((await run(userId, "ash")).hits.map((h) => h.title).sort()).toEqual(["Asha Devi", "Ashok Kumar"]);
    expect((await run(userId, "98765")).hits.map((h) => h.title).sort()).toEqual(["Asha Devi", "Ashok Kumar"]);
    expect((await run(userId, "80000")).hits.map((h) => h.title)).toEqual(["Ashok Kumar"]);
    expect((await run(userId, ashaUhid)).hits.map((h) => h.title)).toEqual(["Asha Devi"]);
  });

  it("LIKE metacharacters are literal — `a%` matches nobody", async () => {
    await seed();
    const userId = await userHolding(["patients.read"]);
    const res = await run(userId, "a%");
    expect(res.hits).toEqual([]);
    expect(res.total).toBe(0);
  });

  it("SEALED — a confidential record is absent from hits, from TOTAL, and from the ordering", async () => {
    await seed();
    await seedConfidential();
    const userId = await userHolding(["patients.read"]);

    const sealed = await run(userId, "asha");

    // Hits and total agree, and the total is the one a database without the row would produce.
    expect(sealed.hits.map((h) => h.title)).toEqual(["Asha Devi"]);
    expect(sealed.total).toBe(1);

    // The equivalence that IS the assertion: delete the confidential row and the answer is
    // byte-identical. A count that leaked would break this even with the hits still correct.
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
    await seed();
    const userId2 = await userHolding(["patients.read"]);
    const withoutTheRow = await run(userId2, "asha");
    expect(sealed.hits.map((h) => h.title)).toEqual(withoutTheRow.hits.map((h) => h.title));
    expect(sealed.total).toBe(withoutTheRow.total);
  });

  it("a holder of patients.confidential.read sees the record, UNMARKED — a permission is not a break-glass", async () => {
    await seed();
    await seedConfidential();
    const userId = await userHolding(["patients.read", "patients.confidential.read"]);

    const res = await run(userId, "asha");

    expect(res.hits.map((h) => h.title).sort()).toEqual(["Asha Confidential", "Asha Devi"]);
    expect(res.total).toBe(2);
    // Patients carry no scope, so this provider never emits a RESTRICTED stub (see its comment).
    expect(res.hits.every((h: SearchHit) => h.restricted === undefined)).toBe(true);
  });

  it("BREAK-GLASS DOES NOT WIDEN SEARCH — no query-level read path honours it", async () => {
    await seed();
    await seedConfidential();
    const userId = await userHolding(["patients.read"]);
    await useBreakGlass(db, loadConfig(), { type: "user", id: userId }, { reason: "ED unconscious patient" });

    const res = await run(userId, "asha");

    // The palette must not be the one surface where a hospital-wide grant reveals what
    // `getPatientSummaries` keeps sealed. If the owner's D6 ruling changes this, it changes
    // HERE and in registration.ts together — never in one of them.
    expect(res.hits.map((h) => h.title)).toEqual(["Asha Devi"]);
    expect(res.total).toBe(1);
  });

  it("a holder renders a confidential row by ALIAS-OR-NAME, never leaking a name the gate hid", async () => {
    await seed();
    await seedConfidential();
    const userId = await userHolding(["patients.read", "patients.confidential.read"]);

    const res = await run(userId, "asha");
    const conf = res.hits.find((h) => h.subtitle?.includes("female") && h.title !== "Asha Devi");

    // A holder sees the real record; the alias branch is what protects a non-holder if the D6
    // ruling ever lets one through (see the provider's comment).
    expect(conf?.title).toBe("Asha Confidential");
  });

  it("the phone is MASKED to its last four in a list row", async () => {
    await seed();
    const userId = await userHolding(["patients.read"]);
    const hit = (await run(userId, "asha")).hits[0]!;
    expect(hit.meta?.phone).toBe("•••••• 3210");
    expect(JSON.stringify(hit)).not.toContain("9876543210");
  });

  it("total counts past the cap — the palette can say 'showing 1 of 2'", async () => {
    await seed();
    const userId = await userHolding(["patients.read"]);
    const res = await run(userId, "ash", 1);
    expect(res.hits).toHaveLength(1);
    expect(res.total).toBe(2);
  });

  it("a query under two characters runs nothing", async () => {
    await seed();
    const userId = await userHolding(["patients.read"]);
    expect(await run(userId, "a")).toEqual({ hits: [], total: 0 });
  });
});
