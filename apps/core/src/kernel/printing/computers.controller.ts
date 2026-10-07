import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpException, Inject, NotFoundException, OnModuleInit, Param, Post, Req } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import type { Request } from "express";
import { CurrentActor, Public, RequirePermission } from "../auth/decorators";

import { DB } from "../tokens";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import { printJobs } from "../db/schema";
import { appendEvent } from "../events/append";
import { getPatient } from "../../modules/patients";
import { enqueuePrintJob } from "./enqueue";
import { HOSPITAL, esc, registerDocumentRenderer } from "./document-kit";
import {
  PRINT_COMPUTER_ALIVE_SECONDS, computerAlive, counterDestination, enrolComputer, getComputer, issueEnrolmentCode,
  listComputers, printComputerCodeIssued, printComputerEnrolled, printComputerRevoked, printJobSentToComputer,
  revokeComputer, sendJobToComputer, touchComputer,
} from "./computers";
import type { ComputerRow } from "./computers";

/**
 * ═══ THE COUNTER'S PRINT PROGRAM — the routes (decision 0047) ═══
 *
 *   administrator   POST /print/computers/codes        a one-time code for one computer
 *                   GET  /print/computers              every computer, its printer, when it last asked
 *                   POST /print/computers/:id/revoke   ends it (kill switch) and hands its paper back
 *                   POST /print/computers/:id/test     a test page on that computer's printer
 *   the installer   POST /print/enrol                  PUBLIC — spends a code, returns the key ONCE
 *   the program     POST /print/heartbeat              agent — what it is and which printers it sees
 *   the desk        GET  /print/computers/here         the computers a browser may link itself to
 *                   POST /print/jobs/:id/send-to-computer   "print this on the computer I sit at"
 *
 * `enrol` is public because the installer has nothing but the code: eight characters from a
 * 31-letter alphabet, alive fifteen minutes, spent by the first use, and rate-limited per address.
 * It returns the agent key exactly once; only the key's SHA-256 is kept.
 */

const ADMIN = "auth.users.manage";
const DESK = "opd.paper.reprint";

const codeBody = z.object({ name: z.string().trim().min(1).max(80) });
const enrolBody = z.object({
  code: z.string().min(4).max(32),
  platform: z.string().max(40).optional(),
  appVersion: z.string().max(40).optional(),
});
const heartbeatBody = z.object({
  printer: z.string().max(200).nullable().optional(),
  printers: z.array(z.string().max(200)).max(40).optional(),
  platform: z.string().max(40).optional(),
  appVersion: z.string().max(40).optional(),
});
const sendBody = z.object({ computerId: z.string().min(1) });

function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}

