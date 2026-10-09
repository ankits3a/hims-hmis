import { tokenLabel } from "../counter/rules";
import { ageYearsAt } from "../slips/rules";
import { doorsOf, humanDate, tokenText } from "../vitals/rules";
import type { Door } from "../vitals/rules";
import type { Seat } from "../seats";

/**
 * QUICK SCAN — WHAT A SCANNED PATIENT OFFERS THIS PERSON (owner 2026-10-08; approved board
 * `boards/2026-10-08-scan-vitals`, parts "scan" and "gestures").
 *
 * Pure: no React, no fetch. The server says where the visit stands and which actions this login
 * holds the permission for (`GET /opd/scan`, apps/core/src/modules/opd/scan.ts); THIS file is the
 * one place that turns that into a screen — a direct jump, or one card with the next step on top.
 * A scan and a press-and-hold on a row both end in `scanPlan`, so the two cannot offer different things.
 *
 * It only decides what is OFFERED. Every action is still refused or allowed by its own server route.
 */

export const SCAN_ACTIONS = ["vitals", "slip", "consult", "brief", "paper", "collect", "visit", "move", "book", "newVisit"] as const;
export type ScanAction = (typeof SCAN_ACTIONS)[number];
export type ScanStage = "registered" | "vitals" | "waiting" | "called" | "consult" | "done";

export type ScanPatient = { id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean; administrativeGender?: string | null; dob?: string | null };
export type ScanVisit = {
  encounterId: string; patientId: string; visitNo: string; serviceDate: string;
  tokenNo: number | null; departmentCode: string | null; departmentName: string | null;
  stage: ScanStage; vitalsDone: boolean; slip: "none" | "filed" | "retake"; feeUnpaid: boolean; mine: boolean;
  /**
   * Owner 2026-10-09 — the server says "Guardian with reports" may be OFFERED: a revisit or renewal
   * still waiting for vitals, to the bay's or the desk's grant. Optional: an older server sends none.
   */
  guardianOffer?: boolean;
  patient: ScanPatient;
};
export type ScanCandidate = Pick<ScanVisit, "encounterId" | "visitNo" | "tokenNo" | "departmentCode" | "departmentName" | "patient">;
export type ScanMissReason = "unknown" | "other_day" | "abandoned" | "no_visit_today";
/** `GET /opd/scan`, exactly as `scanResolve` returns it. */
export type ScanResult =
  | { outcome: "visit"; visit: ScanVisit; permitted: ScanAction[] }
  | { outcome: "ambiguous"; candidates: ScanCandidate[] }
  | { outcome: "miss"; reason: ScanMissReason; visitNo?: string; serviceDate?: string; status?: string; patient?: ScanPatient; permitted: ScanAction[] };

/** What the phone asks the server: a READING of the code, never the raw text. */
export type ScanQuery = { by: "visit" | "encounter" | "token" | "uhid" | "patient"; value: string; departmentCode?: string };

/** What a lookup ended in — the server's answer, or the reason there is none. */
export type ScanOutcome =
  | ScanResult
  /** The code names nothing readable, or a card the server refused (`reason` is `vitalsBay.identify.scanFailed.*`). */
  | { outcome: "unreadable"; card?: string }
  | { outcome: "offline" };

/**
 * EVERY READING OF THE TEXT, most likely first — `doorsOf`, the one reader the vitals bay and the
 * slip desk already use (token `4` / `#4` / `ORT-4`, UHID, visit number, `rx1.` e-prescription).
 * A patient card (`q1.…`) is returned apart: the server verifies it before it names anybody.
 */
export function readingsOf(raw: string): { card: string } | { queries: ScanQuery[]; first: Door | null } {
  const doors = doorsOf(raw);
  const first = doors[0] ?? null;
  if (first !== null && first.kind === "scan") return { card: first.payload };
  const queries: ScanQuery[] = [];
  for (const d of doors) {
    if (d.kind === "token") queries.push({ by: "token", value: String(d.tokenNo), ...(d.departmentCode === undefined ? {} : { departmentCode: d.departmentCode }) });
    else if (d.kind === "visit") queries.push({ by: "visit", value: d.visitNo });
    else if (d.kind === "encounter") queries.push({ by: "encounter", value: d.encounterId });
    else if (d.kind === "uhid") queries.push({ by: "uhid", value: d.uhid });
  }
  return { queries, first };
}

/** The phone screen each action lives on — an action whose screen this login cannot open is not offered. */
export const SEAT_OF: Record<ScanAction, Seat["key"]> = {
  vitals: "vitals", slip: "slips", consult: "consult", brief: "consult", paper: "consult",
  collect: "counter", visit: "counter", move: "counter", book: "counter", newVisit: "counter",
};

/** The server's permitted list, narrowed to the screens this login has on the phone. */
export function reachable(permitted: readonly ScanAction[], seats: readonly Seat["key"][]): ScanAction[] {
  return permitted.filter((a) => seats.includes(SEAT_OF[a]));
}

