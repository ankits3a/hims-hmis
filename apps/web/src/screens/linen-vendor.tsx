import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { useAuth } from "../lib/auth";
import {
  challanReturnApi, checkBillApi, decideBillApi, decideRecoveryApi, fetchLinenFloor, fetchVendorDesk, linenRefusal, newTapKey,
  raiseRecoveryApi, rupees, sendToVendorApi,
} from "../lib/linen-api";
import { LinenTabs } from "./linen-store";
import type { LinenBillCard, LinenChallanCard, LinenVendorMonthReport } from "@hmis/contracts";
import "./linen.css";

/**
 * ═══ LD-2 (#979, decisions 0087 and 0092) — THE VENDOR LAUNDRY DESK (16:9) ═══
 *
 * Centre: challans out (late ones first) with the dock return per item — accepted, refused damaged, refused stained —
 * and the send-to-vendor form (vendor, weight: the challan). Right: last month's report per vendor (below par proposes a
 * recovery; the owner or finance approves it, never its proposer), the vendor's bills (an excess waits for stores), the
 * plant's licences (red within 60 days) and chemical per kg washed beside the vendor's per-kg cost.
 * No patient or staff name anywhere on this desk.
 */
export function LinenVendor(): React.ReactElement {
  const { t } = useTranslation();
  const desk = useQuery({ queryKey: ["linen", "vendor-desk"], queryFn: () => fetchVendorDesk(), refetchInterval: 60_000 });
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const d = desk.data;
  const say = (ok: boolean, text: string): void => setNotice({ ok, text });
  const refused = (e: unknown): string => t(`linen.refusal.${linenRefusal(e) ?? "failed"}`, { defaultValue: t("linen.refusal.failed") });
  const challans = [...(d?.openChallans ?? [])].sort((a, b) => Number(b.late) - Number(a.late) || a.dueAt.localeCompare(b.dueAt));

  return (
    <PaperScreen testId="linen-vendor" style={{ height: "var(--pp-h)" }}>
      <div className="lp-desk">
        <LinenTabs on="vendor" />
        <div className="lp-grid store vendor">
          <section className="lp-centre">
            <div className="lp-title">
              <div><h1>{t("linen.vendor.title")}</h1><p>{t("linen.vendor.sub")}</p></div>
              {notice !== null && <p role="alert" className={notice.ok ? "ln-notice ok" : "ln-notice"} data-testid="vendor-notice">{notice.text}</p>}
            </div>
            <div className="box lp-table-box">
              <table className="lp-table" data-testid="vendor-challans">
                <thead>
                  <tr>
                    <th>{t("linen.vendor.col.challan")}</th><th className="lp-narrow-hide">{t("linen.vendor.col.vendor")}</th><th>{t("linen.vendor.col.pieces")}</th>
                    <th>{t("linen.vendor.col.due")}</th><th>{t("linen.vendor.col.out")}</th><th />
                  </tr>
                </thead>
                <tbody>
                  {challans.map((c) => <ChallanRow key={c.id} c={c} onDone={say} refused={refused} />)}
                  {d !== undefined && challans.length === 0 && <tr><td colSpan={6} className="ln-empty">{t("linen.vendor.noChallans")}</td></tr>}
                </tbody>
              </table>
            </div>
            {d !== undefined && d.vendors.length > 0 && <SendToVendor vendors={d.vendors} onDone={say} refused={refused} />}
            {d !== undefined && d.vendors.length > 0 && <CheckBill vendors={d.vendors} month={d.month} onDone={say} refused={refused} />}
          </section>
          <aside className="lp-side">
            <section className="box" data-testid="vendor-reports">
              <header className="lp-h"><b>{t("linen.vendor.report", { month: d?.month ?? "" })}</b></header>
              {(d?.reports ?? []).map((r) => <ReportRow key={r.linenVendorId} r={r} onDone={say} refused={refused} />)}
              {d !== undefined && d.reports.length === 0 && <div className="ln-empty">{t("linen.vendor.noVendors")}</div>}
            </section>
            <section className="box" data-testid="vendor-bills">
              <header className="lp-h"><b>{t("linen.vendor.bills")}</b><span className="mono">{d?.bills.length ?? 0}</span></header>
              {(d?.bills ?? []).map((b) => <BillRow key={b.id} b={b} onDone={say} refused={refused} />)}
            </section>
            <section className="box" data-testid="vendor-licences">
              <header className="lp-h"><b>{t("linen.vendor.licences")}</b></header>
              {(d?.licences ?? []).map((l) => (
                <div key={l.id} className="lp-crow" data-testid={`licence-${l.kind}`}>
                  <div><b>{t(`linen.vendor.licence.${l.kind}`)}</b><small>{l.licenceNo} · {l.validTo}</small></div>
                  <span className={l.state === "ok" ? "ln-tag" : "ln-tag inf"}>
                    {l.state === "expired" ? t("linen.vendor.expired") : t("linen.vendor.daysLeft", { count: l.daysLeft })}
                  </span>
                </div>
              ))}
              {d !== undefined && d.licences.length === 0 && <div className="ln-empty">{t("linen.vendor.noLicences")}</div>}
            </section>
            <section className="box" data-testid="vendor-chemicals">
              <header className="lp-h"><b>{t("linen.vendor.chemicals")}</b><span className="mono">{t("linen.vendor.kg", { n: d?.chemicals.kgWashed ?? 0 })}</span></header>
              {(d?.chemicals.items ?? []).map((c) => (
                <div key={c.itemId} className="lp-crow"><div><b>{c.name}</b><small>{c.perKg} {c.uom}/kg · {rupees(c.costPerKgPaise)}/kg</small></div></div>
              ))}
              {d !== undefined && (
                <div className="lp-crow" data-testid="vendor-perkg">
                  <small>{t("linen.vendor.inHouse")}: {d.chemicals.inHouseCostPerKgPaise === null ? "—" : `${rupees(d.chemicals.inHouseCostPerKgPaise)}/kg`}</small>
                  <small>{t("linen.vendor.atVendor")}: {d.chemicals.vendorCostPerKgPaise === null ? "—" : `${rupees(d.chemicals.vendorCostPerKgPaise)}/kg`}</small>
                </div>
              )}
            </section>
          </aside>
        </div>
      </div>
    </PaperScreen>
  );
}

