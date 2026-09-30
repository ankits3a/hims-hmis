import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import {
  BIOMETRY_MAX, PCPNDT_REPORT_DECLARATION_EN, PCPNDT_REPORT_DECLARATION_HI, PLACENTA_POSITIONS, PRESENTATIONS,
  deriveObstetric, formatGa,
} from "../lib/obstetric";
import type { ObstetricBiometryInput, ObstetricDerived } from "../lib/obstetric";
import { useAuth } from "../lib/auth";
import {
  draftReport, fetchFormF, fetchImagingDevices, fetchReadiness, fetchReport, fetchStudy, fetchWorklist,
  openFormF, publishReport, radiologyErrorCode, radiologyErrorDetail, radiologyErrorText, recordAcquired,
  recordFormF, signReport, startAcquisition,
} from "../lib/radiology-api";
import type { WireFormFView, WireImagingDevice, WireStudyView, WireWorklistRow } from "../lib/radiology-api";
import {
  FORM_F_INDICATIONS, closeFormFGate, fetchFormFRegister, fetchMonthlyReturn, fetchPcpndtRegistrations,
  verifySecondFactor,
} from "../lib/radiology-usg-api";
import type { FormFField, WireRegisterRow } from "../lib/radiology-usg-api";
import { istDay, minutesSince } from "../components/radiology/desk-time";
import { SeatLink } from "../components/radiology/imaging-counter";
import { RadiologyStation } from "./radiology-station";

/**
 * PLAN 18-S RS7 T3/T4 — **THE ULTRASOUND & PCPNDT STATION.** One route, four header views
 * (`?view=room|formf|register|monthly`), the house layout on each.
 *
 *   · **Scan room** — the sonologist's. Right: ONE list, today's ultrasound studies on the
 *     ultrasound machines. Opening a patient means she is on the couch (no "call" button). Centre,
 *     for a PCPNDT scan: Form F (open → fill → sign her declaration) → the scan (start, measure with
 *     live GA/EFW/EDD) → the report (drafted by rule from the measurements, the fixed declaration
 *     line below it) → sign under a fresh second factor → publish. For any other scan: scan → report
 *     → sign. ONE next act in the pinned dock; Enter runs it.
 *   · **Form F** — the month's serials BY SERIAL, never by name (`pcpndt-books.ts`); state, what is
 *     missing, the per-machine gap check.
 *   · **Registration** — the §19 certificate, its machines and the people on it (the first web
 *     caller of `GET /pcpndt/registrations`), with the renewal clock.
 *   · **Monthly return** — counts per machine, the discrepancies to close, the 5th, and the return
 *     as text to copy. Sending it is the nodal officer's act on the state portal.
 *
 * ═══ NOTHING ON THIS SCREEN DECIDES THE LAW ═══
 *
 * The Form F gate, the foetal-sex guard, who may sign on which machine, the biometry arithmetic of
 * record — all the server's. The live GA/EFW here is a preview of the same pure functions
 * (`@hmis/contracts`) the server re-runs on save; the refusal words shown are the server's code
 * translated into the room's words, with the server's own sentence underneath.
 */

export type UsgView = "room" | "formf" | "register" | "monthly";
export const USG_VIEWS: readonly UsgView[] = ["room", "formf", "register", "monthly"];
const VIEW_GRANT: Record<UsgView, string> = {
  room: "pcpndt.form_f.write",
  formf: "pcpndt.form_f.read",
  register: "pcpndt.registrations.read",
  monthly: "pcpndt.registrations.read",
};

const LIST_STATES = ["checked_in", "ready", "in_acquisition", "acquired", "reported"];
const WORK_ORDER: Record<string, number> = { in_acquisition: 0, ready: 1, checked_in: 2, acquired: 3, reported: 4 };
const field = "w-full rounded border bg-background px-2 py-1 text-sm";

export function RadiologyUsg({ view = "room" }: { view?: UsgView }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const router = useRouter({ warn: false });
  const allowed = USG_VIEWS.filter((v) => can(VIEW_GRANT[v]));
  const current = allowed.includes(view) ? view : (allowed[0] ?? view);
  const go = (e: React.MouseEvent, v: UsgView): void => {
    if (router === undefined) return;
    e.preventDefault();
    void router.navigate({ to: "/radiology/usg", search: { view: v } });
  };
  const views = allowed.map((v) => (
    <a
      key={v} href={`/radiology/usg?view=${v}`} className="st-nv" data-testid={`usg-view-${v}`}
      aria-current={v === current ? "page" : undefined} onClick={(e) => go(e, v)}
    >
      {t(`radiology.usg.views.${v}`)}
    </a>
  ));
  if (current === "formf") return <FormFRegisterView views={views} />;
  if (current === "register") return <RegistrationView views={views} />;
  if (current === "monthly") return <MonthlyReturnView views={views} />;
  return <ScanRoom views={views} />;
}

/* ═══════════════════════════ refusals, in the room's words ═══════════════════════════ */

const REMEDY: Record<string, string | undefined> = {
  machine_not_registered: "/radiology/usg?view=register",
  person_not_registered: "/radiology/usg?view=register",
  registration_expired: "/radiology/usg?view=register",
  no_active_registration: "/radiology/usg?view=register",
  payment_required: "/radiology/reception",
};

function UsgRefusal({ error, machine, studyId }: { error: unknown; machine: string; studyId?: string }): React.ReactElement {
  const { t } = useTranslation();
  const { username } = useAuth();
  const code = radiologyErrorCode(error);
  const detail = radiologyErrorDetail(error);
  const plain = code === null ? null : t(`radiology.usg.refusal.${code}`, {
    defaultValue: "", machine, person: username ?? "", words: Array.isArray(detail?.matched) ? (detail.matched as string[]).join(", ") : "",
  });
  const fix = code === null ? undefined
    : code === "gate_open" || code === "not_ready" ? (studyId === undefined ? undefined : `/radiology/studies/${studyId}`)
      : REMEDY[code];
  return (
    <div role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900" data-refusal={code ?? "unknown"}>
      {plain !== null && plain !== "" ? <p className="m-0 font-semibold">{plain}</p> : null}
      <p className="m-0 text-xs">{radiologyErrorText(error)}</p>
      {fix !== undefined ? <p className="m-0 mt-1"><SeatLink to={fix}>{t(`radiology.usg.fix.${code === "gate_open" || code === "not_ready" ? "gates" : code === "payment_required" ? "desk" : "register"}`)}</SeatLink></p> : null}
    </div>
  );
}

/* ═══════════════════════════ the scan room ═══════════════════════════ */

type Step = "formf" | "scan" | "report" | "sign";
type Foetus = { label: string; crlMm: string; bpdMm: string; hcMm: string; acMm: string; flMm: string; fhrBpm: string; presentation: string };
type Measures = { lmp: string; afiCm: string; placenta: string; foetuses: Foetus[]; anomalySurvey: boolean };
const emptyFoetus = (label: string): Foetus => ({ label, crlMm: "", bpdMm: "", hcMm: "", acMm: "", flMm: "", fhrBpm: "", presentation: "" });
const EMPTY_MEASURES: Measures = { lmp: "", afiCm: "", placenta: "", foetuses: [emptyFoetus("A")], anomalySurvey: false };

const num = (s: string): number | null => {
  const v = Number(s.trim());
  return s.trim() === "" || !Number.isFinite(v) ? null : v;
};

/**
 * The typed measurements as the server's input shape, or null when a number is outside the range
 * the server's schema accepts (`BIOMETRY_MAX`) — the preview goes blank rather than extrapolating.
 */
export function biometryInput(m: Measures): ObstetricBiometryInput | null {
  const inRange = (v: number | null, max: number): boolean => v === null || (v > 0 && v <= max);
  const foetuses = m.foetuses.map((f) => ({
    label: f.label, crlMm: num(f.crlMm), bpdMm: num(f.bpdMm), hcMm: num(f.hcMm), acMm: num(f.acMm),
    flMm: num(f.flMm), fhrBpm: num(f.fhrBpm) === null ? null : Math.round(num(f.fhrBpm)!),
    presentation: f.presentation === "" ? null : f.presentation as (typeof PRESENTATIONS)[number],
  }));
  const ok = foetuses.every((f) => inRange(f.crlMm, BIOMETRY_MAX.crlMm) && inRange(f.bpdMm, BIOMETRY_MAX.bpdMm)
    && inRange(f.hcMm, BIOMETRY_MAX.hcMm) && inRange(f.acMm, BIOMETRY_MAX.acMm) && inRange(f.flMm, BIOMETRY_MAX.flMm)
    && inRange(f.fhrBpm, BIOMETRY_MAX.fhrBpm)) && (num(m.afiCm) === null || num(m.afiCm)! <= BIOMETRY_MAX.afiCm);
  if (!ok) return null;
  return {
    lmp: /^\d{4}-\d{2}-\d{2}$/.test(m.lmp) ? m.lmp : null,
    afiCm: num(m.afiCm),
    placenta: m.placenta === "" ? null : m.placenta as (typeof PLACENTA_POSITIONS)[number],
    foetuses,
  };
}

