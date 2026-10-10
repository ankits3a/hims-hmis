import type { CopilotIntent } from "./phrasebook";
import type { Actor, CopilotAnswerKey } from "@hmis/contracts";
import type { Db, Tx } from "../db/client";
import type { z } from "zod";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-COPILOT — THE TOOL CATALOG'S CONTRACT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Plan 12a scope item 2 asks for exactly this: *"every agent-callable declares input schema, output
 * schema, required permission, approval requirement, the audit event it appends, and its failure
 * behaviour."* This is that declaration, in the shape the four seams before it already use —
 * `search`, `resourceKinds`, `desk` and `orderKinds` all hang off `ModuleManifest` and are collected
 * at boot, so the kernel never imports a module and a module never learns about the kernel's
 * collector. The copilot is the fifth use of that seam and deliberately looks like the other four.
 *
 * ═══ WHY THE TOOL RETURNS A KEY AND NOT A SENTENCE ═══
 *
 * A tool answers with an i18n KEY and parameters, never prose. Three reasons, in order of how much
 * they cost when ignored:
 *
 *   1. The clerk's language is the clerk's. The hospital runs in Hindi and English and the answer
 *      must arrive in whichever the operator set — `locales/hi.json` already carries eleven `agent`
 *      key groups, so this is where the hospital's Hindi already lives.
 *   2. A server composing display prose puts presentation in the one place that cannot be seen. The
 *      existing screens already answer through `t("<screen>.agent.*")`; the copilot joins them
 *      rather than inventing a second way to say things.
 *   3. It keeps the model's distance from the answer STRUCTURAL. The model picks a tool; the tool
 *      picks a key; the key picks a sentence somebody wrote and reviewed. There is no point in that
 *      chain where generated text reaches a clerk.
 */

/** What a tool hands back. Never a sentence — see the header. */
export type CopilotAnswer = {
  /**
   * An i18n key under `copilot.answer.*`, rendered by the web in the operator's own language.
   *
   * Typed to the CLOSED set in `@hmis/contracts`, so a tool cannot invent a key. An invented one
   * would not fail anywhere — `lib/i18n.ts` sets no `parseMissingKeyHandler`, so i18next renders
   * the key itself and a clerk reads `copilot.answer.whatever` where a sentence should be, with
   * every suite green. `contracts/copilot.ts` explains why that particular defect cannot be caught
   * by the test that catches all the others.
   */
  key: CopilotAnswerKey;
  /** Interpolations for that key. Values are already display-ready (formatted money, counts, names). */
  params: Record<string, string | number>;
  /**
   * For a tool that PRODUCES something rather than merely says something — the day report's
   * sections, a worklist, a call sheet. The web decides how to present it; the shape is the tool's.
   */
  payload?: unknown;
  /**
   * E0.2 — what an ACT tool would do, for a human to confirm. Read only from a tool declared
   * `kind: "act"`: the ask path validates `args` against the tool's `act.args`, signs a proposal
   * (`act.ts`) and sends THAT, never this field. Nothing is written until `POST /copilot/confirm`.
   */
  propose?: { args: unknown };
};

/** Everything a tool is given, and deliberately nothing more. */
export type CopilotToolCtx = {
  db: Db;
  /**
   * THE ASKING HUMAN, always — never an agent identity.
   *
   * The copilot runs as the person who typed the question, so their guards, their scope and their
   * 403s apply unchanged and the copilot can never reach anything they could not reach themselves.
   * `kernel/auth/guards.ts` mints `agent` actors from `x-agent-key` and they hold no permissions at
   * all; an `agent` reaching this would read nothing, which is the correct failure but the wrong
   * conversation. The controller refuses a non-`user` actor before a tool ever runs.
   */
  actor: Actor;
  /**
   * What the question was about, rehydrated — a UHID, a visit number, a phone number — or null.
   * Already resolved from the model's placeholder by `rehydrate`, so a value here was typed by the
   * operator and never invented by a model.
   */
  subject: string | null;
  /** IST service date the question is about. Today unless the operator said otherwise. */
  serviceDate: string;
  /**
   * PD-7 C8 — the question AS MASKED: every identifier already a placeholder. For a tool whose
   * subject is a THING rather than a person — a medicine by name — which no placeholder carries.
   * A tool reads words from it and never tries to reverse a placeholder; the model never sees it
   * from here (the model's copy went out, and came back as a tool name, before any tool ran).
   */
  question: string;
};

/**
 * One thing the copilot can do. Declared by the module that owns the data, collected at boot.
 *
 * `needsSubject` is not decoration: a tool that requires a patient and is handed none must refuse
 * with a sentence a clerk can act on ("which patient?"), not run a query against null and answer
 * about nobody. The collector cannot check that, so the runner does it for every tool uniformly.
 */
