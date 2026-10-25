import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { billingErrorMessage } from "../lib/billing-api";
import { refusalWords } from "../lib/refusal-words";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";

/**
 * ═══ GO-LIVE SCREENS — WORKFLOW DEFINITIONS (`/admin/workflows`) ═══
 *
 * Every workflow definition (OT, IPD and any later one): its state, the approvals it holds, who drafted and who
 * activated it, a summary of its steps and, for a draft, how it differs from the version in force.
 *
 * The buttons are the existing acts, nothing more:
 * - **Approve as <role>** → `POST /workflow/definitions/:id/approve` (`workflow.definitions.approve`). Only the policy
 *   roles the viewer HOLDS are offered.
 * - **Activate** → `POST /workflow/definitions/:id/activate` (`workflow.definitions.activate`).
 *
 * Approve is disabled, with the reason, for the person who drafted the definition (`drafter_cannot_approve`).
 * Two different people, the roles and drafter ≠ activator are enforced by the server (`approveDefinition`,
 * `activateDefinition`). The screen only hides buttons that cannot work; a refusal is shown as the server words it.
 */
type Person = { id: string; name: string | null };
type Transition = { from: string; to: string; roles: string[] };
export type WireBoardDefinition = {
  id: string; defKey: string; version: number; title: string; changeClass: string; status: "draft" | "active" | "retired";
  draftedBy: Person; draftedAt: string; activatedBy: Person | null; activatedAt: string | null;
  approvals: { approverId: string; approverName: string | null; roleKey: string; emergency: boolean; note: string; at: string }[];
  requiredRoles: string[]; missingRoles: string[];
  steps: { initialState: string; states: { name: string; terminal: boolean }[]; transitions: Transition[] };
  diff: { addedStates: string[]; removedStates: string[]; addedTransitions: Transition[]; removedTransitions: Transition[] } | null;
};
export type WireWorkflowBoard = { definitions: WireBoardDefinition[]; viewer: { policyRoles: string[] } };

const who = (p: Person): string => p.name ?? p.id;
const arrow = (x: Transition): string => `${x.from} → ${x.to}`;
const when = (iso: string): string => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

function DefinitionCard({ d, myRoles }: { d: WireBoardDefinition; myRoles: string[] }): React.ReactElement {
  const { t } = useTranslation();
  const { can, actor } = useAuth();
  const qc = useQueryClient();
  const [note, setNote] = useState(t("workflows.defaultNote"));
  const [showSteps, setShowSteps] = useState(false);
  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ["workflow", "board"] }); };
  const approve = useMutation({
    mutationFn: (roleKey: string) => api("POST", `/workflow/definitions/${encodeURIComponent(d.id)}/approve`, { roleKey, note: note.trim() }),
    onSuccess: refresh,
  });
  const activate = useMutation({
    mutationFn: () => api("POST", `/workflow/definitions/${encodeURIComponent(d.id)}/activate`),
    onSuccess: refresh,
  });
  const me = actor?.id ?? null;
  const iApproved = d.approvals.some((a) => a.approverId === me);
  const offer = d.status === "draft" && can("workflow.definitions.approve")
    ? d.missingRoles.filter((r) => myRoles.includes(r)) : [];
  const iDrafted = me !== null && d.draftedBy.id === me;
  const error = approve.error ?? activate.error;

  return (
    <article className="box" data-testid={`wf-${d.defKey}-v${d.version}`} style={{ display: "flex", flexDirection: "column", gap: 8, padding: "13px 15px" }}>
      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 10px" }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{d.title}</h2>
        <span className="mo" style={{ fontSize: 12, color: "var(--dim)" }}>{d.defKey} · v{d.version} · {t("workflows.class", { c: d.changeClass })}</span>
        <span className="tag" data-testid={`wf-${d.defKey}-v${d.version}-state`} style={{ marginLeft: "auto" }}>{t(`workflows.state.${d.status}`)}</span>
      </header>
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>
        {t("workflows.drafted", { who: who(d.draftedBy), at: when(d.draftedAt) })}
        {d.activatedBy !== null && d.activatedAt !== null && <> · {t("workflows.activated", { who: who(d.activatedBy), at: when(d.activatedAt) })}</>}
      </p>

      {d.status === "draft" && (
        <div data-testid={`wf-${d.defKey}-v${d.version}-approvals`} style={{ fontSize: 13 }}>
          {d.requiredRoles.length === 0
            ? <p style={{ margin: 0 }}>{t("workflows.noApprovalsNeeded")}</p>
            : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {d.requiredRoles.map((r) => {
                  const got = d.approvals.find((a) => a.roleKey === r && !a.emergency);
                  return (
                    <li key={r}>
                      <b>{t(`workflows.role.${r}`, { defaultValue: r })}</b>:{" "}
                      {got === undefined
                        ? <span style={{ color: "var(--warn, #9a3412)" }}>{t("workflows.waiting")}</span>
                        : t("workflows.approvedBy", { who: got.approverName ?? got.approverId, at: when(got.at) })}
                    </li>
                  );
                })}
              </ul>
            )}
        </div>
      )}

      {d.diff !== null && (
        <div style={{ fontSize: 12.5 }} data-testid={`wf-${d.defKey}-v${d.version}-diff`}>
          <b>{t("workflows.diffTitle")}</b>{" "}
          {d.diff.addedTransitions.length + d.diff.removedTransitions.length + d.diff.addedStates.length + d.diff.removedStates.length === 0
            ? t("workflows.diffNone")
            : (
              <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
                {d.diff.addedStates.map((s) => <li key={`as-${s}`}>+ {t("workflows.state1", { s })}</li>)}
                {d.diff.removedStates.map((s) => <li key={`rs-${s}`}>− {t("workflows.state1", { s })}</li>)}
                {d.diff.addedTransitions.map((x) => <li key={`at-${arrow(x)}`}>+ {arrow(x)}</li>)}
                {d.diff.removedTransitions.map((x) => <li key={`rt-${arrow(x)}`}>− {arrow(x)}</li>)}
              </ul>
            )}
        </div>
      )}

      <div>
        <button type="button" className="sec" onClick={() => setShowSteps(!showSteps)} aria-expanded={showSteps}
          data-testid={`wf-${d.defKey}-v${d.version}-steps-toggle`} style={{ fontSize: 12.5 }}>
          {t("workflows.steps", { states: d.steps.states.length, transitions: d.steps.transitions.length })}
        </button>
        {showSteps && (
          <ul className="mo" style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12, columns: "18rem auto" }}>
            {d.steps.transitions.map((x) => <li key={arrow(x)}>{arrow(x)} <span style={{ color: "var(--faint)" }}>({x.roles.join(", ")})</span></li>)}
          </ul>
        )}
      </div>

      {d.status === "draft" && (offer.length > 0 || (d.missingRoles.length === 0 && can("workflow.definitions.activate"))) && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {offer.length > 0 && (
            <input value={note} onChange={(e) => setNote(e.target.value)} aria-label={t("workflows.note")}
              style={{ flex: "1 1 14rem", minWidth: 0, padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 6, fontSize: 13 }} />
          )}
          {offer.map((r) => (
            <button key={r} type="button" className="sec" disabled={iDrafted || iApproved || approve.isPending || note.trim().length < 3}
              onClick={() => approve.mutate(r)} data-testid={`wf-${d.defKey}-v${d.version}-approve-${r}`}>
              {t("workflows.approveAs", { role: t(`workflows.role.${r}`, { defaultValue: r }) })}
            </button>
          ))}
          {d.missingRoles.length === 0 && can("workflow.definitions.activate") && (
            <button type="button" className="pri" disabled={iDrafted || activate.isPending} onClick={() => activate.mutate()}
              data-testid={`wf-${d.defKey}-v${d.version}-activate`}>
              {t("workflows.activate")}
            </button>
          )}
          {iApproved && offer.length > 0 && <span style={{ fontSize: 12.5, color: "var(--dim)" }}>{t("workflows.youApproved")}</span>}
          {iDrafted && offer.length > 0 && (
            <span style={{ fontSize: 12.5, color: "var(--dim)" }} data-testid={`wf-${d.defKey}-v${d.version}-drafter`}>{t("workflows.drafterCannotApprove")}</span>
          )}
          {iDrafted && d.missingRoles.length === 0 && <span style={{ fontSize: 12.5, color: "var(--dim)" }}>{t("workflows.youDrafted")}</span>}
        </div>
      )}
      {d.status === "draft" && d.missingRoles.length > 0 && offer.length === 0 && (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }} data-testid={`wf-${d.defKey}-v${d.version}-waitfor`}>
          {t("workflows.waitingFor", { roles: d.missingRoles.map((r) => t(`workflows.role.${r}`, { defaultValue: r })).join(", ") })}
        </p>
      )}
      {error !== null && <p role="alert" style={{ margin: 0, fontSize: 13, color: "#b91c1c" }}>{refusalWords(error, t, billingErrorMessage)}</p>}
    </article>
  );
}