const fmtDay = (iso: string | null): string => {
  if (iso === null) return "—";
  const [y, mo, d] = iso.split("-");
  return `${d}-${mo}-${y}`;
};

/**
 * The rule-built draft (no inference — DPIA v0.2): sentences made from what was measured and
 * tapped. It never writes a sex, and the mother's age and sex are on the report header, not here.
 */
export function obstetricDraft(m: Measures, d: ObstetricDerived): { findings: string; impression: string } {
  const twins = d.numberOfFoetuses > 1;
  const parts: string[] = [twins ? `${String(d.numberOfFoetuses)} live intrauterine foetuses.` : "Single live intrauterine foetus."];
  for (const [i, f] of m.foetuses.entries()) {
    const der = d.foetuses[i];
    const bits: string[] = [];
    if (f.crlMm !== "") bits.push(`CRL ${f.crlMm} mm`);
    if (f.bpdMm !== "") bits.push(`BPD ${f.bpdMm} mm`);
    if (f.hcMm !== "") bits.push(`HC ${f.hcMm} mm`);
    if (f.acMm !== "") bits.push(`AC ${f.acMm} mm`);
    if (f.flMm !== "") bits.push(`FL ${f.flMm} mm`);
    const who = twins ? `Foetus ${f.label}: ` : "";
    const ga = der?.gaCompositeDays ?? null;
    const lines = [
      bits.length > 0 ? `${who}${bits.join(", ")}${ga === null ? "" : `, corresponding to ${formatGa(ga)}`}.` : "",
      der?.efwGrams !== null && der?.efwGrams !== undefined ? `${who}Estimated foetal weight ${String(der.efwGrams)} g (Hadlock).` : "",
      f.fhrBpm !== "" ? `${who}Cardiac activity present, FHR ${f.fhrBpm} bpm.` : "",
      f.presentation !== "" ? `${who}Presentation ${f.presentation}.` : "",
    ].filter((x) => x !== "");
    parts.push(...lines);
  }
  if (m.afiCm !== "") parts.push(`AFI ${m.afiCm} cm${d.liquor === null ? "" : ` — liquor ${d.liquor === "normal" ? "adequate" : d.liquor}`}.`);
  if (m.placenta !== "") parts.push(`Placenta ${m.placenta.replace("_", "-")}.`);
  if (m.anomalySurvey) parts.push("No gross structural anomaly seen on this scan.");
  const ga = d.gaByScanDays;
  const impression = [
    `${twins ? "Twin" : "Single"} live intrauterine pregnancy${ga === null ? "" : ` of ${formatGa(ga)} by scan`}.`,
    d.eddByScan === null ? "" : `EDD by scan ${fmtDay(d.eddByScan)}.`,
    d.discordanceDays !== null && Math.abs(d.discordanceDays) > 14 ? `Scan age differs from dates by ${String(Math.abs(d.discordanceDays))} days.` : "",
  ].filter((x) => x !== "").join(" ");
  return { findings: parts.join(" "), impression };
}

