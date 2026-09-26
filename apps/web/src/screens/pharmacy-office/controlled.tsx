import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import {
  endPrescriber, fetchBalance, fetchCheckSheet, fetchControlledLicences, fetchControlledToday, fetchPrescribers, fetchRegisterDocument,
  postWitnessedAct, recordCheck, recordControlledLicence, recordPrescriber,
} from "../../lib/controlled-api";
import { pharmacyErrorText } from "../../lib/pharmacy-api";
import { printInFrame } from "../../lib/print-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "./sheet";
import type { LicenceKind, WireBalance, WireCheckResult, Witness, WitnessedAct } from "../../lib/controlled-api";

/**
 * ═══ PHARMACY P6 — THE OFFICE'S CONTROLLED SIDE (`?view=controlled`) ═══
 *
 * The cabinet of NDPS narcotic / psychotropic and Schedule X drugs, one screen: what needs this person
 * today (a licence missing, lapsed or inside 60 days; today's balance check; a count that did not balance;
 * the acts waiting for two keys), the licences and the trained prescribers, the day's count, the registers
 * printed in the forms' layout, and the balance that must meet the stock ledger.
 *
 * Keys: L licences, C count the cabinet, R print the register, B the balance; ↑/↓ through the waiting acts,
 * ⏎ opens one. Every act at the cabinet asks for the witness's username and PIN in its own sheet.
 */
const today = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

type Open =
  | { kind: "licences" } | { kind: "check" } | { kind: "register" } | { kind: "balance" }
  | { kind: "act"; act: WitnessedAct; label: string; needs: "officer" | "approval" | null };

