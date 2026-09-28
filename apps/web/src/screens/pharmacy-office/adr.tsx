import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ADR_CAUSALITY, ADR_CHALLENGE, ADR_CHANNELS, ADR_MANAGE, ADR_OUTCOMES, ADR_RECORD, ADR_SERIOUSNESS,
  addAdrEvent, fetchAdr, fetchAdrDocument, fetchAdrList, isSerious, recordAdr, suggestAdrSalts,
} from "../../lib/adr-api";
import { newIdempotencyKey } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { searchPatients } from "../../lib/patients-api";
import { pharmacyErrorText } from "../../lib/pharmacy-api";
import { printInFrame } from "../../lib/print-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "./sheet";
import type {
  AdrCausality, AdrChallenge, AdrChannel, AdrEventBody, AdrOutcome, AdrSeriousness, WireAdrDetail, WireAdrPatient, WireAdrRow,
} from "../../lib/adr-api";
import type { WirePatientHit } from "../../lib/patients-api";

/**
 * ═══ PHARMACY STAGE D1 — THE ADVERSE DRUG REACTION REGISTER (an office page under Law) ═══
 *
 * The register, newest first, with each report's state read off its events: not yet sent to PvPI (a
 * serious one turns red after PvPI's 15 days), sent, closed. The record sheet is the PvPI Suspected ADR
 * Reporting Form's fields; every suspected medicine picked from the formulary writes a coded allergy in
 * the same transaction, which is what makes the next prescription of that moiety refuse. A manager
 * (`pharmacy.adr.manage`) records the WHO-UMC causality, the send to PvPI and the close; anybody who may
 * read the register prints the form.
 *
 * Built on the office's legacy-side primitives (shadcn + the paper-and-pine palette) so it renders under
 * the office frame's `.pof-legacy` without a second reset.
 */
const DAY = 86_400_000;
const SERIOUS_DAYS = 15;
const todayIso = (): string => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const daysSince = (iso: string): number => Math.max(0, Math.floor((Date.parse(todayIso()) - Date.parse(new Date(Date.parse(iso) + 5.5 * 3600_000).toISOString().slice(0, 10))) / DAY));

export function patientLabel(p: WireAdrPatient | null, t: TFunction): string {
  if (p === null) return t("pharmacyOffice.adr.patientHidden");
  const who = p.restricted ? (p.alias ?? t("pharmacyOffice.adr.patientHidden")) : (p.name ?? "");
  return `${who} · ${p.uhid}`;
}

/** The report's state as one pill: closed, sent, or waiting on PvPI (red once a serious one is past 15 days). */
export function statePill(r: WireAdrRow, t: TFunction): { cls: string; text: string } {
  if (r.state.closed) return { cls: "pill", text: t("pharmacyOffice.adr.state.closed") };
  if (r.state.sentOn !== null) return { cls: "pill on", text: t("pharmacyOffice.adr.state.sent", { date: r.state.sentOn }) };
  const ago = daysSince(r.createdAt);
  if (isSerious(r.seriousness) && ago > SERIOUS_DAYS) return { cls: "pill rd", text: t("pharmacyOffice.adr.state.late", { days: ago - SERIOUS_DAYS }) };
  if (isSerious(r.seriousness)) return { cls: "pill gd", text: t("pharmacyOffice.adr.state.due", { days: SERIOUS_DAYS - ago }) };
  return { cls: "pill", text: t("pharmacyOffice.adr.state.toSend") };
}

