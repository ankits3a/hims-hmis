import { z } from "zod";
import { PROPOSAL_MAX_TTL_MS, argsHash, canonicalJson, confirmProposal, issueProposal, proposalKey, signatureValid } from "./act";
import { collectCopilotTools } from "./catalog";
import { CopilotError, defineAct } from "./types";
import type { ConfirmDeps, Proposal } from "./act";
import type { CopilotToolDecl } from "./types";
import type { ModuleRegistry } from "../modules/loader";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * E0.2 — the proposal and the confirm gate, WITHOUT a database (spec
 * /opt/hmis-context/SPEC-copilot-confirm-2026-10-11.md). Every refusal here must happen before the
 * database is touched at all, so `db` is a proxy that fails the test if anything reads it. The
 * transaction, the replay and the rollback are `test/copilot-confirm.e2e.test.ts`'s.
 */
const key = proposalKey(Buffer.alloc(32, 7));
const clerk: Actor = { type: "user", id: "u_clerk" };
const NOW = new Date("2026-10-11T04:00:00Z");

const act = defineAct<{ slot: string }>({
  args: z.object({ slot: z.string().regex(/^\d\d:\d\d$/) }).strict(),
  recheck: () => Promise.resolve(null),
  apply: () => Promise.reject(new Error("unit tests never reach apply")),
  verify: { none: "unit fixture" },
});
const bookSlot: CopilotToolDecl = {
  intent: "fixture_book_slot" as CopilotToolDecl["intent"],
  permission: "opd.queue.read",
  needsSubject: false,
  kind: "act",
  act,
  run: () => Promise.resolve({ key: "copilot.answer.actDone", params: {} }),
};
const readTool: CopilotToolDecl = {
  intent: "queue_depth", permission: null, needsSubject: false,
  run: () => Promise.resolve({ key: "copilot.answer.queueShortest", params: {} }),
};

const untouchableDb = new Proxy({}, { get: () => { throw new Error("the database was touched before the gate refused"); } }) as Db;
const deps = (over: Partial<ConfirmDeps> = {}): ConfirmDeps => ({
  db: untouchableDb, key, tools: [bookSlot, readTool], halts: new Set(), can: () => Promise.resolve(true), now: NOW, ...over,
});
const propose = (args: unknown = { slot: "10:30" }, at: Date = NOW): Proposal => issueProposal(key, bookSlot, clerk, { args }, null, at)!;

describe("E0.2 — the proposal", () => {
  it("canonical JSON sorts keys at every depth, so both sides sign the same bytes", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
    expect(argsHash({ b: 1, a: 2 })).toBe(argsHash({ a: 2, b: 1 }));
  });

  it("binds user, tool, exact args and subject, expires within five minutes, and verifies", () => {
    const p = issueProposal(key, bookSlot, clerk, { args: { slot: "10:30" } }, "UHID123", NOW)!;
    expect(p).toMatchObject({ v: 1, userId: "u_clerk", tool: "fixture_book_slot", args: { slot: "10:30" }, subject: "UHID123" });
    expect(p.expiresAt - p.issuedAt).toBe(PROPOSAL_MAX_TTL_MS);
    expect(signatureValid(key, p)).toBe(true);
    expect(signatureValid(proposalKey(Buffer.alloc(32, 8)), p)).toBe(false);
  });

  it("caps a tool's longer TTL at five minutes", () => {
    const long: CopilotToolDecl = { ...bookSlot, act: { ...act, ttlMs: 60 * 60 * 1000 } };
    const p = issueProposal(key, long, clerk, { args: { slot: "10:30" } }, null, NOW)!;
    expect(p.expiresAt - p.issuedAt).toBe(PROPOSAL_MAX_TTL_MS);
  });

  it("makes no proposal for a tool that is not a declared act, or for args its own schema refuses", () => {
    expect(issueProposal(key, readTool, clerk, { args: {} }, null, NOW)).toBeNull();
    expect(issueProposal(key, bookSlot, clerk, { args: { slot: "half past ten" } }, null, NOW)).toBeNull();
  });
});

describe("E0.2 — confirm refuses before touching the database", () => {
  it("done-means 3: args changed after signing refuse", async () => {
    const p = { ...propose(), args: { slot: "11:00" } };
    expect((await confirmProposal(deps(), clerk, p)).outcome).toBe("invalid");
  });

  it("refuses a subject, expiry or tool changed after signing", async () => {
    for (const p of [{ ...propose(), subject: "UHID999" }, { ...propose(), expiresAt: propose().expiresAt + 60_000 }, { ...propose(), tool: "queue_depth" }]) {
      expect((await confirmProposal(deps(), clerk, p)).outcome).toBe("invalid");
    }
  });

  it("refuses somebody else's proposal", async () => {
    const res = await confirmProposal(deps(), { type: "user", id: "u_other" }, propose());
    expect(res).toMatchObject({ outcome: "invalid", answer: { key: "copilot.answer.actInvalid" } });
  });

  it("done-means 2: an expired proposal refuses — at the instant of expiry and after", async () => {
    const p = propose();
    expect((await confirmProposal(deps({ now: new Date(p.expiresAt) }), clerk, p)))
      .toMatchObject({ outcome: "expired", answer: { key: "copilot.answer.actExpired" } });
    expect((await confirmProposal(deps({ now: new Date(p.expiresAt + 3_600_000) }), clerk, p)).outcome).toBe("expired");
  });

  it("done-means 7: an act halt (and a global or read halt) refuses confirm", async () => {
    for (const scope of ["act", "global", "read"] as const) {
      expect(await confirmProposal(deps({ halts: new Set([scope]) }), clerk, propose()))
        .toMatchObject({ outcome: "halted", answer: { key: "copilot.answer.paused" } });
    }
  });

  it("done-means 4: a permission not held at confirm refuses", async () => {
    expect(await confirmProposal(deps({ can: () => Promise.resolve(false) }), clerk, propose()))
      .toMatchObject({ outcome: "notPermitted", answer: { key: "copilot.answer.notPermitted" } });
  });

  it("done-means 8 (#678): a validly signed proposal naming a tool not declared act refuses", async () => {
    // Signed with the real key and naming a READ tool: only the kind check can stop it.
    const p = issueProposal(key, { ...bookSlot, intent: "queue_depth" }, clerk, { args: { slot: "10:30" } }, null, NOW)!;
    expect(signatureValid(key, p)).toBe(true);
    expect((await confirmProposal(deps(), clerk, p)).outcome).toBe("notAct");
    // ...and a tool that has gone from the catalog.
    expect((await confirmProposal(deps({ tools: [readTool] }), clerk, propose())).outcome).toBe("notAct");
  });
});

describe("E0.2 / #678 — the catalog refuses a half-declared write at boot", () => {
  const registry = { all: () => [], allPermissions: () => ["opd.queue.read"] } as unknown as ModuleRegistry;

  it("refuses kind act without an act block, and an act block without kind act", () => {
    const { act: _drop, ...noBlock } = bookSlot;
    for (const t of [noBlock, { ...bookSlot, kind: "read" as const }, { ...bookSlot, kind: undefined }]) {
      expect(() => collectCopilotTools(registry, [t])).toThrow(CopilotError);
      try { collectCopilotTools(registry, [t]); } catch (e) { expect((e as CopilotError).code).toBe("act_undeclared"); }
    }
  });

  it("accepts a fully declared act", () => {
    expect(collectCopilotTools(registry, [bookSlot])).toHaveLength(1);
  });
});
