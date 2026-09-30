import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { events, membershipInstances } from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { IST_OFFSET_MS, istDayIndex } from "./coupon-rules";
import { entitlementCountersOf, counterLiveAt } from "./entitlements";
import { instrumentRecognised } from "./events";
import { recogniseForActor } from "./recognition";
import type { PatientSummary } from "../patients";
import type { RecognisedMembership, RecognitionResult } from "./recognition";
import type { Db } from "../../kernel/db/client";

/**
 * UX-AUDIT 2026-09-28 · BOARD — THE CARD-RECOGNITION COUNTER'S OWN VIEW (`/counter/instruments`).
 *
 * The owner-approved board (docs/design/2026-09-28-ux-audit/card-recognition) lists what the screen
 * needs that recognition did not send. This file adds exactly those, ON TOP of `recogniseForActor`
 * rather than inside it: the pharmacy rail calls that function too, and it wants none of this.
 *
 *   1. THE HOLDER — name, UHID, age and sex of the patient the card is linked to, read through the
 *      patients module's own `getPatientSummaries`. A sealed holder comes back `restricted` with the
 *      alias the seal allows; nothing here reads `is_confidential` or decides it a second time.
 *   2. BENEFITS LEFT, AS COUNTS. A counter whose unit is `count` says "3 of 4". A counter whose unit
 *      is `paise` says only that the balance is worked out ON THE BILL — OWNER RULING 28-Sep-2026
 *      (money): a card's rupee balance is never shown at the counter. The figure is not withheld by
 *      the screen; it is never put on the wire (E-32), which is the only way a screen cannot show it.
 *   3. THE ONE NEXT ACT, decided here so every client says the same thing. OWNER RULING 28-Sep-2026:
 *      an EXPIRED card is never honoured — its only act is "bill at full rate", and suspended and
 *      cancelled read the same way. A usable card the book has not linked to anybody goes to
 *      Reconcile and is never applied (on the money path a presented code is a coupon only —
 *      `codesAreCouponsOnly` — so an unlinked card cannot reach a bill anyway).
 *   4. "CARDS TODAY" — this counter's own day of recognitions, from `instrument.recognised`.
 */

/** How the card reads today. `usable` is `membershipUsableAt`'s answer; the rest say why not. */
export type CounterStanding = "usable" | "not_yet_valid" | "expired" | "suspended" | "cancelled";

/** The ONE act the counter offers. There is no "apply" act: a linked usable card is applied by the bill. */
export type CounterNextAct = "take_to_bill" | "bill_full_rate" | "reconcile";

/**
 * What is left of one benefit. `visits` is a count; `on_the_bill` is a money balance whose figure
 * this wire never carries (owner ruling 28-Sep-2026); `every_visit` is a benefit with no counter.
 */
export type CounterAllowance =
  | { kind: "visits"; granted: number; remaining: number }
  | { kind: "on_the_bill" }
  | { kind: "every_visit" };

export type CounterHolder = {
  patientId: string;
  uhid: string;
  /** Null when the holder is sealed from this reader — `alias` is what the seal allows instead. */
  name: string | null;
  alias: string | null;
  restricted: boolean;
  ageYears: number | null;
  /** Administrative gender, as every display surface reads it (`PatientSummary`). */
  sex: string;
};

export type CounterMembership = RecognisedMembership & {
  standing: CounterStanding;
  /** The book has linked this card to a patient. An unlinked card is never applied. */
  linked: boolean;
  holder: CounterHolder | null;
  allowances: { benefitKey: string; title: string; allowance: CounterAllowance }[];
  nextAct: CounterNextAct;
};

export type CounterRecognition = Omit<RecognitionResult, "memberships"> & { memberships: CounterMembership[] };

const DAY_MS = 86_400_000;
const YEAR_MS = 365.2425 * DAY_MS;

export function standingOf(m: Pick<RecognisedMembership, "status" | "usable" | "validFrom">, at: Date): CounterStanding {
  if (m.status !== "active") return m.status;
  if (m.usable) return "usable";
  // Active and not usable can only be a date: before its first IST day, or after its last.
  return istDayIndex(at) < istDayIndex(m.validFrom) ? "not_yet_valid" : "expired";
}

export function nextActOf(standing: CounterStanding, linked: boolean): CounterNextAct {
  if (standing !== "usable") return "bill_full_rate";
  return linked ? "take_to_bill" : "reconcile";
}

function holderOf(s: PatientSummary, at: Date): CounterHolder {
  return {
    patientId: s.id,
    uhid: s.uhid,
    name: s.name,
    alias: s.alias,
    restricted: s.restricted,
    // A sealed holder's age is part of what the seal covers, with the name.
    ageYears: s.restricted || s.dob === null ? null : Math.max(0, Math.floor((at.getTime() - s.dob.getTime()) / YEAR_MS)),
    sex: s.administrativeGender,
  };
}

/**
 * Recognition, as the counter screen reads it. Same gate, same instruments, same disclosure as
 * `recogniseForActor` — this only adds the four things above.
 */
