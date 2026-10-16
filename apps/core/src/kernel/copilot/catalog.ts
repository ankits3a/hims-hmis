import { COPILOT_ANSWER_KEYS } from "@hmis/contracts";
import { hasPermission } from "../auth/permissions";
import { toolHalted } from "./halt";
import { CopilotIntentError } from "./intents";
import { kernelCueTokens, moduleHelpIntents, normaliseCue } from "./phrasebook";
import { CopilotError } from "./types";
import type { CollectedCopilotIntent, ModuleCopilotIntent } from "./intents";
import type { CopilotHaltScope } from "../db/schema";
import type { CopilotAnswer, CopilotToolCtx, CopilotToolDecl } from "./types";
import type { CopilotIntent } from "./phrasebook";
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
      E0.2 (#678) — A WRITE IS DECLARED BOTH WAYS OR NOT AT ALL. `kind: "act"` is what the act halt
      stops and what confirm admits; the `act` block is the write confirm runs. One without the other
      is either a write that slips the halt or an act tool with nothing to run.
    */
    if ((t.kind === "act") !== (t.act !== undefined)) {
      throw new CopilotError(
        "act_undeclared",
        `copilot tool "${t.intent}" must declare kind "act" and an act block together — ` +
          "a write without kind \"act\" slips the act halt, and kind \"act\" without a write has nothing to confirm",
      );
    }

    /*
      #678 — A DRAFT IS NAMED AND DECLARED TOGETHER. The plan's `draft_*` intents prepare something a
      person then reviews; the draft halt stops tools declared `kind: "draft"`. A `draft_*` tool left
      untagged answers straight through a draft halt, and a tagged tool not named `draft_*` hides
      from whoever reads the phrasebook.
    */
    if (t.intent.startsWith("draft_") !== (t.kind === "draft")) {
      throw new CopilotError(
        "draft_undeclared",
        `copilot tool "${t.intent}" must be named draft_* and declare kind "draft" together — ` +
          "an untagged draft tool answers through a draft halt",
      );
    }

    /*
      `collectDeskProviders`' refusal, verbatim in intent: a tool gated on a permission no manifest
      declares is a tool no role can ever reach, and it would sit in the catalog looking implemented
      forever. Boot is the only honest place to find that out.
    */
    for (const p of t.permission === null ? [] : [t.permission, ...(t.alsoAdmits ?? [])]) {
      if (declared.has(p)) continue;
      throw new CopilotError(
        "undeclared_permission",
        `copilot tool "${t.intent}" declares permission "${p}", which no manifest declares — ` +
          "a tool gated on a permission nothing declares is a tool no role can ever reach",
      );
    }
  }
  return tools;
}

/**
 * #598 (plan E0.7) — THE MODULES' OWN INTENTS, COLLECTED AT BOOT.
 *
 * The sixth use of the manifest seam, beside `collectCopilotTools`: every `copilotIntents` entry from
 * `registry.all()`, in registry order, refused at BOOT (never on the first question) when it is:
 *
 *   · outside its module's namespace — `<key>.<name>` keeps a module from shadowing the kernel or a sibling;
 *   · a duplicate — an intent the kernel's tables still hold, or that another module declared;
 *   · routed by a cue another intent already owns — the floor would score the two alike, and the margin
 *     rule would quietly stop answering one of them;
 *   · answered with a key that has no sentence — `translated` defaults to the contract's closed set,
 *     which the web's `copilot-keys.test.ts` holds to en.json AND hi.json; the core image carries no
 *     locale files, so that set is the boot-time witness of a translation.
 *
 * Install the result (`installCopilotIntents`) and the phrasebook, the router, the chooser and the help
 * sentence read it.
 */
