import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm, FormProvider } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { AgentDock } from "../components/agent-dock";
import type { AgentLine } from "../components/agent-dock";
import { api } from "../lib/api";
import { CONFIDENTIAL_CAPTURE_ENABLED } from "../lib/confidential-capture";
import { FormKit, TextField, SelectField, CheckboxField } from "../components/form-kit";
import { SubmitButton } from "../components/submit-button";
import { PatientPhoto } from "../components/patient-photo";
import { QrCard, type QrCardData } from "../components/qr-card";
import { usePatientInHand } from "../lib/patient-in-hand";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

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

type EffectiveAuthority = { messages: boolean; consents: boolean; dsr: boolean; bills: boolean };
type GuardianItem = { guardian: GuardianRow; effectiveAuthority: EffectiveAuthority };

const phonePattern = /^[6-9]\d{9}$/;

// ——— Header: name (+ confidential badge/alias), UHID, photo, merged-record banner ———

function Header({ patient, resolvedFrom }: { patient: PatientRow; resolvedFrom: string | null }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <header className="space-y-2">
      {resolvedFrom !== null && (
        <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">{t("patient.merged")}</p>
      )}
      <div className="flex items-center gap-4">
        <PatientPhoto patientId={patient.id} className="h-20 w-16 rounded border" />
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{patient.name}</h1>
            {patient.isConfidential && (
              <>
                <Badge variant="destructive">{t("patient.confidentialBadge")}</Badge>
                {patient.alias !== null && <span className="text-sm text-neutral-500">({patient.alias})</span>}
              </>
            )}
          </div>
          <p className="font-mono text-sm text-neutral-600">{patient.uhid}</p>
        </div>
      </div>
    </header>
  );
}

// ——— Promotional opt-in (D9, DPDP): revocable consent — a single-field PATCH, exact payload ———

function OptInSection({ patient }: { patient: PatientRow }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const patientId = patient.id;
  const [optIn, setOptIn] = useState(patient.promotionalOptIn);

  const save = async (idempotencyKey: string): Promise<void> => {
    await api("PATCH", `/patients/${patientId}`, { promotionalOptIn: optIn }, idempotencyKey);
    await queryClient.invalidateQueries({ queryKey: ["patient", patientId] });
  };

  return (
    <section className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-field
          checked={optIn}
          onChange={(e) => setOptIn(e.target.checked)}
        />
        {t("patient.promotionalOptIn")}
      </label>
      <SubmitButton size="sm" onClick={save}>{t("patient.saveConsent")}</SubmitButton>
    </section>
  );
}

// ——— Deceased (D10, D-33): a send-time hard stop — mark and clear both PATCH-and-diff (D10) ———