export function AdrRegisterView(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["pharmacy", "adr"], queryFn: () => fetchAdrList() });
  const [selected, setSelected] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const items = q.data?.items ?? [];
  const open = items.filter((r) => r.state.sentOn === null && !r.state.closed).length;
  const first = q.data?.items[0]?.id ?? null;
  useEffect(() => { if (selected === null && first !== null) setSelected(first); }, [first, selected]);

  return (
    <div className="space-y-4" data-testid="adr-view">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{t("pharmacyOffice.adr.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("pharmacyOffice.adr.lead", { count: open })}</p>
        </div>
        {can(ADR_RECORD) && <Button type="button" data-testid="adr-record-open" onClick={() => setRecording(true)}>{t("pharmacyOffice.adr.report")}</Button>}
      </div>
      {q.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(q.error, t)}</p>}
      {notice !== null && <p role="status" className="text-sm text-green-700" data-testid="adr-notice">{notice}</p>}
      {q.data !== undefined && items.length === 0 && <p className="text-sm text-muted-foreground" data-testid="adr-empty">{t("pharmacyOffice.adr.empty")}</p>}
      {items.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <ul className="divide-y rounded border" data-testid="adr-list">
            {items.map((r) => {
              const pill = statePill(r, t);
              return (
                <li key={r.id}>
                  <button
                    type="button" data-testid={`adr-row-${r.no}`} aria-current={selected === r.id ? "true" : undefined}
                    className={`flex w-full flex-col gap-1 px-3 py-2 text-left ${selected === r.id ? "bg-emerald-50/60" : "hover:bg-muted/50"}`}
                    onClick={() => setSelected(r.id)}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs">{r.no}</span>
                      <span className={isSerious(r.seriousness) ? "pill rd" : "pill"}>{t(`pharmacyOffice.adr.seriousness.${r.seriousness}`)}</span>
                      <span className={pill.cls} data-testid={`adr-state-${r.no}`}>{pill.text}</span>
                    </span>
                    <span className="truncate text-sm font-medium">{r.suspects.join(" · ")}</span>
                    <span className="truncate text-xs text-muted-foreground">{patientLabel(r.patient, t)} · {t("pharmacyOffice.adr.onset", { date: r.onsetDate })}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {selected !== null && <AdrDetailPanel id={selected} canManage={can(ADR_MANAGE)} />}
        </div>
      )}
      {recording && (
        <Sheet title={t("pharmacyOffice.adr.report")} testId="adr-record-sheet" onClose={() => setRecording(false)}>
          <AdrRecordForm onDone={(no, id) => { setRecording(false); setSelected(id); setNotice(t("pharmacyOffice.adr.recorded", { no })); }} />
        </Sheet>
      )}
    </div>
  );
}

function AdrDetailPanel({ id, canManage }: { id: string; canManage: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["pharmacy", "adr", id], queryFn: () => fetchAdr(id) });
  const [error, setError] = useState<string | null>(null);
  const print = async (): Promise<void> => {
    setError(null);
    try { if (!printInFrame(await fetchAdrDocument(id))) setError(t("pharmacyOffice.sheet.printFailed")); } catch (e) { setError(pharmacyErrorText(e, t)); }
  };
  const a = q.data;
  if (q.error !== null) return <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(q.error, t)}</p>;
  if (a === undefined) return <div className="text-sm text-muted-foreground">…</div>;
  return (
    <section className="min-w-0 space-y-3 rounded border p-3" data-testid="adr-detail">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 font-semibold">{a.no} · {patientLabel(a.patient, t)}</h3>
        <Button type="button" variant="outline" data-testid="adr-print" onClick={() => void print()}>{t("pharmacyOffice.adr.print")}</Button>
      </div>
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <p className="whitespace-pre-wrap text-sm" data-testid="adr-reaction">{a.reaction}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <Fact k={t("pharmacyOffice.adr.f.onset")} v={a.onsetDate} />
        <Fact k={t("pharmacyOffice.adr.f.recovery")} v={a.recoveryDate ?? "—"} />
        <Fact k={t("pharmacyOffice.adr.f.seriousness")} v={t(`pharmacyOffice.adr.seriousness.${a.seriousness}`)} />
        <Fact k={t("pharmacyOffice.adr.f.outcome")} v={t(`pharmacyOffice.adr.outcome.${a.outcome}`)} />
        <Fact k={t("pharmacyOffice.adr.f.dechallenge")} v={t(`pharmacyOffice.adr.challenge.${a.dechallenge}`)} />
        <Fact k={t("pharmacyOffice.adr.f.rechallenge")} v={t(`pharmacyOffice.adr.challenge.${a.rechallenge}`)} />
        <Fact k={t("pharmacyOffice.adr.f.reporter")} v={a.reportedByCode} />
        <Fact k={t("pharmacyOffice.adr.f.causality")} v={a.state.causality === null ? "—" : t(`pharmacyOffice.adr.causality.${a.state.causality}`)} />
      </dl>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="adr-suspects">
          <thead><tr className="text-left text-xs text-muted-foreground">
            <th className="py-1 pr-2">{t("pharmacyOffice.adr.f.drug")}</th><th className="py-1 pr-2">{t("pharmacyOffice.adr.f.batch")}</th>
            <th className="py-1 pr-2">{t("pharmacyOffice.adr.f.dose")}</th><th className="py-1 pr-2">{t("pharmacyOffice.adr.f.dates")}</th>
          </tr></thead>
          <tbody>
            {a.suspectLines.map((s) => (
              <tr key={s.position} className="border-t">
                <td className="py-1 pr-2">{s.name}{s.saltId === null ? "" : " ✓"}</td><td className="py-1 pr-2">{s.batchNo ?? ""}</td>
                <td className="py-1 pr-2">{[s.dose, s.route, s.frequency].filter((x) => x !== null).join(" · ")}</td>
                <td className="py-1 pr-2">{[s.startDate, s.stopDate].filter((x) => x !== null).join(" – ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{t("pharmacyOffice.adr.allergyNote")}</p>
      {a.events.length > 0 && (
        <ol className="space-y-1 text-sm" data-testid="adr-events">
          {a.events.map((e) => <li key={e.id}>• {eventText(e, t)} <span className="text-xs text-muted-foreground">{e.recordedByCode} · {e.recordedAt.slice(0, 10)}</span></li>)}
        </ol>
      )}
      {canManage && !a.state.closed && <AdrActions a={a} />}
    </section>
  );
}

function Fact({ k, v }: { k: string; v: string }): React.ReactElement {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="truncate">{v}</dd></div>;
}

function eventText(e: WireAdrDetail["events"][number], t: TFunction): string {
  if (e.kind === "causality_assessed") return t("pharmacyOffice.adr.ev.causality", { grade: t(`pharmacyOffice.adr.causality.${e.causality ?? "unclassifiable"}`) });
  if (e.kind === "sent_to_pvpi") return t("pharmacyOffice.adr.ev.sent", { date: e.sentOn ?? "", channel: t(`pharmacyOffice.adr.channel.${e.channel ?? "amc"}`), ref: e.pvpiRef ?? "—" });
  return e.note === null ? t("pharmacyOffice.adr.ev.closed") : t("pharmacyOffice.adr.ev.closedNote", { note: e.note });
}

const selectCls = "h-9 w-full rounded-md border bg-background px-2 text-sm";

function AdrActions({ a }: { a: WireAdrDetail }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [causality, setCausality] = useState<AdrCausality>((a.state.causality as AdrCausality | null) ?? "possible");
  const [sentOn, setSentOn] = useState(todayIso());
  const [channel, setChannel] = useState<AdrChannel>("amc");
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: (body: AdrEventBody) => addAdrEvent(a.id, body),
    onSuccess: async () => { setNote(""); await qc.invalidateQueries({ queryKey: ["pharmacy", "adr"] }); },
  });
  return (
    <div className="space-y-3 border-t pt-3" data-testid="adr-actions">
      <form className="grid items-end gap-2 sm:grid-cols-[1fr_auto]" onSubmit={(e) => { e.preventDefault(); m.mutate({ kind: "causality_assessed", causality }); }}>
        <label className="text-sm">{t("pharmacyOffice.adr.act.causality")}
          <select className={selectCls} data-testid="adr-causality" value={causality} onChange={(e) => setCausality(e.target.value as AdrCausality)}>
            {ADR_CAUSALITY.map((c) => <option key={c} value={c}>{t(`pharmacyOffice.adr.causality.${c}`)}</option>)}
          </select>
        </label>
        <Button type="submit" variant="outline" data-testid="adr-causality-save" disabled={m.isPending}>{t("pharmacyOffice.adr.act.save")}</Button>
      </form>
      {a.state.sentOn === null && (
        <form className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]" onSubmit={(e) => { e.preventDefault(); m.mutate({ kind: "sent_to_pvpi", sentOn, channel, pvpiRef: ref.trim() === "" ? null : ref.trim() }); }}>
          <label className="text-sm">{t("pharmacyOffice.adr.act.sentOn")}
            <Input type="date" data-testid="adr-sent-on" value={sentOn} max={todayIso()} onChange={(e) => setSentOn(e.target.value)} />
          </label>
          <label className="text-sm">{t("pharmacyOffice.adr.act.channel")}
            <select className={selectCls} data-testid="adr-channel" value={channel} onChange={(e) => setChannel(e.target.value as AdrChannel)}>
              {ADR_CHANNELS.map((c) => <option key={c} value={c}>{t(`pharmacyOffice.adr.channel.${c}`)}</option>)}
            </select>
          </label>
          <label className="text-sm">{t("pharmacyOffice.adr.act.ref")}
            <Input data-testid="adr-ref" autoComplete="off" value={ref} onChange={(e) => setRef(e.target.value)} />
          </label>
          <Button type="submit" data-testid="adr-sent-save" disabled={m.isPending || sentOn === ""}>{t("pharmacyOffice.adr.act.sent")}</Button>
        </form>
      )}
      <form className="grid items-end gap-2 sm:grid-cols-[1fr_auto]" onSubmit={(e) => { e.preventDefault(); m.mutate({ kind: "closed", note: note.trim() === "" ? null : note.trim() }); }}>
        <label className="text-sm">{a.state.sentOn === null ? t("pharmacyOffice.adr.act.closeWhy") : t("pharmacyOffice.adr.act.closeNote")}
          <Input data-testid="adr-close-note" autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <Button type="submit" variant="outline" data-testid="adr-close" disabled={m.isPending || (a.state.sentOn === null && note.trim() === "")}>{t("pharmacyOffice.adr.act.close")}</Button>
      </form>
      {m.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(m.error, t)}</p>}
    </div>
  );
}

type SuspectDraft = { saltId: string | null; saltName: string | null; name: string; batchNo: string; dose: string; route: string; frequency: string; startDate: string; stopDate: string };
const blankSuspect = (): SuspectDraft => ({ saltId: null, saltName: null, name: "", batchNo: "", dose: "", route: "", frequency: "", startDate: "", stopDate: "" });
const orNull = (s: string): string | null => (s.trim() === "" ? null : s.trim());

/**
 * Stage D1 deferral — the pharmacy desk opens this sheet for the patient in hand, and, from a line, with
 * that line's medicine (and its batch, once picked) as the first suspect. Everything stays editable.
 */
export type AdrPrefill = {
  patient: Pick<WirePatientHit, "id" | "uhid" | "name">;
  suspect?: { name: string; batchNo: string | null };
};

export function AdrRecordForm({ prefill, onDone }: { prefill?: AdrPrefill; onDone: (no: string, id: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [key] = useState(() => newIdempotencyKey());
  const [patientQ, setPatientQ] = useState("");
  const [hits, setHits] = useState<WirePatientHit[]>([]);
  const [patient, setPatient] = useState<Pick<WirePatientHit, "id" | "uhid" | "name"> | null>(prefill?.patient ?? null);
  const [suspects, setSuspects] = useState<SuspectDraft[]>(() => [
    prefill?.suspect === undefined ? blankSuspect() : { ...blankSuspect(), name: prefill.suspect.name, batchNo: prefill.suspect.batchNo ?? "" },
  ]);
  const [reaction, setReaction] = useState("");
  const [onsetDate, setOnset] = useState(todayIso());
  const [recoveryDate, setRecovery] = useState("");
  const [seriousness, setSeriousness] = useState<AdrSeriousness>("not_serious");
  const [outcome, setOutcome] = useState<AdrOutcome>("recovering");
  const [dechallenge, setDechallenge] = useState<AdrChallenge>("unknown");
  const [rechallenge, setRechallenge] = useState<AdrChallenge>("na");
  const [weight, setWeight] = useState("");
  const [concomitants, setConcomitants] = useState("");
  const [tests, setTests] = useState("");
  const [history, setHistory] = useState("");

  const [findError, setFindError] = useState<string | null>(null);
  const findPatient = async (): Promise<void> => {
    if (patientQ.trim().length < 2) return;
    setFindError(null);
    try { setHits(await searchPatients(patientQ.trim(), 6)); } catch (e) { setHits([]); setFindError(pharmacyErrorText(e, t)); }
  };
  const put = (i: number, patch: Partial<SuspectDraft>): void => setSuspects((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const m = useMutation({
    mutationFn: () => recordAdr({
      patientId: patient!.id, reaction: reaction.trim(), onsetDate, recoveryDate: orNull(recoveryDate),
      seriousness, outcome, dechallenge, rechallenge, weightKg: weight.trim() === "" ? null : Number(weight),
      suspects: suspects.map((s) => ({
        saltId: s.saltId, name: orNull(s.name) ?? s.saltName, batchNo: orNull(s.batchNo), dose: orNull(s.dose), route: orNull(s.route),
        frequency: orNull(s.frequency), startDate: orNull(s.startDate), stopDate: orNull(s.stopDate),
      })),
      concomitants: concomitants.split("\n").map((l) => l.trim()).filter((l) => l !== "").map((name) => ({ name })),
      relevantTests: orNull(tests), relevantHistory: orNull(history),
    }, key),
    onSuccess: async (out) => { await qc.invalidateQueries({ queryKey: ["pharmacy", "adr"] }); onDone(out.no, out.reportId); },
  });

  const ready = patient !== null && reaction.trim() !== "" && onsetDate !== "" && suspects.every((s) => s.saltId !== null || s.name.trim() !== "");

  return (
    <form className="space-y-4" data-testid="adr-record-form" onSubmit={(e) => { e.preventDefault(); if (ready) m.mutate(); }}>
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">{t("pharmacyOffice.adr.form.patient")}</legend>
        {patient === null ? (
          <>
            <div className="flex gap-2">
              <Input data-testid="adr-patient-q" autoComplete="off" placeholder={t("pharmacyOffice.adr.form.patientFind")} value={patientQ}
                onChange={(e) => setPatientQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void findPatient(); } }} />
              <Button type="button" variant="outline" data-testid="adr-patient-find" onClick={() => void findPatient()}>{t("pharmacyOffice.adr.form.find")}</Button>
            </div>
            {findError !== null && <p role="alert" className="text-sm text-red-600">{findError}</p>}
            <ul className="divide-y rounded border empty:hidden">
              {hits.map((h) => (
                <li key={h.id}><button type="button" data-testid={`adr-patient-${h.uhid}`} className="w-full px-3 py-2 text-left text-sm hover:bg-muted/50" onClick={() => setPatient(h)}>{h.name} · {h.uhid}</button></li>
              ))}
            </ul>
          </>
        ) : (
          <div className="flex items-center gap-2 text-sm" data-testid="adr-patient-picked">
            <span className="font-medium">{patient.name} · {patient.uhid}</span>
            <button type="button" className="text-xs underline" onClick={() => setPatient(null)}>{t("pharmacyOffice.adr.form.change")}</button>
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">{t("pharmacyOffice.adr.form.suspects")}</legend>
        <p className="text-xs text-muted-foreground">{t("pharmacyOffice.adr.form.suspectsHint")}</p>
        {suspects.map((s, i) => <SuspectRow key={i} i={i} s={s} put={put} />)}
        {suspects.length < 10 && (
          <Button type="button" variant="outline" data-testid="adr-suspect-add" onClick={() => setSuspects((xs) => [...xs, blankSuspect()])}>{t("pharmacyOffice.adr.form.addSuspect")}</Button>
        )}
      </fieldset>

      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-semibold">{t("pharmacyOffice.adr.form.reaction")}</legend>
        <label className="text-sm sm:col-span-2">{t("pharmacyOffice.adr.form.describe")}
          <textarea data-testid="adr-reaction-text" className="min-h-20 w-full rounded-md border bg-background p-2 text-sm" value={reaction} onChange={(e) => setReaction(e.target.value)} />
        </label>
        <label className="text-sm">{t("pharmacyOffice.adr.f.onset")}<Input type="date" data-testid="adr-onset" value={onsetDate} max={todayIso()} onChange={(e) => setOnset(e.target.value)} /></label>
        <label className="text-sm">{t("pharmacyOffice.adr.f.recovery")}<Input type="date" data-testid="adr-recovery" value={recoveryDate} max={todayIso()} onChange={(e) => setRecovery(e.target.value)} /></label>
        <Choice label={t("pharmacyOffice.adr.f.seriousness")} testId="adr-seriousness" value={seriousness} options={ADR_SERIOUSNESS} ns="seriousness" onChange={(v) => setSeriousness(v as AdrSeriousness)} />
        <Choice label={t("pharmacyOffice.adr.f.outcome")} testId="adr-outcome" value={outcome} options={ADR_OUTCOMES} ns="outcome" onChange={(v) => setOutcome(v as AdrOutcome)} />
        <Choice label={t("pharmacyOffice.adr.f.dechallenge")} testId="adr-dechallenge" value={dechallenge} options={ADR_CHALLENGE} ns="challenge" onChange={(v) => setDechallenge(v as AdrChallenge)} />
        <Choice label={t("pharmacyOffice.adr.f.rechallenge")} testId="adr-rechallenge" value={rechallenge} options={ADR_CHALLENGE} ns="challenge" onChange={(v) => setRechallenge(v as AdrChallenge)} />
      </fieldset>

      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-semibold">{t("pharmacyOffice.adr.form.more")}</legend>
        <label className="text-sm">{t("pharmacyOffice.adr.form.weight")}<Input inputMode="decimal" data-testid="adr-weight" value={weight} onChange={(e) => setWeight(e.target.value)} /></label>
        <label className="text-sm">{t("pharmacyOffice.adr.form.concomitants")}
          <textarea data-testid="adr-concomitants" className="min-h-16 w-full rounded-md border bg-background p-2 text-sm" value={concomitants} onChange={(e) => setConcomitants(e.target.value)} />
        </label>
        <label className="text-sm">{t("pharmacyOffice.adr.form.tests")}<textarea className="min-h-16 w-full rounded-md border bg-background p-2 text-sm" value={tests} onChange={(e) => setTests(e.target.value)} /></label>
        <label className="text-sm">{t("pharmacyOffice.adr.form.history")}<textarea className="min-h-16 w-full rounded-md border bg-background p-2 text-sm" value={history} onChange={(e) => setHistory(e.target.value)} /></label>
      </fieldset>

      {m.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(m.error, t)}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" data-testid="adr-record-save" disabled={!ready || m.isPending}>{t("pharmacyOffice.adr.form.save")}</Button>
        <span className="text-xs text-muted-foreground">{t("pharmacyOffice.adr.form.saveHint")}</span>
      </div>
    </form>
  );
}

function Choice({ label, testId, value, options, ns, onChange }: {
  label: string; testId: string; value: string; options: readonly string[]; ns: string; onChange: (v: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <label className="text-sm">{label}
      <select className={selectCls} data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{t(`pharmacyOffice.adr.${ns}.${o}`)}</option>)}
      </select>
    </label>
  );
}

function SuspectRow({ i, s, put }: { i: number; s: SuspectDraft; put: (i: number, patch: Partial<SuspectDraft>) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    let live = true;
    const h = setTimeout(() => { void suggestAdrSalts(q.trim()).then((r) => { if (live) setHits(r.items); }).catch(() => { if (live) setHits([]); }); }, 200);
    return () => { live = false; clearTimeout(h); };
  }, [q]);
  return (
    <div className="space-y-2 rounded border p-2" data-testid={`adr-suspect-${String(i)}`}>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-sm">{t("pharmacyOffice.adr.form.moiety")}
          {s.saltId === null ? (
            <>
              <Input data-testid={`adr-salt-q-${String(i)}`} autoComplete="off" placeholder={t("pharmacyOffice.adr.form.moietyFind")} value={q} onChange={(e) => setQ(e.target.value)} />
              {hits.length > 0 && (
                <ul className="mt-1 divide-y rounded border">
                  {hits.map((h) => (
                    <li key={h.id}><button type="button" data-testid={`adr-salt-${String(i)}-${h.name}`} className="w-full px-2 py-1 text-left text-sm hover:bg-muted/50"
                      onClick={() => { put(i, { saltId: h.id, saltName: h.name }); setHits([]); setQ(""); }}>{h.name}</button></li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <span className="flex items-center gap-2 py-2" data-testid={`adr-salt-picked-${String(i)}`}>
              <span className="pill on">{s.saltName}</span>
              <button type="button" className="text-xs underline" onClick={() => put(i, { saltId: null, saltName: null })}>{t("pharmacyOffice.adr.form.change")}</button>
            </span>
          )}
        </label>
        <label className="text-sm">{t("pharmacyOffice.adr.form.brand")}<Input data-testid={`adr-brand-${String(i)}`} autoComplete="off" value={s.name} onChange={(e) => put(i, { name: e.target.value })} /></label>
      </div>
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <label className="text-sm">{t("pharmacyOffice.adr.f.batch")}<Input autoComplete="off" value={s.batchNo} onChange={(e) => put(i, { batchNo: e.target.value })} /></label>
        <label className="text-sm">{t("pharmacyOffice.adr.f.dose")}<Input autoComplete="off" value={s.dose} onChange={(e) => put(i, { dose: e.target.value })} /></label>
        <label className="text-sm">{t("pharmacyOffice.adr.form.route")}<Input autoComplete="off" value={s.route} onChange={(e) => put(i, { route: e.target.value })} /></label>
        <label className="text-sm">{t("pharmacyOffice.adr.form.frequency")}<Input autoComplete="off" value={s.frequency} onChange={(e) => put(i, { frequency: e.target.value })} /></label>
        <label className="text-sm">{t("pharmacyOffice.adr.form.started")}<Input type="date" value={s.startDate} onChange={(e) => put(i, { startDate: e.target.value })} /></label>
        <label className="text-sm">{t("pharmacyOffice.adr.form.stopped")}<Input type="date" value={s.stopDate} onChange={(e) => put(i, { stopDate: e.target.value })} /></label>
      </div>
    </div>
  );
}