function ScanRoom({ views }: { views: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(id); }, []);
  const devicesQ = useQuery({ queryKey: ["radiology", "devices"], queryFn: fetchImagingDevices });
  const listQ = useQuery({ queryKey: ["radiology", "worklist", "all"], queryFn: () => fetchWorklist("all"), refetchInterval: 30_000 });
  const registerQ = useQuery({ queryKey: ["radiology", "pcpndt", "register"], queryFn: () => fetchFormFRegister() });
  const usg = (devicesQ.data?.devices ?? []).filter((d) => d.modality === "usg");
  const byDevice = new Map(usg.map((d) => [d.id, d]));
  const formByStudy = new Map((registerQ.data?.rows ?? []).map((r) => [r.studyId, r]));
  const rows = (listQ.data?.rows ?? [])
    .filter((r) => r.deviceResourceId !== null && byDevice.has(r.deviceResourceId) && LIST_STATES.includes(r.status))
    .sort((a, b) => (a.priority === "stat" ? 0 : 1) - (b.priority === "stat" ? 0 : 1)
      || (WORK_ORDER[a.status] ?? 9) - (WORK_ORDER[b.status] ?? 9)
      || (a.checkedInAt ?? a.createdAt).localeCompare(b.checkedInAt ?? b.createdAt));
  const [selected, setSelected] = useState<string | null>(null);
  const inHand = rows.find((r) => r.studyId === selected) ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const waitingForm = rows.filter((r) => r.formFRequired && r.status === "checked_in"
    && (formByStudy.get(r.studyId) === undefined || formByStudy.get(r.studyId)!.state === "open"));
  const list = (
    <section aria-label={t("radiology.usg.list")}>
      <h2 className="tag m-0 mb-2">{t("radiology.usg.list")} · {rows.length}</h2>
      {rows.length === 0 && !listQ.isPending ? <p className="text-sm text-muted-foreground">{t("radiology.usg.nobody")}</p> : null}
      <ul className="m-0 list-none space-y-1 p-0" data-testid="usg-list">
        {rows.map((r) => {
          const form = formByStudy.get(r.studyId);
          const done = r.status === "acquired" || r.status === "reported";
          return (
            <li key={r.studyId} data-acc={r.accessionNo} data-state={r.status}>
              <button
                type="button" data-testid={`usg-row-${r.studyId}`} aria-current={r.studyId === selected ? "true" : undefined}
                className={`w-full rounded border bg-card p-2 text-left text-sm ${r.studyId === selected ? "border-green-700" : ""} ${done ? "opacity-70" : ""}`}
                onClick={() => setSelected(r.studyId)}
              >
                <span className="flex justify-between gap-2">
                  <b className="min-w-0 truncate">{r.patientName}</b>
                  <span className="mo shrink-0 text-xs">{byDevice.get(r.deviceResourceId ?? "")?.code ?? ""}</span>
                </span>
                <span className="block text-xs text-muted-foreground">
                  {r.priority === "stat" ? <b className="text-red-700">STAT · </b> : null}
                  {r.studyTypeCode} · {t(`radiology.usg.status.${r.status}`, { defaultValue: r.status })}
                  {r.formFRequired
                    ? form === undefined
                      ? <span className="text-red-700"> · {t("radiology.usg.formOwed")}</span>
                      : <span className="mo"> · {form.serial} {t(`radiology.usg.state.${form.state}`)}</span>
                    : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
  const clocks = (
    <ul className="m-0 list-none space-y-1 p-0 text-sm" data-testid="usg-clocks">
      {waitingForm.map((r) => (
        <li key={r.studyId}>{t("radiology.usg.clockFormF", { name: r.patientName, min: minutesSince(r.checkedInAt ?? r.createdAt, now) })}</li>
      ))}
      <li className="text-muted-foreground">{t("radiology.usg.clockReturn")}</li>
    </ul>
  );

  return (
    <RadiologyStation
      station="usg" views={views}
      title={t("radiology.usg.room.title")} place={t("radiology.usg.room.place")}
      stats={[
        { label: t("radiology.usg.stats.waiting"), value: rows.filter((r) => !["acquired", "reported"].includes(r.status)).length },
        { label: t("radiology.usg.stats.toReport"), value: rows.filter((r) => ["acquired", "reported"].includes(r.status)).length, tone: "waiting" },
        { label: t("radiology.usg.stats.formOwed"), value: waitingForm.length, tone: "danger" },
      ]}
      lane={inHand === null ? <RoomLaneEmpty usg={usg} /> : <RoomLane row={inHand} device={byDevice.get(inHand.deviceResourceId ?? "") ?? null} />}
      list={list}
      inHand={inHand !== null}
      closeListOn={selected}
      clocks={clocks}
      clocksAlert={waitingForm.length > 0}
      clocksSummary={waitingForm.length > 0 ? t("radiology.usg.clocksSummary", { count: waitingForm.length }) : t("radiology.usg.clocksNone")}
    >
      {listQ.isError ? <UsgRefusal error={listQ.error} machine="" /> : null}
      {inHand === null
        ? <RoomIdle usg={usg} />
        : <Couch key={inHand.studyId} row={inHand} device={byDevice.get(inHand.deviceResourceId ?? "") ?? null} onDone={() => setSelected(null)} />}
    </RadiologyStation>
  );
}

function RoomLaneEmpty({ usg }: { usg: WireImagingDevice[] }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="mt-4 space-y-2 text-sm" data-testid="usg-nobody">
      <p className="text-muted-foreground">{t("radiology.usg.nobodyOnCouch")}</p>
      <p><span className="tag">{t("radiology.usg.rooms")}</span> {usg.map((d) => d.code).join(" · ") || "—"}</p>
    </div>
  );
}

function RoomLane({ row, device }: { row: WireWorklistRow; device: WireImagingDevice | null }): React.ReactElement {
  const { t } = useTranslation();
  const formQ = useQuery({
    queryKey: ["pcpndt", "form-f", row.studyId], queryFn: () => fetchFormF(row.studyId), enabled: row.formFRequired,
  });
  const f = formQ.data?.form ?? null;
  const sections = (f?.sections ?? {}) as Record<string, unknown>;
  return (
    <div className="mt-4 space-y-3 text-sm" data-testid="usg-in-hand">
      <div>
        <span className="tag">{t("radiology.usg.onCouch")}</span>
        <p className="m-0 mt-1 text-base font-semibold">{row.patientName}</p>
        <p className="m-0 mo text-xs">{row.accessionNo} · {row.studyTypeCode}</p>
        <p className="m-0 text-xs">{device === null ? "—" : `${device.code} · ${device.name}${device.room === null ? "" : ` · ${device.room}`}`}</p>
      </div>
      <div>
        <span className="tag">PCPNDT</span>
        {row.formFRequired
          ? (
            <dl className="m-0 mt-1 grid grid-cols-[7rem_1fr] gap-x-2 text-xs">
              <dt>{t("radiology.usg.lane.formF")}</dt>
              <dd className="mo">{f === null ? <span className="text-red-700">{t("radiology.usg.lane.notOpened")}</span> : `${device?.code ?? ""}/${String(f.serialYear)}/${String(f.serialNo).padStart(4, "0")}`}</dd>
              <dt>{t("radiology.usg.lane.status")}</dt>
              <dd>{f === null ? "—" : t(`radiology.usg.state.${f.verifiedAt !== null ? "verified" : f.status}`)}</dd>
              <dt>{t("radiology.usg.lane.lmp")}</dt>
              <dd className="mo">{typeof sections.lmp === "string" ? fmtDay(sections.lmp) : "—"}</dd>
              <dt>{t("radiology.usg.lane.weeks")}</dt>
              <dd className="mo">{f?.gestationWeeks ?? "—"}</dd>
            </dl>
          )
          : <p className="m-0 mt-1 text-xs text-muted-foreground">{t("radiology.usg.lane.notPcpndt")}</p>}
      </div>
    </div>
  );
}

function RoomIdle({ usg }: { usg: WireImagingDevice[] }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="space-y-3" data-testid="usg-idle">
      <div className="grid gap-2 sm:grid-cols-3">
        {usg.map((d) => (
          <div key={d.id} className="rounded border bg-card p-3 text-sm">
            <b className="mo">{d.code}</b> · {d.name}
            <p className="m-0 text-xs text-muted-foreground">{d.room ?? "—"} · {t(`radiology.setup.status.${d.status}`, { defaultValue: d.status })}</p>
          </div>
        ))}
      </div>
      <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="usg-rule">{t("radiology.usg.rule")}</p>
    </div>
  );
}

const isObstetric = (s: { formFRequired: boolean; studyTypeCode: string }): boolean =>
  s.formFRequired || /(^|[-_])(OB|OBS|OBST|ANC)([-_]|$)/i.test(s.studyTypeCode);

/** Where the study stands, read from the server — the step the room opens on. */
function stepFor(s: WireStudyView, form: WireFormFView | null): Step {
  if (s.formFRequired && (form === null || form.status === "open")) return "formf";
  if (["checked_in", "ready", "in_acquisition"].includes(s.status)) return "scan";
  const hasHumanDraft = s.reports.some((r) => (r.status === "draft" || r.status === "prelim") && !r.machineDrafted);
  if (s.status === "acquired" && !hasHumanDraft) return "report";
  return "sign";
}

function Couch({ row, device, onDone }: { row: WireWorklistRow; device: WireImagingDevice | null; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const studyQ = useQuery({ queryKey: ["radiology", "study", row.studyId], queryFn: () => fetchStudy(row.studyId) });
  const formQ = useQuery({ queryKey: ["pcpndt", "form-f", row.studyId], queryFn: () => fetchFormF(row.studyId), enabled: row.formFRequired });
  const readyQ = useQuery({ queryKey: ["radiology", "readiness", row.studyId], queryFn: () => fetchReadiness(row.studyId) });
  const s = studyQ.data?.study ?? null;
  const form = formQ.data?.form ?? null;
  const ob = isObstetric(row);
  const machine = device?.code ?? "";
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const serverStep = s === null || (row.formFRequired && formQ.isPending) ? null : stepFor(s, form);
  const cur: Step | null = step ?? serverStep;
  const refresh = async (): Promise<void> => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["radiology", "study", row.studyId] }),
      qc.invalidateQueries({ queryKey: ["pcpndt", "form-f", row.studyId] }),
      qc.invalidateQueries({ queryKey: ["radiology", "readiness", row.studyId] }),
      qc.invalidateQueries({ queryKey: ["radiology", "worklist"] }),
      qc.invalidateQueries({ queryKey: ["radiology", "pcpndt", "register"] }),
    ]);
  };
  const fail = (e: unknown): void => { setError(e); setNote(null); };
  const ok = (msg: string): void => { setError(null); setNote(msg); void refresh(); };

  /* ── Form F state ── */
  const [indication, setIndication] = useState("");
  const [ff, setFf] = useState({ relative: "", sons: "", daughters: "", lmp: "", selfReferral: true, referrer: "", referrerReg: "", declared: false, language: "hi" });
  /* ── the scan ── */
  const [m, setM] = useState<Measures>(EMPTY_MEASURES);
  const [organs, setOrgans] = useState<Record<string, string>>({});
  /* ── the report ── */
  const [findings, setFindings] = useState("");
  const [impression, setImpression] = useState("");
  const [totp, setTotp] = useState("");
  const draftedRef = useRef(false);

  useEffect(() => {
    const lmp = (form?.sections as Record<string, unknown> | undefined)?.lmp;
    if (typeof lmp === "string") setM((p) => (p.lmp === "" ? { ...p, lmp } : p));
  }, [form]);

  const bio = biometryInput(m);
  const scanDay = istDay(Date.now());
  const derived = ob && bio !== null ? deriveObstetric(bio, scanDay) : null;

  const openF = useMutation({
    mutationFn: () => openFormF({
      studyId: row.studyId, patientId: row.patientId, deviceResourceId: row.deviceResourceId ?? "",
      indicationCode: indication, applicability: "pregnant",
    }),
    onSuccess: () => ok(t("radiology.usg.done.formOpened")), onError: fail,
  });
  const recordF = useMutation({
    mutationFn: async () => {
      if (form === null) return;
      const lmp = ff.lmp === "" ? null : ff.lmp;
      const weeks = lmp === null ? null : Math.floor(Math.max(0, (Date.parse(`${scanDay}T00:00:00Z`) - Date.parse(`${lmp}T00:00:00Z`)) / 86_400_000) / 7);
      await recordFormF(form.formFId, {
        sections: {
          relative_name: ff.relative.trim(),
          living_children: { sons: Number(ff.sons || "0"), daughters: Number(ff.daughters || "0") },
          ...(lmp === null ? {} : { lmp }),
          ...(ff.selfReferral ? {} : { referrer: { name: ff.referrer.trim(), registration_no: ff.referrerReg.trim() } }),
          patient_declaration: { obtained_at: new Date().toISOString(), language: ff.language },
          procedure: "ultrasonography",
        },
        declaration: { signature_kind: "signature" },
        referral: { self_referral: ff.selfReferral },
        gestationWeeks: weeks,
      });
      /** The gate reads the register; the sonologist closes it from the row she just wrote. */
      await closeFormFGate(row.studyId);
    },
    onSuccess: () => { setStep("scan"); ok(t("radiology.usg.done.formRecorded")); }, onError: fail,
  });
  const start = useMutation({
    mutationFn: async () => {
      if (row.formFRequired) await closeFormFGate(row.studyId);
      await startAcquisition(row.studyId);
    },
    onSuccess: () => ok(t("radiology.usg.done.started")), onError: fail,
  });
  const finish = useMutation({
    mutationFn: async () => {
      if (s?.status === "in_acquisition") await recordAcquired(row.studyId, { imageSource: "no_pacs_images" });
      const draft = ob && derived !== null && bio !== null
        ? obstetricDraft(m, derived)
        : { findings: Object.values(organs).join(" "), impression: "" };
      draftedRef.current = true;
      setFindings(draft.findings);
      setImpression(draft.impression);
    },
    onSuccess: () => { setStep("report"); ok(t("radiology.usg.done.acquired")); }, onError: fail,
  });
  const save = useMutation({
    mutationFn: () => draftReport(row.studyId, {
      ...(ob ? { templateKey: "usg_obstetric" } : {}),
      body: { findings, ...(ob && bio !== null ? { obstetric_biometry: bio } : {}) },
      impression, laterality: s?.laterality ?? null,
    }),
    onSuccess: () => { setStep("sign"); ok(t("radiology.usg.done.saved")); }, onError: fail,
  });
  const signable = s?.reports.find((r) => (r.status === "draft" || r.status === "prelim") && !r.machineDrafted)?.id ?? null;
  const signed = s?.reports.find((r) => r.status === "signed") ?? null;
  const sign = useMutation({
    mutationFn: async () => {
      await verifySecondFactor(totp);
      await signReport(row.studyId, { reportId: signable ?? "" });
    },
    onSuccess: () => { setTotp(""); ok(t("radiology.usg.done.signed")); }, onError: fail,
  });
  const publish = useMutation({
    mutationFn: () => publishReport(row.studyId),
    onSuccess: () => ok(t("radiology.usg.done.published")), onError: fail,
  });

  /* When a saved draft exists and nothing is typed yet (a reload), seed from it. */
  const latestDraft = useQuery({
    queryKey: ["radiology", "report", signable], queryFn: () => fetchReport(signable!), enabled: signable !== null && !draftedRef.current,
  });
  useEffect(() => {
    const r = latestDraft.data?.report;
    if (r === undefined || r === null || draftedRef.current) return;
    draftedRef.current = true;
    const body = r.body as { findings?: string };
    setFindings((c) => (c === "" ? body.findings ?? "" : c));
    setImpression((c) => (c === "" ? r.impression ?? "" : c));
  }, [latestDraft.data]);

  /* ── the dock: the ONE next act ── */
  const missingF: string[] = [];
  if (form !== null && form.status === "open") {
    if (ff.relative.trim() === "") missingF.push(t("radiology.usg.ff.relative"));
    if (ff.sons === "" || ff.daughters === "") missingF.push(t("radiology.usg.ff.children"));
    if (ff.lmp === "") missingF.push(t("radiology.usg.ff.lmp"));
    if (!ff.selfReferral && ff.referrer.trim() === "") missingF.push(t("radiology.usg.ff.referrer"));
    if (!ff.declared) missingF.push(t("radiology.usg.ff.declaration"));
  }
  const scanReady = !ob || (derived !== null && derived.foetuses.every((f) => f.gaCompositeDays !== null) && m.foetuses.every((f) => f.fhrBpm !== ""));
  let dock: { label: string; hint: string; run: (() => void) | null };
  if (s === null || cur === null) dock = { label: t("common.loading"), hint: "", run: null };
  else if (s.status === "published") dock = { label: t("radiology.usg.dock.next"), hint: t("radiology.usg.dock.nextHint"), run: onDone };
  else if (cur === "formf" && form === null) {
    dock = { label: t("radiology.usg.dock.openForm"), hint: indication === "" ? t("radiology.usg.dock.pickIndication") : t("radiology.usg.dock.openHint", { machine }), run: indication === "" ? null : () => openF.mutate() };
  } else if (cur === "formf") {
    dock = { label: t("radiology.usg.dock.recordForm"), hint: missingF.length > 0 ? t("radiology.usg.dock.missing", { fields: missingF.join(" · ") }) : t("radiology.usg.dock.recordHint"), run: missingF.length > 0 ? null : () => recordF.mutate() };
  } else if (cur === "scan" && s.status !== "in_acquisition") {
    dock = { label: t("radiology.usg.dock.start"), hint: t("radiology.usg.dock.startHint", { machine }), run: () => start.mutate() };
  } else if (cur === "scan") {
    dock = { label: t("radiology.usg.dock.finish"), hint: scanReady ? t("radiology.usg.dock.finishHint") : t("radiology.usg.dock.measureFirst"), run: scanReady ? () => finish.mutate() : null };
  } else if (cur === "report") {
    dock = { label: t("radiology.usg.dock.save"), hint: t("radiology.usg.dock.saveHint"), run: findings.trim() === "" ? null : () => save.mutate() };
  } else if (signed !== null) {
    dock = { label: t("radiology.usg.dock.publish"), hint: t("radiology.usg.dock.publishHint"), run: () => publish.mutate() };
  } else {
    dock = { label: t("radiology.usg.dock.sign"), hint: /^\d{6}$/.test(totp) ? t("radiology.usg.dock.signHint") : t("radiology.usg.dock.typeCode"), run: /^\d{6}$/.test(totp) && signable !== null ? () => sign.mutate() : null };
  }
  const busy = openF.isPending || recordF.isPending || start.isPending || finish.isPending || save.isPending || sign.isPending || publish.isPending;
  const dockRun = useRef(dock.run);
  dockRun.current = busy ? null : dock.run;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag)) return;
      if (e.key === "Enter" && dockRun.current !== null) { e.preventDefault(); dockRun.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const steps: Step[] = ob && row.formFRequired ? ["formf", "scan", "report", "sign"] : ["scan", "report", "sign"];
  const order = cur === null ? -1 : steps.indexOf(cur);
  const serverOrder = serverStep === null ? -1 : steps.indexOf(serverStep);
  const openGates = (readyQ.data?.open ?? []).filter((g) => g !== "form_f");

  return (
    <div className="flex min-h-full flex-col" data-testid="usg-couch">
      <div className="rounded border bg-card p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <b className="text-base">{row.patientName}</b>
          <span className="text-xs">
            {s?.studyTypeCode ?? row.studyTypeCode} · <span className="mo">{row.accessionNo}</span>
            {row.formFRequired ? <b className="ml-2 rounded bg-amber-100 px-1 text-amber-900">PCPNDT</b> : null}
          </span>
        </div>
      </div>
      <ol className="m-0 mt-2 flex list-none flex-wrap gap-1 p-0" aria-label={t("radiology.usg.steps")}>
        {steps.map((k, i) => (
          <li key={k}>
            <button
              type="button" aria-current={cur === k ? "step" : undefined} disabled={i > Math.max(order, serverOrder)}
              className={`rounded border px-3 py-1 text-sm disabled:opacity-50 ${cur === k ? "border-green-700 bg-green-50 font-semibold" : ""}`}
              onClick={() => setStep(k)} data-testid={`usg-step-${k}`}
            >
              <span className="mo text-xs">{String(i + 1).padStart(2, "0")}</span> {t(`radiology.usg.step.${k}`)}
            </button>
          </li>
        ))}
      </ol>
      <div className="flex-1 space-y-3 py-3">
        {error !== null ? <UsgRefusal error={error} machine={machine} studyId={row.studyId} /> : null}
        {note !== null ? <p role="status" className="text-sm text-green-800">{note}</p> : null}
        {openGates.length > 0 && cur === "scan" && s?.status !== "in_acquisition"
          ? (
            <div role="note" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm" data-testid="usg-open-gates">
              {t("radiology.usg.openGates", { gates: openGates.map((g) => t(`radiology.gate.${g}`, { defaultValue: g })).join(", ") })}
              {" "}<SeatLink to={`/radiology/studies/${row.studyId}`}>{t("radiology.usg.fix.gates")}</SeatLink>
            </div>
          )
          : null}
        {cur === "formf" ? <FormFStep form={form} machine={machine} indication={indication} onIndication={setIndication} ff={ff} onFf={setFf} /> : null}
        {cur === "scan" ? (
          ob
            ? <Biometry m={m} onM={setM} derived={derived} editable={s?.status === "in_acquisition"} />
            : <Organs organs={organs} onOrgans={setOrgans} editable={s?.status === "in_acquisition"} />
        ) : null}
        {cur === "report" || cur === "sign"
          ? (
            <ReportStep
              ob={ob} findings={findings} impression={impression} onFindings={setFindings} onImpression={setImpression}
              editable={cur === "report"} derived={derived}
            />
          )
          : null}
        {cur === "sign" && signed === null
          ? (
            <label className="block max-w-xs text-sm" data-testid="usg-totp">
              {t("radiology.usg.totp")}
              <input className={`${field} mo`} inputMode="numeric" maxLength={6} value={totp} autoComplete="one-time-code"
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))} />
              <span className="block text-xs text-muted-foreground">{t("radiology.usg.totpHint")}</span>
            </label>
          )
          : null}
        {signed !== null ? <p role="status" className="text-sm" data-testid="usg-signed">{t("radiology.usg.signedAs", { version: signed.version })}{signed.publishedAt !== null ? ` · ${t("radiology.usg.published")}` : ""}</p> : null}
      </div>
      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 rounded border bg-card p-3 shadow-sm" data-testid="usg-dock">
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">{dock.hint}</span>
        <button
          type="button" data-testid="usg-dock-act"
          className="rounded bg-green-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          disabled={dock.run === null || busy} onClick={() => dock.run?.()}
        >
          {dock.label} <span className="kb">Enter</span>
        </button>
      </div>
    </div>
  );
}