type Say = { onDone: (ok: boolean, text: string) => void; refused: (e: unknown) => string };

const when = (iso: string): string => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

/** One challan out; Return opens the dock count per item (accepted starts at what is out). */
function ChallanRow({ c, onDone, refused }: { c: LinenChallanCard } & Say): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const out = c.lines.filter((l) => l.missing > 0);
  const [rows, setRows] = useState(() => out.map((l) => ({ itemCode: l.itemCode, accepted: l.missing, damaged: 0, stained: 0 })));
  const save = useMutation({
    mutationFn: () => challanReturnApi(c.id, rows.filter((r) => r.accepted + r.damaged + r.stained > 0)),
    onSuccess: () => { setOpen(false); onDone(true, t("linen.vendor.returned")); void qc.invalidateQueries({ queryKey: ["linen"] }); },
    onError: (e) => onDone(false, refused(e)),
  });
  const set = (i: number, k: "accepted" | "damaged" | "stained", v: string): void =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: Math.max(0, Math.floor(Number(v) || 0)) } : r)));
  return (
    <>
      <tr className={c.late ? "hot" : ""} data-testid={`challan-${c.challanNo}`}>
        <td><b className="mono">{c.challanNo}</b>{c.rush ? <span className="ln-dim"> · {t("linen.vendor.rush")}</span> : ""}</td>
        <td className="lp-narrow-hide">{c.vendorName}</td>
        <td className="mono">{c.pieces} · {(c.weightGrams / 1000).toFixed(1)} kg</td>
        <td className={`mono${c.late ? " ln-err" : ""}`}>{when(c.dueAt)}{c.late ? ` · ${t("linen.vendor.late")}` : ""}</td>
        <td className="mono">{out.reduce((n, l) => n + l.missing, 0)}</td>
        <td><button type="button" className="ln-mini" onClick={() => setOpen((o) => !o)} data-testid={`return-${c.challanNo}`}>{t("linen.vendor.return")}</button></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6}>
            <div className="lp-form" data-testid={`return-form-${c.challanNo}`}>
              {rows.map((r, i) => (
                <span key={r.itemCode} className="lp-qc">
                  <b>{t(`linen.item.${r.itemCode}`, { defaultValue: r.itemCode })} · {t("linen.vendor.outN", { n: out[i]!.missing })}</b>
                  {(["accepted", "damaged", "stained"] as const).map((k) => (
                    <label key={k}>{t(`linen.vendor.${k}`)}<input inputMode="numeric" value={r[k]} onChange={(e) => set(i, k, e.target.value)} data-testid={`ret-${r.itemCode}-${k}`} /></label>
                  ))}
                </span>
              ))}
              <button type="button" className="ln-mini ok" disabled={save.isPending} onClick={() => save.mutate()} data-testid={`return-save-${c.challanNo}`}>{t("linen.vendor.saveReturn")}</button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** The soiled room's ordinary linen out to a vendor on a challan: vendor, dock weight, rush. */
