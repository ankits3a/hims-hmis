/**
 * ═══ THE COUNTER'S RULES — ONE COPY FOR THE COUNTER PC AND THE PHONE (owner 2026-10-06, mobile M4) ═══
 *
 * Moved, comments and all, out of `apps/web/src/screens/desk-one/model.ts`, which re-exports every
 * name below: the three lanes and what each does with a token, the visit that is already open
 * today, the bill as the server priced it, the board's wait arithmetic, the token as the slip
 * prints it and an age as a counter says it. Pure TypeScript, no imports, NOT in the contracts
 * index — the web imports it by path and the phone's Metro watches the same file
 * (`apps/mobile/src/counter/rules.ts`), so a rule changed for Desk One changes on the phone in the
 * same commit. Nothing here decides money or a queue position: every figure is read off a server
 * answer, and these functions only say it.
 */

// ——— the wire shapes these rules read (structural: the web's wider `Wire…` types satisfy them) ———

export type CounterSequence = "queue_first" | "bill_first";
export type TokenLane = "token_first" | "token_on_payment";
export type CounterFlow = { counterSequence: CounterSequence; tokenLane: TokenLane };

export type CounterTimelineItem = {
  visitNo?: string; encounterId: string; serviceDate: string; status: string; visitType: string;
  doctorId: string | null; doctorName: string | null; departmentId: string | null; departmentName: string | null;
  referredFromEncounterId?: string | null;
};

export type CounterPricedLine = {
  lineId: string; serviceId: string; serviceName: string; qty: number; grossPaise: number; discountPaise: number;
  winner: { reason: string } | null;
};
export type CounterFeeQuote = {
  free: boolean; feesOff?: boolean;
  draft: { lines: CounterPricedLine[]; totals: { cgstPaise: number; sgstPaise: number; roundingPaise: number; netPayablePaise: number } } | null;
  freeReason: { kind: "review_window" | "referral_window"; doctorName: string | null; seenOn: string; windowEndsOn: string } | null;
};

/** One doctor's row of `GET /opd/queues/summary`, as far as the board's arithmetic reads it. */
export type CounterDoctorSummary = {
  doctor: { id: string; departmentId: string; active: boolean };
  waitingCount: number; waitingVitalsCount: number; scheduledToday: boolean; avgConsultMinutes: number;
};

/**
 * Owner, 2026-10-01 — how a FREE consultation is written wherever an amount is shown: in Hindi,
 * whatever language the screen is in. (`apps/web/src/lib/format.ts` re-exports it.)
 */
export const SAMAJ_SEVA_AMOUNT = "₹0 (समाज सेवा छूट)";

/* ══════════ §4 · the flow machine ══════════ */

/**
 * The artifact's three lanes, and the two server columns each one IS.
 *
 * `opd_config` carries `counter_sequence` (queue_first | bill_first) and `token_lane`
 * (token_first | token_on_payment) — two independent booleans, four combinations, of which the
 * artifact names three because the fourth (`bill_first` + `token_first`) is incoherent: a token
 * cannot precede a bill in a lane whose whole definition is that the bill comes first. The server
 * lets both columns be set independently, so `laneOf` must fold that fourth case onto F3 rather
 * than crash — a supervisor who sets it gets bill-first behaviour, which is what they asked for.
 */
export type Lane = "F1" | "F2" | "F3";

export const LANES: readonly Lane[] = ["F1", "F2", "F3"];

export function laneOf(flow: CounterFlow): Lane {
  if (flow.counterSequence === "bill_first") return "F3";
  return flow.tokenLane === "token_first" ? "F1" : "F2";
}

export function flowOf(lane: Lane): CounterFlow {
  switch (lane) {
    case "F1": return { counterSequence: "queue_first", tokenLane: "token_first" };
    case "F2": return { counterSequence: "queue_first", tokenLane: "token_on_payment" };
    case "F3": return { counterSequence: "bill_first", tokenLane: "token_on_payment" };
  }
}

/* ══════════ the token's three states ══════════ */

export type TokenState =
  | { kind: "none" }
  /** There is a visit and deliberately no slip: F2 before payment (position taken), or F3 (neither). */
  | { kind: "held"; position: number | null }
  | { kind: "out"; tokenNo: number; paid: boolean };

