import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import { copilotActs } from "../db/schema";
import { withTx } from "../db/client";
import { toolPermitted } from "./catalog";
import { toolHalted } from "./halt";
import type { PermissionCheck } from "./catalog";
import type { CopilotHaltScope } from "../db/schema";
import type { CopilotActCtx, CopilotActResult, CopilotAnswer, CopilotToolDecl } from "./types";
import type { Actor, CopilotAnswerKey } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * E0.2 — PROPOSE → CONFIRM → ACT (plan E0.2, decision 0064; spec
 * /opt/hmis-context/SPEC-copilot-confirm-2026-10-11.md — built overnight 2026-10-11, awaiting review)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A write tool never writes from an ask. The ask hands back a PROPOSAL — user, tool, exact args,
 * subject, expiry ≤ 5 min — under an HMAC, and nothing happens until the same human taps confirm.
 * Confirm trusts nothing the proposal implies about NOW: it re-reads the halt, the permission and
 * the state, and the module write commits with its `copilot_acts` row in one transaction or not
 * at all.
 *
 * ═══ ONE PROPOSAL, ONE ACT — WITHOUT A MIGRATION ═══
 *
 * `copilot_acts.confirm_id` is NOT NULL UNIQUE (migration 0194). The confirm id is DERIVED from the
 * proposal id (`cf_<proposal id>`), so the existing index refuses a second act for one proposal: a
 * replay is answered from the pre-read, and a concurrent double tap that passes the pre-read loses
 * on the index, which rolls back its module write with it.
 */

/** E0.2 — DI token for tools no manifest declares. `CopilotModule` provides `[]`; only tests override it. */
export const COPILOT_EXTRA_TOOLS = Symbol("COPILOT_EXTRA_TOOLS");

/** Plan E0.2: a proposal lives at most five minutes, whatever a tool asks for. */
export const PROPOSAL_MAX_TTL_MS = 5 * 60 * 1000;

export const proposalSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1).max(64),
  userId: z.string().min(1).max(64),
  tool: z.string().min(1).max(64),
  args: z.unknown(),
  subject: z.string().min(1).max(80).nullable(),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  sig: z.string().min(1).max(128),
}).strict();
export type Proposal = z.infer<typeof proposalSchema>;

/**
 * The proposal key: a sub-key of `SECRET_KEY` for this one purpose, so a proposal signature can
 * never stand in for a badge token or any other HMAC made with the root key. Never logged.
 */
export function proposalKey(secretKey: Buffer): Buffer {
  return createHmac("sha256", secretKey).update("hmis.copilot.proposal.v1").digest();
}

/** JSON with object keys sorted at every depth — one byte string per value, whichever side built it. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export const argsHash = (args: unknown): string => createHash("sha256").update(canonicalJson(args)).digest("hex");

const sign = (key: Buffer, body: Omit<Proposal, "sig">): string =>
  createHmac("sha256", key).update(canonicalJson(body)).digest("base64url");

export function signatureValid(key: Buffer, p: Proposal): boolean {
  const { sig, ...body } = p;
  const want = Buffer.from(sign(key, body));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * The ask path's half: an act tool answered with `propose`; sign it. Null when the tool is not a
 * declared act or its args fail the tool's own schema — the ask then answers `failed`, because a
 * proposal nobody could confirm is worse than none.
 */
export function issueProposal(
  key: Buffer,
  tool: CopilotToolDecl,
  actor: Actor,
  propose: { args: unknown },
  subject: string | null,
  now: Date,
): Proposal | null {
  if (tool.kind !== "act" || tool.act === undefined) return null;
  const parsed = tool.act.args.safeParse(propose.args);
  if (!parsed.success) return null;
  const ttl = Math.min(tool.act.ttlMs ?? PROPOSAL_MAX_TTL_MS, PROPOSAL_MAX_TTL_MS);
  const body: Omit<Proposal, "sig"> = {
    v: 1, id: newId(), userId: actor.id, tool: tool.intent, args: parsed.data, subject,
    issuedAt: now.getTime(), expiresAt: now.getTime() + ttl,
  };
  return { ...body, sig: sign(key, body) };
}

export type ConfirmOutcome =
  | "done" | "invalid" | "expired" | "notAct" | "halted" | "notPermitted" | "alreadyDone" | "stateChanged" | "failed";

export type ConfirmResult = { outcome: ConfirmOutcome; answer: CopilotAnswer; actId?: string };