function SendToVendor({ vendors, onDone, refused }: { vendors: { id: string; name: string }[] } & Say): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const floor = useQuery({ queryKey: ["linen", "floor"], queryFn: fetchLinenFloor });
  const pool = Object.entries(floor.data?.soiledRoom.general ?? {}).filter(([, n]) => n > 0);
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const [kg, setKg] = useState("");
  const [rush, setRush] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>({});
  const lines = pool.map(([itemCode]) => ({ itemCode, qty: Math.floor(Number(qty[itemCode] ?? "0") || 0) })).filter((l) => l.qty > 0);
  const grams = Math.round(Number(kg) * 1000);
  const send = useMutation({
    mutationFn: () => sendToVendorApi({ infected: false, lines, linenVendorId: vendorId, weightGrams: grams, rush }, newTapKey()),
    onSuccess: (r) => { setQty({}); setKg(""); onDone(true, t("linen.vendor.sent", { no: r.batchNo ?? "" })); void qc.invalidateQueries({ queryKey: ["linen"] }); },
    onError: (e) => onDone(false, refused(e)),
  });
  return (
    <section className="box" data-testid="vendor-send">
      <header className="lp-h"><b>{t("linen.vendor.send")}</b></header>
      <div className="lp-form" style={{ padding: "8px 12px" }}>
        <label>{t("linen.vendor.col.vendor")}
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} data-testid="send-vendor">
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        {pool.map(([itemCode, n]) => (
          <label key={itemCode}>{t(`linen.item.${itemCode}`, { defaultValue: itemCode })} · {n}
            <input inputMode="numeric" value={qty[itemCode] ?? ""} onChange={(e) => setQty((q) => ({ ...q, [itemCode]: e.target.value }))} data-testid={`send-${itemCode}`} />
          </label>
        ))}
        <label>{t("linen.vendor.weight")}<input inputMode="decimal" value={kg} onChange={(e) => setKg(e.target.value)} data-testid="send-kg" /></label>
        <label className="ln-check plain"><input type="checkbox" checked={rush} onChange={(e) => setRush(e.target.checked)} />{t("linen.vendor.rush")}</label>
        <button type="button" className="ln-mini ok" disabled={send.isPending || lines.length === 0 || !(grams > 0) || vendorId === ""} onClick={() => send.mutate()} data-testid="send-go">
          {t("linen.vendor.sendGo")}
        </button>
        {floor.data !== undefined && pool.length === 0 && <span className="ln-dim">{t("linen.vendor.nothingSoiled")}</span>}
      </div>
    </section>
  );
}

