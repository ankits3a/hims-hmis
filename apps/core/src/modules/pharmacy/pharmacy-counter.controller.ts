import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CONFIG, DB, MODULE_REGISTRY } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { collectOrderKinds } from "../../kernel/orders/kinds";
import { withIdempotency } from "../billing";
import { claimDispense, findAtCounter } from "./claim";
import { OPD_PHARMACY_STORE_CODE, istDateOf } from "./config";
import { PHARMACY_IDEMPOTENT_ROUTES, idSchema, parsed, toHttp } from "./pharmacy-http";
import { confirmSlip, getDispense, listQueue } from "./queue";
import { billDispense, previewDispenseBill } from "./bill";
import { handOverDispense } from "./handover";
import { labelFor } from "./label";
import { pickDispense } from "./pick";
import { checkPickScan } from "./scan";
import { cancelDispense, checkedAlternativesFor, declineLine, placementsFor, precheckTicket, verifyDispense } from "./verify";
import { cancelBilledDispense } from "./refund";
import { authorisationDetail, decideAuthorisation, requestAuthorisation } from "./authorisations";
import type { AuthorisationDetail } from "./authorisations";
import type { AuthorisationRow } from "./authorisation-reads";
import { reorderAdvice } from "./replenishment";
import { acceptReturn } from "./returns";
import { h1Register } from "./registers";
import { LEAKAGE_STORE_CODES, pharmacyLeakage } from "./leakage";
import type { LeakageReport } from "./leakage";
import { counterSummary } from "./summary";
import type { CounterSummary } from "./summary";
import type { H1Register } from "./registers";
import type { ReturnResult } from "./returns";
import type { ReorderAdvice } from "./replenishment";
import type { CancelBilledResult } from "./refund";
import type { Actor } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import type { ModuleRegistry } from "../../kernel/modules/loader";
import type { FindResult } from "./claim";
import type { DispenseView, QueueRow } from "./queue";
import type { CheckedAlternative, LinePrecheck } from "./verify";
import type { RetailShelfEntry } from "./retail";
import type { PricedDraft } from "../billing";
import type { LabelData } from "./label";

const claimBody = z.object({ dispenseId: idSchema, door: z.enum(["rx_qr", "patient_qr", "token", "uhid"]) });
const verifyBody = z.object({
  lines: z.array(z.object({
    lineIdx: z.number().int().nonnegative(),
    qtyBase: z.number().int().positive(),
    dispensedMedicineId: idSchema.optional(),
    patientConsent: z.boolean().optional(),
  })),
});
const reasonBody = z.object({ reason: z.string().min(1).max(240) });
const refundBody = z.object({ reason: z.string().min(3).max(500), reasonClass: z.enum(["mistake", "genuine"]) });
const returnBody = z.object({
  lines: z.array(z.object({ lineIdx: z.number().int().nonnegative(), qtyBase: z.number().int().positive() })).min(1).max(50),
  sealedIntact: z.literal(true),
  reason: z.string().min(3).max(500),
  reasonClass: z.enum(["mistake", "genuine"]),
});
const pickBody = z.object({
  lines: z.array(z.object({
    lineIdx: z.number().int().nonnegative(),
    qtyBase: z.number().int().positive().optional(),
    pickNote: z.string().max(240).optional(),
    batchId: idSchema.optional(),
    /** P13 — the code read off the pack in hand. */
    scan: z.string().min(1).max(200).optional(),
  })).optional(),
});
const billBody = z.object({
  tenders: z.array(z.object({ mode: z.enum(["cash", "upi", "card"]), amountPaise: z.number().int().nonnegative(), refText: z.string().max(120).optional() })).min(1),
  panNumber: z.string().max(20).optional(),
  form60: z.boolean().optional(),
  changeGivenPaise: z.number().int().nonnegative().optional(),
  tags: z.array(z.string().min(1)).optional(),
});
const handoverBody = z.object({
  identity: z.object({ via: z.enum(["token", "phone_last4"]), value: z.string().min(1).max(12) }).optional(),
});

/**
 * PLAN 16c T3 — the counter's routes. `decls` come from the INSTALLED registry (17a F2), the
 * idempotency claim wraps the transaction rather than living inside it (the lab desk's shape),
 * and every route is gated by `@RequirePermission` alone.
 */
