import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { permissions, roleAssignments, rolePermissions, roles, users } from "../../kernel/db/schema";
import { RosterError } from "./errors";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import {
  credentialsOf, expiringCredentials, holdsCredential, recordCredential, verifyCredential,
} from "./credentials";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PHASE R (R4) — what somebody holds, and until when.
 *
 * The window is the part that matters. A lapsed ACLS is indistinguishable from no ACLS on the night
 * somebody needs it, and the only way anybody finds out in time is if the roster can say *"this
 * expires inside the month you are about to publish."* Expiry is a FINDING (R8), never a refusal:
 * refusing to roster somebody whose BLS lapses on the 20th would empty a ward on the 21st.
 */
describe("roster — credentials (R4)", () => {
  const MS = "01USER00000000000000000MS";
  const NURSE = "01USER00000000000000NURSE";
  const ms: Actor = { type: "user", id: MS };

  let db: Db;
  let teardown: () => Promise<void>;
  const at = (s: string): Date => new Date(`${s}:00+05:30`);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values({ key: "medical_superintendent", title: "Medical Superintendent" });
    await db.insert(permissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })),
    );
    await db.insert(rolePermissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ roleKey: "medical_superintendent", permission })),
    );
    for (const [id, username] of [[MS, "sunita.mishra"], [NURSE, "asha.kumari"]] as const) {
      await db.insert(users).values({ id, username, fullName: username, staffCode: `EMP-${id.slice(-4)}`, passwordHash: "x" });
    }
    await db.insert(roleAssignments).values({ id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null });
  });

  const refusal = async (p: Promise<unknown>): Promise<RosterError> => {
    const e = await p.then(() => null, (err: unknown) => err);
    if (!(e instanceof RosterError)) throw new Error(`expected a RosterError, got: ${String(e)}`);
    return e;
  };

  const record = (over: Partial<Parameters<typeof recordCredential>[2]> = {}) =>
    withTx(db, (tx) => recordCredential(tx, ms, {
      userId: NURSE, credentialKey: "acls", reference: "ACLS/2026/1187",
      validFrom: at("2026-01-01T00:00"), validTo: at("2027-01-01T00:00"), ...over,
    }));

  it("records a certificate and reads it back at an instant inside its window", async () => {
    await record();
    expect((await credentialsOf(db, NURSE, at("2026-06-01T00:00"))).map((c) => c.credentialKey)).toEqual(["acls"]);
    // ...and not before it was issued, nor after it lapsed
    expect(await credentialsOf(db, NURSE, at("2025-12-31T00:00"))).toEqual([]);
    expect(await credentialsOf(db, NURSE, at("2027-01-02T00:00"))).toEqual([]);
  });

  it("a registration with no expiry never lapses", async () => {
    await record({ credentialKey: "nursing_council", reference: "BNRC/44210", validTo: null });
    expect(await holdsCredential(db, NURSE, "nursing_council", at("2099-01-01T00:00"))).toBe(true);
    // ...and therefore never appears in an expiry sweep
    expect(await expiringCredentials(db, at("2026-01-01T00:00"), at("2099-01-01T00:00"))).toEqual([]);
  });

  it("VERIFYING is a second act, by a second desk, and a requirement may ask for it", async () => {
    const { credentialId } = await record();
    const when = at("2026-06-01T00:00");
    expect(await holdsCredential(db, NURSE, "acls", when)).toBe(true);
    // a clerk typed the number from a form; nobody has checked it against the council's register
    expect(await holdsCredential(db, NURSE, "acls", when, { verifiedOnly: true })).toBe(false);

    await withTx(db, (tx) => verifyCredential(tx, ms, credentialId));
    expect(await holdsCredential(db, NURSE, "acls", when, { verifiedOnly: true })).toBe(true);
    const [row] = await credentialsOf(db, NURSE, when);
    expect(row!.verifiedBy).toBe(MS);
    expect(row!.verifiedAt).not.toBeNull();
  });

  it("the expiry sweep answers the question a head asks before publishing a month", async () => {
    await record({ validTo: at("2026-10-20T00:00") });                       // lapses mid-October
    await record({ credentialKey: "bls", reference: "BLS/9", validTo: at("2027-05-01T00:00") });
    const october = await expiringCredentials(db, at("2026-10-01T00:00"), at("2026-11-01T00:00"));
    expect(october.map((c) => c.credentialKey)).toEqual(["acls"]);
    // the boundary is half-open at the top, like every window in this phase
    expect(await expiringCredentials(db, at("2026-10-01T00:00"), at("2026-10-20T00:00"))).toEqual([]);
  });

  it("refuses a certificate that expires before it was issued, an empty number, and an unknown kind", async () => {
    expect((await refusal(record({ validTo: at("2025-06-01T00:00") }))).code).toBe("invalid_window");
    expect((await refusal(record({ reference: "   " }))).code).toBe("invalid_window");
    expect((await refusal(record({ credentialKey: "scuba" as never }))).code).toBe("unknown_credential");
  });

  it("recording one is a governed act — a person holding nothing cannot", async () => {
    const e = await refusal(withTx(db, (tx) => recordCredential(tx, { type: "user", id: NURSE }, {
      userId: NURSE, credentialKey: "acls", reference: "self-declared", validFrom: at("2026-01-01T00:00"),
    })));
    expect(e.code).toBe("not_permitted");
  });
});
