import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, Logger, Optional, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CONFIG, DB, MODULE_REGISTRY } from "../tokens";
import { CurrentActor, RequirePermission } from "../auth/decorators";
import { hasPermission } from "../auth/permissions";
import { istDayString as istDay } from "../approvals/cumulative";
import { collectDeskProviders } from "../desk/registry";
import { openAiCompatibleClient } from "../inference/openai-compatible";
import { chooserFor } from "../inference/openai-decisions";
import { collectCopilotTools, permissionCheckFor, runTool } from "./catalog";
import { COPILOT_EXTRA_TOOLS, confirmProposal, issueProposal, proposalKey, proposalSchema } from "./act";
import type { ConfirmOutcome, Proposal } from "./act";
import { kernelCopilotTools } from "./kernel-tools";
import { IdentifierLeak, rehydrate } from "./mask";
import { COPILOT_NAME_SOURCE, loadDayNames, maskForAsk, nameDays, nameIndexFor } from "./names";
import type { CopilotNameSource } from "./names";
import * as router from "./router";
import { acknowledgeNotice, noticeSeen, readCopilotHealth, recordAsk } from "./ledger";
import { asksHalted, listHalts, readCopilotGate } from "./halt";
import { SpendMeter, inrToMicro } from "./spend";
import type { CopilotGate } from "./halt";
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

/** E0.2 — the confirm tap carries the proposal back exactly as the ask handed it out. */
const confirmBody = z.object({ proposal: proposalSchema }).strict();

/** The permission behind `GET /copilot/health` (declared by `deskManifest`). */
export const COPILOT_HEALTH_READ = "copilot.health.read";
const healthQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

/** E0.3/E0.5 — the health read, plus the cap and the halt switch as they stand now. */
export type CopilotHealthResponse = CopilotHealth & {
  capInr: number;
  /** The day read is today AND today's estimated spend has reached the cap: phrasebook-only till midnight IST. */
  capped: boolean;
  /** Halted scopes now. Who halted is in the audit event, not here: this page names nobody. */
  halts: { scope: string; haltedAt: string; reason: string | null }[];
};

const PAUSED = "copilot.answer.paused" as const;

export type AskResponse = {
  answer: CopilotAnswer;
  /** E0.2 — present only when an ACT tool proposed a write: the web shows it and posts it to `/copilot/confirm` on one tap. */
  proposal?: Proposal;
  /** `phrasebook` | `model` | `none` — the seat SAYS where the routing came from (`triage.ts`'s rule). */
  source: "phrasebook" | "model" | "none";
  intent: string | null;
};

