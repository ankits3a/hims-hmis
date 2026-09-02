import { BadRequestException, HttpException } from "@nestjs/common";
import { z } from "zod";
import { ApprovalError } from "../../kernel/approvals/types";
import { OrderError, orderHttpStatus } from "../../kernel/orders/errors";
import { ResourceError, resourceHttpStatus } from "../../kernel/resources/errors";
import { WorkflowError } from "../../kernel/workflow/instances";
import { BillingError, billingHttpStatus } from "../billing";
import { OpdError } from "../opd";
import { TariffError, tariffHttpStatus } from "../tariff";
import { LabError, labHttpStatus } from "./errors";

/**
 * PLAN 17b T8 — **THE ONE ERROR MAPPER FOR ALL FIVE LAB CONTROLLERS.**
 *
 * ═══ THIS REPOSITORY HAS SHIPPED THE 500-ESCAPE THREE TIMES ═══
 *
 * Plan 09 shipped a `MembershipError` that escaped billing's `toHttp` and reached a busy counter as
 * a **500**; Plan 13 shipped it again, introduced by the FIX for the first; Plan 14 shipped it a
 * third time and its own e2e caught an unmapped `ApprovalError`. `labHttpStatus` was exported at
 * T2 for exactly this, and `lab.e2e.test.ts` drives a real refusal from EVERY family below through
 * a real route so the table is EXECUTED rather than asserted.
 *
 * ═══ THE LAB CALLS SIX ERROR-RAISING LAYERS, AND EVERY ONE OF THEM IS REACHABLE ═══
 *
 *   · `LabError`       — this module's own union, through the table T2 exported.
 *   · `OrderError`     — `placeOrder` and `advanceOrderItem`. `stale_state` is a 409 CAS loser and
 *                        `clinician_required` a 422; a bench that read either as a crash would
 *                        stop working rather than re-read.
 *   · `BillingError`   — the desk issues an invoice, the cancel issues a credit note, and the
 *                        §269ST refusal comes back through here (F27's own path).
 *   · `TariffError`    — an orderable the tariff has no price for. It is the go-live failure the
 *                        runbook's catalogue seed is written to avoid, and a counter meeting it
 *                        needs to read "no price for LABSVC-MP", not a stack trace.
 *   · `WorkflowError`  — every lab-item transition. `role_denied` is 403 within the 409 family:
 *                        "you may not" and "not now" send a technologist to different people.
 *   · `ApprovalError`  — `releaseUnpaid`'s approval lookup.
 *   · `ResourceError`  — the bench registry, when a worklist resolves one.
 *
 * Anything else RETHROWS. A 500 is a genuine bug and must stay loud.
 */
export function httpError(statusCode: number, message: string, code: string, detail?: unknown): HttpException {
  const body: { statusCode: number; message: string; code: string; detail?: unknown } = { statusCode, message, code };
  if (detail !== undefined) body.detail = detail;
  return new HttpException(body, statusCode);
}

export function toHttp(e: unknown): never {
  if (e instanceof LabError) throw httpError(labHttpStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof OrderError) throw httpError(orderHttpStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof BillingError) throw httpError(billingHttpStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof TariffError) throw httpError(tariffHttpStatus(e.code), e.message, e.code);
  if (e instanceof ApprovalError) throw httpError(409, e.message, e.code);
  if (e instanceof ResourceError) throw httpError(resourceHttpStatus(e.code), e.message, e.code);
  if (e instanceof WorkflowError) {
    throw httpError(e.code === "role_denied" ? 403 : 409, e.message, e.code);
  }
  /**
   * PLAN 17c T1 — the walk-in door opens a `V` visit through OPD, so OPD's refusals now reach this
   * mapper (`unknown_department` on day one, `unknown_doctor` when two pathologists are active).
   * OPD exports no status table; the shape of the code decides, the way its own controller does.
   */
  if (e instanceof OpdError) {
    const code = String(e.code);
    const status = /not_found$|^unknown_/.test(code) ? 404
      : /inactive$|mismatch$|^user_actor_required$/.test(code) ? 409 : 422;
    throw httpError(status, e.message, code);
  }
  throw e;
}

/** A zod refusal is a 400 with the ISSUES — a counter that is told "invalid body" cannot fix it. */
export function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}

export const idSchema = z.string().min(1).max(64);
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * DD19 — **THE NINE ROUTES THAT MUST NOT DO THEIR WORK TWICE**, named here rather than counted at
 * nine call sites. Every one of them creates a document, a tube, a number or a signature; a page
 * reload, a second tab or a duplicated request on a flaky counter uplink would otherwise place a
 * second order, draw a second tube or bill a second reflex.
 *
 * The route string IS the idempotency scope key, so it is a constant rather than a literal typed
 * twice — §2.54 at argument scope, and the failure it prevents is silent: two routes sharing a
 * scope string would let one route's replay answer the other's request.
 */
export const LAB_IDEMPOTENT_ROUTES = {
  deskOrder: "POST /lab/desk/orders",
  addOn: "POST /lab/desk/add-on",
  cancelItem: "POST /lab/desk/items/:itemId/cancel",
  printLabels: "POST /lab/collection/labels",
  collect: "POST /lab/collection/collect",
  receive: "POST /lab/bench/receive",
  reject: "POST /lab/bench/reject",
  enterResult: "POST /lab/bench/results",
  verifyResult: "POST /lab/verify/results/:resultId",
} as const;

/** The four the document lane adds. They create or hand over a REPORT, which is the same argument. */
export const LAB_REPORT_ROUTES = {
  publish: "POST /lab/reports",
  print: "POST /lab/reports/:reportId/print",
  release: "POST /lab/reports/:reportId/release",
  amend: "POST /lab/reports/:reportId/amend",
  /** Close review m7 — both of these WRITE and both lacked a key. */
  amendResult: "POST /lab/results/amend",
  rerun: "POST /lab/verify/rerun",
} as const;
