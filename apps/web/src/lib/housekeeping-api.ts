import { ApiError, api } from "./api";
import type {
  BedCleansView, HkChecklistView, HkProofView, HkContractorView, HkDoorAck, HkDoorNeed, HkRotaView, HkSetupView, HkSupervisorView, HkWorkForm,
  HousekeepingBoardView, RotaPlaceInput,
} from "@hmis/contracts";

/* ═══ E1.4 HOUSEKEEPING (issue #721) — `apps/core/src/modules/housekeeping/housekeeping.controller.ts`. The paths
 * are the contract's `HOUSEKEEPING_ROUTES`, copied: the web bundle imports the contract package for TYPES only. ═══ */
const HOUSEKEEPING_ROUTES = {
  bedCleans: "/housekeeping/bed-cleans",
  board: "/housekeeping/board",
  verify: (taskId: string) => `/housekeeping/cleans/${encodeURIComponent(taskId)}/verify`,
  nudge: (taskId: string) => `/housekeeping/cleans/${encodeURIComponent(taskId)}/nudge`,
  // HK-1 (#973)
  supervisor: "/housekeeping/supervisor",
  confirm: (taskId: string) => `/housekeeping/tasks/${encodeURIComponent(taskId)}/confirm`,
  work: (taskId: string) => `/housekeeping/tasks/${encodeURIComponent(taskId)}/work`,
  photo: (taskId: string) => `/housekeeping/tasks/${encodeURIComponent(taskId)}/photo`,
  workForm: (taskId: string) => `/housekeeping/tasks/${encodeURIComponent(taskId)}/work-form`,
  proof: (taskId: string) => `/housekeeping/tasks/${encodeURIComponent(taskId)}/proof`,
  setup: "/housekeeping/setup",
  areas: "/housekeeping/areas",
  areaQr: (areaId: string) => `/housekeeping/areas/${encodeURIComponent(areaId)}/qr`,
  areaRevoke: (areaId: string) => `/housekeeping/areas/${encodeURIComponent(areaId)}/revoke-qr`,
  checklists: "/housekeeping/checklists",
  contractors: "/housekeeping/contractors",
  staff: "/housekeeping/staff",
  rotas: "/housekeeping/rotas",
  rotaPublish: (rotaId: string) => `/housekeeping/rotas/${encodeURIComponent(rotaId)}/publish`,
  door: "/housekeeping/door",
} as const;
/** The contract's housekeeping kinds the attendant works with a checklist, copied (types-only import rule). */
export const HK_WORKED_KINDS: ReadonlySet<string> = new Set([
  "bed_clean_routine", "bed_clean_terminal", "spill", "area_request", "area_round_checked", "area_round",
]);
/** The contract's `HK_FAIL_REASONS`, copied. */
export const HK_FAIL_REASONS = ["Floor wet", "Bin full", "Linen missing", "Stain", "Smell", "Toilet dirty"] as const;
/** The contract's `HOUSEKEEPING_KINDS.terminal`, copied for the same reason. */
export const TERMINAL_CLEAN_KIND = "bed_clean_terminal";

export type CleanAck = { id: string; state: string; version: number };

export const fetchBedCleans = () => api<BedCleansView>("GET", HOUSEKEEPING_ROUTES.bedCleans);
export const fetchHousekeepingBoard = () => api<HousekeepingBoardView>("GET", HOUSEKEEPING_ROUTES.board);
export const verifyCleanApi = (taskId: string, version?: number) =>
  api<CleanAck>("POST", HOUSEKEEPING_ROUTES.verify(taskId), version === undefined ? {} : { version });
export const nudgeCleanApi = (taskId: string) => api<CleanAck>("POST", HOUSEKEEPING_ROUTES.nudge(taskId), {});

