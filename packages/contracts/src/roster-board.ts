/**
 * THE ROSTER'S TWO READING SCREENS — "Who is on now" and "My duties" — AS ONE SET OF RULES, read by
 * the web screens (`apps/web/src/screens/roster-on-now.tsx`, `roster-my-duties.tsx`) and by the phone
 * (`apps/mobile/src/roster`, mobile plan M5). Pure TypeScript with no imports and NOT in the
 * contracts index, like `vitals-entry.ts`: the phone app is outside the pnpm workspace and reads
 * this file by path.
 *
 * Nothing here decides who is on duty — the server's board says that. This file holds the wire
 * shapes of `roster-board.controller.ts` (transcribed from `modules/roster/{board,my-duties,swaps}.ts`)
 * and the reading rules both screens share: what the clock means for the take, how a unit's "till"
 * is said, what a duty IS in two words, which day is rest after a night, and which of the requests
 * on a person's page are theirs to answer.
 *
 * Every wording choice comes back as an i18n KEY (and its parts), never a sentence: the web and the
 * phone each have their own translator, and a clerk must read the same sentence on both.
 */

/* ═══ wire: GET /roster/on-now ═══ */

export type RosterSource = "published" | "pattern" | "static";

/** `phone` — D6: only a person in the building now carries one (null when none is on file). */
export type WireBoardPerson = { userId: string; name: string; positionKey: string; positionLabel: string; cadre: string; phone: string | null };
export type WireBoardRung = { userId: string | null; name: string | null; positionKey: string; positionLabel: string; callTier: number | null };
export type WireBoardUnit = { teamId: string; code: string; name: string; startsAt: string; endsAt: string };
export type WireBoardDepartment = {
  departmentId: string; code: string; name: string; units: number; source: RosterSource; skeleton: boolean;
  unitOnTake: WireBoardUnit | null; backupUnit: WireBoardUnit | null;
  inTheBuilding: WireBoardPerson[]; facultyOnCall: WireBoardRung[];
  /**
   * 2026-10-04 (owner: only the OPD is live) — who sits in this department's OPD now or later today.
   * Drawn ONLY where no duty roster is published. Null on the board as it stood; absent from older servers.
   */
  inOpd?: WireOpdSitting[] | null;
};
export type WireOpdSitting = { userId: string; name: string; designation: string | null; from: string; till: string; now: boolean };
export type WireBoardService = {
  positionKey: string; positionLabel: string; cadre: string; source: RosterSource;
  people: { userId: string; name: string; departmentId: string | null }[];
};
export type BoardHoleKind = "no_take_cycle" | "take_gap" | "vacant_slot" | "absent_on_duty" | "skeleton_short";
export type WireBoardHole = {
  kind: BoardHoleKind; departmentId: string; departmentName: string; from: string; to: string;
  positionKey: string | null; positionLabel: string | null; userId: string | null; name: string | null;
  /** 20-U I5 — `skeleton_short` only: the strike day's uncovered duties, as one line. Null otherwise. */
  count: number | null;
};
/** The reader, for the Doctor Desk header — `month.ts` `rosterSelf`. Null fields: not posted to a unit now. */
export type WireRosterSelf = {
  name: string | null; grade: string | null; positionKey: string | null; unitName: string | null; departmentName: string | null;
};
export type WireOnNowBoard = {
  at: string; resolverEnabled: boolean; you: WireRosterSelf;
  departments: WireBoardDepartment[]; services: WireBoardService[]; holes: WireBoardHole[];
  /**
   * 2026-10-04 (owner) — departments whose OPD has doctors but which run no CONFIRMED unit yet
   * (Paediatrics, sat by guest faculty). Never a row and never a hole. Optional: older servers send none.
   */
  departmentsWithoutUnit?: { departmentId: string; code: string; name: string; doctors: number; inOpd?: WireOpdSitting[] }[];
  /** 20-U U6 (I22) — open "this is wrong" flags. Optional: a board read before U6 carries none. */
  flags?: WireRosterFlag[];
  /** 20-U infra — the RECORD of the last scheduled print (20:00 / 08:00 IST). Optional: older servers send none. */
  lastPrint?: WireBoardPrint | null;
};