/**
 * ═══ THE STAMP IS DERIVED, AND THE LANE DECIDES WHEN THE SLIP LEAVES THE PRINTER ═══
 *
 * `joinQueue` has NO settlement gate server-side, and that is correct rather than a hole: the PAID
 * stamp is computed from the encounter's fee status, never stored, so a token joined before payment
 * reads UNPAID *truthfully*. What the three lanes actually differ in is therefore two things, and
 * this function is where both live:
 *
 *   F1  the number is allocated AND the slip prints, stamped UNPAID; the bill flips the stamp.
 *   F2  the number is allocated (the position is taken, so arrival order is respected) and the
 *       SLIP IS HELD. `tokenNo` is NOT null here — the server joined the queue — which is why
 *       "held" cannot be inferred from a null token and the lane has to be an argument.
 *   F3  nothing is allocated at all until the money is in; `tokenNo` is null and `shouldJoinNow`
 *       is what later fills it.
 *
 * `moneyTaken` is the single predicate for "the money is in": settled, credit-extended, or a free
 * visit with nothing to collect. All three are lawful exits from the bill stage.
 */
export function tokenStateOf(
  lane: Lane,
  visit: { tokenNo: number | null } | null,
  moneyTaken: boolean,
): TokenState {
  if (visit === null) return { kind: "none" };
  if (visit.tokenNo === null) return { kind: "held", position: null };
  if (lane === "F2" && !moneyTaken) return { kind: "held", position: visit.tokenNo };
  return { kind: "out", tokenNo: visit.tokenNo, paid: moneyTaken };
}

/* ══════════ DESK-FIXES A/B — the visit that is ALREADY open today ══════════ */

/**
 * A visit opened for this patient TODAY that has not ended — the thing the desk must offer before it
 * offers a new seating. `referral` is set when a doctor's internal referral opened it, naming the
 * department and doctor that sent them (read off the same timeline, never re-derived).
 */
export type OpenVisit = {
  encounterId: string;
  visitNo: string;
  departmentId: string | null;
  departmentName: string | null;
  doctorId: string | null;
  doctorName: string | null;
  status: string;
  visitType: string;
  referral: { fromEncounterId: string; fromDepartmentName: string | null; fromDoctorName: string | null } | null;
};

/** The states after which a visit is over: nothing is billed or seated against it from the desk. */
const ENDED_VISIT_STATES = new Set(["completed", "abandoned"]);

/**
 * ═══ THE DESK FORGOT A VISIT IT HAD JUST OPENED (2026-09-28 walk, defect A) ═══
 *
 * The desk printed MED-1 stamped UNPAID, the clerk cleared the desk, searched the patient again —
 * and the desk offered a NEW seating while Bill said "Nothing to bill yet". The visit, its token and
 * its fee were all still on the server; the only road to them was typing the visit number into
 * `/billing`. Every one of today's un-ended visits is surfaced first, newest first (the timeline's
 * own order). Pure, so the filter is pinned without a screen.
 */
export function openVisitsToday(items: readonly CounterTimelineItem[], serviceDate: string): OpenVisit[] {
  const byId = new Map(items.map((i) => [i.encounterId, i] as const));
  return items
    .filter((i) => i.serviceDate.slice(0, 10) === serviceDate && !ENDED_VISIT_STATES.has(i.status))
    .map((i) => {
      const fromId = i.referredFromEncounterId ?? null;
      const from = fromId === null ? undefined : byId.get(fromId);
      return {
        encounterId: i.encounterId,
        visitNo: i.visitNo ?? i.encounterId,
        departmentId: i.departmentId,
        departmentName: i.departmentName,
        doctorId: i.doctorId,
        doctorName: i.doctorName,
        status: i.status,
        visitType: i.visitType,
        referral: fromId === null ? null : {
          fromEncounterId: fromId,
          fromDepartmentName: from?.departmentName ?? null,
          fromDoctorName: from?.doctorName ?? null,
        },
      };
    });
}

/**
 * RC-4's `shouldJoinNow`, restated for this screen: the deferred join fires after the money and
 * only then. Pure, so the mutant that fires it early can be applied to this function alone.
 */
