import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm, FormProvider } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { FormKit, TextField, SelectField, CheckboxField } from "../components/form-kit";
import { PatientPhoto } from "./registration-desk";
import { QrCard, type QrCardData } from "../components/qr-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

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

// ——— Demographics + ABHA: dirty-fields-only PATCH (T15 Step 2's exact onSave) ———

const patchSchema = z.object({
  name: z.string().min(1),
  phone: z.string().regex(phonePattern).optional().or(z.literal("")),
  altPhone: z.string().regex(phonePattern).optional().or(z.literal("")),
  dob: z.string().optional().or(z.literal("")),
  sex: z.enum(["male", "female", "other", "unknown"]),
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
      const v = (values as Record<string, unknown>)[key];
      patch[key] = v === "" ? null : v; // cleared inputs null the column (server treats null as a clear)
    }
    if (Object.keys(patch).length === 0) return;
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
      <FormProvider {...form}>
        <FormKit onSubmit={onSave} className="max-w-3xl">
          <div className="grid grid-cols-2 gap-3">
            <TextField name="name" label={t("register.name")} />
            <TextField name="phone" label={t("register.phone")} />
            <TextField name="altPhone" label={t("register.altPhone")} />
            <TextField name="dob" label={t("register.dob")} type="date" />
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
            <CheckboxField name="isConfidential" label={t("register.confidential")} />
            <CheckboxField name="sensitiveContext" label={t("register.sensitive")} />
          </div>
          {form.watch("isConfidential") && <TextField name="alias" label={t("register.alias")} />}
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
          <Button type="submit" disabled={form.formState.isSubmitting}>{t("patient.save")}</Button>
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
        <Button size="sm">{t("patient.addAllergy")}</Button>
      </DialogTrigger>
      <DialogContent>
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
            <Button type="submit">{t("patient.addAllergy")}</Button>
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
        <Button size="sm" variant="outline">{t("patient.markError")}</Button>
      </DialogTrigger>
      <DialogContent>
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
          <Button onClick={() => void submit()} disabled={reason.trim() === ""}>
            {t("patient.markError")}
          </Button>
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
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("patient.substance")}</TableHead>
            <TableHead>{t("patient.reaction")}</TableHead>
            <TableHead>{t("patient.severity")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {allergies.data?.items.map((a) => {
            const corrected = a.status === "entered_in_error";
            const strike = corrected ? "text-neutral-400 line-through" : "";
            return (
              <TableRow key={a.id}>
                <TableCell className={strike}>{a.substance}</TableCell>
                <TableCell className={strike}>{a.reaction ?? "—"}</TableCell>
                <TableCell className={strike}>{a.severity !== null ? t(`patient.${a.severity}`) : "—"}</TableCell>
                <TableCell>
                  {corrected ? (
                    <span className="text-xs text-neutral-500">{t("patient.reason")}: {a.correctionReason}</span>
                  ) : (
                    <EnteredInErrorDialog patientId={patientId} allergyId={a.id} />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
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
        <Button size="sm">{t("patient.addGuardian")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("patient.addGuardian")}</DialogTitle></DialogHeader>
        <FormProvider {...form}>
          <FormKit onSubmit={submit}>
            <TextField name="name" label={t("register.guardianName")} autoFocus />
            <TextField name="phone" label={t("register.guardianPhone")} />
            <SelectField name="relationship" label={t("register.relationship")} options={relationshipOptions} />
            <TextField name="consentNote" label={t("register.consentNote")} />
            <Button type="submit">{t("patient.addGuardian")}</Button>
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
          <Button size="sm" variant="outline" onClick={() => setEditing((v) => !v)}>{t("patient.authority")}</Button>
          <Button size="sm" variant="outline" onClick={() => void end()}>{t("patient.endGuardian")}</Button>
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
          <Button size="sm" onClick={() => void saveAuthority()}>{t("patient.save")}</Button>
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
      <Button variant="outline" className="no-print" onClick={() => setConfirmOpen(true)}>
        {t("card.reissue")}
      </Button>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("card.reissue")}</DialogTitle></DialogHeader>
          <p>{t("card.reissueWarning")}</p>
          <div className="flex justify-end">
            <Button onClick={() => void reissue()}>{t("card.reissue")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ——— Screen ———

export function PatientDetail(): React.ReactElement {
  // The route's full id is "/authed/patients/$patientId" — authedRoute is a pathless
  // layout route (id: "authed", no path segment), so the URL is "/patients/$patientId"
  // but the route TREE id TanStack Router's typed `from` wants is prefixed with it.
  const { patientId } = useParams({ from: "/authed/patients/$patientId" });
  const { t } = useTranslation();

  const patientQuery = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => api<{ patient: PatientRow; resolvedFrom: string | null }>("GET", `/patients/${patientId}`),
  });

  if (!patientQuery.data) return <div className="p-6">{t("app.loading")}</div>;

  const { patient, resolvedFrom } = patientQuery.data;

  return (
    <div className="space-y-6 p-6">
      <Header patient={patient} resolvedFrom={resolvedFrom} />
      <DemographicsSection patient={patient} />
      <AllergiesSection patientId={patient.id} />
      <GuardiansSection patient={patient} />
      <CardSection patient={patient} />
    </div>
  );
}
