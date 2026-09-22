import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { CircleCheck, Inbox as InboxIcon, CircleX } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtRupees } from "../lib/format";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { APPROVAL_KINDS, ageOf, decisionErrorKey, isKnownKind, patientName } from "./approval-kinds";
import type { ApprovalPatient } from "./approval-kinds";

/**
 * ═══ APPROVALS-UX — THE OWNER'S INBOX, REBUILT FROM "THIS SCREEN CONFUSES ME" ═══
 *
 * The owner decides discounts, refunds and merges here, and said of the old screen: *"the approval
 * screen UI/UX is rubbish. It should be simple, intuitive and easy."* The old screen was a table
 * with six UNLABELLED columns: a machine key, `subjectType · subjectId` (a ULID), a bare integer of
 * minutes, and — for a money approval — no amount, although the row carried it.
 *
 * Each request is now a card that says in a sentence what is being asked ("Refund ₹1,250 to Ramesh
 * Kumar"), who asked and when, their note, and what saying yes does. Approve is ONE confirm step
 * with the note already filled in; reject asks for a reason with one-tap choices.
 *
 * ═══ WHY APPROVE STILL CARRIES A NOTE ═══
 *
 * The server REQUIRES one for both verdicts (`kernel/approvals/decisions.ts`: `note_required`, §8
 * "approve/reject with note"), and it is written into the audit event. That guard stays. What
 * changed is that the approver no longer has to TYPE it: "Approved as requested" is pre-filled, so
 * approving is two taps and the audit trail still says why.
 *
 * ═══ WHAT THE SERVER DECIDES, AND THIS SCREEN ONLY SHOWS ═══
 *
 * Names arrive from the server (`kernel/approvals/people.ts`) — including whether this reader may
 * see a sealed patient's legal name. The "you asked for this one" notice is presentation: the server
 * refuses a requester deciding their own request (SoD) whether or not this screen noticed first.
 */

type ApprovalItem = {
  id: string;
  typeKey: string;
  requesterId: string;
  requesterName: string | null;
  urgencyClass: "routine" | "urgent" | "emergency";
  patientId: string | null;
  payeeId: string | null;
  patient: ApprovalPatient | null;
  amountPaise: number | null;
  cumulativePatientPaise: number | null;
  cumulativePayeePaise: number | null;
  requestNote: string | null;
  status: "pending" | "granted" | "rejected";
  decisionNote: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  requestedAt: string;
};

type ApprovalList = { items: ApprovalItem[]; total: number };

/**
 * The names are the server's newest fields. A tab left open across a deploy can briefly talk to an
 * API that does not send them yet, and a card must then say "a staff member" rather than crash on
 * `undefined` — so absent reads as null, once, here.
 */
async function fetchList(path: string): Promise<ApprovalList> {
  const body = await api<ApprovalList>("GET", path);
  return {
    total: body.total,
    items: body.items.map((i) => ({
      ...i,
      requesterName: i.requesterName ?? null,
      decidedByName: i.decidedByName ?? null,
      patient: i.patient ?? null,
    })),
  };
}
type Verdict = "approve" | "reject";

const DECIDED_PAGE = 25;

const APPROVE_PRESETS = ["asRequested", "oneTime", "checked"] as const;
const REJECT_PRESETS = ["tooHigh", "unclear", "talkFirst", "policy", "duplicate"] as const;

// ——— words ———

/** The request as one sentence — or its label, when the row lacks a value the sentence needs. */
function headline(item: ApprovalItem, t: TFunction): string {
  if (!isKnownKind(item.typeKey)) return t("inbox.unknownKind.label");
  const needs: readonly string[] = APPROVAL_KINDS[item.typeKey];
  const amount = item.amountPaise === null ? null : fmtRupees(item.amountPaise);
  const patient = item.patient === null ? null : patientName(item.patient);
  if ((needs.includes("amount") && amount === null) || (needs.includes("patient") && patient === null)) {
    return t(`inbox.kinds.${item.typeKey}.label`);
  }
  return t(`inbox.kinds.${item.typeKey}.ask`, { amount, patient });
}