export function shouldJoinNow(
  lane: Lane,
  visit: { encounterId: string; tokenNo: number | null; joining: boolean } | null,
  moneyTaken: boolean,
): boolean {
  if (lane !== "F3") return false;
  if (visit === null || visit.joining) return false;
  if (visit.tokenNo !== null) return false;
  return moneyTaken;
}


/* ══════════ money ══════════ */

/** `₹3,720` — en-IN grouping, from paise, with no fractional part when it is whole rupees. */
export function rs(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export type BillLine = { label: string; paise: number; credit: boolean };

/**
 * ═══ THE LIVE BILL, READ OFF THE SERVER'S OWN PRICED DRAFT ═══
 *
 * §3 of the artifact: *"pricing is not a stage, it is a column … the arithmetic happened as chips
 * attached."* So this function does NO arithmetic of its own beyond a sum it can be checked
 * against: every line and every discount below is a field the pricing engine already decided, and
 * the total is `netPayablePaise` as the engine folded it — never a re-addition on the client.
 *
 * FD-7's CRITICAL is the reason for that discipline: a value lane discounted nothing because the
 * screen asserted an intermediate field instead of the amount. The amount is what is rendered here.
 */
export function billOf(quote: CounterFeeQuote | null): { lines: BillLine[]; totalPaise: number; free: boolean } {
  if (quote === null) {
    return { lines: [{ label: "OPD consult — priced on assignment", paise: 0, credit: false }], totalPaise: 0, free: false };
  }
  if (quote.free || quote.draft === null) {
    const why = quote.freeReason;
    const label = quote.feesOff === true
      ? `OPD consultation — ${SAMAJ_SEVA_AMOUNT}`
      : why === null
      ? "review visit — nothing to collect"
      : `${why.kind === "referral_window" ? "referral visit" : "review visit"} — free till ${why.windowEndsOn}${why.doctorName === null ? "" : ` (${why.doctorName})`}`;
    return { lines: [{ label, paise: 0, credit: true }], totalPaise: 0, free: true };
  }
  const lines: BillLine[] = [];
  for (const line of quote.draft.lines) {
    lines.push({ label: line.serviceName, paise: line.grossPaise, credit: false });
    const won = line.winner;
    if (won !== null && line.discountPaise > 0) {
      lines.push({ label: won.reason, paise: -line.discountPaise, credit: true });
    }
  }
  const totals = quote.draft.totals;
  if (totals.cgstPaise + totals.sgstPaise > 0) {
    lines.push({ label: "GST", paise: totals.cgstPaise + totals.sgstPaise, credit: false });
  }
  if (totals.roundingPaise !== 0) {
    lines.push({ label: "rounding", paise: totals.roundingPaise, credit: totals.roundingPaise < 0 });
  }
  return { lines, totalPaise: totals.netPayablePaise, free: totals.netPayablePaise === 0 };
}

/** The invoice's own lines, taken from the quote the clerk was shown, so the two cannot disagree. */
export function invoiceLinesOf(draft: { lines: CounterPricedLine[] }): { lineId: string; serviceId: string; qty: number }[] {
  return draft.lines.map((l) => ({ lineId: l.lineId, serviceId: l.serviceId, qty: l.qty }));
}


/* ══════════ the queue read ══════════ */

export type DeptQueue<D extends CounterDoctorSummary = CounterDoctorSummary> = {
  departmentId: string;
  departmentName: string;
  doctors: D[];
  /** The shortest line in the department, in minutes — the number a patient is actually told. */
  poolWaitMinutes: number;
  /** Waiting for a doctor in this department. */
  waiting: number;
  /** Waiting for the vitals bay in this department — ahead of a new walk-in, counted separately. */
  atVitals: number;
};

/**
 * §3 — *"Queue bars — one bar per doctor, marigold past six waiting; wait shown as minutes AND a
 * clock time, because patients ask 'kitne baje?'"* Both halves come from here: the wait is
 * `waitingCount × avgConsultMinutes`, which is the server's own pace term (`avgConsultMinutes` is
 * `NOT NULL DEFAULT 6` on the department, so there is no client-side fallback to drift).
 *
 * ═══ WHY `waitingVitalsCount` IS NOT IN THIS PRODUCT, AND IS SHOWN SEPARATELY INSTEAD ═══
 *
 * The board reports two queues per doctor: `waitingCount` (waiting for the DOCTOR) and
 * `waitingVitalsCount` (waiting for the vitals bay first). A patient at vitals will reach the
 * doctor before a walk-in seated now, so folding them in would give a longer and arguably truer
 * wait — and it would also SILENTLY DISAGREE with `lib/walk-in-routing.ts`, which is the shipped
 * routing rail and computes `waitingCount × avgConsultMinutes` under RC-3's D7. Two formulas for
 * one number is how a screen and a server come to quote different waits to the same patient.
 *
 * So this stays the rail's formula, and `vitalsAhead` below is rendered as its own labelled figure.
 * Both numbers are on the doctor's row and neither is a guess.
 */
export function waitMinutes(d: Pick<CounterDoctorSummary, "waitingCount" | "avgConsultMinutes">): number {
  return d.waitingCount * d.avgConsultMinutes;
}

/** Waiting for the VITALS BAY, not for the doctor — ahead of a new walk-in, and shown as its own. */
export function vitalsAhead(d: Pick<CounterDoctorSummary, "waitingVitalsCount">): number {
  return d.waitingVitalsCount;
}

/** Everybody in this doctor's part of the hall: the header's "N waiting" is the sum of these. */
export function inHall(d: Pick<CounterDoctorSummary, "waitingCount" | "waitingVitalsCount">): number {
  return d.waitingCount + d.waitingVitalsCount;
}

export function bookableToday(d: Pick<CounterDoctorSummary, "scheduledToday" | "doctor">): boolean {
  return d.scheduledToday && d.doctor.active;
}

/** Group the summary by department, ordered by the shortest pool first: the desk's actual question. */
export function deptQueues<D extends CounterDoctorSummary>(
  summaries: readonly D[],
  departments: readonly { id: string; name: string }[],
): DeptQueue<D>[] {
  const byDept = new Map<string, D[]>();
  for (const s of summaries) {
    const list = byDept.get(s.doctor.departmentId) ?? [];
    list.push(s);
    byDept.set(s.doctor.departmentId, list);
  }
  const out: DeptQueue<D>[] = [];
  for (const dept of departments) {
    const doctors = (byDept.get(dept.id) ?? []).filter((d) => d.doctor.active);
    if (doctors.length === 0) continue;
    const open = doctors.filter(bookableToday);
    const waits = open.map(waitMinutes);
    out.push({
      departmentId: dept.id,
      departmentName: dept.name,
      doctors: [...doctors].sort((a, b) => waitMinutes(a) - waitMinutes(b)),
      poolWaitMinutes: waits.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...waits),
      waiting: open.reduce((a, d) => a + d.waitingCount, 0),
      atVitals: open.reduce((a, d) => a + d.waitingVitalsCount, 0),
    });
  }
  return out;
}

