import { recordPhiAccess } from "../../kernel/phi/audit";
import { formatPaise } from "../../kernel/report/money";
import { isValidUhid, searchPatients } from "../patients";
import { patientBalance } from "./receipts";
import type { CopilotAnswer, CopilotToolDecl } from "../../kernel/copilot/types";

/**
 * ═══ E1.6 — "U00110012 KA KITNA BAAKI HAI?" ANSWERED WITH THE COUNTER'S OWN FIGURE ═══
 *
 * Decision 0064; spec /opt/hmis-context/SPEC-copilot-dues-2026-10-11.md (owner yes 2026-10-11).
 *
 * THE FIGURE IS `patientBalance(...).outstandingPaise` — the very call behind
 * `GET /billing/patients/:id/balance`, which the billing counter prints as its dues total. The
 * tool does no arithmetic of its own: a copilot quoting a different number from the counter beside
 * it is worse than one that says nothing. Dues only — the advance is never said (owner Q1, 2026-10-11).
 *
 * THE GATE is the dues route's own (`GET /billing/patients/:patientId/dues`): `billing.dues.patient.read`
 * (front desk, owner ruling 2026-09-30) or `billing.invoice.read` (the counters). The doctor role
 * holds neither — a doctor's screen never shows money (owner 2026-10-09).
 *
 * THE SUBJECT MUST BE A UHID. A bill names a patient (FD-35), so a visit number is not resolved to
 * one; and a name never reaches a tool as a subject (E0.6). The answer quotes the UHID the clerk
 * typed, never the patient's name, so a confidential patient's name cannot leak through it.
 */

const UHID_SHAPE_RE = /^[A-Za-z]{1,5}\d{8}$/;

export const billingCopilotTools: readonly CopilotToolDecl[] = [
  {
    intent: "patient_dues",
    permission: "billing.dues.patient.read",
    alsoAdmits: ["billing.invoice.read"],
    needsSubject: true,
    async run(ctx): Promise<CopilotAnswer> {
      // Upper-cased first: `isValidUhid` matches [A-Z] only (the OPD tool's order — shape, then check digit).
      const typed = (ctx.subject ?? "").trim().toUpperCase();
      if (!UHID_SHAPE_RE.test(typed)) return { key: "copilot.answer.duesNeedUhid", params: {} };
      if (!isValidUhid(typed)) return { key: "copilot.answer.uhidCheckFailed", params: { uhid: typed } };

      const patient = (await searchPatients(ctx.db, ctx.actor, typed, 5)).find((p) => p.uhid === typed);
      if (patient === undefined) return { key: "copilot.answer.visitUnknownPatient", params: {} };

      const balance = await patientBalance(ctx.db, ctx.actor, patient.id);
      await recordPhiAccess(ctx.db, {
        actor: ctx.actor,
        patientId: patient.id,
        surface: "copilot.patient_dues",
        reason: "desk copilot asked what this patient owes",
      });

      if (balance.outstandingPaise <= 0 || balance.dues.length === 0) {
        return { key: "copilot.answer.duesNone", params: { uhid: patient.uhid } };
      }
      // `listDues` is oldest-first (`seq` ascending), so the first row is the oldest unpaid bill.
      const oldest = balance.dues[0]!;
      return {
        key: "copilot.answer.duesOwed",
        params: {
          uhid: patient.uhid,
          amount: formatPaise(balance.outstandingPaise),
          count: balance.dues.length,
          billNo: oldest.invoiceNo,
          date: oldest.serviceDay,
        },
      };
    },
  },
];