/**
 * 20-U infra (owner 2026-10-04) — `board-print.ts` `lastBoardPrint`. `outcome` is what the server
 * did (`no_printer`: no relay is granted the board's printer, nothing was queued); `copies.printed`
 * is paper a relay REPORTED, never the number queued.
 */
export type WireBoardPrint = {
  printId: string; slotAt: string; renderedAt: string; outcome: "queued" | "no_printer"; destinations: string[];
  copies: { queued: number; printed: number; waiting: number; failed: number };
  lastPrintedAt: string | null; nextAt: string;
};

/* ═══ wire: my duties, covers and swaps, "this is wrong" ═══ */

export type WireDutyRef = {
  assignmentId: string; userId: string | null; positionKey: string; positionLabel: string;
  startsAt: string; endsAt: string; istDate: string; night: boolean; mode: string | null; kind: string;
  departmentId: string; teamId: string | null; teamName: string | null;
};
export type WireMyDuty = WireDutyRef & { activities: string[]; upcoming: boolean };
/** `unavailable` is approved leave, said as nothing more (D6); otherwise a validator rule key. */
export type WireCoverReason = { ruleKey: string; severity: "block" | "warn" | "unavailable"; params: Record<string, unknown> };
export type WireCoverStatus = "asked" | "accepted" | "declined" | "approved" | "refused" | "withdrawn";
export type WireCoverRequest = {
  requestId: string; kind: "cover" | "swap"; status: WireCoverStatus; crossUnit: boolean;
  owner: { userId: string; name: string }; counterpart: { userId: string; name: string }; requestedBy: { userId: string; name: string };
  duty: WireDutyRef; give: WireDutyRef | null;
  note: string | null; requestedAt: string; answeredAt: string | null;
  decidedBy: { userId: string; name: string } | null; decidedAt: string | null; refusedRule: string | null;
  check: WireCoverReason | null;
  youMay: { answer: boolean; approve: boolean; withdraw: boolean };
};
export type WireMyDuties = {
  at: string; days: string[]; you: WireRosterSelf; duties: WireMyDuty[];
  onTake: null | { teamId: string; name: string; endsAt: string };
  /** D6: the reader's unit SR on duty NOW, with a number when one is on file. */
  mySr: null | { userId: string; name: string; phone: string | null };
  requests: WireCoverRequest[];
};
export type WireCoverCandidate = {
  userId: string; name: string; grade: string; teamId: string; teamName: string; crossUnit: boolean;
  nextDay: { istDate: string; duty: null | { night: boolean; positionKey: string } };
  swaps: WireDutyRef[];
};
export type WireCoverRefusal = {
  userId: string; name: string; grade: string; teamId: string; teamName: string;
  reason: WireCoverReason; near: null | { istDate: string; night: boolean };
};
export type WireCoverOptions = {
  duty: WireDutyRef; ownerName: string; canTake: WireCoverCandidate[]; cannot: WireCoverRefusal[]; openRequestId: string | null;
};
export type WireRosterFlag = {
  flagId: string; departmentId: string | null; user: null | { userId: string; name: string };
  at: string; note: string; raisedBy: { userId: string; name: string }; raisedAt: string; youMayResolve: boolean;
};

