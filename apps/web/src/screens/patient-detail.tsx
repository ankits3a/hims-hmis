import { useEffect, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm, FormProvider } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { useCopilot } from "../lib/use-copilot";
import { CopilotReport } from "../components/copilot-report";
import { AgentDock } from "../components/agent-dock";
import type { AgentLine } from "../components/agent-dock";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { CONFIDENTIAL_CAPTURE_ENABLED } from "../lib/confidential-capture";
import { FormKit, TextField, SelectField, CheckboxField } from "../components/form-kit";
import { SubmitButton } from "../components/submit-button";
import { PatientPhoto } from "../components/patient-photo";
import { QrCard, type QrCardData } from "../components/qr-card";
import { PaperScreen } from "../components/paper-screen";
import { usePatientInHand } from "../lib/patient-in-hand";
import { ageOf } from "./desk-one/model";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AbdmVerifyPanel } from "../components/abdm-verify";
import { abhaCapability, getPatientDocument, listPatientDocuments } from "../lib/patients-api";
import { patientTimeline } from "../lib/opd-api";
import { listDues, listInvoicesFor } from "../lib/billing-api";
import { fetchPatientDispenses, fetchPatientImaging, fetchPatientResults } from "../lib/brief-history";
import { reportsForPatient } from "../lib/lab-api";
import { fmtPaise } from "../lib/format";
import {
  buildTimeline, dmy, dmyIst, duesSummary, groupByDay, istDay, maskMobile, openVisitsToday, type Labels,
} from "./patient-profile-model";
import "./patient-profile.css";

// Wire shapes (patients.controller.ts) — every Date column arrives JSON-serialized as an
// ISO string, so these are the on-the-wire types, not the drizzle $inferSelect ones.
type PatientRow = {
  id: string;
  uhid: string;
  name: string;
  phone: string | null;
  altPhone: string | null;
  dob: string | null;
  dobEstimated: boolean;
  sex: string;
  administrativeGender: string;
  identityAssurance: string;
  addressLine: string | null;
  district: string | null;
  stateName: string | null;
  pincode: string | null;
  language: string;
  bloodGroup: string | null;
  isConfidential: boolean;
  alias: string | null;
  sensitiveContext: boolean;
  abhaAddress: string | null;
  abhaNumber: string | null;
  abhaVerificationStatus: string;
  abhaLinkToken: string | null;
  legacyUhid: string | null;
  qrVersion: number;
  status: string;
  mergedIntoPatientId: string | null;
  promotionalOptIn: boolean;
  deceasedAt: string | null;
  /** OWNER RULING 2026-09-29 — optional: an older server sends none. */
  deathCertificateNo?: string | null;
  /** Registration instant, for "patient since". Optional: the row carries it, the type did not name it. */
  createdAt?: string;
};

type AllergyRow = {
  id: string;
  substance: string;
  reaction: string | null;
  severity: "mild" | "moderate" | "severe" | null;
  status: "active" | "entered_in_error";
  correctionReason: string | null;
};

type GuardianRow = {
  id: string;
  name: string;
  phone: string | null;
  relationship: string;
  authorityMessages: boolean;
  authorityConsents: boolean;
  authorityDsr: boolean;
  authorityBills: boolean;
  validTo: string | null;
  status: "active" | "ended" | "majority_ended";
};

/** FD-34 — `GET /patients/:id/linked` (modules/patients/linked.ts). Dates arrive ISO-serialized. */
type LinkedRow = {
  id: string;
  uhid: string;
  name: string;
  phone: string | null;
  altPhone: string | null;
  administrativeGender: string;
  dob: string | null;
  isConfidential: boolean;
  registeredOn: string;
  sharedOn: string[];
};
type LinkedWire = { numbers: string[]; items: LinkedRow[]; total: number };

type EffectiveAuthority = { messages: boolean; consents: boolean; dsr: boolean; bills: boolean };
type GuardianItem = { guardian: GuardianRow; effectiveAuthority: EffectiveAuthority };

const phonePattern = /^[6-9]\d{9}$/;

/**
 * UX-AUDIT 2026-09-29 · BOARD — "Restricted (sealed) patient: the alias is the name everywhere on
 * this page" (owner, 28-Sep). The server only sends a sealed row to a reader it has already allowed
 * (patients.confidential.read or a break-glass grant); this page still draws the alias, never the
 * real name, and leaves contact, address and family links undrawn.
 */
function shownName(p: PatientRow, restrictedLabel: string): string {
  if (!p.isConfidential) return p.name;
  return p.alias !== null && p.alias.trim() !== "" ? p.alias : restrictedLabel;
}

/**
 * A server refusal as the sentence it carries. The patients module answers `{ message: "code: sentence" }`;
 * `String(e)` printed "ApiError: API 400", which told the clerk nothing (found by this lane's refusal test).
 */
function refusal(e: unknown): string {
  if (e instanceof ApiError && typeof e.body === "object" && e.body !== null) {
    const m = (e.body as { message?: unknown }).message;
    const text = Array.isArray(m) ? m.join(" ") : typeof m === "string" ? m : null;
    if (text !== null && text !== "") {
      const sentence = text.replace(/^[a-z_]+:\s*/, "");
      return sentence.charAt(0).toUpperCase() + sentence.slice(1);
    }
  }
  return String(e);
}

function useGenderWord(): (g: string) => string {
  const { t } = useTranslation();
  return (g) => (["male", "female", "other", "unknown"].includes(g) ? t(`register.${g}`) : g);
}

/* ——— Promotional opt-in (D9, DPDP): revocable consent — a single-field PATCH, exact payload ——— */

function MessagesBox({ patient, canEdit }: { patient: PatientRow; canEdit: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const patientId = patient.id;
  const [open, setOpen] = useState(false);
  const [optIn, setOptIn] = useState(patient.promotionalOptIn);

  const save = async (idempotencyKey: string): Promise<void> => {
    await api("PATCH", `/patients/${patientId}`, { promotionalOptIn: optIn }, idempotencyKey);
    await queryClient.invalidateQueries({ queryKey: ["patient", patientId] });
    setOpen(false);
  };

  return (
    <section className="box" style={{ padding: "12px 14px" }} data-testid="profile-messages">
      <div className="tag">{t("profile.messages")}</div>
      <div style={{ fontSize: 12.5, marginTop: 4 }}>
        {patient.language === "hi" ? t("register.hindi") : t("register.english")} · {t("profile.promotional")}:{" "}
        <b>{patient.promotionalOptIn ? t("profile.yes") : t("profile.no")}</b>{" "}
        {canEdit && !open && (
          <button type="button" className="lnk" onClick={() => setOpen(true)}>{t("profile.change")}</button>
        )}
      </div>
      {patient.sensitiveContext && (
        <p style={{ fontSize: 11.5, color: "var(--red)", margin: "6px 0 0" }}>{t("patient.sealedBanner")}</p>
      )}
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          <label className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
            <input type="checkbox" data-field checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />
            {t("patient.promotionalOptIn")}
          </label>
          <SubmitButton plain className="pri" style={{ height: 32 }} onClick={save}>{t("patient.saveConsent")}</SubmitButton>
        </div>
      )}
    </section>
  );
}

/*
 * ——— Record a death (D10, D-33) — OWNER RULING 2026-09-29 (law) ———
 *
 * "Record a death" does not save without the death certificate number: for a death in this
 * hospital, the MCCD certificate (Form 4 / 4A) number. The server refuses it
 * (`death_certificate_required`); the screen says so first — the confirm stays disabled until a
 * number is typed — and shows the server's sentence if it refuses anyway.
 */
