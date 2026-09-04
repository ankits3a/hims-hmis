import { api } from "./api";

/**
 * PLAN 18c T1 — the AERB registers' wire contract, transcribed from `aerb.controller.ts` exactly as
 * `radiology-api.ts` transcribes the imaging department's: this file DESCRIBES what those routes
 * ship and never re-derives or widens it.
 *
 * ═══ NOTHING HERE DECIDES WHETHER A MACHINE MAY EMIT ═══
 *
 * Whether a licence covers today, whether the gap list should name a machine, which modalities AERB
 * licences at all — every one of those is on the server, and every one is a rule an inspector could
 * be shown. A screen that recomputed any of them would be the copy that drifted (§2.54), and here
 * the drift would be a console telling a radiographer a machine is licensed when the register says
 * it is not.
 */

export type WireLicence = {
  id: string;
  deviceResourceId: string;
  deviceCode: string;
  deviceName: string;
  modality: string | null;
  licenceType: string;
  licenceNo: string;
  eloraRef: string | null;
  typeApprovalRef: string | null;
  layoutApprovalRef: string | null;
  validFrom: string;
  validTo: string;
  status: string;
  rsoUserId: string | null;
  rsoName: string | null;
  decommissionedAt: string | null;
  decommissionRef: string | null;
  remarks: string | null;
};

export type WireLicenceGap = {
  deviceResourceId: string;
  code: string;
  name: string;
  modality: string;
};

export type WireAppointment = {
  id: string;
  userId: string;
  userName: string;
  personRole: string;
  approvalRef: string | null;
  qualification: string;
  validFrom: string;
  validTo: string | null;
  active: boolean;
};

export function fetchLicences(includeInactive: boolean): Promise<{ rows: WireLicence[] }> {
  return api<{ rows: WireLicence[] }>("GET", `/aerb/licences?includeInactive=${String(includeInactive)}`);
}

export function fetchLicenceGaps(onDate: string): Promise<{ rows: WireLicenceGap[] }> {
  return api<{ rows: WireLicenceGap[] }>("GET", `/aerb/licences/gaps?onDate=${onDate}`);
}

export function fetchAppointments(): Promise<{ rows: WireAppointment[] }> {
  return api<{ rows: WireAppointment[] }>("GET", "/aerb/persons");
}

/**
 * The refusal's own code and message — `device_not_licensed` is a sentence with an action in it,
 * and "cannot proceed" is not. `radiology-api.ts`'s shape, unchanged.
 */
export function aerbErrorText(e: unknown): string {
  const body = (e as { body?: { message?: string; code?: string } } | undefined)?.body;
  if (body?.message !== undefined) return body.code === undefined ? body.message : `${body.message} (${body.code})`;
  return e instanceof Error ? e.message : String(e);
}
