import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";
import { ageOf } from "./desk-one/model";
import "./merge-review.css";

/*
  UX-AUDIT 2026-09-28 · BOARD — MERGE REVIEW, BUILT FROM THE OWNER-APPROVED BOARD
  (`docs/design/2026-09-28-ux-audit/merge-review.html` + `.notes.md`).

  The house three-column layout inside the app shell: the pair in hand on the left, a four-step flow
  in the centre (pick, compare, which survives, reason) with ONE pinned act, and one list of merge
  requests on the right — no tabs, granted first. The Medical Superintendent (the approver, owner
  ruling 26-Aug-2026) opens a request on this same screen, sees the comparison FROZEN as captured at
  request time, and approves or refuses with a note.

  What the board asked for and this file does NOT draw, because the server has nothing to back it:
  the source chip (DESK / LAB / IPD / MRD) and "registered at counter N", the copilot's duplicate
  suggestions, and the date of the merge that joined two picked records. Each is on the board's
  "needs server" list and is reported, not faked.

  OWNER RULINGS THAT BIND THIS SCREEN: Aadhaar is never evidence — no field, no chip, no placeholder
  invites typing it, not even its last four digits. A SEALED (confidential) record is merged only
  after the MS records a break-glass on it (`merge.ts`, checked at execute); this screen says so
  before the request is sent and gives the MS the step on the approver's seat.
*/

// ——— wire shapes ———

type SearchHit = {
  id: string; uhid: string; name: string; phone: string | null; administrativeGender: string;
  dob: string | null; isConfidential: boolean; hasPhoto: boolean;
  // Present on the wire since FD-11 (search.ts) — optional here so an older payload still renders.
  district?: string | null;
};

// The subset of `GET /patients/:id` (and of the frozen request.snapshot rows) this screen reads.
type PatientRow = {
  id: string;
  uhid: string;
  name: string;
  phone: string | null;
  dob: string | null;
  dobEstimated?: boolean;
  administrativeGender: string;
  addressLine: string | null;
  abhaAddress: string | null;
  abhaNumber: string | null;
  abhaVerificationStatus?: string;
  isConfidential?: boolean;
  createdAt?: string;
};
type Allergy = { id: string; substance: string; reaction: string | null; severity: string | null; status?: string };
type Guardian = { id: string; name: string; status?: string };
type VisitSummary = { patientId: string; visits: number; lastVisitOn: string | null };

type MergeStatus = "requested" | "executed" | "unmerged" | "refused";
type MergeRequestView = {
  id: string;
  winnerId: string;
  loserId: string;
  approvalId?: string;
  status: MergeStatus;
  requestNote: string;
  requestedBy?: string;
  requestedAt?: string;
  snapshot: { winnerBefore: PatientRow; loserBefore: PatientRow };
};
type MergeDetail = {
  request: MergeRequestView;
  approvalStatus: string | null;
  unmergeApprovalStatus: string | null;
  decisionNote?: string | null;
  decidedAt?: string | null;
  requestedByName?: string | null;
  sealed?: { winner: boolean; loser: boolean };
};
type Stage = "granted" | "waiting" | "refused" | "unmerge_waiting" | "done";
type ListSide = { id: string; uhid: string; name: string; sealed: boolean };
type ListItem = {
  id: string; status: MergeStatus; stage: Stage; approvalId: string; approvalStatus: string | null;
  requestNote: string; requestedBy: string; requestedByName: string | null; requestedAt: string; dueAt: string | null;
  decisionNote: string | null; decidedByName: string | null; decidedAt: string | null; executedAt: string | null;
  unmergeApprovalStatus: string | null; winner: ListSide; loser: ListSide;
};

// ——— dates: every date reads DD-Mon-YYYY (the board's "DOB shown as 1986-03-12" finding) ———

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** `patient_merge`'s closure SLA (`approval-types.ts`): the MS's 4-hour line. */
const MS_LINE_MS = 240 * 60_000;

