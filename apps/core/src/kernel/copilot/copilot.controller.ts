import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, Logger, Optional, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CONFIG, DB, MODULE_REGISTRY } from "../tokens";
import { CurrentActor, RequirePermission } from "../auth/decorators";
import { istDayString as istDay } from "../approvals/cumulative";
import { collectDeskProviders } from "../desk/registry";
import { openAiCompatibleClient } from "../inference/openai-compatible";
import { chooserFor } from "../inference/openai-decisions";
import { collectCopilotTools, permissionCheckFor, runTool } from "./catalog";
import { kernelCopilotTools } from "./kernel-tools";
import { IdentifierLeak, rehydrate } from "./mask";
import { COPILOT_NAME_SOURCE, loadDayNames, maskForAsk, nameDays, nameIndexFor } from "./names";
import type { CopilotNameSource } from "./names";
import * as router from "./router";
import { acknowledgeNotice, noticeSeen, readCopilotHealth, recordAsk } from "./ledger";
import type { AskRecord, CopilotHealth } from "./ledger";
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
  /**
   * E0.1 — the SCREEN that asked, for the ledger (G1 per seat). A short slug the web derives from
   * its route's first path segment, never a full path: a path can carry a patient's id.
   */
  screen: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).optional(),
});

/** The permission behind `GET /copilot/health` (declared by `deskManifest`). */
export const COPILOT_HEALTH_READ = "copilot.health.read";
const healthQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export type AskResponse = {
  answer: CopilotAnswer;
  /** `phrasebook` | `model` | `none` — the seat SAYS where the routing came from (`triage.ts`'s rule). */
  source: "phrasebook" | "model" | "none";
  intent: string | null;
};

