import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type React from "react";
import {
  DISMISS_REASONS, dismissMatchItem, fetchReconcileQueue, markLapsedRestoreChecked, membershipErrorMessage,
  resolveMatchItem,
} from "../lib/membership-api";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { StationShell } from "../components/station/station-shell";
import { ageYearsOf } from "./desk-one/model";
import type {
  WireDismissReason, WireFieldMark, WireLapsedRestore, WireMatchCandidate, WireMatchQueueItem, WireMatchStrength,
} from "../lib/membership-api";
import "./instrument-reconcile.css";

/**
 * PLAN 09 T5 — THE RECONCILE QUEUE: everything the holder-book import refused to guess.
 *
 * ═══ UX-AUDIT 2026-09-28 · BOARD — THE SCREEN FOLLOWS ITS APPROVED BOARD ═══
 *
 * `docs/design/2026-09-28-ux-audit/card-reconcile.html` (owner-approved 28-Sep-2026) is the
 * specification. The house station (`StationShell`): the card holder in hand on the left, a numbered
 * compare → choose → link flow in the centre with a pinned bar, one queue oldest first on the right
 * with NEW CARD / CAP OVER / LAPSED RESTORE chips, "Clocks running" folded below.
 *
 * WHAT STILL HOLDS FROM PLAN 09, AND WHAT THE OWNER CHANGED:
 *
 * · NOTHING IS PRE-SELECTED. A radio per patient, none chosen; the one green act names exactly the
 *   card and the UHID it will link, and it is disabled until a person has chosen.
 * · STRENGTH IS A WORD (owner ruling 28-Sep: Strong / Possible / Weak, never a decimal score). This
 *   reverses Plan 09's "show the number, not a band". The band is the SERVER's, worked out from the
 *   fields that agree, and the fields sit beside it — so the person is still comparing people.
 * · A WEAK LINK NEEDS A STATED PROOF AND A CONFIRM. The server refuses it otherwise
 *   (`match_weak_needs_proof`); the proof goes into the resolve call's existing `note`. The proof is
 *   what was SEEN OR HEARD — the screen never asks for an ID number and refuses a 12-digit run,
 *   because Aadhaar is never stored.
 * · "NONE OF THESE…" ASKS WHY, with preset reasons and a line of text.
 * · A LAPSED RESTORE reads in words and dates, and "Mark checked" takes it off the queue. The owner
 *   ruled (money, 28-Sep) that a benefit given back to an ENDED card is usable only once the card is
 *   renewed; the screen says so, and `consumeEntitlements` already refuses an ended counter.
 *
 * NO SALES FIGURE ANYWHERE (E-32), the same rule the counter's recognition screen carries.
 */

/** The member counter's stations that exist today — the same pairs as `router.tsx`'s NAV. */
const MEMBER_STATIONS = [
  { key: "recognise", to: "/counter/instruments", labelKey: "instrumentReconcile.nav.recognise", permission: "membership.instrument.read" },
  { key: "reconcile", to: "/counter/reconcile", labelKey: "instrumentReconcile.nav.reconcile", permission: "membership.reconcile.operate" },
] as const;

const WEAK_PROOFS = ["id_seen", "called_mobile", "partner_corrected"] as const;
type WeakProof = (typeof WEAK_PROOFS)[number];
const LINK_PROOFS = ["details_agree", "id_seen", "called_mobile"] as const;
type LinkProof = (typeof LINK_PROOFS)[number] | "other";

/** A 12-digit run — the shape of an Aadhaar number. A reason says what was seen, never the number. */
const ID_NUMBER = /\d{4}[\s-]?\d{4}[\s-]?\d{4}/;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_OFFSET_MS = 330 * 60 * 1000;

/** A calendar day `YYYY-MM-DD` → `14-Mar-1974`. No timezone arithmetic: the day is already decided. */
function dmy(ymd: string | null): string {
  if (ymd === null) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (m === null) return ymd;
  return `${m[3]}-${MONTHS[Number(m[2]) - 1] ?? ""}-${m[1]}`;
}

/** An instant → its IST calendar day, `27-Sep-2026`. */
function dmyIst(iso: string): string {
  const d = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  if (Number.isNaN(d.getTime())) return "";
  return dmy(d.toISOString());
}

/** Whole days an item has waited: "today", "1 d", "2 d". */
function waited(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86_400_000));
}

type QueueEntry =
  | { key: string; kind: "match"; at: string; item: WireMatchQueueItem }
  | { key: string; kind: "lapsed"; at: string; lapsed: WireLapsedRestore };

function chipOf(e: QueueEntry): "new" | "cap" | "lapsed" {
  if (e.kind === "lapsed") return "lapsed";
  return e.item.reason === "cap_overflow" ? "cap" : "new";
}

const STRENGTH_CLASS: Record<WireMatchStrength, string> = { strong: "rc-pill on", possible: "rc-pill", weak: "rc-pill gd" };