/** The refusal a housekeeping or task door answered with: its code and the server's own fix, or null. */
export function cleanRefusal(e: unknown): { code: string; message: string; fix: string } | null {
  if (!(e instanceof ApiError)) return null;
  const b = e.body as { code?: unknown; message?: unknown; fix?: unknown } | null;
  if (typeof b?.code !== "string") return null;
  return { code: b.code, message: typeof b.message === "string" ? b.message : "", fix: typeof b.fix === "string" ? b.fix : "" };
}

/* ═══ HK-1 (#973) ═══ */
export const fetchHkSupervisor = () => api<HkSupervisorView>("GET", HOUSEKEEPING_ROUTES.supervisor);
export const confirmCleanApi = (taskId: string, result: "pass" | "fail", reason?: string) =>
  api<CleanAck>("POST", HOUSEKEEPING_ROUTES.confirm(taskId), reason === undefined ? { result } : { result, reason });
export const fetchProof = (taskId: string) => api<{ proof: HkProofView | null }>("GET", HOUSEKEEPING_ROUTES.proof(taskId));
export const fetchWorkForm = (taskId: string) => api<HkWorkForm>("GET", HOUSEKEEPING_ROUTES.workForm(taskId));
export const uploadWorkPhoto = (taskId: string, mimeType: string, imageBase64: string) =>
  api<{ photoKey: string }>("POST", HOUSEKEEPING_ROUTES.photo(taskId), { mimeType, imageBase64 });
export const finishWorkApi = (taskId: string, scan: string, answers: { itemId: string; ok: boolean }[], photoKey?: string) =>
  api<CleanAck>("POST", HOUSEKEEPING_ROUTES.work(taskId), photoKey === undefined ? { scan, answers } : { scan, answers, photoKey });
export const fetchHkSetup = () => api<HkSetupView>("GET", HOUSEKEEPING_ROUTES.setup);
export const defineAreaApi = (b: { resourceId: string; areaClass: string; checklistId: string | null; photoNeeded?: boolean }) =>
  api<{ id: string }>("POST", HOUSEKEEPING_ROUTES.areas, b);
export const fetchAreaQr = (areaId: string) => api<{ token: string }>("GET", HOUSEKEEPING_ROUTES.areaQr(areaId));
export const revokeAreaQrApi = (areaId: string) => api<{ id: string; qrVersion: number }>("POST", HOUSEKEEPING_ROUTES.areaRevoke(areaId), {});
export const saveChecklistApi = (b: { name: string; items: { text: string }[]; lineageId?: string }) =>
  api<HkChecklistView>("POST", HOUSEKEEPING_ROUTES.checklists, b);
export const addContractorApi = (name: string) => api<HkContractorView>("POST", HOUSEKEEPING_ROUTES.contractors, { name });
export const setHkStaffApi = (b: { userId: string; contractorId: string | null; skills: string[] }) =>
  api<void>("POST", HOUSEKEEPING_ROUTES.staff, b);
export const fetchRota = (shiftStartsAt?: string) =>
  api<HkRotaView>("GET", shiftStartsAt === undefined ? HOUSEKEEPING_ROUTES.rotas : `${HOUSEKEEPING_ROUTES.rotas}?shift=${encodeURIComponent(shiftStartsAt)}`);
export const saveRotaApi = (shiftStartsAt: string, places: RotaPlaceInput[]) =>
  api<HkRotaView>("POST", HOUSEKEEPING_ROUTES.rotas, { shiftStartsAt, places });
export const publishRotaApi = (rotaId: string) => api<HkRotaView>("POST", HOUSEKEEPING_ROUTES.rotaPublish(rotaId), {});
/** The public door: no session needed; the token comes from the page's URL fragment. */
export const raiseDoorRequestApi = (token: string, need: HkDoorNeed) => api<HkDoorAck>("POST", HOUSEKEEPING_ROUTES.door, { token, need });
/** The door page's address for an area's token (printed as the door QR). */
export const doorUrl = (token: string, origin: string = window.location.origin): string => `${origin}/door#${token}`;