function kindLabel(item: ApprovalItem, t: TFunction): string {
  return isKnownKind(item.typeKey) ? t(`inbox.kinds.${item.typeKey}.label`) : t("inbox.unknownKind.label");
}

function kindExplain(item: ApprovalItem, t: TFunction): string {
  return isKnownKind(item.typeKey) ? t(`inbox.kinds.${item.typeKey}.explain`) : t("inbox.unknownKind.explain");
}

function age(iso: string, t: TFunction): string {
  const { key, count } = ageOf(iso);
  return t(key, { count });
}

/**
 * C-12, said truthfully. `cumulative*Paise` is a snapshot taken WHEN THE REQUEST WAS FILED: the
 * total of this same TYPE for this patient (or payee) on that IST calendar day, pending + granted,
 * INCLUDING this request (kernel/approvals/requests.ts). So "the others" is the cumulative minus
 * this amount, and it is only worth a line when it is more than zero.
 */
function sameDayLine(item: ApprovalItem, t: TFunction): string | null {
  if (item.amountPaise === null) return null;
  for (const [cumulative, who] of [[item.cumulativePatientPaise, "patient"], [item.cumulativePayeePaise, "payee"]] as const) {
    if (cumulative === null) continue;
    const other = cumulative - item.amountPaise;
    if (other > 0) return t(`inbox.sameDay.${who}`, { other: fmtRupees(other), total: fmtRupees(cumulative) });
  }
  return null;
}

// ——— the card ———

function UrgencyPill({ urgency }: { urgency: ApprovalItem["urgencyClass"] }): React.ReactElement | null {
  const { t } = useTranslation();
  if (urgency === "routine") return null; // urgency is shown only when it matters
  return urgency === "emergency" ? (
    <span className="pill" style={{ background: "var(--gold)", borderColor: "var(--gold)", color: "#fff" }}>{t("inbox.urgency.emergency")}</span>
  ) : (
    <span className="pill gd">{t("inbox.urgency.urgent")}</span>
  );
}

