import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { attStaff, events, users } from "../../kernel/db/schema";
import { createUser } from "../../kernel/auth/identity";
import { withTx } from "../../kernel/db/client";
import { decideLinks, linkPeople, linkStates, normaliseMobile } from "./linking";
import type { Db } from "../../kernel/db/client";

const H1 = "a1".repeat(32);
const H2 = "b2".repeat(32);
const NOW = new Date("2026-03-10T06:00:00Z");

describe("normaliseMobile", () => {
  it("ten digits starting 6-9, whatever it was wrapped in", () => {
    expect(normaliseMobile("9876501234")).toBe("9876501234");
    expect(normaliseMobile("+91 98765-01234")).toBe("9876501234");
    expect(normaliseMobile("919876501234")).toBe("9876501234");
    expect(normaliseMobile("09876501234")).toBe("9876501234");
    expect(normaliseMobile(" 98765 01234 ")).toBe("9876501234");
  });
  it("anything else is no mobile", () => {
    for (const bad of [null, undefined, "", "12345", "5876501234", "98765012345", "abcdefghij"]) expect(normaliseMobile(bad)).toBeNull();
  });
});

describe("linking people — mobile or Aadhaar only", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function login(username: string, set: { phone?: string; aadhaarHash?: string; active?: boolean } = {}): Promise<string> {
    const { id } = await createUser(db, { username, fullName: `Name of ${username}`, password: "s3cret-pass" });
    await db.update(users).set({ phone: set.phone ?? null, aadhaarHash: set.aadhaarHash ?? null, aadhaarLast4: set.aadhaarHash === undefined ? null : "0124", active: set.active ?? true }).where(eq(users.id, id));
    return id;
  }
  async function person(pin: string, set: { mobile?: string; aadhaarHash?: string; status?: string; name?: string } = {}): Promise<void> {
    await db.insert(attStaff).values({ pin, name: set.name ?? `Machine ${pin}`, status: set.status ?? "active", mobile: set.mobile ?? null, aadhaarHash: set.aadhaarHash ?? null });
  }
  const link = () => withTx(db, (tx) => linkPeople(tx, NOW));
  const row = async (pin: string) => (await db.select().from(attStaff).where(eq(attStaff.pin, pin)))[0]!;

  it("by Aadhaar: equal hashes are the same person, whatever the mobiles say", async () => {
    const u = await login("a.kumar", { aadhaarHash: H1, phone: "9000000001" });
    await person("304", { aadhaarHash: H1, mobile: "9876501234" });
    expect(await link()).toEqual({ linked: 1, needsAttention: 0 });
    expect(await row("304")).toMatchObject({ userId: u, linkSource: "aadhaar", linkedAt: NOW, needsAttention: null });
    expect((await linkStates(db)).get(u)).toBe("linked");
  });

  it("by mobile: one active machine person and one login share the number", async () => {
    const u = await login("r.patil", { phone: "9811100014" });
    await person("314", { mobile: "+91 98111-00014" });
    expect(await link()).toEqual({ linked: 1, needsAttention: 0 });
    expect(await row("314")).toMatchObject({ userId: u, linkSource: "mobile" });
  });

  it("Aadhaar wins over mobile when both could match different people", async () => {
    const u = await login("both", { aadhaarHash: H1, phone: "9811100020" });
    await person("401", { aadhaarHash: H1 });
    await person("402", { mobile: "9811100020" });
    await link();
    expect((await row("401")).userId).toBe(u);
    expect(await row("402")).toMatchObject({ userId: null, needsAttention: "login_linked_elsewhere" });
  });

  it("REFUSED on ambiguity — two machine people share the mobile: no link, and it says why", async () => {
    const u = await login("m.lal", { phone: "9811100020" });
    await person("320", { mobile: "9811100020" });
    await person("321", { mobile: "9811100020" });
    expect(await link()).toEqual({ linked: 0, needsAttention: 2 });
    expect(await row("320")).toMatchObject({ userId: null, linkSource: null, needsAttention: "mobile_shared_on_machine" });
    expect(await row("321")).toMatchObject({ userId: null, needsAttention: "mobile_shared_on_machine" });
    expect((await linkStates(db)).get(u)).toBe("two_matches");
  });

  it("REFUSED on ambiguity — two logins share the mobile", async () => {
    const a = await login("twin.a", { phone: "9811100030" });
    const b = await login("twin.b", { phone: "9811100030" });
    await person("330", { mobile: "9811100030" });
    expect(await link()).toEqual({ linked: 0, needsAttention: 1 });
    expect(await row("330")).toMatchObject({ userId: null, needsAttention: "mobile_shared_by_logins" });
    const states = await linkStates(db);
    expect([states.get(a), states.get(b)]).toEqual(["two_matches", "two_matches"]);
  });

  it("REFUSED on ambiguity — two logins carry one Aadhaar", async () => {
    await login("dup.a", { aadhaarHash: H2 });
    await login("dup.b", { aadhaarHash: H2 });
    await person("340", { aadhaarHash: H2 });
    expect(await link()).toEqual({ linked: 0, needsAttention: 1 });
    expect(await row("340")).toMatchObject({ userId: null, needsAttention: "aadhaar_shared" });
  });

  it("a person who LEFT is not matched by mobile (their number may be somebody's now); the active one is", async () => {
    const u = await login("new.joiner", { phone: "9811100040" });
    await person("350", { mobile: "9811100040", status: "left" });
    await person("351", { mobile: "9811100040" });
    expect((await link()).linked).toBe(1);
    expect((await row("351")).userId).toBe(u);
    expect((await row("350")).userId).toBeNull();
  });

  it("NEVER RE-POINTED: a linked machine person keeps their login when a better-looking match appears", async () => {
    const first = await login("first", { phone: "9811100050" });
    await person("360", { mobile: "9811100050" });
    await link();
    expect((await row("360")).userId).toBe(first);
    // Now another login carries the machine person's Aadhaar — the stronger rule — and the first login's phone is gone.
    await db.update(attStaff).set({ aadhaarHash: H1 }).where(eq(attStaff.pin, "360"));
    await db.update(users).set({ phone: null }).where(eq(users.id, first));
    const second = await login("second", { aadhaarHash: H1, phone: "9811100050" });
    expect(await link()).toEqual({ linked: 0, needsAttention: 0 });
    expect(await row("360")).toMatchObject({ userId: first, linkSource: "mobile" });
    expect((await linkStates(db)).get(second)).toBe("not_linked");
  });

  it("a login is ONE person's: a second machine person matching it is not linked", async () => {
    const u = await login("one", { aadhaarHash: H1, phone: "9811100060" });
    await person("370", { aadhaarHash: H1 });
    await link();
    await person("371", { mobile: "9811100060" });
    expect((await link()).linked).toBe(0);
    expect(await row("371")).toMatchObject({ userId: null, needsAttention: "login_linked_elsewhere" });
    expect((await row("370")).userId).toBe(u);
  });

  it("no name matching: the same name with nothing else in common is two people", async () => {
    await db.update(users).set({ fullName: "Dr A Kumar" }).where(eq(users.id, await login("a.kumar2")));
    await person("380", { name: "Dr A Kumar" });
    expect(await link()).toEqual({ linked: 0, needsAttention: 0 });
  });

  it("a deactivated login gains no link; running twice changes nothing; a link is one event with no number in it", async () => {
    await login("gone", { phone: "9811100070", active: false });
    await person("390", { mobile: "9811100070" });
    expect((await link()).linked).toBe(0);
    const u = await login("here", { phone: "9811100071" });
    await person("391", { mobile: "9811100071" });
    expect((await link()).linked).toBe(1);
    expect((await link()).linked).toBe(0);
    const linked = (await db.select().from(events)).filter((e) => e.name === "attendance.person_linked");
    expect(linked.map((e) => e.payload)).toEqual([{ pin: "391", userId: u, source: "mobile" }]);
    expect(JSON.stringify(linked)).not.toContain("9811100071");
  });

  it("the ambiguity clears itself once it is resolved", async () => {
    await login("solo", { phone: "9811100080" });
    await person("392", { mobile: "9811100080" });
    await person("393", { mobile: "9811100080" });
    await link();
    expect((await row("392")).needsAttention).toBe("mobile_shared_on_machine");
    await db.update(attStaff).set({ mobile: "9811100081" }).where(eq(attStaff.pin, "393"));
    expect((await link()).linked).toBe(1);
    expect(await row("392")).toMatchObject({ linkSource: "mobile", needsAttention: null });
    expect((await row("393")).needsAttention).toBeNull();
  });

  it("decideLinks is pure and total over an empty world", () => {
    expect(decideLinks([], [])).toEqual({ links: [], problems: new Map(), loginState: new Map() });
  });
});