@Controller("copilot")
export class CopilotController {
  private readonly tools: CopilotToolDecl[];
  private readonly nameSource: CopilotNameSource;
  private readonly logger = new Logger("copilot");
  /** E0.2 — the proposal HMAC key, derived from `SECRET_KEY`. Never logged. */
  private readonly proposalKey: Buffer;

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
    /*
      E0.2 — TOOLS NO MANIFEST DECLARES, for the protocol's tests: `CopilotModule` provides an EMPTY
      list, and only a test overrides it (with the "book a slot" fixture). Collected with the rest, so
      the boot checks cover them.
    */
    @Optional() @Inject(COPILOT_EXTRA_TOOLS) extraTools: readonly CopilotToolDecl[] = [],
  ) {
    this.nameSource = nameSource ?? loadDayNames;
    /*
      COLLECTED ONCE, AT CONSTRUCTION, so a duplicate intent or an undeclared permission fails at
      BOOT rather than on the first question somebody asks. `collectDeskProviders` refuses on the
      same schedule and for the same reason.
    */
    this.tools = collectCopilotTools(registry, [...kernelCopilotTools(collectDeskProviders(registry)), ...extraTools]);
    this.proposalKey = proposalKey(cfg.secretKey);
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

    const now = new Date();
    const serviceDate = parsed.data.date ?? istDay(now);

    /*
      E0.3 + E0.5 — ONE ROUND TRIP, EVERY ASK, NO CACHE (`halt.ts`): the halt switch and the day's
      estimated spend. A halted read path answers "paused" before anything is masked or routed.
    */
    const gate: CopilotGate = await readCopilotGate(this.db, now);
    if (asksHalted(gate.halts)) {
      rec.outcome = "halted";
      rec.answerKey = PAUSED;
      return { answer: { key: PAUSED, params: {} }, source: "none", intent: null };
    }
    /* At the cap (decision 0064) the ask routes by the phrasebook alone: no model is even built. */
    const capped = gate.spentMicroInr >= inrToMicro(this.cfg.copilotSpend.dailyCapInr);
    const meter = new SpendMeter(this.cfg.copilotSpend.prices);
    rec.capped = capped;
    rec.modelCalls = meter.calls;

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
        masked, slots,
        capped ? null : meter.complete(this.model(), this.cfg.copilot.model),
        capped ? null : this.chooser(meter),
        this.cfg.copilotChoice.minConfidence, { names, phrasebookOnly: phrasebookOnly || capped },
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

    const { propose, ...answer } = await runTool(tool, ctx, permissionCheckFor(ctx), gate.halts);
    /*
      E0.2 — AN ACT TOOL PROPOSES; NOTHING IS WRITTEN HERE. The raw `propose` never leaves: only a
      signed proposal does, and only from a declared act. Args that fail the tool's own schema make
      no proposal and the clerk reads "failed" rather than a button that could never confirm.
    */
    let proposal: Proposal | undefined;
    if (propose !== undefined && tool.kind === "act") {
      proposal = issueProposal(this.proposalKey, tool, actor, propose, ctx.subject, new Date()) ?? undefined;
      if (proposal === undefined) { answer.key = "copilot.answer.failed"; answer.params = {}; delete answer.payload; }
    }
    rec.answerKey = answer.key;
    rec.outcome = answer.key === PAUSED ? "halted"
      : answer.key === "copilot.answer.notPermitted" ? "notPermitted"
      : answer.key === "copilot.answer.needSubject" ? "needSubject"
        : answer.key === "copilot.answer.failed" ? "failed"
          : "answered";
    return { answer, source: routed.source, intent: routed.intent, ...(proposal !== undefined ? { proposal } : {}) };
  }

  /**
   * E0.2 — THE ONE HUMAN TAP. Runs the proposal's act after re-reading everything it assumed: the
   * signature, the caller, the expiry, the tool's kind, the halt, the permission and the state. No
   * `@RequirePermission`: like `ask`, the gate is the TOOL's permission, read inside. Every refusal
   * is a 200 with an answer key; only a malformed body is a 400.
   */
  @Post("confirm")
  @HttpCode(200)
  async confirm(@CurrentActor() actor: Actor, @Body() raw: unknown): Promise<{ outcome: ConfirmOutcome; answer: CopilotAnswer }> {
    if (actor.type !== "user") throw new ForbiddenException("the copilot is a desk surface — user actors only");
    const parsed = confirmBody.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("invalid proposal");
    const now = new Date();
    const gate = await readCopilotGate(this.db, now);
    const res = await confirmProposal({
      db: this.db, key: this.proposalKey, tools: this.tools, halts: gate.halts, now,
      can: (permission) => hasPermission(this.db, actor.id, permission, "hospital"),
    }, actor, parsed.data.proposal);
    // The outcome and the tool only: never the args, the subject or the signature.
    if (res.outcome !== "done") this.logger.log(`copilot confirm refused: ${res.outcome} (tool ${parsed.data.proposal.tool.slice(0, 64)})`);
    return { outcome: res.outcome, answer: res.answer };
  }

  /**
   * E0.1 — one IST day's totals for the owner, IT and the copilot steward. Aggregate only: no user
   * id, no name, no per-person list (plan E0.1 check 4).
   */
  @Get("health")
  @RequirePermission(COPILOT_HEALTH_READ, "hospital")
  async health(@Query() raw: unknown): Promise<CopilotHealthResponse> {
    const q = healthQuery.safeParse(raw);
    if (!q.success) throw new BadRequestException("date must be YYYY-MM-DD");
    const now = new Date();
    const date = q.data.date ?? istDay(now);
    const [health, gate, halts] = await Promise.all([readCopilotHealth(this.db, date), readCopilotGate(this.db, now), listHalts(this.db)]);
    const capInr = this.cfg.copilotSpend.dailyCapInr;
    return {
      ...health,
      capInr,
      capped: date === istDay(now) && gate.spentMicroInr >= inrToMicro(capInr),
      halts: halts.map((h) => ({ scope: h.scope, haltedAt: h.haltedAt, reason: h.reason })),
    };
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
  private chooser(meter: SpendMeter) {
    return chooserFor({
      order: this.cfg.copilotChooserOrder, typesafe: this.cfg.copilotChoice, decisions: this.cfg.decisions,
      openaiKeyFile: this.cfg.openaiKeyFile, minConfidence: this.cfg.copilotChoice.minConfidence,
      wrap: (provider, model, client) => meter.chooser(provider, model, client),
    });
  }
}