function Mark({ mark }: { mark: WireFieldMark }): React.ReactElement {
  const { t } = useTranslation();
  const glyph = mark === "agrees" ? "✓" : mark === "differs" ? "≠" : "–";
  const cls = mark === "agrees" ? "rc-ok" : mark === "differs" ? "rc-no" : "rc-na";
  return <span className={cls} role="img" aria-label={t(`instrumentReconcile.mark.${mark}`)}>{glyph}</span>;
}

export function InstrumentReconcile(): React.ReactElement {
  const { t } = useTranslation();
  const { username } = useAuth();
  const qc = useQueryClient();
  const queue = useQuery({ queryKey: ["membership", "reconcile"], queryFn: fetchReconcileQueue });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [autoPicked, setAutoPicked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  const entries = useMemo<QueueEntry[]>(() => {
    const items = (queue.data?.items ?? []).map((item): QueueEntry => ({ key: `q:${item.id}`, kind: "match", at: item.at, item }));
    const lapsed = (queue.data?.lapsedRestores ?? []).map((l): QueueEntry => ({ key: `l:${l.movementId}`, kind: "lapsed", at: l.at, lapsed: l }));
    // ONE queue, oldest first — the board's rule; a lapsed restore joins it rather than a second list.
    return [...items, ...lapsed].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }, [queue.data]);

  // The queue is worked oldest first, so the oldest opens by itself once; Esc puts it back.
  useEffect(() => {
    if (autoPicked || queue.data === undefined) return;
    setAutoPicked(true);
    if (entries.length > 0) setSelectedKey(entries[0]!.key);
  }, [autoPicked, queue.data, entries]);

  const current = entries.find((e) => e.key === selectedKey) ?? null;

  const afterDecision = async (): Promise<void> => {
    setError(null);
    const idx = entries.findIndex((e) => e.key === selectedKey);
    const next = entries[idx + 1] ?? entries[idx - 1] ?? null;
    setSelectedKey(next?.key ?? null);
    await qc.invalidateQueries({ queryKey: ["membership", "reconcile"] });
  };

  const oldestDays = entries.length > 0 ? waited(entries[0]!.at, now) : 0;
  const ageText = (days: number): string => (days === 0 ? t("instrumentReconcile.today") : t("instrumentReconcile.days", { n: days }));
  const clocks = entries.filter((e) => waited(e.at, now) >= 1);

  const list = (
    <section className="rc-box rc-queue" data-testid="worklist">
      <div className="rc-qhead">
        <span className="tag rc-qtitle">{t("instrumentReconcile.queueTitle", { n: entries.length })}</span>
        <span className="rc-note">{t("instrumentReconcile.oldestFirst")}</span>
      </div>
      {queue.data !== undefined && entries.length === 0 && (
        <p className="rc-empty">{t("instrumentReconcile.empty")}</p>
      )}
      {entries.map((e) => {
        const chip = chipOf(e);
        const name = e.kind === "match" ? e.item.holder.subjectName : e.lapsed.holderName;
        const days = waited(e.at, now);
        return (
          <button
            key={e.key}
            type="button"
            className={`rc-row${e.key === selectedKey ? " sel" : ""}`}
            aria-current={e.key === selectedKey ? "true" : undefined}
            data-testid={`row-${e.kind === "match" ? e.item.cardCode : e.lapsed.cardCode}`}
            onClick={() => { setSelectedKey(e.key); setError(null); }}
          >
            <span className={`rc-src${chip === "lapsed" ? " lp" : ""}`}>{t(`instrumentReconcile.chip.${chip}`)}</span>
            <span className="rc-rowtext">
              <b>{name}</b>
              <small>{rowSubtitle(t, e)}</small>
            </span>
            <span className="mo rc-note rc-age">{ageText(days)}</span>
          </button>
        );
      })}
    </section>
  );

  const inHand = current !== null;
  const holderPlace = current === null ? t("instrumentReconcile.place")
    : current.kind === "lapsed" ? t("instrumentReconcile.lapsedPlace")
    : `${current.item.planTitle} · ${current.item.memberId === null ? t("instrumentReconcile.holder") : (current.item.holder.relation ?? t("instrumentReconcile.member"))}`;

  return (
    <StationShell
      brand={t("instrumentReconcile.brand")}
      stations={MEMBER_STATIONS.map((s) => ({ key: s.key, to: s.to, permission: s.permission, label: t(s.labelKey) }))}
      current="reconcile"
      title={current === null ? t("instrumentReconcile.title")
        : current.kind === "match" ? current.item.holder.subjectName : current.lapsed.holderName}
      place={holderPlace}
      stats={inHand ? [] : [
        { label: t("instrumentReconcile.statWaiting"), value: entries.length, tone: entries.length > 0 ? "waiting" : "plain" },
        { label: t("instrumentReconcile.statOldest"), value: entries.length > 0 ? ageText(oldestDays) : "–" },
      ]}
      statsLabel={t("instrumentReconcile.stats")}
      views={entries.length > 0 ? (
        <span className="rc-pill gd rc-headpill" data-testid="queue-pill">
          {t("instrumentReconcile.waitingPill", { n: entries.length, age: ageText(oldestDays) })}
        </span>
      ) : undefined}
      inHand={inHand}
      lane={current === null ? undefined : <Lane entry={current} onPutBack={() => setSelectedKey(null)} />}
      list={list}
      clocks={clocks.length === 0 ? <p className="rc-note">{t("instrumentReconcile.clocksNone")}</p> : (
        <ul className="rc-clocks">
          {clocks.map((e) => (
            <li key={e.key}>
              <span>{e.kind === "match" ? e.item.holder.subjectName : e.lapsed.holderName}</span>
              <b className="mo">{ageText(waited(e.at, now))}</b>
            </li>
          ))}
        </ul>
      )}
      clocksSummary={clocks.length === 0 ? t("instrumentReconcile.clocksNone")
        : t("instrumentReconcile.clocksSummary", { n: clocks.length, age: ageText(oldestDays) })}
    >
      <div className="rc" data-testid="reconcile">
        {error !== null && <p role="alert" data-testid="reconcile-error" className="rc-error">{error}</p>}
        {queue.data !== undefined && current === null && (
          <div className="rc-idle">
            <p>{entries.length === 0 ? t("instrumentReconcile.empty") : t("instrumentReconcile.pick")}</p>
            <p className="rc-note" data-testid="never-links">{t("instrumentReconcile.neverLinks")}</p>
          </div>
        )}
        {current?.kind === "match" && current.item.reason !== "cap_overflow" && (
          <MatchFlow
            key={current.key}
            item={current.item}
            username={username ?? ""}
            onDone={afterDecision}
            onError={setError}
            onPutBack={() => setSelectedKey(null)}
          />
        )}
        {current?.kind === "match" && current.item.reason === "cap_overflow" && (
          <CapFlow key={current.key} item={current.item} username={username ?? ""} onDone={afterDecision} onError={setError} />
        )}
        {current?.kind === "lapsed" && (
          <LapsedFlow key={current.key} lapsed={current.lapsed} onDone={afterDecision} onError={setError} />
        )}
      </div>
    </StationShell>
  );
}

function rowSubtitle(t: (k: string, o?: Record<string, unknown>) => string, e: QueueEntry): string {
  if (e.kind === "lapsed") return t("instrumentReconcile.rowLapsed", { benefit: e.lapsed.benefitTitle });
  const item = e.item;
  if (item.reason === "cap_overflow") {
    return t("instrumentReconcile.rowCap", { code: item.cardCode, n: item.holder.members.length, cap: item.holder.familyCap });
  }
  const n = item.candidates.length;
  return `${item.cardCode} · ${n === 0 ? t("instrumentReconcile.nobodyAlike") : t("instrumentReconcile.alike", { count: n })}`;
}

/** The card in hand: the left lane. */
function Lane({ entry, onPutBack }: { entry: QueueEntry; onPutBack: () => void }): React.ReactElement {
  const { t } = useTranslation();
  if (entry.kind === "lapsed") {
    const l = entry.lapsed;
    return (
      <div className="rc-lane" data-testid="lane">
        <div className="rc-chipline"><span className="rc-src lp">{t("instrumentReconcile.chip.lapsed")}</span><span className="mo rc-note">{t("instrumentReconcile.card", { code: l.cardCode })}</span></div>
        <div className="rc-fact"><span>{t("instrumentReconcile.cardEnded")}</span><span className="mo">{dmyIst(l.cardEndedOn)}</span></div>
        <div className="rc-fact"><span>{t("instrumentReconcile.givenBackOn")}</span><span className="mo">{dmyIst(l.at)}</span></div>
        <LaneFoot onPutBack={onPutBack} />
      </div>
    );
  }
  const item = entry.item;
  const h = item.holder;
  const chip = chipOf(entry);
  return (
    <div className="rc-lane" data-testid="lane">
      <div className="rc-chipline"><span className="rc-src">{t(`instrumentReconcile.chip.${chip}`)}</span><span className="mo rc-note">{t("instrumentReconcile.card", { code: item.cardCode })}</span></div>
      {h.partnerName !== null && <div className="rc-fact"><span>{t("instrumentReconcile.partner")}</span><span>{h.partnerName}</span></div>}
      <div className="rc-fact"><span>{t("instrumentReconcile.valid")}</span><span className="mo">{dmyIst(h.validFrom)} – {dmyIst(h.validTo)}</span></div>
      <div className="rc-fact"><span>{t("instrumentReconcile.cardMobile")}</span><span className="mo">{h.mobileMasked ?? t("instrumentReconcile.notOnCard")}</span></div>
      {h.cameIn !== null && (
        <div className="rc-fact"><span>{t("instrumentReconcile.cameIn")}</span><span>{t("instrumentReconcile.holderBook", { on: dmyIst(h.cameIn.on) })}</span></div>
      )}
      <div className="rc-lanemore">
      {h.members.length > 0 && (
        <>
          <div className="tag rc-lanetag">{t("instrumentReconcile.onThisCard")}</div>
          {h.members.map((m) => (
            <div key={m.memberNo} className="rc-fact">
              <span>{m.memberNo} · {m.name}</span>
              <span>{m.honoured ? (m.relation ?? "") : t("instrumentReconcile.overCap")}</span>
            </div>
          ))}
        </>
      )}
      <div className="tag rc-lanetag">{t("instrumentReconcile.whyHere")}</div>
      <p className="rc-why">
        {item.reason === "cap_overflow"
          ? t("instrumentReconcile.whyCap")
          : t("instrumentReconcile.whyFuzzy", { count: item.candidates.length })}
      </p>
      {item.note !== null && <p className="rc-note" data-testid={`note-${item.cardCode}`}>{item.note}</p>}
      {item.reason !== "cap_overflow" && <p className="rc-note">{t("instrumentReconcile.mobileProvesNothing")}</p>}
      </div>
      <LaneFoot onPutBack={onPutBack} />
    </div>
  );
}

function LaneFoot({ onPutBack }: { onPutBack: () => void }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <button type="button" className="rc-lanefoot" onClick={onPutBack} data-testid="put-back">
      <span className="kb">Esc</span>{t("instrumentReconcile.putBack")}
    </button>
  );
}

