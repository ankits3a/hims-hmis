/* eslint-disable @typescript-eslint/no-unused-vars -- red-first stubs, replaced by the build */
import type {
  CustodyResult, DeliverInput, LateScan, PorterCardRow, RaiseReturnInput, ReturnTicketView, ScanInput, ShortResolution, TicketView,
} from "./types";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/** STORES S2b (#1112) — not built yet: the acceptance tests run red against these. */
const notBuilt = (): never => { throw new Error("not built: stores S2b custody"); };

export async function takeCustody(_db: Db, _actor: Actor, _scan: ScanInput, _now: Date = new Date()): Promise<CustodyResult> { return notBuilt(); }
export async function handOver(_db: Db, _actor: Actor, _scan: ScanInput & { fromUserId: string }, _now: Date = new Date()): Promise<CustodyResult> { return notBuilt(); }
export async function takeOverCustody(_db: Db, _actor: Actor, _indentId: string, _reason: string, _now: Date = new Date()): Promise<CustodyResult> { return notBuilt(); }
export async function deliverTicket(_db: Db, _actor: Actor, _indentId: string, _input: DeliverInput = {}, _now: Date = new Date()): Promise<CustodyResult> { return notBuilt(); }
export async function returnUndelivered(_db: Db, _actor: Actor, _indentId: string, _input: { clientKey?: string | null; scannedAt?: string | null } = {}, _now: Date = new Date()): Promise<CustodyResult> { return notBuilt(); }
export async function acceptReturn(_db: Db, _actor: Actor, _indentId: string, _now: Date = new Date()): Promise<TicketView> { return notBuilt(); }
export async function resolveShort(_db: Db, _actor: Actor, _indentId: string, _input: { lineIdx: number; resolution: ShortResolution; note?: string | null }, _now: Date = new Date()): Promise<{ ticket: TicketView; approvalId: string | null }> { return notBuilt(); }
export async function raiseReturn(_db: Db, _actor: Actor, _input: RaiseReturnInput, _now: Date = new Date()): Promise<ReturnTicketView[]> { return notBuilt(); }
export async function receiveReturn(_db: Db, _actor: Actor, _transferId: string, _now: Date = new Date()): Promise<ReturnTicketView> { return notBuilt(); }
export async function myCustody(_db: Db, _actor: Actor, _now: Date = new Date()): Promise<PorterCardRow[]> { return notBuilt(); }
export async function lateScansToConfirm(_db: Db, _actor: Actor): Promise<LateScan[]> { return notBuilt(); }
export async function reAskShort(_db: Db, _actor: Actor, _indentId: string, _now: Date = new Date()): Promise<TicketView> { return notBuilt(); }