/** The shortest open line in the building — the dock's answer to "kis line mein kam wait hai?". */
export function shortestLine<Q extends Pick<DeptQueue, "poolWaitMinutes">>(queues: readonly Q[]): Q | null {
  const open = queues.filter((q) => Number.isFinite(q.poolWaitMinutes));
  if (open.length === 0) return null;
  return open.reduce((a, b) => (a.poolWaitMinutes <= b.poolWaitMinutes ? a : b));
}

/** The doctor to assign to when the clerk picked a department and not a person: the shortest line. */
export function firstFreeDoctor<D extends CounterDoctorSummary>(q: Pick<DeptQueue<D>, "doctors">): D | null {
  const open = q.doctors.filter(bookableToday);
  if (open.length === 0) return null;
  return open.reduce((a, b) => (waitMinutes(a) <= waitMinutes(b) ? a : b));
}


/**
 * Age as a counter says it: a whole number of years, or months under one.
 *
 * ═══ THE FIRST TEN CHARACTERS, AND THAT IS A MEASURED FIX ═══
 *
 * The wire type says `dob: string | null` and the OPD convention is an IST calendar date
 * (`YYYY-MM-DD`) — but `GET /patients/search` returns the drizzle `date` column serialized as a
 * FULL ISO TIMESTAMP (`"2025-09-02T00:00:00.000Z"`), measured against the running preview. Appending
 * `T00:00:00Z` to that produces an unparseable string, `Invalid Date`, and every search row rendered
 * its age as an em dash. Slicing to ten characters accepts both shapes, which is what a client that
 * cannot change the serializer has to do.
 */
