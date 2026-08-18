import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../lib/api";
import { listDepartments, listDoctors, opdErrorMessage, todayIst } from "../lib/opd-api";
import type { WireDangerFlag, WireDoctorSummary, WireEncounter, WireOpdConfig, WireVitals } from "../lib/opd-api";
import { useRealtime } from "../lib/realtime";
import { FormKit, SelectField, TextField } from "../components/form-kit";
import { Button } from "@/components/ui/button";

/**
 * The vitals desk (D4 / Task 14): the registered-visits worklist, keyboard-first vitals capture
 * with BAND-AWARE required fields, the danger-flag banner and quick allergy capture. This screen is
 * used by an assistant moving through patients one after another without touching the mouse — a
 * successful save auto-advances to the next worklist row.
 *
 * THE SERVER IS AUTHORITATIVE (WEB CONVENTIONS): the band computed here from the patient's age is a
 * MIRROR of modules/opd/vitals-rules.ts's bandFor, never the authority — the server refuses an
 * incomplete submission (400 vitals_incomplete) regardless of what this screen's stars say, and that
 * refusal is rendered, not swallowed. A 404 from GET /patients/:id is a DOMAIN ANSWER (the patients
 * module hides a confidential record's existence, §14/D-37) — it renders "restricted record" and
 * falls back to the adult band, never a crash.
 */
const POLL_MS = 15_000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
type VitalKey = "heightCm" | "weightKg" | "sbp" | "dbp" | "pulse" | "rr" | "spo2" | "tempC";

/** UTC instant → IST 'HH:MM'. Arithmetic, no Intl — the opd-desk.tsx / opd-appointments.tsx technique,
 * duplicated deliberately: opd-api.ts is not in this task's Files list. */
