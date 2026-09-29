import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type React from "react";
import {
  fetchReadiness, radiologyErrorCode, radiologyErrorText, satisfyGate, startAcquisition,
} from "../../lib/radiology-api";
import {
  DOSE_FIELDS, REPEAT_REASONS, abortAcquisition, aboveDrl, fetchRoomView, paediatricBand, recordRepeat,
  sendAcquired, startAtBedside, suggestedContrastMl,
} from "../../lib/radiology-room-api";
import type { AcquiredBody, RepeatReason, WireProtocol, WireRoomView } from "../../lib/radiology-room-api";
import type { WireGate } from "../../lib/radiology-api";
import { SeatLink } from "./imaging-counter";

/**
 * PLAN 18-S RS6 — **THE ROOM CONSOLE: Identify → Protocol → Acquire → Send.**
 *
 * The board's `room:console` (`docs/design/2026-09-28-radiology-stations/`, station "Modality
 * rooms"). The patient is on the table because the technologist opened them; every step below
 * reads the server and sends intents:
 *
 *   · **Identify** closes the ROOM gates — `identity_two_factor` (the second identifier is compared
 *     with the patient master by the server) and `laterality_confirm` (the patient points). Any
 *     other open gate belongs to the PREP bay: it is shown with a link to `/radiology/prep` and the
 *     dock stays shut. The console never satisfies a prep gate.
 *   · **Protocol** is the HOD's published book (`imaging_protocols`), with the contrast volume for
 *     this weight and the breath-hold words in English and Hindi. "No protocol published" is said
 *     plainly — the book is guidance, not a gate.
 *   · **Acquire** starts, records repeats and aborts; the dose fields are the modality's, and a
 *     number above the published DRL asks for a reason (never blocks). A refusal names the seat
 *     that fixes it.
 *   · **Send** records the acquisition with the image source; the study leaves this list and
 *     appears on the reading worklist.
 *
 * `mode="bedside"` is the portable round's use (T3): the same flow, with the bedside radiation
 * checklist before Start, attested as text on the start.
 */

export const ROOM_GATES = ["identity_two_factor", "laterality_confirm"] as const;
const STEPS = ["identify", "protocol", "acquire", "send"] as const;
type Step = (typeof STEPS)[number];

/** Where each refusal at the machine is fixed — the words stay the server's. */
const ROOM_REMEDY: Record<string, { to: string; key: string } | undefined> = {
  device_not_licensed: { to: "/radiology/radiation-safety", key: "radiology.room.fix.licence" },
  device_unavailable: { to: "/radiology/room?view=downtime", key: "radiology.room.fix.downtime" },
  /** The registry's refusal for a machine that is in use OR out of service (its message names which). */
  already_occupied: { to: "/radiology/room?view=downtime", key: "radiology.room.fix.downtime" },
  payment_required: { to: "/radiology/reception", key: "radiology.room.fix.desk" },
  not_ready: { to: "/radiology/prep", key: "radiology.room.fix.prep" },
  gate_open: { to: "/radiology/prep", key: "radiology.room.fix.prep" },
  machine_not_registered: { to: "/radiology/radiation-safety", key: "radiology.room.fix.pcpndt" },
  form_f_missing: { to: "/radiology/worklist", key: "radiology.room.fix.formF" },
};

type Refused = { code: string | null; message: string };

export function RoomRefusal({ r }: { r: Refused }): React.ReactElement {
  const { t } = useTranslation();
  const fix = r.code === null ? undefined : ROOM_REMEDY[r.code];
  return (
    <div role="alert" data-refusal={r.code ?? "unknown"} className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900">
      <p className="m-0">{r.message}</p>
      {fix !== undefined && <p className="m-0 mt-1"><SeatLink to={fix.to}>{t(fix.key)}</SeatLink></p>}
    </div>
  );
}

const refusedOf = (e: unknown): Refused => ({ code: radiologyErrorCode(e), message: radiologyErrorText(e) });
const num = (s: string): number | null => (s.trim() === "" || Number.isNaN(Number(s)) ? null : Number(s));
const field = "w-full rounded border bg-background px-2 py-1 text-sm";

