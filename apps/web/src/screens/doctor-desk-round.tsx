import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useParams, useRouter } from "@tanstack/react-router";
import { useAuth } from "../lib/auth";
import { deskErrorText, fetchWardRound } from "../lib/doctor-desk-api";
import type { WireWardRound } from "../lib/doctor-desk-api";
import { roundQueue } from "../lib/round-queue";
import type { QueuedNote } from "../lib/round-queue";
import { whenText } from "./doctor-desk-tower";
import "../components/doctor-desk/phone.css";
import "./doctor-desk-ward.css";

/**
 * ═══ #962 (plan DD-IPD.4) — ROUND, one bed, the phone (`docs/design/2026-09-18-doctor-desk/Round.dc.html`) ═══
 *
 * "Since you last saw" — every line a row somebody entered, with its source (IPD's `changesSince`, from MY last round);
 * the vitals strip with the early-warning score; the round note and Sign. The note is IPD's own act (`POST
 * /ipd/rounds/sign`) — the Desk writes nothing — and it SAVES ON THE PHONE FIRST (`lib/round-queue.ts`): the client id is
 * the idempotency key, so a replay lands once; each note shows when it was signed and when it reached the server.
 *
 * The board's dark header bar is re-skinned light with an ink edge (R13). ABSENT in part 1, never drawn empty: OWED ON
 * THIS BED and tasks to a named resident (part 2), "Pull today's vitals + labs in". No money (decision 0058).
 */
type T = (k: string, o?: Record<string, unknown>) => string;

/** The IST calendar date of an instant ("2026-03-10"), for `whenText`'s "today" test. */
export function istDateOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

type NoteLine = { key: string; signedAt: string; syncedAt: string | null; state: "synced" | "queued" | "conflict"; error: string | null; text: string | null };

/** The server's notes and the phone's, one line per note (a synced phone note IS a server row: matched by round id). */
export function noteLines(mine: WireWardRound["mine"], local: readonly QueuedNote[]): NoteLine[] {
  const known = new Set(mine.map((m) => m.roundId));
  const lines: NoteLine[] = mine.map((m) => {
    const phone = local.find((n) => n.roundId === m.roundId);
    return { key: m.roundId, signedAt: m.signedAt, syncedAt: m.syncedAt, state: "synced", error: null, text: phone?.soap.assessment ?? null };
  });
  for (const n of local) {
    if (n.roundId !== null && known.has(n.roundId)) continue;
    lines.push({
      key: n.clientId, signedAt: n.signedAt, syncedAt: n.syncedAt, state: n.status, error: n.error, text: n.soap.assessment ?? null,
    });
  }
  return lines.sort((a, b) => b.signedAt.localeCompare(a.signedAt));
}

function vitalCells(v: NonNullable<WireWardRound["vitals"]>, t: T): { k: string; v: string; hot: boolean }[] {
  const out = [
    { k: t("doctorDesk.ward.v.bp"), v: v.bp ?? "—", hot: false },
    { k: t("doctorDesk.ward.v.pulse"), v: v.pulse === null ? "—" : String(v.pulse), hot: v.pulse !== null && (v.pulse > 110 || v.pulse < 50) },
    { k: t("doctorDesk.ward.v.temp"), v: v.temperatureC === null ? "—" : v.temperatureC.toFixed(1), hot: v.temperatureC !== null && v.temperatureC >= 38 },
    { k: t("doctorDesk.ward.v.spo2"), v: v.spo2 === null ? "—" : String(v.spo2), hot: v.spo2 !== null && v.spo2 < 92 },
  ];
  out.push({
    k: v.ews === null ? t("doctorDesk.ward.v.ews") : v.ews.kind.toUpperCase(),
    v: v.ews === null ? "—" : String(v.ews.value),
    hot: v.ews !== null && (v.ews.band === "high" || v.ews.band === "medium"),
  });
  return out;
}

export function DoctorDeskRound(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const params = useParams({ strict: false }) as { admissionId?: string };
  const admissionId = params.admissionId ?? "";
  const q = useQuery({ queryKey: ["doctor-desk", "ward", "round", admissionId], queryFn: () => fetchWardRound(admissionId), enabled: admissionId !== "", refetchInterval: 60_000 });
  const v = q.data;
  return (
    <div className="ddp" data-testid="doctor-desk-round">
      <div className="ddp-col">
        <RoundBar v={v} />
        <div className="ddp-scroll">
          {q.isPending && <p className="ddp-dim">{t("doctorDesk.loading")}</p>}
          {q.isError && <p role="alert" className="dd-alert">{deskErrorText(q.error, t)}</p>}
          {v !== undefined && <RoundBody v={v} lang={i18n.language} />}
        </div>
        {v !== undefined && <Walk v={v} />}
      </div>
    </div>
  );
}