@Controller("pharmacy")
export class PharmacyCounterController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  private decls() { return collectOrderKinds(this.registry); }

  @RequirePermission("pharmacy.dispense.read", "hospital")
  @Get("queue")
  async queue(@CurrentActor() actor: Actor, @Query("serviceDate") serviceDate?: string): Promise<{ items: QueueRow[] }> {
    return { items: await listQueue(this.db, actor, { serviceDate: serviceDate ?? istDateOf(new Date()) }) };
  }

  @RequirePermission("pharmacy.dispense.read", "hospital")
  @Get("find")
  async find(@CurrentActor() actor: Actor, @Query("q") q?: string): Promise<FindResult> {
    try {
      return await findAtCounter(this.db, this.cfg, actor, q ?? "", new Date());
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.read", "hospital")
  @Get("dispenses/:id")
  async one(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<DispenseView> {
    try {
      return await getDispense(this.db, actor, id);
    } catch (e) {
      return toHttp(e);
    }
  }

  /** P13 — what a pack scan says about a line, as the pack is scanned. Nothing is reserved. */
  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Get("dispenses/:id/lines/:idx/scan")
  async scan(@Param("id") id: string, @Param("idx") idx: string, @Query("code") code?: string): Promise<{ itemCode: string; batchNo: string | null; expiryDate: string | null }> {
    const q = parsed(z.object({ idx: z.coerce.number().int().nonnegative(), code: z.string().min(1).max(200) }), { idx, code });
    try {
      return await checkPickScan(this.db, id, q.idx, q.code);
    } catch (e) {
      return toHttp(e);
    }
  }

  /** PD-7 C3 — each equivalent comes back already put to this patient's check (`checkedAlternativesFor`). */
  @RequirePermission("pharmacy.dispense.read", "hospital")
  @Get("dispenses/:id/lines/:idx/alternatives")
  async alternatives(@CurrentActor() actor: Actor, @Param("id") id: string, @Param("idx") idx: string): Promise<{ items: CheckedAlternative[] }> {
    try {
      return { items: await checkedAlternativesFor(this.db, actor, id, Number(idx), new Date()) };
    } catch (e) {
      return toHttp(e);
    }
  }

  /**
   * PD-9 (owner ruling 2026-09-19) — ask THE PRESCRIBER to authorise one refusal on one line. The
   * counter's permission to ask; the Act's registration inside (`requestAuthorisation`).
   */
  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Post("dispenses/:id/lines/:idx/authorisations")
  async askPrescriber(@CurrentActor() actor: Actor, @Param("id") id: string, @Param("idx") idx: string, @Body() body: unknown): Promise<AuthorisationRow> {
    const lineIdx = parsed(z.object({ idx: z.coerce.number().int().nonnegative() }), { idx }).idx;
    const input = parsed(z.object({
      book: z.enum(["allergy", "interaction", "duplicate", "drug_disease"]), about: z.string().min(1).max(200),
      note: z.string().max(500).optional(), medicineId: idSchema.optional(),
    }), body);
    try {
      return await requestAuthorisation(this.db, actor, { dispenseId: id, lineIdx, ...input }, new Date());
    } catch (e) {
      return toHttp(e);
    }
  }

  /** PD-9 — the request as the prescriber reads it. The doctor's permission; the prescriber alone inside. */
  @RequirePermission("opd.consult", "hospital")
  @Get("authorisations/:id")
  async authorisation(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<AuthorisationDetail> {
    try {
      return await authorisationDetail(this.db, actor, id);
    } catch (e) {
      return toHttp(e);
    }
  }

  /** PD-9 — the prescriber authorises or declines, with a reason. */
  @RequirePermission("opd.consult", "hospital")
  @Post("authorisations/:id/decision")
  async decide(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<AuthorisationRow> {
    const input = parsed(z.object({ authorise: z.boolean(), reason: z.string().max(500) }), body);
    try {
      return await decideAuthorisation(this.db, actor, id, input, new Date());
    } catch (e) {
      return toHttp(e);
    }
  }

  /** C3b — the ticket's own lines, put to the check before anyone walks to the shelf (`precheckTicket`). */
  @RequirePermission("pharmacy.dispense.read", "hospital")
  @Get("dispenses/:id/precheck")
  async precheck(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ lines: LinePrecheck[] }> {
    try {
      return await precheckTicket(this.db, actor, id, new Date());
    } catch (e) {
      return toHttp(e);
    }
  }

  /**
   * PD-5b — what a line the catalogue could not place may be read as. The counter's own permission,
   * not the downtime clerk's (`/pharmacy/downtime/shelf`): the search is part of working a ticket,
   * and the act that places the line is still verify's, by a registered pharmacist.
   */
  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Get("dispenses/:id/lines/:idx/shelf")
  async shelf(@Param("id") id: string, @Param("idx") idx: string, @Query("q") q?: string): Promise<{ items: RetailShelfEntry[] }> {
    const input = parsed(z.object({ idx: z.coerce.number().int().nonnegative(), q: z.string().max(200).default("") }), { idx, q });
    try {
      return { items: await placementsFor(this.db, id, input.idx, input.q, new Date()) };
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Post("dispenses")
  async claim(@CurrentActor() actor: Actor, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<DispenseView> {
    const input = parsed(claimBody, body);
    try {
      return await withIdempotency(this.db, { actorId: actor.id, route: PHARMACY_IDEMPOTENT_ROUTES.claim, key }, input,
        () => claimDispense(this.db, actor, input, new Date()));
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Post("dispenses/:id/verify")
  async verify(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<DispenseView> {
    const input = parsed(verifyBody, body);
    try {
      return await withIdempotency(this.db, { actorId: actor.id, route: PHARMACY_IDEMPOTENT_ROUTES.verify, key }, { id, ...input },
        () => verifyDispense(this.db, actor, this.decls(), id, input, new Date()));
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Post("dispenses/:id/pick")
  async pick(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<DispenseView> {
    const input = parsed(pickBody, body);
    try {
      return await withIdempotency(this.db, { actorId: actor.id, route: PHARMACY_IDEMPOTENT_ROUTES.pick, key }, { id, ...input },
        () => pickDispense(this.db, actor, this.decls(), id, input, new Date()));
    } catch (e) {
      return toHttp(e);
    }
  }

  /**
   * ═══ FD-31 — THE PHARMACIST'S CROSS-CONFIRMATION (OWNER RULING 2026-09-12) ═══
   *
   * `pharmacy.dispense.place` — the counter's own key, which the pharmacist working the queue
   * already holds. Deliberately NOT `pharmacy.dispense.scheduled`: that is the registered
   * pharmacist's hand-over grant for Schedule H, and gating this on it would mean an ordinary
   * transcribed slip could not be confirmed by the person actually at the window.
   *
   * No body. The attestation is "I have the slip and it matches"; anything this route asked the
   * pharmacist to type would be a second-hand copy of what the slip already says.
   */
  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Post("dispenses/:id/confirm-slip")
  async confirmSlipRoute(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ slipConfirmedBy: string | null; slipConfirmedAt: Date | null }> {
    try {
      const row = await confirmSlip(this.db, actor, id, new Date());
      return { slipConfirmedBy: row.slipConfirmedBy, slipConfirmedAt: row.slipConfirmedAt };
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Get("dispenses/:id/bill/preview")
  async preview(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<PricedDraft> {
    try {
      return await previewDispenseBill(this.db, actor, id, new Date());
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("billing.invoice.issue", "hospital")
  @Post("dispenses/:id/bill")
  async bill(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<DispenseView> {
    const input = parsed(billBody, body);
    try {
      return await withIdempotency(this.db, { actorId: actor.id, route: PHARMACY_IDEMPOTENT_ROUTES.bill, key }, { id, ...input },
        () => billDispense(this.db, actor, id, input, new Date()));
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Post("dispenses/:id/handover")
  async handover(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<DispenseView> {
    const input = parsed(handoverBody, body);
    try {
      return await withIdempotency(this.db, { actorId: actor.id, route: PHARMACY_IDEMPOTENT_ROUTES.handover, key }, { id, ...input },
        () => handOverDispense(this.db, actor, this.decls(), id, input, new Date()));
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.read", "hospital")
  @Get("dispenses/:id/label")
  async label(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<LabelData> {
    try {
      return await labelFor(this.db, actor, id);
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Post("dispenses/:id/lines/:idx/decline")
  async decline(@CurrentActor() actor: Actor, @Param("id") id: string, @Param("idx") idx: string, @Body() body: unknown): Promise<DispenseView> {
    const { reason } = parsed(reasonBody, body);
    try {
      return await declineLine(this.db, actor, this.decls(), id, Number(idx), reason, new Date());
    } catch (e) {
      return toHttp(e);
    }
  }

  /** P6 — a sealed pack comes back: restocked, credited, its refund requested. The act asserts the rest. */
  @RequirePermission("billing.refund.request", "hospital")
  @Post("dispenses/:id/returns")
  async returns(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<ReturnResult> {
    const input = parsed(returnBody, body);
    try {
      return await withIdempotency(this.db, { actorId: actor.id, route: PHARMACY_IDEMPOTENT_ROUTES.returns, key }, { id, ...input },
        () => acceptReturn(this.db, actor, this.decls(), id, input, new Date()));
    } catch (e) {
      return toHttp(e);
    }
  }

  /** P7 — the counter's day. `day` is an IST date; today when absent. Read-only. */
  @RequirePermission("pharmacy.dispense.read", "hospital")
  @Get("summary")
  async summary(@Query("day") day?: string): Promise<CounterSummary> {
    try {
      return await counterSummary(this.db, day ?? istDateOf(new Date()));
    } catch (e) {
      return toHttp(e);
    }
  }

  /**
   * P9 — the Schedule H1 register for `from`..`to` (IST dates, at most 31 days). The read asserts the
   * permission itself, and logs one PHI access row per patient it shows.
   */
  @RequirePermission("pharmacy.register.read", "hospital")
  @Get("registers/h1")
  async h1Register(
    @CurrentActor() actor: Actor, @Query("from") from?: string, @Query("to") to?: string,
  ): Promise<H1Register> {
    try {
      return await h1Register(this.db, actor, { from: from ?? "", to: to ?? "" });
    } catch (e) {
      return toHttp(e);
    }
  }

  /**
   * P12 — the leakage triangle for one IST day (today when absent). The Leakage Auditor's report is
   * the billing supervisor's and the owner's, not the counter's: `billing.reports.read`. P19b:
   * `store` picks the counter, `PHARM-OPD` (the default) or `PHARM-RETAIL`.
   */
  @RequirePermission("billing.reports.read", "hospital")
  @Get("leakage")
  async leakage(@Query("day") day?: string, @Query("store") store?: string): Promise<LeakageReport> {
    try {
      return await pharmacyLeakage(this.db, day ?? istDateOf(new Date()), parsed(z.enum(LEAKAGE_STORE_CODES), store ?? OPD_PHARMACY_STORE_CODE));
    } catch (e) {
      return toHttp(e);
    }
  }

  /** P4 — the reorder list: what the counter will run out of, and where it can come from. Read-only. */
  @RequirePermission("pharmacy.dispense.read", "hospital")
  @Get("reorder")
  async reorder(): Promise<ReorderAdvice> {
    try {
      return await reorderAdvice(this.db, new Date());
    } catch (e) {
      return toHttp(e);
    }
  }

  /**
   * P5 — a paid dispense that cannot be collected. The act asserts the Act's registration and both
   * billing strings itself; this decorator is the first gate, not the only one.
   */
  @RequirePermission("billing.refund.request", "hospital")
  @Post("dispenses/:id/refund")
  async refund(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<CancelBilledResult> {
    const input = parsed(refundBody, body);
    try {
      return await withIdempotency(this.db, { actorId: actor.id, route: PHARMACY_IDEMPOTENT_ROUTES.refund, key }, { id, ...input },
        () => cancelBilledDispense(this.db, actor, this.decls(), id, input, new Date()));
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Post("dispenses/:id/cancel")
  async cancel(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<DispenseView> {
    const { reason } = parsed(reasonBody, body);
    try {
      return await cancelDispense(this.db, actor, this.decls(), id, reason, new Date());
    } catch (e) {
      return toHttp(e);
    }
  }
}
