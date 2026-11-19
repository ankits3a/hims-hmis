import { api } from "./api";
import type {
  StoresCondemnationReason, WireAssetAddition, WireAssetDueRow, WireAssetLookup, WireAssetPassport, WireAssetRegisterRow, WireAssetRemoval, WireCondemnation,
  WireTagLine, WireVerificationRound,
} from "@hmis/contracts";
import type { WireRenderedDocument } from "./print-api";

/**
 * STORES S4a (#1114) — the client of `modules/stores/assets.controller.ts`, the asset passport. The wire shapes live
 * in `packages/contracts/src/stores.ts`. Cost reaches only a `stores.assets.read` holder (the server leaves the key out).
 */
const enc = encodeURIComponent;
const A = "/stores/assets";

export const assetLookup = (code: string): Promise<WireAssetLookup> => api("GET", `${A}/lookup?code=${enc(code.trim())}`);
export const assetById = (unitId: string): Promise<WireAssetLookup> => api("GET", `${A}/${enc(unitId)}`);
/** "Report fault": one line, and the photo when one was taken (a JPEG, base64, capped by `PhotoCapture`). */
export const reportAssetFault = (unitId: string, text: string, imageBase64?: string | null): Promise<WireAssetPassport> =>
  api("POST", `${A}/${enc(unitId)}/fault`, imageBase64 == null ? { text } : { text, imageBase64 });
export type AssetDetails = {
  warrantyEnd?: string | null;
  contract?: { kind: "amc" | "cmc"; supplierId?: string | null; start: string; end: string } | null;
  calibration?: { doneOn: string; dueOn: string; agency: string } | null;
  installedOn?: string | null;
};
export const addAssetDetails = (unitId: string, b: AssetDetails): Promise<WireAssetPassport> => api("POST", `${A}/${enc(unitId)}/details`, b);
export const openAssetRepair = (unitId: string, note: string | null): Promise<WireAssetPassport> => api("POST", `${A}/${enc(unitId)}/repair`, { note });
export const closeAssetRepair = (unitId: string, outcome: "repaired" | "not_repairable" | "preventive"): Promise<WireAssetPassport> =>
  api("POST", `${A}/${enc(unitId)}/repair/close`, { outcome });
export const assetFoundHere = (unitId: string, shelfId: string): Promise<{ told: number }> => api("POST", `${A}/${enc(unitId)}/found-here`, { shelfId });
export const proposeAssetTransfer = (unitId: string, toShelfId: string): Promise<WireAssetPassport> => api("POST", `${A}/${enc(unitId)}/transfer`, { toShelfId });
export const acceptAssetTransfer = (code: string): Promise<WireAssetPassport> => api("POST", `${A}/transfer/accept`, { code });
export const assetLabel = (unitId: string): Promise<WireRenderedDocument | null> => api("GET", `${A}/${enc(unitId)}/label`);
export const myAssets = (): Promise<{ rows: WireAssetRegisterRow[]; toAccept?: WireAssetRegisterRow[] }> => api("GET", `${A}/mine`);
export const assetRegister = (): Promise<{ rows: WireAssetRegisterRow[] }> => api("GET", `${A}/register`);
export const assetsDue = (): Promise<{ rows: WireAssetDueRow[] }> => api("GET", `${A}/due`);
export const tagLines = (): Promise<{ lines: WireTagLine[] }> => api("GET", `${A}/grns`);
export const tagLine = (grnLineId: string): Promise<WireTagLine | null> => api("GET", `${A}/grn-lines/${enc(grnLineId)}`);
export const tagUnits = (grnLineId: string, units: { serial: string | null }[]): Promise<{ units: { id: string; tagNo: string }[]; line: WireTagLine }> =>
  api("POST", `${A}/tag`, { grnLineId, units });
export const verificationRounds = (): Promise<{ rounds: WireVerificationRound[]; departments: { id: string; name: string }[] }> => api("GET", `${A}/verification`);
export const startRound = (departmentId: string): Promise<WireVerificationRound> => api("POST", `${A}/verification`, { departmentId });
export const getRound = (roundId: string): Promise<WireVerificationRound> => api("GET", `${A}/verification/${enc(roundId)}`);
export const scanRound = (roundId: string, code: string, shelfId: string): Promise<WireVerificationRound> =>
  api("POST", `${A}/verification/${enc(roundId)}/scan`, { code, shelfId });
export const closeRound = (roundId: string): Promise<WireVerificationRound> => api("POST", `${A}/verification/${enc(roundId)}/close`, {});
export const assetAdditions = (month: string): Promise<{ month: string; rows: WireAssetAddition[] }> => api("GET", `${A}/exports/additions?month=${enc(month)}`);

// ── S4b (#1114): withdrawal, regulation, condemnation, loss, disposal ──
export const withdrawUnit = (unitId: string, reason: string): Promise<WireAssetPassport> => api("POST", `${A}/${enc(unitId)}/withdraw`, { reason });
export const returnToUse = (unitId: string): Promise<WireAssetPassport> => api("POST", `${A}/${enc(unitId)}/return-to-use`, {});
export const addRegulatorPaper = (unitId: string, kind: "decommission" | "transfer" | "intimation", refNo: string): Promise<WireAssetPassport> =>
  api("POST", `${A}/${enc(unitId)}/regulator-paper`, { kind, refNo });
export const markFound = (unitId: string, storeId: string): Promise<WireAssetPassport> => api("POST", `${A}/${enc(unitId)}/found`, { storeId });
export const condemnations = (): Promise<{ rows: WireCondemnation[] }> => api("GET", `${A}/condemnations`);
export const condemnationsToSign = (): Promise<{ rows: WireCondemnation[] }> => api("GET", `${A}/condemnations/to-sign`);
export const getCondemnation = (id: string): Promise<WireCondemnation> => api("GET", `${A}/condemnations/${enc(id)}`);
export const proposeCondemnation = (b: { unitId: string; reason: StoresCondemnationReason; note?: string | null; holdsData?: boolean }): Promise<WireCondemnation> =>
  api("POST", `${A}/condemnations`, b);
export const signCondemnation = (id: string): Promise<WireCondemnation> => api("POST", `${A}/condemnations/${enc(id)}/sign`, {});
export const objectCondemnation = (id: string, reason: string): Promise<WireCondemnation> => api("POST", `${A}/condemnations/${enc(id)}/object`, { reason });
export type DisposeBody = {
  method: "scrap_sale" | "buy_back" | "e_waste"; buyerId: string; amountPaise: number; invoiceNo: string; receiptRef?: string | null; poRef?: string | null;
  certificateNo?: string | null; wipeCertificateNo?: string | null; bids?: { vendorId: string; amountPaise: number }[];
};
export const disposeCondemned = (id: string, b: DisposeBody): Promise<{ condemnation: WireCondemnation; passId: string | null }> =>
  api("POST", `${A}/condemnations/${enc(id)}/dispose`, b);
export const writeOffLoss = (id: string, inquiryNo: string): Promise<WireCondemnation> => api("POST", `${A}/condemnations/${enc(id)}/write-off`, { inquiryNo });
export const disposalBuyers = async (): Promise<{ id: string; name: string }[]> => (await api<{ vendors: { id: string; name: string }[] }>("GET", `${A}/condemnations/buyers`)).vendors;
export const assetRemovals = (month: string): Promise<{ month: string; rows: WireAssetRemoval[] }> => api("GET", `${A}/exports/removals?month=${enc(month)}`);
