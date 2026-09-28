import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { SubmitButton } from "../../components/submit-button";
import { billingErrorMessage } from "../../lib/billing-api";
import { dayWords, fetchOwnDrawer, instantWords, payVoucher, resolveMismatch } from "../../lib/billing-office-api";
import { fmtIst, fmtPaise } from "../../lib/format";
import { SRC_KEY, docOf, methodWord, needTitle, patientOf } from "./needs-text";
import type { OfficeView } from "./pages";
import type { ReconOutcome, WireBillingNeeds, WireNeedRow } from "../../lib/billing-office-api";

/**
 * ═══ UX-AUDIT 2026-09-28 · BOARD — THE ITEM IN HAND ═══
 *
 * Artboards 1, 2 and 4 of the approved billing back office board: the item in hand on the left with its
 * facts and why it is here; its steps, numbered, in the centre; the one next act pinned at the bottom.
 * On a phone the steps stack and the act stays at the thumb.
 *
 * Every act is the server's to allow: a pay is `POST /billing/refunds/:id/pay`, a mismatch decision
 * `POST /billing/recon/mismatches/:id/resolve` — and the refusals come back in the server's own words.
 *
 * OWNER RULINGS 2026-09-28 bound here:
 *  · Aadhaar is never stored — the payee step asks for the NAME and the TYPE of ID shown, and nothing
 *    else: there is no ID-number field (DECIDED: "ID shown" is kept, as a type only, because the type of
 *    document the counter looked at is still worth recording; its number is looked at and never typed).
 *  · Blind count — the drawer step says the drawer is open and since when; its expected cash is never
 *    fetched into a component (`fetchOwnDrawer` drops it).
 *  · A bank short-settlement above ₹50.00 is the owner's to write off — the act asks the owner.
 *  · Credit is the owner's alone — there is no credit act anywhere on this screen.
 */

type Go = { view: OfficeView; page?: string };
type HandProps = {
  row: WireNeedRow;
  limits: WireBillingNeeds["limits"] | null;
  phone: boolean;
  onBack: () => void;
  onGo: (go: Go) => void;
  onDone: (message: string) => void;
};

const ID_TYPES = ["aadhaar", "pan", "voter_id", "driving_licence", "passport", "other"] as const;
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

type Step = { n: number; state: "done" | "now" | "todo"; title: string; body?: React.ReactNode; aside?: React.ReactNode };

function Steps({ steps, compact }: { steps: Step[]; compact: boolean }): React.ReactElement {
  return (
    <div className="bof-flow" data-testid="hand-steps">
      {steps.map((s) => (
        <div key={s.n} className={`bof-step ${s.state}`} data-testid={`step-${String(s.n)}`} style={compact ? { padding: "10px 12px" } : undefined}>
          <span className="num" aria-hidden="true">{s.state === "done" ? "✓" : s.n}</span>
          <div style={{ flexGrow: 1, minWidth: 0 }}>
            <h3>{s.title}</h3>
            {s.body}
          </div>
          {s.aside}
        </div>
      ))}
    </div>
  );
}

/** Artboard 4 — on a phone the finished steps fold into one line ("Requested · approved · issued"). */
function foldDone(steps: Step[]): Step[] {
  const done = steps.filter((s) => s.state === "done");
  if (done.length < 2) return steps;
  const titles = done.map((s, i) => (i === 0 ? s.title : s.title.charAt(0).toLowerCase() + s.title.slice(1)));
  return [{ n: done[done.length - 1]!.n, state: "done", title: titles.join(" · ") }, ...steps.filter((s) => s.state !== "done")];
}

type Shape = {
  head: string;
  sub: string;
  /** [label, value, printed number or money → monospace] */
  facts: [string, string, boolean?][];
  why: string;
  flags?: React.ReactNode;
  footer?: React.ReactNode;
  h1: string;
  lead: string;
  steps: Step[];
  bar: React.ReactNode;
};