/**
 * FD-15 — the age in WHOLE YEARS, for the correction sheet's input box.
 *
 * Separate from `ageOf` because that one is a LABEL ("41y", "7m" under a year) and this is a
 * NUMBER the clerk edits. They share the birthday rule below deliberately: two derivations of one
 * person's age is how a record reads 41 on one screen and 42 on another.
 */
/**
 * ═══ FD-23 CLOSE REVIEW — TODAY, IN IST, BECAUSE AN AGE IS A DATE DIFFERENCE AND DATES ARE LOCAL ═══
 *
 * `ageOf` and `ageYearsOf` read `getUTCMonth()/getUTCDate()` off `new Date()`. Between 00:00 and
 * 05:30 IST — and a hospital runs through every one of those hours — the UTC instant is still
 * YESTERDAY, so a patient on their birthday was shown a year younger, and `overlays.tsx` seeded the
 * amend box from that same wrong number. `istClock`, `istDateLabel`, `dayMonthIst` and
 * `monthYearIst` in this very file all take deliberate care to be IST; these two did not.
 */
function istYmdToday(at: Date = new Date()): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at).split("-");
  return { y: Number(parts[0]), m: Number(parts[1]), d: Number(parts[2]) };
}

/**
 * ═══ FD-20 — WHAT A PATIENT IS ACTUALLY HOLDING: "MED-4", NOT "T-4" ═══
 *
 * Owner, 2026-09-04: *"the token number should be not according to the doctor but Department. For
 * Example it should be 'MED - 4', 'PED - 290'."* The series moved server-side; this is the face of
 * it, and `opd_departments.code` is the prefix its own schema comment always said it was for
 * ("printed on token slips").
 *
 * ONE function for every place a token is shown — the dossier, the bill, and the two scripts the
 * clerk reads out loud. A token the screen prints one way and the clerk says another is a patient
 * standing in front of the wrong door. The bare "T-" fallback is for a code the desk has not
 * loaded yet, never a guess at what the department might be called.
 */
export function tokenLabel(departmentCode: string | null, tokenNo: number): string {
  return departmentCode === null || departmentCode === "" ? `T-${String(tokenNo)}` : `${departmentCode}-${String(tokenNo)}`;
}