/** A calendar date (`YYYY-MM-DD…`, the DOB and a visit's service date) → `12-Mar-1986`. No timezone. */
function dmy(date: string | null | undefined): string {
  if (date === null || date === undefined) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (m === null) return "—";
  return `${m[3]!}-${MONTHS[Number(m[2]) - 1] ?? "?"}-${m[1]!}`;
}
/** An instant → its IST calendar date, `28-Sep-2026`. */
function dmyIst(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const d = new Date(t + IST_OFFSET_MS);
  return `${String(d.getUTCDate()).padStart(2, "0")}-${MONTHS[d.getUTCMonth()]!}-${String(d.getUTCFullYear())}`;
}
/** An instant → IST clock time, `09:20`. */
function hmIst(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const d = new Date(t + IST_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
/** Milliseconds → `1 h 40 m` / `25 m`: the board's clock against the MS's 4-hour line. */
function span(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(mins / 60);
  return h > 0 ? `${String(h)} h ${String(mins % 60)} m` : `${String(mins)} m`;
}
function ageYears(dob: string | null): string {
  const age = ageOf(dob);
  return age === "" ? "" : age.endsWith("m") ? age : `${age} y`;
}

/**
 * UX-AUDIT 2026-09-28 — the mobile is masked the way every list row in the app masks it —
 * `•••••• 3210`, the rule in `search-provider.ts`'s `toHit` (DD8: a list row is not a record; the
 * full number is on the comparison, behind the pick).
 */
function maskedPhone(phone: string | null): string | null {
  if (phone === null || phone === "") return null;
  return `•••••• ${phone.replace(/\D/g, "").slice(-4)}`;
}

/** The comparison shows the full mobile, grouped as the board draws it: `98290 41236`. */
function spacedPhone(phone: string | null): string {
  if (phone === null || phone === "") return "—";
  return /^\d{10}$/.test(phone) ? `${phone.slice(0, 5)} ${phone.slice(5)}` : phone;
}

// Server errors carry either a plain string or a zod issue array (patients.controller.ts's toHttp).
function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { message?: unknown } | null;
    if (typeof body?.message === "string") return body.message;
    if (Array.isArray(body?.message)) {
      return body.message
        .map((issue) =>
          typeof issue === "object" && issue !== null && "message" in issue
            ? String((issue as { message: unknown }).message)
            : String(issue),
        )
        .join("; ");
    }
  }
  return String(e);
}

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** A clock for the "time left" pills; a tick every half minute is all a 4-hour line needs. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** true on a phone-width viewport; jsdom has no `matchMedia`, and reads as desktop there. */
function useNarrow(): boolean {
  const query = "(max-width: 639px)";
  const [narrow, setNarrow] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = (): void => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

function sexWord(t: TFunction, g: string): string {
  return t(`register.${g}`, { defaultValue: g });
}
function active<T extends { status?: string }>(items: T[] | undefined): T[] {
  return (items ?? []).filter((x) => (x.status ?? "active") === "active");
}

// ——— step 1: the picker (PR #355's behaviours kept: disabled second pick, hit details, Change) ———

function HitDetails({ hit }: { hit: SearchHit }): React.ReactElement {
  const { t } = useTranslation();
  const age = ageOf(hit.dob);
  const parts = [
    age === "" ? null : t("merge.hitAge", { age: age.endsWith("m") ? age : `${age}y` }),
    sexWord(t, hit.administrativeGender),
    hit.dob === null ? null : t("merge.hitDob", { dob: dmy(hit.dob) }),
    maskedPhone(hit.phone),
    hit.district ?? null,
  ].filter((p): p is string => p !== null && p !== "");
  return <span className="sub">{parts.join(" · ")}</span>;
}

/*
  UX-AUDIT 2026-09-28 — THE SAME RECORD COULD BE PICKED AS BOTH A AND B (PR #355, kept). The other
  side's pick arrives as `takenId`: its row still renders (hiding it would make a search look like it
  lost a patient) but disabled, saying which side already holds it. A picked side can be changed.
*/
function PatientPicker({
  label, hit, onPick, onClear, side, takenId, takenLabel,
}: {
  label: string; hit: SearchHit | null; onPick: (h: SearchHit) => void; onClear: () => void; side: string;
  takenId: string | null; takenLabel: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const debounced = useDebounced(q, 250);
  const search = useQuery({
    queryKey: ["patient-search", side, debounced],
    queryFn: () => api<{ items: SearchHit[] }>("GET", `/patients/search?q=${encodeURIComponent(debounced)}`),
    enabled: hit === null && debounced.trim().length >= 2,
  });

  if (hit !== null) {
    return (
      <div className="box pick" data-testid={`pick-${side}`}>
        <div className="ph">{hit.hasPhoto ? t("merge.photo") : t("merge.noPhoto")}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tag">{label}</div>
          <div style={{ fontWeight: 600 }}>{hit.name}</div>
          <div className="mo" style={{ fontSize: 12 }}>{hit.uhid}</div>
          <HitDetails hit={hit} />
        </div>
        <button type="button" onClick={onClear} className="link">{t("merge.change")}</button>
      </div>
    );
  }

  return (
    <div className="box" style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
      <div style={{ padding: "10px 12px" }}>
        <div className="tag" style={{ marginBottom: 6 }}>{label}</div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("search.placeholder")}
          aria-label={t("merge.searchFor", { side: label })}
          className="search"
        />
      </div>
      <div>
        {search.data?.items.map((h) => {
          const taken = h.id === takenId;
          return (
            <button key={h.id} type="button" onClick={() => onPick(h)} disabled={taken} className="hit">
              <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{h.name}</span> · <span className="mo" style={{ fontSize: 12 }}>{h.uhid}</span>
              {taken && <span style={{ marginLeft: 6, fontSize: 11.5, fontWeight: 600, color: "var(--gold-ink)" }}>({t("merge.alreadyPicked", { side: takenLabel })})</span>}
              <HitDetails hit={h} />
            </button>
          );
        })}
        {search.data !== undefined && search.data.items.length === 0 && (
          <p style={{ margin: 0, padding: "8px 12px", fontSize: 12, color: "var(--dim)" }}>{t("search.none")}</p>
        )}
      </div>
    </div>
  );
}

// ——— step 2: the comparison ———

type CompareRow = { key: string; label: string; a: React.ReactNode; b: React.ReactNode; differs: boolean };

function AllergyList({ items, movesTo }: { items: Allergy[] | undefined; movesTo?: string }): React.ReactElement {
  const { t } = useTranslation();
  if (items === undefined) return <span style={{ color: "var(--dim)" }}>—</span>;
  const live = active(items);
  if (live.length === 0) return <span style={{ color: "var(--dim)" }}>{t("merge.noneRecorded")}</span>;
  return (
    <>
      {live.map((a) => (
        <span key={a.id} className="al">
          {a.substance} — {a.reaction ?? t("merge.reactionNotRecorded")}
          {a.severity !== null && a.severity !== "" && (
            <span className={`sev${a.severity === "severe" ? " s" : ""}`}>{t(`merge.severity.${a.severity}`, { defaultValue: a.severity })}</span>
          )}
          {movesTo !== undefined && <span className="mv">{t("merge.movesTo", { side: movesTo })}</span>}
        </span>
      ))}
    </>
  );
}

function allergyKey(items: Allergy[] | undefined): string {
  return active(items).map((a) => `${a.substance.toLowerCase()}|${a.reaction ?? ""}|${a.severity ?? ""}`).sort().join(";");
}

function dobCell(t: TFunction, p: PatientRow): React.ReactNode {
  if (p.dob === null) return "—";
  const age = ageYears(p.dob);
  return (
    <>
      {dmy(p.dob)}
      <span style={{ color: "var(--dim)" }}>{age === "" ? "" : ` · ${age}`}{p.dobEstimated === true ? ` · ${t("merge.yearOnly")}` : ""}</span>
    </>
  );
}

function abhaCell(t: TFunction, p: PatientRow): React.ReactNode {
  const v = p.abhaAddress ?? p.abhaNumber;
  if (v === null) return <span style={{ color: "var(--dim)" }}>{t("merge.none")}</span>;
  return (
    <>
      {v}{" "}
      {p.abhaVerificationStatus === "verified" && <span className="pill on" style={{ height: 18, fontSize: 9.5 }}>{t("merge.verified")}</span>}
    </>
  );
}

/** The rows the board draws, in its order. */
function compareRows(
  t: TFunction,
  a: PatientRow, b: PatientRow,
  extra: {
    aAllergies?: Allergy[] | undefined; bAllergies?: Allergy[] | undefined; aMovesTo?: string | undefined; bMovesTo?: string | undefined;
    aGuardians?: Guardian[] | undefined; bGuardians?: Guardian[] | undefined;
    aVisits?: VisitSummary | undefined; bVisits?: VisitSummary | undefined;
    allergiesLabel?: string;
    withExtras?: boolean;
  },
): CompareRow[] {
  const rows: CompareRow[] = [
    { key: "name", label: t("register.name"), a: a.name, b: b.name, differs: a.name !== b.name },
    { key: "sex", label: t("card.sex"), a: sexWord(t, a.administrativeGender), b: sexWord(t, b.administrativeGender), differs: a.administrativeGender !== b.administrativeGender },
    { key: "dob", label: t("register.dob"), a: dobCell(t, a), b: dobCell(t, b), differs: (a.dob ?? "").slice(0, 10) !== (b.dob ?? "").slice(0, 10) },
    { key: "phone", label: t("register.phone"), a: <span className="mo">{spacedPhone(a.phone)}</span>, b: <span className="mo">{spacedPhone(b.phone)}</span>, differs: (a.phone ?? "") !== (b.phone ?? "") },
    { key: "address", label: t("register.address"), a: a.addressLine ?? "—", b: b.addressLine ?? "—", differs: (a.addressLine ?? "") !== (b.addressLine ?? "") },
    { key: "abha", label: t("patient.abha"), a: abhaCell(t, a), b: abhaCell(t, b), differs: (a.abhaAddress ?? a.abhaNumber ?? "") !== (b.abhaAddress ?? b.abhaNumber ?? "") },
    {
      key: "allergies", label: extra.allergiesLabel ?? t("patient.allergies"),
      a: <AllergyList items={extra.aAllergies} {...(extra.aMovesTo === undefined ? {} : { movesTo: extra.aMovesTo })} />,
      b: <AllergyList items={extra.bAllergies} {...(extra.bMovesTo === undefined ? {} : { movesTo: extra.bMovesTo })} />,
      differs: allergyKey(extra.aAllergies) !== allergyKey(extra.bAllergies),
    },
  ];
  if (extra.withExtras === true) {
    const g = (items: Guardian[] | undefined): React.ReactNode => {
      if (items === undefined) return "—";
      const live = active(items);
      return live.length === 0 ? <span style={{ color: "var(--dim)" }}>{t("merge.none")}</span> : live.map((x) => x.name).join(", ");
    };
    const v = (s: VisitSummary | undefined): string =>
      s === undefined ? "—" : s.visits === 0 ? t("merge.noVisits") : t("merge.visitsLine", { count: s.visits, last: dmy(s.lastVisitOn) });
    rows.push(
      { key: "guardians", label: t("merge.guardians"), a: g(extra.aGuardians), b: g(extra.bGuardians), differs: false },
      { key: "visits", label: t("merge.visits"), a: v(extra.aVisits), b: v(extra.bVisits), differs: false },
      { key: "registered", label: t("merge.registered"), a: dmyIst(a.createdAt), b: dmyIst(b.createdAt), differs: false },
    );
  }
  return rows;
}

/*
  UX-AUDIT 2026-09-28 — AT 390 px RECORD B AND EVERY "differs" MARKER WERE OFF-SCREEN (PR #355,
  kept). Below 640px each field row becomes a small grid — label and marker on the first line, then
  A and B stacked, each captioned (`merge-review.css`). It is still one `<tr>` per field either way,
  so a row and its marker stay one element. BOARD: on a phone the identical rows fold behind
  "+ N more fields", because the rows that differ are the ones that answer the question.
*/
function CompareTable({
  rows, headA, headB, capA, capB, keepA,
}: {
  rows: CompareRow[]; headA: string; headB: string; capA: string; capB: string; keepA: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const narrow = useNarrow();
  const [open, setOpen] = useState(false);
  const shown = narrow && !open ? rows.filter((r) => r.differs) : rows;
  const hidden = rows.length - shown.length;
  return (
    <div className="box" style={{ overflow: "hidden" }}>
      <table className="cmp">
        <thead>
          <tr>
            <th />
            <th className={keepA ? "keep" : ""}>{headA}</th>
            <th>{headB}</th>
            <th style={{ width: 80 }} />
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.key} className={r.differs ? "df" : ""} data-row={r.key}>
              <td className="k">{r.label}</td>
              <td className={`va${keepA ? " keep" : ""}`}><span className="cap tag">{capA}</span>{r.a}</td>
              <td className="vb"><span className="cap tag">{capB}</span>{r.b}</td>
              <td className="dfm">{r.differs ? t("merge.differs") : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 && (
        <button type="button" className="more" onClick={() => setOpen(true)}>{t("merge.moreFields", { count: hidden })} ▾</button>
      )}
    </div>
  );
}

// ——— the right column: one list, no tabs ———

function StagePill({ item, now }: { item: ListItem; now: number }): React.ReactElement {
  const { t } = useTranslation();
  switch (item.stage) {
    case "granted": return <span className="pill on">{t("merge.list.runIt")}</span>;
    case "waiting": return <span className="pill gd">{item.dueAt === null ? "—" : span(new Date(item.dueAt).getTime() - now)}</span>;
    case "refused": return <span className="pill rd">{t("merge.list.refused")}</span>;
    case "unmerge_waiting": return <span className="pill">{t("merge.list.unmerge")}</span>;
    default: return <span className="pill">{item.status === "unmerged" ? t("merge.list.unmerged") : t("merge.list.merged")}</span>;
  }
}

function listLine(t: TFunction, item: ListItem, myId: string | null): string {
  const who = item.requestedBy === myId ? t("merge.list.byYou") : (item.requestedByName ?? "—");
  switch (item.stage) {
    case "granted": return t("merge.list.lineGranted", { loser: item.loser.uhid, winner: item.winner.uhid, at: hmIst(item.decidedAt) });
    case "refused": return t("merge.list.lineRefused", { note: item.decisionNote ?? "" });
    case "unmerge_waiting": return t("merge.list.lineUnmerge", { date: dmyIst(item.executedAt) });
    case "done": return t("merge.list.lineDone", { loser: item.loser.uhid, winner: item.winner.uhid, date: dmyIst(item.executedAt ?? item.decidedAt) });
    default: return t("merge.list.lineWaiting", { loser: item.loser.uhid, winner: item.winner.uhid, at: hmIst(item.requestedAt), who });
  }
}

function RequestsList({
  items, now, selectedId, onOpen, open, onClose, myId,
}: {
  items: ListItem[] | undefined; now: number; selectedId: string | null; onOpen: (id: string) => void;
  open: boolean; onClose: () => void; myId: string | null;
}): React.ReactElement {
  const { t } = useTranslation();
  const waiting = (items ?? []).filter((i) => i.stage === "waiting" && i.dueAt !== null);
  const nearest = waiting.reduce<number | null>((m, i) => {
    const left = new Date(i.dueAt!).getTime() - now;
    return m === null || left < m ? left : m;
  }, null);
  return (
    <aside className={`list${open ? " open" : ""}`} aria-label={t("merge.list.title")}>
      <section className="box" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "12px 14px" }}>
          <span className="tag" style={{ flexGrow: 1 }}>{t("merge.list.head", { count: items?.length ?? 0 })}</span>
          {open && <button type="button" className="link" onClick={onClose}>{t("merge.list.close")}</button>}
        </div>
        {items === undefined && <p style={{ margin: 0, padding: "10px 14px", fontSize: 12, color: "var(--dim)" }}>{t("app.loading")}</p>}
        {items !== undefined && items.length === 0 && (
          <p style={{ margin: 0, padding: "10px 14px", borderTop: "1px solid var(--line2)", fontSize: 12.5, color: "var(--dim)" }}>{t("merge.list.empty")}</p>
        )}
        {items?.map((i) => (
          <button key={i.id} type="button" className={`row${i.id === selectedId ? " sel" : ""}`} onClick={() => onOpen(i.id)} data-testid="merge-list-row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, overflowWrap: "anywhere" }}>{i.winner.name}</div>
              <div style={{ fontSize: 11.5, color: "var(--dim)", overflowWrap: "anywhere" }}>{listLine(t, i, myId)}</div>
            </div>
            <StagePill item={i} now={now} />
          </button>
        ))}
      </section>
      <details className="box">
        <summary style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px" }}>
          <span className="tag" style={{ flexGrow: 1 }}>{t("merge.list.clocks", { count: waiting.length })}</span>
          {nearest !== null && <span style={{ fontSize: 11.5, color: "var(--gold-ink)", fontWeight: 600 }}>{t("merge.list.line4h", { left: span(nearest) })}</span>}
          <span style={{ color: "var(--dim)" }}>▾</span>
        </summary>
        <div style={{ padding: "0 14px 12px" }}>
          {waiting.length === 0 ? <p style={{ margin: 0, fontSize: 12, color: "var(--dim)" }}>{t("merge.list.noClocks")}</p> : waiting.map((i) => (
            <div key={i.id} className="fact"><span>{i.winner.name}</span><span className="mo">{span(new Date(i.dueAt!).getTime() - now)}</span></div>
          ))}
        </div>
      </details>
      <p style={{ margin: 0, fontSize: 11, lineHeight: "15px", color: "var(--dim)" }}>{t("merge.list.foot")}</p>
    </aside>
  );
}