type FfState = { relative: string; sons: string; daughters: string; lmp: string; selfReferral: boolean; referrer: string; referrerReg: string; declared: boolean; language: string };

function FormFStep({ form, machine, indication, onIndication, ff, onFf }: {
  form: WireFormFView | null; machine: string; indication: string; onIndication: (v: string) => void;
  ff: FfState; onFf: (f: FfState) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const set = (p: Partial<FfState>) => onFf({ ...ff, ...p });
  if (form === null) {
    return (
      <section className="space-y-2" data-testid="usg-formf-open">
        <h2 className="text-base font-semibold">{t("radiology.usg.ff.title")}</h2>
        <p className="rounded border border-amber-300 bg-amber-50 p-2 text-sm">{t("radiology.usg.ff.serialWarning", { machine })}</p>
        <fieldset className="space-y-1">
          <legend className="text-sm font-semibold">{t("radiology.usg.ff.indication")}</legend>
          <div className="grid gap-1">
            {FORM_F_INDICATIONS.map((c) => (
              <label key={c} className={`flex items-start gap-2 rounded border p-2 text-sm ${indication === c ? "border-green-700 bg-green-50" : "bg-card"}`}>
                <input type="radio" name="usg-indication" value={c} checked={indication === c} onChange={() => onIndication(c)} />
                <span className="mo w-10 shrink-0">{c}</span>
                <span>{t(`radiology.usg.indication.${c}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>
    );
  }
  if (form.status !== "open") {
    return (
      <section className="space-y-1 rounded border bg-card p-3 text-sm" data-testid="usg-formf-done">
        <b className="mo">{machine}/{form.serialYear}/{String(form.serialNo).padStart(4, "0")}</b> · {t(`radiology.usg.state.${form.verifiedAt !== null ? "verified" : "recorded"}`)}
        <p className="m-0 text-xs text-muted-foreground">{t("radiology.usg.ff.verifyNote")}</p>
      </section>
    );
  }
  return (
    <section className="space-y-3" data-testid="usg-formf-fill">
      <h2 className="text-base font-semibold">{t("radiology.usg.ff.title")} · <span className="mo">{machine}/{form.serialYear}/{String(form.serialNo).padStart(4, "0")}</span></h2>
      <p className="text-sm">{form.patientName} · <span className="mo">{form.patientUhid}</span></p>
      {form.patientIsConfidential ? <p className="text-xs text-muted-foreground">{t("pcpndt.formF.realNameNotice")}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">{t("radiology.usg.ff.relative")}
          <input className={field} value={ff.relative} maxLength={160} data-testid="ff-relative" onChange={(e) => set({ relative: e.target.value })} />
        </label>
        <label className="block text-sm">{t("radiology.usg.ff.lmp")}
          <input className={field} type="date" value={ff.lmp} data-testid="ff-lmp" onChange={(e) => set({ lmp: e.target.value })} />
        </label>
        <label className="block text-sm">{t("radiology.usg.ff.sons")}
          <input className={field} inputMode="numeric" value={ff.sons} maxLength={2} data-testid="ff-sons" onChange={(e) => set({ sons: e.target.value.replace(/\D/g, "") })} />
        </label>
        <label className="block text-sm">{t("radiology.usg.ff.daughters")}
          <input className={field} inputMode="numeric" value={ff.daughters} maxLength={2} data-testid="ff-daughters" onChange={(e) => set({ daughters: e.target.value.replace(/\D/g, "") })} />
        </label>
      </div>
      <p className="m-0 text-xs text-muted-foreground">{t("radiology.usg.ff.childrenNote")}</p>
      <fieldset className="space-y-2 rounded border p-2">
        <legend className="text-sm font-semibold">{t("radiology.usg.ff.referral")}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ff.selfReferral} data-testid="ff-self" onChange={(e) => set({ selfReferral: e.target.checked })} />
          {t("radiology.usg.ff.selfReferral")}
        </label>
        {!ff.selfReferral
          ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block text-sm">{t("radiology.usg.ff.referrer")}
                <input className={field} value={ff.referrer} maxLength={160} onChange={(e) => set({ referrer: e.target.value })} />
              </label>
              <label className="block text-sm">{t("radiology.usg.ff.referrerReg")}
                <input className={field} value={ff.referrerReg} maxLength={80} onChange={(e) => set({ referrerReg: e.target.value })} />
              </label>
            </div>
          )
          : null}
      </fieldset>
      <fieldset className="space-y-2 rounded border border-amber-300 bg-amber-50 p-2">
        <legend className="text-sm font-semibold">{t("radiology.usg.ff.declaration")}</legend>
        <p className="m-0 text-sm" lang="hi">{t("radiology.usg.ff.patientWordsHi")}</p>
        <p className="m-0 text-sm">{t("radiology.usg.ff.patientWordsEn")}</p>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1">
            <input type="radio" name="ff-lang" checked={ff.language === "hi"} onChange={() => set({ language: "hi" })} /> हिन्दी
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name="ff-lang" checked={ff.language === "en"} onChange={() => set({ language: "en" })} /> English
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={ff.declared} data-testid="ff-declared" onChange={(e) => set({ declared: e.target.checked })} />
            {t("radiology.usg.ff.declaredTick")}
          </label>
        </div>
      </fieldset>
      <p className="m-0 text-xs text-muted-foreground">{t("radiology.usg.ff.yourDeclaration")}</p>
    </section>
  );
}

function Biometry({ m, onM, derived, editable }: {
  m: Measures; onM: (m: Measures) => void; derived: ObstetricDerived | null; editable: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const setF = (i: number, p: Partial<Foetus>) => onM({ ...m, foetuses: m.foetuses.map((f, j) => (j === i ? { ...f, ...p } : f)) });
  const numIn = (label: string, unit: string, value: string, on: (v: string) => void, testid: string) => (
    <label className="block text-sm">
      {label} <span className="mo text-xs text-muted-foreground">({unit})</span>
      <input className={`${field} mo`} inputMode="decimal" value={value} disabled={!editable} data-testid={testid}
        onChange={(e) => on(e.target.value.replace(/[^\d.]/g, ""))} />
    </label>
  );
  return (
    <section className="space-y-3" data-testid="usg-biometry">
      <h2 className="text-base font-semibold">{t("radiology.usg.bio.title")}</h2>
      {!editable ? <p className="text-xs text-muted-foreground">{t("radiology.usg.bio.startFirst")}</p> : null}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>{t("radiology.usg.bio.number")}</span>
        {[1, 2].map((n) => (
          <button key={n} type="button" disabled={!editable} aria-pressed={m.foetuses.length === n}
            className={`rounded border px-3 py-1 ${m.foetuses.length === n ? "border-green-700 bg-green-50" : ""}`}
            onClick={() => onM({ ...m, foetuses: n === 1 ? [m.foetuses[0]!] : [m.foetuses[0]!, m.foetuses[1] ?? emptyFoetus("B")] })}>
            {t(n === 1 ? "radiology.usg.bio.single" : "radiology.usg.bio.twins")}
          </button>
        ))}
      </div>
      {m.foetuses.map((f, i) => {
        const d = derived?.foetuses[i] ?? null;
        return (
          <div key={f.label} className="space-y-2 rounded border bg-card p-3">
            {m.foetuses.length > 1 ? <b className="text-sm">{t("radiology.usg.bio.foetus", { label: f.label })}</b> : null}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {numIn("CRL", "mm", f.crlMm, (v) => setF(i, { crlMm: v }), `bio-crl-${f.label}`)}
              {numIn("BPD", "mm", f.bpdMm, (v) => setF(i, { bpdMm: v }), `bio-bpd-${f.label}`)}
              {numIn("HC", "mm", f.hcMm, (v) => setF(i, { hcMm: v }), `bio-hc-${f.label}`)}
              {numIn("AC", "mm", f.acMm, (v) => setF(i, { acMm: v }), `bio-ac-${f.label}`)}
              {numIn("FL", "mm", f.flMm, (v) => setF(i, { flMm: v }), `bio-fl-${f.label}`)}
              {numIn("FHR", "bpm", f.fhrBpm, (v) => setF(i, { fhrBpm: v }), `bio-fhr-${f.label}`)}
            </div>
            <div className="flex flex-wrap gap-1 text-sm">
              <span className="mr-1">{t("radiology.usg.bio.presentation")}</span>
              {PRESENTATIONS.map((p) => (
                <button key={p} type="button" disabled={!editable} aria-pressed={f.presentation === p}
                  className={`rounded border px-2 py-0.5 ${f.presentation === p ? "border-green-700 bg-green-50" : ""}`}
                  onClick={() => setF(i, { presentation: f.presentation === p ? "" : p })}>
                  {t(`radiology.usg.bio.pres.${p}`)}
                </button>
              ))}
            </div>
            <p className="m-0 text-sm" data-testid={`bio-derived-${f.label}`}>
              {t("radiology.usg.bio.ga")} <b className="mo">{formatGa(d?.gaCompositeDays ?? null)}</b>
              {d?.method === "crl" ? ` (${t("radiology.usg.bio.byCrl")})` : d?.method === "hadlock_mean" ? ` (${t("radiology.usg.bio.byHadlock")})` : ""}
              {" · "}{t("radiology.usg.bio.efw")} <b className="mo">{d?.efwGrams === null || d === null ? "—" : `${String(d.efwGrams)} g`}</b>
              {d?.fhrOutsideRange === true ? <span className="text-red-700"> · {t("radiology.usg.bio.fhrFlag")}</span> : null}
            </p>
          </div>
        );
      })}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {numIn(t("radiology.usg.bio.afi"), "cm", m.afiCm, (v) => onM({ ...m, afiCm: v }), "bio-afi")}
        <label className="block text-sm">{t("radiology.usg.bio.lmp")}
          <input className={field} type="date" value={m.lmp} disabled={!editable} onChange={(e) => onM({ ...m, lmp: e.target.value })} />
        </label>
        <label className="block text-sm">{t("radiology.usg.bio.placenta")}
          <select className={field} value={m.placenta} disabled={!editable} data-testid="bio-placenta" onChange={(e) => onM({ ...m, placenta: e.target.value })}>
            <option value="">—</option>
            {PLACENTA_POSITIONS.map((p) => <option key={p} value={p}>{t(`radiology.usg.bio.plac.${p}`)}</option>)}
          </select>
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={m.anomalySurvey} disabled={!editable} onChange={(e) => onM({ ...m, anomalySurvey: e.target.checked })} />
        {t("radiology.usg.bio.anomaly")}
      </label>
      <dl className="grid grid-cols-[10rem_1fr] gap-x-2 rounded border bg-card p-3 text-sm" data-testid="bio-summary">
        <dt>{t("radiology.usg.bio.gaLmp")}</dt><dd className="mo">{formatGa(derived?.gaByLmpDays ?? null)}</dd>
        <dt>{t("radiology.usg.bio.gaScan")}</dt><dd className="mo">{formatGa(derived?.gaByScanDays ?? null)}</dd>
        <dt>{t("radiology.usg.bio.eddLmp")}</dt><dd className="mo">{fmtDay(derived?.eddByLmp ?? null)}</dd>
        <dt>{t("radiology.usg.bio.eddScan")}</dt><dd className="mo">{fmtDay(derived?.eddByScan ?? null)}</dd>
        <dt>{t("radiology.usg.bio.liquor")}</dt><dd>{derived?.liquor === null || derived === null ? "—" : t(`radiology.usg.bio.liq.${derived.liquor}`)}</dd>
      </dl>
      <p className="m-0 text-xs text-muted-foreground">{t("radiology.usg.bio.noSex")}</p>
    </section>
  );
}

const ORGANS: readonly { key: string; normal: string; other: string[] }[] = [
  { key: "liver", normal: "Liver normal in size and echotexture.", other: ["Liver shows grade I fatty change.", "Liver is enlarged."] },
  { key: "gb", normal: "Gall bladder normal, no calculus.", other: ["Gall bladder shows a calculus.", "Gall bladder wall is thickened."] },
  { key: "cbd", normal: "CBD not dilated.", other: ["CBD is dilated."] },
  { key: "pancreas", normal: "Pancreas normal.", other: ["Pancreas obscured by bowel gas."] },
  { key: "spleen", normal: "Spleen normal in size.", other: ["Spleen is enlarged."] },
  { key: "kidneys", normal: "Both kidneys normal in size and echotexture; no calculus or hydronephrosis.", other: ["Renal calculus seen.", "Hydronephrosis seen."] },
  { key: "bladder", normal: "Urinary bladder normal.", other: ["Urinary bladder wall is thickened."] },
];

function Organs({ organs, onOrgans, editable }: { organs: Record<string, string>; onOrgans: (o: Record<string, string>) => void; editable: boolean }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section className="space-y-2" data-testid="usg-organs">
      <h2 className="text-base font-semibold">{t("radiology.usg.organs.title")}</h2>
      {!editable ? <p className="text-xs text-muted-foreground">{t("radiology.usg.bio.startFirst")}</p> : null}
      {ORGANS.map((o) => (
        <div key={o.key} className="flex flex-wrap items-center gap-1 text-sm">
          <span className="w-28 shrink-0">{t(`radiology.usg.organs.${o.key}`)}</span>
          {[o.normal, ...o.other].map((s, i) => (
            <button key={s} type="button" disabled={!editable} aria-pressed={organs[o.key] === s}
              className={`rounded border px-2 py-0.5 ${organs[o.key] === s ? (i === 0 ? "border-green-700 bg-green-50" : "border-red-700 bg-red-50") : ""}`}
              onClick={() => onOrgans({ ...organs, [o.key]: s })}>
              {s}
            </button>
          ))}
        </div>
      ))}
      <button type="button" disabled={!editable} className="rounded border px-3 py-1 text-sm"
        onClick={() => onOrgans(Object.fromEntries(ORGANS.map((o) => [o.key, organs[o.key] ?? o.normal])))}>
        {t("radiology.usg.organs.allNormal")}
      </button>
    </section>
  );
}

function ReportStep({ ob, findings, impression, onFindings, onImpression, editable, derived }: {
  ob: boolean; findings: string; impression: string; onFindings: (v: string) => void; onImpression: (v: string) => void;
  editable: boolean; derived: ObstetricDerived | null;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section className="space-y-3" data-testid="usg-report">
      <h2 className="text-base font-semibold">{t("radiology.usg.report.title")}</h2>
      <label className="block text-sm">{t("radiology.report.findings")}
        <textarea className={field} rows={6} value={findings} readOnly={!editable} data-testid="usg-findings" onChange={(e) => onFindings(e.target.value)} />
      </label>
      <label className="block text-sm">{t("radiology.report.impression")}
        <textarea className={field} rows={3} value={impression} readOnly={!editable} data-testid="usg-impression" onChange={(e) => onImpression(e.target.value)} />
      </label>
      {ob && derived !== null && derived.gaByScanDays !== null
        ? <p className="m-0 text-xs text-muted-foreground">{t("radiology.usg.report.biometryRides", { ga: formatGa(derived.gaByScanDays), edd: fmtDay(derived.eddByScan) })}</p>
        : null}
      {ob
        ? (
          <div className="rounded border border-green-700 bg-green-50 p-3 text-sm" data-testid="usg-declaration">
            <span className="tag">{t("radiology.usg.report.declaration")}</span>
            <p className="m-0 mt-1">{PCPNDT_REPORT_DECLARATION_EN}</p>
            <p className="m-0" lang="hi">{PCPNDT_REPORT_DECLARATION_HI}</p>
            <p className="m-0 mt-1 text-xs text-muted-foreground">{t("radiology.usg.report.declarationFixed")}</p>
          </div>
        )
        : null}
      <p className="m-0 text-xs text-muted-foreground">{t("radiology.usg.report.guardNote")}</p>
    </section>
  );
}

/* ═══════════════════════════ the Form F register ═══════════════════════════ */

const FIELD_ORDER: readonly FormFField[] = ["living_children", "relative_name", "referral", "lmp_or_weeks", "indication", "patient_declaration", "sonologist_declaration"];

function istMonth(offset = 0): string {
  const d = new Date(Date.now() + 5.5 * 3_600_000);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.toISOString().slice(0, 7);
}

function MonthSwitch({ month, onMonth }: { month: string; onMonth: (m: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const choices = [istMonth(0), istMonth(-1)];
  return (
    <div className="flex flex-wrap gap-1 text-sm" data-testid="usg-month">
      {choices.map((c, i) => (
        <button key={c} type="button" aria-pressed={month === c}
          className={`rounded border px-3 py-1 ${month === c ? "border-green-700 bg-green-50 font-semibold" : ""}`}
          onClick={() => onMonth(c)}>
          {t(i === 0 ? "radiology.usg.month.this" : "radiology.usg.month.last")} · <span className="mo">{c}</span>
        </button>
      ))}
    </div>
  );
}

function FormFRegisterView({ views }: { views: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  const [month, setMonth] = useState(istMonth(0));
  const q = useQuery({ queryKey: ["radiology", "pcpndt", "register", month], queryFn: () => fetchFormFRegister(month) });
  const rows = q.data?.rows ?? [];
  const cnt = (s: WireRegisterRow["state"]) => rows.filter((r) => r.state === s).length;
  const gapsList = (
    <section aria-label={t("radiology.usg.register.gaps")} data-testid="usg-gaps">
      <h2 className="tag m-0 mb-2">{t("radiology.usg.register.gaps")}</h2>
      <ul className="m-0 list-none space-y-1 p-0 text-sm">
        {(q.data?.serials ?? []).map((b) => (
          <li key={b.deviceResourceId} className="rounded border bg-card p-2">
            <b className="mo">{b.deviceCode ?? "?"} {b.year}</b> · 0001 → {String(b.minted).padStart(4, "0")}
            {b.gaps.length === 0
              ? <span className="text-green-800"> · {t("radiology.usg.register.noGap")}</span>
              : <span className="text-red-700"> · {t("radiology.usg.register.gap", { serials: b.gaps.map((n) => String(n).padStart(4, "0")).join(", ") })}</span>}
          </li>
        ))}
        {(q.data?.serials ?? []).length === 0 ? <li className="text-muted-foreground">{t("radiology.usg.register.noSerials")}</li> : null}
      </ul>
    </section>
  );
  return (
    <RadiologyStation
      station="usg" views={views} title={t("radiology.usg.register.title")} place={t("radiology.usg.register.place")}
      stats={[
        { label: t("radiology.usg.register.opened"), value: rows.length },
        { label: t("radiology.usg.state.verified"), value: cnt("verified"), tone: "live" },
        { label: t("radiology.usg.register.notVerified"), value: cnt("open") + cnt("recorded"), tone: cnt("open") + cnt("recorded") > 0 ? "danger" : "plain" },
        { label: t("radiology.usg.state.cancelled"), value: cnt("cancelled") },
      ]}
      list={gapsList}
    >
      <div className="space-y-3">
        <MonthSwitch month={month} onMonth={setMonth} />
        <p className="m-0 text-xs text-muted-foreground">{t("radiology.usg.register.noNames")}</p>
        {q.isError ? <UsgRefusal error={q.error} machine="" /> : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm" data-testid="usg-register">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="p-1">{t("radiology.usg.register.serial")}</th>
                <th className="p-1">{t("radiology.usg.register.opened")}</th>
                <th className="p-1">{t("radiology.usg.register.indication")}</th>
                <th className="p-1">{t("radiology.usg.lane.status")}</th>
                <th className="p-1">{t("radiology.usg.register.signedBy")}</th>
                <th className="p-1">{t("radiology.usg.register.missing")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.formFId} data-state={r.state} className={`border-t ${r.state === "open" || r.state === "recorded" ? "bg-amber-50" : ""}`}>
                  <td className="mo p-1"><a className="underline" href={`/pcpndt/form-f/${r.studyId}`}>{r.serial}</a></td>
                  <td className="mo p-1">{r.openedAt.slice(0, 10)}</td>
                  <td className="p-1">{r.indicationCode}</td>
                  <td className="p-1">{t(`radiology.usg.state.${r.state}`)}</td>
                  <td className="p-1">{r.signedByName ?? "—"}{r.verifiedByName !== null ? ` → ${r.verifiedByName}` : ""}</td>
                  <td className="p-1 text-xs">{FIELD_ORDER.filter((f) => r.missing.includes(f)).map((f) => t(`radiology.usg.field.${f}`)).join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && !q.isPending ? <p className="text-sm text-muted-foreground">{t("radiology.usg.register.empty")}</p> : null}
      </div>
    </RadiologyStation>
  );
}

/* ═══════════════════════════ the §19 registration ═══════════════════════════ */

const daysTo = (day: string): number => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${istDay(Date.now())}T00:00:00Z`)) / 86_400_000);

function RegistrationView({ views }: { views: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["pcpndt", "registrations"], queryFn: fetchPcpndtRegistrations });
  const book = q.data?.registrations ?? [];
  const live = book.filter((b) => b.registration.status === "active");
  const clocks = (
    <ul className="m-0 list-none space-y-1 p-0 text-sm" data-testid="usg-reg-clocks">
      {live.map((b) => {
        const left = daysTo(b.registration.validTo);
        return (
          <li key={b.registration.id} className={left <= 90 ? "text-red-700" : ""}>
            {t("radiology.usg.reg.renewClock", { no: b.registration.registrationNo, date: fmtDay(b.registration.validTo), days: left })}
          </li>
        );
      })}
      {live.length === 0 ? <li className="text-red-700">{t("radiology.usg.reg.noneLive")}</li> : null}
    </ul>
  );
  const soon = live.some((b) => daysTo(b.registration.validTo) <= 90);
  return (
    <RadiologyStation
      station="usg" views={views} title={t("radiology.usg.reg.title")} place={t("radiology.usg.reg.place")}
      stats={[
        { label: t("radiology.usg.reg.certificates"), value: live.length },
        { label: t("radiology.usg.reg.machines"), value: live.reduce((a, b) => a + b.machines.filter((m) => m.active).length, 0) },
        { label: t("radiology.usg.reg.persons"), value: live.reduce((a, b) => a + b.persons.filter((p) => p.active).length, 0) },
      ]}
      clocks={clocks} clocksAlert={soon || live.length === 0}
      clocksSummary={live.length === 0 ? t("radiology.usg.reg.noneLive") : soon ? t("radiology.usg.reg.renewSoon") : t("radiology.usg.reg.renewFine")}
    >
      <div className="space-y-4" data-testid="usg-registration">
        {q.isError ? <UsgRefusal error={q.error} machine="" /> : null}
        {book.length === 0 && !q.isPending
          ? <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">{t("radiology.usg.reg.empty")}</p>
          : null}
        {book.map((b) => {
          const machines = b.machines.filter((m) => m.active);
          return (
            <section key={b.registration.id} className="space-y-3 rounded border bg-card p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="m-0 text-base font-semibold mo">{b.registration.registrationNo}</h2>
                <span className="text-sm">{b.registration.site} · {t(`radiology.usg.reg.status.${b.registration.status}`, { defaultValue: b.registration.status })}</span>
              </div>
              <p className="m-0 text-sm">{t("radiology.usg.reg.valid", { from: fmtDay(b.registration.validFrom), to: fmtDay(b.registration.validTo) })}</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[32rem] text-sm">
                  <thead><tr className="text-left text-xs text-muted-foreground">
                    <th className="p-1">{t("radiology.usg.reg.machine")}</th><th className="p-1">{t("radiology.usg.reg.makeModel")}</th>
                    <th className="p-1">{t("radiology.usg.reg.serial")}</th><th className="p-1">{t("radiology.usg.reg.formB")}</th>
                  </tr></thead>
                  <tbody>
                    {b.machines.map((m) => (
                      <tr key={m.id} className={`border-t ${m.active ? "" : "opacity-60"}`}>
                        <td className="mo p-1">{m.deviceCode ?? "?"}{m.active ? "" : ` · ${t("radiology.usg.reg.withdrawn")}`}</td>
                        <td className="p-1">{m.make} {m.model}</td>
                        <td className="mo p-1">{m.serial}</td>
                        <td className="mo p-1">{m.formBRef ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3 className="m-0 text-sm font-semibold">{t("radiology.usg.reg.whoMay")}</h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[32rem] text-sm" data-testid="usg-matrix">
                  <thead><tr className="text-left text-xs text-muted-foreground">
                    <th className="p-1">{t("radiology.usg.reg.person")}</th><th className="p-1">{t("radiology.usg.reg.qualification")}</th>
                    {machines.map((m) => <th key={m.id} className="mo p-1">{m.deviceCode ?? "?"}</th>)}
                  </tr></thead>
                  <tbody>
                    {b.persons.map((p) => (
                      <tr key={p.id} className={`border-t ${p.active ? "" : "opacity-60"}`}>
                        <td className="p-1">{p.fullName ?? "—"}{p.councilRegNo === null ? "" : <span className="mo text-xs"> · {p.councilRegNo}</span>}</td>
                        <td className="p-1 text-xs">{p.qualification}</td>
                        {machines.map((m) => <td key={m.id} className="p-1">{p.active ? "✓" : "—"}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="m-0 text-xs text-muted-foreground">{t("radiology.usg.reg.membershipNote")}</p>
            </section>
          );
        })}
        <p className="m-0 text-xs text-muted-foreground">{t("radiology.usg.reg.ownerAct")}</p>
      </div>
    </RadiologyStation>
  );
}

/* ═══════════════════════════ the monthly return ═══════════════════════════ */

function MonthlyReturnView({ views }: { views: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  const dayOfMonth = Number(istDay(Date.now()).slice(8, 10));
  /** Up to the 5th, the return being prepared is LAST month's. */
  const [month, setMonth] = useState(dayOfMonth <= 5 ? istMonth(-1) : istMonth(0));
  const q = useQuery({ queryKey: ["radiology", "pcpndt", "monthly", month], queryFn: () => fetchMonthlyReturn(month) });
  const r = q.data ?? null;
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    if (r === null) return;
    const clip = (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    if (clip === undefined) return;
    void clip.writeText(r.csv).then(() => setCopied(true));
  };
  const copyRef = useRef(copy);
  copyRef.current = copy;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag)) return;
      if (e.key === "Enter") { e.preventDefault(); copyRef.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const discrepancies = r?.discrepancies ?? [];
  const list = (
    <section aria-label={t("radiology.usg.monthly.discrepancies")} data-testid="usg-discrepancies">
      <h2 className="tag m-0 mb-2">{t("radiology.usg.monthly.discrepancies")} · {discrepancies.length}</h2>
      <ul className="m-0 list-none space-y-1 p-0 text-sm">
        {discrepancies.map((d, i) => (
          <li key={`${d.kind}-${d.serial ?? d.accessionNo ?? String(i)}`} className="rounded border bg-card p-2" data-kind={d.kind}>
            <b className="mo">{d.serial ?? d.accessionNo ?? "—"}</b>
            <span className="block text-xs">{t(`radiology.usg.monthly.kind.${d.kind}`, { fields: (d.missing ?? []).map((f) => t(`radiology.usg.field.${f}`)).join(", ") })}</span>
            {d.studyId !== null && d.kind !== "serial_gap"
              ? <a className="text-xs underline" href={`/pcpndt/form-f/${d.studyId}`}>{t("radiology.usg.monthly.openForm")}</a>
              : null}
          </li>
        ))}
        {discrepancies.length === 0 && r !== null ? <li className="text-green-800">{t("radiology.usg.monthly.clean")}</li> : null}
      </ul>
    </section>
  );
  return (
    <RadiologyStation
      station="usg" views={views} title={t("radiology.usg.monthly.title")} place={t("radiology.usg.monthly.place")}
      stats={r === null ? [] : [
        { label: t("radiology.usg.monthly.scans"), value: r.totals.scans },
        { label: t("radiology.usg.monthly.pcpndt"), value: r.totals.pcpndtScans },
        { label: t("radiology.usg.monthly.verified"), value: r.totals.formF.verified, tone: "live" },
        { label: t("radiology.usg.monthly.short"), value: r.totals.short, tone: r.totals.short > 0 ? "danger" : "plain" },
        { label: t("radiology.usg.monthly.due"), value: r.daysLeft >= 0 ? t("radiology.usg.monthly.daysLeft", { days: r.daysLeft }) : t("radiology.usg.monthly.overdue"), tone: r.daysLeft < 3 ? "danger" : "waiting" },
      ]}
      list={list}
    >
      <div className="flex min-h-full flex-col">
        <div className="flex-1 space-y-3">
          <MonthSwitch month={month} onMonth={(m) => { setMonth(m); setCopied(false); }} />
          {q.isError ? <UsgRefusal error={q.error} machine="" /> : null}
          {r !== null
            ? (
              <>
                <p className="m-0 text-sm" data-testid="usg-due">{t("radiology.usg.monthly.dueBy", { date: fmtDay(r.dueBy) })}</p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[36rem] text-sm" data-testid="usg-return">
                    <thead><tr className="text-left text-xs text-muted-foreground">
                      <th className="p-1">{t("radiology.usg.reg.machine")}</th>
                      <th className="p-1 text-right">{t("radiology.usg.monthly.scans")}</th>
                      <th className="p-1 text-right">{t("radiology.usg.monthly.pcpndt")}</th>
                      <th className="p-1 text-right">{t("radiology.usg.monthly.opened")}</th>
                      <th className="p-1 text-right">{t("radiology.usg.monthly.recorded")}</th>
                      <th className="p-1 text-right">{t("radiology.usg.monthly.verified")}</th>
                      <th className="p-1 text-right">{t("radiology.usg.monthly.short")}</th>
                    </tr></thead>
                    <tbody>
                      {r.machines.map((m) => (
                        <tr key={m.deviceResourceId} className={`border-t ${m.short > 0 ? "bg-red-50" : ""}`}>
                          <td className="p-1"><b className="mo">{m.code}</b> <span className="text-xs">{m.registrationNo ?? t("radiology.usg.monthly.unregistered")}</span></td>
                          <td className="mo p-1 text-right">{m.scans}</td>
                          <td className="mo p-1 text-right">{m.pcpndtScans}</td>
                          <td className="mo p-1 text-right">{m.formF.opened}</td>
                          <td className="mo p-1 text-right">{m.formF.recorded}</td>
                          <td className="mo p-1 text-right">{m.formF.verified}</td>
                          <td className="mo p-1 text-right">{m.short}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <label className="block text-sm">{t("radiology.usg.monthly.csv")}
                  <textarea className={`${field} mo text-xs`} rows={5} readOnly value={r.csv} data-testid="usg-csv" />
                </label>
                <p className="m-0 text-xs text-muted-foreground">{t("radiology.usg.monthly.humanAct")}</p>
              </>
            )
            : null}
        </div>
        <div className="sticky bottom-0 -mx-1 mt-3 flex flex-wrap items-center gap-3 rounded border bg-card p-3 shadow-sm" data-testid="usg-monthly-dock">
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            {copied ? t("radiology.usg.monthly.copied") : discrepancies.length > 0 ? t("radiology.usg.monthly.closeFirst", { count: discrepancies.length }) : t("radiology.usg.monthly.copyHint")}
          </span>
          <button type="button" data-testid="usg-copy" className="rounded bg-green-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={r === null} onClick={copy}>
            {t("radiology.usg.monthly.copy")} <span className="kb">Enter</span>
          </button>
        </div>
      </div>
    </RadiologyStation>
  );
}