function RoundBar({ v }: { v: WireWardRound | undefined }): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter({ warn: false });
  return (
    <div className="ddw-bar-top">
      <a href="/doctor-desk/beds" className="ddw-back" data-testid="dd-round-back" onClick={(e) => { if (router === undefined) return; e.preventDefault(); void router.navigate({ to: "/doctor-desk/beds" }); }}>
        {t("doctorDesk.ward.back")}
      </a>
      <span className="ddw-bar-mid">{v === undefined || v.position.of === 0 ? t("doctorDesk.ward.roundWord") : t("doctorDesk.ward.roundOf", { i: v.position.index, n: v.position.of })}</span>
      <span className="ddw-bar-r">{t("doctorDesk.ward.savedOnPhone")}</span>
    </div>
  );
}

function RoundBody({ v, lang }: { v: WireWardRound; lang: string }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const day = istDateOf(v.at);
  const header = [
    v.dx, t("doctorDesk.ward.day", { n: v.dayOfStay }),
    v.unitName === null ? null : t("doctorDesk.ward.under", { unit: v.unitName, who: v.consultantName ?? "" }),
    v.allergies.length === 0 ? null : t("doctorDesk.ward.allergy", { list: v.allergies.join(", ") }),
  ].filter((x): x is string => x !== null && x !== "");
  return (
    <>
      <div className="ddp-head">
        <h1 className="ddp-h1" data-testid="dd-round-name">
          {v.patient.name ?? t("doctorDesk.patientSealed")}
          {v.ageSex !== null && <span className="ddw-h1-age"> · {v.ageSex}</span>}
        </h1>
        {v.bedCode !== null && <span className="ddw-bed-big">{v.bedCode}</span>}
      </div>
      <div className="ddp-sub" data-testid="dd-round-sub">{header.join(" · ")}</div>

      <section className="ddp-list" data-testid="dd-round-since">
        <div className="ddw-eyebrow-row ddp-eyebrow">
          {v.since === null ? t("doctorDesk.ward.sinceAdmission") : t("doctorDesk.ward.sinceSaw", { at: whenText(v.since, day, lang) })}
        </div>
        {v.changes.length === 0 && <div className="ddp-empty" data-testid="dd-round-nochange">{t("doctorDesk.ward.nothingSince")}</div>}
        {v.changes.map((c) => (
          <div key={c.key} className="ddw-line" data-testid={`dd-since-${c.key}`}>
            <div className={`ddw-line-t${c.abnormal ? " ddp-red" : ""}`}>{c.text}</div>
            <div className="ddp-li-s">
              {t(`doctorDesk.ward.source.${c.source}`, { defaultValue: c.source })}
              {c.at !== null ? ` · ${whenText(c.at, day, lang)}` : ""}
              {c.records.length > 0 ? ` · ${c.records.slice(-2).map((r) => r.label).join("; ")}` : ""}
            </div>
          </div>
        ))}
        <div className="ddp-empty">{t("doctorDesk.ward.everyLine")}</div>
      </section>

      {v.vitals !== null && (
        <div className="ddw-vitals" data-testid="dd-round-vitals" title={t("doctorDesk.ward.vitalsAt", { at: whenText(v.vitals.observedAt, day, lang) })}>
          {vitalCells(v.vitals, t).map((c) => (
            <div key={c.k} className="ddw-vital">
              <span className="ddw-vital-k">{c.k}</span>
              <span className={`ddw-vital-v${c.hot ? " ddp-red" : ""}`}>{c.v}</span>
            </div>
          ))}
        </div>
      )}

      {can("ipd.round.sign") ? <NoteCard v={v} lang={lang} /> : <Mine v={v} local={[]} lang={lang} />}
    </>
  );
}

