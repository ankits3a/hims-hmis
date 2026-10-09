import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, HttpException, Inject, Post } from "@nestjs/common";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { CONFIG, DB } from "../../kernel/tokens";
import { CurrentActor } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { events, roleAssignments, users } from "../../kernel/db/schema";
import { maskedAadhaar } from "./aadhaar";
import { userIdentityChanged } from "./events";
import { aadhaarChange, lockIdentity, writeIdentity } from "./identity-write";
import { linkStates, pinOfUser } from "./linking";
import { aadhaarKeyOf } from "./secrets";
import type { Actor } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db, Tx } from "../../kernel/db/client";
import type { LinkState } from "./linking";

/**
 * The roles that make a login a MACHINE (`scripts/seed-roles.ts`: "a MACHINE account … holds nothing
 * else"). A bridge has no Aadhaar and no attendance; it is never asked for one.
 */
export const MACHINE_ROLES = ["modality_bridge", "lab_bridge"] as const;

/**
 * A person may save their own Aadhaar this many times in a day. DECIDED: the auth throttle
 * (`kernel/auth/throttle.ts`) is keyed to credential kinds and is everyone's file; a count of this
 * route's own events is enough here, because an attempt that the server refuses changes nothing and
 * the number itself cannot be guessed in five tries.
 */
export const SELF_SAVES_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

// The number only, and NO zod issue is ever sent back: an issue can quote the value it refused.
const selfBody = z.object({ aadhaar: z.string().trim().min(1).max(40) }).strict();

export type SelfIdentityView = {
  /** The server holds the linking key; without it an Aadhaar cannot be taken at all. */
  aadhaarConfigured: boolean;
  /** `XXXX XXXX 0124`, or null. */
  aadhaar: string | null;
  attendance: LinkState;
  /** Draw the "Add your Aadhaar" sticker: key there, none saved yet, a person (not a machine), not yet linked. */
  needsAadhaar: boolean;
};

/**
 * ═══ "ADD YOUR AADHAAR" — THE SIGNED-IN PERSON'S OWN RECORD (owner 2026-10-09) ═══
 *
 * "When the user logs in, a sticker on top of the window/screen will be there till the Aadhar number
 * is input and saved by the user. If it matches with the data from attendance API then good. Our
 * system will automatically maps the user/staff."
 *
 * There is NO id in either path: the record is the caller's, always. No permission is needed for the
 * same reason `/attendance/me` needs none — a person may tell the hospital their own number.
 *
 * The write is the admin route's (`identity-write.ts`): the same validation, the same keyed hash, the
 * same event (actor = the person themself) and the same in-transaction link attempt. Two logins that
 * give one number link neither — `decideLinks`' `aadhaar_shared` rule, unchanged.
 *
 * ONCE LINKED THE NUMBER IS LOCKED (`aadhaar_locked`): a wrong link is the administrator's to mend on
 * the Users screen, never the person's to re-point. And a person already linked (by mobile, say) is
 * not asked: `needsAadhaar` is false, so the sticker never asks for something the server would refuse.
 */
@Controller("me")
export class MeIdentityController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Get("identity")
  async get(@CurrentActor() actor: Actor): Promise<SelfIdentityView> {
    const configured = aadhaarKeyOf(this.cfg.attendance) !== null;
    if (actor.type !== "user") return { aadhaarConfigured: configured, aadhaar: null, attendance: "not_linked", needsAadhaar: false };
    return this.view(this.db, actor.id, configured);
  }

  @Post("identity")
  @HttpCode(200)
  async set(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<SelfIdentityView> {
    const parsed = selfBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: "bad_body" });
    if (actor.type !== "user" || (await isMachine(this.db, actor.id))) throw new ForbiddenException({ code: "not_a_person" });
    const now = new Date();
    const hash = aadhaarChange(parsed.data.aadhaar, this.cfg.attendance, now.getTime());
    return withTx(this.db, async (tx) => {
      const user = await lockIdentity(tx, actor.id);
      if ((await pinOfUser(tx, actor.id)) !== null) throw new ConflictException({ code: "aadhaar_locked" });
      if ((await selfSavesSince(tx, actor.id, new Date(now.getTime() - DAY_MS))) >= SELF_SAVES_PER_DAY) {
        throw new HttpException({ code: "too_many_attempts" }, 429);
      }
      await writeIdentity(tx, actor, now, user, { aadhaar: hash });
      return this.view(tx, actor.id, true);
    });
  }

  private async view(exec: Db | Tx, userId: string, configured: boolean): Promise<SelfIdentityView> {
    const row = (await exec.select({ last4: users.aadhaarLast4 }).from(users).where(eq(users.id, userId)))[0];
    const attendance = (await linkStates(exec)).get(userId) ?? "not_linked";
    const last4 = row?.last4 ?? null;
    const needsAadhaar = configured && row !== undefined && last4 === null && attendance !== "linked" && !(await isMachine(exec, userId));
    return { aadhaarConfigured: configured, aadhaar: last4 === null ? null : maskedAadhaar(last4), attendance, needsAadhaar };
  }
}

async function isMachine(exec: Db | Tx, userId: string): Promise<boolean> {
  const rows = await exec.select({ k: roleAssignments.roleKey }).from(roleAssignments)
    .where(and(eq(roleAssignments.userId, userId), inArray(roleAssignments.roleKey, [...MACHINE_ROLES]))).limit(1);
  return rows.length > 0;
}

/** How many times this person changed their OWN Aadhaar since `since` — read off the events they wrote. */
async function selfSavesSince(tx: Tx, userId: string, since: Date): Promise<number> {
  const rows = await tx.select({ n: sql<number>`count(*)::int` }).from(events).where(and(
    eq(events.name, userIdentityChanged.name), eq(events.actorType, "user"), eq(events.actorId, userId),
    gt(events.occurredAt, since), sql`${events.payload}->>'userId' = ${userId}`, sql`${events.payload}->>'field' = 'aadhaar'`,
  ));
  return rows[0]?.n ?? 0;
}
