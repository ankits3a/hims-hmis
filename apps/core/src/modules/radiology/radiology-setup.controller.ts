import { Body, Controller, Get, Inject, Param, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { istDayString } from "../../kernel/approvals/cumulative";
import { imagingDevices } from "./devices";
import {
  RADIOLOGY_DEVICES_MANAGE, SETTABLE_DEVICE_STATUSES, createImagingDevice, editImagingDevice,
  setImagingDeviceStatus,
} from "./machines";
import { setupBooks, setupPrices, setupRooms } from "./setup";
import { IMAGING_MODALITIES } from "./kinds";
import { idSchema, parsed, toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS4 — **THE SETUP STATION'S HTTP SURFACE.** Every route is `radiology.devices.manage`.
 *
 *   GET   /radiology/setup/devices              the whole register (retired included) + rooms
 *   POST  /radiology/setup/devices              register a machine
 *   PATCH /radiology/setup/devices/:id          edit its description (never its modality)
 *   POST  /radiology/setup/devices/:id/status   set a status with a reason → the studies to move
 *   GET   /radiology/setup/books                the governed books, versions and approvers
 *   GET   /radiology/setup/prices               RAD- services, GST category, active and ruled price
 *
 * The books are CHANGED through the existing `/radiology/definitions/draft` and `/publish` routes
 * and approved in the kernel approvals inbox; this surface adds no second approval system.
 */

/** Wire shapes. Field rules live in `machines.ts` so an in-process caller meets the same refusals. */
const createBody = z.object({
  code: z.string().max(64),
  name: z.string().max(200),
  modality: z.enum(IMAGING_MODALITIES),
  roomId: idSchema.nullable().optional(),
  aeTitle: z.string().max(64).nullable().optional(),
  portable: z.boolean().optional(),
}).strict();

const editBody = z.object({
  code: z.string().max(64).optional(),
  name: z.string().max(200).optional(),
  modality: z.string().max(32).optional(),
  roomId: idSchema.nullable().optional(),
  aeTitle: z.string().max(64).nullable().optional(),
  portable: z.boolean().optional(),
}).strict();

const statusBody = z.object({
  status: z.enum(SETTABLE_DEVICE_STATUSES),
  /** Required and non-blank — `setImagingDeviceStatus` refuses a blank one with `reason_required`. */
  reason: z.string().max(1000),
}).strict();

@Controller("radiology/setup")
export class RadiologySetupController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("devices")
  @RequirePermission(RADIOLOGY_DEVICES_MANAGE, "hospital")
  async devices(): Promise<unknown> {
    try {
      const [devices, rooms] = await Promise.all([
        imagingDevices(this.db, istDayString(new Date()), { includeRetired: true }),
        setupRooms(this.db),
      ]);
      return { devices, rooms };
    } catch (e) { toHttp(e); }
  }

  @Post("devices")
  @RequirePermission(RADIOLOGY_DEVICES_MANAGE, "hospital")
  async create(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(createBody, body);
    try {
      return await withTx(this.db, (tx) => createImagingDevice(tx, actor, input));
    } catch (e) { toHttp(e); }
  }

  @Patch("devices/:id")
  @RequirePermission(RADIOLOGY_DEVICES_MANAGE, "hospital")
  async edit(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    const deviceId = parsed(idSchema, id);
    const patch = parsed(editBody, body);
    try {
      await withTx(this.db, (tx) => editImagingDevice(tx, actor, deviceId, patch));
      return { deviceResourceId: deviceId };
    } catch (e) { toHttp(e); }
  }

  @Post("devices/:id/status")
  @RequirePermission(RADIOLOGY_DEVICES_MANAGE, "hospital")
  async status(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    const deviceId = parsed(idSchema, id);
    const input = parsed(statusBody, body);
    try {
      return await withTx(this.db, (tx) => setImagingDeviceStatus(tx, actor, deviceId, input));
    } catch (e) { toHttp(e); }
  }

  @Get("books")
  @RequirePermission(RADIOLOGY_DEVICES_MANAGE, "hospital")
  async books(): Promise<unknown> {
    try {
      return { books: await setupBooks(this.db) };
    } catch (e) { toHttp(e); }
  }

  @Get("prices")
  @RequirePermission(RADIOLOGY_DEVICES_MANAGE, "hospital")
  async prices(): Promise<unknown> {
    try {
      return { services: await setupPrices(this.db) };
    } catch (e) { toHttp(e); }
  }
}