/** Keys A / N / Esc while no dialog is open and nobody is typing. */
function useKeys(enabled: boolean, keys: Record<string, (() => void) | undefined>): void {
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const fn = keys[e.key.length === 1 ? e.key.toLowerCase() : e.key];
      if (fn !== undefined) { e.preventDefault(); fn(); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });
}

function MatchFlow({
  item, username, onDone, onError, onPutBack,
}: {
  item: WireMatchQueueItem; username: string; onDone: () => Promise<void>; onError: (m: string | null) => void; onPutBack: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string | null>(null);
  const [proof, setProof] = useState<LinkProof | null>(null);
  const [proofText, setProofText] = useState("");
  const [dialog, setDialog] = useState<"weak" | "none" | null>(null);
  const pick = item.candidates.find((c) => c.patientId === chosen) ?? null;
  const name = item.holder.subjectName;

  const link = useMutation({
    mutationFn: resolveMatchItem,
    onSuccess: async () => { setDialog(null); await onDone(); },
    onError: (e: unknown) => { onError(membershipErrorMessage(e)); },
  });

  const noteFor = (): string | undefined => {
    if (proof === null) return undefined;
    const text = proofText.trim();
    if (proof === "other") return text === "" ? undefined : text;
    return text === "" ? t(`instrumentReconcile.proof.${proof}`) : `${t(`instrumentReconcile.proof.${proof}`)} — ${text}`;
  };
  const idTyped = ID_NUMBER.test(proofText);

  const pressLink = (): void => {
    if (pick === null || link.isPending || idTyped) return;
    if (pick.comparison.strength === "weak") { setDialog("weak"); return; }
    link.mutate({ queueItemId: item.id, patientId: pick.patientId, note: noteFor() });
  };

  useKeys(dialog === null, { a: pressLink, n: () => setDialog("none"), Escape: onPutBack });

  return (
    <div className="rc-flow">
      <div className="rc-scroll">
        <div className="rc-h">
          <h1>{t("instrumentReconcile.whoIs", { name })}</h1>
          <span>{t("instrumentReconcile.flowHint")}</span>
        </div>

        <Step n={1} done>{t("instrumentReconcile.step1")}</Step>
        {item.candidates.length === 0 ? (
          <p className="rc-stepbody">{t("instrumentReconcile.noCandidates")}</p>
        ) : (
          <>
            <CompareGrid item={item} chosen={chosen} onChoose={setChosen} />
            <CompareCards item={item} chosen={chosen} onChoose={setChosen} />
          </>
        )}

        <Step n={2} done={chosen !== null}>{t("instrumentReconcile.step2")}</Step>
        <p className="rc-stepbody" data-testid="chosen-line">
          {t("instrumentReconcile.nothingChosen")}{" "}
          {pick !== null && (
            <>{t("instrumentReconcile.youChose")} <b>{pick.patientName} · UHID {pick.uhid}</b>. </>
          )}
          {t("instrumentReconcile.noneHint")}
        </p>

        {item.candidates.length > 0 && (
          <>
            <Step n={3} done={proof !== null}>
              {t("instrumentReconcile.step3")} <span className="rc-light">{t("instrumentReconcile.step3Optional")}</span>
            </Step>
            <div className="rc-stepbody rc-pills" role="radiogroup" aria-label={t("instrumentReconcile.step3")}>
              {[...LINK_PROOFS, "other" as const].map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={proof === p}
                  className={`rc-pill rc-choice${proof === p ? " on" : ""}`}
                  onClick={() => setProof(proof === p ? null : p)}
                >
                  {t(`instrumentReconcile.proof.${p}`)}
                </button>
              ))}
            </div>
            {proof !== null && (
              <div className="rc-stepbody">
                <input
                  className="rc-field"
                  aria-label={t("instrumentReconcile.proofLine")}
                  placeholder={t("instrumentReconcile.proofPlaceholder")}
                  value={proofText}
                  maxLength={300}
                  onChange={(e) => setProofText(e.target.value)}
                />
                {idTyped && <p className="rc-warn" role="alert">{t("instrumentReconcile.noIdNumbers")}</p>}
              </div>
            )}
          </>
        )}
      </div>

      <div className="rc-bar" data-testid="action-bar">
        <div className="rc-bartext">
          <div className="rc-barmain" data-testid="bar-says">
            {pick === null
              ? t("instrumentReconcile.barChoose")
              : t("instrumentReconcile.barLink", { code: item.cardCode, name: pick.patientName, uhid: pick.uhid })}
          </div>
          <div className="rc-note">{t("instrumentReconcile.barPermanent", { user: username })}</div>
        </div>
        <button type="button" className="rc-sec" onClick={() => setDialog("none")} data-testid="none-of-these">
          {t("instrumentReconcile.noneOfThese")} <span className="kb">N</span>
        </button>
        <button
          type="button"
          className="rc-pri"
          disabled={pick === null || link.isPending || idTyped}
          onClick={pressLink}
          data-testid="link"
        >
          {t("instrumentReconcile.linkThisCard")} <span className="kb">A</span>
        </button>
      </div>

      {dialog === "weak" && pick !== null && (
        <WeakDialog
          pick={pick}
          holderName={name}
          pending={link.isPending}
          onBack={() => setDialog(null)}
          onLink={(note) => link.mutate({ queueItemId: item.id, patientId: pick.patientId, note, confirmWeak: true })}
        />
      )}
      {dialog === "none" && (
        <DismissDialog
          title={t("instrumentReconcile.nobodyHere", { name })}
          reasons={DISMISS_REASONS}
          username={username}
          queueItemId={item.id}
          onBack={() => setDialog(null)}
          onDone={onDone}
          onError={onError}
        />
      )}
    </div>
  );
}

