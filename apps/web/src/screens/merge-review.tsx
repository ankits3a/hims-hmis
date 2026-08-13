import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../lib/api";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type SearchHit = {
  id: string; uhid: string; name: string; phone: string | null; sex: string;
  dob: string | null; isConfidential: boolean; hasPhoto: boolean;
};

// Wire shape (patients.controller.ts) — the subset this screen's comparison table needs.
// The SAME shape backs both the live GET /patients/:id fetch (picker phase) and the frozen
// request.snapshot.{winnerBefore,loserBefore} (tracker phase, §11.5's captured-at-request view).
type PatientRow = {
  id: string;
  uhid: string;
  name: string;
  phone: string | null;
  dob: string | null;
  sex: string;
  addressLine: string | null;
  abhaAddress: string | null;
  abhaNumber: string | null;
};

type MergeRequestView = {
  id: string;
  winnerId: string;
  loserId: string;
  status: "requested" | "executed" | "unmerged";
  requestNote: string;
  snapshot: { winnerBefore: PatientRow; loserBefore: PatientRow };
};

// Server errors carry either a plain string (SoD/business refusals) or a zod issue array
// (validation failures) — see patients.controller.ts's toHttp / the plan's wire-contract note.
// String(err) on the array path prints "[object Object]"; this extracts the real text.
function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { message?: unknown } | null;
    if (typeof body?.message === "string") return body.message;
    if (Array.isArray(body?.message)) {
      return body.message
        .map((issue) =>
          typeof issue === "object" && issue !== null && "message" in issue
            ? String((issue as { message: unknown }).message)
            : String(issue),
        )
        .join("; ");
    }
  }
  return String(e);
}

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

// ——— Picker: T14's search query shape, one selectable result per side ———

function PatientPicker({
  label, hit, onPick, side,
}: { label: string; hit: SearchHit | null; onPick: (h: SearchHit) => void; side: string }): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const debounced = useDebounced(q, 250);
  const search = useQuery({
    queryKey: ["patient-search", side, debounced],
    queryFn: () => api<{ items: SearchHit[] }>("GET", `/patients/search?q=${encodeURIComponent(debounced)}`),
    enabled: hit === null && debounced.trim().length >= 2,
  });

  if (hit !== null) {
    return (
      <div className="rounded border p-2">
        <p className="text-xs font-medium text-neutral-500">{label}</p>
        <p className="font-medium">{hit.name}</p>
        <p className="font-mono text-xs text-neutral-600">{hit.uhid}</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-neutral-500">{label}</p>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("search.placeholder")}
        className="w-full rounded border px-2 py-1"
      />
      <div className="space-y-1">
        {search.data?.items.map((h) => (
          <button
            key={h.id}
            type="button"
            onClick={() => onPick(h)}
            className="block w-full rounded border px-2 py-1 text-left text-sm hover:bg-neutral-50"
          >
            {h.name} · <span className="font-mono text-xs">{h.uhid}</span>
          </button>
        ))}
        {search.data !== undefined && search.data.items.length === 0 && (
          <p className="text-xs text-neutral-500">{t("search.none")}</p>
        )}
      </div>
    </div>
  );
}

// ——— Comparison table: one row per field, differing rows flagged with merge.differs ———