export function ageYearsOf(dob: string | null): number | null {
  if (dob === null || dob === "") return null;
  const born = new Date(`${dob.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(born.getTime())) return null;
  const today = istYmdToday();
  let years = today.y - born.getUTCFullYear();
  const bornMonth = born.getUTCMonth() + 1;
  const beforeBirthday = today.m < bornMonth
    || (today.m === bornMonth && today.d < born.getUTCDate());
  if (beforeBirthday) years -= 1;
  return years < 0 ? null : years;
}

export function ageOf(dob: string | null): string {
  if (dob === null || dob === "") return "";
  const born = new Date(`${dob.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(born.getTime())) return "";
  const now = new Date();
  const today = istYmdToday(now);
  let years = today.y - born.getUTCFullYear();
  const bornMonth = born.getUTCMonth() + 1;
  const beforeBirthday = today.m < bornMonth
    || (today.m === bornMonth && today.d < born.getUTCDate());
  if (beforeBirthday) years -= 1;
  if (years < 1) {
    const months = Math.max(0, Math.round((now.getTime() - born.getTime()) / (30.44 * 86_400_000)));
    return `${String(months)}m`;
  }
  return String(years);
}

/** `M` / `F` / `O` from the server's `administrativeGender`, for the dossier's `38F` line. */
export function sexLetter(gender: string): string {
  const g = gender.toLowerCase();
  if (g.startsWith("m")) return "M";
  if (g.startsWith("f")) return "F";
  return "O";
}

export function initialsOf(name: string): string {
  return name.split(/\s+/).filter((w) => w !== "").map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
}


/* ══════════ registration: the one box, and the phone's short form ══════════ */

/**
 * ═══ ONE BOX, AGE OR DATE OF BIRTH — THE BOX WORKS OUT WHICH (owner, 2026-10-01) ═══
 *
 * *"In the Age field, we should allow the field to capture exact date of birth instead of just plain
 * number as Age. Our system should be smart enough to understand if it's date of birth or simple age
 * in number."* The old form made the clerk pick a mode first. Now what is typed decides:
 *
 *   · one to three digits                         → an AGE in years (0–130)
 *   · day, month, year with / - . or a space      → a DATE OF BIRTH, day first, as India writes it
 *   · eight digits, `14031986`                    → the same date with no separators
 *   · `1986-03-14`                                → the same date, year first
 *
 * A two-digit year is this century when that is not in the future, otherwise the last one. A date
 * that does not exist, lies in the future, or is more than 130 years back is NOT a date of birth,
 * and anything half-typed is nothing yet — null, so nothing travels until the box is readable.
 */
export type AgeOrDob = { kind: "age"; years: number } | { kind: "dob"; iso: string };
export function parseAgeOrDob(raw: string, today: Date = new Date()): AgeOrDob | null {
  const text = raw.trim();
  if (/^\d{1,3}$/.test(text)) {
    const years = Number.parseInt(text, 10);
    return years <= 130 ? { kind: "age", years } : null;
  }
  let parts: [string, string, string] | null = null; // day, month, year
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const dmy = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2}|\d{4})$/.exec(text);
  const packed = /^(\d{2})(\d{2})(\d{4})$/.exec(text);
  if (iso !== null) parts = [iso[3]!, iso[2]!, iso[1]!];
  else if (dmy !== null) parts = [dmy[1]!, dmy[2]!, dmy[3]!];
  else if (packed !== null) parts = [packed[1]!, packed[2]!, packed[3]!];
  if (parts === null) return null;
  const day = Number.parseInt(parts[0], 10);
  const month = Number.parseInt(parts[1], 10);
  let year = Number.parseInt(parts[2], 10);
  const thisYear = today.getFullYear();
  if (parts[2].length === 2) year += year <= thisYear % 100 ? Math.floor(thisYear / 100) * 100 : (Math.floor(thisYear / 100) - 1) * 100;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  if (date.getTime() > todayUtc || year < thisYear - 130) return null;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return { kind: "dob", iso: `${String(year)}-${pad(month)}-${pad(day)}` };
}

/** MAJORITY_AGE_YEARS on the server (`patients/types.ts`): a KNOWN minor's registration must name a guardian. */
export const COUNTER_MAJORITY_AGE = 18;

export const GUARDIAN_RELATIONSHIPS = ["father", "mother", "spouse", "sibling", "legal_guardian", "other"] as const;
export type GuardianRelationship = (typeof GUARDIAN_RELATIONSHIPS)[number];

/**
 * THE PHONE'S SHORT REGISTRATION FORM — the fields the counter's fast path asks for and nothing
 * else: name, sex, the one age-or-date-of-birth box, a mobile, an address, and a guardian when the
 * box says the patient is a minor. Everything else on the record (ABHA, coverage, a sealed record's
 * alias, the referrer) is entered at the counter PC or from the patient's profile.
 */
export type ShortRegistration = {
  name: string; sex: "" | "male" | "female" | "other"; ageOrDob: string; phone: string; address: string;
  guardianName: string; guardianRelationship: "" | GuardianRelationship; guardianPhone: string;
};
export const EMPTY_SHORT_REGISTRATION: ShortRegistration = {
  name: "", sex: "", ageOrDob: "", phone: "", address: "", guardianName: "", guardianRelationship: "", guardianPhone: "",
};

/** Whole years for what the box holds, or null while it is unreadable. A typed age is taken as said. */
export function shortFormAgeYears(f: Pick<ShortRegistration, "ageOrDob">, today: Date = new Date()): number | null {
  const got = parseAgeOrDob(f.ageOrDob, today);
  if (got === null) return null;
  if (got.kind === "age") return got.years;
  return ageYearsOf(got.iso);
}

