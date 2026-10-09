import {
  BadRequestException, Controller, Headers, HttpCode, Inject, Post, Req, ServiceUnavailableException, UnauthorizedException,
} from "@nestjs/common";
import { CONFIG, DB } from "../../kernel/tokens";
import { Public } from "../../kernel/auth/decorators";
import { webhookSecretOf } from "./secrets";
import { storePunches } from "./sync";
import { verifyBioattendWebhook, webhookBody } from "./webhook";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";

/**
 * `POST /webhooks/bioattend` (`/api/webhooks/bioattend` at the edge) — bioattend posts each new punch
 * about two seconds after a device records it.
 *
 * PUBLIC TO USER AUTH (bioattend holds no HMIS session) and authenticated by the SIGNATURE instead,
 * over the raw bytes `app.bootstrap.ts` kept for this one path. Nothing of the body is used before
 * the signature and the timestamp hold. Then: insert-or-ignore on the punch id — bioattend delivers
 * at least once and the two-minute pull can deliver the same punch — and 204 at once.
 *
 *   signing secret not on this host      503   (bioattend retries; nothing is lost — the pull has it)
 *   bad signature, stale or no timestamp 401   with no detail of which
 *   signed, but not the guide's shape    400   (their side shows the batch failing: the contract moved)
 *
 * It never moves the pull's cursor: delivery "starts at the newest punch when the webhook is
 * switched on", so the history before it is the pull's to fetch.
 */
@Controller("webhooks")
export class BioattendWebhookController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Public()
  @Post("bioattend")
  @HttpCode(204)
  async receive(
    @Req() req: { rawBody?: unknown },
    @Headers("x-bioattend-timestamp") timestamp: string | undefined,
    @Headers("x-bioattend-signature") signature: string | undefined,
  ): Promise<void> {
    const now = new Date();
    const secret = webhookSecretOf(this.cfg.attendance, now.getTime());
    if (secret === null) throw new ServiceUnavailableException();
    const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
    if (raw === null) throw new UnauthorizedException();
    if (verifyBioattendWebhook({ secret, timestamp, signature, raw, nowMs: now.getTime() }) !== "ok") throw new UnauthorizedException();

    let json: unknown;
    try { json = JSON.parse(raw.toString("utf8")); } catch { throw new BadRequestException(); }
    const body = webhookBody.safeParse(json);
    if (!body.success) throw new BadRequestException();
    if (body.data.event !== "punches" || body.data.punches === undefined) return;
    await storePunches(this.db, body.data.punches, "webhook", now);
  }
}
