import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useForm, FormProvider } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { FormKit, TextField, SelectField, CheckboxField } from "../components/form-kit";
import { PhotoCapture } from "../components/photo-capture";
import { QrCard, type QrCardData } from "../components/qr-card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type SearchHit = {
  id: string; uhid: string; name: string; phone: string | null; sex: string;
  dob: string | null; isConfidential: boolean; hasPhoto: boolean;
};

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function PatientPhoto({ patientId, className }: { patientId: string; className: string }): React.ReactElement {
  const photo = useQuery({
    queryKey: ["patient-photo", patientId],
    queryFn: () => api<{ mimeType: string; imageBase64: string }>("GET", `/patients/${patientId}/photo`),
    retry: false,
  });
  if (!photo.data) return <div className={`${className} bg-neutral-100`} />;
  return <img alt="" className={`${className} object-cover`} src={`data:${photo.data.mimeType};base64,${photo.data.imageBase64}`} />;
}

// ——— C-18: the attach confirmation — photo LARGE, demographics beside, explicit yes/no ———
function AttachDialog({
  hit, onClose, onReject,
}: { hit: SearchHit; onClose: () => void; onReject: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("attach.title")}</DialogTitle></DialogHeader>
        <div className="flex gap-4">
          {hit.hasPhoto ? (
            <PatientPhoto patientId={hit.id} className="h-56 w-44 rounded border" />
          ) : (
            <p className="w-44 self-center text-sm text-amber-700">{t("attach.noPhoto")}</p>
          )}
          <dl className="space-y-1 text-sm">
            <div><dt className="inline font-medium">{t("card.uhid")}: </dt><dd className="inline font-mono">{hit.uhid}</dd></div>
            <div><dt className="inline font-medium">{t("register.name")}: </dt><dd className="inline">{hit.name}</dd></div>
            <div><dt className="inline font-medium">{t("register.phone")}: </dt><dd className="inline">{hit.phone ?? "—"}</dd></div>
            <div><dt className="inline font-medium">{t("card.sex")}: </dt><dd className="inline">{hit.sex}</dd></div>
            <div><dt className="inline font-medium">{t("card.dob")}: </dt><dd className="inline">{hit.dob?.slice(0, 10) ?? "—"}</dd></div>
          </dl>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onReject}>{t("attach.reject")}</Button>
          <Button onClick={() => void navigate({ to: "/patients/$patientId", params: { patientId: hit.id } })}>
            {t("attach.confirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Client mirror of T9's registerBody semantics (server stays authoritative).
const phonePattern = /^[6-9]\d{9}$/;
const registerSchema = z
  .object({
    name: z.string().min(1),
    phone: z.string().regex(phonePattern).optional().or(z.literal("")),
    dob: z.string().optional().or(z.literal("")),
    // NOT z.coerce: coerce("") === 0, which would make every blank form a zero-year-old minor.
    ageYears: z.preprocess(
      (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
      z.number().int().min(0).max(130).optional(),
    ),
    sex: z.enum(["male", "female", "other", "unknown"]),
    addressLine: z.string().optional(),
    district: z.string().optional(),
    pincode: z.string().regex(/^\d{6}$/).optional().or(z.literal("")),
    language: z.enum(["hi", "en"]),
    isConfidential: z.boolean(),
    alias: z.string().optional(),
    sensitiveContext: z.boolean(),
    abhaAddress: z.string().optional(),
    abhaNumber: z.string().optional(),
    legacyUhid: z.string().optional(),
    guardianName: z.string().optional(),
    guardianPhone: z.string().regex(phonePattern).optional().or(z.literal("")),
    guardianRelationship: z.enum(["father", "mother", "spouse", "sibling", "legal_guardian", "other"]),
    guardianConsentNote: z.string().optional(),
  })
  .refine((v) => !(v.dob !== undefined && v.dob !== "" && v.ageYears !== undefined), {
    message: "dob or age, not both", path: ["ageYears"],
  })
  .refine((v) => !v.isConfidential || (v.alias ?? "").trim() !== "", {
    message: "alias required", path: ["alias"],
  });
type RegisterFormValues = z.infer<typeof registerSchema>;
// PLAN DEFECT (typecheck TS2719 + a runtime miss): `ageYears` goes through z.preprocess, so the
// schema's INPUT type is `unknown` there while its OUTPUT is `number | undefined`. The form holds
// input values (react-hook-form never coerces a number input — `register` hands back the raw
// string), so the form is typed on the input side and the resolver transforms into
// RegisterFormValues at submit. Without this split `useForm<RegisterFormValues>` rejects the
// resolver, and `watch("ageYears")` returns "10" — which the plan's `typeof === "number"` test
// silently reads as "not a minor", so the D-31 guardian section never appeared.
type RegisterFormInput = z.input<typeof registerSchema>;

function isMinorInput(v: { dob?: string; ageYears?: unknown }): boolean {
  const raw = v.ageYears;
  const age = typeof raw === "string" ? (raw.trim() === "" ? undefined : Number(raw)) : raw;
  if (typeof age === "number" && Number.isFinite(age)) return age < 18;
  if (v.dob !== undefined && v.dob !== "") {
    const dob = new Date(v.dob);
    return Date.now() - dob.getTime() < 18 * 365.25 * 24 * 3600 * 1000; // UI hint only; the server rule is authoritative
  }
  return false;
}

function NewPatientForm({
  prefillPhone, onRegistered,
}: { prefillPhone: string; onRegistered: (patientId: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<RegisterFormInput, unknown, RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      name: "", phone: prefillPhone, sex: "unknown", language: "hi",
      isConfidential: false, sensitiveContext: false, guardianRelationship: "father",
    },
  });
  const watched = form.watch(["dob", "ageYears"]);
  const minor = isMinorInput({ dob: watched[0], ageYears: watched[1] });

  const submit = form.handleSubmit(async (v) => {
    setServerError(null);
    if (minor && (v.guardianName ?? "").trim() === "") {
      form.setError("guardianName", { message: t("register.guardianRequired") });
      return;
    }
    const body: Record<string, unknown> = {
      name: v.name,
      sex: v.sex,
      language: v.language,
      ...(v.phone !== undefined && v.phone !== "" ? { phone: v.phone } : {}),
      ...(v.dob !== undefined && v.dob !== "" ? { dob: v.dob } : {}),
      ...(typeof v.ageYears === "number" ? { ageYears: v.ageYears } : {}),
      ...(v.addressLine !== undefined && v.addressLine !== "" ? { addressLine: v.addressLine } : {}),
      ...(v.district !== undefined && v.district !== "" ? { district: v.district } : {}),
      ...(v.pincode !== undefined && v.pincode !== "" ? { pincode: v.pincode } : {}),
      ...(v.isConfidential ? { isConfidential: true, alias: v.alias } : {}),
      ...(v.sensitiveContext ? { sensitiveContext: true } : {}),
      ...(v.abhaAddress !== undefined && v.abhaAddress !== "" ? { abhaAddress: v.abhaAddress } : {}),
      ...(v.abhaNumber !== undefined && v.abhaNumber !== "" ? { abhaNumber: v.abhaNumber } : {}),
      ...(v.legacyUhid !== undefined && v.legacyUhid !== "" ? { legacyUhid: v.legacyUhid } : {}),
      ...((v.guardianName ?? "").trim() !== ""
        ? {
            guardian: {
              name: v.guardianName,
              relationship: v.guardianRelationship,
              ...(v.guardianPhone !== undefined && v.guardianPhone !== "" ? { phone: v.guardianPhone } : {}),
              ...(v.guardianConsentNote !== undefined && v.guardianConsentNote !== "" ? { consentNote: v.guardianConsentNote } : {}),
            },
          }
        : {}),
    };
    try {
      const res = await api<{ patient: { id: string } }>("POST", "/patients", body);
      if (photoBlob !== null) {
        const buf = new Uint8Array(await photoBlob.arrayBuffer());
        let binary = "";
        for (const b of buf) binary += String.fromCharCode(b);
        await api("PUT", `/patients/${res.patient.id}/photo`, { imageBase64: btoa(binary) });
      }
      onRegistered(res.patient.id);
    } catch (e) {
      setServerError(String(e));
    }
  });

  return (
    <FormProvider {...form}>
      <FormKit onSubmit={submit} className="max-w-2xl">
        <h2 className="text-lg font-semibold">{t("register.title")}</h2>
        <div className="grid grid-cols-2 gap-3">
          <TextField name="name" label={t("register.name")} autoFocus />
          <TextField name="phone" label={t("register.phone")} />
          <TextField name="dob" label={t("register.dob")} type="date" />
          <TextField name="ageYears" label={t("register.age")} type="number" />
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
          <TextField name="pincode" label={t("register.pincode")} />
          <TextField name="abhaAddress" label={t("register.abhaAddress")} />
          <TextField name="abhaNumber" label={t("register.abhaNumber")} />
          <TextField name="legacyUhid" label={t("register.legacyUhid")} />
        </div>
        <div className="flex gap-6">
          <CheckboxField name="isConfidential" label={t("register.confidential")} />
          <CheckboxField name="sensitiveContext" label={t("register.sensitive")} />
        </div>
        {form.watch("isConfidential") && <TextField name="alias" label={t("register.alias")} />}
        {minor && (
          <fieldset className="space-y-3 rounded border p-3">
            <legend className="px-1 text-sm font-medium">
              {t("register.guardian")} — {t("register.guardianRequired")}
            </legend>
            <div className="grid grid-cols-2 gap-3">
              <TextField name="guardianName" label={t("register.guardianName")} />
              <TextField name="guardianPhone" label={t("register.guardianPhone")} />
              <SelectField
                name="guardianRelationship"
                label={t("register.relationship")}
                options={[
                  { value: "father", label: "father" }, { value: "mother", label: "mother" },
                  { value: "legal_guardian", label: "legal_guardian" }, { value: "other", label: "other" },
                ]}
              />
              <TextField name="guardianConsentNote" label={t("register.consentNote")} />
            </div>
          </fieldset>
        )}
        <PhotoCapture onCapture={setPhotoBlob} />
        {serverError !== null && <p role="alert" className="text-sm text-red-600">{serverError}</p>}
        <Button type="submit" disabled={form.formState.isSubmitting}>{t("register.submit")}</Button>
      </FormKit>
    </FormProvider>
  );
}

export function RegistrationDesk(): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const debounced = useDebounced(q, 250);
  const [attach, setAttach] = useState<SearchHit | null>(null);
  const [view, setView] = useState<{ kind: "search" } | { kind: "new"; prefillPhone: string } | { kind: "card"; patientId: string }>({ kind: "search" });

  const search = useQuery({
    queryKey: ["patient-search", debounced],
    queryFn: () => api<{ items: SearchHit[] }>("GET", `/patients/search?q=${encodeURIComponent(debounced)}`),
    enabled: view.kind === "search" && debounced.trim().length >= 2,
  });

  const card = useQuery({
    queryKey: ["qr-card", view.kind === "card" ? view.patientId : ""],
    queryFn: () => api<QrCardData>("GET", `/patients/${view.kind === "card" ? view.patientId : ""}/qr`),
    enabled: view.kind === "card",
  });

  if (view.kind === "card") {
    return (
      <div className="p-6">
        {card.data ? <QrCard data={card.data} /> : <p>{t("app.loading")}</p>}
        <Button variant="outline" className="no-print mt-4" onClick={() => { setView({ kind: "search" }); setQ(""); }}>
          {t("register.registered")} ✓
        </Button>
      </div>
    );
  }

  if (view.kind === "new") {
    return (
      <div className="p-6">
        <NewPatientForm prefillPhone={view.prefillPhone} onRegistered={(patientId) => setView({ kind: "card", patientId })} />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-6">
      <div className="max-w-xl">
        <input
          data-search-input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("search.placeholder")}
          className="w-full rounded border px-3 py-2 text-lg"
        />
        <p className="pt-1 text-xs text-neutral-500">{t("search.hint")}</p>
      </div>
      <div className="max-w-xl space-y-2">
        {search.data?.items.map((hit) => (
          <button
            key={hit.id}
            type="button"
            onClick={() => setAttach(hit)}
            className="flex w-full items-center gap-3 rounded border p-2 text-left hover:bg-neutral-50"
          >
            {hit.hasPhoto ? <PatientPhoto patientId={hit.id} className="h-12 w-10 rounded" /> : <div className="h-12 w-10 rounded bg-neutral-100" />}
            <span className="min-w-0">
              <span className="block truncate font-medium">{hit.name}</span>
              <span className="block font-mono text-xs text-neutral-600">{hit.uhid} · {hit.phone ?? "—"}</span>
            </span>
          </button>
        ))}
        {search.data !== undefined && search.data.items.length === 0 && (
          <p className="text-sm text-neutral-500">{t("search.none")}</p>
        )}
      </div>
      <Button onClick={() => setView({ kind: "new", prefillPhone: /^\d+$/.test(q.trim()) ? q.trim() : "" })}>
        {t("search.newPatient")}
      </Button>
      {attach !== null && (
        <AttachDialog
          hit={attach}
          onClose={() => setAttach(null)}
          onReject={() => {
            setView({ kind: "new", prefillPhone: attach.phone ?? (/^\d+$/.test(q.trim()) ? q.trim() : "") });
            setAttach(null);
          }}
        />
      )}
    </div>
  );
}
