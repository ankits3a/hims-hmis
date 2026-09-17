import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CONFIG, DB, DOCUMENT_STORE } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { istDateOf } from "./config";
import { idSchema, parsed, toHttp } from "./pharmacy-http";
import {
  counterBatches, enterPaperDispense, getRetailSale, inspectSheet, listPaperDispenses, listRetailLicences, listRetailSales,
  pharmacyStaff, previewPaperDispense, previewRetailSale, recordRetailLicence, retailLicenceState, searchCounterShelf,
  searchRetailShelf, sellRetail,
} from "./retail";
import type { Actor } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";
import type {
  CounterBatch, PharmacyStaffMember, RetailLicenceState, RetailLicenceView, RetailPreview, RetailSaleRow, RetailSaleView,
  RetailShelfEntry, SheetCheck,
} from "./retail";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const lineSchema = z.object({
  medicineId: idSchema,
  qtyBase: z.number().int().positive().max(100_000),
  batchId: idSchema.optional(),
  scan: z.string().min(1).max(200).optional(),
});
const previewBody = z.object({ patientId: idSchema.optional(), lines: z.array(lineSchema).min(1).max(50) });
const saleBody = z.object({
  customer: z.union([
    z.object({ existingId: idSchema }),
    z.object({
      register: z.object({
        name: z.string().trim().min(1).max(120),
        sex: z.enum(["male", "female", "other", "unknown"]),
        ageYears: z.number().int().min(0).max(130).optional(),
        phone: z.string().regex(/^[6-9]\d{9}$/, "10-digit Indian mobile").optional(),
        addressLine: z.string().max(300).optional(),
      }),
      acknowledgedDuplicates: z.boolean().optional(),
    }),
  ]),
  lines: z.array(lineSchema).min(1).max(50),
  prescription: z.object({
    prescriberName: z.string().max(120),
    prescriberRegNo: z.string().max(60),
    prescriberAddress: z.string().max(300),
    rxDate: z.string().max(10),
    photo: z.object({ mimeType: z.enum(["image/jpeg", "image/png", "application/pdf"]), imageBase64: z.string().min(1) }),
  }).optional(),
  tenders: z.array(z.object({
    mode: z.enum(["cash", "upi", "card"]),
    amountPaise: z.number().int().nonnegative(),
    refText: z.string().max(120).optional(),
  })).min(1).max(5),
  panNumber: z.string().max(10).optional(),
  form60: z.boolean().optional(),
  changeGivenPaise: z.number().int().nonnegative().optional(),
});
const storeCode = z.enum(["PHARM-OPD", "PHARM-RETAIL"]);
const instant = z.string().datetime({ offset: true });
const paperPreviewBody = previewBody.extend({ storeCode, occurredAt: instant });
const paperBody = saleBody.extend({
  sheetQr: z.string().min(1).max(300),
  storeCode,
  occurredAt: instant,
  dispensedBy: idSchema,
  lines: z.array(lineSchema.extend({ batchId: idSchema })).min(1).max(50),
});
const licenceBody = z.object({
  form20No: z.string().max(60),
  form21No: z.string().max(60),
  validFrom: isoDate,
  validTo: isoDate,
  pharmacistInCharge: z.string().max(120),
  note: z.string().max(500).optional(),
});

/**
 * PHARMACY P19 — the walk-in retail counter. Selling is `pharmacy.retail.sell`; recording the
 * licence is `pharmacy.retail.manage`. The second permissions a sale may need (`patients.register`
 * for a new customer, `pharmacy.dispense.scheduled` for a Schedule H line) are asserted inside
 * `sellRetail`, because a second decorator would overwrite the first.
 */