export function Hand(p: HandProps): React.ReactElement {
  const shape = useShape(p);
  const { t } = useTranslation();
  const chip = t(`billingOffice.board.src.${SRC_KEY[p.row.source]}`);
  const tone = p.row.kind === "recon_mismatch" || p.row.kind === "recon_disputed" ? " rd" : "";

  if (p.phone) {
    return (
      <div className="bof-full" role="dialog" aria-modal="true" aria-label={shape.h1} data-testid="in-hand">
        <div className="pof-ptop">
          <button type="button" className="pof-pmenu" onClick={p.onBack} data-testid="in-hand-back" aria-label={t("billingOffice.board.today.back")}>←</button>
          <span className={`src${tone}`}>{chip}</span>
          <span className="mo" style={{ fontSize: 11, color: "var(--dim)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{docOf(p.row)}</span>
        </div>
        <div style={{ padding: "14px 16px 6px" }}>
          <div style={{ fontSize: 16, fontWeight: 600 }} data-testid="in-hand-head">{shape.head}</div>
          <div style={{ fontSize: 12, color: "var(--dim)" }}>{shape.sub}</div>
        </div>
        <div style={{ padding: "6px 16px", flexGrow: 1, overflowY: "auto", minHeight: 0 }}>
          <Steps steps={foldDone(shape.steps)} compact />
        </div>
        <div className="bof-bar phone">{shape.bar}</div>
      </div>
    );
  }

  return (
    <>
      <aside className="pof-lane" aria-label={t("billingOffice.board.today.inHandAria")} data-testid="in-hand">
        <div style={{ padding: "18px 18px 10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className={`src${tone}`}>{chip}</span>
            <span className="mo" style={{ fontSize: 11, color: "var(--dim)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{docOf(p.row)}</span>
          </div>
          <h2 style={{ margin: "10px 0 0", fontSize: 16, lineHeight: "22px", fontWeight: 600 }} data-testid="in-hand-head">{shape.head}</h2>
          {shape.sub !== "" && <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 3 }}>{shape.sub}</div>}
        </div>
        <div style={{ padding: "0 18px", flexGrow: 1, overflowY: "auto", minHeight: 0 }}>
          {shape.facts.map(([k, v, mono]) => (
            <div key={k} className="fact"><span style={{ color: "var(--dim)" }}>{k}</span><span className={mono === true ? "mo" : undefined}>{v}</span></div>
          ))}
          {shape.why !== "" && (
            <>
              <div className="tag" style={{ margin: "16px 0 6px" }}>{t("billingOffice.board.today.why")}</div>
              <p style={{ margin: 0, fontSize: 12.5, lineHeight: "18px" }} data-testid="in-hand-why">{shape.why}</p>
            </>
          )}
          {shape.flags}
        </div>
        {shape.footer !== undefined && (
          <div style={{ padding: "12px 18px", borderTop: "1px solid var(--line)", fontSize: 11, color: "var(--dim)", lineHeight: "15px" }}>{shape.footer}</div>
        )}
      </aside>
      <main className="bof-centre">
        <div className="bof-flowhd"><h1>{shape.h1}</h1><span>{shape.lead}</span></div>
        <div style={{ flexGrow: 1, overflowY: "auto", minHeight: 0, padding: "0 24px" }}>
          <Steps steps={shape.steps} compact={false} />
        </div>
        <div className="bof-bar">{shape.bar}</div>
      </main>
    </>
  );
}

/** Each kind's facts, steps and pinned act. */
function useShape(p: HandProps): Shape {
  const pay = usePayShape(p);
  const recon = useReconShape(p);
  const simple = useSimpleShape(p);
  if (p.row.kind === "pay_voucher") return pay;
  if (p.row.kind === "recon_mismatch" || p.row.kind === "recon_disputed") return recon;
  return simple;
}

// ——— PAY: requested → approved → issued → who takes the money → which drawer → signature ———

function usePayShape(p: HandProps): Shape {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const row = p.row;
  const on = row.kind === "pay_voucher";
  const pr = row.params;
  const cash = str(pr.method) === "cash";
  const drawer = useQuery({ queryKey: ["billing-office", "own-drawer"], queryFn: fetchOwnDrawer, enabled: on && cash, retry: false });
  const [payee, setPayee] = useState(() => (row.patient !== null && !row.patient.restricted ? row.patient.name ?? "" : ""));
  const [idType, setIdType] = useState("");
  const [error, setError] = useState<string | null>(null);

  const amount = fmtPaise(num(pr.amountPaise));
  const who = patientOf(row);
  const method = methodWord(str(pr.method), t).toLowerCase();
  const flags = Array.isArray(pr.guardFlags) ? pr.guardFlags : [];
  const ownerApproved = num(pr.amountPaise) > (p.limits?.refundOwnerAbovePaise ?? Number.POSITIVE_INFINITY);

  const pay = async (key: string): Promise<void> => {
    if (payee.trim() === "" || idType === "") { setError(t("billingOffice.board.pay.required")); return; }
    setError(null);
    try {
      const done = await payVoucher(str(pr.voucherId), { payeeName: payee.trim(), payeeIdType: idType }, key);
      await qc.invalidateQueries({ queryKey: ["billing-office"] });
      p.onDone(t("billingOffice.board.pay.done", { voucherNo: done.voucherNo }));
    } catch (e) {
      setError(billingErrorMessage(e));
    }
  };

  const drawerStep: Step = {
    n: 5, state: "todo", title: t("billingOffice.board.pay.drawer"),
    body: <div className="m">{!cash ? t("billingOffice.board.pay.drawerBank")
      : drawer.data?.open === true ? t("billingOffice.board.pay.drawerOpen", { time: drawer.data.openedAt === null ? "—" : fmtIst(drawer.data.openedAt) })
      : drawer.data !== undefined || drawer.error !== null ? t("billingOffice.board.pay.drawerNone") : ""}</div>,
    aside: cash && drawer.data?.open === true ? <span className="pill on" style={{ alignSelf: "center" }} data-testid="drawer-open">{t("billingOffice.board.pay.drawerPill")}</span> : undefined,
  };

  return {
    head: t("billingOffice.board.pay.head", { patient: who }),
    sub: row.patient?.uhid ? t("billingOffice.board.uhid", { uhid: row.patient.uhid }) : "",
    facts: [
      [t("billingOffice.board.pay.fact.amount"), amount, true],
      [t("billingOffice.board.pay.fact.kind"), t(`billingOffice.kind.${str(pr.refundKind) === "invoice_refund" ? "invoice_refund" : "advance_refund"}`)],
      ...(str(pr.invoiceNo) !== "" ? [[t("billingOffice.board.pay.fact.bill"), str(pr.invoiceNo), true] as [string, string, boolean]] : []),
      ...(str(pr.creditNoteNo) !== "" ? [[t("billingOffice.board.pay.fact.creditNote"), str(pr.creditNoteNo), true] as [string, string, boolean]] : []),
      [t("billingOffice.board.pay.fact.payBy"), methodWord(str(pr.method), t)],
      [t("billingOffice.board.pay.fact.reason"), t(`billingOffice.request.${str(pr.reasonClass) === "mistake" ? "mistake" : "genuine"}`)],
      ...(pr.approvedAt !== null ? [[t("billingOffice.board.pay.fact.approved"), [instantWords(str(pr.approvedAt), false), str(pr.approvedBy)].filter((x) => x !== "").join(" · ")] as [string, string]] : []),
      [t("billingOffice.board.pay.fact.issued"), [instantWords(str(pr.issuedAt), false), str(pr.issuedBy)].filter((x) => x !== "").join(" · ")],
    ],
    why: t("billingOffice.board.pay.why", { reason: str(pr.reason) }),
    flags: (
      <>
        <div className="tag" style={{ margin: "16px 0 6px" }}>{t("billingOffice.board.pay.flags")}</div>
        <p style={{ margin: 0, fontSize: 12, lineHeight: "17px", color: "var(--gold-ink, #9a6208)" }} data-testid="hand-flags">
          {flags.length === 0 ? t("billingOffice.board.pay.noFlags")
            : flags.map((f) => (["terminal_encounter", "delivered_line"].includes(f) ? t(`billingOffice.guardFlags.${f}`) : f)).join(" · ")}
        </p>
      </>
    ),
    footer: t("billingOffice.board.pay.footer"),
    h1: t("billingOffice.board.pay.h1", { voucherNo: str(pr.voucherNo) }),
    lead: t("billingOffice.board.pay.lead", { amount, method, patient: who }),
    steps: [
      { n: 1, state: "done", title: t("billingOffice.board.pay.requested"),
        body: <div className="m">{t("billingOffice.board.pay.requestedM", { at: instantWords(str(pr.requestedAt)), by: str(pr.requestedBy) || "—", reason: str(pr.reason) })}</div> },
      { n: 2, state: "done", title: t("billingOffice.board.pay.approved"),
        body: <div className="m">{t(ownerApproved ? "billingOffice.board.pay.approvedOwnerM" : "billingOffice.board.pay.approvedM", { at: instantWords(str(pr.approvedAt)), by: str(pr.approvedBy) || "—" })}</div> },
      { n: 3, state: "done", title: t("billingOffice.board.pay.issued"),
        body: <div className="m">{t("billingOffice.board.pay.issuedM", { voucherNo: str(pr.voucherNo), amount, method })}</div> },
      { n: 4, state: "now", title: t("billingOffice.board.pay.who"),
        body: (
          <>
            <div className="m">{t("billingOffice.board.pay.whoM")}</div>
            <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
              <label className="bof-fld">
                <span>{t("billingOffice.board.pay.payeeName")}</span>
                <input className="in" value={payee} onChange={(e) => setPayee(e.target.value)} autoComplete="off" data-testid="payee-name" />
              </label>
              <label className="bof-fld" style={{ maxWidth: 220 }}>
                <span>{t("billingOffice.board.pay.idShown")}</span>
                <select className="in" value={idType} onChange={(e) => setIdType(e.target.value)} data-testid="payee-id-type">
                  <option value="">{t("billingOffice.board.pay.choose")}</option>
                  {ID_TYPES.map((k) => <option key={k} value={k}>{t(`billingOffice.board.pay.idType.${k}`)}</option>)}
                </select>
              </label>
            </div>
          </>
        ) },
      drawerStep,
      { n: 6, state: "todo", title: t("billingOffice.board.pay.sign"), body: <div className="m">{t("billingOffice.board.pay.signM")}</div> },
    ],
    bar: (
      <>
        <div className="why">
          {error !== null ? <span role="alert" data-testid="hand-error" style={{ color: "var(--red)" }}>{error}</span>
            : cash ? t("billingOffice.board.pay.whyCash", { amount }) : t("billingOffice.board.pay.whyBank")}
        </div>
        <button type="button" className="sec" onClick={p.onBack} data-testid="hand-not-now">{t("billingOffice.board.today.notNow")}</button>
        <SubmitButton plain className="pri" data-testid="hand-act" onClick={(k) => pay(k)}>
          {cash ? t("billingOffice.board.pay.act", { amount }) : t("billingOffice.board.pay.actBank", { amount })}
          <span className="kb" style={{ background: "transparent", color: "#cfe8dc", borderColor: "#3f8a70" }}>A</span>
        </SubmitButton>
      </>
    ),
  };
}

// ——— RECON: what the bank owed and paid → what happened ———

function useReconShape(p: HandProps): Shape {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const row = p.row;
  const pr = row.params;
  const disputed = row.kind === "recon_disputed";
  const shortPaise = num(pr.shortPaise);
  const isShort = shortPaise > 0;
  const limit = p.limits?.reconChargeManagerMaxPaise ?? 5_000;
  const ownerLine = isShort && shortPaise > limit;
  const ownerState = str(pr.ownerApproval);
  const [choice, setChoice] = useState<ReconOutcome>(disputed || ownerState !== "" ? (isShort ? "bank_charge" : "reupload") : "dispute");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(ownerState === "pending");

  const diff = fmtPaise(Math.abs(shortPaise));
  const mode = methodWord(str(pr.mode), t);
  const tolerance = fmtPaise(p.limits?.reconTolerancePaise ?? 100);

  const act = async (): Promise<void> => {
    if (reason.trim() === "") { setError(t("billingOffice.board.recon.reasonNeeded")); return; }
    setError(null);
    try {
      const r = await resolveMismatch(str(pr.tenderId), { outcome: choice, reason: reason.trim() });
      await qc.invalidateQueries({ queryKey: ["billing-office"] });
      // Asked of the owner: the item stays in hand, its act waiting, and moves to the clocks on the next read.
      if (r.status === "awaiting_owner") { setAsked(true); return; }
      p.onDone(t(`billingOffice.board.recon.done.${choice}`, { receiptNo: str(pr.receiptNo), amount: diff }));
    } catch (e) {
      setError(billingErrorMessage(e));
    }
  };

  const options: { k: ReconOutcome; b: string; tx: string; off: boolean }[] = [
    { k: "dispute", b: t("billingOffice.board.recon.disputeB"), tx: t("billingOffice.board.recon.disputeT"), off: disputed },
    { k: "bank_charge", b: t("billingOffice.board.recon.chargeB"), tx: isShort ? t("billingOffice.board.recon.chargeT", { limit: fmtPaise(limit) }) : t("billingOffice.board.recon.notShort"), off: !isShort },
    { k: "reupload", b: t("billingOffice.board.recon.reuploadB"), tx: t("billingOffice.board.recon.reuploadT"), off: false },
  ];

  const actLabel = choice === "dispute" ? t("billingOffice.board.recon.actDispute")
    : choice === "reupload" ? t("billingOffice.board.recon.actReupload")
    : ownerState === "granted" ? t("billingOffice.board.recon.actApply", { amount: diff })
    : ownerLine ? t("billingOffice.board.recon.actOwner", { amount: diff })
    : t("billingOffice.board.recon.actCharge", { amount: diff });
  const whyLine = choice === "dispute" ? t("billingOffice.board.recon.whyDispute", { amount: diff })
    : choice === "reupload" ? t("billingOffice.board.recon.whyReupload")
    : ownerState === "granted" ? t("billingOffice.board.recon.whyApply")
    : ownerLine ? t("billingOffice.board.recon.whyOwner", { amount: diff, limit: fmtPaise(limit) })
    : t("billingOffice.board.recon.whyCharge");
  const waitingOnOwner = asked && choice === "bank_charge" && ownerState !== "granted";

  return {
    head: t(isShort ? "billingOffice.board.recon.headShort" : "billingOffice.board.recon.headOver", { mode, patient: patientOf(row) }),
    sub: row.patient?.uhid ? t("billingOffice.board.uhid", { uhid: row.patient.uhid }) : "",
    facts: [
      [t("billingOffice.board.recon.fact.taken"), `${instantWords(str(pr.takenAt))} · ${mode}`],
      [t("billingOffice.board.recon.fact.receipt"), str(pr.receiptNo), true],
      ...(pr.uploadedAt !== null ? [[t("billingOffice.board.recon.fact.uploaded"), instantWords(str(pr.uploadedAt))] as [string, string]] : []),
      ...(pr.disputedAt !== null && pr.disputedAt !== undefined ? [[t("billingOffice.board.recon.fact.disputed"), instantWords(str(pr.disputedAt))] as [string, string]] : []),
    ],
    why: disputed ? t("billingOffice.board.recon.whyDisputed") : ownerState === "pending" ? t("billingOffice.board.recon.pendingOwner", { amount: diff }) : t("billingOffice.board.recon.whyHere"),
    h1: t("billingOffice.board.recon.h1", { receiptNo: str(pr.receiptNo) }),
    lead: t("billingOffice.board.recon.lead", { amount: diff, tolerance }),
    steps: [
      { n: 1, state: "done", title: t("billingOffice.board.recon.owed"),
        body: (
          <>
            <div className="bof-money" data-testid="recon-money">
              <div><div className="k">{t("billingOffice.board.recon.k.taken")}</div><div className="v">{fmtPaise(num(pr.amountPaise))}</div></div>
              <div><div className="k">{t("billingOffice.board.recon.k.expected")}</div><div className="v">{fmtPaise(num(pr.expectedNetPaise))}</div></div>
              <div><div className="k">{t("billingOffice.board.recon.k.settled")}</div><div className="v">{fmtPaise(num(pr.settledPaise))}</div></div>
              <div className="diff"><div className="k">{t(isShort ? "billingOffice.board.recon.k.short" : "billingOffice.board.recon.k.over")}</div><div className="v" data-testid="recon-diff">{diff}</div></div>
            </div>
            <div className="m" style={{ marginTop: 6 }}>{t("billingOffice.board.recon.owedM")}</div>
          </>
        ) },
      { n: 2, state: "now", title: t("billingOffice.board.recon.what"),
        body: (
          <div role="radiogroup" aria-label={t("billingOffice.board.recon.what")} style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 8, maxWidth: 760 }}>
            {options.map((o) => (
              <button key={o.k} type="button" role="radio" aria-checked={choice === o.k} disabled={o.off} className={choice === o.k ? "bof-opt on" : "bof-opt"}
                data-testid={`recon-opt-${o.k}`} onClick={() => setChoice(o.k)}>
                <span className="radio" aria-hidden="true" />
                <span><b>{o.b}</b> {o.tx}</span>
              </button>
            ))}
            <label className="bof-fld" style={{ marginTop: 4 }}>
              <span>{t("billingOffice.board.recon.reason")}</span>
              <input className="in" value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" data-testid="recon-reason" />
            </label>
          </div>
        ) },
    ],
    bar: (
      <>
        <div className="why">
          {error !== null ? <span role="alert" data-testid="hand-error" style={{ color: "var(--red)" }}>{error}</span>
            : waitingOnOwner ? <span data-testid="hand-owner">{t("billingOffice.board.recon.pendingOwner", { amount: diff })}</span> : whyLine}
        </div>
        <button type="button" className="sec" onClick={p.onBack} data-testid="hand-not-now">{t("billingOffice.board.today.notNow")}</button>
        <SubmitButton plain className="pri" data-testid="hand-act" disabled={waitingOnOwner} onClick={() => act()}>
          {actLabel}
          <span className="kb" style={{ background: "transparent", color: "#cfe8dc", borderColor: "#3f8a70" }}>A</span>
        </SubmitButton>
      </>
    ),
  };
}

// ——— everything else: facts, one or two steps, and a door to where the act lives ———

function useSimpleShape(p: HandProps): Shape {
  const { t, i18n } = useTranslation();
  const row = p.row;
  const pr = row.params;
  const title = needTitle(row, t, i18n.language);
  const who = patientOf(row);
  const k = row.kind;
  const amount = fmtPaise(num(pr.amountPaise));

  let facts: [string, string, boolean?][] = [];
  let steps: Step[] = [];
  let act: React.ReactNode = null;
  let why = "";

  const door = (label: string, go: Go, testId = "hand-act"): React.ReactNode => (
    <button type="button" className="pri" data-testid={testId} onClick={() => p.onGo(go)}>{label}</button>
  );

  if (k === "approve_refund" || k === "refund_owner") {
    facts = [
      [t("billingOffice.board.pay.fact.amount"), amount, true],
      [t("billingOffice.board.simple.asked"), [instantWords(row.since), str(pr.requestedBy)].filter((x) => x !== "").join(" · ")],
    ];
    why = str(pr.note);
    steps = [
      { n: 1, state: "done", title: t("billingOffice.board.pay.requested"), body: <div className="m">{str(pr.note)}</div> },
      { n: 2, state: k === "refund_owner" ? "todo" : "now", title: t(`billingOffice.board.simple.${k}.step`),
        body: <div className="m">{t(`billingOffice.board.simple.${k}.stepM`, { limit: fmtPaise(p.limits?.refundOwnerAbovePaise ?? 2_500_000) })}</div> },
    ];
    act = k === "approve_refund"
      ? <Link to="/approvals" search={{ focus: str(pr.approvalId) }} className="pri" data-testid="hand-act">{t("billingOffice.board.simple.approve_refund.act")}</Link>
      : <span className="pill gd" data-testid="hand-owner">{t("billingOffice.board.simple.refund_owner.act")}</span>;
  } else if (k === "unbilled_visit") {
    facts = [
      [t("billingOffice.board.simple.unbilled_visit.visit"), str(pr.visitNo), true],
      [t("billingOffice.board.simple.unbilled_visit.day"), dayWords(str(pr.serviceDate))],
      [t("billingOffice.board.simple.unbilled_visit.type"), ["new", "revisit", "renewal", "referral"].includes(str(pr.visitType)) ? t(`opd.visitType.${str(pr.visitType)}`) : t("billingOffice.orphans.typeUnknown")],
    ];
    why = t("billingOffice.board.simple.unbilled_visit.why");
    steps = [
      { n: 1, state: "done", title: t("billingOffice.board.simple.unbilled_visit.step1"), body: <div className="m">{t("billingOffice.board.simple.unbilled_visit.step1M", { visitNo: str(pr.visitNo), day: dayWords(str(pr.serviceDate)), patient: who })}</div> },
      { n: 2, state: "now", title: t("billingOffice.board.simple.unbilled_visit.step2"), body: <div className="m">{t("billingOffice.board.simple.unbilled_visit.step2M")}</div> },
    ];
    // Billing already opens a bill for an encounter at `/billing?encounterId=` (the OPD desk's door).
    act = <Link to="/billing" search={{ encounterId: str(pr.encounterId) }} className="pri" data-testid="hand-act">{t("billingOffice.board.simple.unbilled_visit.act")}</Link>;
  } else if (k === "recon_missing") {
    facts = [[t("billingOffice.board.simple.recon_missing.tenders"), String(num(pr.count))], [t("billingOffice.board.pay.fact.amount"), fmtPaise(num(pr.totalPaise))]];
    why = t("billingOffice.board.simple.recon_missing.why");
    steps = [{ n: 1, state: "now", title: t("billingOffice.board.simple.recon_missing.step"), body: <div className="m">{t("billingOffice.board.simple.recon_missing.stepM")}</div> }];
    act = door(t("billingOffice.board.simple.recon_missing.act"), { view: "recon", page: "upload" });
  } else if (k === "daybook_paper") {
    facts = [[t("billingOffice.board.simple.daybook_paper.receipts"), String(num(pr.count))], [t("billingOffice.board.pay.fact.amount"), fmtPaise(num(pr.totalPaise))]];
    why = t("billingOffice.board.simple.daybook_paper.why");
    steps = [{ n: 1, state: "now", title: t("billingOffice.board.simple.daybook_paper.step"), body: <div className="m">{t("billingOffice.board.simple.daybook_paper.stepM")}</div> }];
    act = door(t("billingOffice.board.simple.daybook_paper.act"), { view: "daybook", page: "daybook" });
  } else {
    facts = [[t("billingOffice.board.simple.gstr1_due.due"), dayWords(str(pr.due))]];
    why = t("billingOffice.board.simple.gstr1_due.why");
    steps = [{ n: 1, state: "now", title: t("billingOffice.board.simple.gstr1_due.step"), body: <div className="m">{t("billingOffice.board.simple.gstr1_due.stepM")}</div> }];
    act = door(t("billingOffice.board.simple.gstr1_due.act"), { view: "gstr1", page: "gstr1" });
  }

  return {
    head: title,
    sub: who === "" ? "" : row.patient?.uhid ? `${who} · ${t("billingOffice.board.uhid", { uhid: row.patient.uhid })}` : who,
    facts, why,
    h1: title,
    lead: "",
    steps,
    bar: (
      <>
        <div className="why" />
        <button type="button" className="sec" onClick={p.onBack} data-testid="hand-not-now">{t("billingOffice.board.today.notNow")}</button>
        {act}
      </>
    ),
  };
}