/**
 * What stops the short form from being sent, as keys the screen words — the server's own refusals,
 * seen coming: `phoneField` is a bare 10-digit Indian mobile (`patients.controller.ts`), and a known
 * minor with no guardian is `minor_needs_guardian` (`registration.ts`). Empty = ready.
 */
export type ShortFormGap = "name" | "sex" | "age" | "phone" | "guardian" | "guardianPhone";
export function shortFormGaps(f: ShortRegistration, today: Date = new Date()): ShortFormGap[] {
  const gaps: ShortFormGap[] = [];
  const digits = (v: string): string => v.replace(/\s/g, "");
  if (f.name.trim() === "") gaps.push("name");
  if (f.sex === "") gaps.push("sex");
  const years = shortFormAgeYears(f, today);
  if (years === null) gaps.push("age");
  if (digits(f.phone) !== "" && !/^[6-9]\d{9}$/.test(digits(f.phone))) gaps.push("phone");
  if (years !== null && years < COUNTER_MAJORITY_AGE && (f.guardianName.trim() === "" || f.guardianRelationship === "")) gaps.push("guardian");
  if (digits(f.guardianPhone) !== "" && !/^[6-9]\d{9}$/.test(digits(f.guardianPhone))) gaps.push("guardianPhone");
  return gaps;
}

/**
 * The body `POST /patients` receives from the short form. The same rules the counter PC's
 * `registerBodyOf` keeps: a blank box is an OMITTED key, never an empty string; exactly one of
 * `dob` / `ageYears`; and a guardian's four authorities always travel explicitly (messages and
 * bills on, consents and records off — the signed-off design, never a column default).
 */
export function shortRegisterBody(f: ShortRegistration, opts: { acknowledgeDuplicates?: boolean } = {}, today: Date = new Date()): Record<string, unknown> {
  const t = (v: string): string => v.trim();
  const digits = (v: string): string => v.replace(/\s/g, "");
  const born = parseAgeOrDob(f.ageOrDob, today);
  return {
    name: t(f.name),
    sex: f.sex,
    ...(digits(f.phone) === "" ? {} : { phone: digits(f.phone) }),
    ...(born === null ? {} : born.kind === "dob" ? { dob: born.iso } : { ageYears: born.years }),
    ...(t(f.address) === "" ? {} : { addressLine: t(f.address) }),
    ...(t(f.guardianName) === "" || f.guardianRelationship === ""
      ? {}
      : {
        guardian: {
          name: t(f.guardianName),
          relationship: f.guardianRelationship,
          ...(digits(f.guardianPhone) === "" ? {} : { phone: digits(f.guardianPhone) }),
          authorityMessages: true, authorityBills: true, authorityConsents: false, authorityDsr: false,
        },
      }),
    ...(opts.acknowledgeDuplicates === true ? { acknowledgedDuplicates: true } : {}),
  };
}

/* ══════════ "Wrong department — move patient": what the preview means (owner 2026-10-05) ══════════ */

export type MoveVisitType = "new" | "revisit" | "renewal";
export type MoveMoneyKind = "none" | "zero_bill" | "transfer" | "difference" | "billing_office";
export type MoveMoney = {
  kind: MoveMoneyKind;
  invoiceId: string | null; invoiceNo: string | null;
  paidPaise: number; newFeePaise: number;
  /** newFee − paid: positive is collected now, negative stays as the patient's credit. */
  differencePaise: number;
  billingOfficeReason: "other_services" | "on_credit" | "part_paid" | "several_bills" | null;
};
export type MoveConsultTerms = { consultFeeOff: boolean; paise: Record<MoveVisitType, number | null> };

/**
 * What a visit of this kind costs, as the move panel says it. THE SERVER'S AMOUNT WINS: the preview
 * prices both sides with the money rule's own pricer, so the fee line and the money line cannot
 * disagree. The price list is used only to say WHY it is free (the fee switch) or for a server that
 * sent no amount. null = unknown (a seat that may not read the terms): the kind stands alone.
 */