export type WirePrintComputer = {
  id: string; name: string; printer: string | null; printers: string[]; platform: string | null; appVersion: string | null;
  lastSeenAt: string | null; alive: boolean; revoked: boolean; createdAt: string;
};
function wire(row: ComputerRow, now: Date): WirePrintComputer {
  return {
    id: row.id, name: row.name, printer: row.printer, printers: row.printers, platform: row.platform, appVersion: row.appVersion,
    lastSeenAt: row.lastSeenAt === null ? null : row.lastSeenAt.toISOString(), alive: computerAlive(row, now), revoked: row.revokedAt !== null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Ten tries a minute per address. In memory: one api process serves the site, and a restart forgiving a minute is harmless. */
const ENROL_PER_MINUTE = 10;
const enrolTries = new Map<string, number[]>();
export function enrolAllowed(address: string, now: number = Date.now()): boolean {
  const recent = (enrolTries.get(address) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= ENROL_PER_MINUTE) { enrolTries.set(address, recent); return false; }
  recent.push(now);
  enrolTries.set(address, recent);
  if (enrolTries.size > 5000) enrolTries.clear();
  return true;
}
export function forgetEnrolTries(): void { enrolTries.clear(); }

@Controller("print")
export class PrintComputersController implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db) {}

  onModuleInit(): void {
    registerDocumentRenderer("print_test_page", async (_db, params, now) => {
      const name = typeof params["computerName"] === "string" ? params["computerName"] : "";
      const at = now.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
      return {
        title: "HMIS test page",
        page: { widthMm: 210, heightMm: 297 },
        html: `<!doctype html><html><head><meta charset="utf-8"><title>HMIS test page</title><style>@page{size:A4;margin:0}body{margin:14mm;font-family:"Noto Sans","Noto Sans Devanagari","Nirmala UI","Segoe UI",sans-serif;font-size:13pt;color:#000}h1{font-size:18pt;margin:0 0 6mm}p{margin:0 0 3mm}.box{border:1px solid #000;padding:6mm;margin-top:8mm}</style></head><body><h1>${HOSPITAL.nameTitleCase}</h1><p>Test page — this computer's print program is working.</p><p>जाँच पृष्ठ — इस कंप्यूटर का प्रिंट प्रोग्राम काम कर रहा है।</p><p>${esc(name)} · ${esc(at)} IST</p><div class="box">A4 · 210 × 297 mm — the border should be whole on all four sides.</div></body></html>`,
      };
    });
  }

  @Post("computers/codes")
  @RequirePermission(ADMIN, "hospital")
  async issueCode(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ code: string; expiresAt: string }> {
    const { name } = parsed(codeBody, body);
    return await withTx(this.db, async (tx) => {
      const issued = await issueEnrolmentCode(tx, { name, createdBy: actor.id });
      await appendEvent(tx, printComputerCodeIssued.make({ actor, payload: { codeId: issued.id, name, expiresAt: issued.expiresAt.toISOString() } }));
      return { code: issued.code, expiresAt: issued.expiresAt.toISOString() };
    });
  }

  @Get("computers")
  @RequirePermission(ADMIN, "hospital")
  async list(): Promise<{ aliveSeconds: number; computers: WirePrintComputer[] }> {
    const now = new Date();
    return { aliveSeconds: PRINT_COMPUTER_ALIVE_SECONDS, computers: (await listComputers(this.db)).map((r) => wire(r, now)) };
  }

  /** What a desk's browser may link itself to: names and liveness only, and never a revoked computer. */
  @Get("computers/here")
  @RequirePermission(DESK, "hospital")
  async here(): Promise<{ computers: { id: string; name: string; printer: string | null; alive: boolean }[] }> {
    const now = new Date();
    return {
      computers: (await listComputers(this.db)).filter((r) => r.revokedAt === null)
        .map((r) => ({ id: r.id, name: r.name, printer: r.printer, alive: computerAlive(r, now) })),
    };
  }

  @Post("computers/:id/revoke")
  @RequirePermission(ADMIN, "hospital")
  async revoke(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ revoked: boolean }> {
    return await withTx(this.db, async (tx) => {
      const row = await revokeComputer(tx, id, actor.id);
      if (row === null) return { revoked: false };
      await appendEvent(tx, printComputerRevoked.make({ actor, payload: { computerId: row.id, agentId: row.agentId, name: row.name } }));
      return { revoked: true };
    });
  }

  @Post("computers/:id/test")
  @RequirePermission(ADMIN, "hospital")
  async test(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ jobId: string | null }> {
    const computer = await getComputer(this.db, id);
    if (computer === null) throw new NotFoundException("no such print computer");
    if (!computerAlive(computer)) throw new ConflictException({ code: "print_computer_offline", message: `${computer.name} has not asked for work in the last ${String(PRINT_COMPUTER_ALIVE_SECONDS)} seconds` });
    return await withTx(this.db, async (tx) => {
      const jobId = await enqueuePrintJob(tx, {
        document: "print_test_page",
        params: { computerId: computer.id, computerName: computer.name },
        dedupeKey: `print-test:${computer.id}:${String(Date.now())}`,
        requestedBy: actor.type === "user" ? actor.id : null,
      });
      if (jobId !== null) await sendJobToComputer(tx, { jobId, computerId: computer.id });
      return { jobId };
    });
  }

  @Post("enrol")
  @Public()
  async enrol(@Req() req: Request, @Body() body: unknown): Promise<{ computerId: string; name: string; agentKey: string; destination: string; aliveSeconds: number }> {
    const address = req.ip ?? "unknown";
    if (!enrolAllowed(address)) throw new HttpException({ code: "too_many_attempts", message: "too many enrolment attempts — wait a minute" }, 429);
    const input = parsed(enrolBody, body);
    const out = await withTx(this.db, async (tx) => {
      const enrolled = await enrolComputer(tx, { code: input.code, platform: input.platform ?? null, appVersion: input.appVersion ?? null });
      if (enrolled === null) return null;
      await appendEvent(tx, printComputerEnrolled.make({
        actor: { type: "agent", id: enrolled.agentId },
        payload: { computerId: enrolled.computerId, agentId: enrolled.agentId, name: enrolled.name, codeId: enrolled.codeId, platform: input.platform ?? null, appVersion: input.appVersion ?? null },
      }));
      return enrolled;
    });
    // One answer for wrong, used and expired: the installer is told to ask for a new code either way.
    if (out === null) throw new ForbiddenException({ code: "enrolment_code_refused", message: "that code is wrong, already used, or older than fifteen minutes — ask the administrator for a new one" });
    return { computerId: out.computerId, name: out.name, agentKey: out.agentKey, destination: out.destination, aliveSeconds: PRINT_COMPUTER_ALIVE_SECONDS };
  }

  @Post("heartbeat")
  async heartbeat(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ ok: true }> {
    if (actor.type !== "agent") throw new ForbiddenException("a print program reports itself, not a user");
    const input = parsed(heartbeatBody, body);
    await touchComputer(this.db, actor.id, {
      ...(input.printer === undefined ? {} : { printer: input.printer }),
      ...(input.printers === undefined ? {} : { printers: input.printers }),
      ...(input.platform === undefined ? {} : { platform: input.platform }),
      ...(input.appVersion === undefined ? {} : { appVersion: input.appVersion }),
    });
    return { ok: true };
  }

  /**
   * The same permission and the same §14 read as `printed-here`: a desk that may not see the patient
   * may not route their paper. `sent: false` carries the reason so the browser can print instead.
   */
  @Post("jobs/:id/send-to-computer")
  @RequirePermission(DESK, "hospital")
  async send(@CurrentActor() actor: Actor, @Param("id") jobId: string, @Body() body: unknown): Promise<{ sent: boolean; reason: string | null; destination: string | null }> {
    const { computerId } = parsed(sendBody, body);
    if (actor.type !== "user") return { sent: false, reason: "not_a_user", destination: null };
    const rows = await this.db.select({ patientId: printJobs.patientId }).from(printJobs).where(eq(printJobs.id, jobId));
    const job = rows[0];
    if (job === undefined) return { sent: false, reason: "not_sendable", destination: null };
    if (job.patientId !== null && (await getPatient(this.db, actor, job.patientId)) === null) return { sent: false, reason: "not_sendable", destination: null };
    return await withTx(this.db, async (tx) => {
      const r = await sendJobToComputer(tx, { jobId, computerId });
      if (r.outcome !== "sent") return { sent: false, reason: r.outcome, destination: null };
      await appendEvent(tx, printJobSentToComputer.make({ actor, payload: { jobId, computerId, document: r.document ?? "", from: r.from ?? "" } }));
      return { sent: true, reason: null, destination: counterDestination(computerId) };
    });
  }
}
