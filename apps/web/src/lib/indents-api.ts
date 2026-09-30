import { api } from "./api";

/**
 * PHARMACY GAP A6b — the indent wire contract, transcribed from `materials-indents.controller.ts`. An indent is a
 * sub-store (`from`) asking a supplying store (`to`) for stock; the supplying store issues it as a transfer or
 * rejects it, the requester may cancel it while it is asked. Refusals are `materialsErrors` codes
 * (`materialsErrorText`). Quantities are integer base units.
 */
export type IndentStatus = "requested" | "issued" | "rejected" | "cancelled";
export type WireIndent = {
  id: string; indentNo: string; status: IndentStatus; note: string | null;
  from: { id: string; code: string; name: string }; to: { id: string; code: string; name: string };
  requestedBy: { id: string; name: string }; requestedAt: string;
  decidedBy: { id: string; name: string } | null; decidedAt: string | null;
  rejectReason: string | null; cancelReason: string | null;
  transfer: { id: string; ref: string; status: string } | null;
  lines: {
    lineIdx: number; itemId: string; itemCode: string; itemName: string; baseUom: string;
    qtyBase: number; qtyIssued: number | null; available: number | null;
  }[];
};

export async function fetchIndents(storeId?: string): Promise<WireIndent[]> {
  const q = storeId === undefined || storeId === "" ? "" : `?${new URLSearchParams({ storeId }).toString()}`;
  return (await api<{ indents: WireIndent[] }>("GET", `/materials/indents${q}`)).indents;
}
export async function raiseIndent(input: {
  fromResourceId: string; toResourceId: string; note?: string; lines: { itemId: string; qtyBase: number }[];
}): Promise<WireIndent> {
  return (await api<{ indent: WireIndent }>("POST", "/materials/indents", input)).indent;
}
export async function issueIndent(id: string, lines: { lineIdx: number; qtyBase: number }[]): Promise<WireIndent> {
  return (await api<{ indent: WireIndent }>("POST", `/materials/indents/${encodeURIComponent(id)}/issue`, { lines })).indent;
}
export async function rejectIndent(id: string, reason: string): Promise<WireIndent> {
  return (await api<{ indent: WireIndent }>("POST", `/materials/indents/${encodeURIComponent(id)}/reject`, { reason })).indent;
}
export async function cancelIndent(id: string, reason: string): Promise<WireIndent> {
  return (await api<{ indent: WireIndent }>("POST", `/materials/indents/${encodeURIComponent(id)}/cancel`, { reason })).indent;
}
