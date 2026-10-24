import { api } from "./api";
import type {
  RequestTransportInput, TransportBoardView, TransportDetailsView, TransportEscortOption, TransportPatientOption,
  TransportPlaceOption, TransportRequestAck,
} from "@hmis/contracts";

/* ═══ E1.6 TRANSPORT (issue #723) — `apps/core/src/modules/transport/transport.controller.ts`. The paths are the
 * contract's `TRANSPORT_ROUTES`, copied: the web bundle imports the contract package for TYPES only. ═══ */
const TRANSPORT_ROUTES = {
  request: "/transport/requests",
  details: "/transport/details",
  board: "/transport/board",
  patients: "/transport/patients",
  places: "/transport/places",
  escorts: "/transport/escorts",
  escort: (taskId: string) => `/transport/tasks/${encodeURIComponent(taskId)}/escort`,
  oxygen: (taskId: string) => `/transport/tasks/${encodeURIComponent(taskId)}/oxygen-check`,
} as const;
/** The contract's `TRANSPORT_KINDS`, copied for the same reason. */
export const PATIENT_MOVE_KIND = "patient_move";
export const TRANSPORT_KIND_SET: ReadonlySet<string> = new Set(["patient_move", "sample_run", "document_run"]);

export const fetchTransportDetails = (ids: readonly string[]) =>
  api<TransportDetailsView>("GET", `${TRANSPORT_ROUTES.details}?ids=${ids.map(encodeURIComponent).join(",")}`);
export const fetchTransportBoard = () => api<TransportBoardView>("GET", TRANSPORT_ROUTES.board);
export const fetchTransportPatients = (q: string) =>
  api<TransportPatientOption[]>("GET", `${TRANSPORT_ROUTES.patients}?q=${encodeURIComponent(q)}`);
export const fetchTransportPlaces = () => api<TransportPlaceOption[]>("GET", TRANSPORT_ROUTES.places);
export const fetchEscorts = () => api<TransportEscortOption[]>("GET", TRANSPORT_ROUTES.escorts);
export const requestTransportApi = (body: RequestTransportInput) => api<TransportRequestAck>("POST", TRANSPORT_ROUTES.request, body);
export const addEscortApi = (taskId: string, escortUserId: string) =>
  api<{ taskId: string }>("POST", TRANSPORT_ROUTES.escort(taskId), { escortUserId });
export const oxygenCheckApi = (taskId: string) => api<{ taskId: string }>("POST", TRANSPORT_ROUTES.oxygen(taskId), {});