function DeceasedSection({ patient }: { patient: PatientRow }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const patientId = patient.id;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ["patient", patientId] });

  const mark = async (idempotencyKey: string): Promise<void> => {
    await api("PATCH", `/patients/${patientId}`, { deceasedAt: `${date}T00:00:00.000Z` }, idempotencyKey);
    await refresh();
    setConfirmOpen(false);
  };

  const clear = async (idempotencyKey: string): Promise<void> => {
    await api("PATCH", `/patients/${patientId}`, { deceasedAt: null }, idempotencyKey);
    await refresh();
  };

  if (patient.deceasedAt !== null) {
    return (
      <section className="space-y-2">
        <p className="rounded bg-neutral-100 px-3 py-2 text-sm text-neutral-700">
          {t("patient.deceasedBanner", { date: patient.deceasedAt.slice(0, 10) })}
        </p>
        <SubmitButton size="sm" variant="outline" onClick={clear}>{t("patient.clearDeceased")}</SubmitButton>
      </section>
    );
  }

  return (
    <section className="space-y-2">
      <button className="sec" onClick={() => setConfirmOpen(true)}>{t("patient.markDeceased")}</button>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="pp">
          <DialogHeader><DialogTitle>{t("patient.markDeceased")}</DialogTitle></DialogHeader>
          <p>{t("patient.markDeceasedWarning")}</p>
          <div>
            <label className="block text-sm font-medium" htmlFor="deceased-date">{t("patient.deceasedDate")}</label>
            <input
              id="deceased-date"
              data-field
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded border px-2 py-1"
            />
          </div>
          <div className="flex justify-end">
            <SubmitButton onClick={mark}>{t("patient.confirmDeceased")}</SubmitButton>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ——— Demographics + ABHA: dirty-fields-only PATCH (T15 Step 2's exact onSave) ———

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

function DemographicsSection({ patient }: { patient: PatientRow }): React.ReactElement {
  const { t } = useTranslation();
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
      setServerError(String(e));
    }
  });

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{t("patient.demographics")}</h2>
      {/* PLAN 22c-A T7 — the assurance stamp, surfaced so the desk can see how much the hospital
          vouches for this identity before it amends it. An unevidenced Class I amendment drops it
          to `staff_verified` (DD5), and a clerk who cannot see the stamp cannot notice that. */}
      <p className="text-sm text-neutral-600" data-testid="identity-assurance">
        {t("patient.identityAssurance")}: <span className="font-medium">{t(`assurance.${patient.identityAssurance}`, patient.identityAssurance)}</span>
      </p>
      <FormProvider {...form}>
        <FormKit onSubmit={onSave} className="max-w-3xl">
          <div className="grid grid-cols-2 gap-3">
            <TextField name="name" label={t("register.name")} />
            <TextField name="phone" label={t("register.phone")} />
            <TextField name="altPhone" label={t("register.altPhone")} />
            <TextField name="dob" label={t("register.dob")} type="date" />
            <SelectField
              name="administrativeGender"
              label={t("patient.administrativeGender")}
              options={[
                { value: "unknown", label: t("register.unknown") },
                { value: "female", label: t("register.female") },
                { value: "male", label: t("register.male") },
                { value: "other", label: t("register.other") },
              ]}
            />
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
            <SelectField
              name="sex"
              label={t("register.sex")}
              options={[
                { value: "unknown", label: t("register.unknown") },
                { value: "female", label: t("register.female") },
                { value: "male", label: t("register.male") },
                { value: "other", label: t("register.other") },
              ]}
            />
            <SelectField
              name="language"
              label={t("register.language")}
              options={[
                { value: "hi", label: t("register.hindi") },
                { value: "en", label: t("register.english") },
              ]}
            />
            <TextField name="addressLine" label={t("register.address")} className="col-span-2" />
            <TextField name="district" label={t("register.district")} />
            <TextField name="stateName" label={t("register.state")} />
            <TextField name="pincode" label={t("register.pincode")} />
            <TextField name="bloodGroup" label={t("register.bloodGroup")} />
            <TextField name="legacyUhid" label={t("register.legacyUhid")} />
          </div>
          <div className="flex gap-6">
            {/* DD5 — see lib/confidential-capture.ts. The form still HOLDS the record's current
                value, so it is never marked dirty and the PATCH omits it: an edit must not
                silently un-confidential a record that already is one. */}
            {CONFIDENTIAL_CAPTURE_ENABLED && (
              <CheckboxField name="isConfidential" label={t("register.confidential")} />
            )}
            <CheckboxField name="sensitiveContext" label={t("register.sensitive")} />
          </div>
          {CONFIDENTIAL_CAPTURE_ENABLED && form.watch("isConfidential") && (
            <TextField name="alias" label={t("register.alias")} />
          )}
          <fieldset className="space-y-3 rounded border p-3">
            <legend className="px-1 text-sm font-medium">{t("patient.abha")}</legend>
            <div className="grid grid-cols-2 gap-3">
              <TextField name="abhaAddress" label={t("register.abhaAddress")} />
              <TextField name="abhaNumber" label={t("register.abhaNumber")} />
              <SelectField
                name="abhaVerificationStatus"
                label={t("patient.abha")}
                options={[
                  { value: "none", label: "none" },
                  { value: "self_declared", label: "self_declared" },
                  { value: "verified", label: "verified" },
                ]}
              />
            </div>
            {patient.abhaLinkToken !== null && (
              <p className="text-sm text-neutral-500">{t("patient.abha")}: {patient.abhaLinkToken}</p>
            )}
          </fieldset>
          {serverError !== null && <p role="alert" className="text-sm text-red-600">{serverError}</p>}
          <button className="pri" type="submit" disabled={form.formState.isSubmitting}>{t("patient.save")}</button>
        </FormKit>
      </FormProvider>
    </section>
  );
}

