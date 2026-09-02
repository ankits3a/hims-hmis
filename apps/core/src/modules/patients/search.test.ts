import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { patientPhotos, registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { patientsManifest } from "./manifest";
import { registerPatient } from "./registration";
import { searchPatients } from "./search";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const clerk: Actor = { type: "user", id: "clerk-1" };

describe("searchPatients", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
  });

  async function seedThree(): Promise<{ ashaUhid: string }> {
    const asha = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Asha Devi", sex: "female", phone: "9876543210" }),
    );
    await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Ashok Kumar", sex: "male", phone: "9876500000", altPhone: "8000000001" }),
    );
    await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Binod Singh", sex: "male", phone: "7012345678" }),
    );
    return { ashaUhid: asha.patient.uhid };
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   * FD-6 — A SURNAME IS A NAME, AND THE COUNTER COULD NOT FIND ONE
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   *
   * MEASURED ON 10,000 SEEDED PATIENTS, 2026-09-02: 668 of them carried "Kumar" in their name and
   * `GET /patients/search?q=Kumar` returned `{"items":[]}`. The lane was anchored to the start of
   * the WHOLE name, so it served only the case where the FIRST name was typed first. The command
   * palette answered the same word with five people in the same second, because it orders by
   * trigram similarity and the counter did not — one product, two search boxes, opposite answers.
   *
   * In Bihar the counter is full of Kumar, Devi, Singh, Sah and Prasad, and a patient asked their
   * name commonly answers with one of them.
   */
  it("FD-6 — a query matches the start of ANY word in the name, not only the first", async () => {
    await seedThree();
    /*
     * ═══ `matchedOn` IS THE ASSERTION, AND THE FIRST VERSION OF THIS TEST WAS WRONG ═══
     *
     * Asserting only the NAMES passed against the shipped defect — mutant M7, which re-anchored the
     * lane to the whole name, was GREEN. The rows were still coming back, through the trigram
     * FALLBACK: `similarity('kumar','ashok kumar')` clears the threshold, so the fallback quietly
     * satisfied a test that claimed to be about the exact lane.
     *
     * `matchedOn` separates them, because it is computed from the EXACT lane's own SQL fragment
     * evaluated per row (`laneFor("name")`). An exact word-start hit carries `["name"]`; a row that
     * only the fallback found carries `[]`. So this now fails the moment the word-boundary lane
     * stops doing the work, which is the whole point of the row.
     */
    const kumar = await searchPatients(db, clerk, "Kumar");
    expect(kumar.map((r) => r.name)).toEqual(["Ashok Kumar"]);
    expect(kumar[0]!.matchedOn).toEqual(["name"]); // THE KILL — `[]` here means the fallback did it

    const devi = await searchPatients(db, clerk, "Devi");
    expect(devi.map((r) => r.name)).toEqual(["Asha Devi"]);
    expect(devi[0]!.matchedOn).toEqual(["name"]);

    const singh = await searchPatients(db, clerk, "Singh");
    expect(singh.map((r) => r.name)).toEqual(["Binod Singh"]);
    expect(singh[0]!.matchedOn).toEqual(["name"]);

    // The first name still works, unchanged — the old behaviour is a subset of the new one.
    const ashok = await searchPatients(db, clerk, "Ashok");
    expect(ashok.map((r) => r.name)).toEqual(["Ashok Kumar"]);
    expect(ashok[0]!.matchedOn).toEqual(["name"]);
  });

  /**
   * WORD-START, NOT `%needle%`, AND THIS ROW IS THE DIFFERENCE.
   *
   * An unanchored contains-match would also fire mid-word. On a duplicate-detection surface that is
   * noise on every common surname, and noise is worse than a miss: a clerk who learns the list is
   * padded stops reading it. `umar` is inside `Kumar` and must not match it.
   */
  it("FD-6 — a fragment INSIDE a word does not match: 'umar' is not 'Kumar'", async () => {
    await seedThree();
    // Same discipline as the row above: the FALLBACK may legitimately surface a near-spelling for
    // these, so what is asserted is that no row matched the EXACT lane — nothing claims "umar" is
    // a name match for "Kumar".
    for (const fragment of ["umar", "ingh"]) {
      const hits = await searchPatients(db, clerk, fragment);
      expect({ fragment, exact: hits.filter((r) => r.matchedOn.includes("name")).map((r) => r.name) })
        .toEqual({ fragment, exact: [] });
    }
  });

  /**
   * ═══ FD-6 — THE APPROXIMATE BRANCH FINALLY HAS A CONSUMER ═══
   *
   * `patientFuzzyCondition` was written for this, its docstring said "used only when the exact one
   * found nobody", it was exported — and **nothing in the repository called it**. A rail with no
   * consumer. It now runs, and only on the road it was written for: a NAME query that found nobody.
   *
   * Both halves are asserted, because "runs sometimes" is not the claim. A misspelling finds the
   * patient; and an exact hit is NOT diluted by approximate ones, which is the property the
   * docstring protects — burying an exact match among near-misses makes the common case worse.
   */
  it("FD-6 — a misspelt name falls back to similarity, and an exact hit never does", async () => {
    await seedThree();
    // Exact found nobody → the fallback fires and finds her anyway.
    const misspelt = await searchPatients(db, clerk, "Ashaa");
    expect(misspelt.map((r) => r.name)).toContain("Asha Devi");
    // Exact found somebody → ONLY the exact rows come back. "Binod" must not drag in near-misses.
    const exact = await searchPatients(db, clerk, "Binod");
    expect(exact.map((r) => r.name)).toEqual(["Binod Singh"]);
  });

  it("digit queries search phone AND alt-phone by prefix", async () => {
    await seedThree();
    const both = await searchPatients(db, clerk, "98765");
    expect(both.map((r) => r.name).sort()).toEqual(["Asha Devi", "Ashok Kumar"]);
    const viaAlt = await searchPatients(db, clerk, "80000");
    expect(viaAlt.map((r) => r.name)).toEqual(["Ashok Kumar"]);
  });

  /*
   * RC-1 T4 / D6 — the row says WHY it matched, from the same SQL fragments that matched it.
   * Reasons, never a percentage (design ruling): the seat renders these as "same mobile" /
   * "name match" / "UHID" chips.
   */
  it("matchedOn names the lane that fired, per row — mobile, name, uhid, and the ambiguous digit run", async () => {
    const { ashaUhid } = await seedThree();

    const byPhone = await searchPatients(db, clerk, "98765");
    for (const hit of byPhone) expect(hit.matchedOn).toEqual(["mobile"]);

    const byName = await searchPatients(db, clerk, "asha");
    expect(byName[0]!.matchedOn).toEqual(["name"]);

    const byUhid = await searchPatients(db, clerk, ashaUhid);
    expect(byUhid).toHaveLength(1);
    expect(byUhid[0]!.matchedOn).toEqual(["uhid"]);

    // The ambiguous digit run tries BOTH lanes; each row reports only the lane that actually
    // fired for IT — Binod's phone starts 7012345, Asha's serial contains the same digits only
    // if her UHID happens to; assert the phone hit reports mobile and nothing it did not match.
    const ambiguous = await searchPatients(db, clerk, "7012345");
    const binod = ambiguous.find((r) => r.name === "Binod Singh")!;
    expect(binod.matchedOn).toContain("mobile");
    // And a trailing-digits UHID read reports the uhid lane, not mobile.
    const trailing = await searchPatients(db, clerk, ashaUhid.slice(3));
    const asha = trailing.find((r) => r.uhid === ashaUhid)!;
    expect(asha.matchedOn).toContain("uhid");
    expect(asha.matchedOn).not.toContain("name");
  });

  it("UHID-shaped queries match exactly, case-insensitively on the prefix", async () => {
    const { ashaUhid } = await seedThree();
    const hits = await searchPatients(db, clerk, ashaUhid.toLowerCase());
    expect(hits).toHaveLength(1);
    expect(hits[0]!.uhid).toBe(ashaUhid);
  });

  /**
   * THE 2026-08-25 FORMAT'S SEARCH LANES. The format change (nine characters, no separators) only
   * pays off if the box forgives how a desk actually types an id, so each of these is a way a real
   * lookup arrives rather than a permutation for its own sake. The UHIDs are sliced out of the
   * allocated value instead of being written as literals: `truncateAll` does not reset `uhid_seq`,
   * so the serial differs between runs and any hard-coded id here would be a time bomb.
   */
  it("finds a patient by a UHID typed WITHOUT the prefix letter — the numeric-keypad path", async () => {
    const { ashaUhid } = await seedThree();
    const bare = ashaUhid.slice(3); // 8 digits: the 7-digit serial and its check digit, no "HMS"
    expect((await searchPatients(db, clerk, bare)).map((r) => r.uhid)).toEqual([ashaUhid]);
  });

  it("finds a patient by the LEADING serial digits, with the check digit not yet typed", async () => {
    // A serial copied out of a report, or off an older system that never carried a check digit —
    // a trailing-anchored match would miss every one of these.
    const { ashaUhid } = await seedThree();
    const serial = ashaUhid.slice(3, 10);
    expect((await searchPatients(db, clerk, serial)).map((r) => r.uhid)).toEqual([ashaUhid]);
    expect((await searchPatients(db, clerk, `hms${serial}`)).map((r) => r.uhid)).toEqual([ashaUhid]);
  });

  it("finds a patient by the TRAILING digits read off a card", async () => {
    // The other half of the desk, and the reason the lane is a substring rather than a prefix:
    // the leading `U123` is shared by every patient for the hospital's first 55,000 registrations.
    const { ashaUhid } = await seedThree();
    expect((await searchPatients(db, clerk, ashaUhid.slice(-4))).map((r) => r.uhid)).toContain(ashaUhid);
  });

  it("treats spaces and hyphens inside an ID as punctuation", async () => {
    const { ashaUhid } = await seedThree();
    const spaced = `${ashaUhid.slice(0, 3)} ${ashaUhid.slice(3, 7)}-${ashaUhid.slice(7)}`;
    expect((await searchPatients(db, clerk, spaced)).map((r) => r.uhid)).toEqual([ashaUhid]);
  });

  it("a digit run inside the UHID window still searches PHONES — the lanes are OR'd, not chosen between", async () => {
    // Guards the regression where the UHID lane returns early and swallows the phone lane: five
    // digits are both a plausible phone prefix and a plausible UHID fragment, and a desk that
    // typed a phone prefix must not be told there is no such patient.
    await seedThree();
    const hits = await searchPatients(db, clerk, "98765");
    expect(hits.map((r) => r.name).sort()).toEqual(["Asha Devi", "Ashok Kumar"]);
  });

  it("text queries search name by case-insensitive prefix, with LIKE metacharacters inert", async () => {
    await seedThree();
    const hits = await searchPatients(db, clerk, "ash");
    expect(hits.map((r) => r.name)).toEqual(["Asha Devi", "Ashok Kumar"]); // name asc
    expect(await searchPatients(db, clerk, "sha")).toEqual([]); // prefix, not substring — deliberate Phase-1 scope
    expect(await searchPatients(db, clerk, "a%")).toEqual([]); // % is a literal, matches nobody
  });

  it("returns hasPhoto without ever selecting bytes", async () => {
    await seedThree();
    const asha = (await searchPatients(db, clerk, "9876543210"))[0]!;
    expect(asha.hasPhoto).toBe(false);
    await db.insert(patientPhotos).values({
      patientId: asha.id, mimeType: "image/jpeg", bytes: Buffer.from([0xff]), updatedBy: "t",
    });
    expect((await searchPatients(db, clerk, "9876543210"))[0]!.hasPhoto).toBe(true);
  });

  it("excludes confidential patients unless the caller holds patients.confidential.read", async () => {
    const registry = new ModuleRegistry();
    registry.install(patientsManifest);
    await syncPermissions(db, registry);
    await createRole(db, "vip_desk", "VIP Desk");
    await grantPermissionToRole(db, registry, "vip_desk", "patients.confidential.read");
    const holder = await createUser(db, { username: "holder2", fullName: "H", password: "p1234567" });
    await assignRole(db, { userId: holder.id, roleKey: "vip_desk", scopeType: "hospital" });

    await withTx(db, (tx) =>
      registerPatient(tx, clerk, {
        name: "Vip Person", sex: "male", phone: "9111111111", isConfidential: true, alias: "Patient V",
      }),
    );
    expect(await searchPatients(db, clerk, "9111111111")).toEqual([]);
    const seen = await searchPatients(db, { type: "user", id: holder.id }, "9111111111");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.isConfidential).toBe(true);
  });

  it("short and non-user queries", async () => {
    await seedThree();
    expect(await searchPatients(db, clerk, " 9 ")).toEqual([]); // trimmed length < 2
    await expect(searchPatients(db, { type: "agent", id: "a1" }, "asha")).rejects.toMatchObject({
      code: "user_actor_required",
    });
  });
});