@Controller("pharmacy/retail")
export class PharmacyRetailController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DOCUMENT_STORE) private readonly documents: DocumentStore,
  ) {}

  /** Whether the counter may sell today, for its banner. */
  @RequirePermission("pharmacy.retail.sell", "hospital")
  @Get("state")
  async state(): Promise<RetailLicenceState> {
    return retailLicenceState(this.db, new Date());
  }

  @RequirePermission("pharmacy.retail.sell", "hospital")
  @Get("shelf")
  async shelf(@CurrentActor() actor: Actor, @Query("q") q?: string): Promise<{ items: RetailShelfEntry[] }> {
    try {
      return { items: await searchRetailShelf(this.db, actor, (q ?? "").slice(0, 200), new Date()) };
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.retail.sell", "hospital")
  @Post("preview")
  async preview(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<RetailPreview> {
    const input = parsed(previewBody, body);
    try {
      return await previewRetailSale(this.db, actor, input, new Date());
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.retail.sell", "hospital")
  @Post("sales")
  async sell(@CurrentActor() actor: Actor, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<RetailSaleView> {
    const input = parsed(saleBody, body);
    const { prescription, ...rest } = input;
    try {
      return await sellRetail(this.db, this.documents, actor, {
        ...rest,
        ...(prescription === undefined ? {} : {
          prescription: {
            prescriberName: prescription.prescriberName, prescriberRegNo: prescription.prescriberRegNo,
            prescriberAddress: prescription.prescriberAddress, rxDate: prescription.rxDate,
            photo: { mimeType: prescription.photo.mimeType, bytes: Buffer.from(prescription.photo.imageBase64, "base64") },
          },
        }),
      }, key, new Date());
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.retail.sell", "hospital")
  @Get("sales")
  async list(@CurrentActor() actor: Actor, @Query("day") day?: string): Promise<{ items: RetailSaleRow[] }> {
    try {
      return { items: await listRetailSales(this.db, actor, day ?? istDateOf(new Date())) };
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.retail.sell", "hospital")
  @Get("sales/:id")
  async get(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<RetailSaleView> {
    try {
      return await getRetailSale(this.db, actor, parsed(idSchema, id));
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.retail.manage", "hospital")
  @Get("licences")
  async licences(@CurrentActor() actor: Actor): Promise<{ items: RetailLicenceView[]; state: RetailLicenceState }> {
    try {
      return { items: await listRetailLicences(this.db, actor), state: await retailLicenceState(this.db, new Date()) };
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.retail.manage", "hospital")
  @Post("licences")
  async record(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<RetailLicenceView> {
    const input = parsed(licenceBody, body);
    try {
      return await recordRetailLicence(this.db, actor, input, new Date());
    } catch (e) {
      return toHttp(e);
    }
  }
}

/**
 * PHARMACY P20 — paper dispenses entered after an outage. Every route is `pharmacy.downtime.enter`;
 * the sheet's signature is checked with the kernel's secret key, the one that printed it.
 */
@Controller("pharmacy/downtime")
export class PharmacyDowntimeController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DOCUMENT_STORE) private readonly documents: DocumentStore,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** What a scanned sheet is, and whether it was already entered. */
  @RequirePermission("pharmacy.downtime.enter", "hospital")
  @Get("sheet")
  async sheet(@CurrentActor() actor: Actor, @Query("qr") qr?: string): Promise<SheetCheck> {
    try {
      return await inspectSheet(this.db, actor, this.cfg.secretKey, (qr ?? "").slice(0, 300));
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.downtime.enter", "hospital")
  @Get("staff")
  async staff(@CurrentActor() actor: Actor): Promise<{ items: PharmacyStaffMember[] }> {
    try {
      return { items: await pharmacyStaff(this.db, actor, new Date()) };
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.downtime.enter", "hospital")
  @Get("shelf")
  async counterShelf(@CurrentActor() actor: Actor, @Query("store") store?: string, @Query("q") q?: string): Promise<{ items: RetailShelfEntry[] }> {
    const code = parsed(storeCode, store);
    try {
      return { items: await searchCounterShelf(this.db, actor, code, (q ?? "").slice(0, 200), new Date()) };
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.downtime.enter", "hospital")
  @Get("batches")
  async batches(@CurrentActor() actor: Actor, @Query("store") store?: string, @Query("itemId") itemId?: string): Promise<{ items: CounterBatch[] }> {
    const code = parsed(storeCode, store);
    const item = parsed(idSchema, itemId);
    try {
      return { items: await counterBatches(this.db, actor, code, item) };
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.downtime.enter", "hospital")
  @Post("preview")
  async paperPreview(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<RetailPreview> {
    const input = parsed(paperPreviewBody, body);
    try {
      return await previewPaperDispense(this.db, actor, { ...input, occurredAt: new Date(input.occurredAt) }, new Date());
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.downtime.enter", "hospital")
  @Post("dispenses")
  async enterPaper(@CurrentActor() actor: Actor, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<RetailSaleView> {
    const input = parsed(paperBody, body);
    const { prescription, occurredAt, ...rest } = input;
    try {
      return await enterPaperDispense(this.db, this.documents, this.cfg.secretKey, actor, {
        ...rest,
        occurredAt: new Date(occurredAt),
        ...(prescription === undefined ? {} : {
          prescription: {
            prescriberName: prescription.prescriberName, prescriberRegNo: prescription.prescriberRegNo,
            prescriberAddress: prescription.prescriberAddress, rxDate: prescription.rxDate,
            photo: { mimeType: prescription.photo.mimeType, bytes: Buffer.from(prescription.photo.imageBase64, "base64") },
          },
        }),
      }, key, new Date());
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.downtime.enter", "hospital")
  @Get("dispenses")
  async paperList(@CurrentActor() actor: Actor): Promise<{ items: RetailSaleRow[] }> {
    try {
      return { items: await listPaperDispenses(this.db, actor) };
    } catch (e) {
      return toHttp(e);
    }
  }
}
