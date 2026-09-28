import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../lib/api";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ageOf } from "./desk-one/model";

type SearchHit = {
  id: string; uhid: string; name: string; phone: string | null; administrativeGender: string;
  dob: string | null; isConfidential: boolean; hasPhoto: boolean;
  // Present on the wire since FD-11 (search.ts) — optional here so an older payload still renders.
  district?: string | null;
};

/**
 * UX-AUDIT 2026-09-28 — TWO "ASHA DEVI" ROWS COULD NOT BE TOLD APART BEFORE ONE WAS PICKED.
 *
 * A real-Chromium walk of /merge searched "asha" and got two buttons reading `Asha Devi · HMS…`,
 * with nothing but the UHID between them — on the one screen whose whole job is deciding whether two
 * records are the same human being. `GET /patients/search` already returns everything needed to
 * tell them apart (sex, date of birth, mobile, district; see `PatientSearchResult`), so this is a
 * rendering fix and the shared `patients` contract is untouched.
 *
 * The mobile is masked the way every list row in the app masks it — `•••••• 3210`, the rule in
 * `search-provider.ts`'s `toHit` (DD8: a list row is not a record; the full number is on the
 * comparison below, behind the pick). Age comes from Desk One's `ageOf`, so the two screens can
 * never disagree about how old the same patient is.
 */
function maskedPhone(phone: string | null): string | null {
  if (phone === null || phone === "") return null;
  return `•••••• ${phone.replace(/\D/g, "").slice(-4)}`;
}

function HitDetails({ hit }: { hit: SearchHit }): React.ReactElement {
  const { t } = useTranslation();
  const age = ageOf(hit.dob);
  const parts = [
    // `ageOf` gives "36" for years and "5m" under one — the unit rides with the number either way.
    age === "" ? null : t("merge.hitAge", { age: age.endsWith("m") ? age : `${age}y` }),
    t(`register.${hit.administrativeGender}`, { defaultValue: hit.administrativeGender }),
    hit.dob === null ? null : t("merge.hitDob", { dob: hit.dob.slice(0, 10) }),
    maskedPhone(hit.phone),
    hit.district ?? null,
  ].filter((p): p is string => p !== null && p !== "");
  return <span className="block text-xs text-neutral-600">{parts.join(" · ")}</span>;
}

