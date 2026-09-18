import { hasPermission } from "../auth/permissions";
import { CopilotError } from "./types";
import type { CopilotAnswer, CopilotToolCtx, CopilotToolDecl } from "./types";
import type { ModuleRegistry } from "../modules/loader";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-COPILOT — THE TOOL CATALOG, COLLECTED AT BOOT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The fifth use of the seam `search`, `resourceKinds`, `desk` and `orderKinds` already use, and it
 * is deliberately the same shape: `ALL_MANIFESTS` is already the one place that answers "which
 * modules exist", so this reads it rather than growing a registry of its own. A module owns its own
 * tools; when the lab wants the copilot to answer about specimens, that ships with the lab and the
 * kernel learns nothing about specimens.
 */
export function collectCopilotTools(
  registry: ModuleRegistry,
  /**
   * Tools the KERNEL itself owns, because their data is the kernel's and no module could declare
   * them — the caller's own day report is composed by `kernel/desk`, from every module's providers
   * at once. They are passed in rather than imported so this file stays a collector and the
   * duplicate-intent check covers kernel and modules in ONE pass; two lists checked separately is
   * how a collision gets through.
   */
  kernelTools: readonly CopilotToolDecl[] = [],
): CopilotToolDecl[] {
  const tools = [...kernelTools, ...registry.all().flatMap((m) => m.copilotTools ?? [])];
  const claimed = new Set<string>();
  const declared = new Set(registry.allPermissions());

  for (const t of tools) {
    /*
      ONE INTENT, ONE TOOL. The router's whole job is to name an intent; if two modules claim the
      same one, "which tool runs" has no answer and whichever manifest loads first would silently
      win. `collectOrderKinds` refuses a kind two manifests claim for the same reason.
    */
    if (claimed.has(t.intent)) {
      throw new CopilotError(
        "duplicate_tool",
        `two modules claim the copilot intent "${t.intent}" — the router names an intent, so exactly one tool must answer it`,
      );
    }
    claimed.add(t.intent);

    /*
      `collectDeskProviders`' refusal, verbatim in intent: a tool gated on a permission no manifest
      declares is a tool no role can ever reach, and it would sit in the catalog looking implemented
      forever. Boot is the only honest place to find that out.
    */
    if (t.permission !== null && !declared.has(t.permission)) {
      throw new CopilotError(
        "undeclared_permission",
        `copilot tool "${t.intent}" declares permission "${t.permission}", which no manifest declares — ` +
          "a tool gated on a permission nothing declares is a tool no role can ever reach",
      );
    }
  }
  return tools;
}

/** Injected so the tests drive the permission branches without a database. */
export type PermissionCheck = (permission: string) => Promise<boolean>;

export function permissionCheckFor(ctx: CopilotToolCtx): PermissionCheck {
  return (permission: string) => hasPermission(ctx.db, ctx.actor.id, permission, "hospital");
}

/**
 * Run one tool for one question.
 *
 * ═══ EVERY REFUSAL IS A SENTENCE, NEVER A STACK TRACE ═══
 *
 * This is a counter with a queue at it. A clerk who asks a question and gets a 500 learns the box
 * is broken; a clerk told "you do not have access to that" or "which patient?" learns something
 * they can act on, and the second costs the hospital nothing. So there is no path here that reaches
 * the operator as an error — every outcome is an answer key the web can render in their language.
 */
export async function runTool(
  tool: CopilotToolDecl,
  ctx: CopilotToolCtx,
  can: PermissionCheck,
): Promise<CopilotAnswer> {
  /*
    BEFORE THE TOOL RUNS, exactly as `loadDesk` gates a card rather than running it and filtering
    after. Run-then-filter would do the work and read the data for an answer the person may not see,
    which is the only thing the permission is for.
  */
  if (tool.permission !== null && !(await can(tool.permission))) {
    return { key: "copilot.answer.notPermitted", params: {} };
  }

  /*
    A tool that needs a patient and was handed none must SAY so. Running the query against null
    would either error or, worse, answer about nobody in a sentence that reads like an answer.
  */
  if (tool.needsSubject && ctx.subject === null) {
    return { key: "copilot.answer.needSubject", params: {} };
  }

  try {
    return await tool.run(ctx);
  } catch {
    /*
      SWALLOWED, AND NOTHING OF IT REACHES THE CLERK. A database error names columns and tables:
      that is a disclosure, and it is also of no use whatever to somebody standing at a counter.
      The same bargain `runOne` makes for a desk card — one tool failing degrades its own answer and
      never the desk.
    */
    return { key: "copilot.answer.failed", params: {} };
  }
}
