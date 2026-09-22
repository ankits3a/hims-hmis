import { BadRequestException, Body, Controller, ForbiddenException, HttpCode, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import { CONFIG, DB, MODULE_REGISTRY } from "../tokens";
import { CurrentActor } from "../auth/decorators";
import { istDayString as istDay } from "../approvals/cumulative";
import { collectDeskProviders } from "../desk/registry";
import { openAiCompatibleClient } from "../inference/openai-compatible";
import { typesafeClient } from "../inference/typesafe";
import { collectCopilotTools, permissionCheckFor, runTool } from "./catalog";
import { kernelCopilotTools } from "./kernel-tools";
import { IdentifierLeak, maskQuestion, rehydrate } from "./mask";
import { routeQuestion } from "./router";
import type { CopilotAnswer, CopilotToolDecl } from "./types";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import type { ModuleRegistry } from "../modules/loader";
import type { Actor } from "@hmis/contracts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-COPILOT — THE DESK COPILOT'S ONE DOOR
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-17: *"we are building agentic AI based hospital operating system that uses AI agent
 * as a co-pilot to human user of the system."* This route is where a typed question becomes an act.
 *
 * ═══ IT RUNS AS THE PERSON WHO ASKED, AND THAT IS THE WHOLE SECURITY MODEL ═══
 *
 * There is no copilot identity, no service account, no `x-agent-key`. The request arrives on the
 * clerk's own session and every tool is gated on the clerk's own permissions, so the copilot is
 * exactly as powerful as the person using it and never one grant more. `kernel/auth/guards.ts`
 * mints `agent` actors that hold no permissions at all; one reaching here would read nothing, which
 * is the right failure but the wrong conversation — so a non-user actor is refused outright, as the
 * speech route refuses one for the same reason.
 *
 * That also settles the question the kernel's own design law raises. `orders/place.ts` carries
 * *"COPILOT DESIGN LAW: THE LLM NARRATES AND NEVER ORIGINATES"* and refuses an `agent` actor. This
 * route does not weaken it: nothing here writes, nothing here originates, and the model never
 * reaches a tool — it reaches a tool NAME, from a closed menu, chosen for a question a human typed.
 */
const askBody = z.object({
  question: z.string().min(1).max(500),
  /**
   * The names the SCREEN knows it is displaying, masked by value before anything leaves.
   *
   * A UHID has a shape a regular expression can find and a name does not (see `mask.ts`). The
   * screen is the only surface that knows which people are on it, so it supplies them. Capped
   * because this is operator-supplied input that becomes regular expressions.
   */
  terms: z.array(z.string().min(1).max(80)).max(20).optional(),
  date: z.string().length(10).optional(),
});

export type AskResponse = {
  answer: CopilotAnswer;
  /** `phrasebook` | `model` | `none` — the seat SAYS where the routing came from (`triage.ts`'s rule). */
  source: "phrasebook" | "model" | "none";
  intent: string | null;
};

@Controller("copilot")
export class CopilotController {
  private readonly tools: CopilotToolDecl[];

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    /*
      THE REGISTRY IS INJECTED, NOT REBUILT. `app.module.ts` already installs `ALL_MANIFESTS` into
      one, and its comment is emphatic about why a second copy of "which modules exist" is a defect:
      four hand-maintained copies of that fact are what left `admin` holding 9 of 59 permissions on
      a live box. A registry constructed here would be a fifth.
    */
    @Inject(MODULE_REGISTRY) registry: ModuleRegistry,
  ) {
    /*
      COLLECTED ONCE, AT CONSTRUCTION, so a duplicate intent or an undeclared permission fails at
      BOOT rather than on the first question somebody asks. `collectDeskProviders` refuses on the
      same schedule and for the same reason.
    */
    this.tools = collectCopilotTools(registry, kernelCopilotTools(collectDeskProviders(registry)));
  }

  @Post("ask")
  /*
    200, NOT 201. A question is not a creation, and every refusal below is a 200 carrying an answer
    key — a clerk who gets an HTTP error learns the box is broken, and a clerk who is told "which
    patient?" learns something they can act on.
  */
  @HttpCode(200)
  async ask(@CurrentActor() actor: Actor, @Body() raw: unknown): Promise<AskResponse> {
    if (actor.type !== "user") {
      throw new ForbiddenException("the copilot is a desk surface — user actors only");
    }
    const parsed = askBody.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? "invalid body");

    const serviceDate = parsed.data.date ?? istDay(new Date());

    /*
      MASK FIRST, ALWAYS — before routing, before the floor, before anything is logged. The masked
      form is what the phrasebook scores and what the model would see, so there is no ordering in
      which an identifier could reach either.
    */
    const { masked, slots } = maskQuestion(parsed.data.question, parsed.data.terms ?? []);

    let routed;
    try {
      routed = await routeQuestion(masked, slots, this.model(), this.chooser(), this.cfg.copilotChoice.minConfidence);
    } catch (e) {
      /*
        THE SCRUBBER FIRED. Something identifier-shaped survived masking, and the request was
        refused rather than sent. The clerk gets an ordinary "I did not understand" — there is
        nothing they can do about a masker bug — and the exception carries no identifier text, by
        construction, so this is safe to let surface in a log.
      */
      if (e instanceof IdentifierLeak) {
        return { answer: { key: "copilot.answer.notUnderstood", params: {} }, source: "none", intent: null };
      }
      throw e;
    }

    if (routed === null) {
      return { answer: { key: "copilot.answer.notUnderstood", params: {} }, source: "none", intent: null };
    }

    const tool = this.tools.find((t) => t.intent === routed.intent);
    if (tool === undefined) {
      /*
        A ROUTED INTENT WITH NO TOOL BEHIND IT. Real and expected: the phrasebook knows an intent
        the moment its cues are written, and the module that answers it may ship later. Saying "I
        cannot do that yet" is honest; a 500 would blame the clerk for a gap in the catalog.
      */
      return { answer: { key: "copilot.answer.noTool", params: {} }, source: routed.source, intent: routed.intent };
    }

    const ctx = {
      db: this.db,
      actor,
      /*
        REHYDRATED HERE AND NOWHERE ELSE. `rehydrate` resolves only placeholders this request
        minted, so a value reaching a tool was typed by the operator moments ago and can never be
        one the model invented.
      */
      subject: routed.slot === null ? null : rehydrate(routed.slot, slots),
      serviceDate,
      question: masked,
    };

    const answer = await runTool(tool, ctx, permissionCheckFor(ctx));
    return { answer, source: routed.source, intent: routed.intent };
  }

  /**
   * The model, or null when none is configured — which is a supported way to run this hospital. The
   * phrasebook answers on its own and the desk never learns the difference except in the long tail.
   */
  private model() {
    return openAiCompatibleClient(this.cfg.copilot);
  }

  /**
   * The router's FIRST model (owner, 2026-09-19: TypeSafe as priority, the chat model its fallback),
   * or null when no key is configured — and then `model()` answers alone, exactly as before.
   */
  private chooser() {
    return typesafeClient(this.cfg.copilotChoice);
  }
}