function ApprovalCard({
  item, onDecide, canDecide, isOwn, focused = false,
}: {
  item: ApprovalItem;
  onDecide?: (verdict: Verdict) => void;
  /** null while the signed-in person's permissions are still loading: show no answer yet, not a wrong one. */
  canDecide: boolean | null;
  isOwn: boolean;
  /** T3 — this is the card the alerts bell was about (`/approvals?focus=<id>`). */
  focused?: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useAuth();
  const sameDay = sameDayLine(item, t);
  const decided = item.status !== "pending";
  const attention = !decided && item.urgencyClass !== "routine";

  const actions = decided || canDecide === null ? null : isOwn ? (
    <p role="note" style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--dim)", maxWidth: 260 }}>{t("inbox.ownRequest")}</p>
  ) : !canDecide ? (
    <p role="note" style={{ margin: 0, fontSize: 13, color: "var(--dim)", maxWidth: 260 }}>{t("inbox.cannotDecide")}</p>
  ) : (
    <>
      <button type="button" className="sec" style={{ height: 40, padding: "0 20px", fontSize: 14 }} onClick={() => onDecide?.("reject")}>
        {t("inbox.reject")}
      </button>
      <button type="button" className="pri" style={{ minWidth: 124, fontSize: 14 }} onClick={() => onDecide?.("approve")}>
        {t("inbox.approve")}
      </button>
    </>
  );

  return (
    <article
      className="box"
      data-approval-id={item.id}
      // T3 — the bell's deep link lands here. The attribute is what the scroll finds and what the
      // test reads; the ring is what the eye finds.
      data-focused={focused ? "true" : undefined}
      aria-label={headline(item, t)}
      style={{
        padding: "14px 18px 16px", display: "flex", flexDirection: "column", gap: 8,
        // An inset stripe, not a wider border, so an urgent card's text lines up with its neighbours.
        ...(attention ? { boxShadow: "inset 4px 0 0 var(--gold)" } : {}),
        ...(focused ? { outline: "2px solid var(--gold)", outlineOffset: 2 } : {}),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="tag" style={{ color: "var(--dim)" }}>{kindLabel(item, t)}</span>
        {decided ? null : <UrgencyPill urgency={item.urgencyClass} />}
        <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--dim)" }}>{age(item.requestedAt, t)}</span>
      </div>

      {/*
        The question on the left, the two answers on the right — beside it on a desk or a tablet in
        landscape, under it on a phone (the row wraps). An answer that sits next to its question is
        one the eye does not have to travel for.
      */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "12px 20px" }}>
        <div style={{ flex: "1 1 400px", minWidth: 0, display: "flex", flexDirection: "column", gap: 7 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 650, lineHeight: 1.35, letterSpacing: "-.005em" }}>{headline(item, t)}</h2>

          {item.patient === null ? null : (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 13, color: "var(--dim)" }}>
              <span className="mo">{t("inbox.uhid", { uhid: item.patient.uhid })}</span>
              {/*
                No link to a sealed record for a reader who got the alias: the record screen would
                refuse them, and a link that always refuses is how people learn to ignore links.
              */}
              {item.patient.restricted || !can("patients.read") ? null : (
                <button
                  type="button"
                  onClick={() => { void navigate({ to: "/patients/$patientId", params: { patientId: item.patient!.id } }); }}
                  style={{ color: "var(--green)", fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 3 }}
                >
                  {t("inbox.openPatient")}
                </button>
              )}
            </div>
          )}

          <div style={{ fontSize: 13.5 }}>
            <span style={{ color: "var(--dim)" }}>{t("inbox.askedBy", { name: item.requesterName ?? t("inbox.someone") })}</span>
            {item.requestNote === null || item.requestNote.trim() === "" ? null : (
              <q style={{ display: "block", marginTop: 3, fontSize: 14, color: "var(--ink)" }}>{item.requestNote}</q>
            )}
          </div>

          <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{kindExplain(item, t)}</p>
        </div>

        {actions === null ? null : (
          <div style={{ flex: "0 0 auto", marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>{actions}</div>
        )}
      </div>

      {sameDay === null ? null : (
        <p style={{ margin: 0, fontSize: 12.5, padding: "7px 10px", borderRadius: 6, background: "var(--gold-soft)", border: "1px solid var(--gold-line)" }}>
          {sameDay}
        </p>
      )}

      {decided ? <DecidedFooter item={item} /> : null}
    </article>
  );
}

function DecidedFooter({ item }: { item: ApprovalItem }): React.ReactElement {
  const { t } = useTranslation();
  const granted = item.status === "granted";
  const who = item.decidedByName;
  const verdict = granted
    ? (who === null ? t("inbox.decided.approved") : t("inbox.decided.approvedBy", { name: who }))
    : (who === null ? t("inbox.decided.rejected") : t("inbox.decided.rejectedBy", { name: who }));
  const Icon = granted ? CircleCheck : CircleX;
  return (
    <div style={{ marginTop: 4, paddingTop: 10, borderTop: "1px solid var(--line2)", display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13.5, fontWeight: 600, color: granted ? "var(--green)" : "var(--red)" }}>
        <Icon size={16} aria-hidden />
        <span>{verdict}</span>
        {item.decidedAt === null ? null : (
          <span style={{ fontWeight: 400, color: "var(--dim)", fontSize: 12.5 }}>· {age(item.decidedAt, t)}</span>
        )}
      </div>
      {item.decisionNote === null ? null : <q style={{ fontSize: 13, color: "var(--ink)" }}>{item.decisionNote}</q>}
    </div>
  );
}