export type Offer = { action: ScanAction; labelKey: string; subKey?: string };
export type Greyed = Offer & { reasonKey: string };
export type Plan = {
  /** Rule b: the patient is waiting for exactly this person's job — open it, no card. */
  jump: ScanAction | null;
  /** Rule c: what this patient needs NEXT from this person — the one large button. */
  next: Offer | null;
  others: Offer[];
  /** At most two actions the patient needs that are somebody else's job — never a long grey list. */
  greyed: Greyed[];
};

const inLine = (s: ScanStage): boolean => s === "waiting" || s === "called" || s === "consult";

/** Every action this visit could take NOW, the patient's own next step first. Permission is not looked at here. */
function applicable(visit: ScanVisit, cashOpen: boolean): Offer[] {
  const out: Offer[] = [];
  const open = visit.stage !== "done";
  const needsVitals = (visit.stage === "vitals" || visit.stage === "registered") && !visit.vitalsDone;
  if (needsVitals) out.push({ action: "vitals", labelKey: "mobile.scan.act.vitals" });
  if (inLine(visit.stage)) out.push({ action: "consult", labelKey: visit.stage === "consult" ? "mobile.scan.act.consultGoOn" : "mobile.scan.act.consult" });
  if (!open && visit.slip !== "filed") out.push({ action: "slip", labelKey: "mobile.scan.act.slip", ...(visit.slip === "retake" ? { subKey: "mobile.scan.sub.retake" } : {}) });
  const collect: Offer = { action: "collect", labelKey: "mobile.scan.act.collect", subKey: cashOpen ? "mobile.scan.sub.fee" : "mobile.scan.sub.noCash" };
  if (visit.feeUnpaid && open && cashOpen) out.push(collect);
  if (open) out.push({ action: "visit", labelKey: "mobile.scan.act.visit" });
  if (visit.feeUnpaid && open && !cashOpen) out.push(collect);
  if (visit.stage !== "registered") out.push({ action: "brief", labelKey: "mobile.scan.act.brief" });
  if (inLine(visit.stage)) out.push({ action: "paper", labelKey: "mobile.scan.act.paper" });
  if (visit.vitalsDone && (visit.stage === "vitals" || visit.stage === "waiting" || visit.stage === "called")) out.push({ action: "vitals", labelKey: "mobile.scan.act.recheck" });
  if (visit.stage === "registered" || visit.stage === "vitals" || visit.stage === "waiting") out.push({ action: "move", labelKey: "mobile.scan.act.move" });
  out.push({ action: "book", labelKey: "mobile.scan.act.book" });
  if (!open) out.push({ action: "newVisit", labelKey: "mobile.scan.act.newVisit" });
  return out;
}

/** The jobs a patient is WAITING for: the only ones worth greying for somebody who may not do them. */
const WAITED_FOR: ReadonlySet<ScanAction> = new Set<ScanAction>(["vitals", "slip", "collect"]);

/**
 * THE ONE MODEL FUNCTION. `permitted` is what the server said this login may do for this visit
 * (already narrowed by `reachable`); `cashOpen` is this person's own cash session.
 *
 * A DIRECT JUMP is never a write: it opens the screen where the act is one visible tap. The vitals
 * form and the doctor's own patient open on sight; the slip and the fee — permissions nearly every
 * desk holds — open directly only for a person who has nothing else to do for this patient.
 */
export function scanPlan(visit: ScanVisit, permitted: readonly ScanAction[], ctx: { cashOpen: boolean }): Plan {
  const all = applicable(visit, ctx.cashOpen);
  const offered = all.filter((o) => permitted.includes(o.action));
  const next = offered[0] ?? null;
  const others = offered.slice(1);

  const sole = offered.length === 1;
  const jumps: ScanAction[] = [];
  if (next !== null) {
    const has = (a: ScanAction): boolean => offered.some((o) => o.action === a);
    if (has("vitals") && (visit.stage === "vitals" || visit.stage === "registered") && !visit.vitalsDone) jumps.push("vitals");
    if (has("consult") && visit.mine && inLine(visit.stage)) jumps.push("consult");
    if (has("slip") && sole) jumps.push("slip");
    if (has("collect") && ctx.cashOpen && sole) jumps.push("collect");
  }

  // Greyed: what the patient is waiting for that this person may not do. Nothing greyed beside nothing to do — no dead buttons.
  const greyed: Greyed[] = next === null ? [] : all
    .filter((o) => WAITED_FOR.has(o.action) && o.labelKey !== "mobile.scan.act.recheck" && !permitted.includes(o.action))
    .slice(0, 2)
    .map((o) => ({ action: o.action, labelKey: o.labelKey, reasonKey: "mobile.scan.notYourJob" }));

  return { jump: jumps.length === 1 ? jumps[0]! : null, next, others, greyed };
}