function ComparisonTable({
  left, right, leftAllergyCount, rightAllergyCount,
}: {
  left: PatientRow; right: PatientRow; leftAllergyCount: number | null; rightAllergyCount: number | null;
}): React.ReactElement {
  const { t } = useTranslation();
  const rows: { label: string; left: string; right: string }[] = [
    { label: t("register.name"), left: left.name, right: right.name },
    { label: t("register.phone"), left: left.phone ?? "—", right: right.phone ?? "—" },
    { label: t("register.dob"), left: left.dob?.slice(0, 10) ?? "—", right: right.dob?.slice(0, 10) ?? "—" },
    { label: t("card.sex"), left: left.sex, right: right.sex },
    { label: t("register.address"), left: left.addressLine ?? "—", right: right.addressLine ?? "—" },
    {
      label: t("patient.abha"),
      left: left.abhaAddress ?? left.abhaNumber ?? "—",
      right: right.abhaAddress ?? right.abhaNumber ?? "—",
    },
    {
      label: t("patient.allergies"),
      left: leftAllergyCount !== null ? String(leftAllergyCount) : "—",
      right: rightAllergyCount !== null ? String(rightAllergyCount) : "—",
    },
  ];
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead />
          <TableHead>{t("merge.left")}</TableHead>
          <TableHead>{t("merge.right")}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const differs = r.left !== r.right;
          return (
            <TableRow key={r.label} className={differs ? "bg-amber-50" : undefined}>
              <TableCell className="font-medium">{r.label}</TableCell>
              <TableCell>{r.left}</TableCell>
              <TableCell>{r.right}</TableCell>
              <TableCell>
                {differs && <span className="text-xs font-medium text-amber-700">{t("merge.differs")}</span>}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ——— Unmerge block (E-15 act-first-review-after — mirrors T8's server rule) ———

function UnmergeBlock({
  requestId, unmergeApprovalStatus,
}: { requestId: string; unmergeApprovalStatus: string | null }): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [actFirst, setActFirst] = useState(false);
  const [requested, setRequested] = useState(false);
  const [actFirstSubmitted, setActFirstSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestTheUnmerge = async (): Promise<void> => {
    const trimmed = note.trim();
    if (trimmed === "") return;
    setError(null);
    try {
      await api("POST", `/patients/merge-requests/${requestId}/unmerge-request`, { note: trimmed, actFirst });
      setActFirstSubmitted(actFirst);
      setRequested(true);
      await queryClient.invalidateQueries({ queryKey: ["merge-request", requestId] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const executeTheUnmerge = async (): Promise<void> => {
    setError(null);
    try {
      await api("POST", `/patients/merge-requests/${requestId}/unmerge`);
      await queryClient.invalidateQueries({ queryKey: ["merge-request", requestId] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // Mirrors T8's executeUnmerge rule: granted OR filed act-first and still pending — the
  // server remains authoritative; this is client convenience only.
  const canExecute = unmergeApprovalStatus === "granted" || (requested && actFirstSubmitted);

  return (
    <section className="space-y-2 rounded border p-3">
      <h2 className="text-sm font-semibold">{t("merge.unmerge")}</h2>
      {!requested && (
        <>
          <div>
            <label className="block text-sm font-medium" htmlFor="unmerge-note">{t("merge.unmergeNote")}</label>
            <textarea
              id="unmerge-note"
              data-field
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded border px-2 py-1"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={actFirst} onChange={(e) => setActFirst(e.target.checked)} />
            {t("merge.actFirst")}
          </label>
          <Button size="sm" onClick={() => void requestTheUnmerge()} disabled={note.trim() === ""}>
            {t("merge.unmerge")}
          </Button>
        </>
      )}
      {requested && (
        <Button size="sm" onClick={() => void executeTheUnmerge()} disabled={!canExecute}>
          {t("merge.unmergeExecute")}
        </Button>
      )}
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </section>
  );
}

// ——— Tracker: polled GET /patients/merge-requests/:id (no approvals.requests.read needed) ———

function TrackerView({
  requestId, view,
}: {
  requestId: string;
  view: { request: MergeRequestView; approvalStatus: string | null; unmergeApprovalStatus: string | null };
}): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [executeError, setExecuteError] = useState<string | null>(null);
  const { request, approvalStatus, unmergeApprovalStatus } = view;

  const executeMerge = async (): Promise<void> => {
    setExecuteError(null);
    try {
      await api("POST", `/patients/merge-requests/${requestId}/execute`);
      await queryClient.invalidateQueries({ queryKey: ["merge-request", requestId] });
    } catch (e) {
      setExecuteError(errorMessage(e));
    }
  };

  return (
    <div className="space-y-4">
      <ComparisonTable
        left={request.snapshot.winnerBefore}
        right={request.snapshot.loserBefore}
        leftAllergyCount={null}
        rightAllergyCount={null}
      />
      <p>
        {t("merge.status")}: <span>{approvalStatus ?? "—"}</span>
      </p>
      {executeError !== null && <p role="alert" className="text-sm text-red-600">{executeError}</p>}
      {request.status === "requested" && (
        <Button onClick={() => void executeMerge()} disabled={approvalStatus !== "granted"}>
          {t("merge.execute")}
        </Button>
      )}
      {request.status !== "requested" && <p className="font-medium">{t("merge.executed")}</p>}
      {request.status !== "requested" && (
        <UnmergeBlock requestId={requestId} unmergeApprovalStatus={unmergeApprovalStatus} />
      )}
    </div>
  );
}

// ——— Screen ———

export function MergeReview(): React.ReactElement {
  const { t } = useTranslation();
  const [left, setLeft] = useState<SearchHit | null>(null);
  const [right, setRight] = useState<SearchHit | null>(null);
  const [winner, setWinner] = useState<"left" | "right" | null>(null);
  const [note, setNote] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);

  const leftPatient = useQuery({
    queryKey: ["patient", left?.id ?? ""],
    queryFn: () => api<{ patient: PatientRow; resolvedFrom: string | null }>("GET", `/patients/${left?.id}`),
    enabled: left !== null,
  });
  const rightPatient = useQuery({
    queryKey: ["patient", right?.id ?? ""],
    queryFn: () => api<{ patient: PatientRow; resolvedFrom: string | null }>("GET", `/patients/${right?.id}`),
    enabled: right !== null,
  });
  const leftAllergies = useQuery({
    queryKey: ["patient-allergies", left?.id ?? ""],
    queryFn: () => api<{ items: unknown[] }>("GET", `/patients/${left?.id}/allergies`),
    enabled: left !== null,
  });
  const rightAllergies = useQuery({
    queryKey: ["patient-allergies", right?.id ?? ""],
    queryFn: () => api<{ items: unknown[] }>("GET", `/patients/${right?.id}/allergies`),
    enabled: right !== null,
  });

  const tracker = useQuery({
    queryKey: ["merge-request", requestId],
    queryFn: () => api<{ request: MergeRequestView; approvalStatus: string | null; unmergeApprovalStatus: string | null }>(
      "GET", `/patients/merge-requests/${requestId}`),
    enabled: requestId !== null,
    refetchInterval: 5_000,
  });

  const submit = async (): Promise<void> => {
    if (winner === null || leftPatient.data === undefined || rightPatient.data === undefined) return;
    const trimmed = note.trim();
    if (trimmed === "") return;
    setSubmitError(null);
    const winnerId = winner === "left" ? leftPatient.data.patient.id : rightPatient.data.patient.id;
    const loserId = winner === "left" ? rightPatient.data.patient.id : leftPatient.data.patient.id;
    try {
      const res = await api<{ mergeRequestId: string; approvalId: string; instanceId: string }>(
        "POST", "/patients/merge-requests", { winnerId, loserId, note: trimmed },
      );
      setRequestId(res.mergeRequestId);
    } catch (e) {
      setSubmitError(errorMessage(e));
    }
  };

  if (requestId !== null) {
    return (
      <div className="space-y-6 p-6">
        <h1 className="text-xl font-semibold">{t("merge.title")}</h1>
        {tracker.data === undefined ? <p>{t("app.loading")}</p> : <TrackerView requestId={requestId} view={tracker.data} />}
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-xl font-semibold">{t("merge.title")}</h1>
      <p className="text-sm text-neutral-500">{t("merge.pickTwo")}</p>
      <div className="grid grid-cols-2 gap-4">
        <PatientPicker side="left" label={t("merge.left")} hit={left} onPick={setLeft} />
        <PatientPicker side="right" label={t("merge.right")} hit={right} onPick={setRight} />
      </div>
      {leftPatient.data !== undefined && rightPatient.data !== undefined && (
        <>
          <ComparisonTable
            left={leftPatient.data.patient}
            right={rightPatient.data.patient}
            leftAllergyCount={leftAllergies.data?.items.length ?? null}
            rightAllergyCount={rightAllergies.data?.items.length ?? null}
          />
          <fieldset className="space-y-2 rounded border p-3">
            <legend className="text-sm font-medium">{t("merge.winner")}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="merge-winner" checked={winner === "left"} onChange={() => setWinner("left")} />
              {t("merge.left")} — {leftPatient.data.patient.name}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="merge-winner" checked={winner === "right"} onChange={() => setWinner("right")} />
              {t("merge.right")} — {rightPatient.data.patient.name}
            </label>
          </fieldset>
          <div>
            <label className="block text-sm font-medium" htmlFor="merge-note">{t("merge.note")}</label>
            <textarea
              id="merge-note"
              data-field
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded border px-2 py-1"
            />
          </div>
          {submitError !== null && <p role="alert" className="text-sm text-red-600">{submitError}</p>}
          <Button onClick={() => void submit()} disabled={winner === null || note.trim() === ""}>
            {t("merge.submit")}
          </Button>
        </>
      )}
    </div>
  );
}