export type MoveFee = { kind: "amount"; paise: number } | { kind: "feesOff" } | { kind: "free" };
export function moveFee(vt: MoveVisitType, terms: MoveConsultTerms | undefined, serverPaise?: number): MoveFee | null {
  if (serverPaise !== undefined && serverPaise > 0) return { kind: "amount", paise: serverPaise };
  if (terms?.consultFeeOff === true) return { kind: "feesOff" };
  if (serverPaise !== undefined) return { kind: "free" };
  if (terms === undefined) return null;
  const paise = terms.paise[vt];
  if (paise === null) return vt === "revisit" ? { kind: "free" } : null;
  return paise > 0 ? { kind: "amount", paise } : { kind: "free" };
}

/** A move the desk cannot make: the Billing office's kind of bill, or a fee difference this seat may not settle. */
export function moveMoneyBlocks(money: MoveMoney | undefined, maySettle: boolean): boolean {
  if (money === undefined) return false;
  if (money.kind === "billing_office") return true;
  return money.kind === "difference" && !maySettle;
}

/** What is tendered in the same act as the move: only a HIGHER fee, and only at a seat that may settle it. */
export function moveCollectPaise(money: MoveMoney | undefined, maySettle: boolean): number {
  return money?.kind === "difference" && maySettle && money.differencePaise > 0 ? money.differencePaise : 0;
}

/**
 * The money sentence under the fee line: which `registrationCounter.move.money.*` key, its amounts
 * (already written as rupees), and how loud it is. `none` says nothing.
 */
export type MoveMoneyLine = { key: string; vars: Record<string, string>; tone: "ok" | "warn" | "stop" };
export function moveMoneyLine(money: MoveMoney, maySettle: boolean): MoveMoneyLine | null {
  const no = money.invoiceNo ?? "";
  const base = "registrationCounter.move.money";
  switch (money.kind) {
    case "none":
      return null;
    case "zero_bill":
      return { key: `${base}.zeroBill`, vars: { no }, tone: "ok" };
    case "transfer":
      return { key: `${base}.transfer`, vars: { paid: rs(money.paidPaise), no }, tone: "ok" };
    case "difference":
      if (!maySettle) return { key: `${base}.differsDesk`, vars: { paid: rs(money.paidPaise), fee: rs(money.newFeePaise) }, tone: "stop" };
      if (money.differencePaise < 0) {
        return { key: `${base}.lower`, vars: { paid: rs(money.paidPaise), fee: rs(money.newFeePaise), left: rs(-money.differencePaise) }, tone: "warn" };
      }
      return { key: `${base}.higher`, vars: { paid: rs(money.paidPaise), fee: rs(money.newFeePaise), diff: rs(money.differencePaise) }, tone: "warn" };
    case "billing_office":
      return { key: `${base}.office.${money.billingOfficeReason ?? "several_bills"}`, vars: { no }, tone: "stop" };
  }
}

/* ══════════ the visit's paper (FD-24 / FD-25): one current state per document ══════════ */

export type PaperJob = { id: string; document: string; status: string; createdAt: string };

/**
 * What a visit's print jobs amount to. A DOCUMENT HAS ONE CURRENT STATE and it is the newest
 * row's: a reprint mints a new job, so two rows for one slip are two ATTEMPTS at one thing. Failed
 * wins (it is the only state that offers an action), then waiting, then printed.
 */
export type PaperState<J extends PaperJob = PaperJob> = {
  state: "none" | "waiting" | "printed" | "failed"; current: J[]; failed: J[]; pending: J[];
};
export function paperState<J extends PaperJob>(jobs: readonly J[]): PaperState<J> {
  if (jobs.length === 0) return { state: "none", current: [], failed: [], pending: [] };
  const latest = new Map<string, J>();
  for (const job of jobs) {
    const held = latest.get(job.document);
    if (held === undefined || job.createdAt > held.createdAt) latest.set(job.document, job);
  }
  const current = [...latest.values()];
  const failed = current.filter((j) => j.status === "failed");
  const pending = current.filter((j) => j.status === "queued" || j.status === "claimed");
  return { state: failed.length > 0 ? "failed" : pending.length > 0 ? "waiting" : "printed", current, failed, pending };
}