// ——— words ———

export type Words = { key: string; vars?: Record<string, string | number> };

/** The token as the slip prints it (`MED-9`), or the visit number when the visit holds no token. */
export function tokenOf(v: Pick<ScanVisit, "tokenNo" | "departmentCode" | "visitNo">): string {
  return v.tokenNo === null ? v.visitNo : tokenLabel(v.departmentCode, v.tokenNo);
}

/** Where the visit stands, in the words of the strip and of the green banner. */
export function stageWords(v: ScanVisit): Words {
  switch (v.stage) {
    case "registered": return { key: "mobile.scan.state.registered" };
    case "vitals": return { key: v.vitalsDone ? "mobile.scan.state.vitalsDone" : "mobile.scan.state.vitals" };
    case "waiting": return { key: v.vitalsDone ? "mobile.scan.state.vitalsDone" : "mobile.scan.state.waiting" };
    case "called": return { key: "mobile.scan.state.called" };
    case "consult": return { key: "mobile.scan.state.consult" };
    case "done": return { key: v.slip === "filed" ? "mobile.scan.state.doneFiled" : v.slip === "retake" ? "mobile.scan.state.doneRetake" : "mobile.scan.state.done" };
  }
}

/** Everything the strip says after the name: age, sex, the stage, the fee, and whose patient it is not. */
export function stripWords(v: ScanVisit, permitted: readonly ScanAction[], now: number): Words[] {
  const out: Words[] = [];
  if (!v.patient.restricted) {
    const years = ageYearsAt(v.patient.dob ?? null, now);
    if (years !== null) out.push({ key: "mobile.scan.age", vars: { years } });
    const g = (v.patient.administrativeGender ?? "").toLowerCase();
    if (g === "male" || g === "female") out.push({ key: `mobile.scan.sex.${g}` });
  }
  out.push(stageWords(v));
  if (v.feeUnpaid) out.push({ key: "mobile.scan.state.unpaid" });
  // A doctor who is not this visit's doctor is told so, since "Start consultation" is not offered.
  if (!v.mine && permitted.includes("brief") && inLine(v.stage)) out.push({ key: "mobile.scan.state.otherDoctor" });
  return out;
}

export function nameOf(p: ScanPatient): string | null {
  return p.restricted ? p.alias : (p.name ?? p.uhid);
}

export type MissView = { title: Words; body: Words | null; mayOpenVisit: boolean; patient: ScanPatient | null };

/** A miss always says WHY (board frame E). `door` is how the text was read, so the sentence can name it. */
export function missView(o: Exclude<ScanOutcome, { outcome: "visit" } | { outcome: "ambiguous" }>, door: Door | null): MissView {
  if (o.outcome === "offline") return { title: { key: "mobile.scan.miss.offline" }, body: { key: "mobile.network" }, mayOpenVisit: false, patient: null };
  if (o.outcome === "unreadable") {
    return {
      title: { key: "mobile.scan.miss.unreadable" },
      body: o.card === undefined ? { key: "mobile.scan.miss.unreadableBody" } : { key: `vitalsBay.identify.scanFailed.${o.card}` },
      mayOpenVisit: false, patient: null,
    };
  }
  const patient = o.patient ?? null;
  const mayOpenVisit = patient !== null && o.permitted.includes("newVisit");
  switch (o.reason) {
    case "other_day":
      return {
        title: { key: "mobile.scan.miss.otherDay", vars: { date: humanDate(o.serviceDate ?? "") } },
        body: { key: o.status === "completed" ? "mobile.scan.miss.otherDayCompleted" : "mobile.scan.miss.otherDayOpen", vars: { visitNo: o.visitNo ?? "" } },
        mayOpenVisit, patient,
      };
    case "abandoned":
      return { title: { key: "mobile.scan.miss.abandoned" }, body: { key: "mobile.scan.miss.abandonedBody", vars: { visitNo: o.visitNo ?? "" } }, mayOpenVisit, patient };
    case "no_visit_today":
      return { title: { key: "mobile.scan.miss.noVisit", vars: { who: patient === null ? "" : (nameOf(patient) ?? patient.uhid) } }, body: { key: "mobile.scan.miss.noVisitBody" }, mayOpenVisit, patient };
    case "unknown": {
      const body: Words = door === null ? { key: "mobile.scan.miss.unreadableBody" }
        : door.kind === "token" ? { key: "mobile.scan.miss.token", vars: { token: tokenText(door) } }
        : door.kind === "visit" ? { key: "mobile.scan.miss.visit", vars: { visitNo: door.visitNo } }
        : door.kind === "uhid" ? { key: "mobile.scan.miss.uhid", vars: { uhid: door.uhid } }
        : { key: "mobile.scan.miss.prescription" };
      return { title: { key: "mobile.scan.miss.notToday" }, body, mayOpenVisit: false, patient: null };
    }
  }
}