export type ConfirmDeps = {
  db: Db;
  key: Buffer;
  tools: readonly CopilotToolDecl[];
  /** Halted scopes read for THIS confirm, fresh (`readCopilotGate`). */
  halts: ReadonlySet<CopilotHaltScope>;
  can: PermissionCheck;
  now: Date;
};

const said = (outcome: ConfirmOutcome, key: CopilotAnswerKey): ConfirmResult => ({ outcome, answer: { key, params: {} } });

/** A refusal raised INSIDE the transaction, so the transaction rolls back and the clerk reads `key`. */
class Refused extends Error {
  constructor(readonly outcome: ConfirmOutcome, readonly key: CopilotAnswerKey) {
    super(outcome);
  }
}

function isConfirmIdTaken(e: unknown): boolean {
  const pick = (x: unknown): { code?: unknown; constraint?: unknown } =>
    (typeof x === "object" && x !== null ? (x as { code?: unknown; constraint?: unknown }) : {});
  return [pick(e), pick((e as { cause?: unknown } | null)?.cause)]
    .some((c) => c.code === "23505" && c.constraint === "copilot_acts_confirm_ux");
}

export const confirmIdFor = (proposalId: string): string => `cf_${proposalId}`;

/**
 * The confirm half. Every refusal is an answer, never a stack trace (the runner's rule). The order
 * is cheapest-and-most-certain first, and nothing touches the database's write side before the
 * proposal is proven genuine, this caller's, unexpired, an act, unhalted and permitted.
 */
export async function confirmProposal(deps: ConfirmDeps, actor: Actor, p: Proposal): Promise<ConfirmResult> {
  if (!signatureValid(deps.key, p) || p.userId !== actor.id) return said("invalid", "copilot.answer.actInvalid");
  const now = deps.now.getTime();
  if (now >= p.expiresAt || p.expiresAt - p.issuedAt > PROPOSAL_MAX_TTL_MS || p.issuedAt > now + 60_000) {
    return said("expired", "copilot.answer.actExpired");
  }

  /*
    #678 — ONLY A DECLARED ACT IS CONFIRMABLE. A tool that writes without `kind: "act"` would slip
    the act halt; the collector refuses it at boot, and this refuses anything else that names a
    read or draft tool, whatever a signature says.
  */
  const tool = deps.tools.find((t) => t.intent === p.tool);
  if (tool === undefined || tool.kind !== "act" || tool.act === undefined) return said("notAct", "copilot.answer.actInvalid");
  const act = tool.act;

  if (toolHalted(tool, deps.halts)) return said("halted", "copilot.answer.paused");
  if (!(await toolPermitted(tool, deps.can))) return said("notPermitted", "copilot.answer.notPermitted");

  const args = act.args.safeParse(p.args);
  if (!args.success) return said("invalid", "copilot.answer.actInvalid");

  const confirmId = confirmIdFor(p.id);
  const prior = await deps.db.select({ id: copilotActs.id }).from(copilotActs).where(eq(copilotActs.confirmId, confirmId));
  if (prior.length > 0) return said("alreadyDone", "copilot.answer.actAlreadyDone");

  const ctx: CopilotActCtx = { actor, subject: p.subject };
  try {
    const { result, actId } = await withTx(deps.db, async (tx) => {
      const refusal = await act.recheck(tx, args.data, ctx);
      if (refusal !== null) throw new Refused("stateChanged", refusal);
      const result: CopilotActResult = await act.apply(tx, args.data, ctx);
      if ("readBack" in act.verify && !(await act.verify.readBack(tx, args.data, result, ctx))) {
        throw new Refused("failed", "copilot.answer.failed");
      }
      const actId = newId();
      await tx.insert(copilotActs).values({
        id: actId,
        actorId: actor.id,
        tool: tool.intent,
        subjectPatientId: result.subjectPatientId,
        argsHash: argsHash(args.data),
        proposalId: p.id,
        confirmId,
        resultModule: result.module,
        resultRowId: result.rowId,
      });
      return { result, actId };
    });
    return { outcome: "done", answer: result.answer, actId };
  } catch (e) {
    if (e instanceof Refused) return said(e.outcome, e.key);
    if (isConfirmIdTaken(e)) return said("alreadyDone", "copilot.answer.actAlreadyDone");
    /* SWALLOWED like `runTool`'s: a database error names tables, and a counter can do nothing with it. */
    return said("failed", "copilot.answer.failed");
  }
}