@Controller("copilot")
export class CopilotController {
  private readonly tools: CopilotToolDecl[];
  private readonly nameSource: CopilotNameSource;
  private readonly logger = new Logger("copilot");

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
    /*
      E0.6 — THE NAME SOURCE IS A SEAM. Nothing provides it in production, so the day's names come
      from `loadDayNames`; a test or the eval harness provides a fixed list (or none) under the token.
    */
    @Optional() @Inject(COPILOT_NAME_SOURCE) nameSource?: CopilotNameSource,
  ) {
    this.nameSource = nameSource ?? loadDayNames;
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
    /*
      E0.1 — ONE LEDGER ROW PER REQUEST, WHATEVER BECOMES OF IT. `answer` fills `rec` as it learns
      things; the row is written in `finally`, so a refusal, a malformed body and a thrown error are
      recorded exactly like an answer. The write is AWAITED: if it fails the request fails, because
      an answer the ledger could not record would break the G6(a) reconciliation silently.
    */
    const started = Date.now();
    const rec: Omit<AskRecord, "actor" | "ms"> = {
      outcome: "error", route: "none", intent: null, answerKey: null, maskedQuestion: null, screen: null,
    };
    try {
      return await this.answer(actor, raw, rec);
    } finally {
      await recordAsk(this.db, { ...rec, actor, ms: Date.now() - started });
    }
  }

  private async answer(actor: Actor, raw: unknown, rec: Omit<AskRecord, "actor" | "ms">): Promise<AskResponse> {
    if (actor.type !== "user") {
      rec.outcome = "refusedActor";
      throw new ForbiddenException("the copilot is a desk surface — user actors only");
    }
    const parsed = askBody.safeParse(raw);
    if (!parsed.success) {
      rec.outcome = "badRequest";
      throw new BadRequestException(parsed.error.issues[0]?.message ?? "invalid body");
    }
    rec.screen = parsed.data.screen ?? null;

    const serviceDate = parsed.data.date ?? istDay(new Date());

    /*
      MASK FIRST, ALWAYS — before routing, before the floor, before anything is logged. The masked
      form is what the phrasebook scores and what the model would see, so there is no ordering in
      which an identifier could reach either.

      E0.6 — and the names of the day's patients with it, read fresh for this ask. No list (an error,
      a slow read, an overflow) or a near-spelling of a name means PHRASEBOOK-ONLY: the floor may
      still answer, nothing is sent, and with no list the ledger keeps no question text.
    */
    const names = await nameIndexFor(this.nameSource, this.db, nameDays(new Date(), serviceDate));
    const { masked, slots, nameSlots, phrasebookOnly } = maskForAsk(parsed.data.question, parsed.data.terms ?? [], names);
    if (names === null) this.logger.warn("copilot: name list unavailable — phrasebook-only for this ask");
    else if (phrasebookOnly) this.logger.log("copilot: near-spelling of a patient name — phrasebook-only for this ask");

    let routed;
    try {
      routed = await router.routeQuestion(
        masked, slots, this.model(), this.chooser(), this.cfg.copilotChoice.minConfidence, { names, phrasebookOnly },
      );
    } catch (e) {
      /*
        THE SCRUBBER FIRED. Something identifier-shaped survived masking, and the request was
        refused rather than sent. The clerk gets an ordinary "I did not understand" — there is
        nothing they can do about a masker bug — and the exception carries no identifier text, by
        construction, so this is safe to let surface in a log. The ledger row keeps NO question:
        a question the scrubber caught is by definition one that still carries an identifier.
      */
      if (e instanceof IdentifierLeak) {
        rec.outcome = "identifierLeak";
        rec.answerKey = "copilot.answer.notUnderstood";
        return { answer: { key: "copilot.answer.notUnderstood", params: {} }, source: "none", intent: null };
      }
      throw e;
    }
    // Only now is the masked form known to have passed the scrubber (or never needed it) — and
    // only with the day's names in hand is it known to carry none of them.
    if (names !== null) rec.maskedQuestion = masked;

    if (routed === null) {
      rec.outcome = "notUnderstood";
      rec.answerKey = "copilot.answer.notUnderstood";
      return { answer: { key: "copilot.answer.notUnderstood", params: {} }, source: "none", intent: null };
    }
    rec.route = routed.via;
    rec.intent = routed.intent;

    const tool = this.tools.find((t) => t.intent === routed.intent);
    if (tool === undefined) {
      /*
        A ROUTED INTENT WITH NO TOOL BEHIND IT. Real and expected: the phrasebook knows an intent
        the moment its cues are written, and the module that answers it may ship later. Saying "I
        cannot do that yet" is honest; a 500 would blame the clerk for a gap in the catalog.
      */
      rec.outcome = "noTool";
      rec.answerKey = "copilot.answer.noTool";
      return { answer: { key: "copilot.answer.noTool", params: {} }, source: routed.source, intent: routed.intent };
    }

    const ctx = {
      db: this.db,
      actor,
      /*
        REHYDRATED HERE AND NOWHERE ELSE. `rehydrate` resolves only placeholders this request
        minted, so a value reaching a tool was typed by the operator moments ago and can never be
        one the model invented. It never reaches the ledger.
      */
      /*
        E0.6 — A PLACEHOLDER MINTED FROM A SERVER NAME IS NEVER A SUBJECT. No tool resolves a name to
        a patient, and a name is not a visit number; the tool asks "which patient?" instead.
      */
      subject: routed.slot === null || nameSlots.includes(routed.slot) ? null : rehydrate(routed.slot, slots),
      serviceDate,
      question: masked,
    };

    const answer = await runTool(tool, ctx, permissionCheckFor(ctx));
    rec.answerKey = answer.key;
    rec.outcome = answer.key === "copilot.answer.notPermitted" ? "notPermitted"
      : answer.key === "copilot.answer.needSubject" ? "needSubject"
        : answer.key === "copilot.answer.failed" ? "failed"
          : "answered";
    return { answer, source: routed.source, intent: routed.intent };
  }

  /**
   * E0.1 — one IST day's totals for the owner, IT and the copilot steward. Aggregate only: no user
   * id, no name, no per-person list (plan E0.1 check 4).
   */
  @Get("health")
  @RequirePermission(COPILOT_HEALTH_READ, "hospital")
  async health(@Query() raw: unknown): Promise<CopilotHealth> {
    const q = healthQuery.safeParse(raw);
    if (!q.success) throw new BadRequestException("date must be YYYY-MM-DD");
    return readCopilotHealth(this.db, q.data.date ?? istDay(new Date()));
  }

  /**
   * The staff notice (owner ruling 2026-10-10: notice first) — has THIS user dismissed it? Self-
   * scoped structurally: it reads the caller's own row and takes no user id, so it names no
   * permission (the `GET /me/report` reasoning).
   */
  @Get("notice")
  async notice(@CurrentActor() actor: Actor): Promise<{ seen: boolean }> {
    if (actor.type !== "user") throw new ForbiddenException("user actors only");
    return { seen: await noticeSeen(this.db, actor.id) };
  }

  @Post("notice")
  @HttpCode(204)
  async dismissNotice(@CurrentActor() actor: Actor): Promise<void> {
    if (actor.type !== "user") throw new ForbiddenException("user actors only");
    await acknowledgeNotice(this.db, actor.id);
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
    return chooserFor({
      order: this.cfg.copilotChooserOrder, typesafe: this.cfg.copilotChoice, decisions: this.cfg.decisions,
      openaiKeyFile: this.cfg.openaiKeyFile, minConfidence: this.cfg.copilotChoice.minConfidence,
    });
  }
}