export function collectCopilotIntents(
  registry: ModuleRegistry,
  translated: ReadonlySet<string> = new Set(COPILOT_ANSWER_KEYS),
): CollectedCopilotIntent[] {
  const owner = new Map<string, string>();
  for (const [intent, tokens] of kernelCueTokens()) for (const t of tokens) if (!owner.has(t)) owner.set(t, intent);
  const claimed = new Set<string>(kernelCueTokens().keys());
  const out: CollectedCopilotIntent[] = [];

  for (const m of registry.all()) {
    for (const [intent, decl] of Object.entries(m.copilotIntents ?? {})) {
      if (!intent.startsWith(`${m.key}.`) || intent.length === m.key.length + 1) {
        throw new CopilotIntentError(
          "intent_namespace",
          `module "${m.key}" declares the copilot intent "${intent}" — a module's intents are named "${m.key}.<name>"`,
        );
      }
      if (claimed.has(intent)) {
        throw new CopilotIntentError(
          "duplicate_intent",
          `the copilot intent "${intent}" is declared twice (module "${m.key}" and the kernel or another module) — the router names one intent`,
        );
      }
      claimed.add(intent);

      const mine = new Set<string>();
      for (const cue of decl.cues) {
        if (cue.weight <= 0) continue;
        const token = normaliseCue(cue.token);
        const other = owner.get(token);
        if (other !== undefined && other !== intent) {
          throw new CopilotIntentError(
            "cue_collision",
            `the copilot intent "${intent}" uses the cue "${token}", which "${other}" already owns — two intents scored alike stop answering`,
          );
        }
        mine.add(token);
      }
      for (const t of mine) owner.set(t, intent);

      for (const key of decl.answerKeys) {
        if (translated.has(key)) continue;
        throw new CopilotIntentError(
          "untranslated_answer_key",
          `the copilot intent "${intent}" may answer "${key}", which has no sentence — add it to COPILOT_ANSWER_KEYS and both locale files`,
        );
      }
      out.push({ intent: intent as ModuleCopilotIntent, module: m.key, decl });
    }
  }
  return out;
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
  /** E0.3 — the halted scopes read for THIS ask (`readCopilotGate`); none by default. */
  halts: ReadonlySet<CopilotHaltScope> = new Set(),
): Promise<CopilotAnswer> {
  /*
    E0.3 — THE HALT GOES FIRST, before the permission read: a paused copilot does no work at all for
    the tool it stopped. Generic on the tool's declared kind (see `halt.ts`).
  */
  if (toolHalted(tool, halts)) return { key: "copilot.answer.paused", params: {} };

  /*
    BEFORE THE TOOL RUNS, exactly as `loadDesk` gates a card rather than running it and filtering
    after. Run-then-filter would do the work and read the data for an answer the person may not see,
    which is the only thing the permission is for.
  */
  if (!(await toolPermitted(tool, can))) {
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

/** May the asker reach this tool? Null permission: any authenticated user. Re-read on every call, no cache. */
export async function toolPermitted(tool: Pick<CopilotToolDecl, "permission" | "alsoAdmits">, can: PermissionCheck): Promise<boolean> {
  return tool.permission === null || admitted([tool.permission, ...(tool.alsoAdmits ?? [])], can);
}

/** Any one of the gate's permissions admits; asked in order, stopping at the first held. */
async function admitted(permissions: readonly string[], can: PermissionCheck): Promise<boolean> {
  for (const p of permissions) if (await can(p)) return true;
  return false;
}

/**
 * #676 — what "I did not understand" offers instead: the help sentence's abilities, in this order,
 * kept to the ones THIS asker may use. A doctor is never offered what a patient owes (owner: the
 * doctor never sees payment); a cashier is. Checked exactly as `runTool` checks, before anything runs.
 */
export const HELP_INTENTS: readonly CopilotIntent[] = ["visit_status", "queue_depth", "patient_dues", "my_day_report"];

export async function helpIntentsFor(tools: readonly CopilotToolDecl[], can: PermissionCheck): Promise<CopilotIntent[]> {
  const out: CopilotIntent[] = [];
  /* #598 — then each module intent that asks to be offered (`copilotIntents[…].help`), in registry order. */
  for (const intent of [...HELP_INTENTS, ...moduleHelpIntents()]) {
    const tool = tools.find((t) => t.intent === intent);
    if (tool !== undefined && await toolPermitted(tool, can)) out.push(intent);
  }
  return out;
}