export async function recogniseAtCounter(
  db: Db,
  actor: Actor,
  input: { patientId?: string | null; presentedCodes?: string[]; at: Date },
): Promise<CounterRecognition> {
  const base = await recogniseForActor(db, actor, input);
  const ids = base.memberships.map((m) => m.instanceId);
  const owners = ids.length === 0
    ? []
    : await db
      .select({ id: membershipInstances.id, patientId: membershipInstances.patientId })
      .from(membershipInstances)
      .where(inArray(membershipInstances.id, ids));
  const ownerOf = new Map(owners.map((o) => [o.id, o.patientId] as const));
  const patientIds = [...new Set(owners.map((o) => o.patientId).filter((p): p is string => p !== null))];
  const summaries = await getPatientSummaries(db, actor, patientIds);
  const summaryOf = new Map(summaries.map((s) => [s.requestedId, s] as const));
  const counters = await entitlementCountersOf(db, ids);

  return {
    ...base,
    memberships: base.memberships.map((m): CounterMembership => {
      const owner = ownerOf.get(m.instanceId) ?? null;
      const linked = owner !== null;
      const summary = owner === null ? undefined : summaryOf.get(owner);
      const standing = standingOf(m, input.at);
      return {
        ...m,
        standing,
        linked,
        holder: summary === undefined ? null : holderOf(summary, input.at),
        allowances: m.benefits.map((b) => {
          const counter = counters.find((c) => c.instanceId === m.instanceId && c.benefitKey === b.benefitKey);
          let allowance: CounterAllowance;
          if (counter === undefined) allowance = { kind: "every_visit" };
          else if (counter.unit !== "count") allowance = { kind: "on_the_bill" };
          else {
            allowance = {
              kind: "visits",
              granted: counter.grantedQty,
              // A lapsed or void counter honours nothing today, whatever its log says.
              remaining: counterLiveAt(counter, input.at) ? Math.max(0, counter.remainingQty) : 0,
            };
          }
          return { benefitKey: b.benefitKey, title: b.title, allowance };
        }),
        nextAct: nextActOf(standing, linked),
      };
    }),
  };
}

/**
 * Writes `instrument.recognised` for the code the counter presented. One event per recognition the
 * screen asks for; a recognition by patient alone (no card in hand) is not a card at the counter.
 */
export async function recordRecognition(
  db: Db,
  actor: Actor,
  presentedCodes: string[],
  result: CounterRecognition,
  at: Date,
): Promise<void> {
  const code = presentedCodes.map((c) => c.trim()).find((c) => c !== "");
  if (code === undefined) return;
  const folded = code.toLowerCase();
  const card = result.memberships.find((m) => m.cardCode.toLowerCase() === folded);
  const coupon = card === undefined ? result.coupons.find((c) => c.code.toLowerCase() === folded) : undefined;
  await withTx(db, (tx) =>
    appendEvent(tx, instrumentRecognised.make({
      actor,
      occurredAt: at,
      patientId: card?.holder?.patientId,
      payload: {
        code: card?.cardCode ?? coupon?.code ?? code,
        source: card !== undefined ? "card" : coupon !== undefined ? "coupon" : "none",
        instanceId: card?.instanceId ?? null,
        origin: card?.origin ?? null,
        standing: card?.standing ?? null,
        linked: card?.linked ?? false,
      },
    })),
  );
}

export type CardTodayRow = {
  code: string;
  source: "card" | "coupon" | "none";
  origin: string | null;
  standing: CounterStanding | null;
  linked: boolean;
  at: Date;
  holder: { name: string | null; alias: string | null; restricted: boolean; uhid: string } | null;
  /** The row needs this counter before anything else: no match, or a usable card nobody has linked. */
  needsYou: boolean;
};

const TODAY_LIMIT = 50;

/**
 * THIS COUNTER'S CARDS TODAY — the signed-in person's own recognitions since IST midnight, newest
 * first, one row per code (the latest reading wins), rows that need the counter first.
 *
 * The holder is named through `getPatientSummaries`, the same sealed gate as recognition. The row
 * carries a status word and never a figure: the event it is read from holds none.
 */
export async function cardsToday(db: Db, actor: Actor, now: Date): Promise<CardTodayRow[]> {
  const dayStart = new Date(istDayIndex(now) * DAY_MS - IST_OFFSET_MS);
  const rows = await db
    .select({ occurredAt: events.occurredAt, patientId: events.patientId, payload: events.payload })
    .from(events)
    .where(and(
      eq(events.name, instrumentRecognised.name),
      eq(events.actorId, actor.id),
      // `recorded_at` is the partition key, so the day bound goes on it too; `occurred_at` is the day.
      gte(events.recordedAt, new Date(dayStart.getTime() - DAY_MS)),
      gte(events.occurredAt, dayStart),
    ))
    .orderBy(desc(events.seq))
    .limit(TODAY_LIMIT * 4);

  const seen = new Set<string>();
  const latest: { row: (typeof rows)[number]; payload: ReturnType<typeof instrumentRecognised.payloadSchema.parse> }[] = [];
  for (const row of rows) {
    const parsed = instrumentRecognised.payloadSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    const key = parsed.data.code.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push({ row, payload: parsed.data });
    if (latest.length >= TODAY_LIMIT) break;
  }

  const patientIds = [...new Set(latest.map((l) => l.row.patientId).filter((p): p is string => p !== null))];
  const summaryOf = new Map((await getPatientSummaries(db, actor, patientIds)).map((s) => [s.requestedId, s] as const));

  const out = latest.map(({ row, payload }): CardTodayRow => {
    const s = row.patientId === null ? undefined : summaryOf.get(row.patientId);
    return {
      code: payload.code,
      source: payload.source,
      origin: payload.origin,
      standing: payload.standing,
      linked: payload.linked,
      at: row.occurredAt,
      holder: s === undefined ? null : { name: s.name, alias: s.alias, restricted: s.restricted, uhid: s.uhid },
      needsYou: payload.source === "none" || (payload.standing === "usable" && !payload.linked),
    };
  });
  // Stable: needs-you rows first, each group keeping newest-first.
  return [...out.filter((r) => r.needsYou), ...out.filter((r) => !r.needsYou)];
}