// Wire shape (patients.controller.ts) — the subset this screen's comparison table needs.
// The SAME shape backs both the live GET /patients/:id fetch (picker phase) and the frozen
// request.snapshot.{winnerBefore,loserBefore} (tracker phase, §11.5's captured-at-request view).
type PatientRow = {
  id: string;
  uhid: string;
  name: string;
  phone: string | null;
  dob: string | null;
  administrativeGender: string;
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

/*
  UX-AUDIT 2026-09-28 — THE SAME RECORD COULD BE PICKED AS BOTH A AND B.

  The walk picked HMS0000001234 on both sides and "Request merge" stayed enabled; the server refuses
  it (`merge_same_patient`, 409), but only after the clerk has typed a reason and pressed the button.
  So the other side's pick arrives here as `takenId`: its row still renders (hiding it would make a
  search look like it lost a patient) but disabled, saying which side already holds it. A picked
  side can be changed, because a pick that cannot be undone is a screen you reload to recover from.
*/
function PatientPicker({
  label, hit, onPick, onClear, side, takenId, takenLabel,
}: {
  label: string; hit: SearchHit | null; onPick: (h: SearchHit) => void; onClear: () => void; side: string;
  takenId: string | null; takenLabel: string;
}): React.ReactElement {
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
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium text-neutral-500">{label}</p>
          <button type="button" onClick={onClear} className="text-xs text-neutral-600 underline">
            {t("merge.change")}
          </button>
        </div>
        <p className="font-medium">{hit.name}</p>
        <p className="font-mono text-xs text-neutral-600">{hit.uhid}</p>
        <HitDetails hit={hit} />
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
        {search.data?.items.map((h) => {
          const taken = h.id === takenId;
          return (
            <button
              key={h.id}
              type="button"
              onClick={() => onPick(h)}
              disabled={taken}
              className="block w-full rounded border px-2 py-1 text-left text-sm hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
            >
              <span className="break-words">{h.name}</span> · <span className="font-mono text-xs">{h.uhid}</span>
              {taken && <span className="ml-1 text-xs font-medium text-amber-700">({t("merge.alreadyPicked", { side: takenLabel })})</span>}
              <HitDetails hit={h} />
            </button>
          );
        })}
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
    { label: t("card.sex"), left: left.administrativeGender, right: right.administrativeGender },
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
  /*
    UX-AUDIT 2026-09-28 — AT 390 px RECORD B AND EVERY "differs" MARKER WERE OFF-SCREEN.

    Four `whitespace-nowrap` columns inside the table's own horizontal scroller put Record B and the
    marker at x≈660 on a 390 px phone: the page did not overflow, so nothing looked broken, and the
    one column that answers "are these the same person?" was simply not there. Below `sm` each field
    row becomes a small grid — label and marker on the first line, then A and B stacked, each
    captioned — and values wrap. From `sm` up it is the same four-column table as before; it is
    still one `<tr>` per field either way, so a row and its marker stay one element.
  */
  const cell = "whitespace-normal break-words sm:table-cell";
  return (
    <Table>
      <TableHeader className="hidden sm:table-header-group">
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
            <TableRow
              key={r.label}
              className={`grid grid-cols-[1fr_auto] sm:table-row ${differs ? "bg-amber-50" : ""}`}
            >
              <TableCell className={`${cell} order-1 pb-0 font-medium sm:pb-2`}>{r.label}</TableCell>
              <TableCell className={`${cell} order-3 col-span-2 py-1 sm:py-2`}>
                <span className="mr-2 text-xs text-neutral-500 sm:hidden">{t("merge.left")}</span>
                {r.left}
              </TableCell>
              <TableCell className={`${cell} order-4 col-span-2 pt-0 sm:pt-2`}>
                <span className="mr-2 text-xs text-neutral-500 sm:hidden">{t("merge.right")}</span>
                {r.right}
              </TableCell>
              <TableCell className={`${cell} order-2 pb-0 text-right sm:pb-2 sm:text-left`}>
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

  /*
    UX-AUDIT 2026-09-28 — the picker refuses the same SEARCH row on both sides, but two different
    rows can still RESOLVE to one record (`GET /patients/:id` follows a merged record to its winner —
    `resolvedFrom`). Compared on the resolved ids, so the screen never offers a merge the server will
    refuse as `merge_same_patient`.
  */
  const sameRecord = leftPatient.data !== undefined && rightPatient.data !== undefined
    && leftPatient.data.patient.id === rightPatient.data.patient.id;

  const submit = async (): Promise<void> => {
    if (winner === null || sameRecord || leftPatient.data === undefined || rightPatient.data === undefined) return;
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <PatientPicker
          side="left" label={t("merge.left")} hit={left} onPick={setLeft} onClear={() => { setLeft(null); setWinner(null); }}
          takenId={right?.id ?? null} takenLabel={t("merge.right")}
        />
        <PatientPicker
          side="right" label={t("merge.right")} hit={right} onPick={setRight} onClear={() => { setRight(null); setWinner(null); }}
          takenId={left?.id ?? null} takenLabel={t("merge.left")}
        />
      </div>
      {sameRecord && <p role="alert" className="text-sm text-red-600">{t("merge.sameRecord")}</p>}
      {leftPatient.data !== undefined && rightPatient.data !== undefined && !sameRecord && (
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
          <Button onClick={() => void submit()} disabled={winner === null || sameRecord || note.trim() === ""}>
            {t("merge.submit")}
          </Button>
        </>
      )}
    </div>
  );
}