/** A vendor's month: the facts, the par verdict in words, and the recovery's next step for whoever may take it. */
function ReportRow({ r, onDone, refused }: { r: LinenVendorMonthReport } & Say): React.ReactElement {
  const { t } = useTranslation();
  const { can, actor } = useAuth();
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (verb: "raise" | "approve" | "reject") =>
      verb === "raise" ? raiseRecoveryApi(r.linenVendorId, r.month) : decideRecoveryApi(r.recovery!.id, verb),
    onSuccess: (_d, verb) => { onDone(true, t(`linen.vendor.done.${verb}`)); void qc.invalidateQueries({ queryKey: ["linen"] }); },
    onError: (e) => onDone(false, refused(e)),
  });
  const mayRaise = can("linen.vendor") && r.monthOver && r.proposed !== null && r.recovery === null;
  const mayDecide = can("linen.recovery.approve") && r.recovery?.state === "proposed" && r.recovery.proposedBy !== actor?.id;
  return (
    <div className="lp-crow col" data-testid={`report-${r.linenVendorId}`}>
      <div>
        <b>{r.vendorName} <span className={r.belowPar ? "ln-tag inf" : "ln-tag"}>{r.belowPar ? t("linen.vendor.belowPar") : t("linen.vendor.withinPar")}</span></b>
        <small>{t("linen.vendor.facts", { sent: r.piecesSent, lost: r.lost, damaged: r.damaged, late: r.lateBatches, batches: r.batches })}</small>
        {r.proposed !== null && <small>{t("linen.vendor.proposed", { amount: rupees(r.proposed.totalPaise) })}</small>}
        {r.reversals.length > 0 && <small>{t("linen.vendor.reversals", { count: r.reversals.reduce((n, x) => n + x.qty, 0) })}</small>}
        {r.recovery !== null && <small>{t(`linen.vendor.recovery.${r.recovery.state}`, { amount: rupees(r.recovery.approvedPaise ?? r.recovery.proposedPaise) })}</small>}
      </div>
      {mayRaise && <button type="button" className="ln-mini" disabled={act.isPending} onClick={() => act.mutate("raise")} data-testid={`raise-${r.linenVendorId}`}>{t("linen.vendor.raise")}</button>}
      {mayDecide && (
        <span className="lp-acts">
          <button type="button" className="ln-mini ok" disabled={act.isPending} onClick={() => act.mutate("approve")} data-testid={`approve-${r.linenVendorId}`}>{t("linen.vendor.approve")}</button>
          <button type="button" className="ln-mini" disabled={act.isPending} onClick={() => act.mutate("reject")} data-testid={`reject-${r.linenVendorId}`}>{t("linen.vendor.reject")}</button>
        </span>
      )}
    </div>
  );
}

function BillRow({ b, onDone, refused }: { b: LinenBillCard } & Say): React.ReactElement {
  const { t } = useTranslation();
  const { can, actor } = useAuth();
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (verb: "approve" | "refuse") => decideBillApi(b.id, verb),
    onSuccess: () => { onDone(true, t("linen.vendor.billDecided")); void qc.invalidateQueries({ queryKey: ["linen"] }); },
    onError: (e) => onDone(false, refused(e)),
  });
  const flagged = b.lines.filter((l) => l.flagged);
  return (
    <div className="lp-crow col" data-testid={`bill-${b.vendorBillNo}`}>
      <div>
        <b><span className="mono">{b.vendorBillNo}</span> · {t(`linen.vendor.billState.${b.state}`)}</b>
        <small>{t("linen.vendor.payable", { amount: rupees(b.payablePaise), billed: rupees(b.billedPaise) })}</small>
        {flagged.map((l) => <small key={l.itemCode} className="ln-err">{t("linen.vendor.flagged", { item: t(`linen.item.${l.itemCode}`, { defaultValue: l.itemCode }), billed: l.billed, accepted: l.accepted })}</small>)}
        {b.heldPaise > 0 && b.state === "held" && <small className="ln-err">{t("linen.vendor.held", { amount: rupees(b.heldPaise) })}</small>}
      </div>
      {b.state === "held" && can("linen.bill.approve") && b.checkedBy !== actor?.id && (
        <span className="lp-acts">
          <button type="button" className="ln-mini ok" disabled={act.isPending} onClick={() => act.mutate("approve")} data-testid={`bill-approve-${b.vendorBillNo}`}>{t("linen.vendor.approveExcess")}</button>
          <button type="button" className="ln-mini" disabled={act.isPending} onClick={() => act.mutate("refuse")}>{t("linen.vendor.refuseExcess")}</button>
        </span>
      )}
    </div>
  );
}

