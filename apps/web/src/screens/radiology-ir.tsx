import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type React from "react";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { checkInStudy, radiologyErrorCode, radiologyErrorText, startAcquisition } from "../lib/radiology-api";
import { fetchRoomView, sendAcquired } from "../lib/radiology-room-api";
import {
  draftInstructions, fetchIrCase, fetchIrCases, fmtFluoro, irHandoff, irOverrideCoagulation, irRecordNote, irRecordVitals,
  irSignIn, irSignOut, irSkinFollowUp, irTimeOut, karLevel, parseFluoro, suggestedSkinCheck,
} from "../lib/radiology-ir-api";
import type { IrNext, IrPhase, IrSedationPlan, WireIrCase, WireIrRow } from "../lib/radiology-ir-api";
import { RoomRefusal } from "../components/radiology/room-console";
import { useNow } from "../components/radiology/imaging-counter";
import { RadiologyStation } from "./radiology-station";

/**
 * PLAN 18-S RS12b — **THE IR SUITE: a header view of the Rooms station (`/radiology/room?view=ir`).**
 *
 * The board's `room:ir`. Right = the suite's ONE list (booked → on the table → sent and not yet
 * handed to recovery; STAT first) with "Clocks running" folded under it (a sedation reading due,
 * a STAT waiting). Left = the patient in hand. Centre = the case: the WHO phases as forms (Sign in
 * → Time out → the procedure → Sign out), the coagulation card with its dates, the sedation chart
 * with its five-minute clock, the live dose tiles (fluoro time, DAP, Ka,r) with the 3 Gy / 5 Gy
 * alerts, then the procedure note and the recovery hand-off in English and Hindi.
 *
 * ONE next act sits in the dock and Enter runs it; the server decides every rule (the checklist,
 * the coagulation window, the fasting hours, the Ka,r triggers) and its refusal is shown in its own
 * words with the seat that fixes it. Opening a booked patient from the list checks them in — no
 * presence button.
 */

const field = "w-full rounded border bg-background px-2 py-1 text-sm";
const num = (v: string): number | null => (v.trim() === "" || Number.isNaN(Number(v)) ? null : Number(v));
const lines = (v: string): string[] => v.split(/\n|,/).map((x) => x.trim()).filter((x) => x !== "");
/** `datetime-local` (read as IST) → ISO with the +05:30 offset the server compares against its clock. */
const istLocalToIso = (v: string): string | undefined => (v === "" ? undefined : `${v}:00+05:30`);

function useGo(): (study: string | undefined) => void {
  const router = useRouter({ warn: false });
  return (study) => {
    if (!router) return;
    void router.navigate({ to: "/radiology/room", search: { view: "ir", study } });
  };
}

