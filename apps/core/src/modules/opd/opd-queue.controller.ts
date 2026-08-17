import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { CONFIG, DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { completeConsultation, saveConsultNote, startConsultation } from "./consultation";
import { transferQueue } from "./encounters";
import { parsed, toHttp } from "./opd-masters.controller";
import { getPrescriptionPrint, issuePrescription, listPrescriptions, verifyPrescriptionQr } from "./prescriptions";
import { boardSnapshot, callNext, listQueue, skipCalled, summaryByDoctor } from "./queue";
import { setSessionStatus } from "./sessions";
import { istDate } from "./time";
import type { EncounterRow, PrescriptionRow, QueueEntryRow } from "./encounters";
import type { IssuedPrescription, RxPrintData, RxVerifyResult } from "./prescriptions";
import type { BoardItem, DoctorSummary, QueueView } from "./queue";
import type { SessionRow } from "./sessions";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";

const summaryQuery = z.object({ departmentId: z.string().min(1).optional(), serviceDate: z.string().max(10).optional() });
const boardQuery = z.object({ serviceDate: z.string().max(10).optional(), roomIds: z.string().max(2000).optional() });
const transferBody = z.object({
  fromDoctorId: z.string().min(1),
  toDoctorId: z.string().min(1),
  serviceDate: z.string().min(1).max(10),
  entryIds: z.array(z.string().min(1)).optional(),
  consented: z.boolean(),
  reason: z.string().max(500),
});
const queueQuery = z.object({ doctorId: z.string().min(1), serviceDate: z.string().max(10).optional() });
const sessionStatusBody = z.object({ status: z.enum(["in", "out", "closed"]) });
const consultNoteBody = z.object({
  chiefComplaint: z.string().max(2000).nullable().optional(),
  diagnosis: z.string().max(2000).nullable().optional(),
  icd10Code: z.string().max(20).nullable().optional(),
  advice: z.string().max(4000).nullable().optional(),
  admissionAdvised: z.boolean().optional(),
  referralTo: z.string().max(200).nullable().optional(),
  referralNote: z.string().max(2000).nullable().optional(),
});
const consultCompleteBody = z.object({
  note: consultNoteBody.optional(),
  testsOrderedReturnToday: z.boolean(),
  followUpDays: z.number().int().positive().optional(), // anything but the default must be a configured extension
});
const rxLineBody = z.object({
  drug: z.string().max(300),
  dose: z.string().max(100),
  route: z.string().max(100),
  frequency: z.string().max(100),
  durationDays: z.number().int().positive().nullable(),
  instructions: z.string().max(2000).nullable(),
  noSubstitution: z.boolean(),
});
// No .min(1) on lines: an empty prescription answers empty_prescription with its OPD code, not a zod 400.
const prescriptionBody = z.object({
  lines: z.array(rxLineBody),
  overrides: z.array(z.object({
    lineIndex: z.number().int().nonnegative(), substance: z.string().max(200), reason: z.string().max(500),
  })).optional(),
});
const verifyBody = z.object({ payload: z.string().min(1).max(500) });

@Controller("opd")
export class OpdQueueController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  // ——— literal-segment routes FIRST: summary / board / transfer would otherwise be eaten by ':sessionId' ———

  @RequirePermission("opd.queue.read", "hospital")
  @Get("queues/summary")
  async summary(@Query() query: unknown): Promise<{ items: DoctorSummary[] }> {
    const q = parsed(summaryQuery, query);
    try {
      return { items: await summaryByDoctor(this.db, q.departmentId, q.serviceDate ?? istDate(new Date())) };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.display.read", "hospital")
  @Get("queues/board")
  async board(@Query() query: unknown): Promise<{ items: BoardItem[] }> {
    const q = parsed(boardQuery, query);
    const roomIds = q.roomIds === undefined ? undefined : q.roomIds.split(",").filter((s) => s !== "");
    try {
      return { items: await boardSnapshot(this.db, q.serviceDate ?? istDate(new Date()), roomIds) };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.queue.transfer", "hospital")
  @Post("queues/transfer")
  async transfer(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ transferred: number; toSessionId: string }> {
    const b = parsed(transferBody, body);
    try {
      return await transferQueue(this.db, actor, b);
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— the doctor-day queue ———

  @RequirePermission("opd.queue.read", "hospital")
  @Get("queues")
  async queue(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<QueueView | { session: null }> {
    const q = parsed(queueQuery, query);
    try {
      return (await listQueue(this.db, actor, q.doctorId, q.serviceDate ?? istDate(new Date()))) ?? { session: null };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.queue.operate", "hospital")
  @Post("queues/:sessionId/call-next")
  async callNext(
    @CurrentActor() actor: Actor, @Param("sessionId") sessionId: string,
  ): Promise<{ entry: QueueEntryRow | null; encounter: EncounterRow | null }> {
    try {
      return await callNext(this.db, actor, sessionId);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.queue.operate", "hospital")
  @Post("queues/:sessionId/status")
  async sessionStatus(
    @CurrentActor() actor: Actor, @Param("sessionId") sessionId: string, @Body() body: unknown,
  ): Promise<{ session: SessionRow }> {
    const b = parsed(sessionStatusBody, body);
    try {
      return { session: await withTx(this.db, (tx) => setSessionStatus(tx, actor, sessionId, b.status)) };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.queue.operate", "hospital")
  @Post("queues/entries/:entryId/skip")
  async skip(@CurrentActor() actor: Actor, @Param("entryId") entryId: string): Promise<{ entry: QueueEntryRow }> {
    try {
      return await skipCalled(this.db, actor, entryId);
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— the consultation ———

  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/consult/start")
  async start(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ encounter: EncounterRow; queueEntry: QueueEntryRow }> {
    try {
      return await startConsultation(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Put("visits/:id/consult/note")
  async note(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ encounter: EncounterRow }> {
    const b = parsed(consultNoteBody, body);
    try {
      return await saveConsultNote(this.db, actor, id, b);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/consult/complete")
  async complete(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ encounter: EncounterRow }> {
    const b = parsed(consultCompleteBody, body);
    try {
      return await completeConsultation(this.db, actor, id, b);
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— the e-Rx ———

  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/prescriptions")
  async prescribe(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<IssuedPrescription> {
    const b = parsed(prescriptionBody, body);
    try {
      return await issuePrescription(this.db, actor, this.cfg, id, b);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.visits.read", "hospital")
  @Get("visits/:id/prescriptions")
  async prescriptions(@Param("id") id: string): Promise<{ items: PrescriptionRow[] }> {
    return { items: await listPrescriptions(this.db, id) };
  }

  @RequirePermission("opd.prescriptions.verify", "hospital")
  @Post("prescriptions/verify")
  @HttpCode(200) // a failed scan is a domain answer (ok:false), never a transport error — the qr/verify precedent
  async verify(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<RxVerifyResult> {
    const b = parsed(verifyBody, body);
    try {
      return await verifyPrescriptionQr(this.db, this.cfg, actor, b.payload);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.visits.read", "hospital")
  @Get("prescriptions/:id/print")
  async print(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<RxPrintData> {
    try {
      return await getPrescriptionPrint(this.db, this.cfg, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }
}