export function ControlledView(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["pharmacy", "controlled", "today"], queryFn: fetchControlledToday });
  const [open, setOpen] = useState<Open | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const d = q.data;
  const custodian = can("pharmacy.ndps.custody");
  const keeper = can("pharmacy.licences.manage");

  const onKey = (e: React.KeyboardEvent): void => {
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement).tagName);
    if (typing || open !== null || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "l") { e.preventDefault(); setOpen({ kind: "licences" }); return; }
    if (k === "c" && custodian) { e.preventDefault(); setOpen({ kind: "check" }); return; }
    if (k === "r") { e.preventDefault(); setOpen({ kind: "register" }); return; }
    if (k === "b") { e.preventDefault(); setOpen({ kind: "balance" }); }
  };

  const acts: { key: string; label: string; open: Open }[] = d === undefined ? [] : [
    ...d.pending.grns.map((g) => ({ key: g.id, label: t("pharmacyOffice.controlled.act.grn", { no: g.grnNo, challan: g.challanNo }), open: { kind: "act" as const, act: { act: "grn_post" as const, grnId: g.id }, label: g.grnNo, needs: null } })),
    ...d.pending.writeOffs.filter((w) => w.approvalStatus === "granted").map((w) => ({
      key: w.id, label: t("pharmacyOffice.controlled.act.writeOff", { no: w.writeOffNo }),
      open: { kind: "act" as const, act: { act: "write_off_post" as const, writeOffId: w.id }, label: w.writeOffNo, needs: "officer" as const },
    })),
    ...d.pending.adjustments.map((a) => ({
      key: a.approvalId, label: t("pharmacyOffice.controlled.act.adjustment", { lines: a.lines, net: a.netQty }),
      open: { kind: "act" as const, act: { act: "adjustment_post" as const, approvalId: a.approvalId }, label: t("pharmacyOffice.controlled.act.adjustmentTitle"), needs: null },
    })),
  ];

  return (
    <div className="space-y-5 focus:outline-none" tabIndex={-1} onKeyDown={onKey} data-testid="controlled-view">
      {q.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(q.error, t)}</p>}
      {notice !== null && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {d !== undefined && (
        <>
          <section className="rounded border border-emerald-700/40 bg-emerald-50/40 p-3" data-testid="controlled-needs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-emerald-800 px-1.5 py-0.5 text-xs font-medium text-white">{t("pharmacyOffice.agent.tag")}</span>
              <span className="text-sm font-medium">{d.needsYou.length === 0 ? t("pharmacyOffice.controlled.allClear") : t("pharmacyOffice.controlled.needsTitle", { count: d.needsYou.length })}</span>
            </div>
            <ul className="mt-2 space-y-1 text-sm">
              {d.needsYou.map((n, i) => <li key={`${n.key}-${String(i)}`} data-testid={`need-${n.key}`}>• {t(`pharmacyOffice.controlled.needs.${n.key}`, n.params)}</li>)}
            </ul>
          </section>

          <div className="grid gap-3 md:grid-cols-2">
            {(["ndps_rmi", "schedule_x"] as LicenceKind[]).map((k) => {
              const s = d.licences[k];
              return (
                <div key={k} className={`rounded border p-3 ${s.state === "current" && !s.renewalDue ? "" : "border-amber-400"}`} data-testid={`licence-${k}`}>
                  <div className="text-xs text-muted-foreground">{t(`pharmacyOffice.controlled.licence.${k}`)}</div>
                  <div className="text-sm font-medium">{s.licence === null ? t("pharmacyOffice.controlled.licence.none") : `${s.licence.form} ${s.licence.licenceNo}`}</div>
                  <div className="text-xs">{t(`pharmacyOffice.controlled.licence.state.${s.state}`, { until: s.licence?.validUntil ?? "", days: s.daysLeft ?? 0 })}</div>
                </div>
              );
            })}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded border p-3" data-testid="controlled-check-card">
              <div className="text-xs text-muted-foreground">{t("pharmacyOffice.controlled.checkTitle")}</div>
              <div className="text-sm">{d.checkedToday === null ? t("pharmacyOffice.controlled.checkNotDone") : t(d.checkedToday.balanced ? "pharmacyOffice.controlled.checkBalanced" : "pharmacyOffice.controlled.checkDiscrepancy")}</div>
              {custodian && <Button type="button" className="mt-2" onClick={() => setOpen({ kind: "check" })}>{t("pharmacyOffice.controlled.count")} <span className="ml-1 text-xs opacity-70">C</span></Button>}
            </div>
            <div className={`rounded border p-3 ${d.discrepancies.length > 0 ? "border-red-400" : ""}`} data-testid="controlled-discrepancies">
              <div className="text-2xl font-semibold tabular-nums">{d.discrepancies.length}</div>
              <div className="text-xs text-muted-foreground">{t("pharmacyOffice.controlled.discrepancies")}</div>
            </div>
            <div className={`rounded border p-3 ${d.custodianPairHeld ? "" : "border-red-400"}`} data-testid="controlled-pair">
              <div className="text-sm">{t(d.custodianPairHeld ? "pharmacyOffice.controlled.pairHeld" : "pharmacyOffice.controlled.pairMissing")}</div>
            </div>
          </div>

          <section>
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t("pharmacyOffice.controlled.waiting")}</h2>
            {acts.length === 0 ? <p className="text-sm text-muted-foreground">{t("pharmacyOffice.controlled.nothingWaiting")}</p> : (
              <ul className="divide-y rounded border">
                {acts.map((a) => (
                  <li key={a.key}>
                    <button type="button" data-testid={`act-${a.key}`} disabled={!custodian}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none" onClick={() => setOpen(a.open)}>
                      <span className="flex-1">{a.label}</span><span className="text-xs text-muted-foreground">{t("pharmacyOffice.controlled.twoKeys")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen({ kind: "licences" })}>{t("pharmacyOffice.controlled.licences")} <span className="ml-1 text-xs opacity-70">L</span></Button>
            <Button type="button" variant="outline" onClick={() => setOpen({ kind: "register" })}>{t("pharmacyOffice.controlled.register")} <span className="ml-1 text-xs opacity-70">R</span></Button>
            <Button type="button" variant="outline" onClick={() => setOpen({ kind: "balance" })}>{t("pharmacyOffice.controlled.balance")} <span className="ml-1 text-xs opacity-70">B</span></Button>
          </div>
        </>
      )}
      {open?.kind === "licences" && <LicenceSheet canManage={keeper} onClose={() => setOpen(null)} />}
      {open?.kind === "check" && <CheckSheet onClose={() => setOpen(null)} onDone={(r) => { setOpen(null); setNotice(t(r.balanced ? "pharmacyOffice.controlled.checked" : "pharmacyOffice.controlled.checkedShort")); }} />}
      {open?.kind === "register" && <RegisterSheet onClose={() => setOpen(null)} />}
      {open?.kind === "balance" && <BalanceSheet onClose={() => setOpen(null)} />}
      {open?.kind === "act" && <ActSheet act={open.act} label={open.label} needs={open.needs} onClose={() => setOpen(null)} onDone={() => { setOpen(null); setNotice(t("pharmacyOffice.controlled.actDone")); }} />}
    </div>
  );
}

function WitnessFields({ value, onChange }: { value: Witness; onChange: (w: Witness) => void }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid="witness-fields">
      <label className="text-sm">{t("pharmacyOffice.controlled.witness")}
        <Input data-testid="witness-username" autoComplete="off" value={value.username} onChange={(e) => onChange({ ...value, username: e.target.value })} />
      </label>
      <label className="text-sm">{t("pharmacyOffice.controlled.pin")}
        <Input data-testid="witness-pin" type="password" inputMode="numeric" autoComplete="off" value={value.pin} onChange={(e) => onChange({ ...value, pin: e.target.value })} />
      </label>
    </div>
  );
}

const FORM_OF: Record<LicenceKind, string> = { ndps_rmi: "Form 3G", schedule_x: "Form 20F" };

function LicenceSheet({ canManage, onClose }: { canManage: boolean; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["pharmacy", "controlled", "licences"], queryFn: fetchControlledLicences });
  const doctors = useQuery({ queryKey: ["pharmacy", "controlled", "prescribers"], queryFn: fetchPrescribers });
  const [kind, setKind] = useState<LicenceKind>("ndps_rmi");
  const [f, setF] = useState({ licenceNo: "", issuingAuthority: "", holderName: "", responsiblePerson: "", validFrom: "", validUntil: "", documentRef: "" });
  const [doc, setDoc] = useState({ doctorId: "", training: "" });
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    setError(null);
    try {
      await recordControlledLicence({ kind, form: FORM_OF[kind], ...f, ...(f.documentRef.trim() === "" ? {} : { documentRef: f.documentRef.trim() }) });
      setF({ licenceNo: "", issuingAuthority: "", holderName: "", responsiblePerson: "", validFrom: "", validUntil: "", documentRef: "" });
      await qc.invalidateQueries({ queryKey: ["pharmacy", "controlled"] });
    } catch (e) { setError(pharmacyErrorText(e, t)); }
  };
  const addDoctor = async (): Promise<void> => {
    setError(null);
    try { await recordPrescriber(doc.doctorId, doc.training); setDoc({ doctorId: "", training: "" }); await qc.invalidateQueries({ queryKey: ["pharmacy", "controlled"] }); } catch (e) { setError(pharmacyErrorText(e, t)); }
  };
  const field = (k: keyof typeof f, label: string, type = "text"): React.ReactElement => (
    <label className="text-sm">{label}<Input data-testid={`lic-${k}`} type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
  );
  return (
    <Sheet title={t("pharmacyOffice.controlled.licences")} onClose={onClose} testId="licence-sheet">
      {error !== null && <p role="alert" className="mb-2 text-sm text-red-600">{error}</p>}
      {canManage && (
        <form className="grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="text-sm">{t("pharmacyOffice.controlled.licence.kind")}
            <select className="block h-9 w-full rounded border px-2" data-testid="lic-kind" value={kind} onChange={(e) => setKind(e.target.value as LicenceKind)}>
              <option value="ndps_rmi">{t("pharmacyOffice.controlled.licence.ndps_rmi")}</option>
              <option value="schedule_x">{t("pharmacyOffice.controlled.licence.schedule_x")}</option>
            </select>
          </label>
          {field("licenceNo", t("pharmacyOffice.controlled.licence.number", { form: FORM_OF[kind] }))}
          {field("issuingAuthority", t("pharmacyOffice.controlled.licence.authority"))}
          {field("holderName", t("pharmacyOffice.controlled.licence.holder"))}
          {field("responsiblePerson", t(kind === "ndps_rmi" ? "pharmacyOffice.controlled.licence.designatedRmp" : "pharmacyOffice.controlled.licence.pharmacist"))}
          {field("documentRef", t("pharmacyOffice.controlled.licence.documentRef"))}
          {field("validFrom", t("pharmacyOffice.controlled.licence.validFrom"), "date")}
          {field("validUntil", t(kind === "schedule_x" ? "pharmacyOffice.controlled.licence.retentionDue" : "pharmacyOffice.controlled.licence.validUntil"), "date")}
          <div className="sm:col-span-2"><Button type="submit" data-testid="lic-save">{t("pharmacyOffice.controlled.licence.save")}</Button></div>
        </form>
      )}
      <h3 className="mt-4 text-sm font-semibold">{t("pharmacyOffice.controlled.licence.history")}</h3>
      <ul className="text-sm" data-testid="licence-history">
        {(list.data?.items ?? []).map((l) => (
          <li key={l.id}>{t(`pharmacyOffice.controlled.licence.${l.kind}`)} · {l.form} {l.licenceNo} · {l.validFrom} → {l.validUntil} · {l.issuingAuthority}</li>
        ))}
      </ul>
      <h3 className="mt-4 text-sm font-semibold">{t("pharmacyOffice.controlled.prescribers")}</h3>
      <p className="text-xs text-muted-foreground">{t("pharmacyOffice.controlled.prescribersWhy")}</p>
      <ul className="text-sm" data-testid="prescriber-list">
        {(doctors.data?.current ?? []).map((p) => (
          <li key={p.id} className="flex items-center gap-2">
            <span className="flex-1">{p.doctorName} ({p.registrationNo ?? "—"}) · {p.training}</span>
            {canManage && <button type="button" className="text-xs underline" onClick={() => void endPrescriber(p.id, "ended at the office").then(() => qc.invalidateQueries({ queryKey: ["pharmacy", "controlled"] }))}>{t("pharmacyOffice.controlled.end")}</button>}
          </li>
        ))}
      </ul>
      {canManage && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="text-sm">{t("pharmacyOffice.controlled.doctor")}
            <select className="block h-9 rounded border px-2" data-testid="rx-doctor" value={doc.doctorId} onChange={(e) => setDoc({ ...doc, doctorId: e.target.value })}>
              <option value="">—</option>
              {(doctors.data?.doctors ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <label className="flex-1 text-sm">{t("pharmacyOffice.controlled.training")}<Input data-testid="rx-training" value={doc.training} onChange={(e) => setDoc({ ...doc, training: e.target.value })} /></label>
          <Button type="button" disabled={doc.doctorId === "" || doc.training.trim() === ""} onClick={() => void addDoctor()}>{t("pharmacyOffice.controlled.addDoctor")}</Button>
        </div>
      )}
    </Sheet>
  );
}

function CheckSheet({ onClose, onDone }: { onClose: () => void; onDone: (r: WireCheckResult) => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const sheet = useQuery({ queryKey: ["pharmacy", "controlled", "check"], queryFn: fetchCheckSheet });
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [witness, setWitness] = useState<Witness>({ username: "", pin: "" });
  const [error, setError] = useState<string | null>(null);
  const lines = sheet.data?.lines ?? [];
  const complete = lines.every((l) => /^\d+$/.test(counts[l.batchId] ?? "")) && witness.username.trim() !== "" && witness.pin !== "";
  const submit = async (): Promise<void> => {
    setError(null);
    try {
      const r = await recordCheck(witness, lines.map((l) => ({ batchId: l.batchId, countedQty: Number(counts[l.batchId]) })));
      await qc.invalidateQueries({ queryKey: ["pharmacy", "controlled"] });
      onDone(r);
    } catch (e) { setError(pharmacyErrorText(e, t)); }
  };
  return (
    <Sheet title={t("pharmacyOffice.controlled.checkTitle")} onClose={onClose} testId="check-sheet">
      <p className="mb-2 text-xs text-muted-foreground">{t("pharmacyOffice.controlled.checkWhy")}</p>
      {error !== null && <p role="alert" className="mb-2 text-sm text-red-600">{error}</p>}
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-muted-foreground"><th>{t("pharmacyOffice.controlled.drug")}</th><th>{t("pharmacyOffice.controlled.batch")}</th><th className="text-right">{t("pharmacyOffice.controlled.book")}</th><th className="text-right">{t("pharmacyOffice.controlled.counted")}</th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.batchId} className="border-t">
              <td>{l.drugName}</td><td className="font-mono text-xs">{l.batchNo}</td><td className="text-right tabular-nums">{l.onHand} {l.unit}</td>
              <td className="text-right"><Input className="ml-auto w-24 text-right" data-testid={`count-${l.batchNo}`} inputMode="numeric" value={counts[l.batchId] ?? ""} onChange={(e) => setCounts({ ...counts, [l.batchId]: e.target.value.trim() })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3"><WitnessFields value={witness} onChange={setWitness} /></div>
      <Button type="button" className="mt-3" disabled={!complete} data-testid="check-submit" onClick={() => void submit()}>{t("pharmacyOffice.controlled.recordCheck")}</Button>
    </Sheet>
  );
}

function ActSheet({ act, label, needs, onClose, onDone }: {
  act: WitnessedAct; label: string; needs: "officer" | "approval" | null; onClose: () => void; onDone: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [witness, setWitness] = useState<Witness>({ username: "", pin: "" });
  const [officer, setOfficer] = useState({ name: "", designation: "", orderRef: "" });
  const [disposal, setDisposal] = useState({ disposalAgency: "", manifestNo: "", disposalDate: "" });
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    setError(null);
    const body: WitnessedAct = act.act === "write_off_post" ? {
      ...act,
      ...(officer.name.trim() === "" ? {} : { officer }),
      disposal: Object.fromEntries(Object.entries(disposal).filter(([, v]) => v.trim() !== "")),
    } : act;
    try { await postWitnessedAct(witness, body); await qc.invalidateQueries({ queryKey: ["pharmacy", "controlled"] }); onDone(); } catch (e) { setError(pharmacyErrorText(e, t)); }
  };
  return (
    <Sheet title={`${label} · ${t("pharmacyOffice.controlled.twoKeys")}`} onClose={onClose} testId="act-sheet">
      {error !== null && <p role="alert" className="mb-2 text-sm text-red-600">{error}</p>}
      {needs === "officer" && (
        <div className="mb-3 grid gap-2 sm:grid-cols-3" data-testid="officer-fields">
          <p className="text-xs text-muted-foreground sm:col-span-3">{t("pharmacyOffice.controlled.officerWhy")}</p>
          <label className="text-sm">{t("pharmacyOffice.controlled.officerName")}<Input data-testid="officer-name" value={officer.name} onChange={(e) => setOfficer({ ...officer, name: e.target.value })} /></label>
          <label className="text-sm">{t("pharmacyOffice.controlled.officerDesignation")}<Input value={officer.designation} onChange={(e) => setOfficer({ ...officer, designation: e.target.value })} /></label>
          <label className="text-sm">{t("pharmacyOffice.controlled.officerOrder")}<Input value={officer.orderRef} onChange={(e) => setOfficer({ ...officer, orderRef: e.target.value })} /></label>
          <label className="text-sm">{t("pharmacyOffice.controlled.agency")}<Input value={disposal.disposalAgency} onChange={(e) => setDisposal({ ...disposal, disposalAgency: e.target.value })} /></label>
          <label className="text-sm">{t("pharmacyOffice.controlled.manifest")}<Input value={disposal.manifestNo} onChange={(e) => setDisposal({ ...disposal, manifestNo: e.target.value })} /></label>
          <label className="text-sm">{t("pharmacyOffice.controlled.handedOn")}<Input type="date" value={disposal.disposalDate} onChange={(e) => setDisposal({ ...disposal, disposalDate: e.target.value })} /></label>
        </div>
      )}
      <WitnessFields value={witness} onChange={setWitness} />
      <Button type="button" className="mt-3" data-testid="act-submit" disabled={witness.username.trim() === "" || witness.pin === ""} onClick={() => void submit()}>{t("pharmacyOffice.controlled.post")}</Button>
    </Sheet>
  );
}

function RegisterSheet({ onClose }: { onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [kind, setKind] = useState<"form3h" | "schedule_x">("form3h");
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const print = async (): Promise<void> => {
    setError(null);
    try { if (!printInFrame(await fetchRegisterDocument(kind, from, to))) setError(t("pharmacyOffice.sheet.printFailed")); } catch (e) { setError(pharmacyErrorText(e, t)); }
  };
  return (
    <Sheet title={t("pharmacyOffice.controlled.register")} onClose={onClose} testId="register-sheet">
      {error !== null && <p role="alert" className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">{t("pharmacyOffice.controlled.whichRegister")}
          <select className="block h-9 rounded border px-2" data-testid="register-kind" value={kind} onChange={(e) => setKind(e.target.value as "form3h" | "schedule_x")}>
            <option value="form3h">{t("pharmacyOffice.controlled.form3h")}</option>
            <option value="schedule_x">{t("pharmacyOffice.controlled.scheduleXRegister")}</option>
          </select>
        </label>
        <label className="text-sm">{t("pharmacyOffice.controlled.from")}<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-sm">{t("pharmacyOffice.controlled.to")}<Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <Button type="button" data-testid="register-print" onClick={() => void print()}>{t("pharmacyOffice.controlled.print")}</Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t("pharmacyOffice.controlled.registerWhy")}</p>
    </Sheet>
  );
}

function BalanceSheet({ onClose }: { onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [data, setData] = useState<WireBalance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async (): Promise<void> => {
    setError(null);
    try { setData(await fetchBalance(from, to)); } catch (e) { setError(pharmacyErrorText(e, t)); }
  };
  return (
    <Sheet title={t("pharmacyOffice.controlled.balance")} onClose={onClose} testId="balance-sheet">
      {error !== null && <p role="alert" className="mb-2 text-sm text-red-600">{error}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">{t("pharmacyOffice.controlled.from")}<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-sm">{t("pharmacyOffice.controlled.to")}<Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <Button type="button" data-testid="balance-load" onClick={() => void load()}>{t("pharmacyOffice.controlled.show")}</Button>
      </div>
      {data !== null && (
        <>
          <p className={`mt-2 text-sm ${data.reconciled ? "text-green-700" : "text-red-700"}`} data-testid="balance-verdict">
            {t(data.reconciled ? "pharmacyOffice.controlled.reconciled" : "pharmacyOffice.controlled.notReconciled")}
          </p>
          <table className="mt-2 w-full text-sm" data-testid="balance-table">
            <thead><tr className="text-left text-xs text-muted-foreground">
              <th>{t("pharmacyOffice.controlled.drug")}</th><th>{t("pharmacyOffice.controlled.batch")}</th>
              {(["opening", "received", "issued", "destroyed", "adjusted", "closing", "ledgerClosing"] as const).map((c) => <th key={c} className="text-right">{t(`pharmacyOffice.controlled.col.${c}`)}</th>)}
              <th />
            </tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.batchId} className="border-t">
                  <td>{r.drugName}</td><td className="font-mono text-xs">{r.batchNo}</td>
                  {([r.opening, r.received, r.issued, r.destroyed, r.adjusted, r.closing, r.ledgerClosing]).map((n, i) => <td key={i} className="text-right tabular-nums">{n}</td>)}
                  <td className={r.reconciled ? "text-green-700" : "text-red-700"}>{r.reconciled ? "✓" : "✗"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Sheet>
  );
}