function fmtIst(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

function patientLabel(p: { name: string | null; alias: string | null; restricted: boolean } | null | undefined): string {
  if (!p) return "—";
  return p.restricted ? (p.alias ?? "—") : (p.name ?? "—");
}

function ErrorLine({ message }: { message: string | null }): React.ReactElement | null {
  if (message === null) return null;
  return <p role="alert" className="text-sm text-red-600">{message}</p>;
}

// ——— the client-side MIRROR of modules/opd/vitals-rules.ts's bandFor + modules/opd/time.ts's ageYearsAt ———

type BandConfig = {
  key: "infant" | "child_1_5" | "child_6_12" | "adult";
  upToAgeYears: number | null;
  required: string[];
};
type DangerRangesConfig = { weightRequiredUnderYears: number; bands: BandConfig[] };

/** Same UTC-based whole-years calculation as modules/opd/time.ts's ageYearsAt — a mirror, not the authority. */
function ageYearsAt(dobIso: string, at: Date): number {
  const dob = new Date(dobIso);
  const years = at.getUTCFullYear() - dob.getUTCFullYear();
  const notYet = at.getUTCMonth() < dob.getUTCMonth() || (at.getUTCMonth() === dob.getUTCMonth() && at.getUTCDate() < dob.getUTCDate());
  return notYet ? years - 1 : years;
}

/** The band whose EXCLUSIVE upper bound the age is below; unknown age → the adult tail (mirrors bandFor). */
function bandFor(ageYears: number | null, cfg: DangerRangesConfig): BandConfig {
  const tail = cfg.bands[cfg.bands.length - 1]!;
  if (ageYears === null) return tail;
  return cfg.bands.find((b) => b.upToAgeYears !== null && ageYears < b.upToAgeYears) ?? tail;
}

// ——— wire shapes this screen reads that aren't in opd-api.ts (patients.controller.ts / allergies.ts) ———

type PatientDetailRow = { uhid: string; name: string | null; alias: string | null; dob: string | null; sex: string };
type AllergyRow = { id: string; substance: string; severity: "mild" | "moderate" | "severe" | null; status: string };

type WorklistItem = Omit<WireEncounter, "patient"> & {
  patient: { name: string | null; alias: string | null; restricted: boolean; uhid: string } | null;
  queueEntry: { tokenNo: number } | null;
};

// ——— the vitals form: z.preprocess coerces every numeric field, blank → undefined (§3.19) ———

/**
 * §3.19 — register() hands back a STRING for every `<input type="number">` (and every other
 * control). The coercion lives HERE, at the resolver, so the body that reaches the wire already
 * carries numbers. Written as `.transform().pipe()` rather than `z.preprocess` — the identical
 * choice opd-admin.tsx's schedules form makes and documents (K41): `z.preprocess`'s `z.input` type
 * collapses to `unknown`, which does not typecheck against `useForm`'s declared field-value shape,
 * where `.transform().pipe()` keeps `z.input` as the honest string the DOM actually holds.
 */
const numOrBlank = z.string().transform((v) => (v.trim() === "" ? undefined : Number(v))).pipe(z.number().optional());
const strOrBlank = z.string().transform((v) => (v.trim() === "" ? undefined : v)).pipe(z.string().optional());

const vitalsFormSchema = z.object({
  heightCm: numOrBlank, weightKg: numOrBlank, sbp: numOrBlank, dbp: numOrBlank,
  pulse: numOrBlank, rr: numOrBlank, spo2: numOrBlank, tempC: numOrBlank,
  notes: strOrBlank,
});
type VitalsFormInput = z.input<typeof vitalsFormSchema>;
type VitalsFormValues = z.output<typeof vitalsFormSchema>;
const EMPTY_VITALS: VitalsFormInput = {
  heightCm: "", weightKg: "", sbp: "", dbp: "", pulse: "", rr: "", spo2: "", tempC: "", notes: "",
};

const allergySchema = z.object({ substance: z.string().min(1), severity: z.enum(["", "mild", "moderate", "severe"]) });
type AllergyFormValues = z.infer<typeof allergySchema>;
const EMPTY_ALLERGY: AllergyFormValues = { substance: "", severity: "" };

export function OpdVitals(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const today = todayIst();

  const [departmentId, setDepartmentId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dangerFlags, setDangerFlags] = useState<WireDangerFlag[] | null>(null);
  const [missingFields, setMissingFields] = useState<string[] | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const advanceTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
  }, []);

  const departments = useQuery({ queryKey: ["opd", "departments"], queryFn: listDepartments, refetchInterval: POLL_MS });
  const doctors = useQuery({ queryKey: ["opd", "doctors"], queryFn: listDoctors, refetchInterval: POLL_MS });
  const config = useQuery({ queryKey: ["opd", "config"], queryFn: () => api<WireOpdConfig>("GET", "/opd/config") });
  const summary = useQuery({
    queryKey: ["opd", "queues", "summary", departmentId, today],
    queryFn: () => api<{ items: WireDoctorSummary[] }>(
      "GET", `/opd/queues/summary?departmentId=${departmentId}&serviceDate=${today}`,
    ),
    enabled: departmentId !== "",
    refetchInterval: POLL_MS,
  });
  const visits = useQuery({
    queryKey: ["opd", "visits", "registered", departmentId],
    queryFn: () => api<{ items: WorklistItem[] }>(
      "GET", `/opd/visits?status=registered${departmentId !== "" ? `&departmentId=${departmentId}` : ""}`,
    ),
    refetchInterval: POLL_MS,
  });
  const worklistItems = visits.data?.items ?? [];

  // D6: a visit.opened frame on the department's doctors' queue topics is a HINT to re-read the
  // worklist. Correctness rides the 15 s poll above; a missed frame costs seconds, never correctness.
  const topics = departmentId === "" ? [] : (summary.data?.items ?? []).map((s) => `queue:${s.doctor.id}:${today}`);
  useRealtime(topics, () => {
    void queryClient.invalidateQueries({ queryKey: ["opd", "visits"] });
  });

  const selectedRow = worklistItems.find((v) => v.id === selectedId) ?? null;
  const patientId = selectedRow?.patientId ?? null;

  const patientQuery = useQuery({
    queryKey: ["patient", patientId ?? ""],
    queryFn: () => api<{ patient: PatientDetailRow; resolvedFrom: string | null }>("GET", `/patients/${patientId}`),
    enabled: patientId !== null,
    retry: false,
  });
  const restricted = patientQuery.isError && patientQuery.error instanceof ApiError && patientQuery.error.status === 404;
  const allergiesQuery = useQuery({
    queryKey: ["patient-allergies", patientId ?? ""],
    queryFn: () => api<{ items: AllergyRow[] }>("GET", `/patients/${patientId}/allergies`),
    enabled: patientId !== null && !restricted,
  });

  const ageYears = !restricted && patientQuery.data?.patient.dob ? ageYearsAt(patientQuery.data.patient.dob, new Date()) : null;
  const dangerRanges = config.data?.dangerRanges as DangerRangesConfig | undefined;
  const band = dangerRanges ? bandFor(ageYears, dangerRanges) : null;
  const requiredSet = new Set<string>(band?.required ?? []);
  if (dangerRanges && ageYears !== null && ageYears < dangerRanges.weightRequiredUnderYears) requiredSet.add("weightKg");

  const starLabel = (key: VitalKey): string => {
    const base = t(`opdVitals.field.${key}`);
    return requiredSet.has(key) ? `${base} *` : base;
  };
  const doctorNameOf = (id: string | null): string => {
    if (id === null) return "—";
    return doctors.data?.items.find((d) => d.id === id)?.displayName ?? "—";
  };

  const form = useForm<VitalsFormInput, unknown, VitalsFormValues>({
    resolver: zodResolver(vitalsFormSchema), defaultValues: EMPTY_VITALS,
  });
  const allergyForm = useForm<AllergyFormValues>({ resolver: zodResolver(allergySchema), defaultValues: EMPTY_ALLERGY });

  const selectRow = (id: string): void => {
    if (advanceTimer.current !== null) { window.clearTimeout(advanceTimer.current); advanceTimer.current = null; }
    setSelectedId(id);
    setDangerFlags(null);
    setMissingFields(null);
    setSubmitError(null);
    form.reset(EMPTY_VITALS);
    allergyForm.reset(EMPTY_ALLERGY);
  };

  const advanceToNext = (): void => {
    const ids = worklistItems.map((v) => v.id);
    const idx = selectedId === null ? -1 : ids.indexOf(selectedId);
    const nextId = idx >= 0 ? (ids[idx + 1] ?? null) : null;
    setSelectedId(nextId);
    setDangerFlags(null);
    setMissingFields(null);
    form.reset(EMPTY_VITALS);
  };

  // K46: NUMBERS are posted as numbers, and a blank optional field is OMITTED — never "", never null.
  const submitVitals = form.handleSubmit(async (values) => {
    if (selectedId === null) return;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v !== undefined) body[k] = v;
    }
    setSubmitError(null);
    setMissingFields(null);
    try {
      const res = await api<{ vitals: WireVitals; flags: WireDangerFlag[]; encounter: WireEncounter }>(
        "POST", `/opd/visits/${selectedId}/vitals`, body,
      );
      await queryClient.invalidateQueries({ queryKey: ["opd", "visits"] });
      if (res.flags.length > 0) {
        setDangerFlags(res.flags);
        advanceTimer.current = window.setTimeout(() => { advanceToNext(); }, 4_000);
      } else {
        advanceToNext();
      }
    } catch (e) {
      if (e instanceof ApiError) {
        const errBody = e.body as { code?: string; detail?: { missing?: string[] } } | null;
        if (errBody?.code === "vitals_incomplete" && Array.isArray(errBody.detail?.missing)) {
          setMissingFields(errBody.detail!.missing);
          return;
        }
      }
      setSubmitError(opdErrorMessage(e));
    }
  });

  const submitAllergy = allergyForm.handleSubmit(async (v) => {
    if (patientId === null) return;
    await api("POST", `/patients/${patientId}/allergies`, {
      substance: v.substance,
      ...(v.severity !== "" ? { severity: v.severity } : {}),
      source: "vitals",
    });
    await queryClient.invalidateQueries({ queryKey: ["patient-allergies", patientId] });
    allergyForm.reset(EMPTY_ALLERGY);
  });

  return (
    <div className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t("opdVitals.title")}</h1>
      <div className="grid gap-6 lg:grid-cols-3">
        {/* (a) the registered-visits worklist */}
        <div className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="vitals-department">{t("opd.labels.department")}</label>
          <select
            id="vitals-department"
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            className="w-full rounded border px-2 py-1"
          >
            <option value="">{t("opdVitals.allDepartments")}</option>
            {(departments.data?.items ?? []).map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>

          <h2 className="pt-2 text-sm font-semibold">{t("opdVitals.worklist")}</h2>
          <div data-testid="worklist" className="space-y-2">
            {worklistItems.length === 0 && <p className="text-sm text-neutral-500">{t("opdVitals.empty")}</p>}
            {worklistItems.map((item) => (
              <button
                key={item.id}
                type="button"
                data-testid={`worklist-row-${item.id}`}
                onClick={() => selectRow(item.id)}
                className={`block w-full rounded border p-2 text-left text-sm ${selectedId === item.id ? "border-blue-500 bg-blue-50" : ""}`}
              >
                <span data-testid={`token-${item.id}`} className="tabular-nums">{item.queueEntry?.tokenNo ?? "—"}</span>
                {" · "}
                <span>{patientLabel(item.patient)}</span>
                {" · "}
                <span className="font-mono text-xs">{item.patient?.uhid ?? "—"}</span>
                {" · "}
                <span>{doctorNameOf(item.doctorId)}</span>
                {" · "}
                <span>{fmtIst(item.openedAt)}</span>
              </button>
            ))}
          </div>
        </div>

        {/* (b) the patient panel + the keyboard-first vitals form */}
        <div className="space-y-3 lg:col-span-2">
          {selectedId === null && <p className="text-sm text-neutral-500">{t("opdVitals.pickRowHint")}</p>}

          {selectedId !== null && (
            <>
              <div className="rounded border p-3">
                {restricted && (
                  <p data-testid="restricted-banner" className="text-sm text-amber-700">{t("opdVitals.restricted")}</p>
                )}
                {!restricted && patientQuery.data && (
                  <>
                    <h2 data-testid="patient-panel-name" className="text-lg font-semibold">
                      {patientQuery.data.patient.name ?? patientQuery.data.patient.alias ?? "—"}
                    </h2>
                    <p className="font-mono text-xs text-neutral-600">{patientQuery.data.patient.uhid}</p>
                    <p className="text-sm text-neutral-600">
                      {t("opdVitals.age", { age: ageYears ?? "—" })} · {patientQuery.data.patient.sex}
                    </p>
                  </>
                )}
                {band !== null && <p data-testid="band-label" className="text-sm">{t(`opdVitals.band.${band.key}`)}</p>}

                {!restricted && (
                  <div className="pt-2">
                    <h3 className="text-sm font-semibold">{t("patient.allergies")}</h3>
                    <ul data-testid="allergy-list" className="text-sm">
                      {(allergiesQuery.data?.items ?? []).map((a) => (
                        <li key={a.id}>
                          {a.substance}{a.severity !== null ? ` (${t(`patient.${a.severity}`)})` : ""}
                        </li>
                      ))}
                    </ul>
                    <FormProvider {...allergyForm}>
                      <FormKit onSubmit={submitAllergy} className="mt-2 flex flex-wrap items-end gap-2">
                        <TextField name="substance" label={t("patient.substance")} className="w-40" />
                        <SelectField
                          name="severity"
                          label={t("patient.severity")}
                          className="w-32"
                          options={[
                            { value: "", label: t("opdVitals.severityNone") },
                            { value: "mild", label: t("patient.mild") },
                            { value: "moderate", label: t("patient.moderate") },
                            { value: "severe", label: t("patient.severe") },
                          ]}
                        />
                        <Button type="submit" size="sm">{t("patient.addAllergy")}</Button>
                      </FormKit>
                    </FormProvider>
                  </div>
                )}
              </div>

              <div className="rounded border p-3">
                <h3 className="text-sm font-semibold">{t("opdVitals.vitalsTitle")}</h3>
                <FormProvider {...form}>
                  <FormKit onSubmit={submitVitals}>
                    <TextField name="heightCm" label={starLabel("heightCm")} type="number" autoFocus />
                    <TextField name="weightKg" label={starLabel("weightKg")} type="number" />
                    <TextField name="sbp" label={starLabel("sbp")} type="number" />
                    <TextField name="dbp" label={starLabel("dbp")} type="number" />
                    <TextField name="pulse" label={starLabel("pulse")} type="number" />
                    <TextField name="rr" label={starLabel("rr")} type="number" />
                    <TextField name="spo2" label={starLabel("spo2")} type="number" />
                    <TextField name="tempC" label={starLabel("tempC")} type="number" />
                    <TextField name="notes" label={t("opdVitals.field.notes")} />
                    <Button type="submit">{t("opdVitals.submit")}</Button>
                  </FormKit>
                </FormProvider>
                {dangerFlags !== null && dangerFlags.map((f, i) => (
                  <p key={i} role="alert" className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
                    {t("opdVitals.danger", { vital: t(`opdVitals.field.${f.vital}`), value: f.value, limit: f.limit })}
                  </p>
                ))}
                {missingFields !== null && (
                  <p role="alert" className="mt-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    {t("opdVitals.incomplete", { fields: missingFields.map((k) => t(`opdVitals.field.${k}`)).join(", ") })}
                  </p>
                )}
                <ErrorLine message={submitError} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