function Line({ ok, title, children }: { ok: boolean | null; title: React.ReactNode; children?: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-start gap-2 border-b py-2 last:border-b-0" data-ok={ok === null ? "na" : String(ok)}>
      <span aria-hidden className={`mt-0.5 inline-block h-3 w-3 shrink-0 rounded-full ${ok === true ? "bg-green-700" : ok === false ? "bg-amber-500" : "bg-slate-300"}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {children}
      </div>
    </div>
  );
}

function Card({ title, children, testid }: { title: React.ReactNode; children: React.ReactNode; testid?: string }): React.ReactElement {
  return (
    <section className="rounded border bg-card" data-testid={testid}>
      <h3 className="m-0 border-b px-3 py-2 text-sm font-semibold">{title}</h3>
      <div className="px-3 py-1">{children}</div>
    </section>
  );
}

export function RoomConsole({ studyId, mode = "room", onDone }: {
  studyId: string;
  mode?: "room" | "bedside";
  /** The study was sent: the station clears the patient in hand. */
  onDone: (accessionNo: string) => void;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const roomQ = useQuery({ queryKey: ["radiology", "room", studyId], queryFn: () => fetchRoomView(studyId) });
  const gatesQ = useQuery({ queryKey: ["radiology", "gates", studyId], queryFn: () => fetchReadiness(studyId) });
  const v: WireRoomView | undefined = roomQ.data?.study;
  const gates: WireGate[] = gatesQ.data?.gates ?? [];

  const [step, setStep] = useState<Step>("identify");
  const [refused, setRefused] = useState<Refused | null>(null);
  /* Identify */
  const [nameSaid, setNameSaid] = useState(false);
  const [idKind, setIdKind] = useState<"wristband" | "uhid" | "dob">("wristband");
  const [idValue, setIdValue] = useState("");
  /* Protocol */
  const [lang, setLang] = useState<"en" | "hi">(i18n.language === "hi" ? "hi" : "en");
  const [weight, setWeight] = useState("");
  /* Bedside checklist (T3) */
  const [bay, setBay] = useState({ distance: false, apron: false, pregnancy: false });
  /* Acquire */
  const [dose, setDose] = useState<Record<string, string>>({});
  const [drlReason, setDrlReason] = useState("");
  const [contrastGiven, setContrastGiven] = useState<boolean | null>(null);
  const [agent, setAgent] = useState("");
  const [volume, setVolume] = useState("");
  const [notGivenReason, setNotGivenReason] = useState("");
  const [repeatReason, setRepeatReason] = useState<RepeatReason>("positioning");
  const [abortOpen, setAbortOpen] = useState(false);
  const [abortReason, setAbortReason] = useState("");
  /* Send */
  const [source, setSource] = useState<"pacs" | "no_pacs_images">("pacs");
  const [uid, setUid] = useState<string | null>(null);

  const started = v?.status === "in_acquisition";
  useEffect(() => { if (started) setStep((s) => (s === "identify" || s === "protocol" ? "acquire" : s)); }, [started]);
  useEffect(() => {
    if (v?.patient.weight !== null && v?.patient.weight !== undefined && weight === "") setWeight(String(v.patient.weight.kg));
  }, [v?.patient.weight, weight]);

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ["radiology", "room", studyId] });
    void qc.invalidateQueries({ queryKey: ["radiology", "gates", studyId] });
    void qc.invalidateQueries({ queryKey: ["radiology", "room-list"] });
  };
  const ok = (): void => { setRefused(null); refresh(); };
  const fail = (e: unknown): void => { setRefused(refusedOf(e)); refresh(); };

  const satisfy = useMutation({
    mutationFn: ({ kind, evidence }: { kind: string; evidence: unknown }) => satisfyGate(studyId, kind, evidence),
    onSuccess: ok, onError: fail,
  });
  const bedsideText = t("radiology.room.bedside.evidence");
  const start = useMutation({
    mutationFn: () => (mode === "bedside" ? startAtBedside(studyId, bedsideText) : startAcquisition(studyId)),
    onSuccess: () => { ok(); setStep("acquire"); },
    onError: fail,
  });
  const repeat = useMutation({ mutationFn: () => recordRepeat(studyId, repeatReason), onSuccess: ok, onError: fail });
  const abort = useMutation({
    mutationFn: () => abortAcquisition(studyId, abortReason.trim()),
    onSuccess: () => { setAbortOpen(false); setAbortReason(""); ok(); setStep("acquire"); },
    onError: fail,
  });

  const protocol: WireProtocol | null = v?.protocol.protocol ?? null;
  const kg = num(weight);
  const suggestion = protocol === null ? null : suggestedContrastMl(protocol, kg);
  const doseFields = v === undefined || !v.ionising ? [] : DOSE_FIELDS[v.modality] ?? [];
  const typed = Object.fromEntries(doseFields.map((f) => [f, num(dose[f] ?? "")]));
  const over = v === undefined ? [] : aboveDrl(v.drl, typed);
  const anyDose = doseFields.some((f) => typed[f] !== null);
  const contrastApplies = v !== undefined && v.contrastOption !== "none";
  const effectiveGiven = contrastGiven ?? (v?.contrastOption === "required");

  const body = (): AcquiredBody => {
    const b: AcquiredBody = { imageSource: source };
    if (source === "pacs") {
      const u = (uid ?? v?.mintedStudyInstanceUid ?? "").trim();
      if (u !== "" && u !== v?.mintedStudyInstanceUid) b.studyInstanceUid = u;
    }
    for (const f of doseFields) if (typed[f] !== null) (b as Record<string, unknown>)[f] = f === "fluoroSeconds" ? Math.round(typed[f]!) : typed[f];
    if (anyDose) b.doseManual = true;
    if (over.length > 0 && drlReason.trim() !== "") b.drlReason = drlReason.trim();
    if (contrastApplies) {
      b.contrastGiven = effectiveGiven;
      if (effectiveGiven) {
        if (agent.trim() !== "") b.contrastAgent = agent.trim();
        const vol = num(volume);
        if (vol !== null) b.contrastVolumeMl = vol;
      } else if (v?.contrastOption === "required" && notGivenReason.trim() !== "") {
        b.contrastNotGivenReason = notGivenReason.trim();
      }
    }
    return b;
  };
  const send = useMutation({
    mutationFn: () => sendAcquired(studyId, body()),
    onSuccess: (r) => { setRefused(null); refresh(); void qc.invalidateQueries({ queryKey: ["radiology", "worklist"] }); onDone(r.accessionNo); },
    onError: fail,
  });

  /* ── gate facts ── */
  const gate = (k: string) => gates.find((g) => g.kind === k);
  const idGate = gate("identity_two_factor");
  const sideGate = gate("laterality_confirm");
  const prepOpen = gates.filter((g) => g.state === "open" && !(ROOM_GATES as readonly string[]).includes(g.kind));
  const roomOpen = gates.filter((g) => g.state === "open" && (ROOM_GATES as readonly string[]).includes(g.kind));
  const bayClear = mode !== "bedside" || (bay.distance && bay.apron && bay.pregnancy);
  const identified = roomOpen.length === 0;

  /* ── the dock: ONE next act ── */
  let dock: { label: string; hint: string; run: (() => void) | null; danger?: boolean };
  if (v === undefined) dock = { label: t("common.loading"), hint: "", run: null };
  else if (step === "identify") {
    dock = prepOpen.length > 0
      ? { label: t("radiology.room.dock.toProtocol"), hint: t("radiology.room.dock.prepHold"), run: null }
      : !identified
      ? { label: t("radiology.room.dock.toProtocol"), hint: t("radiology.room.dock.identifyFirst"), run: null }
      : { label: t("radiology.room.dock.toProtocol"), hint: t("radiology.room.dock.identified"), run: () => setStep("protocol") };
  } else if (step === "protocol") {
    dock = { label: t("radiology.room.dock.toAcquire"), hint: t("radiology.room.dock.protocolHint"), run: () => setStep("acquire") };
  } else if (step === "acquire") {
    if (!started) {
      dock = !identified || prepOpen.length > 0
        ? { label: t("radiology.room.dock.start"), hint: t("radiology.room.dock.identifyFirst"), run: null }
        : !bayClear
        ? { label: t("radiology.room.dock.start"), hint: t("radiology.room.bedside.clearFirst"), run: null }
        : { label: t("radiology.room.dock.start"), hint: t("radiology.room.dock.startHint", { machine: v.device?.code ?? "" }), run: start.isPending ? null : () => start.mutate() };
    } else {
      dock = v.ionising && !anyDose
        ? { label: t("radiology.room.dock.toSend"), hint: t("radiology.room.dock.doseFirst"), run: null }
        : { label: t("radiology.room.dock.toSend"), hint: t("radiology.room.dock.sendHint"), run: () => setStep("send") };
    }
  } else {
    dock = !started
      ? { label: t("radiology.room.dock.send"), hint: t("radiology.room.dock.notStarted"), run: null }
      : { label: t("radiology.room.dock.send"), hint: t("radiology.room.dock.sendFinal"), run: send.isPending ? null : () => send.mutate() };
  }
  const dockRun = useRef(dock.run);
  dockRun.current = dock.run;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target !== null && ["TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName)) return;
      if (e.key === "Enter" && dockRun.current !== null) { e.preventDefault(); dockRun.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (roomQ.isError) return <RoomRefusal r={refusedOf(roomQ.error)} />;
  if (v === undefined) return <p>{t("common.loading")}</p>;

  const stepIndex = STEPS.indexOf(step);

  return (
    <div className="flex min-h-full flex-col" data-testid="room-console" data-step={step} data-state={v.status}>
      <div className="rounded border bg-card p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-base font-semibold" data-testid="console-patient">{v.patient.name}</span>
          <span className="mo text-xs">{v.accessionNo}</span>
        </div>
        <p className="m-0 text-xs text-muted-foreground">
          {v.priority === "stat" ? <b className="text-red-700">STAT · </b> : null}
          {v.studyTypeName} · {t(`radiology.room.state.${v.status}`, { defaultValue: v.status })}
          {v.bedsideLocation !== null ? ` · ${v.bedsideLocation}` : ""}
        </p>
      </div>

      <ol className="m-0 mt-3 flex list-none flex-wrap gap-1 p-0" aria-label={t("radiology.room.steps")}>
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              type="button" aria-current={step === s ? "step" : undefined}
              data-testid={`step-${s}`}
              className={`rounded border px-3 py-1 text-sm ${step === s ? "border-green-700 bg-green-50 font-semibold" : ""}`}
              onClick={() => setStep(s)}
            >
              <span className="mo text-xs">{String(i + 1).padStart(2, "0")}</span> {t(`radiology.room.step.${s}`)}
            </button>
          </li>
        ))}
      </ol>

      <div className="flex-1 space-y-3 py-3">
        {refused !== null && <RoomRefusal r={refused} />}

        {stepIndex === 0 && (
          <>
            {mode === "bedside" && (
              <Card title={t("radiology.room.bedside.title")} testid="bedside-checklist">
                {(["distance", "apron", "pregnancy"] as const).map((k) => (
                  <label key={k} className="flex items-start gap-2 border-b py-2 text-sm last:border-b-0">
                    <input type="checkbox" checked={bay[k]} onChange={(e) => setBay((b) => ({ ...b, [k]: e.target.checked }))} data-testid={`bay-${k}`} />
                    <span>{t(`radiology.room.bedside.${k}`)}</span>
                  </label>
                ))}
              </Card>
            )}
            <Card title={t("radiology.room.identify.title")} testid="identify">
              {idGate === undefined
                ? <Line ok={null} title={t("radiology.room.identify.noGate")} />
                : idGate.state !== "open"
                ? <Line ok title={t("radiology.room.identify.done", { state: t(`radiology.room.gateState.${idGate.state}`, { defaultValue: idGate.state }) })} />
                : (
                  <>
                    <Line ok={nameSaid} title={t("radiology.room.identify.first")}>
                      <label className="mt-1 flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={nameSaid} onChange={(e) => setNameSaid(e.target.checked)} data-testid="id-first" />
                        {t("radiology.room.identify.firstSaid", { name: v.patient.name, age: v.patient.ageYears ?? "—" })}
                      </label>
                    </Line>
                    <Line ok={false} title={t("radiology.room.identify.second")}>
                      <div className="mt-1 grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
                        <select className={field} value={idKind} aria-label={t("radiology.room.identify.kind")}
                          onChange={(e) => setIdKind(e.target.value as typeof idKind)} data-testid="id-kind">
                          {(["wristband", "uhid", "dob"] as const).map((k) => <option key={k} value={k}>{t(`radiology.room.identify.kinds.${k}`)}</option>)}
                        </select>
                        <input className={`${field} mo`} value={idValue} onChange={(e) => setIdValue(e.target.value)}
                          placeholder={idKind === "dob" ? "YYYY-MM-DD" : t("radiology.room.identify.scanHint")}
                          aria-label={t("radiology.room.identify.value")} data-testid="id-value" />
                        <button type="button" className="rounded border px-3 py-1 text-sm font-medium disabled:opacity-50"
                          disabled={!nameSaid || idValue.trim() === "" || satisfy.isPending} data-testid="id-check"
                          onClick={() => satisfy.mutate({ kind: "identity_two_factor", evidence: { secondIdentifier: idKind, value: idValue.trim() } })}>
                          {t("radiology.room.identify.check")}
                        </button>
                      </div>
                      <p className="m-0 mt-1 text-xs text-muted-foreground">{t("radiology.room.identify.never")}</p>
                    </Line>
                  </>
                )}
              {sideGate !== undefined && (
                sideGate.state !== "open"
                  ? <Line ok title={t("radiology.room.side.done", { side: t(`radiology.room.side.${v.laterality}`, { defaultValue: v.laterality }) })} />
                  : (
                    <Line ok={false} title={t("radiology.room.side.title", { side: v.laterality === "na" ? t("radiology.room.side.notRecorded") : t(`radiology.room.side.${v.laterality}`, { defaultValue: v.laterality }) })}>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {(["left", "right", "bilateral"] as const).map((s) => (
                          <button key={s} type="button" className="rounded border px-3 py-1 text-sm" data-testid={`side-${s}`}
                            disabled={satisfy.isPending}
                            onClick={() => satisfy.mutate({ kind: "laterality_confirm", evidence: { patientStated: s } })}>
                            {t("radiology.room.side.points", { side: t(`radiology.room.side.${s}`) })}
                          </button>
                        ))}
                      </div>
                      <p className="m-0 mt-1 text-xs text-muted-foreground">{t("radiology.room.side.never")}</p>
                    </Line>
                  )
              )}
            </Card>
            {prepOpen.length > 0 && (
              <div role="note" data-testid="prep-open" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950">
                <p className="m-0">{t("radiology.room.prepOpen", { gates: prepOpen.map((g) => t(`radiology.gate.${g.kind}`, { defaultValue: g.kind })).join(", ") })}</p>
                <p className="m-0 mt-1"><SeatLink to="/radiology/prep">{t("radiology.room.fix.prep")}</SeatLink></p>
              </div>
            )}
          </>
        )}

        {stepIndex === 1 && (
          protocol === null
            ? (
              <div role="note" data-testid="no-protocol" className="rounded border border-dashed p-3 text-sm">
                <p className="m-0">{v.protocol.book === "none" ? t("radiology.room.protocol.noBook") : t("radiology.room.protocol.noEntry", { study: v.studyTypeName })}</p>
                <p className="m-0 mt-1"><SeatLink to="/radiology/setup?view=books">{t("radiology.room.protocol.toBooks")}</SeatLink></p>
              </div>
            )
            : (
              <>
                <Card testid="protocol-card" title={<>{protocol.name}{v.protocol.matchedOn === "modality" ? <span className="ml-2 text-xs font-normal text-muted-foreground">{t("radiology.room.protocol.default")}</span> : null}<span className="mo ml-2 text-xs font-normal text-muted-foreground">v{v.protocol.version}</span></>}>
                  <p className="my-2 whitespace-pre-line text-sm">{protocol.technique}</p>
                  <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 pb-2 text-sm">
                    {protocol.preset !== undefined && <><dt className="text-muted-foreground">{t("radiology.room.protocol.preset")}</dt><dd className="m-0 mo">{protocol.preset}</dd></>}
                    {protocol.kv !== undefined && <><dt className="text-muted-foreground">kV</dt><dd className="m-0 mo">{protocol.kv.min}–{protocol.kv.max}</dd></>}
                    {protocol.mas !== undefined && <><dt className="text-muted-foreground">mAs</dt><dd className="m-0 mo">{protocol.mas.min}–{protocol.mas.max}</dd></>}
                    {protocol.ct !== undefined && <><dt className="text-muted-foreground">{t("radiology.room.protocol.slice")}</dt><dd className="m-0 mo">{protocol.ct.slice_mm} mm · pitch {protocol.ct.pitch}</dd></>}
                    {protocol.sequences !== undefined && <><dt className="text-muted-foreground">{t("radiology.room.protocol.sequences")}</dt><dd className="m-0">{protocol.sequences.join(" → ")}</dd></>}
                  </dl>
                </Card>
                {protocol.contrast !== undefined && (
                  <Card testid="protocol-contrast" title={t("radiology.room.protocol.contrast")}>
                    <p className="my-2 text-sm">
                      {t(`radiology.room.phase.${protocol.contrast.phase}`, { defaultValue: protocol.contrast.phase })}
                      {protocol.contrast.agent !== undefined ? ` · ${protocol.contrast.agent}` : ""}
                      {` · ${protocol.contrast.ml_per_kg} mL/kg · ${t("radiology.room.protocol.max", { ml: protocol.contrast.max_ml })} · ${t("radiology.room.protocol.delay", { s: protocol.contrast.delay_s })}`}
                      {protocol.contrast.rate_ml_s !== undefined ? ` · ${t("radiology.room.protocol.rate", { rate: protocol.contrast.rate_ml_s })}` : ""}
                    </p>
                    <label className="flex flex-wrap items-center gap-2 pb-2 text-sm">
                      {t("radiology.room.protocol.weight")}
                      <input className={`${field} mo w-24`} inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} data-testid="weight" />
                      <span data-testid="contrast-suggestion">
                        {suggestion === null ? t("radiology.room.protocol.needWeight") : t("radiology.room.protocol.suggest", { ml: suggestion })}
                      </span>
                    </label>
                  </Card>
                )}
                {paediatricBand(protocol, kg) !== null && (
                  <div role="note" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm" data-testid="paeds-band">
                    {(() => {
                      const b = paediatricBand(protocol, kg)!;
                      return t("radiology.room.protocol.band", { from: b.from_kg, to: b.to_kg }) + (b.kv !== undefined ? ` · kV ${b.kv.min}–${b.kv.max}` : "") + (b.mas !== undefined ? ` · mAs ${b.mas.min}–${b.mas.max}` : "") + (b.note !== undefined ? ` · ${b.note}` : "");
                    })()}
                  </div>
                )}
                {protocol.breath_hold !== undefined && (
                  <Card testid="breath-hold" title={<span className="flex items-center justify-between gap-2">{t("radiology.room.protocol.say")}
                    <span className="flex gap-1">
                      {(["en", "hi"] as const).map((l) => (
                        <button key={l} type="button" aria-pressed={lang === l} className={`rounded border px-2 text-xs ${lang === l ? "bg-muted font-semibold" : ""}`} onClick={() => setLang(l)}>{l === "en" ? "EN" : "हिं"}</button>
                      ))}
                    </span></span>}>
                    <p className="my-2 text-lg" lang={lang}>{protocol.breath_hold[lang]}</p>
                  </Card>
                )}
              </>
            )
        )}

        {stepIndex === 2 && (
          <>
            {!started
              ? (
                <p className="rounded border bg-card p-3 text-sm" data-testid="acquire-ready">
                  {identified && prepOpen.length === 0
                    ? t("radiology.room.acquire.clear", { machine: v.device?.code ?? "" })
                    : t("radiology.room.dock.identifyFirst")}
                </p>
              )
              : (
                <>
                  {v.ionising && (
                    <Card testid="dose" title={t("radiology.room.dose.title")}>
                      {doseFields.length === 0
                        ? <p className="my-2 text-sm">{t("radiology.room.dose.none")}</p>
                        : (
                          <div className="grid gap-2 py-2 sm:grid-cols-2">
                            {doseFields.map((f) => {
                              const level = v.drl.find((l) => ({ doseCtdivol: "ctdivol", doseDlp: "dlp", doseDap: "dap", fluoroSeconds: "fluoro_seconds" })[f] === l.quantity);
                              return (
                                <label key={f} className="text-sm">
                                  {t(`radiology.room.dose.${f}`)}
                                  <input className={`${field} mo`} inputMode="decimal" value={dose[f] ?? ""} data-testid={`dose-${f}`}
                                    onChange={(e) => setDose((d) => ({ ...d, [f]: e.target.value.replace(/[^\d.]/g, "") }))} />
                                  <span className="text-xs text-muted-foreground">{level === undefined ? t("radiology.room.dose.noLevel") : t("radiology.room.dose.level", { value: level.value })}</span>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      {over.length > 0 && (
                        <label className="block pb-2 text-sm" data-testid="drl-over">
                          <span className="text-amber-800">{t("radiology.room.dose.over")}</span>
                          <input className={field} value={drlReason} onChange={(e) => setDrlReason(e.target.value)} data-testid="drl-reason" placeholder={t("radiology.room.dose.reasonHint")} />
                        </label>
                      )}
                    </Card>
                  )}
                  {contrastApplies && (
                    <Card testid="contrast" title={t("radiology.room.contrast.title")}>
                      <div className="flex flex-wrap gap-3 py-2 text-sm">
                        <label className="flex items-center gap-2"><input type="radio" name="cg" checked={effectiveGiven} onChange={() => setContrastGiven(true)} data-testid="contrast-given" />{t("radiology.room.contrast.given")}</label>
                        <label className="flex items-center gap-2"><input type="radio" name="cg" checked={!effectiveGiven} onChange={() => setContrastGiven(false)} data-testid="contrast-not-given" />{t("radiology.room.contrast.notGiven")}</label>
                      </div>
                      {effectiveGiven
                        ? (
                          <div className="grid gap-2 pb-2 sm:grid-cols-2">
                            <label className="text-sm">{t("radiology.room.contrast.agent")}<input className={field} value={agent} onChange={(e) => setAgent(e.target.value)} placeholder={protocol?.contrast?.agent ?? ""} /></label>
                            <label className="text-sm">{t("radiology.room.contrast.volume")}<input className={`${field} mo`} inputMode="decimal" value={volume} onChange={(e) => setVolume(e.target.value)} placeholder={suggestion === null ? "" : String(suggestion)} data-testid="contrast-volume" /></label>
                          </div>
                        )
                        : v.contrastOption === "required"
                        ? (
                          <label className="block pb-2 text-sm">
                            <span className="text-amber-800">{t("radiology.room.contrast.reversal")}</span>
                            <input className={field} value={notGivenReason} onChange={(e) => setNotGivenReason(e.target.value)} data-testid="not-given-reason" placeholder={t("radiology.room.contrast.reasonHint")} />
                          </label>
                        )
                        : null}
                      <p className="m-0 pb-2 text-xs text-muted-foreground">
                        {t("radiology.room.contrast.reactionNote")} <SeatLink to="/radiology/prep">{t("radiology.room.fix.prep")}</SeatLink>
                      </p>
                    </Card>
                  )}
                  <Card testid="repeat-abort" title={t("radiology.room.repeat.title")}>
                    <div className="flex flex-wrap items-center gap-2 py-2 text-sm">
                      <select className={`${field} w-auto`} value={repeatReason} onChange={(e) => setRepeatReason(e.target.value as RepeatReason)} aria-label={t("radiology.room.repeat.reason")} data-testid="repeat-reason">
                        {REPEAT_REASONS.map((r) => <option key={r} value={r}>{t(`radiology.room.repeat.reasons.${r}`)}</option>)}
                      </select>
                      <button type="button" className="rounded border px-3 py-1" disabled={repeat.isPending} onClick={() => repeat.mutate()} data-testid="repeat">
                        {t("radiology.room.repeat.record")}
                      </button>
                      <span className="text-xs text-muted-foreground" data-testid="repeat-count">{t("radiology.room.repeat.count", { count: v.repeats.length })}</span>
                    </div>
                    <p className="m-0 pb-2 text-xs text-muted-foreground">{t("radiology.room.repeat.free")}</p>
                    {!abortOpen
                      ? <button type="button" className="mb-2 rounded border border-red-300 px-3 py-1 text-sm text-red-800" onClick={() => setAbortOpen(true)} data-testid="abort-open">{t("radiology.room.abort.open")}</button>
                      : (
                        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                          <input className={`${field} flex-1`} value={abortReason} onChange={(e) => setAbortReason(e.target.value)} placeholder={t("radiology.room.abort.reasonHint")} data-testid="abort-reason" />
                          <button type="button" className="rounded border border-red-400 bg-red-50 px-3 py-1 text-red-900 disabled:opacity-50" disabled={abortReason.trim() === "" || abort.isPending} onClick={() => abort.mutate()} data-testid="abort">{t("radiology.room.abort.go")}</button>
                          <button type="button" className="rounded border px-3 py-1" onClick={() => setAbortOpen(false)}>{t("radiology.room.abort.keep")}</button>
                        </div>
                      )}
                  </Card>
                </>
              )}
          </>
        )}

        {stepIndex === 3 && (
          <Card testid="send" title={t("radiology.room.send.title")}>
            <fieldset className="space-y-1 py-2 text-sm">
              <legend className="sr-only">{t("radiology.study.imageSource")}</legend>
              <label className="flex items-center gap-2"><input type="radio" name="src" checked={source === "pacs"} onChange={() => setSource("pacs")} />{t("radiology.study.sourcePacs")}</label>
              <label className="flex items-center gap-2"><input type="radio" name="src" checked={source === "no_pacs_images"} onChange={() => setSource("no_pacs_images")} data-testid="source-none" />{t("radiology.study.sourceNoImages")}</label>
              {source === "pacs" && (
                <label className="block">
                  {t("radiology.study.studyUid")}
                  <input className={`${field} mo`} value={uid ?? v.mintedStudyInstanceUid} onChange={(e) => setUid(e.target.value)} data-testid="study-uid" />
                  <span className="text-xs text-muted-foreground">{t("radiology.study.studyUidHint")}</span>
                </label>
              )}
            </fieldset>
            <p className="m-0 pb-2 text-xs text-muted-foreground">{t("radiology.room.send.after")}</p>
          </Card>
        )}
      </div>

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 rounded border bg-card p-3 shadow-sm" data-testid="room-dock">
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">{dock.hint}</span>
        <button
          type="button" data-testid="dock-act"
          className="rounded bg-green-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          disabled={dock.run === null}
          onClick={() => dock.run?.()}
        >
          {dock.label} <span className="kb">Enter</span>
        </button>
      </div>
    </div>
  );
}