export function IrSuiteView({ views, studyId }: { views: React.ReactNode; studyId: string | null }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const go = useGo();
  const now = useNow();
  const [openError, setOpenError] = useState<string | null>(null);
  const listQ = useQuery({ queryKey: ["radiology", "ir-cases"], queryFn: fetchIrCases, refetchInterval: 30_000 });
  const rows = listQ.data?.rows ?? [];
  const inHand = rows.find((r) => r.studyId === studyId) ?? null;

  const open = async (r: WireIrRow): Promise<void> => {
    setOpenError(null);
    go(r.studyId);
    if (r.status === "scheduled") {
      try { await checkInStudy(r.studyId); } catch (e) { setOpenError(radiologyErrorText(e)); }
      void qc.invalidateQueries({ queryKey: ["radiology", "ir-cases"] });
      void qc.invalidateQueries({ queryKey: ["radiology", "ir", r.studyId] });
    }
  };
  const clear = (): void => go(undefined);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape" && studyId !== null) clear(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const dueRows = rows.filter((r) => r.status === "in_acquisition" && r.lastVitalsAt !== null && now - new Date(r.lastVitalsAt).getTime() > 5 * 60_000);
  const statWaiting = rows.filter((r) => r.priority === "stat" && ["scheduled", "checked_in", "ready"].includes(r.status));
  const clocksAlert = dueRows.length + statWaiting.length > 0;

  const list = (
    <section aria-label={t("radiology.ir.listTitle")}>
      <h2 className="tag m-0 mb-2">{t("radiology.ir.listTitle")} · {rows.length}</h2>
      {listQ.isError && <p role="alert" className="text-sm text-red-700">{radiologyErrorText(listQ.error)}</p>}
      {!listQ.isPending && rows.length === 0 && <p className="text-sm text-muted-foreground">{t("radiology.ir.listEmpty")}</p>}
      <ul className="m-0 list-none space-y-1 p-0" data-testid="ir-list">
        {rows.map((r) => (
          <li key={r.studyId} data-state={r.status}>
            <button
              type="button" data-testid={`ir-row-${r.studyId}`} aria-current={r.studyId === studyId ? "true" : undefined}
              className={`w-full rounded border bg-card p-2 text-left text-sm ${r.studyId === studyId ? "border-green-700" : ""}`}
              onClick={() => { void open(r); }}
            >
              <span className="flex justify-between gap-2">
                <b className="min-w-0 truncate">{r.patientName}</b>
                <span className="mo shrink-0 text-xs">{r.scheduledAt === null ? "—" : fmtIst(r.scheduledAt)}</span>
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {r.priority === "stat" ? <b className="text-red-700">STAT · </b> : null}
                {r.studyTypeName}{r.deviceCode === null ? "" : ` · ${r.deviceCode}`}
              </span>
              <span className="block text-xs">{t(`radiology.ir.next.${r.next}`)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
  const clocks = (
    <ul className="m-0 list-none space-y-1 p-0 text-sm" data-testid="ir-clocks">
      {dueRows.map((r) => <li key={`v-${r.studyId}`} className="text-red-800">{t("radiology.ir.clockVitals", { name: r.patientName })}</li>)}
      {statWaiting.map((r) => <li key={`s-${r.studyId}`}>{t("radiology.ir.clockStat", { name: r.patientName, procedure: r.studyTypeName })}</li>)}
      {!clocksAlert && <li className="text-muted-foreground">{t("radiology.room.clocksQuiet")}</li>}
    </ul>
  );

  return (
    <RadiologyStation
      station="room" views={views}
      title={t("radiology.ir.title")}
      place={t("radiology.ir.place")}
      stats={[
        { label: t("radiology.station.onList"), value: rows.length },
        { label: t("radiology.ir.statTable"), value: rows.filter((r) => r.status === "in_acquisition").length, tone: "live" },
        { label: t("radiology.ir.statRecovery"), value: rows.filter((r) => ["acquired", "reported", "published"].includes(r.status)).length, tone: "waiting" },
      ]}
      lane={studyId === null ? undefined : <IrLane studyId={studyId} onClear={clear} />}
      list={list}
      listSummary={inHand === null ? undefined : t("radiology.room.listSummary", { count: rows.length })}
      inHand={studyId !== null}
      closeListOn={studyId}
      clocks={clocks}
      clocksAlert={clocksAlert}
      clocksSummary={clocksAlert ? t("radiology.room.clocksSummary", { count: dueRows.length + statWaiting.length }) : t("radiology.room.clocksNone")}
    >
      <div className="flex min-h-full flex-col space-y-3" data-testid="ir-suite">
        {openError !== null && <p role="alert" className="text-sm text-red-700">{openError}</p>}
        {studyId === null
          ? (
            <div className="space-y-3" data-testid="ir-idle">
              <p className="rounded border bg-card p-3 text-sm">{rows.length === 0 ? t("radiology.ir.idleEmpty") : t("radiology.ir.idleNext", { name: rows[0]!.patientName, procedure: rows[0]!.studyTypeName })}</p>
              <p className="text-xs text-muted-foreground">{t("radiology.ir.howItWorks")}</p>
            </div>
          )
          : <IrCase key={studyId} studyId={studyId} onDone={clear} />}
      </div>
    </RadiologyStation>
  );
}

/** The left lane: who is on the table, the allergies read aloud at Sign in, the weight and kidney. */
function IrLane({ studyId, onClear }: { studyId: string; onClear: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["radiology", "room", studyId], queryFn: () => fetchRoomView(studyId) });
  const v = q.data?.study;
  if (v === undefined) return <p className="mt-4 text-sm text-muted-foreground">{t("common.loading")}</p>;
  const kv = (k: string, val: React.ReactNode, testid?: string): React.ReactElement => (
    <div className="flex justify-between gap-2 border-b py-1 text-sm last:border-b-0" data-testid={testid}>
      <span className="text-muted-foreground">{k}</span><span className="text-right">{val}</span>
    </div>
  );
  return (
    <div className="mt-4 space-y-3 text-sm" data-testid="ir-lane">
      <div>
        <span className="tag">{t("radiology.ir.lane.onTable")}</span>
        <p className="m-0 mt-1 text-base font-semibold">{v.patient.name}</p>
        <p className="m-0 mo text-xs">{v.patient.uhid} · {v.accessionNo}</p>
      </div>
      <div>
        {kv(t("radiology.room.lane.ageSex"), `${v.patient.ageYears ?? "—"} · ${t(`radiology.room.sex.${v.patient.sex}`, { defaultValue: v.patient.sex })}`)}
        {kv(t("radiology.room.lane.allergies"), v.patient.allergies.length === 0 ? t("radiology.room.lane.nka") : <b className="text-red-800">{v.patient.allergies.join(", ")}</b>, "ir-lane-allergies")}
        {kv(t("radiology.room.lane.weight"), v.patient.weight === null ? t("radiology.room.lane.notCharted") : `${v.patient.weight.kg} kg`)}
        {v.renal !== null && kv(t("radiology.room.lane.renal"), v.renal.egfr !== null ? `eGFR ${v.renal.egfr}` : v.renal.creatinineUmolL !== null ? `${v.renal.creatinineUmolL} µmol/L` : "—")}
        {kv(t("radiology.ir.lane.machine"), v.device === null ? "—" : v.device.code)}
      </div>
      <button type="button" className="rounded border px-3 py-1 text-sm" onClick={onClear}>
        {t("radiology.room.lane.clear")} <span className="kb">Esc</span>
      </button>
    </div>
  );
}

type Refused = { code: string | null; message: string };
const refusedOf = (e: unknown): Refused => ({ code: radiologyErrorCode(e), message: radiologyErrorText(e) });

function Card({ title, done, children, testid }: { title: React.ReactNode; done?: string | null; children?: React.ReactNode; testid?: string }): React.ReactElement {
  return (
    <section className="rounded border bg-card" data-testid={testid} data-done={done ? "true" : "false"}>
      <h3 className="m-0 flex flex-wrap items-baseline justify-between gap-2 border-b px-3 py-2 text-sm font-semibold">
        <span>{title}</span>
        {done ? <span className="text-xs font-normal text-green-800">{done}</span> : null}
      </h3>
      {children === undefined || children === null || children === false ? null : <div className="space-y-2 px-3 py-2">{children}</div>}
    </section>
  );
}

function Check({ checked, onChange, children, testid }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode; testid?: string }): React.ReactElement {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />
      <span>{children}</span>
    </label>
  );
}

function Tile({ label, value, unit, tone, testid }: { label: string; value: string; unit: string; tone?: "red" | "amber"; testid?: string }): React.ReactElement {
  const cls = tone === "red" ? "border-red-400 bg-red-50 text-red-900" : tone === "amber" ? "border-amber-400 bg-amber-50" : "bg-background";
  return (
    <div className={`min-w-0 rounded border p-2 ${cls}`} data-testid={testid} data-tone={tone ?? "plain"}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mo text-lg font-semibold">{value}</div>
      <div className="text-xs">{unit}</div>
    </div>
  );
}

function IrCase({ studyId, onDone }: { studyId: string; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { can } = useAuth();
  const now = useNow();
  const caseQ = useQuery({ queryKey: ["radiology", "ir", studyId], queryFn: () => fetchIrCase(studyId) });
  const roomQ = useQuery({ queryKey: ["radiology", "room", studyId], queryFn: () => fetchRoomView(studyId) });
  const c: WireIrCase | undefined = caseQ.data?.case;
  const [refused, setRefused] = useState<Refused | null>(null);
  const [sentNote, setSentNote] = useState<string | null>(null);

  /* Sign in */
  const [siPeople, setSiPeople] = useState("");
  const [siIdentity, setSiIdentity] = useState(false);
  const [consentLang, setConsentLang] = useState<"hi" | "en">("hi");
  const [consentVersion, setConsentVersion] = useState("IR-CONSENT-1");
  const [consentSigner, setConsentSigner] = useState<"patient" | "guardian">("patient");
  const [consentWitness, setConsentWitness] = useState("");
  const [siSite, setSiSite] = useState(false);
  const [siAllergies, setSiAllergies] = useState(false);
  const [anticoag, setAnticoag] = useState<"none" | "held" | "continued">("none");
  const [anticoagNote, setAnticoagNote] = useState("");
  const [sedation, setSedation] = useState<IrSedationPlan>("moderate");
  const [sedationBy, setSedationBy] = useState("");
  const [lastSolids, setLastSolids] = useState("");
  const [lastClear, setLastClear] = useState("");
  const [siIv, setSiIv] = useState(false);
  const [overrideWhy, setOverrideWhy] = useState("");
  /* Time out */
  const [toPeople, setToPeople] = useState("");
  const [toTeam, setToTeam] = useState(false);
  const [toConfirmed, setToConfirmed] = useState(false);
  const [toImages, setToImages] = useState(false);
  const [toAbx, setToAbx] = useState<"given" | "not_indicated">("not_indicated");
  const [toRisks, setToRisks] = useState(false);
  /* Procedure: dose tiles and the sedation chart */
  const [fluoro, setFluoro] = useState("");
  const [dap, setDap] = useState("");
  const [kar, setKar] = useState("");
  const [vit, setVit] = useState({ sys: "", dia: "", hr: "", spo2: "", rass: "0", drug: "" });
  const [skinOn, setSkinOn] = useState(() => suggestedSkinCheck(Date.now()));
  const [skinNote, setSkinNote] = useState("");
  /* Sign out and Send */
  const [soPeople, setSoPeople] = useState("");
  const [soDone, setSoDone] = useState(false);
  const [soCounts, setSoCounts] = useState(false);
  const [soSpecimens, setSoSpecimens] = useState<"labelled" | "none">("none");
  const [soDevices, setSoDevices] = useState("");
  const [soDose, setSoDose] = useState(false);
  const [soPlan, setSoPlan] = useState(false);
  const [source, setSource] = useState<"pacs" | "no_pacs_images">("pacs");
  /* Note and hand-off */
  const [note, setNote] = useState({ procedure: "", approach: "", devices: "", specimens: "", complications: "", ebl: "" });
  const [ho, setHo] = useState({ sys: "", dia: "", hr: "", spo2: "", bedRest: "", drain: "", en: "", hi: "", receivedBy: "" });

  const report = roomQ.data?.study.doseReport ?? null;
  useEffect(() => {
    if (report === null) return;
    if (fluoro === "" && report.fluoroSeconds !== null) setFluoro(fmtFluoro(report.fluoroSeconds));
    if (dap === "" && report.dap !== null) setDap(String(report.dap));
    if (kar === "" && report.kar != null) setKar(String(report.kar));
  }, [report, fluoro, dap, kar]);
  useEffect(() => {
    if (c === undefined) return;
    if (c.note !== null && note.procedure === "") {
      setNote({ procedure: c.note.procedure, approach: c.note.approach ?? "", devices: c.note.devices ?? "", specimens: c.note.specimens ?? "", complications: c.note.complications ?? "", ebl: c.note.bloodLossMl === null ? "" : String(c.note.bloodLossMl) });
    }
    if (c.next === "note" && note.devices === "") {
      const dev = c.phases.find((p) => p.phase === "sign_out")?.items.find((i) => i.key === "devices")?.answer;
      if (typeof dev === "string" && dev.toLowerCase() !== "none") setNote((n) => ({ ...n, devices: dev }));
    }
    if (c.next === "handoff" && ho.en === "") {
      const bedRest = c.bleedingRisk === "high" ? 6 : 4;
      const last = c.sedation.vitals[c.sedation.vitals.length - 1];
      const drain = (c.note?.devices ?? "").trim() !== "";
      const d = draftInstructions(bedRest, drain);
      setHo({
        sys: last ? String(last.bpSystolic) : "", dia: last ? String(last.bpDiastolic) : "", hr: last ? String(last.heartRate) : "",
        spo2: last ? String(last.spo2) : "", bedRest: String(bedRest), drain: drain ? t("radiology.ir.drainDraft") : "",
        en: d.en, hi: d.hi, receivedBy: "",
      });
    }
  }, [c, note.procedure, note.devices, ho.en, t]);

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ["radiology", "ir", studyId] });
    void qc.invalidateQueries({ queryKey: ["radiology", "ir-cases"] });
    void qc.invalidateQueries({ queryKey: ["radiology", "room", studyId] });
  };
  const act = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { setRefused(null); refresh(); },
    onError: (e) => { setRefused(refusedOf(e)); refresh(); },
  });

  const phaseDone = (p: IrPhase): string | null => {
    const r = c?.phases.find((x) => x.phase === p);
    return r === undefined ? null : t("radiology.ir.recordedBy", { name: r.recordedByName, at: fmtIst(r.recordedAt) });
  };

  const karMgy = num(kar);
  const level = c === undefined ? "none" : karLevel(karMgy, c.thresholds);
  const clockDue = c?.sedation.nextDueAt ?? null;
  const dueInMin = clockDue === null ? null : Math.round((new Date(clockDue).getTime() - now) / 60_000);
  const vitalsDue = c !== undefined && c.status === "in_acquisition" && dueInMin !== null && dueInMin <= 0;
  const vitalsReady = [vit.sys, vit.dia, vit.hr, vit.spo2].every((x) => num(x) !== null);

  const recordVitals = (): void => act.mutate(async () => {
    await irRecordVitals(studyId, {
      bpSystolic: num(vit.sys)!, bpDiastolic: num(vit.dia)!, heartRate: num(vit.hr)!, spo2: num(vit.spo2)!, rass: Number(vit.rass),
      ...(vit.drug.trim() === "" ? {} : { drug: vit.drug.trim() }),
    });
    setVit({ sys: "", dia: "", hr: "", spo2: "", rass: vit.rass, drug: "" });
  });

  /** The one next act, and whether it can run. */
  const dock = ((): { label: string; hint: string; ready: boolean; run: (() => void) | null } => {
    if (c === undefined) return { label: "", hint: "", ready: false, run: null };
    const next: IrNext = c.next;
    const signInBody = () => ({
      participants: lines(siPeople), identityConfirmed: siIdentity,
      consent: {
        procedureCode: c.studyTypeCode, templateVersion: consentVersion.trim(), language: consentLang, signer: consentSigner,
        ...(consentWitness.trim() === "" ? {} : { witness: consentWitness.trim() }), thumbImpression: false,
        laterality: c.lateralityApplicable && ["left", "right", "bilateral"].includes(c.laterality) ? c.laterality as "left" | "right" | "bilateral" : null,
        conversionCovered: false, signedAt: new Date().toISOString(),
      },
      siteMarked: siSite, allergiesReviewed: siAllergies, anticoagulants: anticoag,
      ...(anticoagNote.trim() === "" ? {} : { anticoagulantNote: anticoagNote.trim() }),
      sedationPlan: sedation, ...(sedationBy.trim() === "" ? {} : { sedationBy: sedationBy.trim() }),
      ...(lastSolids === "" ? {} : { lastSolidsAt: istLocalToIso(lastSolids) }),
      ...(lastClear === "" ? {} : { lastClearFluidsAt: istLocalToIso(lastClear) }),
      ivAccessAndResus: siIv,
    });
    switch (next) {
      case "check_in": return { label: t("radiology.ir.dock.checkIn"), hint: t("radiology.ir.dock.checkInHint"), ready: false, run: null };
      case "sign_in": {
        const ready = lines(siPeople).length > 0 && consentVersion.trim() !== "";
        return { label: t("radiology.ir.dock.signIn"), hint: t("radiology.ir.dock.signInHint"), ready, run: () => act.mutate(() => irSignIn(studyId, signInBody())) };
      }
      case "time_out":
        return {
          label: t("radiology.ir.dock.timeOut"), hint: t("radiology.ir.dock.timeOutHint"), ready: lines(toPeople).length > 0,
          run: () => act.mutate(() => irTimeOut(studyId, {
            participants: lines(toPeople), teamIntroduced: toTeam, patientProcedureSideConfirmed: toConfirmed,
            imagesDisplayed: toImages, antibiotics: toAbx, criticalEventsDiscussed: toRisks,
          })),
        };
      case "start":
        return { label: t("radiology.ir.dock.start"), hint: t("radiology.ir.dock.startHint"), ready: true, run: () => act.mutate(() => startAcquisition(studyId)) };
      case "sign_out":
        if (vitalsDue) return { label: t("radiology.ir.dock.vitals"), hint: t("radiology.ir.dock.vitalsHint"), ready: vitalsReady, run: recordVitals };
        return {
          label: t("radiology.ir.dock.signOut"), hint: t("radiology.ir.dock.signOutHint"), ready: lines(soPeople).length > 0 && soDevices.trim() !== "",
          run: () => act.mutate(() => irSignOut(studyId, {
            participants: lines(soPeople), procedureDone: soDone, countsCorrect: soCounts, specimens: soSpecimens,
            devices: soDevices.trim(), doseRecorded: soDose, recoveryPlanGiven: soPlan,
          })),
        };
      case "send": {
        if (level !== "none" && c.skinFollowUp === null) {
          return {
            label: t("radiology.ir.dock.skin"), hint: t("radiology.ir.dock.skinHint"), ready: skinOn !== "",
            run: () => act.mutate(() => irSkinFollowUp(studyId, skinOn, skinNote)),
          };
        }
        const fl = parseFluoro(fluoro);
        const ready = fl !== null || num(dap) !== null || report !== null;
        return {
          label: t("radiology.ir.dock.send"), hint: t("radiology.ir.dock.sendHint"), ready,
          run: () => act.mutate(async () => {
            const typed = fl !== null || num(dap) !== null || karMgy !== null;
            await sendAcquired(studyId, {
              imageSource: source,
              ...(fl === null ? {} : { fluoroSeconds: fl }), ...(num(dap) === null ? {} : { doseDap: num(dap) }),
              ...(karMgy === null ? {} : { doseKar: karMgy }), ...(typed ? { doseManual: true } : {}),
            });
            setSentNote(c.accessionNo);
          }),
        };
      }
      case "note":
        return {
          label: t("radiology.ir.dock.note"), hint: t("radiology.ir.dock.noteHint"), ready: note.procedure.trim().length >= 3,
          run: () => act.mutate(() => irRecordNote(studyId, {
            procedure: note.procedure.trim(),
            ...(note.approach.trim() === "" ? {} : { approach: note.approach.trim() }),
            ...(note.devices.trim() === "" ? {} : { devices: note.devices.trim() }),
            ...(note.specimens.trim() === "" ? {} : { specimens: note.specimens.trim() }),
            ...(note.complications.trim() === "" ? {} : { complications: note.complications.trim() }),
            ...(num(note.ebl) === null ? {} : { bloodLossMl: num(note.ebl)! }),
          })),
        };
      case "handoff": {
        const ready = [ho.sys, ho.dia, ho.hr, ho.spo2, ho.bedRest].every((x) => num(x) !== null)
          && ho.en.trim().length >= 10 && ho.hi.trim().length >= 10 && ho.receivedBy.trim().length >= 2;
        return {
          label: t("radiology.ir.dock.handoff"), hint: t("radiology.ir.dock.handoffHint"), ready,
          run: () => act.mutate(() => irHandoff(studyId, {
            vitals: { bpSystolic: num(ho.sys)!, bpDiastolic: num(ho.dia)!, heartRate: num(ho.hr)!, spo2: num(ho.spo2)! },
            bedRestHours: num(ho.bedRest)!, ...(ho.drain.trim() === "" ? {} : { drainCare: ho.drain.trim() }),
            instructionsEn: ho.en.trim(), instructionsHi: ho.hi.trim(), receivedBy: ho.receivedBy.trim(),
          })),
        };
      }
      case "done": return { label: t("radiology.ir.dock.done"), hint: t("radiology.ir.dock.doneHint"), ready: true, run: onDone };
      default: return { label: t("radiology.ir.dock.closed"), hint: "", ready: false, run: null };
    }
  })();

  const runRef = useRef<(() => void) | null>(null);
  runRef.current = dock.ready && !act.isPending ? dock.run : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target !== null && ["TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName)) return;
      if (e.key === "Enter" && runRef.current !== null) { e.preventDefault(); runRef.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (caseQ.isError) return <RoomRefusal r={refusedOf(caseQ.error)} />;
  if (c === undefined) return <p>{t("common.loading")}</p>;

  const stepIndex = c.next === "sign_in" || c.next === "check_in" ? 0 : c.next === "time_out" ? 1 : c.next === "start" || c.next === "sign_out" ? 2 : c.next === "send" ? 3 : 4;
  const signedIn = phaseDone("sign_in");
  const timedOut = phaseDone("time_out");
  const signedOut = phaseDone("sign_out");
  const onTable = c.status === "in_acquisition";
  const after = ["acquired", "reported", "published"].includes(c.status);
  const coag = c.coagulation;
  const coagBad = coag.required && coag.verdicts.length > 0 && coag.override === null;
  const mayOverride = can("radiology.gates.override");

  return (
    <div className="flex min-h-full flex-col gap-3" data-testid="ir-case" data-next={c.next} data-state={c.status}>
      <div className="rounded border bg-card p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-base font-semibold" data-testid="ir-procedure">{c.studyTypeName}</span>
          <span className="mo text-xs">{c.accessionNo}</span>
        </div>
        <p className="m-0 text-xs text-muted-foreground">
          {c.priority === "stat" ? <b className="text-red-700">STAT · </b> : null}
          {c.patient.name} · {t(`radiology.room.state.${c.status}`, { defaultValue: c.status })}
          {" · "}{t(`radiology.ir.risk.${c.bleedingRisk}`)}
        </p>
        <ol className="m-0 mt-2 flex list-none flex-wrap gap-1 p-0 text-xs" aria-label={t("radiology.ir.steps")} data-testid="ir-steps">
          {(["signIn", "timeOut", "procedure", "signOut", "recovery"] as const).map((k, i) => (
            <li key={k} aria-current={i === stepIndex ? "step" : undefined}
              className={`rounded border px-2 py-0.5 ${i < stepIndex ? "border-green-700 text-green-800" : i === stepIndex ? "border-green-700 bg-green-50 font-semibold" : "text-muted-foreground"}`}>
              {i + 1}. {t(`radiology.ir.step.${k}`)}
            </li>
          ))}
        </ol>
      </div>

      {sentNote !== null && after && <p role="status" className="rounded border border-green-300 bg-green-50 p-2 text-sm" data-testid="ir-sent">{t("radiology.ir.sent", { acc: sentNote })}</p>}

      {/* ── Coagulation ── */}
      {coag.required && (
        <Card title={t("radiology.ir.coag.title")} testid="ir-coag" done={coag.override !== null ? t("radiology.ir.coag.overridden", { name: coag.override.byName, at: fmtIst(coag.override.at) }) : coag.verdicts.length === 0 ? t("radiology.ir.coag.ok") : null}>
          <div className="grid gap-2 sm:grid-cols-2">
            <p className="m-0 text-sm" data-testid="ir-inr">
              INR <b className={coag.inr !== null && coag.inr.value > c.thresholds.inrMax ? "text-red-700" : ""}>{coag.inr?.value ?? "—"}</b>
              <span className="block text-xs text-muted-foreground">{coag.inr === null ? t("radiology.ir.coag.none") : t("radiology.ir.coag.drawn", { at: new Date(coag.inr.sampledAt).toLocaleDateString("en-IN") })} · {t("radiology.ir.coag.inrRule", { max: c.thresholds.inrMax })}</span>
            </p>
            <p className="m-0 text-sm" data-testid="ir-platelets">
              {t("radiology.ir.coag.platelets")} <b className={coag.platelets !== null && coag.platelets.perUl < c.thresholds.plateletsMinPerUl ? "text-red-700" : ""}>{coag.platelets === null ? "—" : coag.platelets.perUl.toLocaleString("en-IN")}</b>/µL
              <span className="block text-xs text-muted-foreground">{coag.platelets === null ? t("radiology.ir.coag.none") : t("radiology.ir.coag.drawn", { at: new Date(coag.platelets.sampledAt).toLocaleDateString("en-IN") })} · {t("radiology.ir.coag.pltRule", { min: c.thresholds.plateletsMinPerUl.toLocaleString("en-IN"), days: c.thresholds.coagValidDays })}</span>
            </p>
          </div>
          {coag.override !== null && <p className="m-0 text-xs">{t("radiology.ir.coag.reason")}: {coag.override.reason}</p>}
          {coagBad && (
            <div className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900" data-testid="ir-coag-refusal">
              <p className="m-0"><code>coagulation_out_of_range</code> — {coag.verdicts.map((v) => t(`radiology.ir.coag.verdict.${v}`, { max: c.thresholds.inrMax, min: c.thresholds.plateletsMinPerUl.toLocaleString("en-IN"), days: c.thresholds.coagValidDays })).join("; ")}</p>
              {mayOverride
                ? (
                  <div className="mt-2 space-y-1">
                    <label className="block text-xs">{t("radiology.ir.coag.overrideLabel")}
                      <textarea className={field} rows={2} value={overrideWhy} onChange={(e) => setOverrideWhy(e.target.value)} data-testid="ir-override-reason" />
                    </label>
                    <button type="button" className="rounded border border-red-400 bg-white px-3 py-1 text-sm disabled:opacity-50" data-testid="ir-override"
                      disabled={overrideWhy.trim().length < 5 || act.isPending}
                      onClick={() => act.mutate(() => irOverrideCoagulation(studyId, overrideWhy.trim()))}>{t("radiology.ir.coag.override")}</button>
                  </div>
                )
                : <p className="m-0 mt-1 text-xs">{t("radiology.ir.coag.askRadiologist")}</p>}
            </div>
          )}
        </Card>
      )}

      {/* ── Sign in ── */}
      <Card title={t("radiology.ir.signIn.title")} done={signedIn} testid="ir-sign-in">
        {signedIn === null && (
          <>
            <label className="block text-sm">{t("radiology.ir.participants")}
              <textarea className={field} rows={2} value={siPeople} onChange={(e) => setSiPeople(e.target.value)} placeholder={t("radiology.ir.participantsHint")} data-testid="si-people" />
            </label>
            <Check checked={siIdentity} onChange={setSiIdentity} testid="si-identity">{t("radiology.ir.signIn.identity")}</Check>
            <fieldset className="rounded border p-2">
              <legend className="px-1 text-xs text-muted-foreground">{t("radiology.ir.signIn.consent")}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block text-xs">{t("radiology.ir.signIn.consentVersion")}<input className={field} value={consentVersion} onChange={(e) => setConsentVersion(e.target.value)} /></label>
                <label className="block text-xs">{t("radiology.ir.signIn.consentLang")}
                  <select className={field} value={consentLang} onChange={(e) => setConsentLang(e.target.value as "hi" | "en")}>
                    <option value="hi">हिन्दी</option><option value="en">English</option>
                  </select>
                </label>
                <label className="block text-xs">{t("radiology.ir.signIn.signer")}
                  <select className={field} value={consentSigner} onChange={(e) => setConsentSigner(e.target.value as "patient" | "guardian")}>
                    <option value="patient">{t("radiology.ir.signIn.signerPatient")}</option><option value="guardian">{t("radiology.ir.signIn.signerGuardian")}</option>
                  </select>
                </label>
                <label className="block text-xs">{t("radiology.ir.signIn.witness")}<input className={field} value={consentWitness} onChange={(e) => setConsentWitness(e.target.value)} data-testid="si-witness" /></label>
              </div>
            </fieldset>
            {c.lateralityApplicable && <Check checked={siSite} onChange={setSiSite} testid="si-site">{t("radiology.ir.signIn.site")}</Check>}
            <Check checked={siAllergies} onChange={setSiAllergies} testid="si-allergies">{t("radiology.ir.signIn.allergies")}</Check>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block text-xs">{t("radiology.ir.signIn.anticoag")}
                <select className={field} value={anticoag} onChange={(e) => setAnticoag(e.target.value as "none" | "held" | "continued")} data-testid="si-anticoag">
                  {(["none", "held", "continued"] as const).map((k) => <option key={k} value={k}>{t(`radiology.ir.signIn.anticoag_${k}`)}</option>)}
                </select>
              </label>
              {anticoag === "continued" && <label className="block text-xs">{t("radiology.ir.signIn.anticoagNote")}<input className={field} value={anticoagNote} onChange={(e) => setAnticoagNote(e.target.value)} /></label>}
              <label className="block text-xs">{t("radiology.ir.signIn.sedation")}
                <select className={field} value={sedation} onChange={(e) => setSedation(e.target.value as IrSedationPlan)} data-testid="si-sedation">
                  {(["local", "moderate", "deep"] as const).map((k) => <option key={k} value={k}>{t(`radiology.ir.sedation.${k}`)}</option>)}
                </select>
              </label>
              {sedation !== "local" && <label className="block text-xs">{t("radiology.ir.signIn.sedationBy")}<input className={field} value={sedationBy} onChange={(e) => setSedationBy(e.target.value)} data-testid="si-sedation-by" /></label>}
              {sedation !== "local" && <label className="block text-xs">{t("radiology.ir.signIn.lastSolids", { h: c.thresholds.fastingSolidsHours })}<input type="datetime-local" className={field} value={lastSolids} onChange={(e) => setLastSolids(e.target.value)} data-testid="si-solids" /></label>}
              {sedation !== "local" && <label className="block text-xs">{t("radiology.ir.signIn.lastClear", { h: c.thresholds.fastingClearHours })}<input type="datetime-local" className={field} value={lastClear} onChange={(e) => setLastClear(e.target.value)} data-testid="si-clear" /></label>}
            </div>
            <Check checked={siIv} onChange={setSiIv} testid="si-iv">{t("radiology.ir.signIn.iv")}</Check>
          </>
        )}
      </Card>

      {/* ── Time out ── */}
      {signedIn !== null && (
        <Card title={t("radiology.ir.timeOut.title")} done={timedOut} testid="ir-time-out">
          {timedOut === null && (
            <>
              <label className="block text-sm">{t("radiology.ir.participants")}
                <textarea className={field} rows={2} value={toPeople} onChange={(e) => setToPeople(e.target.value)} placeholder={t("radiology.ir.timeOut.peopleHint")} data-testid="to-people" />
              </label>
              <Check checked={toTeam} onChange={setToTeam} testid="to-team">{t("radiology.ir.timeOut.team")}</Check>
              <Check checked={toConfirmed} onChange={setToConfirmed} testid="to-confirmed">{t("radiology.ir.timeOut.confirmed")}</Check>
              <Check checked={toImages} onChange={setToImages} testid="to-images">{t("radiology.ir.timeOut.images")}</Check>
              <label className="block text-xs">{t("radiology.ir.timeOut.antibiotics")}
                <select className={field} value={toAbx} onChange={(e) => setToAbx(e.target.value as "given" | "not_indicated")}>
                  <option value="given">{t("radiology.ir.timeOut.abxGiven")}</option><option value="not_indicated">{t("radiology.ir.timeOut.abxNone")}</option>
                </select>
              </label>
              <Check checked={toRisks} onChange={setToRisks} testid="to-risks">{t("radiology.ir.timeOut.risks")}</Check>
            </>
          )}
        </Card>
      )}

      {/* ── The procedure: dose tiles and the sedation chart ── */}
      {(onTable || after) && (
        <Card title={t("radiology.ir.procedure.title")} testid="ir-procedure-card">
          <div className="grid grid-cols-3 gap-2">
            <Tile label={t("radiology.ir.dose.fluoro")} value={parseFluoro(fluoro) === null ? (c.dose.fluoroSeconds === null ? "—" : fmtFluoro(c.dose.fluoroSeconds)) : fmtFluoro(parseFluoro(fluoro)!)} unit="min:s" testid="tile-fluoro" />
            <Tile label="DAP" value={num(dap) === null ? (c.dose.dapGyCm2 === null ? "—" : String(c.dose.dapGyCm2)) : dap} unit="Gy·cm²" testid="tile-dap" />
            <Tile label="Ka,r" value={karMgy === null ? (c.dose.karMgy === null ? "—" : (c.dose.karMgy / 1000).toFixed(2)) : (karMgy / 1000).toFixed(2)}
              unit={t("radiology.ir.dose.karUnit")} tone={level === "srdl" ? "red" : level === "skin" ? "red" : karMgy !== null && karMgy >= c.thresholds.skinFollowUpMgy * 2 / 3 ? "amber" : undefined} testid="tile-kar" />
          </div>
          {level !== "none" && (
            <div role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900" data-testid="ir-skin-alert" data-level={level}>
              <p className="m-0">{t("radiology.ir.dose.skinAlert", { gy: c.thresholds.skinFollowUpMgy / 1000 })}</p>
              {level === "srdl" && <p className="m-0 mt-1 font-semibold">{t("radiology.ir.dose.srdlAlert", { gy: c.thresholds.srdlMgy / 1000 })}</p>}
            </div>
          )}
          {onTable && (
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="block text-xs">{t("radiology.ir.dose.fluoroInput")}<input className={`${field} mo`} value={fluoro} onChange={(e) => setFluoro(e.target.value)} placeholder="12:30" data-testid="dose-fluoro" /></label>
              <label className="block text-xs">{t("radiology.ir.dose.dapInput")}<input className={`${field} mo`} inputMode="decimal" value={dap} onChange={(e) => setDap(e.target.value)} data-testid="dose-dap" /></label>
              <label className="block text-xs">{t("radiology.ir.dose.karInput")}<input className={`${field} mo`} inputMode="decimal" value={kar} onChange={(e) => setKar(e.target.value)} data-testid="dose-kar" /></label>
            </div>
          )}
          {report !== null && onTable && <p className="m-0 text-xs text-muted-foreground">{t("radiology.ir.dose.fromMachine")}</p>}

          <div className="rounded border" data-testid="ir-vitals">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-2 py-1 text-sm">
              <b>{t("radiology.ir.vitals.title")} · {t(`radiology.ir.sedation.${c.sedation.plan ?? "local"}`)}</b>
              {dueInMin !== null && (
                <span className={`text-xs ${dueInMin <= 0 ? "font-semibold text-red-700" : "text-muted-foreground"}`} data-testid="ir-vitals-clock">
                  {dueInMin <= 0 ? t("radiology.ir.vitals.overdue", { min: -dueInMin }) : t("radiology.ir.vitals.dueIn", { min: dueInMin })}
                </span>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-muted-foreground"><th className="px-2 py-1">{t("radiology.ir.vitals.time")}</th><th className="px-2">BP</th><th className="px-2">HR</th><th className="px-2">SpO₂</th><th className="px-2">RASS</th><th className="px-2">{t("radiology.ir.vitals.drug")}</th></tr></thead>
                <tbody>
                  {c.sedation.vitals.length === 0 && <tr><td colSpan={6} className="px-2 py-1 text-muted-foreground">{t("radiology.ir.vitals.none")}</td></tr>}
                  {c.sedation.vitals.map((v) => (
                    <tr key={v.id} className="border-t"><td className="mo px-2 py-1">{fmtIst(v.recordedAt)}</td><td className="mo px-2">{v.bpSystolic}/{v.bpDiastolic}</td><td className="mo px-2">{v.heartRate}</td><td className="mo px-2">{v.spo2}%</td><td className="mo px-2">{v.rass}</td><td className="px-2">{v.drug ?? "—"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            {c.handoff === null && (
              <div className="grid grid-cols-2 gap-2 border-t p-2 sm:grid-cols-6" data-testid="ir-vitals-form">
                <input className={`${field} mo`} inputMode="numeric" aria-label={t("radiology.ir.vitals.sys")} placeholder={t("radiology.ir.vitals.sysShort")} value={vit.sys} onChange={(e) => setVit({ ...vit, sys: e.target.value })} data-testid="vit-sys" />
                <input className={`${field} mo`} inputMode="numeric" aria-label={t("radiology.ir.vitals.dia")} placeholder={t("radiology.ir.vitals.diaShort")} value={vit.dia} onChange={(e) => setVit({ ...vit, dia: e.target.value })} data-testid="vit-dia" />
                <input className={`${field} mo`} inputMode="numeric" aria-label="HR" placeholder="HR" value={vit.hr} onChange={(e) => setVit({ ...vit, hr: e.target.value })} data-testid="vit-hr" />
                <input className={`${field} mo`} inputMode="numeric" aria-label="SpO₂" placeholder="SpO₂" value={vit.spo2} onChange={(e) => setVit({ ...vit, spo2: e.target.value })} data-testid="vit-spo2" />
                <select className={field} aria-label="RASS" value={vit.rass} onChange={(e) => setVit({ ...vit, rass: e.target.value })} data-testid="vit-rass">
                  {[4, 3, 2, 1, 0, -1, -2, -3, -4, -5].map((r) => <option key={r} value={String(r)}>RASS {r > 0 ? `+${String(r)}` : String(r)}</option>)}
                </select>
                <input className={field} aria-label={t("radiology.ir.vitals.drug")} placeholder={t("radiology.ir.vitals.drugHint")} value={vit.drug} onChange={(e) => setVit({ ...vit, drug: e.target.value })} data-testid="vit-drug" />
                {!vitalsDue && (
                  <button type="button" className="col-span-2 rounded border px-3 py-1 text-sm disabled:opacity-50 sm:col-span-6 sm:justify-self-start" disabled={!vitalsReady || act.isPending} onClick={recordVitals} data-testid="vit-record">
                    {t("radiology.ir.vitals.record")}
                  </button>
                )}
              </div>
            )}
          </div>

          {level !== "none" && c.skinFollowUp === null && (onTable || after) && (
            <div className="grid gap-2 rounded border border-red-200 p-2 sm:grid-cols-2" data-testid="ir-skin-form">
              <p className="m-0 text-sm sm:col-span-2">{t("radiology.ir.skin.explain", { min: c.thresholds.skinFollowUpDays.min / 7, max: c.thresholds.skinFollowUpDays.max / 7 })}</p>
              <label className="block text-xs">{t("radiology.ir.skin.on")}<input type="date" className={field} value={skinOn} onChange={(e) => setSkinOn(e.target.value)} data-testid="skin-on" /></label>
              <label className="block text-xs">{t("radiology.ir.skin.note")}<input className={field} value={skinNote} onChange={(e) => setSkinNote(e.target.value)} placeholder={t("radiology.ir.skin.noteHint")} /></label>
            </div>
          )}
          {c.skinFollowUp !== null && <p className="m-0 text-sm text-green-800" data-testid="ir-skin-done">{t("radiology.ir.skin.done", { on: c.skinFollowUp.on, name: c.skinFollowUp.byName })}</p>}
        </Card>
      )}

      {/* ── Sign out ── */}
      {(onTable || after) && (
        <Card title={t("radiology.ir.signOut.title")} done={signedOut} testid="ir-sign-out">
          {signedOut === null && onTable && (
            <>
              <label className="block text-sm">{t("radiology.ir.participants")}
                <textarea className={field} rows={2} value={soPeople} onChange={(e) => setSoPeople(e.target.value)} placeholder={t("radiology.ir.participantsHint")} data-testid="so-people" />
              </label>
              <Check checked={soDone} onChange={setSoDone} testid="so-done">{t("radiology.ir.signOut.done")}</Check>
              <Check checked={soCounts} onChange={setSoCounts} testid="so-counts">{t("radiology.ir.signOut.counts")}</Check>
              <label className="block text-xs">{t("radiology.ir.signOut.specimens")}
                <select className={field} value={soSpecimens} onChange={(e) => setSoSpecimens(e.target.value as "labelled" | "none")}>
                  <option value="none">{t("radiology.ir.signOut.specimensNone")}</option><option value="labelled">{t("radiology.ir.signOut.specimensLabelled")}</option>
                </select>
              </label>
              <label className="block text-xs">{t("radiology.ir.signOut.devices")}<input className={field} value={soDevices} onChange={(e) => setSoDevices(e.target.value)} placeholder={t("radiology.ir.signOut.devicesHint")} data-testid="so-devices" /></label>
              <Check checked={soDose} onChange={setSoDose} testid="so-dose">{t("radiology.ir.signOut.dose")}</Check>
              <Check checked={soPlan} onChange={setSoPlan} testid="so-plan">{t("radiology.ir.signOut.plan")}</Check>
            </>
          )}
          {signedOut !== null && onTable && (
            <label className="block text-xs">{t("radiology.ir.send.source")}
              <select className={field} value={source} onChange={(e) => setSource(e.target.value as "pacs" | "no_pacs_images")} data-testid="send-source">
                <option value="pacs">{t("radiology.ir.send.pacs")}</option><option value="no_pacs_images">{t("radiology.ir.send.noPacs")}</option>
              </select>
            </label>
          )}
        </Card>
      )}

      {/* ── Procedure note, then the recovery hand-off ── */}
      {after && (
        <Card title={t("radiology.ir.note.title")} done={c.note === null ? null : t("radiology.ir.recordedBy", { name: c.note.byName, at: fmtIst(c.note.at) })} testid="ir-note">
          {c.handoff === null
            ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block text-xs sm:col-span-2">{t("radiology.ir.note.procedure")}<textarea className={field} rows={3} value={note.procedure} onChange={(e) => setNote({ ...note, procedure: e.target.value })} data-testid="note-procedure" /></label>
                <label className="block text-xs">{t("radiology.ir.note.approach")}<input className={field} value={note.approach} onChange={(e) => setNote({ ...note, approach: e.target.value })} /></label>
                <label className="block text-xs">{t("radiology.ir.note.devices")}<input className={field} value={note.devices} onChange={(e) => setNote({ ...note, devices: e.target.value })} /></label>
                <label className="block text-xs">{t("radiology.ir.note.specimens")}<input className={field} value={note.specimens} onChange={(e) => setNote({ ...note, specimens: e.target.value })} /></label>
                <label className="block text-xs">{t("radiology.ir.note.ebl")}<input className={`${field} mo`} inputMode="numeric" value={note.ebl} onChange={(e) => setNote({ ...note, ebl: e.target.value })} /></label>
                <label className="block text-xs sm:col-span-2">{t("radiology.ir.note.complications")}<input className={field} value={note.complications} onChange={(e) => setNote({ ...note, complications: e.target.value })} placeholder={t("radiology.ir.note.complicationsHint")} /></label>
                {c.note !== null && c.next === "handoff" && <p className="m-0 text-xs text-muted-foreground sm:col-span-2">{t("radiology.ir.note.editable")}</p>}
              </div>
            )
            : <p className="m-0 whitespace-pre-wrap text-sm">{c.note?.procedure}</p>}
        </Card>
      )}
      {after && c.note !== null && (
        <Card title={t("radiology.ir.handoff.title")} done={c.handoff === null ? null : t("radiology.ir.handoff.done", { name: c.handoff.byName, at: fmtIst(c.handoff.at), to: c.handoff.detail.receivedBy })} testid="ir-handoff">
          {c.handoff === null
            ? (
              <div className="grid gap-2 sm:grid-cols-4">
                <label className="block text-xs">{t("radiology.ir.vitals.sys")}<input className={`${field} mo`} value={ho.sys} onChange={(e) => setHo({ ...ho, sys: e.target.value })} /></label>
                <label className="block text-xs">{t("radiology.ir.vitals.dia")}<input className={`${field} mo`} value={ho.dia} onChange={(e) => setHo({ ...ho, dia: e.target.value })} /></label>
                <label className="block text-xs">HR<input className={`${field} mo`} value={ho.hr} onChange={(e) => setHo({ ...ho, hr: e.target.value })} /></label>
                <label className="block text-xs">SpO₂<input className={`${field} mo`} value={ho.spo2} onChange={(e) => setHo({ ...ho, spo2: e.target.value })} /></label>
                <label className="block text-xs">{t("radiology.ir.handoff.bedRest")}<input className={`${field} mo`} value={ho.bedRest} onChange={(e) => setHo({ ...ho, bedRest: e.target.value })} data-testid="ho-bedrest" /></label>
                <label className="block text-xs sm:col-span-3">{t("radiology.ir.handoff.drain")}<input className={field} value={ho.drain} onChange={(e) => setHo({ ...ho, drain: e.target.value })} /></label>
                <label className="block text-xs sm:col-span-2">{t("radiology.ir.handoff.en")}<textarea className={field} rows={3} value={ho.en} onChange={(e) => setHo({ ...ho, en: e.target.value })} data-testid="ho-en" /></label>
                <label className="block text-xs sm:col-span-2" lang="hi">{t("radiology.ir.handoff.hi")}<textarea className={field} rows={3} value={ho.hi} onChange={(e) => setHo({ ...ho, hi: e.target.value })} data-testid="ho-hi" /></label>
                <label className="block text-xs sm:col-span-4">{t("radiology.ir.handoff.receivedBy")}<input className={field} value={ho.receivedBy} onChange={(e) => setHo({ ...ho, receivedBy: e.target.value })} placeholder={t("radiology.ir.handoff.receivedByHint")} data-testid="ho-received" /></label>
                <p className="m-0 text-xs text-muted-foreground sm:col-span-4">{t("radiology.ir.handoff.draftNote")}</p>
              </div>
            )
            : (
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <p className="m-0">{c.handoff.detail.instructionsEn}</p>
                <p className="m-0" lang="hi">{c.handoff.detail.instructionsHi}</p>
              </div>
            )}
        </Card>
      )}

      {refused !== null && <RoomRefusal r={refused} />}

      <div className="sticky bottom-0 -mx-1 mt-auto flex flex-wrap items-center gap-3 rounded border bg-card p-3 shadow-sm" data-testid="ir-dock" data-act={c.next}>
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">{dock.hint}</span>
        {dock.run !== null && (
          <button type="button" data-testid="ir-dock-act" disabled={!dock.ready || act.isPending} onClick={() => dock.run?.()}
            className="rounded bg-green-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {dock.label} <span className="kb">Enter</span>
          </button>
        )}
        {dock.run === null && <span className="text-sm font-semibold">{dock.label}</span>}
      </div>
    </div>
  );
}