export type CopilotToolDecl = {
  /** The intent this tool answers. One tool per intent — the collector refuses a second claimant. */
  intent: CopilotIntent;
  /**
   * The permission the ASKING USER must hold, at hospital scope.
   *
   * Checked BEFORE the tool runs, exactly as `loadDesk` gates a card: run-then-filter would do the
   * work and read the data for an answer the person may not see. A permission no manifest declares
   * fails at BOOT, which is `collectDeskProviders`' refusal and for its reason — a tool gated on a
   * string nothing declares is a tool no role can ever reach, and it would sit in the catalog
   * looking implemented forever.
   *
   * `null` means AUTHENTICATED-ONLY, and it is a real category rather than an escape hatch. It is
   * for a tool whose answer is about the caller themselves and is self-scoped STRUCTURALLY — the
   * way `GET /me/report` has no `@RequirePermission` because `loadReport` takes no `userId` and
   * there is no argument by which it could answer about anybody else (07c DD4). A permission there
   * would be theatre: there is no wider set of data for it to gate. Anything that reads about
   * ANOTHER person names a permission, without exception.
   */
  permission: string | null;
  /**
   * E1.6 — further permissions that ALSO admit the asker, exactly as `@RequirePermission`'s
   * `alsoAdmits` does on the screen's route: the copilot is then reachable by the same seats as that
   * route and no others. Each string is boot-checked like `permission`. Ignored when `permission`
   * is null.
   */
  alsoAdmits?: readonly string[];
  /** Whether the question must name somebody. See the type header. */
  needsSubject: boolean;
  /**
   * E0.3 — what the tool does, for the halt switch: `read` (the default) answers; `draft` prepares
   * something a human then reviews; `act` writes (behind E0.2's confirm). Halting "act" stops every
   * `act` tool while reads still answer; halting "draft" stops every `draft` tool. A write tool that
   * forgot to say `act` would slip a halt, so E0.2's confirm path must refuse a tool without it.
   */
  kind?: "read" | "draft" | "act";
  run(ctx: CopilotToolCtx): Promise<CopilotAnswer>;
  /**
   * E0.2 — the WRITE, run only by `POST /copilot/confirm` after one human tap. Present exactly when
   * `kind` is `"act"`; the collector refuses either without the other at boot.
   */
  act?: CopilotActSpec;
};

/** What an act's steps are handed at confirm: the confirming human and the signed subject. */
export type CopilotActCtx = { actor: Actor; subject: string | null };

/** What `apply` hands back: the answer for the clerk and where the write landed, for `copilot_acts`. */
export type CopilotActResult = {
  answer: CopilotAnswer;
  /** The module that owns the row written (`opd`, `roster`, ...). */
  module: string;
  /** The row the write created or changed. */
  rowId: string;
  /** The patient the act was about, when it was about one (G7: no act on the wrong patient). */
  subjectPatientId: string | null;
};

/**
 * ═══ E0.2 — AN ACT TOOL'S WRITE, DECLARED (spec /opt/hmis-context/SPEC-copilot-confirm-2026-10-11.md) ═══
 *
 * Brainstorm 12 §3: propose → confirm → act → verify. `recheck`, `apply` and a `readBack` verify
 * all run inside ONE transaction with the `copilot_acts` row, so a refusal, a throw or a failed
 * read-back leaves neither the module's row nor the act row.
 *
 * Methods, not function-typed properties, on purpose: method parameters are bivariant, so a tool
 * typed on its own args (`defineAct<{ slot: string }>`) sits in the catalog's `CopilotActSpec`.
 * The confirm path parses `args` with the tool's own schema before any method sees them.
 */
export type CopilotActSpec<A = unknown> = {
  /** The exact args, validated at propose AND again at confirm. */
  args: z.ZodType<A>;
  /** How long a proposal lives, ms. Capped at 5 minutes (plan E0.2) whatever is asked. */
  ttlMs?: number;
  /**
   * Re-read the state the proposal assumed (the slot still free, the leave not already filed).
   * Null = still possible; a key = refuse with it and write nothing. The module's own constraint
   * remains the hard guarantee against a race; this is the sentence the clerk reads.
   */
  recheck(tx: Tx, args: A, ctx: CopilotActCtx): Promise<CopilotAnswerKey | null>;
  /** The module write. Throws to refuse; the transaction then holds nothing. */
  apply(tx: Tx, args: A, ctx: CopilotActCtx): Promise<CopilotActResult>;
  /**
   * Brainstorm §3's "verify", stated by every act tool: a read-back of the write inside the same
   * transaction (false ⇒ roll everything back), or a sentence saying why there is none.
   */
  verify: { readBack(tx: Tx, args: A, result: CopilotActResult, ctx: CopilotActCtx): Promise<boolean> } | { none: string };
};

/** Types an act on its own args and hands it to the catalog. */
export const defineAct = <A>(spec: CopilotActSpec<A>): CopilotActSpec => spec as CopilotActSpec;

export class CopilotError extends Error {
  constructor(readonly code: "duplicate_tool" | "undeclared_permission" | "act_undeclared", message: string) {
    super(message);
    this.name = "CopilotError";
  }
}
