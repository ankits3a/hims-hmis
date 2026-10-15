/**
 * ═══ "TO COLLECT" — WHAT THE DESK'S SCREENS READ THE SAME WAY (owner, 2026-10-09) ═══
 *
 * Owner: *"'To collect' list for desk, with money-off-doctor release: yes."* A visit the desk let
 * through unpaid is an ordinary patient for the doctor, with no mark; the desk and the cashier keep
 * it on this list until the fee is settled (`apps/core/src/modules/billing/to-collect.ts`).
 *
 * ONE file, pure TypeScript, no imports, and NOT in the contracts index — the arrangement of
 * `doctor-queue.ts` and `app-home.ts`. The web desk and the phone read the same path.
 * NOTHING HERE IS A DOCTOR'S: no doctor screen imports this file, and the route refuses the role.
 */

// ——— the wire: `GET /billing/to-collect` exactly as `toCollectList` returns it ———

export type ToCollectState = "done" | "left" | "with_doctor" | "waiting";
export type WireToCollectRow = {
  encounterId: string; visitNo: string; serviceDate: string;
  patientId: string; patientName: string; uhid: string; isConfidential: boolean;
  tokenNo: number | null; doctorName: string | null;
  state: ToCollectState;
  amountDuePaise: number | null;
  letThroughBy: string; letThroughAt: string; reason: string; minutesSince: number;
};

/** The keys the route admits (`billing.controller.ts`). A seat holding none of them does not ask. */
export const TO_COLLECT_READ_PERMISSIONS = ["billing.invoice.read", "opd.visits.open", "billing.dues.patient.read"] as const;
export function mayReadToCollect(held: readonly string[]): boolean {
  return TO_COLLECT_READ_PERMISSIONS.some((p) => held.includes(p));
}

/** Seen and gone, or walked out of the line: the money most likely to leave the building. */
export function isGone(row: Pick<WireToCollectRow, "state">): boolean {
  return row.state === "done" || row.state === "left";
}
export function anyGone(rows: readonly Pick<WireToCollectRow, "state">[]): boolean {
  return rows.some(isGone);
}

/** "₹100", "₹100.50", or "—" when billing could not price it. Whole rupees carry no decimals. */
export function toCollectAmount(paise: number | null): string {
  if (paise === null) return "—";
  const rupees = Math.trunc(paise / 100);
  const rest = paise % 100;
  return rest === 0 ? `₹${String(rupees)}` : `₹${String(rupees)}.${String(rest).padStart(2, "0")}`;
}

/**
 * THE PHONE'S COLLECT RULE, the same one its scan card keeps: taking money needs
 * `billing.invoice.issue` AND an open cash session. Anybody else is told where the money is taken.
 */
export function toCollectAct(held: readonly string[], cashOpen: boolean): "collect" | "at_counter" {
  return held.includes("billing.invoice.issue") && cashOpen ? "collect" : "at_counter";
}
