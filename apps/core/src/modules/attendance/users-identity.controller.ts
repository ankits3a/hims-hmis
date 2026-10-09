import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { CONFIG, DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { users } from "../../kernel/db/schema";
import { maskedAadhaar } from "./aadhaar";
import { aadhaarChange, lockIdentity, mobileChange, writeIdentity } from "./identity-write";
import { linkStates } from "./linking";
import { aadhaarKeyOf } from "./secrets";
import type { Actor } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import type { LinkState } from "./linking";

/** The Users screen's own permission, unchanged: whoever may add and edit users (`kernel/auth/users-admin.controller.ts`). */
const USERS_MANAGE = "auth.users.manage";

// `null` removes, a string sets, an absent key leaves alone. Bounded strings, and NO zod issue is
// ever sent back from this body: an issue can quote the value it refused.
const identityBody = z.object({
  mobile: z.string().max(40).nullable().optional(),
  aadhaar: z.string().max(40).nullable().optional(),
}).strict();

export type UserIdentityView = {
  userId: string;
  mobile: string | null;
  /** `XXXX XXXX 0124` once set — the last four digits are all that is kept of the number. */
  aadhaar: string | null;
  attendance: LinkState;
};

/**
 * ═══ MOBILE AND AADHAAR ON THE USERS SCREEN (owner 2026-10-09) ═══
 *
 * "Match by mobile or Aadhaar only. add a field to add mobile and aadhar in the user screen in admin
 * dashboard or whoever have acces to add/delete/edit user." These two routes are that, under the
 * Users screen's own path and its own permission; they live in this module because what the two
 * fields are FOR is linking a login to the attendance machine's list.
 *
 * THE AADHAAR NUMBER IS NEVER STORED. It arrives in one request body, is validated (twelve digits,
 * first 2–9, Verhoeff), is turned into bioattend's keyed hash with the linking key, and is dropped.
 * What is kept is the hash and the last four digits. The event says WHO and "set" or "removed" —
 * no digit, no hash. A refusal names the rule that failed, never the number.
 *
 * With no linking key on this host the Aadhaar cannot be hashed, so it cannot be accepted:
 * `aadhaar_key_not_configured`, and the screen disables the field and says so.
 */
@Controller("admin/users")
export class UsersIdentityController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  @RequirePermission(USERS_MANAGE, "hospital")
  @Get("identity")
  async list(): Promise<{ aadhaarConfigured: boolean; users: UserIdentityView[] }> {
    const rows = await this.db.select({ id: users.id, phone: users.phone, last4: users.aadhaarLast4 }).from(users).orderBy(users.username);
    const states = await linkStates(this.db);
    return {
      aadhaarConfigured: aadhaarKeyOf(this.cfg.attendance) !== null,
      users: rows.map((r) => ({ userId: r.id, mobile: r.phone, aadhaar: r.last4 === null ? null : maskedAadhaar(r.last4), attendance: states.get(r.id) ?? "not_linked" })),
    };
  }

  @RequirePermission(USERS_MANAGE, "hospital")
  @Post(":id/identity")
  @HttpCode(200)
  async set(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<UserIdentityView> {
    const parsed = identityBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: "bad_body" });
    const { mobile, aadhaar } = parsed.data;
    const now = new Date();
    const phone = mobile === undefined ? undefined : mobileChange(mobile);
    const hash = aadhaar === undefined ? undefined : aadhaarChange(aadhaar, this.cfg.attendance, now.getTime());
    return withTx(this.db, async (tx) => writeIdentity(tx, actor, now, await lockIdentity(tx, id), { phone, aadhaar: hash }));
  }
}