function NoteCard({ v, lang }: { v: WireWardRound; lang: string }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<QueuedNote[]>([]);
  const refresh = useCallback(async () => {
    try { setLocal(await roundQueue().list(v.admissionId)); } catch { /* the phone store refused: the note still sends while open */ }
  }, [v.admissionId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const again = (): void => { void roundQueue().replay().then(refresh).then(() => qc.invalidateQueries({ queryKey: ["doctor-desk", "ward"] })); };
    globalThis.addEventListener?.("online", again);
    return () => globalThis.removeEventListener?.("online", again);
  }, [refresh, qc]);
  const sign = async (): Promise<void> => {
    const words = text.trim();
    if (words === "") return;
    setBusy(true);
    try {
      await roundQueue().sign({ admissionId: v.admissionId, mode: "bedside", soap: { assessment: words } });
      setText("");
      await refresh();
      await qc.invalidateQueries({ queryKey: ["doctor-desk", "ward"] });
    } finally { setBusy(false); }
  };
  return (
    <>
      <section className="ddp-card" data-testid="dd-round-note">
        <div className="ddp-head">
          <label htmlFor="dd-round-text" className="ddp-eyebrow ddw-label">{t("doctorDesk.ward.noteLabel")}</label>
          <span className="ddp-li-s">{t("doctorDesk.ward.youWrite")}</span>
        </div>
        <textarea
          id="dd-round-text" className="ddw-text" rows={3} maxLength={2000} value={text} data-testid="dd-round-text"
          placeholder={t("doctorDesk.ward.notePlaceholder")} onChange={(e) => setText(e.target.value)}
        />
        <div className="ddw-note-btns">
          <button type="button" className="ddp-btn ddp-btn-ink" data-testid="dd-round-sign" disabled={busy || text.trim() === ""} onClick={() => { void sign(); }}>
            {t("doctorDesk.ward.sign")}
          </button>
        </div>
      </section>
      <Mine v={v} local={local} lang={lang} />
    </>
  );
}

function Mine({ v, local, lang }: { v: WireWardRound; local: readonly QueuedNote[]; lang: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const lines = noteLines(v.mine, local);
  if (lines.length === 0) return null;
  const day = istDateOf(v.at);
  return (
    <section className="ddp-list" data-testid="dd-round-mine">
      <div className="ddw-eyebrow-row ddp-eyebrow">{t("doctorDesk.ward.myNotes")}</div>
      {lines.map((n) => (
        <div key={n.key} className="ddw-line" data-testid={`dd-note-${n.key}`} data-state={n.state}>
          {n.text !== null && <div className="ddw-line-t">{n.text}</div>}
          <div className={`ddp-li-s${n.state === "conflict" ? " ddp-red" : n.state === "queued" ? " ddp-amber" : ""}`}>
            {t("doctorDesk.ward.signedAt", { at: whenText(n.signedAt, day, lang) })}
            {" · "}
            {n.state === "synced" && n.syncedAt !== null ? t("doctorDesk.ward.syncedAt", { at: whenText(n.syncedAt, day, lang) })
              : n.state === "queued" ? t("doctorDesk.ward.waiting")
                : t("doctorDesk.ward.conflict", { code: n.error ?? "" })}
          </div>
        </div>
      ))}
    </section>
  );
}

function Walk({ v }: { v: WireWardRound }): React.ReactElement | null {
  const { t } = useTranslation();
  const router = useRouter({ warn: false });
  if (v.prev === null && v.next === null) return null;
  const go = (e: React.MouseEvent, id: string): void => { if (router === undefined) return; e.preventDefault(); void router.navigate({ to: `/doctor-desk/round/${id}` }); };
  return (
    <nav className="ddw-walk" aria-label={t("doctorDesk.ward.walkLabel")}>
      {v.prev !== null ? (
        <a href={`/doctor-desk/round/${v.prev.admissionId}`} className="ddw-walk-a" data-testid="dd-round-prev" onClick={(e) => go(e, v.prev!.admissionId)}>
          <span className="ddw-walk-k">{t("doctorDesk.ward.prev")}</span>
          <span className="ddw-walk-t">{v.prev.bedCode} {v.prev.name ?? ""}</span>
        </a>
      ) : <span />}
      {v.next !== null ? (
        <a href={`/doctor-desk/round/${v.next.admissionId}`} className="ddw-walk-a ddw-walk-next" data-testid="dd-round-next" onClick={(e) => go(e, v.next!.admissionId)}>
          <span className="ddw-walk-k">{t("doctorDesk.ward.next")}</span>
          <span className="ddw-walk-t">{v.next.bedCode} {v.next.name ?? ""}</span>
        </a>
      ) : <span />}
    </nav>
  );
}