// ——— the one confirm step ———

function DecisionDialog({
  item, verdict, onClose, onDone,
}: {
  item: ApprovalItem;
  verdict: Verdict;
  onClose: () => void;
  onDone: (verdict: Verdict, item: ApprovalItem) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const approving = verdict === "approve";
  const [note, setNote] = useState(approving ? t("inbox.confirm.approvePresets.asRequested") : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ key: string; final: boolean } | null>(null);
  const presets = approving
    ? APPROVE_PRESETS.map((p) => t(`inbox.confirm.approvePresets.${p}`))
    : REJECT_PRESETS.map((p) => t(`inbox.confirm.rejectPresets.${p}`));
  const ready = note.trim() !== "" && !busy && error?.final !== true;

  const submit = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/approvals/${item.id}/${verdict}`, { note: note.trim() });
      await queryClient.invalidateQueries({ queryKey: ["approvals"] });
      onDone(verdict, item);
    } catch (e) {
      const key = decisionErrorKey(e);
      /*
        Only a dropped connection or a missing note is worth pressing the button again for. Every
        other refusal (your own request, not your role, already decided, gone) will say the same thing
        the second time, so the button goes away and the way out is Close.
      */
      const final = key !== "inbox.errors.network" && key !== "inbox.errors.noteRequired";
      setError({ key, final });
      // Somebody else decided it, or it is gone: the list under this dialog is stale, so refresh it.
      if (key === "inbox.errors.alreadyDecided" || key === "inbox.errors.gone") {
        void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      }
    } finally {
      setBusy(false);
    }
  };

  const fieldId = `decision-note-${item.id}`;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="pp" style={{ background: "var(--card)", color: "var(--ink)", maxWidth: 520 }}>
        <form
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
          style={{ display: "flex", flexDirection: "column", gap: 14 }}
        >
          <DialogTitle style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
            {approving ? t("inbox.confirm.approveTitle") : t("inbox.confirm.rejectTitle")}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="box" style={{ padding: "12px 14px", background: "var(--wash)", color: "var(--ink)" }}>
              <div style={{ fontSize: 15.5, fontWeight: 650, lineHeight: 1.35 }}>{headline(item, t)}</div>
              <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 4 }}>
                {[item.patient === null ? null : t("inbox.uhid", { uhid: item.patient.uhid }),
                  t("inbox.askedBy", { name: item.requesterName ?? t("inbox.someone") })]
                  .filter((x) => x !== null).join(" · ")}
              </div>
            </div>
          </DialogDescription>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label htmlFor={fieldId} style={{ fontSize: 13, fontWeight: 600 }}>
              {approving ? t("inbox.confirm.noteLabel") : t("inbox.confirm.reasonLabel")}
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {presets.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={note === p}
                  className={note === p ? "pill on" : "pill"}
                  style={{ height: 32, padding: "0 12px", fontSize: 12.5, cursor: "pointer" }}
                  onClick={() => { setNote(p); setError(null); }}
                >
                  {p}
                </button>
              ))}
            </div>
            <input
              id={fieldId}
              className="in"
              value={note}
              autoFocus={!approving}
              placeholder={approving ? undefined : t("inbox.confirm.reasonPlaceholder")}
              onChange={(e) => { setNote(e.target.value); setError(null); }}
            />
            {approving ? null : <span style={{ fontSize: 12, color: "var(--dim)" }}>{t("inbox.confirm.reasonHint")}</span>}
          </div>

          {error === null ? null : (
            <p role="alert" style={{ margin: 0, padding: "9px 12px", borderRadius: 6, fontSize: 13.5, fontWeight: 600, color: "var(--red)", background: "var(--red-soft)", border: "1px solid var(--red-line)" }}>
              {t(error.key)}
            </p>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
            <button type="button" className="sec" style={{ height: 40, padding: "0 18px", fontSize: 14 }} onClick={onClose}>
              {error?.final === true ? t("inbox.confirm.close") : t("inbox.confirm.cancel")}
            </button>
            {error?.final === true ? null : (
              <button
                type="submit"
                className="pri"
                disabled={!ready}
                autoFocus={approving}
                style={{ minWidth: 132, fontSize: 14, ...(approving ? {} : { background: "var(--red)", borderColor: "var(--red)" }) }}
              >
                {busy ? t("inbox.confirm.saving") : approving ? t("inbox.approve") : t("inbox.reject")}
              </button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ——— the screen ———

/**
 * The chosen tab reads as chosen: ink and semibold against dim. Inline, because `.pp button`
 * (desk-one.css) resets `color` and `font` on every button inside a paper screen and out-ranks the
 * trigger's own utility classes — measured in the browser, where both tabs rendered the same grey.
 */
function tabStyle(active: boolean): React.CSSProperties {
  return { padding: "0 14px", fontSize: 13.5, color: active ? "var(--ink)" : "var(--dim)", fontWeight: active ? 650 : 500 };
}

export function ApprovalsInbox(): React.ReactElement {
  const { t } = useTranslation();
  const { actor, can, ready } = useAuth();
  const [tab, setTab] = useState<"waiting" | "decided">("waiting");
  const [deciding, setDeciding] = useState<{ item: ApprovalItem; verdict: Verdict } | null>(null);
  const [done, setDone] = useState<{ verdict: Verdict; what: string } | null>(null);
  const { focus } = useSearch({ strict: false }) as { focus?: string };

  const pending = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () => fetchList("/approvals"),
  });

  /*
    Decided = granted + rejected, newest decision first. The server lists one status at a time, in
    the caller's own queues, newest decision first (worklist.ts); the two pages are merged here.
  */
  const decided = useQuery({
    queryKey: ["approvals", "decided"],
    enabled: tab === "decided",
    queryFn: async () => {
      const [granted, rejected] = await Promise.all([
        fetchList(`/approvals?status=granted&limit=${String(DECIDED_PAGE)}`),
        fetchList(`/approvals?status=rejected&limit=${String(DECIDED_PAGE)}`),
      ]);
      return [...granted.items, ...rejected.items]
        .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))
        .slice(0, DECIDED_PAGE);
    },
  });

  const canDecide = ready ? can("approvals.requests.decide") : null;
  const waitingCount = pending.data?.total;

  /*
    T3 — THE BELL'S DEEP LINK LANDS ON A CARD, NOT ON A LIST.

    Scrolled once per focus id, after the list that contains the card has arrived: the effect is
    keyed on both, so it cannot fire against an empty list and then never fire again. It scrolls
    only DOWNWARD-neutral (`block: "center"`) and never steals focus from a field somebody is
    typing in — the mark is visual, the reader's cursor is their own.
  */
  const scrolledTo = useRef<string | null>(null);
  const waitingItems = pending.data?.items;
  useEffect(() => {
    if (focus === undefined || waitingItems === undefined) return;
    if (scrolledTo.current === focus) return;
    const card = document.querySelector(`[data-approval-id="${CSS.escape(focus)}"]`);
    if (card === null) return;
    scrolledTo.current = focus;
    card.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus, waitingItems]);

  return (
    <PaperScreen testId="approvals-inbox">
      <div style={{ width: "100%", maxWidth: 860, margin: "0 auto", padding: "22px 16px 48px", display: "flex", flexDirection: "column", gap: 16 }}>
        <ScreenTitle title={t("inbox.title")} subtitle={t("inbox.lead")} />

        <Tabs value={tab} onValueChange={(v) => { setTab(v as "waiting" | "decided"); }}>
          <TabsList style={{ height: 40, background: "var(--wash)", border: "1px solid var(--line)" }}>
            <TabsTrigger value="waiting" style={tabStyle(tab === "waiting")}>
              {t("inbox.tabs.waiting")}
              {waitingCount === undefined ? null : (
                <span className="mo" style={{ marginLeft: 6, padding: "0 7px", borderRadius: 999, fontSize: 12, background: waitingCount > 0 ? "var(--gold)" : "var(--line)", color: waitingCount > 0 ? "#fff" : "var(--dim)" }}>
                  {waitingCount}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="decided" style={tabStyle(tab === "decided")}>{t("inbox.tabs.decided")}</TabsTrigger>
          </TabsList>
        </Tabs>

        {done === null ? null : (
          <div role="status" className="box" style={{ display: "flex", alignItems: "center", gap: 9, padding: "11px 14px", borderColor: done.verdict === "approve" ? "var(--green-line)" : "var(--red-line)", background: done.verdict === "approve" ? "var(--green-soft)" : "var(--red-soft)", fontSize: 14, fontWeight: 600, color: done.verdict === "approve" ? "var(--green)" : "var(--red)" }}>
            {done.verdict === "approve" ? <CircleCheck size={18} aria-hidden /> : <CircleX size={18} aria-hidden />}
            <span>{done.verdict === "approve" ? t("inbox.done.approved", { what: done.what }) : t("inbox.done.rejected", { what: done.what })}</span>
          </div>
        )}

        {tab === "waiting" ? (
          <ListBody
            query={pending}
            items={pending.data?.items}
            empty={(
              <div className="box" style={{ padding: "40px 20px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center" }}>
                <InboxIcon size={34} aria-hidden style={{ color: "var(--faint)" }} />
                <p style={{ margin: 0, fontSize: 17, fontWeight: 650 }}>{t("inbox.empty.title")}</p>
                <p style={{ margin: 0, fontSize: 13.5, color: "var(--dim)", maxWidth: 420 }}>{t("inbox.empty.body")}</p>
              </div>
            )}
            render={(item) => (
              <ApprovalCard
                key={item.id}
                item={item}
                canDecide={canDecide}
                isOwn={actor !== null && actor.id === item.requesterId}
                focused={focus !== undefined && focus === item.id}
                onDecide={(verdict) => { setDone(null); setDeciding({ item, verdict }); }}
              />
            )}
          />
        ) : (
          <ListBody
            query={decided}
            items={decided.data}
            empty={<p style={{ margin: 0, fontSize: 14, color: "var(--dim)" }}>{t("inbox.emptyDecided")}</p>}
            render={(item) => <ApprovalCard key={item.id} item={item} canDecide={false} isOwn={false} />}
          />
        )}
      </div>

      {deciding === null ? null : (
        <DecisionDialog
          key={`${deciding.item.id}-${deciding.verdict}`}
          item={deciding.item}
          verdict={deciding.verdict}
          onClose={() => { setDeciding(null); }}
          onDone={(verdict, item) => {
            setDeciding(null);
            setDone({ verdict, what: headline(item, t) });
          }}
        />
      )}
    </PaperScreen>
  );
}

function ListBody({
  query, items, empty, render,
}: {
  query: { isError: boolean; refetch: () => unknown };
  items: ApprovalItem[] | undefined;
  empty: React.ReactNode;
  render: (item: ApprovalItem) => React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  if (query.isError) {
    return (
      <div role="alert" className="box" style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", borderColor: "var(--red-line)", background: "var(--red-soft)" }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--red)" }}>{t("inbox.loadFailed")}</span>
        <button type="button" className="sec" onClick={() => { void query.refetch(); }}>{t("inbox.retry")}</button>
      </div>
    );
  }
  if (items === undefined) return <p style={{ margin: 0, fontSize: 14, color: "var(--dim)" }}>{t("inbox.loading")}</p>;
  if (items.length === 0) return <>{empty}</>;
  return <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{items.map(render)}</div>;
}