function RecordDeathDialog({ patient, open, onOpenChange }: { patient: PatientRow; open: boolean; onOpenChange: (o: boolean) => void }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [date, setDate] = useState(() => istDay(new Date().toISOString()));
  const [certNo, setCertNo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mark = async (idempotencyKey: string): Promise<void> => {
    if (certNo.trim() === "") { setError(t("profile.death.certRequired")); return; }
    setError(null);
    try {
      await api("PATCH", `/patients/${patient.id}`, { deceasedAt: `${date}T00:00:00.000Z`, deathCertificateNo: certNo.trim() }, idempotencyKey);
    } catch (e) {
      setError(refusal(e));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["patient", patient.id] });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="pp">
        <DialogHeader><DialogTitle>{t("profile.death.title")}</DialogTitle></DialogHeader>
        <p style={{ fontSize: 13 }}>{t("patient.markDeceasedWarning")}</p>
        <div>
          <label className="block text-sm font-medium" htmlFor="deceased-date">{t("patient.deceasedDate")}</label>
          <input id="deceased-date" data-field type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <p style={{ fontSize: 11.5, color: "var(--dim)", margin: "4px 0 0" }}>{dmy(date)}</p>
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="death-cert-no">{t("profile.death.certLabel")}</label>
          <input id="death-cert-no" data-field value={certNo} maxLength={60} onChange={(e) => setCertNo(e.target.value)} />
          <p style={{ fontSize: 11.5, color: "var(--dim)", margin: "4px 0 0" }}>{t("profile.death.certHint")}</p>
        </div>
        {error !== null && <p role="alert" style={{ color: "var(--red)", fontSize: 12.5 }}>{error}</p>}
        <div className="flex justify-end">
          <SubmitButton plain className="pri" onClick={mark} disabled={certNo.trim() === ""}>{t("patient.confirmDeceased")}</SubmitButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeceasedBanner({ patient, canClear }: { patient: PatientRow; canClear: boolean }): React.ReactElement | null {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  if (patient.deceasedAt === null) return null;
  const clear = async (idempotencyKey: string): Promise<void> => {
    await api("PATCH", `/patients/${patient.id}`, { deceasedAt: null }, idempotencyKey);
    await queryClient.invalidateQueries({ queryKey: ["patient", patient.id] });
  };
  const cert = patient.deathCertificateNo ?? null;
  return (
    <div className="banner dead" data-testid="deceased-banner">
      <span style={{ flex: 1 }}>
        <b>{t("patient.deceasedBanner", { date: dmy(patient.deceasedAt) })}</b>
        {cert !== null && <span style={{ color: "var(--dim)" }}> · {t("profile.death.cert", { number: cert })}</span>}
      </span>
      {canClear && <SubmitButton plain className="sec" onClick={clear}>{t("patient.clearDeceased")}</SubmitButton>}
    </div>
  );
}

/* ——— Demographics + ABHA: dirty-fields-only PATCH (T15 Step 2's exact onSave) ——— */

const patchSchema = z.object({
  name: z.string().min(1),
  phone: z.string().regex(phonePattern).optional().or(z.literal("")),
  altPhone: z.string().regex(phonePattern).optional().or(z.literal("")),
  dob: z.string().optional().or(z.literal("")),
  sex: z.enum(["male", "female", "other", "unknown"]),
  administrativeGender: z.enum(["male", "female", "other", "unknown"]),
  reasonClass: z.string().optional(),
  addressLine: z.string().optional(),
  district: z.string().optional(),
  stateName: z.string().optional(),
  pincode: z.string().regex(/^\d{6}$/).optional().or(z.literal("")),
  language: z.enum(["hi", "en"]),
  bloodGroup: z.string().optional(),
  isConfidential: z.boolean(),
  alias: z.string().optional(),
  sensitiveContext: z.boolean(),
  abhaAddress: z.string().optional(),
  abhaNumber: z.string().optional(),
  abhaVerificationStatus: z.enum(["none", "self_declared", "verified"]),
  legacyUhid: z.string().optional(),
});
type PatchFormValues = z.infer<typeof patchSchema>;

/**
 * ABDM S1 — "Verify with ABDM" on the patient's own record: drawn only when this hospital can verify
 * (the capability, asked under `patients.register` — a reader without it sees no button), and it
 * LINKS to this patient, through the server's one writer of `verified`. UX-AUDIT 2026-09-29 · BOARD:
 * it moved from the ABHA fieldset to "Less often"; the edit drawer is closed while it runs, and the
 * drawer builds its form from the refetched row when it next opens, so no stale ABHA is sent back.
 */
function AbdmVerifyAct({ patient }: { patient: PatientRow }): React.ReactElement | null {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const capability = useQuery({ queryKey: ["abha-capability"], queryFn: abhaCapability, staleTime: 5 * 60 * 1000, retry: false });
  if (capability.data?.canVerify !== true) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" data-testid="patient-abdm-verify">{t("abdm.verify.open")}</button>
      </DialogTrigger>
      <DialogContent className="pp">
        <DialogHeader><DialogTitle>{t("abdm.verify.title")}</DialogTitle></DialogHeader>
        <AbdmVerifyPanel
          mode="verify"
          patientId={patient.id}
          initialIdentifier={patient.abhaNumber ?? patient.abhaAddress ?? ""}
          onLinked={() => { void queryClient.invalidateQueries({ queryKey: ["patient", patient.id] }); }}
          onClose={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function DemographicsForm({ patient, onSaved }: { patient: PatientRow; onSaved: (dirty: boolean) => void }): React.ReactElement {
  const { t } = useTranslation();
  const abdmLocked = patient.abhaVerificationStatus === "verified";
  const restricted = patient.isConfidential;
  const queryClient = useQueryClient();
  const patientId = patient.id;
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<PatchFormValues>({
    resolver: zodResolver(patchSchema),
    defaultValues: {
      name: patient.name,
      phone: patient.phone ?? "",
      altPhone: patient.altPhone ?? "",
      dob: patient.dob !== null ? patient.dob.slice(0, 10) : "",
      sex: patient.sex as PatchFormValues["sex"],
      administrativeGender: patient.administrativeGender as PatchFormValues["administrativeGender"],
      reasonClass: "",
      addressLine: patient.addressLine ?? "",
      district: patient.district ?? "",
      stateName: patient.stateName ?? "",
      pincode: patient.pincode ?? "",
      language: patient.language as PatchFormValues["language"],
      bloodGroup: patient.bloodGroup ?? "",
      isConfidential: patient.isConfidential,
      alias: patient.alias ?? "",
      sensitiveContext: patient.sensitiveContext,
      abhaAddress: patient.abhaAddress ?? "",
      abhaNumber: patient.abhaNumber ?? "",
      abhaVerificationStatus: patient.abhaVerificationStatus as PatchFormValues["abhaVerificationStatus"],
      legacyUhid: patient.legacyUhid ?? "",
    },
  });
  const isDirty = form.formState.isDirty;
  useEffect(() => { onSaved(isDirty); }, [isDirty, onSaved]);

  const onSave = form.handleSubmit(async (values) => {
    const dirty = form.formState.dirtyFields as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(dirty)) {
      if (key === "reasonClass") continue; // context, never a column
      const v = (values as Record<string, unknown>)[key];
      patch[key] = v === "" ? null : v; // cleared inputs null the column (server treats null as a clear)
    }
    if (Object.keys(patch).length === 0) return;
    /**
     * PLAN 22c-A T7 — a Class I amendment carries its reason. The server refuses without one
     * (400 `reason_required`); catching it here means the clerk is told before the round-trip
     * rather than by an error banner. `sex` is deliberately NOT in this list: it is Class III, a
     * clinical correction, and asking for an identity reason to fix it would be the DD4 confusion
     * this phase exists to remove.
     */
    // CLOSE REVIEW n16 — kept in step with `modules/patients/identity.ts`'s CLASS_I, which
    // includes `dobEstimated`. No control writes it today; the lists drifting apart is the defect.
    const CLASS_I = ["name", "dob", "dobEstimated", "administrativeGender", "abhaNumber"];
    const touchesIdentity = Object.keys(patch).some((k) => CLASS_I.includes(k));
    if (touchesIdentity && (values.reasonClass ?? "") === "") {
      setServerError(t("patient.reasonRequired"));
      return;
    }
    if (touchesIdentity) patch.reasonClass = values.reasonClass;
    setServerError(null);
    try {
      await api("PATCH", `/patients/${patientId}`, patch);
      await queryClient.invalidateQueries({ queryKey: ["patient", patientId] });
      form.reset(values);
    } catch (e) {
      setServerError(refusal(e));
    }
  });

  const gender = [
    { value: "unknown", label: t("register.unknown") },
    { value: "female", label: t("register.female") },
    { value: "male", label: t("register.male") },
    { value: "other", label: t("register.other") },
  ];

  return (
    <FormProvider {...form}>
      <FormKit onSubmit={onSave} className="space-y-4">
        <section id="pf-identity">
          <h2>{t("profile.edit.identity")}</h2>
          {/* PLAN 22c-A T7 — the assurance stamp, surfaced so the desk can see how much the hospital
              vouches for this identity before it amends it. */}
          <p className="note" style={{ marginBottom: 8 }}>
            {t("patient.identityAssurance")}: <b>{t(`assurance.${patient.identityAssurance}`, patient.identityAssurance)}</b>
          </p>
          {/* ABDM S1 — DECIDED (NHA M1 workbook): while the ABHA is verified, name, birth and gender are ABDM's.
              The server refuses an amendment of them (409 `abha_demographics_locked`); the form says so first. */}
          {abdmLocked ? (
            <p data-testid="abdm-demographics-locked" className="note" style={{ marginBottom: 8 }}>{t("abdm.lock.note")}</p>
          ) : null}
          <div className="grid2">
            {/* Restricted: the real name is not in the form (owner, 28-Sep). It stays in the form's
                state, never dirty, so no PATCH carries it. */}
            {!restricted && <TextField name="name" label={t("register.name")} readOnly={abdmLocked} />}
            <div>
              <TextField name="dob" label={t("register.dob")} type="date" readOnly={abdmLocked} />
              <p className="note">{dmy(form.watch("dob") ?? "")}</p>
            </div>
            <SelectField name="administrativeGender" disabled={abdmLocked} label={t("patient.administrativeGender")} options={gender} />
            <SelectField name="sex" label={t("register.sex")} options={gender} />
            <TextField name="bloodGroup" label={t("register.bloodGroup")} />
            <TextField name="legacyUhid" label={t("register.legacyUhid")} />
          </div>
          <div style={{ marginTop: 10, padding: "10px 12px", border: "1px solid var(--gold-line)", background: "var(--gold-soft)", borderRadius: 6 }}>
            <SelectField
              name="reasonClass"
              label={t("patient.amendmentReason")}
              options={[
                { value: "", label: "—" },
                { value: "clerical_error", label: t("patient.amendmentReasons.clerical_error") },
                { value: "legal_change", label: t("patient.amendmentReasons.legal_change") },
                { value: "document_correction", label: t("patient.amendmentReasons.document_correction") },
                { value: "patient_request", label: t("patient.amendmentReasons.patient_request") },
                { value: "merge_reconciliation", label: t("patient.amendmentReasons.merge_reconciliation") },
              ]}
            />
            <p className="note" style={{ marginTop: 4 }}>{t("patient.reasonRequired")}</p>
          </div>
        </section>
        <section id="pf-contact">
          <h2>{t("profile.edit.contact")}</h2>
          {restricted ? (
            <p className="note">{t("profile.restricted.editHidden")}</p>
          ) : (
            <div className="grid2">
              <TextField name="phone" label={t("register.phone")} />
              <TextField name="altPhone" label={t("register.altPhone")} />
              <TextField name="addressLine" label={t("register.address")} className="col-span-2" />
              <TextField name="district" label={t("register.district")} />
              <TextField name="stateName" label={t("register.state")} />
              <TextField name="pincode" label={t("register.pincode")} />
            </div>
          )}
          <div className="grid2" style={{ marginTop: 10 }}>
            <SelectField
              name="language"
              label={t("register.language")}
              options={[{ value: "hi", label: t("register.hindi") }, { value: "en", label: t("register.english") }]}
            />
          </div>
          <div className="flex gap-6" style={{ marginTop: 10 }}>
            {/* DD5 — see lib/confidential-capture.ts. The form still HOLDS the record's current
                value, so it is never marked dirty and the PATCH omits it: an edit must not
                silently un-confidential a record that already is one. */}
            {CONFIDENTIAL_CAPTURE_ENABLED && <CheckboxField name="isConfidential" label={t("register.confidential")} />}
            <CheckboxField name="sensitiveContext" label={t("register.sensitive")} />
          </div>
          {CONFIDENTIAL_CAPTURE_ENABLED && form.watch("isConfidential") && <TextField name="alias" label={t("register.alias")} />}
        </section>
        <section id="pf-abha">
          <h2>{t("patient.abha")}</h2>
          <div className="grid2">
            <TextField name="abhaAddress" label={t("register.abhaAddress")} />
            <TextField name="abhaNumber" label={t("register.abhaNumber")} />
            {/* ABDM S0 — `verified` is ABDM's answer, never a clerk's pick: the server refuses a move to
                it (400 `abha_verified_only_by_abdm`). It is listed only so a record ABDM verified
                still SHOWS its stamp — and a clerk may still take the stamp down. */}
            <SelectField
              name="abhaVerificationStatus"
              label={t("profile.abhaStatus")}
              options={[
                { value: "none", label: t("profile.abha.none") },
                { value: "self_declared", label: t("profile.abha.self_declared") },
                ...(patient.abhaVerificationStatus === "verified" ? [{ value: "verified", label: t("profile.abha.verified") }] : []),
              ]}
            />
          </div>
        </section>
        {serverError !== null && <p role="alert" style={{ color: "var(--red)" }}>{serverError}</p>}
        <div style={{ position: "sticky", bottom: -24, background: "var(--card)", borderTop: "1px solid var(--line)", padding: "10px 0", display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ flex: 1, fontSize: 12, color: "var(--dim)" }}>{isDirty ? t("profile.edit.unsaved") : t("profile.edit.nothingChanged")}</span>
          <button className="pri" type="submit" disabled={form.formState.isSubmitting}>{t("patient.save")}</button>
        </div>
      </FormKit>
    </FormProvider>
  );
}

/* ——— Allergies: append-only, E-8 entered-in-error correction (never delete) ——— */

const addAllergySchema = z.object({
  substance: z.string().min(1),
  reaction: z.string().optional(),
  severity: z.enum(["mild", "moderate", "severe"]),
});
type AddAllergyValues = z.infer<typeof addAllergySchema>;

function AddAllergyDialog({ patientId }: { patientId: string }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const form = useForm<AddAllergyValues>({
    resolver: zodResolver(addAllergySchema),
    defaultValues: { substance: "", reaction: "", severity: "mild" },
  });

  const submit = form.handleSubmit(async (v) => {
    await api("POST", `/patients/${patientId}/allergies`, {
      substance: v.substance,
      ...(v.reaction !== undefined && v.reaction !== "" ? { reaction: v.reaction } : {}),
      severity: v.severity,
      source: "registration",
    });
    await queryClient.invalidateQueries({ queryKey: ["patient-allergies", patientId] });
    form.reset();
    setOpen(false);
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className="lnk" style={{ marginLeft: "auto" }} aria-label={t("patient.addAllergy")}>{t("profile.add")}</button>
      </DialogTrigger>
      <DialogContent className="pp">
        <DialogHeader><DialogTitle>{t("patient.addAllergy")}</DialogTitle></DialogHeader>
        <FormProvider {...form}>
          <FormKit onSubmit={submit}>
            <TextField name="substance" label={t("patient.substance")} autoFocus />
            <TextField name="reaction" label={t("patient.reaction")} />
            <SelectField
              name="severity"
              label={t("patient.severity")}
              options={[
                { value: "mild", label: t("patient.mild") },
                { value: "moderate", label: t("patient.moderate") },
                { value: "severe", label: t("patient.severe") },
              ]}
            />
            <button className="pri" type="submit">{t("patient.addAllergy")}</button>
          </FormKit>
        </FormProvider>
      </DialogContent>
    </Dialog>
  );
}

function EnteredInErrorDialog({ patientId, allergyId }: { patientId: string; allergyId: string }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const submit = async (): Promise<void> => {
    const trimmed = reason.trim();
    if (trimmed === "") return; // mandatory reason (E-8) — nothing to send without one
    await api("POST", `/patients/${patientId}/allergies/${allergyId}/entered-in-error`, { reason: trimmed });
    await queryClient.invalidateQueries({ queryKey: ["patient-allergies", patientId] });
    setReason("");
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className="sec">{t("patient.markError")}</button>
      </DialogTrigger>
      <DialogContent className="pp">
        <DialogHeader><DialogTitle>{t("patient.markError")}</DialogTitle></DialogHeader>
        <div>
          <label className="block text-sm font-medium" htmlFor="correction-reason">{t("patient.reason")}</label>
          <input id="correction-reason" data-field className="w-full" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="flex justify-end">
          <button className="pri" onClick={() => void submit()} disabled={reason.trim() === ""}>{t("patient.markError")}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function useAllergies(patientId: string): AllergyRow[] | undefined {
  return useQuery({
    queryKey: ["patient-allergies", patientId],
    queryFn: () => api<{ items: AllergyRow[] }>("GET", `/patients/${patientId}/allergies`),
  }).data?.items;
}

/** The lane's red band: active allergies only, severe in brick red; corrections live under Edit details. */
function AllergyBand({ patientId, canEdit, compact }: { patientId: string; canEdit: boolean; compact: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const items = useAllergies(patientId) ?? [];
  const active = items.filter((a) => a.status === "active");
  const corrected = items.length - active.length;
  const shown = compact ? active.slice(0, 1) : active;
  return (
    <div className="safety" data-testid="allergy-band">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span className="tag" style={{ color: "var(--red)" }}>
          {active.length === 0 ? t("profile.allergies.none") : t("profile.allergies.active", { count: active.length })}
        </span>
        {canEdit && <AddAllergyDialog patientId={patientId} />}
      </div>
      {shown.map((a) => (
        <div className="al" key={a.id}>
          <b>{a.substance}</b>
          <span style={{ flex: 1, color: a.reaction === null ? "var(--dim)" : undefined }}>{a.reaction ?? t("profile.allergies.noReaction")}</span>
          {a.severity !== null && <span className={a.severity === "severe" ? "sev s" : "sev"}>{t(`patient.${a.severity}`)}</span>}
        </div>
      ))}
      {compact && active.length > 1 && <div style={{ fontSize: 11, color: "var(--dim)" }}>{t("profile.allergies.more", { count: active.length - 1 })}</div>}
      {corrected > 0 && <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 4 }}>{t("profile.allergies.corrected", { count: corrected })}</div>}
    </div>
  );
}

function AllergiesSection({ patientId }: { patientId: string }): React.ReactElement {
  const { t } = useTranslation();
  const items = useAllergies(patientId);
  return (
    <section id="pf-allergies">
      <h2>{t("patient.allergies")}</h2>
      <div role="table" className="box" style={{ overflow: "hidden" }}>
        <div role="rowgroup">
          <div role="row" style={{ display: "flex", gap: 10, padding: "9px 13px", borderBottom: "1px solid var(--line2)" }}>
            <span role="columnheader" className="tag" style={{ flex: 1 }}>{t("patient.substance")}</span>
            <span role="columnheader" className="tag" style={{ flex: 1 }}>{t("patient.reaction")}</span>
            <span role="columnheader" className="tag" style={{ flex: 1 }}>{t("patient.severity")}</span>
            <span role="columnheader" className="tag" style={{ flex: 1 }} />
          </div>
        </div>
        <div role="rowgroup">
          {items?.map((a) => {
            const corrected = a.status === "entered_in_error";
            const strike = corrected ? "text-neutral-400 line-through" : "";
            return (
              <div role="row" className="drow" key={a.id}>
                <span role="cell" className={strike} style={{ flex: 1, fontSize: 12 }}>{a.substance}</span>
                <span role="cell" className={strike} style={{ flex: 1, fontSize: 12 }}>{a.reaction ?? "—"}</span>
                <span role="cell" className={strike} style={{ flex: 1, fontSize: 12 }}>{a.severity !== null ? t(`patient.${a.severity}`) : "—"}</span>
                <span role="cell" style={{ flex: 1, fontSize: 12 }}>
                  {corrected ? (
                    <span style={{ fontSize: 11, color: "var(--faint)" }}>{t("patient.reason")}: {a.correctionReason}</span>
                  ) : (
                    <EnteredInErrorDialog patientId={patientId} allergyId={a.id} />
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ——— Guardians / representative: computed effectiveAuthority (never the stored flags), add/end ——— */

function AuthorityBadge({ label, on }: { label: string; on: boolean }): React.ReactElement {
  return (
    <Badge variant={on ? "default" : "outline"} className={on ? undefined : "text-neutral-400 line-through"}>
      {label}
    </Badge>
  );
}

const RELATIONSHIPS = ["father", "mother", "legal_guardian", "other"] as const;

const addGuardianSchema = z.object({
  name: z.string().min(1),
  phone: z.string().regex(phonePattern).optional().or(z.literal("")),
  relationship: z.enum(RELATIONSHIPS),
  consentNote: z.string().optional(),
});
type AddGuardianValues = z.infer<typeof addGuardianSchema>;

function AddGuardianDialog({ patientId, open, onOpenChange }: { patientId: string; open: boolean; onOpenChange: (o: boolean) => void }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const form = useForm<AddGuardianValues>({
    resolver: zodResolver(addGuardianSchema),
    defaultValues: { name: "", phone: "", relationship: "father", consentNote: "" },
  });

  const submit = form.handleSubmit(async (v) => {
    await api("POST", `/patients/${patientId}/guardians`, {
      name: v.name,
      relationship: v.relationship,
      ...(v.phone !== undefined && v.phone !== "" ? { phone: v.phone } : {}),
      ...(v.consentNote !== undefined && v.consentNote !== "" ? { consentNote: v.consentNote } : {}),
    });
    await queryClient.invalidateQueries({ queryKey: ["patient-guardians", patientId] });
    form.reset();
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="pp">
        <DialogHeader><DialogTitle>{t("profile.addRepresentative")}</DialogTitle></DialogHeader>
        <FormProvider {...form}>
          <FormKit onSubmit={submit}>
            <TextField name="name" label={t("register.guardianName")} autoFocus />
            <TextField name="phone" label={t("register.guardianPhone")} />
            <SelectField
              name="relationship"
              label={t("register.relationship")}
              options={RELATIONSHIPS.map((r) => ({ value: r, label: t(`profile.relationship.${r}`) }))}
            />
            <TextField name="consentNote" label={t("register.consentNote")} />
            <button className="pri" type="submit">{t("patient.addGuardian")}</button>
          </FormKit>
        </FormProvider>
      </DialogContent>
    </Dialog>
  );
}

function GuardianCard({ patientId, item }: { patientId: string; item: GuardianItem }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const g = item.guardian;
  const ea = item.effectiveAuthority; // ALWAYS the server-computed field — never g.authority*
  const [editing, setEditing] = useState(false);
  const [messages, setMessages] = useState(g.authorityMessages);
  const [consents, setConsents] = useState(g.authorityConsents);
  const [dsr, setDsr] = useState(g.authorityDsr);
  const [bills, setBills] = useState(g.authorityBills);
  const [validTo, setValidTo] = useState(g.validTo !== null ? g.validTo.slice(0, 10) : "");

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ["patient-guardians", patientId] });

  const saveAuthority = async (): Promise<void> => {
    await api("PATCH", `/patients/${patientId}/guardians/${g.id}`, {
      messages, consents, dsr, bills,
      validTo: validTo === "" ? null : validTo,
    });
    await refresh();
    setEditing(false);
  };

  const end = async (): Promise<void> => {
    await api("POST", `/patients/${patientId}/guardians/${g.id}/end`);
    await refresh();
  };

  return (
    <div className="box" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="flex items-center justify-between">
        <div>
          <p style={{ fontWeight: 600, margin: 0 }}>
            {g.name} <span style={{ fontSize: 12, color: "var(--dim)", fontWeight: 400 }}>· {t(`profile.relationship.${g.relationship}`, g.relationship)}</span>
          </p>
          <p className="mo" style={{ fontSize: 12, color: "var(--dim)", margin: 0 }}>{g.phone === null ? "—" : maskMobile(g.phone)}</p>
        </div>
        {g.status === "majority_ended" && <Badge variant="outline">{t("patient.majorityEnded")}</Badge>}
      </div>
      <div className="flex flex-wrap gap-2">
        <AuthorityBadge label={t("patient.authMessages")} on={ea.messages} />
        <AuthorityBadge label={t("patient.authConsents")} on={ea.consents} />
        <AuthorityBadge label={t("patient.authDsr")} on={ea.dsr} />
        <AuthorityBadge label={t("patient.authBills")} on={ea.bills} />
      </div>
      {g.status === "active" && (
        <div className="flex gap-2">
          <button type="button" className="sec" onClick={() => setEditing((v) => !v)}>{t("patient.authority")}</button>
          <button type="button" className="sec" onClick={() => void end()}>{t("patient.endGuardian")}</button>
        </div>
      )}
      {editing && (
        <div className="flex flex-wrap items-center gap-3" style={{ border: "1px solid var(--line)", borderRadius: 6, padding: 8 }}>
          <label className="flex items-center gap-1"><input type="checkbox" checked={messages} onChange={(e) => setMessages(e.target.checked)} />{t("patient.authMessages")}</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={consents} onChange={(e) => setConsents(e.target.checked)} />{t("patient.authConsents")}</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={dsr} onChange={(e) => setDsr(e.target.checked)} />{t("patient.authDsr")}</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={bills} onChange={(e) => setBills(e.target.checked)} />{t("patient.authBills")}</label>
          <input type="date" aria-label={t("profile.validTo")} value={validTo} onChange={(e) => setValidTo(e.target.value)} />
          <button type="button" className="sec grn" onClick={() => void saveAuthority()}>{t("patient.save")}</button>
        </div>
      )}
    </div>
  );
}

function useGuardians(patientId: string, enabled: boolean): GuardianItem[] | undefined {
  return useQuery({
    queryKey: ["patient-guardians", patientId],
    queryFn: () => api<{ items: GuardianItem[] }>("GET", `/patients/${patientId}/guardians`),
    enabled,
  }).data?.items;
}

function GuardiansSection({ patient }: { patient: PatientRow }): React.ReactElement {
  const { t } = useTranslation();
  const items = useGuardians(patient.id, true);
  const [adding, setAdding] = useState(false);
  return (
    <section id="pf-representative">
      <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{t("profile.edit.representative")}</h2>
        <button type="button" className="sec grn" onClick={() => setAdding(true)}>{t("patient.addGuardian")}</button>
      </div>
      <AddGuardianDialog patientId={patient.id} open={adding} onOpenChange={setAdding} />
      {patient.sensitiveContext && (
        <p className="banner" style={{ border: "1px solid var(--red-line)", background: "var(--red-soft)", color: "var(--red)" }}>{t("patient.sealedBanner")}</p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items?.map((item) => <GuardianCard key={item.guardian.id} patientId={patient.id} item={item} />)}
        {items !== undefined && items.length === 0 && <p className="note">{t("profile.noRepresentative")}</p>}
      </div>
    </section>
  );
}

/**
 * ═══ UX-AUDIT 2026-09-29 · BOARD — "EDIT DETAILS", A DRAWER, NOT THE PAGE ═══
 *
 * The form that used to BE this screen opens over the timeline from the right; the lane stays in
 * view so the clerk still sees who and the allergies. Same dirty-fields PATCH, same identity reason,
 * same allergy corrections and guardian acts — moved, not changed. The section chips jump within
 * the one scrolling body (every field stays mounted), so they are anchors, not tabs.
 */
function EditDrawer({ patient, displayName, onClose }: { patient: PatientRow; displayName: string; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [, setDirty] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && document.querySelector("[role=dialog][data-state=open]") === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const jump = (id: string): void => { document.getElementById(id)?.scrollIntoView?.({ block: "start", behavior: "smooth" }); };
  return (
    <>
      <div className="pf-drawer-back" onClick={onClose} />
      <aside className="pf-drawer" role="dialog" aria-modal="true" aria-label={t("profile.edit.title", { name: displayName })} data-testid="edit-drawer">
        <div className="hd">
          <b>{t("profile.edit.title", { name: displayName })}</b>
          <button type="button" className="sec" style={{ height: 30 }} onClick={onClose}>{t("profile.close")} <span className="kb">Esc</span></button>
        </div>
        <div className="bd">
          <div className="jump">
            {(["identity", "contact", "abha", "allergies", "representative"] as const).map((s) => (
              <button type="button" key={s} className="chip" onClick={() => jump(`pf-${s}`)}>{t(`profile.edit.${s}`)}</button>
            ))}
          </div>
          <DemographicsForm patient={patient} onSaved={setDirty} />
          <AllergiesSection patientId={patient.id} />
          {!patient.isConfidential && <GuardiansSection patient={patient} />}
        </div>
      </aside>
    </>
  );
}

/**
 * ═══ FD-34 — THE FAMILY, ON THE RECORD THAT ALREADY KNEW ABOUT IT ═══
 *
 * Owner, 2026-09-13: Ankit's record must name Sunil when they share a mobile, and Sunil's must name
 * Ankit. The server derives both from one predicate (`modules/patients/linked.ts`). IT SAYS WHAT IT
 * KNOWS AND NOT ONE WORD MORE: "same mobile", never "wife" or "son". UX-AUDIT 2026-09-29 · BOARD —
 * it now sits in the lane under People, beside the one DECLARED relationship (the representative),
 * and the shared number is masked to its last four digits.
 */
function LinkedPatients({ patient }: { patient: PatientRow }): React.ReactElement | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const linked = useQuery({
    queryKey: ["patient-linked", patient.id],
    queryFn: () => api<LinkedWire>("GET", `/patients/${patient.id}/linked`),
    enabled: !patient.isConfidential,
  });

  // D-34 — a phoneless record is a designed path, and it has nothing to be asked about.
  if (patient.phone === null && patient.altPhone === null) return null;

  const items = linked.data?.items ?? [];
  const total = linked.data?.total ?? 0;
  const beyondCap = total - items.length;

  return (
    <div data-testid="linked-patients">
      <div className="fact">
        <span>{t("profile.sameMobile")}</span>
        {items.length === 0 ? (
          <span data-testid="linked-empty" style={{ color: "var(--dim)" }}>{t("patient.linked.none")}</span>
        ) : (
          <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
            {items.map((row) => {
              const age = ageOf(row.dob);
              return (
                <button
                  key={row.id}
                  type="button"
                  data-testid={`linked-${row.uhid}`}
                  style={{ textAlign: "right", color: "var(--green)", fontWeight: 500 }}
                  onClick={() => { void navigate({ to: "/patients/$patientId", params: { patientId: row.id } }); }}
                >
                  {row.isConfidential ? t("profile.restricted.pill") : row.name}
                  {age !== "" && /^\d+$/.test(age) && Number(age) < 18 ? ` (${age} y)` : ""}
                  <span className="mo" style={{ display: "block", fontSize: 10.5, color: "var(--dim)", fontWeight: 400 }}>
                    {t("patient.linked.shares", { number: row.sharedOn.map(maskMobile).join(", ") })}
                  </span>
                </button>
              );
            })}
          </span>
        )}
      </div>
      {beyondCap > 0 && (
        /* A NUMBER SHARED BY THIRTY RECORDS IS NOT A HOUSEHOLD — the list is capped at 20 server-side,
           and saying so is what stops a clerk reading the first twenty as "the family". */
        <p data-testid="linked-beyond-cap" style={{ fontSize: 11, color: "var(--dim)", margin: "4px 0 0" }}>
          {t("patient.linked.more", { count: beyondCap, total })}
        </p>
      )}
      <p style={{ margin: "4px 0 0", fontSize: 11, lineHeight: "15px", color: "var(--dim)" }}>{t("profile.sameMobileNote")}</p>
    </div>
  );
}

/* ——— The hospital card: print + reissue (D-23: every previously printed card dies at that moment) ——— */

function PrintCardDialog({ patient, open, onOpenChange, reissued }: {
  patient: PatientRow; open: boolean; onOpenChange: (o: boolean) => void; reissued: { qrVersion: number; payload: string } | null;
}): React.ReactElement {
  const { t } = useTranslation();
  const qr = useQuery({
    queryKey: ["qr-card", patient.id],
    queryFn: () => api<QrCardData>("GET", `/patients/${patient.id}/qr`),
    enabled: open,
  });
  // UX-AUDIT 2026-09-29 · BOARD — the QR payload carries the internal patient id; it is encoded in the
  // printed code and no longer printed as text on screen.
  const data: QrCardData | null = qr.data === undefined ? null : { ...qr.data, payload: reissued?.payload ?? qr.data.payload };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Not `.pp`: its button reset strips QrCard's own Print button (board finding 10). */}
      <DialogContent>
        <DialogHeader><DialogTitle>{t("card.print")}</DialogTitle></DialogHeader>
        {data === null ? <p>{t("app.loading")}</p> : (
          <div data-testid="qr-card-print" data-payload={data.payload}><QrCard data={data} /></div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReissueDialog({ patient, open, onOpenChange, onReissued }: {
  patient: PatientRow; open: boolean; onOpenChange: (o: boolean) => void; onReissued: (r: { qrVersion: number; payload: string }) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const reissue = async (): Promise<void> => {
    const res = await api<{ qrVersion: number; payload: string }>("POST", `/patients/${patient.id}/qr/reissue`);
    onReissued(res);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="pp">
        <DialogHeader><DialogTitle>{t("card.reissue")}</DialogTitle></DialogHeader>
        <p>{t("card.reissueWarning")}</p>
        <div className="flex justify-end">
          <button className="pri" onClick={() => void reissue()}>{t("card.reissue")}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DocumentDialog({ documentId, onClose }: { documentId: string | null; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const doc = useQuery({
    queryKey: ["patient-document", documentId],
    queryFn: () => getPatientDocument(documentId!),
    enabled: documentId !== null,
  });
  return (
    <Dialog open={documentId !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="pp">
        <DialogHeader><DialogTitle>{t("profile.document")}</DialogTitle></DialogHeader>
        {doc.data === undefined ? <p>{t("app.loading")}</p> : (
          <img alt="" style={{ maxWidth: "100%", maxHeight: "70vh" }} src={`data:${doc.data.mimeType};base64,${doc.data.imageBase64}`} />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ——— Screen ———

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * UX-AUDIT 2026-09-29 · BOARD — THE PATIENT PROFILE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner-approved board: `docs/design/2026-09-29-patient-profile/patient-profile.html`. Measured on
 * the page it replaces: allergies at y = 1,137 px under a 20-input form, no history at all, both
 * mobiles in full four times, the real name as the H1 of a sealed record, and every act drawn for
 * every role. Now: WHO on the left (allergies first), WHERE TODAY and ONE dated timeline in the
 * centre, and on the right only the acts this seat's permissions allow — "the clerk never sees a
 * button the server would refuse". Nothing is editable until "Edit details".
 *
 * PLAN 07b T2 — each onward act still TAKES THE PATIENT IN HAND before it navigates, so the
 * destination already knows who is being served.
 */
export function PatientDetail(): React.ReactElement {
  // The route's full id is "/authed/patients/$patientId" — authedRoute is a pathless
  // layout route (id: "authed", no path segment), so the URL is "/patients/$patientId"
  // but the route TREE id TanStack Router's typed `from` wants is prefixed with it.
  const { patientId } = useParams({ from: "/authed/patients/$patientId" });
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const { takePatient } = usePatientInHand();
  const genderWord = useGenderWord();

  const [log] = useState<AgentLine[]>([]);
  const [editing, setEditing] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [reissuing, setReissuing] = useState(false);
  const [recordingDeath, setRecordingDeath] = useState(false);
  const [addingRep, setAddingRep] = useState(false);
  const [reissued, setReissued] = useState<{ qrVersion: number; payload: string } | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [openDoc, setOpenDoc] = useState<string | null>(null);

  const patientQuery = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => api<{ patient: PatientRow; resolvedFrom: string | null }>("GET", `/patients/${patientId}`),
  });
  const pid = patientQuery.data?.patient.id ?? null;
  const restricted = patientQuery.data?.patient.isConfidential ?? false;

  /*
   * THE TIMELINE'S SOURCES — each one asked only by a seat that holds its permission, so a seat
   * never draws what the server would refuse (board §3 table): visits `opd.visits.read`; values
   * `lab.results.read`, else counter report rows `lab.reports.print`; imaging `radiology.reports.read`;
   * bills and dues `billing.invoice.read`; pharmacy hand-overs `opd.consult`; documents `patients.read`.
   */
  const on = (perm: string): boolean => pid !== null && can(perm);
  const visits = useQuery({ queryKey: ["opd-timeline", pid], queryFn: () => patientTimeline(pid!), enabled: on("opd.visits.read"), retry: false });
  const labResults = useQuery({ queryKey: ["pf-lab-results", pid], queryFn: () => fetchPatientResults(pid!), enabled: on("lab.results.read"), retry: false });
  const labReports = useQuery({ queryKey: ["pf-lab-reports", pid], queryFn: () => reportsForPatient(pid!), enabled: on("lab.reports.print"), retry: false });
  const imaging = useQuery({ queryKey: ["pf-imaging", pid], queryFn: () => fetchPatientImaging(pid!), enabled: on("radiology.reports.read"), retry: false });
  const invoices = useQuery({ queryKey: ["pf-invoices", pid], queryFn: () => listInvoicesFor({ patientId: pid! }), enabled: on("billing.invoice.read"), retry: false });
  const dues = useQuery({ queryKey: ["pf-dues", pid], queryFn: () => listDues(pid!), enabled: on("billing.invoice.read"), retry: false });
  const dispenses = useQuery({ queryKey: ["pf-dispenses", pid], queryFn: () => fetchPatientDispenses(pid!), enabled: on("opd.consult"), retry: false });
  const documents = useQuery({ queryKey: ["pf-documents", pid], queryFn: () => listPatientDocuments(pid!), enabled: on("patients.read"), retry: false });
  const guardians = useGuardians(pid ?? "", pid !== null && !restricted);

  /**
   * ═══ FD-COPILOT — THIS RECORD'S OWN FACTS, NOW THE FALLBACK RATHER THAN THE WHOLE ═══
   *
   * `useCopilot` asks the server first; these branches answer afterwards, for the questions that
   * are about the ROW ON THIS SCREEN. UX-AUDIT 2026-09-29 · BOARD: printed dates and masked
   * mobiles here too — the dock is a read surface like the rest of the page.
   */
  const localAnswer = (question: string): string | null => {
    const q = question.trim().toLowerCase();
    if (q === "") return null;
    const row = patientQuery.data?.patient;
    if (row === undefined) return null;
    if (q.includes("age") || q.includes("dob") || q.includes("born")) {
      return row.dob === null
        ? "No date of birth on this record. — from the patient row."
        : `Date of birth ${dmy(row.dob)}${row.dobEstimated ? " (estimated from an age given at the counter)" : ""}. — from the patient row.`;
    }
    if (q.includes("phone") || q.includes("mobile")) {
      if (row.isConfidential) return "Contact details are not shown on a restricted record. — from the patient row.";
      return `${row.phone === null ? "No mobile" : `Mobile ${maskMobile(row.phone)}`}${row.altPhone === null ? "" : ` · alternate ${maskMobile(row.altPhone)}`}. — from the patient row.`;
    }
    if (q.includes("abha")) {
      return row.abhaNumber === null && row.abhaAddress === null
        ? "No ABHA recorded. It can be added under Edit details. — from the patient row."
        : `ABHA ${row.abhaAddress ?? row.abhaNumber ?? ""} · ${t(`profile.abha.${row.abhaVerificationStatus}`, row.abhaVerificationStatus)}. — from the patient row.`;
    }
    if (q.includes("uhid") || q.includes("number")) {
      return `UHID ${row.uhid}${row.legacyUhid === null ? "" : `; the old paper file is ${row.legacyUhid}`}. — from the patient row.`;
    }
    return null;
  };

  /*
    ═══ THE NAME-MASKING GAP, CLOSED ON THE ONE SCREEN THAT CAN CLOSE IT ═══
    This screen holds the patient row, so a clerk who types "has Asha been seen" here gets that word
    masked to a placeholder before the question could reach a router. The alias is passed too.
  */
  const copilotTerms = (): string[] => {
    const row = patientQuery.data?.patient;
    if (row === undefined) return [];
    return [row.name, row.alias, row.uhid, row.phone, row.altPhone].filter((x): x is string => typeof x === "string" && x !== "");
  };
  const copilot = useCopilot({ terms: copilotTerms, fallback: localAnswer });

  const canEdit = can("patients.update");
  const canDeath = can("patients.deceased.write");
  const canOpenVisit = can("opd.visits.open");
  const canBook = can("opd.appointments.manage");
  const canTakeMoney = can("billing.receipt.record");
  const canBill = can("billing.invoice.issue");
  const canMerge = can("patients.merge");
  const canVerifyAbha = can("patients.register") && canEdit;

  const go = (to: "/opd/desk" | "/opd/appointments" | "/billing"): void => {
    if (pid === null) return;
    takePatient(pid);
    void navigate({ to });
  };

  /* Keys the lane's footer promises: E edit, P print card. Not while typing, not over a dialog. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || editing || document.querySelector("[role=dialog]") !== null) return;
      if ((e.key === "e" || e.key === "E") && canEdit) { e.preventDefault(); setEditing(true); }
      if (e.key === "Enter" && canOpenVisit && (el === null || el === document.body)) { e.preventDefault(); go("/opd/desk"); }
      if (e.key === "p" || e.key === "P") { e.preventDefault(); setPrinting(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `go` is rebuilt each render; the keys it reads are listed
  }, [editing, canEdit, canOpenVisit, pid]);

  if (!patientQuery.data) return <div className="p-6">{t("app.loading")}</div>;

  const { patient, resolvedFrom } = patientQuery.data;
  const name = shownName(patient, t("profile.restricted.pill"));
  const age = ageOf(patient.dob);
  const ageWord = age === "" ? null : /m$/.test(age) ? t("profile.ageMonths", { n: age.slice(0, -1) }) : t("profile.ageYears", { n: age });
  const today = istDay(new Date().toISOString());

  const labels: Labels = {
    clinical: can("opd.consult"),
    visit: (n) => t("profile.tl.visit", { n }),
    medicines: (n) => t("profile.tl.medicines", { count: n }),
    labSigned: t("profile.tl.labSigned"),
    labResults: (n) => t("profile.tl.labResults", { count: n }),
    labReportVersion: (n) => t("profile.tl.version", { n }),
    paidDue: (paid, due) => t("profile.tl.paidDue", { paid, due }),
    settled: t("profile.tl.settled"),
    onCredit: t("profile.tl.onCredit"),
    pharmacy: (n) => t("profile.tl.pharmacy", { count: n }),
    docKind: (k) => t(`profile.docKind.${k}`, t("profile.docKind.other")),
    docScanned: t("profile.tl.scanned"),
    high: t("profile.tl.high"),
    low: t("profile.tl.low"),
  };
  const rows = buildTimeline({
    ...(visits.data !== undefined ? { visits: visits.data.items } : {}),
    ...(labResults.data !== undefined ? { labResults: labResults.data.items } : {}),
    ...(labResults.data === undefined && labReports.data !== undefined ? { labReports: labReports.data } : {}),
    ...(imaging.data !== undefined ? { imaging: imaging.data.items } : {}),
    ...(invoices.data !== undefined ? { invoices: invoices.data.items } : {}),
    ...(dues.data !== undefined ? { dues: dues.data.items } : {}),
    ...(dispenses.data !== undefined ? { dispenses: dispenses.data.items } : {}),
    ...(documents.data !== undefined ? { documents: documents.data } : {}),
  }, labels);
  const days = groupByDay(rows);
  const DAYS_SHOWN = 6;
  const shownDays = showAll ? days : days.slice(0, DAYS_SHOWN);
  const hiddenRows = days.slice(DAYS_SHOWN).reduce((s, d) => s + d.rows.length, 0);

  const owed = duesSummary(dues.data?.items);
  const openToday = openVisitsToday(visits.data?.items, today);
  const pending = labReports.data?.pending ?? [];
  const visitCount = visits.data?.items.length;
  const rep = (guardians ?? []).find((g) => g.guardian.status === "active");

  const phoneFact = (label: string, phone: string | null): React.ReactElement | null => phone === null ? null : (
    <div className="fact"><span>{label}</span><span className="mo">{maskMobile(phone)}</span></div>
  );

  const abhaPill = patient.abhaVerificationStatus === "verified"
    ? <span className="pill on" style={{ height: 18, fontSize: 9.5 }}>{t("profile.abha.verified")}</span>
    : patient.abhaVerificationStatus === "self_declared"
      ? <span className="pill gd" style={{ height: 18, fontSize: 9.5 }}>{t("profile.abha.notVerified")}</span>
      : null;
  const abhaText = patient.abhaAddress ?? (patient.abhaNumber !== null ? `•••• ${patient.abhaNumber.replace(/\D/g, "").slice(-4)}` : null);
  const address = [patient.addressLine, patient.district, patient.pincode].filter((x): x is string => x !== null && x !== "").join(", ");

  const primary = canOpenVisit ? (
    <button className="pri" style={{ width: "100%" }} data-testid="onward-open-visit" onClick={() => { go("/opd/desk"); }}>
      {t("profile.openAtDeskOne")}
    </button>
  ) : null;

  return (
    <PaperScreen>
      <div className={moreOpen ? "pf more" : "pf"} style={{ flexGrow: 1, display: "flex", flexDirection: "column" }}>
        <div className="pf-grid">
          {/* ——— WHO — safety first ——— */}
          <aside className="pf-lane" data-testid="profile-lane">
            <div className="pf-who">
              {restricted
                ? <div className="pf-ph hidden">{t("profile.hidden")}</div>
                : <PatientPhoto patientId={patient.id} className="pf-ph" />}
              <div style={{ minWidth: 0 }}>
                {restricted && <span className="pill rd" data-testid="restricted-pill">{t("profile.restricted.pill")}</span>}
                <h1 style={restricted ? { marginTop: 6 } : undefined}>{name}</h1>
                <div className="mo" style={{ fontSize: 13, marginTop: 2 }}>{patient.uhid}</div>
                <div style={{ fontSize: 12, color: "var(--dim)" }}>
                  {[ageWord, genderWord(patient.administrativeGender), restricted ? null : patient.bloodGroup].filter((x) => x !== null && x !== "").join(" · ")}
                </div>
              </div>
            </div>
            <div className="pf-body">
              <AllergyBand patientId={patient.id} canEdit={canEdit} compact={restricted} />
              {restricted ? (
                <>
                  <div className="fact" style={{ marginTop: 10 }}><span>{t("profile.mobile")}</span><span>{t("profile.hiddenWord")}</span></div>
                  <div className="fact"><span>{t("register.address")}</span><span>{t("profile.hiddenWord")}</span></div>
                  <div className="fact"><span>{t("profile.sameMobile")}</span><span>{t("profile.restricted.noFamily")}</span></div>
                  {patient.sensitiveContext && <div className="fact"><span>{t("profile.familyMessages")}</span><span style={{ color: "var(--red)" }}>{t("profile.sealed")}</span></div>}
                </>
              ) : (
                <div className="pf-facts">
                  <div className="tag" style={{ margin: "14px 0 2px" }}>{t("profile.identity")}</div>
                  {patient.dob !== null && (
                    <div className="fact"><span>{t("profile.born")}</span><span>{dmy(patient.dob)}{patient.dobEstimated ? ` · ${t("profile.estimated")}` : ""}</span></div>
                  )}
                  {phoneFact(t("profile.mobile"), patient.phone)}
                  {phoneFact(t("profile.alternate"), patient.altPhone)}
                  {address !== "" && <div className="fact"><span>{t("register.address")}</span><span>{address}</span></div>}
                  <div className="fact"><span>{t("profile.language")}</span><span>{patient.language === "hi" ? t("register.hindi") : t("register.english")}</span></div>
                  {abhaText !== null && <div className="fact"><span>{t("patient.abha")}</span><span>{abhaText} {abhaPill}</span></div>}
                  <div className="fact"><span>{t("profile.identity")}</span><span data-testid="identity-assurance">{t(`assurance.${patient.identityAssurance}`, patient.identityAssurance)}</span></div>
                  {patient.legacyUhid !== null && <div className="fact"><span>{t("profile.paperFile")}</span><span className="mo">{patient.legacyUhid}</span></div>}
                  {patient.createdAt !== undefined && (
                    <div className="fact"><span>{t("profile.since")}</span><span>
                      {dmyIst(patient.createdAt)}{visitCount !== undefined ? ` · ${t("profile.visits", { count: visitCount })}` : ""}
                    </span></div>
                  )}
                  <div className="tag" style={{ margin: "14px 0 2px" }}>{t("profile.people")}</div>
                  <div className="fact">
                    <span>{t("profile.representative")}</span>
                    {rep === undefined ? <span style={{ color: "var(--dim)" }}>{t("profile.noneDeclared")}</span> : (
                      <span>
                        {rep.guardian.name}
                        <span style={{ display: "block", fontSize: 11, color: "var(--dim)" }}>
                          {[
                            t("profile.declared"),
                            t(`profile.relationship.${rep.guardian.relationship}`, rep.guardian.relationship),
                            [rep.effectiveAuthority.messages && t("patient.authMessages"), rep.effectiveAuthority.consents && t("patient.authConsents"), rep.effectiveAuthority.bills && t("patient.authBills"), rep.effectiveAuthority.dsr && t("patient.authDsr")].filter(Boolean).join(", ").toLowerCase(),
                            rep.guardian.validTo !== null ? t("profile.until", { date: dmy(rep.guardian.validTo) }) : null,
                          ].filter((x) => x !== null && x !== "").join(" · ")}
                        </span>
                      </span>
                    )}
                  </div>
                  <LinkedPatients patient={patient} />
                </div>
              )}
            </div>
            <div className="keys">
              {canOpenVisit && <span><span className="kb">⏎</span> {t("profile.keys.open")}</span>}
              {canEdit && <span><span className="kb">E</span> {t("profile.keys.edit")}</span>}
              <span><span className="kb">P</span> {t("profile.keys.print")}</span>
              <span><span className="kb">F2</span> {t("profile.keys.ask")}</span>
            </div>
          </aside>

          {/* ——— WHERE TODAY + THE ONE TIMELINE ——— */}
          <main className="pf-main">
            {resolvedFrom !== null && <p className="banner gd">{t("patient.merged")}</p>}
            <DeceasedBanner patient={patient} canClear={canDeath} />
            {restricted && (
              <div className="refuse" style={{ marginBottom: 12 }} data-testid="restricted-banner">
                <b style={{ color: "var(--red)" }}>{t("profile.restricted.title")}</b> {t("profile.restricted.body")}
              </div>
            )}
            {(openToday.length > 0 || pending.length > 0 || owed.totalPaise > 0) && (
              <>
                <div className="tag" style={{ marginBottom: 6 }}>{t("profile.today", { date: dmy(today) })}</div>
                <div className="today" data-testid="today-band">
                  {openToday.map((v) => (
                    <div key={v.encounterId}>
                      <b>{t("profile.todayVisit", { dept: v.departmentName ?? "OPD" })}</b>
                      <div className="s">{[t(`profile.visitStatus.${v.status}`, v.status), v.doctorName, v.visitNo !== undefined ? t("profile.tl.visit", { n: v.visitNo }) : null].filter(Boolean).join(" · ")}</div>
                    </div>
                  ))}
                  {pending.length > 0 && (
                    <div>
                      <b>{t("profile.labPending", { count: pending.reduce((s, p) => s + p.itemCount - p.completedCount, 0) })}</b>
                      <div className="s">{pending.flatMap((p) => p.orderables).join(", ")}</div>
                    </div>
                  )}
                  {owed.totalPaise > 0 && (
                    <div className={openToday.length + pending.length > 0 ? "money" : undefined} data-testid="today-dues">
                      <b style={{ color: "var(--gold)" }}>{t("profile.due", { amount: fmtPaise(owed.totalPaise) })}</b>
                      {owed.oldest !== null && (
                        <div className="s">{t("profile.dueFrom", { date: dmy(owed.oldest.serviceDay), bill: owed.oldest.invoiceNo, count: owed.count })}</div>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}

            <h3 style={{ margin: "18px 0 0", fontSize: 15, fontWeight: 600 }}>{t("profile.history")}</h3>
            {days.length === 0 && <p style={{ fontSize: 12.5, color: "var(--dim)" }} data-testid="timeline-empty">{t("profile.noHistory")}</p>}
            <div data-testid="timeline">
              {shownDays.map((d) => (
                <div key={d.day}>
                  <div className="day"><span className="d">{dmy(d.day)}</span><span className="ln" /></div>
                  <div className="box" style={{ overflow: "hidden" }}>
                    {d.rows.map((r) => (
                      <div className={r.owing === true ? "ev owe" : "ev"} key={r.key} data-testid="timeline-row">
                        <span className="src">{r.source}</span>
                        <div style={{ minWidth: 0 }}>
                          <div className="t">{r.title}{r.alert !== undefined && <> <span className="hl">{r.alert}</span></>}</div>
                          {r.sub !== null && <div className="s">{r.sub}</div>}
                        </div>
                        {r.amountPaise !== undefined && <span className="r mo">{fmtPaise(r.amountPaise)}</span>}
                        {r.note !== undefined && <span className="r s">{r.note}</span>}
                        {r.documentId !== undefined && (
                          <button type="button" className="r lnk" onClick={() => setOpenDoc(r.documentId!)}>{t("profile.view")}</button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {!showAll && hiddenRows > 0 && (
              <div className="day">
                <span className="d">{t("profile.earlier", { count: hiddenRows })}</span><span className="ln" />
                <button type="button" className="lnk" onClick={() => setShowAll(true)}>{t("profile.showMore")}</button>
              </div>
            )}
            <p style={{ fontSize: 11.5, color: "var(--dim)", margin: "8px 0 0" }}>{t("profile.historyNote")}</p>
          </main>

          {/* ——— THE ACTS THIS SEAT MAY TAKE ——— */}
          <aside className={moreOpen ? "pf-side open" : "pf-side"} data-testid="onward-actions">
            <section className="box" style={{ padding: 14 }}>
              <div className="tag" style={{ marginBottom: 10 }}>{t("profile.nextAct")}</div>
              {primary}
              <div className="acts2">
                {canBook && <button className="sec" data-testid="onward-book" onClick={() => { go("/opd/appointments"); }}>{t("profile.book")}</button>}
                {(canTakeMoney || canBill) && (
                  <button className="sec" data-testid="onward-bill" onClick={() => { go("/billing"); }}>
                    {canTakeMoney && owed.totalPaise > 0 ? t("profile.take", { amount: fmtPaise(owed.totalPaise) }) : t("patientDetail.onward.bill")}
                  </button>
                )}
                <button className="sec" data-testid="print-card" onClick={() => setPrinting(true)}>{t("card.print")}</button>
                {canEdit && <button className="sec" data-testid="edit-details" onClick={() => setEditing(true)}>{t("profile.editDetails")}</button>}
              </div>
              {(canVerifyAbha || canEdit || canMerge || canDeath) && (
                <>
                  <div className="tag" style={{ margin: "14px 0 6px" }}>{t("profile.lessOften")}</div>
                  <div className="rare" data-testid="less-often">
                    {canVerifyAbha && <AbdmVerifyAct patient={patient} />}
                    {canEdit && !restricted && <button type="button" onClick={() => setAddingRep(true)}>{t("profile.addRepresentative")}</button>}
                    {canEdit && (
                      <button type="button" onClick={() => setReissuing(true)}>
                        {t("card.reissue")} <span style={{ color: "var(--dim)" }}>· {t("profile.reissueNote")}</span>
                      </button>
                    )}
                    {canMerge && (
                      <button type="button" onClick={() => { void navigate({ to: "/merge" }); }}>
                        {t("profile.askMerge")} <span style={{ color: "var(--dim)" }}>· {t("profile.askMergeNote")}</span>
                      </button>
                    )}
                    {canDeath && patient.deceasedAt === null && (
                      <button type="button" className="rd" onClick={() => setRecordingDeath(true)}>{t("profile.death.title")}</button>
                    )}
                  </div>
                </>
              )}
              {reissued !== null && (
                <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--green)" }} data-testid="reissued-note">{t("profile.reissued", { version: reissued.qrVersion })}</p>
              )}
              <p style={{ margin: "10px 0 0", fontSize: 11, lineHeight: "15px", color: "var(--dim)" }}>{t("profile.actsNote")}</p>
            </section>
            <MessagesBox key={`${String(patient.promotionalOptIn)}-${patient.language}`} patient={patient} canEdit={canEdit} />
          </aside>
        </div>

        {/* Phone: the next act pinned at the foot; the rest behind "More". */}
        <div className="dock" data-testid="phone-dock">
          {canOpenVisit
            ? <button className="pri" onClick={() => { go("/opd/desk"); }}>{t("profile.openAtDeskOne")}</button>
            : <span style={{ flex: 1 }} />}
          <button type="button" className="sec" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>{t("profile.more")} ▾</button>
        </div>
      </div>

      {editing && <EditDrawer key={JSON.stringify(patient)} patient={patient} displayName={name} onClose={() => setEditing(false)} />}
      <PrintCardDialog patient={patient} open={printing} onOpenChange={setPrinting} reissued={reissued} />
      <ReissueDialog patient={patient} open={reissuing} onOpenChange={setReissuing} onReissued={setReissued} />
      <RecordDeathDialog patient={patient} open={recordingDeath} onOpenChange={setRecordingDeath} />
      {!restricted && <AddGuardianDialog patientId={patient.id} open={addingRep} onOpenChange={setAddingRep} />}
      <DocumentDialog documentId={openDoc} onClose={() => setOpenDoc(null)} />

      <AgentDock
        answer={copilot.answer}
        log={log}
        onAsk={copilot.ask}
        placeholder={t("patient.askPlaceholder")}
        idle={t("patient.agentIdle")}
        panel={copilot.report === null ? undefined : (
          <CopilotReport report={copilot.report} onDismiss={copilot.dismissReport} />
        )}
      />
    </PaperScreen>
  );
}