// ——— the builder: the pair in hand, the four steps, the pinned act ———

const REASON_CHIPS = ["reRegistered", "sameMobile", "confirmed", "spelling"] as const;

function survivorReasons(
  t: TFunction, keep: PatientRow, close: PatientRow, keepVisits?: VisitSummary, closeVisits?: VisitSummary,
): string {
  const why: string[] = [];
  if (keep.createdAt !== undefined && close.createdAt !== undefined && keep.createdAt < close.createdAt) why.push(t("merge.why.older"));
  if (keepVisits !== undefined && closeVisits !== undefined && keepVisits.visits > closeVisits.visits) {
    why.push(t("merge.why.visits", { count: keepVisits.visits }));
  }
  if (keep.abhaVerificationStatus === "verified") why.push(t("merge.why.abha"));
  if (keep.dob !== null && keep.dobEstimated !== true && (close.dob === null || close.dobEstimated === true)) why.push(t("merge.why.fullDob"));
  const lead = why.length > 0 ? `${why.join(", ")}.` : "";
  const warn = close.abhaVerificationStatus === "verified" ? ` ${t("merge.why.abhaOnClosed")}` : "";
  return `${lead}${warn}`.trim() || t("merge.why.none");
}

function Builder({
  list, onRequested,
}: { list: ListItem[] | undefined; onRequested: (id: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [left, setLeft] = useState<SearchHit | null>(null);
  const [right, setRight] = useState<SearchHit | null>(null);
  const [winner, setWinner] = useState<"left" | "right" | null>(null);
  const [note, setNote] = useState("");
  const [chip, setChip] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const leftPatient = useQuery({
    queryKey: ["patient", left?.id ?? ""],
    queryFn: () => api<{ patient: PatientRow; resolvedFrom: string | null }>("GET", `/patients/${left?.id}`),
    enabled: left !== null,
  });
  const rightPatient = useQuery({
    queryKey: ["patient", right?.id ?? ""],
    queryFn: () => api<{ patient: PatientRow; resolvedFrom: string | null }>("GET", `/patients/${right?.id}`),
    enabled: right !== null,
  });
  const lp = leftPatient.data?.patient;
  const rp = rightPatient.data?.patient;
  const ids = lp !== undefined && rp !== undefined && lp.id !== rp.id ? [lp.id, rp.id] : null;
  const allergies = useQuery({
    queryKey: ["merge-allergies", ids?.join(",") ?? ""],
    queryFn: async () => Promise.all(ids!.map((id) => api<{ items: Allergy[] }>("GET", `/patients/${id}/allergies`).then((r) => r.items))),
    enabled: ids !== null,
  });
  const guardians = useQuery({
    queryKey: ["merge-guardians", ids?.join(",") ?? ""],
    queryFn: async () => Promise.all(ids!.map((id) =>
      api<{ items: Guardian[] }>("GET", `/patients/${id}/guardians`).then((r) => r.items).catch(() => undefined))),
    enabled: ids !== null,
  });
  const visits = useQuery({
    queryKey: ["merge-visits", ids?.join(",") ?? ""],
    queryFn: () => api<{ items: VisitSummary[] }>("GET", `/patients/merge-visits?ids=${ids!.join(",")}`).then((r) => r.items),
    enabled: ids !== null,
  });

  /*
    UX-AUDIT 2026-09-28 — two different search rows can still RESOLVE to one record (`GET /patients/:id`
    follows a merged record to its winner — `resolvedFrom`). Compared on the resolved ids, so the
    screen never offers a merge the server will refuse as `merge_same_patient`.
  */
  const sameRecord = lp !== undefined && rp !== undefined && lp.id === rp.id;
  const both = lp !== undefined && rp !== undefined && !sameRecord;

  const keep = winner === "left" ? lp : winner === "right" ? rp : undefined;
  const close = winner === "left" ? rp : winner === "right" ? lp : undefined;
  const keepLabel = winner === "right" ? "B" : "A";
  const closeLabel = winner === "right" ? "A" : "B";
  const [la, ra] = allergies.data ?? [undefined, undefined];
  const [lg, rg] = guardians.data ?? [undefined, undefined];
  const visitOf = (id: string | undefined): VisitSummary | undefined => visits.data?.find((v) => v.patientId === id);
  const closeAllergies = winner === "left" ? ra : winner === "right" ? la : undefined;
  const closeGuardians = winner === "left" ? rg : winner === "right" ? lg : undefined;

  // A request already live for the record that would close — refused before anybody presses the button.
  const alreadyWaiting = close === undefined ? undefined
    : list?.find((i) => i.status === "requested" && (i.stage === "waiting" || i.stage === "granted") && i.loser.id === close.id);
  const sealed = both && (lp.isConfidential === true || rp.isConfidential === true);

  const ready = both && winner !== null && note.trim() !== "" && alreadyWaiting === undefined && !busy;

  const putDown = useCallback((): void => {
    setLeft(null); setRight(null); setWinner(null); setNote(""); setChip(null); setSubmitError(null);
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    if (!ready || keep === undefined || close === undefined) return;
    setSubmitError(null);
    setBusy(true);
    try {
      const res = await api<{ mergeRequestId: string; approvalId: string; instanceId: string }>(
        "POST", "/patients/merge-requests", { winnerId: keep.id, loserId: close.id, note: note.trim() },
      );
      await queryClient.invalidateQueries({ queryKey: ["merge-requests"] });
      onRequested(res.mergeRequestId);
    } catch (e) {
      setSubmitError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [ready, keep, close, note, queryClient, onRequested]);

  // The lane's keycaps: Esc puts the pair down, ⏎ runs the one next act — never from inside a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      const inField = el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "BUTTON" || el.isContentEditable);
      if (inField) return;
      if (e.key === "Escape") putDown();
      if (e.key === "Enter" && ready) { e.preventDefault(); void submit(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [putDown, ready, submit]);

  const pickChip = (key: string): void => {
    const text = t(`merge.chips.${key}`);
    setChip(key);
    if (note.trim() === "") setNote(`${text}.`);
    else if (!note.includes(text)) setNote(`${note.trim()} ${text}.`);
  };

  const moveCount = (items: { status?: string }[] | undefined): string =>
    items === undefined ? "—" : active(items).length === 0 ? t("merge.lane.noneToMove") : t("merge.lane.movesTo", { count: active(items).length, side: keepLabel });

  const lane = (
    <aside className="lane" aria-label={t("merge.lane.label")}>
      <div style={{ padding: "18px 18px 10px" }}>
        <div className="tag">{t("merge.lane.inHand")}</div>
        <h2 style={{ margin: "10px 0 2px", fontSize: 16, lineHeight: "22px", fontWeight: 600, overflowWrap: "anywhere" }}>
          {both ? (lp.name === rp.name ? t("merge.lane.twice", { name: lp.name }) : `${lp.name} · ${rp.name}`) : t("merge.lane.nothing")}
        </h2>
        <p style={{ margin: 0, fontSize: 12, color: "var(--dim)" }}>
          {keep !== undefined ? t("merge.lane.folds", { keep: keepLabel, close: closeLabel }) : t("merge.lane.pickFirst")}
        </p>
      </div>
      <div style={{ padding: "0 18px 16px" }}>
        {keep !== undefined && close !== undefined && (
          <>
            <div className="box" style={{ padding: "10px 12px", borderColor: "var(--green-line)", background: "var(--green-soft)" }}>
              <div className="tag" style={{ color: "var(--green)" }}>{t("merge.lane.survives", { side: keepLabel })}</div>
              <div style={{ fontWeight: 600, marginTop: 4 }}>{keep.name}</div>
              <div className="mo" style={{ fontSize: 12 }}>{keep.uhid}</div>
              <div style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("merge.lane.since", { date: dmyIst(keep.createdAt), count: visitOf(keep.id)?.visits ?? 0 })}</div>
            </div>
            <div style={{ textAlign: "center", color: "var(--dim)", fontSize: 12, padding: "4px 0" }}>▲ {t("merge.lane.foldsInto")}</div>
            <div className="box" style={{ padding: "10px 12px" }}>
              <div className="tag">{t("merge.lane.closes", { side: closeLabel })}</div>
              <div style={{ fontWeight: 600, marginTop: 4 }}>{close.name}</div>
              <div className="mo" style={{ fontSize: 12 }}>{close.uhid}</div>
              <div style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("merge.lane.since", { date: dmyIst(close.createdAt), count: visitOf(close.id)?.visits ?? 0 })}</div>
            </div>
          </>
        )}
        {/* The merge rule, said BEFORE the request (the board's "hidden rule" finding) — merge.ts executeMerge. */}
        <div className="tag" style={{ margin: "16px 0 4px" }}>{t("merge.lane.whatItDoes")}</div>
        <div className="fact"><span>{t("merge.lane.allergies", { side: closeLabel })}</span><span>{moveCount(closeAllergies)}</span></div>
        <div className="fact"><span>{t("merge.lane.guardians", { side: closeLabel })}</span><span>{moveCount(closeGuardians)}</span></div>
        <div className="fact"><span>{t("merge.lane.photo", { side: closeLabel })}</span><span>{t("merge.lane.photoStays", { side: closeLabel })}</span></div>
        <div className="fact"><span>{t("merge.lane.uhid", { side: closeLabel })}</span><span>{t("merge.lane.uhidOpens", { side: keepLabel })}</span></div>
        <div className="fact"><span>{t("merge.lane.contact", { side: closeLabel })}</span><span style={{ color: "var(--gold-ink)" }}>{t("merge.lane.notCopied", { side: keepLabel })}</span></div>
        <div className="tag" style={{ margin: "16px 0 4px" }}>{t("merge.lane.whoDecides")}</div>
        <p style={{ margin: 0, fontSize: 12, lineHeight: "17px", color: "var(--dim)" }}>{t("merge.lane.whoDecidesBody")}</p>
      </div>
      <div style={{ flexGrow: 1 }} />
      <div style={{ padding: "12px 18px", borderTop: "1px solid var(--line)", fontSize: 11, color: "var(--dim)", display: "flex", gap: 10, flexWrap: "wrap" }}>
        <span><span className="kb">Esc</span> {t("merge.keys.putDown")}</span><span><span className="kb">⏎</span> {t("merge.keys.next")}</span>
      </div>
    </aside>
  );

  return (
    <>
      {lane}
      <main className="centre">
        <div className="flow">
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{t("merge.heading")}</h2>
            <span className="hi" style={{ fontSize: 13, color: "var(--dim)" }}>रिकॉर्ड विलय</span>
          </div>

          <div className="step"><span className="num">1</span><div style={{ flex: 1, minWidth: 0 }}>
            <div className="mst">{t("merge.step1")}</div>
            <div className="pair">
              <PatientPicker
                side="left" label={t("merge.left")} hit={left} onPick={setLeft} onClear={() => { setLeft(null); setWinner(null); }}
                takenId={right?.id ?? null} takenLabel={t("merge.right")}
              />
              <PatientPicker
                side="right" label={t("merge.right")} hit={right} onPick={setRight} onClear={() => { setRight(null); setWinner(null); }}
                takenId={left?.id ?? null} takenLabel={t("merge.left")}
              />
            </div>
            {sameRecord && (
              <div role="alert" className="refuse" style={{ marginTop: 10 }}>
                <b>{t("merge.sameRecordTitle")}</b><br />
                {t("merge.sameRecordBody", { a: left?.uhid ?? "", b: right?.uhid ?? "", canonical: lp.uhid })}
              </div>
            )}
            {!both && !sameRecord && <p style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--dim)" }}>{t("merge.pickTwo")}</p>}
          </div></div>

          {both && (
            <>
              <div className="step"><span className="num">2</span><div style={{ flex: 1, minWidth: 0 }}>
                <CompareStep
                  lp={lp} rp={rp} winner={winner}
                  aAllergies={la} bAllergies={ra} aGuardians={lg} bGuardians={rg}
                  aVisits={visitOf(lp.id)} bVisits={visitOf(rp.id)}
                />
              </div></div>

              <div className="step"><span className="num">3</span><div style={{ flex: 1, minWidth: 0 }}>
                <fieldset style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
                  <legend className="mst" style={{ padding: 0 }}>{t("merge.step3")}</legend>
                  <div className="pair">
                    {(["left", "right"] as const).map((sideKey) => {
                      const me = sideKey === "left" ? lp : rp;
                      const other = sideKey === "left" ? rp : lp;
                      const letter = sideKey === "left" ? "A" : "B";
                      const on = winner === sideKey;
                      return (
                        <label key={sideKey} className={`box radio${on ? " on" : ""}`}>
                          <input type="radio" name="merge-winner" checked={on} onChange={() => setWinner(sideKey)} />
                          <span className="dot" aria-hidden />
                          <span style={{ minWidth: 0 }}>
                            <span style={{ display: "block", fontWeight: 600, fontSize: 13 }}>{t("merge.keep", { side: letter, uhid: me.uhid })}</span>
                            <span style={{ display: "block", fontSize: 12, color: "var(--dim)", marginTop: 2 }}>
                              {survivorReasons(t, me, other, visitOf(me.id), visitOf(other.id))}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {sealed && (
                    <div className="note" style={{ marginTop: 10 }} role="note">
                      <b>{t("merge.sealed.title")}</b> {t("merge.sealed.body")}
                    </div>
                  )}
                </fieldset>
              </div></div>

              <div className="step"><span className={`num${winner === null ? " o" : ""}`}>4</span><div style={{ flex: 1, minWidth: 0 }}>
                <div className="mst">
                  <label htmlFor="merge-note">{t("merge.note")}</label>{" "}
                  <span className="hi" style={{ fontWeight: 400, fontSize: 12.5, color: "var(--dim)" }}>· यह एक ही व्यक्ति क्यों है?</span>
                </div>
                <div className="chips">
                  {REASON_CHIPS.map((k) => (
                    <button key={k} type="button" className={`chip${chip === k ? " on" : ""}`} onClick={() => pickChip(k)}>{t(`merge.chips.${k}`)}</button>
                  ))}
                </div>
                {/* OWNER RULING — Aadhaar is never evidence: nothing here asks for it, or for its last four digits. */}
                <textarea
                  id="merge-note"
                  data-field
                  className="ta"
                  value={note}
                  placeholder={t("merge.notePlaceholder")}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div></div>
              {alreadyWaiting !== undefined && (
                <div role="alert" className="refuse">
                  <b>{t("merge.alreadyWaitingTitle", { uhid: alreadyWaiting.loser.uhid })}</b><br />
                  {t("merge.alreadyWaitingBody", { who: alreadyWaiting.requestedByName ?? "—", at: hmIst(alreadyWaiting.requestedAt) })}
                </div>
              )}
              {submitError !== null && <div role="alert" className="refuse" style={{ marginTop: 10 }}>{submitError}</div>}
            </>
          )}
        </div>
        {both && (
          <div className="dock">
            <div className="say">{t("merge.dock", { due: hmIst(new Date(Date.now() + MS_LINE_MS).toISOString()) })}</div>
            <button type="button" className="pri" onClick={() => void submit()} disabled={!ready}>
              {t("merge.submit")} <span className="kb" style={{ background: "transparent", color: "#cfe8dc", borderColor: "#3f8a70" }}>⏎</span>
            </button>
          </div>
        )}
      </main>
    </>
  );
}

function CompareStep({
  lp, rp, winner, aAllergies, bAllergies, aGuardians, bGuardians, aVisits, bVisits,
}: {
  lp: PatientRow; rp: PatientRow; winner: "left" | "right" | null;
  aAllergies: Allergy[] | undefined; bAllergies: Allergy[] | undefined;
  aGuardians: Guardian[] | undefined; bGuardians: Guardian[] | undefined;
  aVisits: VisitSummary | undefined; bVisits: VisitSummary | undefined;
}): React.ReactElement {
  const { t } = useTranslation();
  // The table always reads A | B as picked; the survivor's column carries the green edge, and the
  // closing record's allergies say where they go — the one thing (with guardians) the merge carries.
  const rows = compareRows(t, lp, rp, {
    aAllergies, bAllergies, aGuardians, bGuardians, aVisits, bVisits, withExtras: true,
    aMovesTo: winner === "right" ? "B" : undefined,
    bMovesTo: winner === "left" ? "A" : undefined,
  });
  const differ = rows.filter((r) => r.differs).length;
  const head = (letter: string, isKeep: boolean): string =>
    winner === null ? t("merge.recordLetter", { side: letter }) : isKeep ? t("merge.headSurvives", { side: letter }) : t("merge.headCloses", { side: letter });
  return (
    <>
      <div className="mst">{t("merge.step2")} <span style={{ fontWeight: 400, fontSize: 12, color: "var(--dim)" }}>· {t("merge.differCount", { count: differ, total: rows.length })}</span></div>
      <CompareTable
        rows={rows}
        headA={head("A", winner === "left")} headB={head("B", winner === "right")}
        capA={t("merge.left")} capB={t("merge.right")}
        keepA={winner === "left"}
      />
    </>
  );
}

// ——— a request opened: the requester's tracker, or the approver's seat ———

function UnmergeBlock({
  requestId, unmergeApprovalStatus,
}: { requestId: string; unmergeApprovalStatus: string | null }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [actFirst, setActFirst] = useState(false);
  const [requested, setRequested] = useState(false);
  const [actFirstSubmitted, setActFirstSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestTheUnmerge = async (): Promise<void> => {
    const trimmed = note.trim();
    if (trimmed === "") return;
    setError(null);
    try {
      await api("POST", `/patients/merge-requests/${requestId}/unmerge-request`, { note: trimmed, actFirst });
      setActFirstSubmitted(actFirst);
      setRequested(true);
      await queryClient.invalidateQueries({ queryKey: ["merge-request", requestId] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const executeTheUnmerge = async (): Promise<void> => {
    setError(null);
    try {
      await api("POST", `/patients/merge-requests/${requestId}/unmerge`);
      await queryClient.invalidateQueries({ queryKey: ["merge-request", requestId] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // Mirrors executeUnmerge's rule: granted OR filed act-first — the server remains authoritative.
  const canExecute = unmergeApprovalStatus === "granted" || (requested && actFirstSubmitted);

  return (
    <section className="box" style={{ padding: 14, marginTop: 14 }}>
      <div className="tag" style={{ marginBottom: 8 }}>{t("merge.unmerge")}</div>
      {!requested && (
        <>
          <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, marginBottom: 4 }} htmlFor="unmerge-note">{t("merge.unmergeNote")}</label>
          <textarea id="unmerge-note" data-field className="ta" value={note} onChange={(e) => setNote(e.target.value)} />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, margin: "8px 0" }}>
            <input type="checkbox" checked={actFirst} onChange={(e) => setActFirst(e.target.checked)} />
            {t("merge.actFirst")}
          </label>
          <button type="button" className="sec" onClick={() => void requestTheUnmerge()} disabled={note.trim() === ""}>{t("merge.unmerge")}</button>
        </>
      )}
      {requested && (
        <button type="button" className="sec" onClick={() => void executeTheUnmerge()} disabled={!canExecute}>{t("merge.unmergeExecute")}</button>
      )}
      {error !== null && <div role="alert" className="refuse" style={{ marginTop: 8 }}>{error}</div>}
    </section>
  );
}

/*
  THE APPROVER'S SEAT (board frame 2). The decision rides the approvals engine's own routes —
  `POST /approvals/:id/approve|reject`, note required, `approvals.requests.decide` — which the MS
  already holds; nothing about who may decide is re-implemented here. Requester ≠ approver is the
  server's rule (`decisions.ts`, asserted at decision time); this screen only declines to DRAW the
  buttons for the person who asked.
*/
function RequestView({
  requestId, onPutDown,
}: { requestId: string; onPutDown: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const { actor, can, ready } = useAuth();
  const queryClient = useQueryClient();
  const now = useNow();
  const [decisionNote, setDecisionNote] = useState("");
  const [glassReason, setGlassReason] = useState("");
  const [glassDone, setGlassDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const detail = useQuery({
    queryKey: ["merge-request", requestId],
    queryFn: () => api<MergeDetail>("GET", `/patients/merge-requests/${requestId}`),
    refetchInterval: 5_000,
  });
  const req = detail.data?.request;
  // The frozen snapshot holds patient rows only, so allergies are read LIVE and labelled "now".
  const allergies = useQuery({
    queryKey: ["merge-allergies", req === undefined ? "" : `${req.winnerId},${req.loserId}`],
    queryFn: async () => Promise.all([req!.winnerId, req!.loserId].map((id) =>
      api<{ items: Allergy[] }>("GET", `/patients/${id}/allergies`).then((r) => r.items).catch(() => undefined))),
    enabled: req !== undefined,
  });

  if (detail.data === undefined || req === undefined) {
    return <main className="centre"><div className="flow"><p>{detail.isError ? errorMessage(detail.error) : t("app.loading")}</p></div></main>;
  }
  const d = detail.data;
  const pending = d.approvalStatus === "pending";
  const refused = req.status === "refused" || d.approvalStatus === "rejected";
  const isOwn = actor !== null && req.requestedBy !== undefined && actor.id === req.requestedBy;
  const canDecide = ready && can("approvals.requests.decide");
  const approverSeat = pending && canDecide && !isOwn;
  const sealedIds = [d.sealed?.winner === true ? req.winnerId : null, d.sealed?.loser === true ? req.loserId : null]
    .filter((x): x is string => x !== null);
  const due = req.requestedAt === undefined ? null : new Date(new Date(req.requestedAt).getTime() + MS_LINE_MS);
  const [wa, la] = allergies.data ?? [undefined, undefined];
  const w = req.snapshot.winnerBefore;
  const l = req.snapshot.loserBefore;
  const rows = compareRows(t, w, l, { aAllergies: wa, bAllergies: la, allergiesLabel: t("merge.allergiesNow") });

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null); setBusy(true);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ["merge-request", requestId] });
      await queryClient.invalidateQueries({ queryKey: ["merge-requests"] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const decide = (verdict: "approve" | "reject"): Promise<void> =>
    act(() => api("POST", `/approvals/${req.approvalId ?? ""}/${verdict}`, { note: decisionNote.trim() }));
  // One grant per sealed record in the pair (`kernel/auth/break-glass.ts`); the server checks it at execute.
  const breakGlass = (): Promise<void> =>
    act(async () => {
      for (const patientId of sealedIds) await api("POST", "/auth/break-glass", { patientId, reason: glassReason.trim() });
      setGlassDone(true);
    });
  const run = (): Promise<void> => act(() => api("POST", `/patients/merge-requests/${requestId}/execute`));

  const statusLine = refused ? null
    : req.status === "executed" ? t("merge.state.executed")
    : req.status === "unmerged" ? t("merge.state.unmerged")
    : d.approvalStatus === "granted" ? t("merge.state.granted")
    : t("merge.state.waiting", { left: due === null ? "—" : span(due.getTime() - now) });

  return (
    <>
      <aside className="lane" aria-label={t("merge.lane.label")}>
        <div style={{ padding: 18 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {pending && due !== null && <span className="pill gd">{t("merge.dueIn", { left: span(due.getTime() - now) })}</span>}
            {refused && <span className="pill rd">{t("merge.list.refused")}</span>}
            {d.approvalStatus === "granted" && req.status === "requested" && <span className="pill on">{t("merge.list.runIt")}</span>}
            {sealedIds.length > 0 && <span className="pill gd">{t("merge.sealed.pill")}</span>}
          </div>
          <h2 style={{ margin: "10px 0 2px", fontSize: 16, fontWeight: 600, overflowWrap: "anywhere" }}>{w.name}</h2>
          <div className="fact"><span>{t("merge.keeps")}</span><span className="mo">{w.uhid}</span></div>
          <div className="fact"><span>{t("merge.closes")}</span><span className="mo">{l.uhid}</span></div>
          <div className="fact"><span>{t("merge.askedBy")}</span><span>{d.requestedByName ?? "—"}</span></div>
          <div className="fact"><span>{t("merge.askedAt")}</span><span>{dmyIst(req.requestedAt)} {hmIst(req.requestedAt)}</span></div>
          <div className="tag" style={{ margin: "14px 0 6px" }}>{t("merge.theirReason")}</div>
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: "18px", overflowWrap: "anywhere" }}>{req.requestNote}</p>
        </div>
        <div style={{ flexGrow: 1 }} />
        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--line)" }}>
          <button type="button" className="sec" onClick={onPutDown}>{t("merge.newRequest")}</button>
        </div>
      </aside>
      <main className="centre">
        <div className="flow">
          <div className="mst" style={{ fontSize: 16 }}>{t("merge.captured", { date: `${dmyIst(req.requestedAt)} ${hmIst(req.requestedAt)}` })}</div>
          <CompareTable
            rows={rows}
            headA={t("merge.headKeeps", { uhid: w.uhid })} headB={t("merge.headClosesUhid", { uhid: l.uhid })}
            capA={t("merge.keeps")} capB={t("merge.closes")} keepA
          />
          {statusLine !== null && (
            <p style={{ margin: "14px 0 0", fontSize: 13 }}><span className="tag">{t("merge.status")}</span> <b data-testid="merge-state">{statusLine}</b></p>
          )}
          {refused && (
            <div className="refuse" role="status" style={{ marginTop: 14 }}>
              <b>{t("merge.refusedTitle")}</b><br />
              {typeof d.decisionNote === "string" && d.decisionNote !== "" && <>“{d.decisionNote}”<br /></>}
              {t("merge.refusedBody")}
            </div>
          )}
          {pending && isOwn && canDecide && (
            <div className="refuse" role="note" style={{ marginTop: 14 }}>
              <b>{t("merge.ownTitle")}</b><br />{t("merge.ownBody")}
            </div>
          )}
          {approverSeat && sealedIds.length > 0 && (
            <div className="note" style={{ marginTop: 14 }}>
              <b>{t("merge.sealed.title")}</b> {t("merge.sealed.approverBody")}
              {glassDone ? (
                <p style={{ margin: "8px 0 0", color: "var(--green)", fontWeight: 600 }}>{t("merge.sealed.recorded")}</p>
              ) : (
                <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input
                    className="search" style={{ flex: 1, minWidth: 180 }} value={glassReason} onChange={(e) => setGlassReason(e.target.value)}
                    aria-label={t("merge.sealed.reasonLabel")} placeholder={t("merge.sealed.reasonLabel")}
                  />
                  <button type="button" className="sec" disabled={glassReason.trim().length < 3 || busy} onClick={() => void breakGlass()}>{t("merge.sealed.record")}</button>
                </div>
              )}
            </div>
          )}
          {approverSeat && (
            <div style={{ marginTop: 14 }}>
              <label className="tag" htmlFor="decision-note" style={{ display: "block", marginBottom: 6 }}>{t("merge.decisionNote")}</label>
              <textarea id="decision-note" className="ta" style={{ minHeight: 48 }} value={decisionNote} placeholder={t("merge.decisionPlaceholder")} onChange={(e) => setDecisionNote(e.target.value)} />
            </div>
          )}
          {req.status === "executed" && <UnmergeBlock requestId={requestId} unmergeApprovalStatus={d.unmergeApprovalStatus} />}
          {error !== null && <div role="alert" className="refuse" style={{ marginTop: 14 }}>{error}</div>}
        </div>
        {approverSeat && (
          <div className="dock">
            <span className="say">{t("merge.approverDock")}</span>
            <button type="button" className="sec rd" disabled={decisionNote.trim() === "" || busy} onClick={() => void decide("reject")}>{t("merge.refuse")}</button>
            <button type="button" className="pri" disabled={decisionNote.trim() === "" || busy || (sealedIds.length > 0 && !glassDone)} onClick={() => void decide("approve")}>
              {decisionNote.trim() === "" ? t("merge.approveNoteFirst") : t("merge.approve")}
            </button>
          </div>
        )}
        {!approverSeat && req.status === "requested" && !refused && (
          <div className="dock">
            <span className="say">{d.approvalStatus === "granted" ? t("merge.runDock") : t("merge.waitDock")}</span>
            <button type="button" className="pri" disabled={d.approvalStatus !== "granted" || busy} onClick={() => void run()}>{t("merge.execute")}</button>
          </div>
        )}
      </main>
    </>
  );
}

// ——— the screen ———

/** `/merge?request=<id>` opens one request — the approvals inbox links a merge card here. */
function requestFromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("request");
  } catch {
    return null;
  }
}

export function MergeReview(): React.ReactElement {
  const { t } = useTranslation();
  const { actor } = useAuth();
  const now = useNow();
  const [requestId, setRequestId] = useState<string | null>(() => requestFromUrl());
  const [drawer, setDrawer] = useState(false);
  const [builderKey, setBuilderKey] = useState(0);

  const list = useQuery({
    queryKey: ["merge-requests"],
    queryFn: () => api<{ items: ListItem[] }>("GET", "/patients/merge-requests").then((r) => r.items),
    refetchInterval: 30_000,
  });
  const counts = useMemo(() => ({
    granted: (list.data ?? []).filter((i) => i.stage === "granted").length,
    waiting: (list.data ?? []).filter((i) => i.stage === "waiting").length,
  }), [list.data]);

  const open = useCallback((id: string): void => { setRequestId(id); setDrawer(false); }, []);
  const putDown = (): void => { setRequestId(null); setBuilderKey((k) => k + 1); };

  return (
    <PaperScreen testId="merge-review">
      <div className="mrg" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        <div style={{ padding: "12px 20px" }}>
          <ScreenTitle
            title={t("merge.title")}
            route="/merge"
            actions={
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {counts.granted > 0 && <span className="pill on">{t("merge.pills.granted", { count: counts.granted })}</span>}
                {counts.waiting > 0 && <span className="pill gd">{t("merge.pills.waiting", { count: counts.waiting })}</span>}
                <button type="button" className="sec drawer-btn" onClick={() => setDrawer((o) => !o)} aria-expanded={drawer}>
                  {t("merge.pills.requests", { count: list.data?.length ?? 0 })}
                </button>
              </span>
            }
          />
        </div>
        <div className="cols">
          {requestId === null
            ? <Builder key={builderKey} list={list.data} onRequested={open} />
            : <RequestView key={requestId} requestId={requestId} onPutDown={putDown} />}
          <RequestsList
            items={list.data} now={now} selectedId={requestId} onOpen={open}
            open={drawer} onClose={() => setDrawer(false)} myId={actor?.id ?? null}
          />
        </div>
      </div>
    </PaperScreen>
  );
}
