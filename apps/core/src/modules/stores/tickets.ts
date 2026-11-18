import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { IssueIndentInput } from "../materials";
import type { ApproveTicketInput, RaiseTicketInput, TicketView } from "./types";

/** STORES S2a (#1112) — RED-FIRST STUBS. The build replaces every body. */
const notBuilt = (): never => { throw new Error("not built: stores S2a tickets"); };

export async function raiseTicket(_db: Db, _actor: Actor, _input: RaiseTicketInput, _now: Date = new Date()): Promise<TicketView> { return Promise.resolve(notBuilt()); }
export async function approveTicket(_db: Db, _actor: Actor, _id: string, _input: ApproveTicketInput = {}, _now: Date = new Date()): Promise<TicketView> { return Promise.resolve(notBuilt()); }
export async function declineTicket(_db: Db, _actor: Actor, _id: string, _reason: string, _now: Date = new Date()): Promise<TicketView> { return Promise.resolve(notBuilt()); }
export async function reRaiseTicket(_db: Db, _actor: Actor, _id: string, _now: Date = new Date()): Promise<TicketView> { return Promise.resolve(notBuilt()); }
export async function claimPicking(_db: Db, _actor: Actor, _id: string, _now: Date = new Date()): Promise<TicketView> { return Promise.resolve(notBuilt()); }
export async function issueTicket(_db: Db, _actor: Actor, _id: string, _input: IssueIndentInput = {}, _now: Date = new Date()): Promise<TicketView> { return Promise.resolve(notBuilt()); }
export async function getTicket(_db: Db, _id: string, _now: Date = new Date()): Promise<TicketView | undefined> { return Promise.resolve(notBuilt()); }
export async function ticketsToApprove(_db: Db, _actor: Actor, _now: Date = new Date()): Promise<TicketView[]> { return Promise.resolve(notBuilt()); }
export async function ticketsToPick(_db: Db, _actor: Actor, _now: Date = new Date()): Promise<TicketView[]> { return Promise.resolve(notBuilt()); }
export async function ticketsToReceive(_db: Db, _actor: Actor, _now: Date = new Date()): Promise<TicketView[]> { return Promise.resolve(notBuilt()); }
export async function overdueEmergencyReviews(_db: Db, _now: Date = new Date()): Promise<TicketView[]> { return Promise.resolve(notBuilt()); }
