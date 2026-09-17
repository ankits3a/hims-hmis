import type { CopilotIntent } from "./phrasebook";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

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
  /** An i18n key under `copilot.answer.*`, rendered by the web in the operator's own language. */
  key: string;
  /** Interpolations for that key. Values are already display-ready (formatted money, counts, names). */
  params: Record<string, string | number>;
  /**
   * For a tool that PRODUCES something rather than merely says something — the day report's
   * sections, a worklist, a call sheet. The web decides how to present it; the shape is the tool's.
   */
  payload?: unknown;
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
  /** Whether the question must name somebody. See the type header. */
  needsSubject: boolean;
  run(ctx: CopilotToolCtx): Promise<CopilotAnswer>;
};

export class CopilotError extends Error {
  constructor(readonly code: "duplicate_tool" | "undeclared_permission", message: string) {
    super(message);
    this.name = "CopilotError";
  }
}
