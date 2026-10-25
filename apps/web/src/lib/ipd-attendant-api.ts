import { api } from "./api";
import type { IpdAttendantConsent, IpdAttendantMessages } from "@hmis/contracts";

/**
 * #761 — the admission's daily-totals card (`IPD_BILLDESK_ROUTES.attendantMessages|attendantConsent|attendantStop`). Paths are
 * copied because the web bundle imports the contract package for TYPES only. Read under `ipd.bill.view`; consent and stop
 * under `ipd.family.issue`. The recipient is always the registered attendant: no number is ever sent from here.
 */
const base = (admissionId: string): string => `/ipd/admissions/${encodeURIComponent(admissionId)}/attendant-messages`;

export function getAttendantMessages(admissionId: string): Promise<IpdAttendantMessages> {
  return api("GET", base(admissionId));
}

export function recordAttendantConsent(admissionId: string, body: IpdAttendantConsent): Promise<IpdAttendantMessages> {
  return api("POST", `${base(admissionId)}/consent`, body);
}

export function stopAttendantMessages(admissionId: string): Promise<IpdAttendantMessages> {
  return api("POST", `${base(admissionId)}/stop`, {});
}