const BILL_ITEMS = ["bedsheet", "draw_sheet", "pillow_cover", "blanket", "patient_gown", "towel", "ot_gown", "ot_drape", "baby_wrap"] as const;

/** The vendor's bill as written, one item line: the server checks it against the pieces accepted that month. */
function CheckBill({ vendors, month, onDone, refused }: { vendors: { id: string; name: string }[]; month: string } & Say): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [f, setF] = useState({ vendorId: vendors[0]?.id ?? "", billNo: "", itemCode: "bedsheet", pieces: "", amount: "", billed: "" });
  const paise = (v: string): number => Math.round(Number(v) * 100);
  const check = useMutation({
    mutationFn: () => checkBillApi({
      linenVendorId: f.vendorId, month, vendorBillNo: f.billNo.trim(),
      lines: [{ itemCode: f.itemCode, pieces: Math.floor(Number(f.pieces)), amountPaise: paise(f.amount) }], billedPaise: paise(f.billed),
    }),
    onSuccess: (b) => { onDone(b.state !== "held", t(`linen.vendor.billState.${b.state}`)); void qc.invalidateQueries({ queryKey: ["linen"] }); },
    onError: (e) => onDone(false, refused(e)),
  });
  if (!can("linen.vendor")) return <></>;
  const ok = f.billNo.trim() !== "" && Number(f.pieces) >= 0 && f.pieces !== "" && Number(f.billed) > 0;
  return (
    <section className="box">
    <header className="lp-h"><b>{t("linen.vendor.checkTitle", { month })}</b></header>
    <div className="lp-form" style={{ padding: "8px 12px" }} data-testid="bill-form">
      <label>{t("linen.vendor.col.vendor")}<select value={f.vendorId} onChange={(e) => setF({ ...f, vendorId: e.target.value })}>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      <label>{t("linen.vendor.billItem")}<select value={f.itemCode} onChange={(e) => setF({ ...f, itemCode: e.target.value })} data-testid="bill-item">
        {BILL_ITEMS.map((c) => <option key={c} value={c}>{t(`linen.item.${c}`, { defaultValue: c })}</option>)}
      </select></label>
      <label>{t("linen.vendor.billNo")}<input value={f.billNo} onChange={(e) => setF({ ...f, billNo: e.target.value })} data-testid="bill-no" /></label>
      <label>{t("linen.vendor.billPieces")}<input inputMode="numeric" value={f.pieces} onChange={(e) => setF({ ...f, pieces: e.target.value })} data-testid="bill-pieces" /></label>
      <label>{t("linen.vendor.billAmount")}<input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
      <label>{t("linen.vendor.billTotal")}<input inputMode="decimal" value={f.billed} onChange={(e) => setF({ ...f, billed: e.target.value })} data-testid="bill-total" /></label>
      <button type="button" className="ln-mini ok" disabled={!ok || check.isPending} onClick={() => check.mutate()} data-testid="bill-check">{t("linen.vendor.checkBill")}</button>
    </div>
    </section>
  );
}
