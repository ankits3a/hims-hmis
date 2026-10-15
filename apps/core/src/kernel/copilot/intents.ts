import type { CopilotAnswerKey } from "@hmis/contracts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * #598 (plan E0.7) — THE OPEN INTENT SEAM: A MODULE DECLARES WHAT IT ANSWERS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `copilotTools` already let a module ship the TOOL that answers an intent. The words that route a
 * question to it — the phrasebook's cues, the chooser's and the chat model's menu line, the help
 * sentence — were still kernel-held lists, so every new intent was a kernel edit to five shared files.
 * `ModuleManifest.copilotIntents` is the other half: keyed by the intent's full name (as IPD keys its
 * `IPD_INTENTS`), each entry carries everything the floor and the menus need. The kernel collects them
 * at boot (`collectCopilotIntents`, `catalog.ts`), refuses the four ways one can be wrong, and the
 * phrasebook, the router, the chooser and the help sentence read the merged set.
 *
 * The seam ADDS intents. It never reaches a gate: masking, the identifier scrubber, the halt and cap,
 * the permission check and the ledger run for a module's intent exactly as for the kernel's, because
 * they run on the routed tool, not on where its words were written.
 *
 * This file imports nothing at runtime, so a module's intent declaration can use the cue helpers
 * without pulling the kernel's copilot in.
 */

/** A phrasebook cue: a substring of the normalised question and how much evidence it is. */
export type Cue = { token: string; weight: number };

/** A cue containing a space outranks a word (`phrasebook.ts` explains the failing test it came from). */
export const PHRASE_WEIGHT = 4;
/** A STRONG cue names the intent almost by itself. */
export const strongCue = (token: string): Cue => ({ token, weight: token.includes(" ") ? PHRASE_WEIGHT : 3 });
/** A WEAK cue tips a balance a strong cue already leans. */
export const weakCue = (token: string): Cue => ({ token, weight: token.includes(" ") ? 2 : 1 });

/** A module's intent name: always `<module key>.<name>`, so it can never shadow the kernel's or a sibling's. */
export type ModuleCopilotIntent = `${string}.${string}`;

/**
 * What the models are offered. `what` / `not_for` / `examples` go to the chooser verbatim
 * (`choice-route.ts` CRITERIA's shape); `line` is the chat model's one-line menu entry, rendered as
 * `<intent> — <line>`. An intent with no `menu` is FLOOR-ONLY: no model is ever offered it.
 */
export type CopilotIntentMenu = {
  line: string;
  what: string;
  not_for?: string;
  examples?: readonly string[];
};

export type CopilotIntentDecl = {
  /** Positive cues (`strongCue` / `weakCue`), matched exactly as the kernel's are. */
  cues: readonly Cue[];
  /** Words that count AGAINST this intent (the phrasebook's NOT_CUES). */
  notCues?: readonly string[];
  /** Absent = floor-only. */
  menu?: CopilotIntentMenu;
  /**
   * Every answer key the intent's tool may return. Each must be in the translated set
   * (`COPILOT_ANSWER_KEYS`, which the web's `copilot-keys.test.ts` holds to en.json AND hi.json);
   * one that is not refuses boot rather than reaching a clerk as `copilot.answer.whatever`.
   */
  answerKeys: readonly CopilotAnswerKey[];
  /** Offered in the "I did not understand — I can…" help, after the kernel's own. */
  help?: true;
};

/** One collected declaration: which module declared it, and the declaration. */
export type CollectedCopilotIntent = { intent: ModuleCopilotIntent; module: string; decl: CopilotIntentDecl };

export class CopilotIntentError extends Error {
  constructor(readonly code: "duplicate_intent" | "cue_collision" | "untranslated_answer_key" | "intent_namespace", message: string) {
    super(message);
    this.name = "CopilotIntentError";
  }
}

/**
 * THE INSTALLED SET. `CopilotController` installs the set it collected from the injected registry at
 * boot; until something installs one (a unit test, the eval recorder) `phrasebook.ts` reads the
 * declarations straight off `ALL_MANIFESTS`, which in production is the same list. `null` restores that.
 */
let installed: readonly CollectedCopilotIntent[] | null = null;

export function installCopilotIntents(list: readonly CollectedCopilotIntent[] | null): void {
  installed = list;
}

export function installedCopilotIntents(): readonly CollectedCopilotIntent[] | null {
  return installed;
}
