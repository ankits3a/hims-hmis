import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { LinkError, candidatesFor, linkByHand, unlinkByHand, linkCounts, searchMachine, suggestions, unlinkedPeople } from "./links";
import { ATTENDANCE_ALL_READ } from "./manifest";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { LinkCounts, LoginRow, MachinePersonRow, Match, Suggestion, UnlinkedRow } from "./links";

/** The Users screen's own permission (`users-identity.controller.ts`): whoever may add and edit users links them. */
const USERS_MANAGE = "auth.users.manage";

const searchQuery = z.object({ q: z.string().max(80).optional() });
const unlinkedQuery = z.object({ q: z.string().max(80).optional(), offset: z.coerce.number().int().min(0).max(100_000).optional() });
const linkBody = z.object({ pin: z.string().min(1).max(40), userId: z.string().min(1).max(40) }).strict();
const unlinkBody = z.object({ reason: z.string().trim().min(1).max(200) }).strict();
/** Six digits in a row (spaces and dashes between them allowed) could be part of a mobile or an Aadhaar: refused, never stored. */
const LONG_NUMBER = /\d(?:[\s-]?\d){5,}/;

function q<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new BadRequestException({ code: "bad_query" });
  return r.data;
}
function linkHttp(e: unknown): never {
  if (!(e instanceof LinkError)) {
    // Two administrators linking one login to two people at once: the unique index answers.
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") throw new ConflictException({ code: "login_linked" });
    throw e;
  }
  if (e.code === "unknown_person" || e.code === "user_not_found") throw new NotFoundException({ code: e.code });
  throw new ConflictException({ code: e.code });
}

/**
 * ═══ THE LINK COUNT AND THE UNLINKED LIST — FOR THOSE WHO WATCH ADOPTION (#634) ═══
 *
 * The owner and the Attendance Committee (`attendance.all.read`): how many of the machine's people
 * are linked to a login, and who is not yet, with the reason. Names, departments and posts — the
 * machine's own list, which this audience already reads in full — and no mobile, no hash.
 */
@Controller("attendance/links")
export class AttendanceLinksController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission(ATTENDANCE_ALL_READ, "hospital")
  @Get()
  async list(@Query() query: unknown): Promise<{ counts: LinkCounts; total: number; offset: number; people: UnlinkedRow[] }> {
    const { q: text, offset } = q(unlinkedQuery, query);
    const out = await unlinkedPeople(this.db, { q: text, offset });
    return { counts: await linkCounts(this.db), total: out.total, offset: offset ?? 0, people: out.people };
  }
}

/**
 * ═══ LINKING BY HAND — THE USERS SCREEN'S ADMINISTRATOR (#634) ═══
 *
 * Search the machine's list, see which logins match a person by mobile or Aadhaar, confirm the
 * link; or take a suggestion (an exact mobile match) with one click. Every link still needs a
 * MATCH (`links.ts` `linkByHand`); the administrator supplies a missing mobile or Aadhaar through
 * the Users screen's own route first (`POST /admin/users/:id/identity`).
 */
@Controller("admin/users/attendance-links")
export class AdminAttendanceLinksController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission(USERS_MANAGE, "hospital")
  @Get()
  async search(@Query() query: unknown): Promise<{ counts: LinkCounts; people: MachinePersonRow[] }> {
    const { q: text } = q(searchQuery, query);
    return { counts: await linkCounts(this.db), people: await searchMachine(this.db, text ?? "") };
  }

  @RequirePermission(USERS_MANAGE, "hospital")
  @Get("suggestions")
  async suggestions(): Promise<{ suggestions: Suggestion[] }> {
    return { suggestions: await suggestions(this.db) };
  }

  @RequirePermission(USERS_MANAGE, "hospital")
  @Get(":pin/candidates")
  async candidates(@Param("pin") pin: string, @Query() query: unknown): Promise<{ person: MachinePersonRow; matches: LoginRow[]; found: LoginRow[] }> {
    const { q: text } = q(searchQuery, query);
    try { return await candidatesFor(this.db, pin, text ?? ""); } catch (e) { return linkHttp(e); }
  }

  @RequirePermission(USERS_MANAGE, "hospital")
  @Post()
  @HttpCode(200)
  async link(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ pin: string; userId: string; source: Match; counts: LinkCounts }> {
    const parsed = linkBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: "bad_body" });
    const now = new Date();
    try {
      const done = await withTx(this.db, (tx) => linkByHand(tx, actor, now, parsed.data.pin, parsed.data.userId));
      return { ...done, counts: await linkCounts(this.db) };
    } catch (e) { return linkHttp(e); }
  }

  /** Undo a link, with a short reason. POST rather than DELETE so the reason travels in a body every proxy keeps. */
  @RequirePermission(USERS_MANAGE, "hospital")
  @Post(":pin/unlink")
  @HttpCode(200)
  async unlink(@CurrentActor() actor: Actor, @Param("pin") pin: string, @Body() body: unknown): Promise<{ pin: string; userId: string; relinksOnSync: boolean; counts: LinkCounts }> {
    const parsed = unlinkBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: "bad_body" });
    if (LONG_NUMBER.test(parsed.data.reason)) throw new BadRequestException({ code: "reason_has_number" });
    const now = new Date();
    try {
      const done = await withTx(this.db, (tx) => unlinkByHand(tx, actor, now, pin, parsed.data.reason));
      return { ...done, counts: await linkCounts(this.db) };
    } catch (e) { return linkHttp(e); }
  }
}