function Step({ n, done, children }: { n: number; done: boolean; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="rc-step">
      <span className={`rc-n${done ? " done" : ""}`}>{n}</span>
      <h3>{children}</h3>
    </div>
  );
}

/** The board's two lines: `52 y` over `14-Mar-1974`. */
function AgeDob({ dob }: { dob: string }): React.ReactElement {
  const age = ageYearsOf(dob);
  return <span className="mo rc-agedob">{age === null ? null : <>{age} y<br /></>}{dmy(dob)}</span>;
}

function sexWord(t: (k: string) => string, sex: string | null): string {
  if (sex === null) return "";
  return ["male", "female", "other"].includes(sex) ? t(`instrumentReconcile.sex.${sex}`) : sex;
}

/** The side-by-side (desktop and tablet): the card in one column, each patient in the next. */
function CompareGrid({
  item, chosen, onChoose,
}: { item: WireMatchQueueItem; chosen: string | null; onChoose: (id: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const cs = item.candidates;
  const cols = { gridTemplateColumns: `104px 150px repeat(${cs.length}, minmax(150px, 1fr))` };
  const cell = (c: WireMatchCandidate, extra = ""): string => `${c.patientId === chosen ? "c1 " : ""}${extra}`;
  const notOnCard = <><span className="rc-na">–</span><span className="rc-note">{t("instrumentReconcile.notOnCard")}</span></>;
  const h = item.holder;
  const row = (label: string, card: React.ReactNode, each: (c: WireMatchCandidate) => React.ReactNode): React.ReactNode => (
    <>
      <div className="k">{label}</div>
      <div className="h">{card}</div>
      {cs.map((c) => <div key={c.patientId} className={cell(c)}>{each(c)}</div>)}
    </>
  );
  return (
    <div className="rc-box rc-cmpwrap" data-testid="compare">
      <div className="rc-cmp" style={cols} role="radiogroup" aria-label={t("instrumentReconcile.step1")}>
        <div className="k top" />
        <div className="h top"><span className="tag">{t("instrumentReconcile.theCard")}</span></div>
        {cs.map((c) => (
          <label key={c.patientId} className={cell(c, "top rc-head")} data-testid={`candidate-${c.patientId}`}>
            <span className="rc-radioline">
              <input
                type="radio"
                name={`pick-${item.id}`}
                checked={c.patientId === chosen}
                onChange={() => onChoose(c.patientId)}
                data-testid={`choose-${c.patientId}`}
              />
              <b>{c.patientName}</b>
            </span>
            <span className="mo rc-uhid">UHID {c.uhid}</span>
            <span className={STRENGTH_CLASS[c.comparison.strength]} data-testid={`strength-${c.patientId}`}>
              {t(`instrumentReconcile.strength.${c.comparison.strength}`)}
            </span>
          </label>
        ))}
        {row(t("instrumentReconcile.f.name"), h.subjectName, (c) => <><Mark mark={c.comparison.name} />{c.patientName}</>)}
        {row(t("instrumentReconcile.f.dob"), h.dob === null ? notOnCard : <AgeDob dob={h.dob} />,
          (c) => <><Mark mark={c.comparison.dob} />{c.dob === null ? t("instrumentReconcile.notOnRecord") : <AgeDob dob={c.dob} />}</>)}
        {row(t("instrumentReconcile.f.sex"), h.sex === null ? notOnCard : sexWord(t, h.sex),
          (c) => <><Mark mark={c.comparison.sex} />{c.sex === null ? t("instrumentReconcile.notOnRecord") : sexWord(t, c.sex)}</>)}
        {row(t("instrumentReconcile.f.mobile"), h.mobileMasked === null ? notOnCard : <span className="mo">{h.mobileMasked}</span>,
          (c) => <><Mark mark={c.comparison.mobile} /><span className="mo">{c.mobileMasked ?? t("instrumentReconcile.notOnRecord")}</span></>)}
        {row(t("instrumentReconcile.f.district"), notOnCard,
          (c) => <><span className="rc-na">–</span>{c.district ?? ""}</>)}
        {row(t("instrumentReconcile.f.lastVisit"), null,
          (c) => (c.lastVisit === null ? <span className="rc-note">{t("instrumentReconcile.noVisit")}</span>
            : <span>{dmy(c.lastVisit.on)}{c.lastVisit.department === null ? "" : ` · ${c.lastVisit.department}`}</span>))}
        {row(t("instrumentReconcile.f.agrees"), null, (c) => (
          <b className={`rc-count ${c.comparison.strength}`} data-testid={`agrees-${c.patientId}`}>
            {t("instrumentReconcile.nOf4", { n: c.comparison.agrees })}
          </b>
        ))}
      </div>
    </div>
  );
}

/** The phone: one patient per card, the same marks, the same radio. */
function CompareCards({
  item, chosen, onChoose,
}: { item: WireMatchQueueItem; chosen: string | null; onChoose: (id: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="rc-cards" role="radiogroup" aria-label={t("instrumentReconcile.step1")}>
      {item.candidates.map((c) => {
        const age = ageYearsOf(c.dob);
        return (
          <label key={c.patientId} className={`rc-box rc-card${c.patientId === chosen ? " sel" : ""}`}>
            <span className="rc-radioline">
              <input type="radio" name={`pickm-${item.id}`} checked={c.patientId === chosen} onChange={() => onChoose(c.patientId)} />
              <b className="rc-grow">{c.patientName}</b>
              <span className={STRENGTH_CLASS[c.comparison.strength]}>{t(`instrumentReconcile.strengthShort.${c.comparison.strength}`)}</span>
            </span>
            <span className="mo rc-note rc-cardsub">
              UHID {c.uhid}
              {c.lastVisit !== null ? ` · ${t("instrumentReconcile.lastVisitShort", { on: dmy(c.lastVisit.on) })}` : c.district !== null ? ` · ${c.district}` : ""}
            </span>
            <span className="rc-marks">
              <span><Mark mark={c.comparison.name} />{t("instrumentReconcile.f.name")}</span>
              <span><Mark mark={c.comparison.dob} />{age === null ? t("instrumentReconcile.f.dob") : `${age} y`}</span>
              <span><Mark mark={c.comparison.sex} />{c.sex === null ? t("instrumentReconcile.f.sex") : sexWord(t, c.sex)}</span>
              <span><Mark mark={c.comparison.mobile} />{t("instrumentReconcile.f.mobile")}</span>
            </span>
            <span className="rc-note">{t("instrumentReconcile.nOf4", { n: c.comparison.agrees })}</span>
          </label>
        );
      })}
    </div>
  );
}

function Dialog({ label, children, foot }: { label: string; children: React.ReactNode; foot: React.ReactNode }): React.ReactElement {
  return (
    <div className="rc-scrim">
      <div className="rc-dialog" role="dialog" aria-modal="true" aria-label={label}>
        <div className="rc-dbody">{children}</div>
        <div className="rc-dfoot">{foot}</div>
      </div>
    </div>
  );
}

function WeakDialog({
  pick, holderName, pending, onBack, onLink,
}: {
  pick: WireMatchCandidate; holderName: string; pending: boolean; onBack: () => void; onLink: (note: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [proof, setProof] = useState<WeakProof | null>(null);
  const [text, setText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const cmp = pick.comparison;
  const fields = (["name", "dob", "sex", "mobile"] as const);
  const differs = fields.filter((f) => cmp[f] === "differs").map((f) => t(`instrumentReconcile.fLower.${f}`));
  const idTyped = ID_NUMBER.test(text);
  const ready = proof !== null && confirmed && !idTyped && !pending;
  const note = proof === null ? "" : text.trim() === "" ? t(`instrumentReconcile.weakProof.${proof}`) : `${t(`instrumentReconcile.weakProof.${proof}`)} — ${text.trim()}`;
  useEffect(() => {
    const on = (e: KeyboardEvent): void => { if (e.key === "Escape") onBack(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onBack]);
  return (
    <Dialog
      label={t("instrumentReconcile.weakTitle")}
      foot={(
        <>
          <span className="rc-note rc-grow">{t("instrumentReconcile.reasonSaved")}</span>
          <button type="button" className="rc-sec" onClick={onBack}>{t("instrumentReconcile.back")}</button>
          <button type="button" className="rc-pri" disabled={!ready} onClick={() => onLink(note)} data-testid="link-anyway">
            {t("instrumentReconcile.linkAnyway")} <span className="kb">A</span>
          </button>
        </>
      )}
    >
      <div className="rc-radioline">
        <b>{pick.patientName} · UHID {pick.uhid}</b>
        <span className="rc-pill gd">{t("instrumentReconcile.strength.weak")}</span>
      </div>
      <div className="rc-warnbox" data-testid="weak-differs">
        <b>{t("instrumentReconcile.weakCount", { n: 4 - cmp.agrees })}</b>{" "}
        {differs.length > 0 && t("instrumentReconcile.weakDiffers", { fields: differs.join(", ") })}{" "}
        {cmp.mobile === "agrees" && t("instrumentReconcile.weakMobile")}{" "}
        {t("instrumentReconcile.weakWouldPut", { name: holderName })}
      </div>
      <div className="tag rc-dtag">{t("instrumentReconcile.howKnow")}</div>
      <div className="rc-radios" role="radiogroup" aria-label={t("instrumentReconcile.howKnow")}>
        {WEAK_PROOFS.map((p) => (
          <label key={p}>
            <input type="radio" name="weak-proof" checked={proof === p} onChange={() => setProof(p)} data-testid={`weak-${p}`} />
            {t(`instrumentReconcile.weakProof.${p}`)}
          </label>
        ))}
      </div>
      <input
        className="rc-field"
        aria-label={t("instrumentReconcile.proofLine")}
        placeholder={t("instrumentReconcile.proofPlaceholder")}
        value={text}
        maxLength={300}
        onChange={(e) => setText(e.target.value)}
      />
      {idTyped && <p className="rc-warn" role="alert">{t("instrumentReconcile.noIdNumbers")}</p>}
      <label className="rc-check">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="weak-confirm" />
        {t("instrumentReconcile.weakConfirm")}
      </label>
    </Dialog>
  );
}

function DismissDialog({
  title, reasons, username, queueItemId, onBack, onDone, onError,
}: {
  title: string; reasons: readonly WireDismissReason[]; username: string; queueItemId: string;
  onBack: () => void; onDone: () => Promise<void>; onError: (m: string | null) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [reason, setReason] = useState<WireDismissReason | null>(null);
  const [note, setNote] = useState("");
  const dismiss = useMutation({
    mutationFn: dismissMatchItem,
    onSuccess: async () => { await onDone(); },
    onError: (e: unknown) => { onError(membershipErrorMessage(e)); },
  });
  const idTyped = ID_NUMBER.test(note);
  const ready = reason !== null && (reason !== "other" || note.trim() !== "") && !idTyped && !dismiss.isPending;
  useEffect(() => {
    const on = (e: KeyboardEvent): void => { if (e.key === "Escape") onBack(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onBack]);
  return (
    <Dialog
      label={title}
      foot={(
        <>
          <span className="rc-note rc-grow">{t("instrumentReconcile.recordedAgainst", { user: username })}</span>
          <button type="button" className="rc-sec" onClick={onBack}>{t("instrumentReconcile.back")}</button>
          <button
            type="button"
            className="rc-pri"
            disabled={!ready}
            data-testid="confirm-dismiss"
            onClick={() => {
              if (reason === null) return;
              const trimmed = note.trim();
              dismiss.mutate({ queueItemId, reason, ...(trimmed === "" ? {} : { note: trimmed }) });
            }}
          >
            {t("instrumentReconcile.dismissWithReason")}
          </button>
        </>
      )}
    >
      <b className="rc-dtitle">{title}</b>
      <div className="tag rc-dtag">{t("instrumentReconcile.whyRequired")}</div>
      <div className="rc-radios" role="radiogroup" aria-label={t("instrumentReconcile.whyRequired")}>
        {reasons.map((r) => (
          <label key={r}>
            <input type="radio" name="dismiss-reason" checked={reason === r} onChange={() => setReason(r)} data-testid={`dismiss-${r}`} />
            {t(`instrumentReconcile.dismissReason.${r}`)}
          </label>
        ))}
      </div>
      <input
        className="rc-field"
        aria-label={t("instrumentReconcile.dismissNote")}
        placeholder={t("instrumentReconcile.dismissPlaceholder")}
        value={note}
        maxLength={300}
        onChange={(e) => setNote(e.target.value)}
      />
      {idTyped && <p className="rc-warn" role="alert">{t("instrumentReconcile.noIdNumbers")}</p>}
      <p className="rc-note rc-dafter">{t("instrumentReconcile.staysUnlinked")}</p>
    </Dialog>
  );
}

/** CAP OVER: more people than the plan covers. Nothing to link; the partner is called, then it is closed. */
function CapFlow({
  item, username, onDone, onError,
}: { item: WireMatchQueueItem; username: string; onDone: () => Promise<void>; onError: (m: string | null) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const over = item.holder.members.filter((m) => !m.honoured);
  useKeys(!open, { n: () => setOpen(true) });
  return (
    <div className="rc-flow">
      <div className="rc-scroll">
        <div className="rc-h">
          <h1>{t("instrumentReconcile.capTitle", { n: item.holder.members.length, cap: item.holder.familyCap })}</h1>
        </div>
        <p className="rc-stepbody rc-flush">{t("instrumentReconcile.capWhy")}</p>
        {over.length > 0 && (
          <div className="rc-box rc-plain">
            <div className="tag">{t("instrumentReconcile.capOver")}</div>
            {over.map((m) => (
              <div key={m.memberNo} className="rc-fact"><span>{m.memberNo} · {m.name}</span><span>{m.relation ?? ""}</span></div>
            ))}
          </div>
        )}
      </div>
      <div className="rc-bar">
        <div className="rc-bartext">
          <div className="rc-barmain">{t("instrumentReconcile.capBar")}</div>
          <div className="rc-note">{t("instrumentReconcile.recordedAgainst", { user: username })}</div>
        </div>
        <button type="button" className="rc-pri" onClick={() => setOpen(true)} data-testid="cap-close">
          {t("instrumentReconcile.capClose")} <span className="kb">N</span>
        </button>
      </div>
      {open && (
        <DismissDialog
          title={t("instrumentReconcile.capDialog")}
          reasons={["partner_file_wrong", "other"]}
          username={username}
          queueItemId={item.id}
          onBack={() => setOpen(false)}
          onDone={onDone}
          onError={onError}
        />
      )}
    </div>
  );
}

/** LAPSED RESTORE: a fact to check, in words and dates, and one act — Mark checked. */
function LapsedFlow({
  lapsed, onDone, onError,
}: { lapsed: WireLapsedRestore; onDone: () => Promise<void>; onError: (m: string | null) => void }): React.ReactElement {
  const { t } = useTranslation();
  const check = useMutation({
    mutationFn: markLapsedRestoreChecked,
    onSuccess: async () => { await onDone(); },
    onError: (e: unknown) => { onError(membershipErrorMessage(e)); },
  });
  const press = (): void => { if (!check.isPending) check.mutate({ movementId: lapsed.movementId }); };
  useKeys(true, { a: press });
  return (
    <div className="rc-flow" data-testid={`lapsed-${lapsed.cardCode}`}>
      <div className="rc-scroll">
        <div className="rc-h"><h1>{t("instrumentReconcile.lapsedTitle", { name: lapsed.holderName })}</h1></div>
        <div className="rc-box rc-plain rc-lapsed">
          <div className="rc-chipline"><span className="rc-src lp">{t("instrumentReconcile.chip.lapsed")}</span><span className="mo rc-note">{t("instrumentReconcile.card", { code: lapsed.cardCode })}</span></div>
          <b className="rc-lname">{lapsed.holderName}</b>
          <div className="rc-fact"><span>{t("instrumentReconcile.benefitGivenBack")}</span><span data-testid="lapsed-benefit">{lapsed.benefitTitle}</span></div>
          <div className="rc-fact"><span>{t("instrumentReconcile.givenBackOn")}</span><span className="mo">{dmyIst(lapsed.at)} · {fmtIst(lapsed.at)}</span></div>
          <div className="rc-fact"><span>{t("instrumentReconcile.cardEnded")}</span><span className="mo">{dmyIst(lapsed.cardEndedOn)}</span></div>
          <div className="rc-fact"><span>{t("instrumentReconcile.bill")}</span><span className="mo" data-testid="lapsed-bill">{lapsed.invoiceNo ?? t("instrumentReconcile.noBill")}</span></div>
          <div className="rc-fact"><span>{t("instrumentReconcile.givenBackBy")}</span><span>{lapsed.givenBackBy}</span></div>
          {lapsed.givenBackReason !== null && (
            <div className="rc-fact"><span>{t("instrumentReconcile.givenBackWhy")}</span><span>{lapsed.givenBackReason}</span></div>
          )}
          <p className="rc-why">{t("instrumentReconcile.lapsedWhy", { benefit: lapsed.benefitTitle })}</p>
          <p className="rc-why" data-testid="lapsed-ruling"><b>{t("instrumentReconcile.lapsedRuling")}</b></p>
        </div>
      </div>
      <div className="rc-bar">
        <div className="rc-bartext">
          <div className="rc-barmain">{t("instrumentReconcile.lapsedBar")}</div>
          <div className="rc-note">{t("instrumentReconcile.lapsedBarNote")}</div>
        </div>
        <button type="button" className="rc-pri" disabled={check.isPending} onClick={press} data-testid="mark-checked">
          {t("instrumentReconcile.markChecked")} <span className="kb">A</span>
        </button>
      </div>
    </div>
  );
}