export function AdminWorkflows(): React.ReactElement {
  const { t } = useTranslation();
  // Decision 0085 invariant 1 — an IPD go-live screen: while `ipd` is off it asks for nothing and draws no board.
  const { moduleOn, ready } = useAuth();
  const on = ready && moduleOn("ipd");
  const q = useQuery({
    queryKey: ["workflow", "board"], enabled: on,
    queryFn: () => api<WireWorkflowBoard>("GET", "/workflow/definitions/board"),
  });
  if (ready && !on) {
    return (
      <PaperScreen testId="admin-workflows-off" style={{ padding: "18px 22px", gap: 14 }}>
        <ScreenTitle title={t("workflows.title")} route="/admin/workflows" />
        <p style={{ margin: 0, fontSize: 13, color: "var(--dim)" }}>{t("workflows.off")}</p>
      </PaperScreen>
    );
  }
  const defs = q.data?.definitions ?? [];
  const drafts = defs.filter((d) => d.status === "draft");
  const rest = defs.filter((d) => d.status !== "draft");
  const myRoles = q.data?.viewer.policyRoles ?? [];
  return (
    <PaperScreen testId="admin-workflows" style={{ padding: "18px 22px", gap: 14 }}>
      <ScreenTitle title={t("workflows.title")} route="/admin/workflows" />
      <p style={{ margin: 0, fontSize: 13, color: "var(--dim)" }}>{t("workflows.lead")}</p>
      {q.error !== null && <p role="alert" style={{ margin: 0, color: "#b91c1c" }}>{refusalWords(q.error, t, billingErrorMessage)}</p>}
      {q.isLoading && <p style={{ margin: 0 }}>{t("workflows.loading")}</p>}
      {q.data !== undefined && (
        <>
          <h2 className="tag" style={{ margin: 0 }}>{t("workflows.awaiting", { count: drafts.length })}</h2>
          {drafts.length === 0 && <p style={{ margin: 0, fontSize: 13 }} data-testid="wf-no-drafts">{t("workflows.noDrafts")}</p>}
          {drafts.map((d) => <DefinitionCard key={d.id} d={d} myRoles={myRoles} />)}
          <h2 className="tag" style={{ margin: "8px 0 0" }}>{t("workflows.inForce")}</h2>
          {rest.map((d) => <DefinitionCard key={d.id} d={d} myRoles={myRoles} />)}
        </>
      )}
    </PaperScreen>
  );
}