// ——— Allergies: append-only, E-8 entered-in-error correction (never delete) ———

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
        <button className="sec grn">{t("patient.addAllergy")}</button>
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
        <button className="sec">{t("patient.markError")}</button>
      </DialogTrigger>
      <DialogContent className="pp">
        <DialogHeader><DialogTitle>{t("patient.markError")}</DialogTitle></DialogHeader>
        <div>
          <label className="block text-sm font-medium" htmlFor="correction-reason">{t("patient.reason")}</label>
          <input
            id="correction-reason"
            data-field
            className="w-full rounded border px-2 py-1"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="flex justify-end">
          <button className="pri" onClick={() => void submit()} disabled={reason.trim() === ""}>
            {t("patient.markError")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AllergiesSection({ patientId }: { patientId: string }): React.ReactElement {
  const { t } = useTranslation();
  const allergies = useQuery({
    queryKey: ["patient-allergies", patientId],
    queryFn: () => api<{ items: AllergyRow[] }>("GET", `/patients/${patientId}/allergies`),
  });

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("patient.allergies")}</h2>
        <AddAllergyDialog patientId={patientId} />
      </div>
      <div role="table" className="box" style={{ overflow: "hidden" }}>
        <div role="rowgroup">
          <div role="row" style={{ display: "flex", gap: 10, padding: "9px 13px", borderBottom: "1px solid var(--line2)" }}>
            <span role="columnheader" className="tag" style={{ flexGrow: 1 }}>{t("patient.substance")}</span>
            <span role="columnheader" className="tag" style={{ flexGrow: 1 }}>{t("patient.reaction")}</span>
            <span role="columnheader" className="tag" style={{ flexGrow: 1 }}>{t("patient.severity")}</span>
            <span role="columnheader" className="tag" style={{ flexGrow: 1 }} />
          </div>
        </div>
        <div role="rowgroup">
          {allergies.data?.items.map((a) => {
            const corrected = a.status === "entered_in_error";
            const strike = corrected ? "text-neutral-400 line-through" : "";
            return (
              <div role="row" className="drow" key={a.id}>
                <span role="cell" className={strike} style={{ flexGrow: 1, fontSize: 12 }}>{a.substance}</span>
                <span role="cell" className={strike} style={{ flexGrow: 1, fontSize: 12 }}>{a.reaction ?? "—"}</span>
                <span role="cell" className={strike} style={{ flexGrow: 1, fontSize: 12 }}>{a.severity !== null ? t(`patient.${a.severity}`) : "—"}</span>
                <span role="cell" style={{ flexGrow: 1, fontSize: 12 }}>
                  {corrected ? (
                    <span className="text-xs text-neutral-500">{t("patient.reason")}: {a.correctionReason}</span>
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

// ——— Guardians: computed effectiveAuthority (never the stored flags), sealed banner, add/end ———

function AuthorityBadge({ label, on }: { label: string; on: boolean }): React.ReactElement {
  return (
    <Badge variant={on ? "default" : "outline"} className={on ? undefined : "text-neutral-400 line-through"}>
      {label}
    </Badge>
  );
}

const relationshipOptions = [
  { value: "father", label: "father" },
  { value: "mother", label: "mother" },
  { value: "legal_guardian", label: "legal_guardian" },
  { value: "other", label: "other" },
];

const addGuardianSchema = z.object({
  name: z.string().min(1),
  phone: z.string().regex(phonePattern).optional().or(z.literal("")),
  relationship: z.enum(["father", "mother", "legal_guardian", "other"]),
  consentNote: z.string().optional(),
});
type AddGuardianValues = z.infer<typeof addGuardianSchema>;

function AddGuardianDialog({ patientId }: { patientId: string }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
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
    setOpen(false);
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="sec grn">{t("patient.addGuardian")}</button>
      </DialogTrigger>
      <DialogContent className="pp">
        <DialogHeader><DialogTitle>{t("patient.addGuardian")}</DialogTitle></DialogHeader>
        <FormProvider {...form}>
          <FormKit onSubmit={submit}>
            <TextField name="name" label={t("register.guardianName")} autoFocus />
            <TextField name="phone" label={t("register.guardianPhone")} />
            <SelectField name="relationship" label={t("register.relationship")} options={relationshipOptions} />
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
    <div className="space-y-2 rounded border p-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium">
            {g.name} <span className="text-sm text-neutral-500">({g.relationship})</span>
          </p>
          <p className="text-sm text-neutral-500">{g.phone ?? "—"}</p>
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
          <button className="sec" onClick={() => setEditing((v) => !v)}>{t("patient.authority")}</button>
          <button className="sec" onClick={() => void end()}>{t("patient.endGuardian")}</button>
        </div>
      )}
      {editing && (
        <div className="flex flex-wrap items-center gap-3 rounded border p-2">
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={messages} onChange={(e) => setMessages(e.target.checked)} />
            {t("patient.authMessages")}
          </label>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={consents} onChange={(e) => setConsents(e.target.checked)} />
            {t("patient.authConsents")}
          </label>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={dsr} onChange={(e) => setDsr(e.target.checked)} />
            {t("patient.authDsr")}
          </label>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={bills} onChange={(e) => setBills(e.target.checked)} />
            {t("patient.authBills")}
          </label>
          <input
            type="date"
            value={validTo}
            onChange={(e) => setValidTo(e.target.value)}
            className="rounded border px-2 py-1 text-sm"
          />
          <button className="sec grn" onClick={() => void saveAuthority()}>{t("patient.save")}</button>
        </div>
      )}
    </div>
  );
}

function GuardiansSection({ patient }: { patient: PatientRow }): React.ReactElement {
  const { t } = useTranslation();
  const guardians = useQuery({
    queryKey: ["patient-guardians", patient.id],
    queryFn: () => api<{ items: GuardianItem[] }>("GET", `/patients/${patient.id}/guardians`),
  });

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("patient.guardians")}</h2>
        <AddGuardianDialog patientId={patient.id} />
      </div>
      {patient.sensitiveContext && (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{t("patient.sealedBanner")}</p>
      )}
      <div className="space-y-2">
        {guardians.data?.items.map((item) => (
          <GuardianCard key={item.guardian.id} patientId={patient.id} item={item} />
        ))}
      </div>
    </section>
  );
}

// ——— Card: reprint + reissue (D-23: every previously printed card dies at that moment) ———

function CardSection({ patient }: { patient: PatientRow }): React.ReactElement {
  const { t } = useTranslation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reissued, setReissued] = useState<{ qrVersion: number; payload: string } | null>(null);

  const qr = useQuery({
    queryKey: ["qr-card", patient.id],
    queryFn: () => api<QrCardData>("GET", `/patients/${patient.id}/qr`),
  });

  const reissue = async (): Promise<void> => {
    const res = await api<{ qrVersion: number; payload: string }>("POST", `/patients/${patient.id}/qr/reissue`);
    setReissued(res);
    setConfirmOpen(false);
  };

  if (!qr.data) return <p>{t("app.loading")}</p>;

  const data: QrCardData = { ...qr.data, payload: reissued?.payload ?? qr.data.payload };

  return (
    <section className="space-y-2">
      <QrCard data={data} />
      <p className="font-mono text-xs text-neutral-400">{data.payload}</p>
      <button className="sec no-print" onClick={() => setConfirmOpen(true)}>
        {t("card.reissue")}
      </button>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="pp">
          <DialogHeader><DialogTitle>{t("card.reissue")}</DialogTitle></DialogHeader>
          <p>{t("card.reissueWarning")}</p>
          <div className="flex justify-end">
            <button className="pri" onClick={() => void reissue()}>{t("card.reissue")}</button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ——— Screen ———

/**
 * PLAN 07b T2 — THE DEAD END, ENDED.
 *
 * Confirming a match on the registration desk routed here, and this screen had ZERO onward actions:
 * no open-visit, no book, no bill. A clerk who had just found the right person had to navigate away
 * by menu and search for them a second time, which is one of the three searches the walk-in cost.
 *
 * Each action TAKES THE PATIENT IN HAND before it navigates, so the destination already knows who
 * is being served — the whole point of the context is that finding somebody happens once.
 */
function OnwardActions({ patientId }: { patientId: string }): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { takePatient } = usePatientInHand();
  const go = (to: "/opd/desk" | "/opd/appointments" | "/billing"): void => {
    takePatient(patientId);
    void navigate({ to });
  };
  return (
    <div className="no-print flex flex-wrap gap-2" data-testid="onward-actions">
      <button className="pri" data-testid="onward-open-visit" onClick={() => { go("/opd/desk"); }}>
        {t("patientDetail.onward.openVisit")}
      </button>
      <button className="sec" data-testid="onward-book" onClick={() => { go("/opd/appointments"); }}>
        {t("patientDetail.onward.book")}
      </button>
      <button className="sec" data-testid="onward-bill" onClick={() => { go("/billing"); }}>
        {t("patientDetail.onward.bill")}
      </button>
    </div>
  );
}

export function PatientDetail(): React.ReactElement {
  // The route's full id is "/authed/patients/$patientId" — authedRoute is a pathless
  // layout route (id: "authed", no path segment), so the URL is "/patients/$patientId"
  // but the route TREE id TanStack Router's typed `from` wants is prefixed with it.
  const { patientId } = useParams({ from: "/authed/patients/$patientId" });
  const { t } = useTranslation();

  const [log] = useState<AgentLine[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);

  const patientQuery = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => api<{ patient: PatientRow; resolvedFrom: string | null }>("GET", `/patients/${patientId}`),
  });

  /**
   * WHAT THE AGENT CAN HONESTLY SAY ABOUT THIS RECORD. Everything comes from the row already
   * fetched, so the answer is instant and cannot be wrong in a way the screen is not. No model, no
   * lookup: a question it does not recognise says so rather than inventing an answer about a
   * patient.
   */
  const ask = (question: string): void => {
    const q = question.trim().toLowerCase();
    if (q === "") return;
    const row = patientQuery.data?.patient;
    if (row === undefined) return;
    if (q.includes("age") || q.includes("dob") || q.includes("born")) {
      setAnswer(row.dob === null
        ? "No date of birth on this record. — from the patient row."
        : `Date of birth ${String(row.dob).slice(0, 10)}${row.dobEstimated ? " (estimated from an age given at the counter)" : ""}. — from the patient row.`);
    } else if (q.includes("phone") || q.includes("mobile")) {
      setAnswer(`${row.phone ?? "No mobile"}${row.altPhone === null ? "" : ` · alternate ${row.altPhone}`}. — from the patient row.`);
    } else if (q.includes("abha")) {
      setAnswer(row.abhaNumber === null && row.abhaAddress === null
        ? "No ABHA recorded. It can be added at registration or here. — from the patient row."
        : `ABHA ${row.abhaNumber ?? row.abhaAddress ?? ""} · ${row.abhaVerificationStatus}. — from the patient row.`);
    } else if (q.includes("uhid") || q.includes("number")) {
      setAnswer(`UHID ${row.uhid}${row.legacyUhid === null ? "" : `; the old paper file is ${row.legacyUhid}`}. — from the patient row.`);
    } else {
      setAnswer("I answer from this patient's record only — UHID, date of birth, contact, ABHA. I cannot look anything else up from here.");
    }
  };

  if (!patientQuery.data) return <div className="p-6">{t("app.loading")}</div>;

  const { patient, resolvedFrom } = patientQuery.data;

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * FD-23 — THE PATIENT RECORD, IN THE COUNTER'S LANGUAGE
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * Owner ruling 2026-09-04: *"redesign /opd/appointments and /patients/ screens aligned to /counter
   * UI and UX. Remember to add AI agent/Co-pilot into it as well."*
   *
   * A CLERK'S EYE, NOT A FORM'S. This was eight stacked cards of equal weight, so the deceased flag,
   * the allergies and the marketing opt-in all shouted equally. It is now the counter's shape: WHO
   * this is on the left and stays there, and the amendable record on the right — the same division
   * `/counter` makes between the dossier and the stage, for the same reason.
   *
   * `.pp` and not `.d1`, because this screen lives inside the application shell and keeps its
   * topbar; the primitives come from the same file so nothing can drift.
   *
   * EVERY TESTID, HANDLER AND SECTION IS UNCHANGED — fifteen tests pin what this screen DOES, and a
   * redesign that quietly changed behaviour would be the worst outcome.
   */
  return (
    <div className="pp" style={{ display: "flex", flexDirection: "column", minHeight: "calc(100vh - 96px)" }}>
      <div style={{ flexGrow: 1, display: "flex", gap: 18, padding: "20px 24px", alignItems: "flex-start" }}>
        {/* WHO THIS IS — the column that does not change as the clerk works down the record. */}
        <aside style={{ width: 320, flexShrink: 0, display: "flex", flexDirection: "column", gap: 13 }}>
          <Header patient={patient} resolvedFrom={resolvedFrom} />
          <OnwardActions patientId={patient.id} />
          <CardSection patient={patient} />
        </aside>

        {/* WHAT CAN BE AMENDED — deceased first, because it is the one that changes every other read. */}
        <div style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 13 }}>
          <DeceasedSection patient={patient} />
          <DemographicsSection patient={patient} />
          <AllergiesSection patientId={patient.id} />
          <GuardiansSection patient={patient} />
          <OptInSection patient={patient} />
        </div>
      </div>

      <AgentDock
        answer={answer}
        log={log}
        onAsk={ask}
        placeholder={t("patient.askPlaceholder")}
        idle={t("patient.agentIdle")}
      />
    </div>
  );
}
