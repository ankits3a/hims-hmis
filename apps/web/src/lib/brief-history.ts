import { api } from "./api";

/**
 * ═══ CONSULT V2 — WHAT THE LAB, RADIOLOGY AND PHARMACY RECORDED, ON THE BRIEF (board `Main`) ═══
 *
 * Three patient-scoped reads, each on its owning module's route, gated and PHI-logged there:
 * signed lab values (`lab.results.read`), signed imaging reports (`radiology.reports.read`) and what
 * the pharmacy handed over (`opd.consult`). The brief turns them into two lines of the board:
 * "SINCE THEN · LAB AND RADIOLOGY" and the refill record under "ON NOW". Recorded facts only — D16.
 *
 * The shapes and the arithmetic (what counts as "since then", the refill record) are ONE file shared
 * with the phone's doctor screen: `packages/contracts/src/doctor-queue.ts` (mobile plan M3).
 */
export { BRIEF_RESULT_LINES, briefRefill, briefResults, guardianBrief, istDay, lastCompletedVisit, lastVisitCard, reportsCard, shortDay, showsLastVisit } from "../../../../packages/contracts/src/doctor-queue";
export type { BriefRefill, BriefResultLine, GuardianBrief, LastVisitCard as LastVisitCardData, WireLastVisit, WirePatientDispense, WirePatientImaging, WirePatientResult } from "../../../../packages/contracts/src/doctor-queue";
import type { WirePatientDispense, WirePatientImaging, WirePatientResult } from "../../../../packages/contracts/src/doctor-queue";

export const fetchPatientResults = (patientId: string): Promise<{ items: WirePatientResult[] }> =>
  api("GET", `/lab/results/patient/${encodeURIComponent(patientId)}`);
export const fetchPatientImaging = (patientId: string): Promise<{ items: WirePatientImaging[] }> =>
  api("GET", `/radiology/reports/patient/${encodeURIComponent(patientId)}`);
export const fetchPatientDispenses = (patientId: string): Promise<{ items: WirePatientDispense[] }> =>
  api("GET", `/pharmacy/doctor/patients/${encodeURIComponent(patientId)}/dispenses`);
