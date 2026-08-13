import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// Wire shape (approvals.controller.ts / kernel/db/schema/approvals.ts) — every Date column
// arrives JSON-serialized as an ISO string.
type ApprovalRow = {
  id: string;
  typeKey: string;
  instanceId: string;
  requesterId: string;
  approverRole: string;
  urgencyClass: "routine" | "urgent" | "emergency";
  actedFirst: boolean;
  subjectType: string;
  subjectId: string;
  patientId: string | null;
  encounterId: string | null;
  payeeId: string | null;
  amountPaise: number | null;
  cumulativePatientPaise: number | null;
  cumulativePayeePaise: number | null;
  requestNote: string | null;
  status: "pending" | "granted" | "rejected";
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  requestedAt: string;
};

// Server errors carry either a plain string (SoD/business refusals) or a zod issue array
// (validation failures) — see approvals.controller.ts's toHttp / the plan's wire-contract
// note. String(err) on the array path prints "[object Object]"; this extracts the real text.
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

function ageMinutes(requestedAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(requestedAt).getTime()) / 60_000));
}

function UrgencyBadge({ urgency }: { urgency: ApprovalRow["urgencyClass"] }): React.ReactElement {
  const { t } = useTranslation();
  if (urgency === "emergency") return <Badge variant="destructive">{t("inbox.urgency.emergency")}</Badge>;
  if (urgency === "urgent") {
    return (
      <Badge variant="outline" className="border-amber-500 bg-amber-50 text-amber-700">
        {t("inbox.urgency.urgent")}
      </Badge>
    );
  }
  return <Badge variant="outline">{t("inbox.urgency.routine")}</Badge>;
}

// ——— Approve/reject dialog: the note is MANDATORY, blocked client-side, enforced server-side ———

function DecisionDialog({
  approvalId, action, queryClient,
}: { approvalId: string; action: "approve" | "reject"; queryClient: QueryClient }): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const label = action === "approve" ? t("inbox.approve") : t("inbox.reject");

  const submit = async (): Promise<void> => {
    const trimmed = note.trim();
    if (trimmed === "") return;
    setError(null);
    try {
      await api("POST", `/approvals/${approvalId}/${action}`, { note: trimmed });
      await queryClient.invalidateQueries({ queryKey: ["approvals"] });
      setNote("");
      setOpen(false);
    } catch (e) {
      // A 403 (SoD: requester === approver) renders here instead of crashing — the clerk who
      // requested cannot decide, and sees why.
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={action === "approve" ? "default" : "outline"}>{label}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{label}</DialogTitle></DialogHeader>
        <div>
          <label className="block text-sm font-medium" htmlFor={`decision-note-${approvalId}-${action}`}>
            {t("inbox.note")}
          </label>
          <textarea
            id={`decision-note-${approvalId}-${action}`}
            data-field
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded border px-2 py-1"
          />
        </div>
        {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end">
          <Button onClick={() => void submit()} disabled={note.trim() === ""}>{label}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ——— Screen: generic worklist — serves every current and future approval type ———

export function ApprovalsInbox(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api<{ items: ApprovalRow[]; total: number }>("GET", "/approvals"),
  });

  return (
    <div className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t("inbox.title")}</h1>
      {approvals.data === undefined && <p>{t("app.loading")}</p>}
      {approvals.data !== undefined && approvals.data.items.length === 0 && (
        <p className="text-sm text-neutral-500">{t("inbox.empty")}</p>
      )}
      {approvals.data !== undefined && approvals.data.items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead />
              <TableHead />
              <TableHead />
              <TableHead />
              <TableHead />
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {approvals.data.items.map((row) => (
              <TableRow key={row.id}>
                <TableCell><UrgencyBadge urgency={row.urgencyClass} /></TableCell>
                <TableCell className="font-mono text-xs">{row.typeKey}</TableCell>
                <TableCell className="text-xs text-neutral-600">{row.subjectType} · {row.subjectId}</TableCell>
                <TableCell className="text-sm">{row.requestNote ?? "—"}</TableCell>
                <TableCell className="text-xs text-neutral-500">{ageMinutes(row.requestedAt)}</TableCell>
                <TableCell>
                  <div className="flex gap-2">
                    <DecisionDialog approvalId={row.id} action="approve" queryClient={queryClient} />
                    <DecisionDialog approvalId={row.id} action="reject" queryClient={queryClient} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