/* ═══ the clock: IST by fixed arithmetic, never the device's zone ═══ */

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** The IST calendar day of an instant, `YYYY-MM-DD`. */
export function istDay(at: string | Date): string {
  const ms = typeof at === "string" ? Date.parse(at) : at.getTime();
  return new Date(Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

/** Minutes past IST midnight. */
export function istMinutes(iso: string): number {
  const d = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** 08:00–20:00 IST: the faculty on call are in the hospital; outside it, at home. */
export function isDaytime(iso: string): boolean {
  const m = istMinutes(iso);
  return m >= 8 * 60 && m < 20 * 60;
}

/* ═══ who is on now ═══ */

/** "General Medicine Unit III" under "General Medicine" reads "Unit III", as the board writes it. */
export function shortUnit(unitName: string, deptName: string): string {
  return unitName.startsWith(`${deptName} `) ? unitName.slice(deptName.length + 1) : unitName;
}

/**
 * What the clock means for who is on take — the board's three sentences, from the data's own take
 * (the first department that has one). `intro` when no unit is on take anywhere.
 */
export type ClockNote =
  | { key: "intro" }
  | { key: "noteLate" | "noteNight" | "noteDay"; take: WireBoardUnit };
export function clockNoteOf(b: Pick<WireOnNowBoard, "at" | "departments">): ClockNote {
  const take = b.departments.find((d) => d.unitOnTake !== null)?.unitOnTake ?? null;
  if (take === null) return { key: "intro" };
  if (istDay(take.startsAt) !== istDay(b.at)) return { key: "noteLate", take };
  if (istMinutes(b.at) >= 20 * 60) return { key: "noteNight", take };
  return { key: "noteDay", take };
}

/**
 * How a unit's take is said under its name: nothing (no unit), "one unit · every day", or
 * "<day>'s take · till <time>" — with the weekday named when the handover is on another day.
 */
export type TakeTill =
  | null
  | { single: true }
  | { single: false; startsAt: string; endsAt: string; sameDay: boolean };
export function takeTillOf(d: Pick<WireBoardDepartment, "unitOnTake" | "units">, at: string): TakeTill {
  const u = d.unitOnTake;
  if (u === null) return null;
  if (d.units === 1) return { single: true };
  return { single: false, startsAt: u.startsAt, endsAt: u.endsAt, sameDay: istDay(u.endsAt) === istDay(at) };
}

/** Who takes the overflow: the named backup unit, General Medicine's unit for a one-unit department, or nobody. */
export type BackupLine =
  | { key: "backup"; unit: string }
  | { key: "coveredBy"; dept: string }
  | { key: "singleBackup" }
  | { key: "noBackup" };
export function backupOf(d: WireBoardDepartment, b: Pick<WireOnNowBoard, "departments">): BackupLine {
  if (d.backupUnit !== null) return { key: "backup", unit: shortUnit(d.backupUnit.name, d.name) };
  if (d.units === 1) {
    const med = b.departments.find((x) => x.code === "MED" && x.departmentId !== d.departmentId && x.unitOnTake !== null);
    return med !== undefined ? { key: "coveredBy", dept: med.name } : { key: "singleBackup" };
  }
  return { key: "noBackup" };
}

/** A department with no take cycle at all — said differently from "cycle published, duty roster not". */
export function hasNoTakeCycle(d: Pick<WireBoardDepartment, "departmentId">, b: Pick<WireOnNowBoard, "holes">): boolean {
  return b.holes.some((h) => h.kind === "no_take_cycle" && h.departmentId === d.departmentId);
}

/**
 * 2026-10-04 (owner: only the OPD is live) — the one quiet line that replaces a per-row warning where
 * no duty roster is published and the board shows who is sitting in OPD instead.
 */
export function opdFallbackOf(b: Pick<WireOnNowBoard, "departments">): "opdFallbackAll" | "opdFallbackSome" | null {
  const unpublished = b.departments.filter((d) => d.source !== "published" && d.inOpd != null);
  if (unpublished.length === 0) return null;
  return unpublished.length === b.departments.length ? "opdFallbackAll" : "opdFallbackSome";
}

/** The names a "this is wrong" flag may be about: everybody the row shows, once each. */
export function flaggablePeople(d: Pick<WireBoardDepartment, "inTheBuilding" | "facultyOnCall">): { userId: string; name: string }[] {
  return [
    ...d.inTheBuilding.map((p) => ({ userId: p.userId, name: p.name })),
    ...d.facultyOnCall.flatMap((r) => (r.userId === null || r.name === null ? [] : [{ userId: r.userId, name: r.name }])),
  ].filter((p, i, all) => all.findIndex((x) => x.userId === p.userId) === i);
}

/* ═══ my duties ═══ */

/**
 * What a duty IS, in one or two words — as an i18n key under `rosterMyDuties`, with the fallback a
 * night duty of an unlisted post takes: "Ward night", "OPD", "Theatre", "Take · 24 hours".
 */
export function dutyWhatKey(d: Pick<WireDutyRef, "kind" | "startsAt" | "endsAt" | "night" | "positionKey" | "mode"> & { activities?: string[] }): { key: string; fallback?: string } {
  if (d.kind === "teaching") return { key: "rosterMyDuties.what.teaching" };
  const hours = (Date.parse(d.endsAt) - Date.parse(d.startsAt)) / 3_600_000;
  if (hours >= 20) return { key: "rosterMyDuties.what.take" };
  if (d.night) return { key: `rosterMyDuties.night.${d.positionKey}`, fallback: "rosterMyDuties.night.other" };
  const acts = d.activities ?? [];
  if (acts.includes("opd") || acts.includes("special_clinic")) return { key: "rosterMyDuties.what.opd" };
  if (acts.includes("elective_ot") || acts.includes("minor_ot")) return { key: "rosterMyDuties.what.ot" };
  if (d.mode === "call") return { key: "rosterMyDuties.what.call" };
  return { key: acts.length > 0 ? "rosterMyDuties.what.ward" : "rosterMyDuties.what.day" };
}

export type DutyDay = { istDate: string; duty: WireMyDuty | null; rest: null | { until: string } };

/** One entry per day of the week: the day's duty (a night first), or rest after a night, or off. */
export function weekOf(m: Pick<WireMyDuties, "days" | "duties">): DutyDay[] {
  return m.days.map((istDate) => {
    const mine = m.duties.filter((d) => d.istDate === istDate && d.kind !== "off");
    const duty = mine.find((d) => d.night) ?? mine[0] ?? null;
    const after = m.duties.find((d) => d.night && istDay(d.endsAt) === istDate);
    return {
      istDate, duty,
      // Rest after a night: nobody may roster you for twelve hours after it ends (rest_after_duty).
      rest: duty === null && after !== undefined ? { until: new Date(Date.parse(after.endsAt) + 12 * 3_600_000).toISOString() } : null,
    };
  });
}

/** Which third of the day the greeting names, from the IST hour. */
export function greetingKey(at: string): "morning" | "afternoon" | "evening" {
  const h = Math.floor(istMinutes(at) / 60);
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
}

/** "Dr. Meena Joshi" → "Dr. Meena": the board greets a colleague by first name. */
export function greetingName(name: string | null): string {
  return name === null ? "" : name.replace(/^((?:dr|mr|mrs|ms|sr|prof)\.?\s+)?(\S+).*$/i, (_m, hon: string | undefined, first: string) => `${hon ?? ""}${first}`);
}

/**
 * The requests on a person's My duties, sorted into what the page draws:
 *   `ofMe`     — somebody asks ME, and I may answer (Yes / No);
 *   `mine`     — about MY duty (I asked, or my SR asked for me), whatever its state, unless withdrawn;
 *   `answered` — asked of me, already answered, still worth one line;
 *   `asked`    — duties with a request still open: "I can't do this" is not offered twice.
 */
export function coverBuckets(requests: readonly WireCoverRequest[], meId: string | null): {
  ofMe: WireCoverRequest[]; mine: WireCoverRequest[]; answered: WireCoverRequest[]; asked: Set<string>;
} {
  return {
    ofMe: requests.filter((r) => r.youMay.answer),
    mine: requests.filter((r) => r.status !== "withdrawn" && r.counterpart.userId !== meId),
    answered: requests.filter((r) => r.counterpart.userId === meId && r.status !== "asked" && r.status !== "withdrawn"),
    asked: new Set(requests.filter((r) => r.status === "asked" || r.status === "accepted").flatMap((r) => [r.duty.assignmentId, ...(r.give === null ? [] : [r.give.assignmentId])])),
  };
}

/** A request card's colour, by where it stands: settled well, settled badly, or still open. */
export function requestTone(status: WireCoverStatus): "ok" | "bad" | "open" {
  return status === "approved" ? "ok" : status === "refused" || status === "declined" ? "bad" : "open";
}
