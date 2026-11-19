import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { QrScan, cameraScanPossible } from "../components/qr-scan";
import { ApiError, apiDownload } from "../lib/api";
import {
  acceptAssetTransfer, addAssetDetails, assetAdditions, assetById, assetFoundHere, assetLabel, assetLookup, assetRegister, assetsDue, closeAssetRepair,
  closeRound, getRound, myAssets, openAssetRepair, proposeAssetTransfer, reportAssetFault, scanRound, startRound, tagLine, tagLines, tagUnits,
  verificationRounds,
} from "../lib/assets-api";
import { printDocumentHere, readPrintSetting } from "../lib/browser-print";
import { listAllShelves, myShelves, storesErrorCode } from "../lib/stores-api";
import { useOnline } from "./stores-tickets";
import "./stores.css";
import type {
  StoresAssetStatus, StoresDueWord, WireAssetDue, WireAssetLookup, WireAssetNext, WireAssetPassportFull, WireAssetPassportForeign, WireAssetRegisterRow,
  WireStoresShelf, WireTagLine, WireVerificationRound,
} from "@hmis/contracts";

/**
 * STORES S4a (#1114, spec "## Screens") — THE ASSET PASSPORT.
 *
 * Phone (390 px, no sideways scroll): `StoresAssetPassport` opens on the camera with the typed last four beside it; a
 * read shows the passport on one screen (name · last four large · status word; place, department, put to use; warranty,
 * AMC and calibration each with a date and a word; the last five events) and ONE primary, Report fault (a one-line
 * sheet: two taps). Another department's unit shows only "Belongs to …" and Found here. Below the scanner: the
 * department's own units (All / Due / Out) and any unit waiting for this person to accept. `StoresTagUnits` tags a
 * GRN line's units (scan or type each serial, Tag and print). `StoresVerificationRound` is the walk with the phone.
 *
 * Desk (16:9): `StoresAssets` — Register, Due, Verification, Condemnation (S4b) and Exports, one primary each.
 * Every status is a word, never a colour alone. Loading is grey rows with no text.
 */

/* ═══════════════════════════════ shared pieces ═══════════════════════════════ */

const page: React.CSSProperties = {
  maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box", padding: "12px 16px 24px", display: "flex", flexDirection: "column", gap: 10,
  background: "var(--paper, #fff)", minHeight: "100%",
};
const desk: React.CSSProperties = { ...page, padding: "16px 24px", gap: 12 };
const rowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap", overflow: "hidden", minHeight: 44,
  borderBottom: "1px solid var(--rule, #e3e3e3)", padding: "4px 0",
};
const cell: React.CSSProperties = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" };
const btn: React.CSSProperties = { minHeight: 40, padding: "0 12px", borderRadius: 6, border: "1px solid var(--ink, #222)", background: "transparent", color: "var(--ink, #222)", flexShrink: 0 };
const primary: React.CSSProperties = { ...btn, background: "var(--ink, #222)", color: "var(--paper, #fff)", fontWeight: 600 };
const word: React.CSSProperties = { flexShrink: 0, fontWeight: 600, padding: "2px 8px", borderRadius: 10, border: "1px solid var(--ink, #222)", fontSize: 13, whiteSpace: "nowrap" };
const input: React.CSSProperties = {
  minHeight: 44, boxSizing: "border-box", width: "100%", fontSize: 16, padding: "0 10px", borderRadius: 6,
  border: "1px solid var(--ink, #222)", background: "var(--card, #fff)", color: "var(--ink, #222)",
};
const stack: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const dim: React.CSSProperties = { color: "var(--dim, #5c6f66)", fontSize: 14, flexShrink: 0 };
const th: React.CSSProperties = { textAlign: "left", padding: "6px 8px", borderBottom: "2px solid var(--ink, #222)", whiteSpace: "nowrap", fontSize: 14 };
const td: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid var(--rule, #e3e3e3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 280 };

/** A status word with a dashed border for the words that need a hand (never colour alone). */
function StatusWord({ status }: { status: StoresAssetStatus }): React.ReactElement {
  const { t } = useTranslation();
  const hot = status === "overdue" || status === "missing" || status === "under_repair" || status === "out_repair";
  return <span data-status={status} style={{ ...word, borderStyle: hot ? "dashed" : "solid" }}>{t(`stores.assets.status.${status}`)}</span>;
}

function DueWord({ w }: { w: StoresDueWord }): React.ReactElement {
  const { t } = useTranslation();
  return <span data-due={w} style={{ ...word, fontWeight: w === "ok" ? 400 : 700, borderStyle: w === "overdue" ? "dashed" : "solid" }}>{t(`stores.assets.due.${w}`)}</span>;
}

/** "20 Nov 2026" (English) / the same in Hindi. */
export function assetDay(d: string, lang: string): string {
  return new Date(`${d}T00:00:00+05:30`).toLocaleDateString(lang === "hi" ? "hi-IN" : "en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

function Offline(): React.ReactElement | null {
  const { t } = useTranslation();
  return useOnline() ? null : <p role="alert" data-testid="stores-offline" style={{ margin: 0, fontWeight: 700 }}>{t("stores.ticket.offline")}</p>;
}

function GreyRows({ n = 3 }: { n?: number }): React.ReactElement {
  return <div aria-busy="true">{Array.from({ length: n }, (_, i) => <div key={i} aria-hidden="true" style={{ ...rowStyle, background: "var(--rule, #eee)", borderRadius: 4, marginBottom: 4 }} />)}</div>;
}

/** A refusal's few words: the server's code, "No connection" when the network failed, else "Could not save". */
function useRefusal(): (e: unknown) => string {
  const { t } = useTranslation();
  return (e) => {
    if (!(e instanceof ApiError)) return t("stores.ticket.offline");
    const code = storesErrorCode(e);
    return code === null ? t("stores.err.failed") : t(`stores.err.${code}`, { defaultValue: t("stores.err.failed") });
  };
}

function Notice({ n }: { n: { text: string; ok: boolean } | null }): React.ReactElement | null {
  if (n === null) return null;
  return (
    <p role="status" data-tone={n.ok ? "ok" : "refused"} style={{
      margin: 0, fontWeight: 700, fontSize: 17, padding: "8px 12px", borderRadius: 6,
      borderLeft: `6px solid ${n.ok ? "var(--state-settled, #1a7f37)" : "var(--state-danger, #b42318)"}`, background: "var(--line, #eef2ef)",
    }}>{n.text}</p>
  );
}

/** The camera (when there is one) with the typed last four beside it; four digits look the code up at once. */
export function ScanOrType({ onCode, label }: { onCode: (code: string) => void; label?: string }): React.ReactElement {
  const { t } = useTranslation();
  const [scanning, setScanning] = useState(cameraScanPossible());
  const [noCamera, setNoCamera] = useState(false);
  const [code, setCode] = useState("");
  return (
    <>
      {scanning && <QrScan onRead={(text) => { setScanning(false); onCode(text); }} onClose={(why) => { setScanning(false); if (why === "unavailable") setNoCamera(true); }} />}
      {!scanning && !noCamera && cameraScanPossible() && (
        <button type="button" style={{ ...primary, minHeight: 48 }} onClick={() => setScanning(true)}>{label ?? t("stores.assets.scan")}</button>
      )}
      <label style={stack}>
        <span>{t("stores.gate.typeLast4")}</span>
        <input
          inputMode="numeric" autoComplete="off" maxLength={4} aria-label={t("stores.gate.typeLast4")} value={code}
          onChange={(e) => {
            const c = e.target.value.replace(/\D/g, "").slice(0, 4);
            setCode(c);
            if (c.length === 4) { onCode(c); setCode(""); }
          }}
          style={{ ...input, fontSize: 20, letterSpacing: 4 }}
        />
      </label>
    </>
  );
}

/* ═══════════════════════════════ the passport (phone) ═══════════════════════════════ */

export function StoresAssetPassport(): React.ReactElement {
  const { t } = useTranslation();
  const search = useSearch({ strict: false }) as { code?: string; unit?: string };
  const refusal = useRefusal();
  const [found, setFound] = useState<WireAssetLookup | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [refused, setRefused] = useState(false);

  const load = (p: Promise<WireAssetLookup>): void => {
    setNotice(null);
    setRefused(false);
    setBusy(true);
    p.then(setFound).catch((e: unknown) => {
      setFound(null);
      if (storesErrorCode(e) === "not_permitted") setRefused(true);
      else setNotice({ text: refusal(e), ok: false });
    }).finally(() => setBusy(false));
  };
  useEffect(() => {
    if (search.unit !== undefined) load(assetById(search.unit));
    else if (search.code !== undefined) load(assetLookup(search.code));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.unit, search.code]);

  return (
    <div data-testid="stores-asset" className="stores-ui" style={page}>
      <Offline />
      <h1 style={{ margin: 0, fontSize: 18 }}>{t("stores.assets.title")}</h1>
      <Notice n={notice} />
      {busy ? <GreyRows n={4} />
        : found?.access === "full" ? <FullPassport p={found} onChange={setFound} onDone={() => setFound(null)} />
        : found?.access === "foreign" ? <ForeignPassport p={found} onDone={() => setFound(null)} />
        : found?.access === "choose" ? (
          <section data-testid="asset-choose" style={stack}>
            <strong>{t("stores.assets.choose")}</strong>
            {found.matches.map((m) => (
              <button key={m.unitId} type="button" style={{ ...btn, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}
                onClick={() => load(assetById(m.unitId))}>{`${m.tagNo.slice(-4)} · ${m.name} · ${m.place}`}</button>
            ))}
          </section>
        ) : (
          <>
            {refused && <p data-testid="asset-refused" style={{ margin: 0, fontWeight: 700 }}>{t("stores.assets.notYourDeptPlain")}</p>}
            <ScanOrType onCode={(c) => load(assetLookup(c))} />
            <DepartmentAssets onOpen={(id) => load(assetById(id))} />
          </>
        )}
    </div>
  );
}

function Row({ k, v, testId }: { k: string; v: React.ReactNode; testId?: string }): React.ReactElement {
  return (
    <div data-testid={testId} style={{ ...rowStyle, minHeight: 36 }}>
      <span style={{ ...dim, minWidth: 96 }}>{k}</span>
      <span style={{ ...cell, display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>{v}</span>
    </div>
  );
}

function DueRow({ label, due }: { label: string; due: WireAssetDue | null }): React.ReactElement {
  const { t, i18n } = useTranslation();
  return <Row k={label} v={due === null ? <span style={dim}>{t("stores.assets.noDate")}</span> : <><span>{assetDay(due.date, i18n.language)}</span><DueWord w={due.word} /></>} />;
}

function NextDue({ next }: { next: WireAssetNext | null }): React.ReactElement {
  const { t, i18n } = useTranslation();
  return (
    <div data-testid="asset-next" style={{ ...rowStyle, minHeight: 36, fontWeight: 600 }}>
      <span style={{ ...dim, minWidth: 96 }}>{t("stores.assets.next")}</span>
      {next === null ? <span style={{ ...cell, textAlign: "right" }}>{t("stores.assets.noDate")}</span> : (
        <span style={{ ...cell, display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
          <span>{`${t(`stores.assets.what.${next.what}`)} ${assetDay(next.date, i18n.language)}`}</span>
          <DueWord w={next.word} />
        </span>
      )}
    </div>
  );
}

const money = (paise: number): string => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

function FullPassport({ p, onChange, onDone }: { p: WireAssetPassportFull; onChange: (p: WireAssetLookup) => void; onDone: () => void }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const refusal = useRefusal();
  const [sheet, setSheet] = useState<null | "fault" | "details" | "transfer" | "repair">(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const done = (next: WireAssetLookup, text: string): void => { onChange(next); setSheet(null); setNotice({ text, ok: true }); };
  const fail = (e: unknown): void => setNotice({ text: refusal(e), ok: false });
  const printLabel = (): void => {
    if (readPrintSetting().mode === "relay") return;
    assetLabel(p.unit.id).then((doc) => { if (doc !== null) void printDocumentHere(doc); }).catch(fail);
  };
  const status = p.transfer !== null
    ? <span style={word}>{t("stores.assets.onItsWay", { dept: p.transfer.toDepartmentName })}</span>
    : <StatusWord status={p.status} />;
  return (
    <section data-testid="asset-passport" style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "2px solid var(--ink, #222)", paddingTop: 6 }}>
      {p.tagReplaced && <p style={{ margin: 0, fontWeight: 700 }}>{t("stores.assets.tagReplaced")}</p>}
      <div style={{ ...rowStyle, borderBottom: "none", minHeight: 0 }}>
        <strong data-testid="asset-name" style={{ ...cell, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 17 }}>{p.unit.name}</strong>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 34, fontWeight: 800, letterSpacing: 2, fontVariantNumeric: "tabular-nums" }}>{p.unit.last4}</span>
        <span style={{ ...dim, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.unit.tagNo}</span>
        {status}
      </div>
      {p.out !== null && <span>{`${t("stores.gate.dueBack", { date: assetDay(p.out.dueBack, i18n.language) })} · ${p.out.passNo.slice(-4)}`}</span>}
      {p.replace && <p style={{ margin: 0, fontWeight: 700 }}>{t("stores.assets.what.replace")}</p>}
      <Row k={t("stores.assets.place")} v={<span>{p.place.name}</span>} />
      <Row k={t("stores.assets.holder")} v={<span>{p.department?.name ?? "—"}</span>} />
      <Row k={t("stores.assets.putToUse")} v={<span>{p.putToUse === null ? t("stores.assets.noDate") : assetDay(p.putToUse, i18n.language)}</span>} />
      <NextDue next={p.next} />
      <DueRow label={t("stores.assets.what.warranty")} due={p.dues.warranty} />
      <DueRow label={t("stores.assets.what.amc")} due={p.dues.amc} />
      <DueRow label={t("stores.assets.what.calibration")} due={p.dues.calibration} />
      {p.device !== null && <Row k={t("stores.assets.device")} v={<span>{`${p.device.name} · ${p.device.status}`}</span>} />}
      {p.unit.serial !== null && <Row k={t("stores.assets.serial")} v={<span>{p.unit.serial}</span>} />}
      {"costPaise" in p && <Row k={t("stores.assets.cost")} v={<span>{p.costPaise === null || p.costPaise === undefined ? t("stores.assets.costUnknown") : money(p.costPaise)}</span>} />}
      <Notice n={notice} />
      {sheet === null && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {p.can.reportFault && <button type="button" style={{ ...primary, flex: "1 1 160px", minHeight: 48 }} onClick={() => { setNotice(null); setSheet("fault"); }}>{t("stores.assets.reportFault")}</button>}
          {p.can.acceptTransfer && (
            <button type="button" style={{ ...primary, flex: "1 1 160px", minHeight: 48 }}
              onClick={() => acceptAssetTransfer(p.unit.tagNo).then((n) => done(n, t("stores.assets.accepted"))).catch(fail)}>{t("stores.assets.accept")}</button>
          )}
          {p.can.addDetails && <button type="button" style={btn} onClick={() => { setNotice(null); setSheet("details"); }}>{t("stores.assets.addDetails")}</button>}
          {p.can.addDetails && <button type="button" style={btn} onClick={() => { setNotice(null); setSheet("repair"); }}>{t(p.status === "under_repair" ? "stores.assets.repaired" : "stores.assets.openRepair")}</button>}
          {p.can.transfer && <button type="button" style={btn} onClick={() => { setNotice(null); setSheet("transfer"); }}>{t("stores.assets.transfer")}</button>}
          {p.can.addDetails && <button type="button" style={btn} onClick={printLabel}>{t("stores.assets.printLabel")}</button>}
        </div>
      )}
      {sheet === "fault" && <FaultSheet unitId={p.unit.id} onDone={(n) => done(n, t("stores.assets.faultDone"))} onFail={fail} onCancel={() => setSheet(null)} />}
      {sheet === "details" && <DetailsSheet unitId={p.unit.id} onDone={(n) => done(n, t("stores.assets.saved"))} onFail={fail} onCancel={() => setSheet(null)} />}
      {sheet === "repair" && <RepairSheet unitId={p.unit.id} open={p.status === "under_repair"} onDone={(n) => done(n, t("stores.assets.saved"))} onFail={fail} onCancel={() => setSheet(null)} />}
      {sheet === "transfer" && <TransferSheet unitId={p.unit.id} from={p.place.id} onDone={(n) => done(n, t("stores.assets.transferAsked"))} onFail={fail} onCancel={() => setSheet(null)} />}
      <h2 style={{ margin: "6px 0 0", fontSize: 15 }}>{t("stores.assets.events")}</h2>
      {p.events.map((e, i) => (
        <div key={`${e.at}-${String(i)}`} style={{ ...rowStyle, minHeight: 32, fontSize: 14 }}>
          <span style={cell}>{[t(`stores.assets.ev.${e.kind}`, { defaultValue: t("stores.assets.ev.other") }), e.where, e.by.name,
            e.note !== null && /^\d{4}-\d{2}-\d{2}$/.test(e.note) ? assetDay(e.note, i18n.language) : e.note].filter((x) => x !== null && x !== "").join(" · ")}</span>
          <span style={dim}>{assetDay(e.at.slice(0, 10), i18n.language)}</span>
        </div>
      ))}
      <button type="button" style={{ ...btn, alignSelf: "flex-start" }} onClick={onDone}>{t("stores.assets.another")}</button>
    </section>
  );
}

type SheetProps = { unitId: string; onDone: (p: WireAssetLookup) => void; onFail: (e: unknown) => void; onCancel: () => void };

function SheetFrame({ children, testId }: { children: React.ReactNode; testId: string }): React.ReactElement {
  return <div data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 8, border: "1px solid var(--ink, #222)", borderRadius: 8, padding: 10 }}>{children}</div>;
}

/** One line of text; Send. With the passport's button that is two taps (budget). */
function FaultSheet({ unitId, onDone, onFail, onCancel }: SheetProps): React.ReactElement {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <SheetFrame testId="asset-fault-sheet">
      <label style={stack}>
        <span>{t("stores.assets.whatWrong")}</span>
        <input aria-label={t("stores.assets.whatWrong")} maxLength={200} value={text} onChange={(e) => setText(e.target.value)} style={input} autoFocus />
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={{ ...primary, flex: 1, minHeight: 48 }} disabled={busy || text.trim() === ""}
          onClick={() => { setBusy(true); reportAssetFault(unitId, text.trim()).then(onDone).catch(onFail).finally(() => setBusy(false)); }}>{t("stores.assets.send")}</button>
        <button type="button" style={btn} onClick={onCancel}>{t("stores.assets.cancel")}</button>
      </div>
    </SheetFrame>
  );
}

function DetailsSheet({ unitId, onDone, onFail, onCancel }: SheetProps): React.ReactElement {
  const { t } = useTranslation();
  const [f, setF] = useState({ warrantyEnd: "", kind: "amc" as "amc" | "cmc", start: "", end: "", calDone: "", calDue: "", agency: "", installedOn: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>): void => setF((x) => ({ ...x, [k]: e.target.value }));
  const date = (k: keyof typeof f, label: string): React.ReactElement => (
    <label style={stack}><span>{label}</span><input type="date" aria-label={label} value={f[k]} onChange={set(k)} style={input} /></label>
  );
  const save = (): void => {
    addAssetDetails(unitId, {
      warrantyEnd: f.warrantyEnd || null,
      contract: f.start !== "" && f.end !== "" ? { kind: f.kind, start: f.start, end: f.end } : null,
      calibration: f.calDone !== "" && f.calDue !== "" && f.agency.trim() !== "" ? { doneOn: f.calDone, dueOn: f.calDue, agency: f.agency.trim() } : null,
      installedOn: f.installedOn || null,
    }).then(onDone).catch(onFail);
  };
  return (
    <SheetFrame testId="asset-details-sheet">
      {date("warrantyEnd", t("stores.assets.warrantyEnd"))}
      <label style={stack}>
        <span>{t("stores.assets.contract")}</span>
        <select aria-label={t("stores.assets.contract")} value={f.kind} onChange={set("kind")} style={input}>
          <option value="amc">{t("stores.assets.amc")}</option>
          <option value="cmc">{t("stores.assets.cmc")}</option>
        </select>
      </label>
      <div style={{ display: "flex", gap: 8 }}>{date("start", t("stores.assets.from"))}{date("end", t("stores.assets.to"))}</div>
      <div style={{ display: "flex", gap: 8 }}>{date("calDone", t("stores.assets.calDone"))}{date("calDue", t("stores.assets.calDue"))}</div>
      <label style={stack}><span>{t("stores.assets.agency")}</span><input aria-label={t("stores.assets.agency")} value={f.agency} onChange={set("agency")} style={input} /></label>
      {date("installedOn", t("stores.assets.installedOn"))}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={{ ...primary, flex: 1 }} onClick={save}>{t("stores.assets.save")}</button>
        <button type="button" style={btn} onClick={onCancel}>{t("stores.assets.cancel")}</button>
      </div>
    </SheetFrame>
  );
}

function RepairSheet({ unitId, open, onDone, onFail, onCancel }: SheetProps & { open: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const [note, setNote] = useState("");
  return (
    <SheetFrame testId="asset-repair-sheet">
      {!open && <input aria-label={t("stores.assets.whatWrong")} value={note} onChange={(e) => setNote(e.target.value)} style={input} />}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {open ? (
          <>
            <button type="button" style={primary} onClick={() => closeAssetRepair(unitId, "repaired").then(onDone).catch(onFail)}>{t("stores.assets.repaired")}</button>
            <button type="button" style={btn} onClick={() => closeAssetRepair(unitId, "not_repairable").then(onDone).catch(onFail)}>{t("stores.assets.notRepairable")}</button>
          </>
        ) : (
          <>
            <button type="button" style={primary} onClick={() => openAssetRepair(unitId, note.trim() || null).then(onDone).catch(onFail)}>{t("stores.assets.openRepair")}</button>
            <button type="button" style={btn} onClick={() => closeAssetRepair(unitId, "preventive").then(onDone).catch(onFail)}>{t("stores.assets.preventive")}</button>
          </>
        )}
        <button type="button" style={btn} onClick={onCancel}>{t("stores.assets.cancel")}</button>
      </div>
    </SheetFrame>
  );
}

/** Any department's shelf (the masters' list when this person may read it, else their own shelves). */
function useShelves(): WireStoresShelf[] {
  const all = useQuery({ queryKey: ["stores", "all-shelves"], queryFn: listAllShelves, retry: false });
  const mine = useQuery({ queryKey: ["stores", "my-shelves"], queryFn: myShelves, retry: false });
  return all.data?.shelves ?? mine.data?.shelves ?? [];
}

function TransferSheet({ unitId, from, onDone, onFail, onCancel }: SheetProps & { from: string }): React.ReactElement {
  const { t } = useTranslation();
  const shelves = useShelves().filter((s) => s.id !== from);
  const [to, setTo] = useState("");
  return (
    <SheetFrame testId="asset-transfer-sheet">
      <label style={stack}>
        <span>{t("stores.assets.toWhich")}</span>
        <select aria-label={t("stores.assets.toWhich")} value={to} onChange={(e) => setTo(e.target.value)} style={input}>
          <option value="" />
          {shelves.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={{ ...primary, flex: 1 }} disabled={to === ""} onClick={() => proposeAssetTransfer(unitId, to).then(onDone).catch(onFail)}>{t("stores.assets.transfer")}</button>
        <button type="button" style={btn} onClick={onCancel}>{t("stores.assets.cancel")}</button>
      </div>
    </SheetFrame>
  );
}

/** Another department's unit: its name, tag, whose it is, and Found here. Nothing else (no cost, no history). */
function ForeignPassport({ p, onDone }: { p: WireAssetPassportForeign; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const refusal = useRefusal();
  const shelves = useQuery({ queryKey: ["stores", "my-shelves"], queryFn: myShelves, retry: false });
  const [shelfId, setShelfId] = useState("");
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const list = shelves.data?.shelves ?? [];
  const here = shelfId !== "" ? shelfId : list.length === 1 ? list[0]!.id : "";
  const dept = p.belongsTo.departmentName;
  return (
    <section data-testid="asset-foreign" style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "2px solid var(--ink, #222)", paddingTop: 6 }}>
      {p.tagReplaced && <p style={{ margin: 0, fontWeight: 700 }}>{t("stores.assets.tagReplaced")}</p>}
      <strong data-testid="asset-name" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 17 }}>{p.unit.name}</strong>
      <span style={{ fontSize: 30, fontWeight: 800, letterSpacing: 2 }}>{p.unit.tagNo.slice(-4)}</span>
      <p style={{ margin: 0, fontWeight: 700, fontSize: 18 }}>{t("stores.assets.belongsTo", { dept })}</p>
      <Notice n={notice} />
      {notice?.ok !== true && (
        <>
          {list.length > 1 && (
            <label style={stack}>
              <span>{t("stores.assets.whereAreYou")}</span>
              <select aria-label={t("stores.assets.whereAreYou")} value={shelfId} onChange={(e) => setShelfId(e.target.value)} style={input}>
                <option value="" />
                {list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          <button type="button" style={{ ...primary, minHeight: 48 }} disabled={here === ""}
            onClick={() => assetFoundHere(p.unit.id, here).then(() => setNotice({ text: t("stores.assets.told", { dept }), ok: true })).catch((e: unknown) => setNotice({ text: refusal(e), ok: false }))}>
            {t("stores.assets.foundHere")}
          </button>
        </>
      )}
      <button type="button" style={{ ...btn, alignSelf: "flex-start" }} onClick={onDone}>{t("stores.assets.another")}</button>
    </section>
  );
}

/** The department's own units (All / Due / Out), and any unit waiting for this person to accept. */
function DepartmentAssets({ onOpen }: { onOpen: (unitId: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores", "assets", "mine"], queryFn: myAssets, retry: false });
  const [chip, setChip] = useState<"all" | "due" | "out">("all");
  const rows = (q.data?.rows ?? []).filter((r) => chip === "all"
    || (chip === "due" && r.next !== null && r.next.word !== "ok")
    || (chip === "out" && (r.status === "out_repair" || r.status === "overdue" || r.status === "on_its_way")));
  const toAccept = q.data?.toAccept ?? [];
  return (
    <section data-testid="asset-mine" style={stack}>
      {toAccept.map((r) => (
        <div key={r.unitId} data-testid={`asset-accept-${r.unitId}`} style={{ ...rowStyle, border: "2px solid var(--ink, #222)", borderRadius: 8, padding: "4px 8px" }}>
          <strong style={{ flexShrink: 0 }}>{t("stores.assets.toAccept")}</strong>
          <span style={cell}>{`${r.last4} · ${r.name}`}</span>
          <button type="button" style={primary} onClick={() => onOpen(r.unitId)}>{t("stores.assets.accept")}</button>
        </div>
      ))}
      <h2 style={{ margin: "8px 0 0", fontSize: 16 }}>{t("stores.assets.mine")}</h2>
      <div role="group" style={{ display: "flex", gap: 6 }}>
        {(["all", "due", "out"] as const).map((c) => (
          <button key={c} type="button" aria-pressed={chip === c} style={{ ...btn, minHeight: 36, borderRadius: 18, fontWeight: chip === c ? 700 : 400, borderWidth: chip === c ? 2 : 1 }}
            onClick={() => setChip(c)}>{t(`stores.assets.chip.${c}`)}</button>
        ))}
      </div>
      {q.data === undefined && !q.isError ? <GreyRows />
        : q.isError ? <p style={{ margin: 0 }}>{t(q.error instanceof ApiError ? "stores.err.failed" : "stores.ticket.offline")}</p>
        : rows.length === 0 ? <p style={{ margin: 0 }}>{t("stores.assets.empty")}</p>
        : rows.map((r) => (
          <button key={r.unitId} type="button" data-testid={`asset-row-${r.unitId}`} onClick={() => onOpen(r.unitId)}
            style={{ ...rowStyle, border: "none", borderBottom: "1px solid var(--rule, #e3e3e3)", background: "transparent", textAlign: "left", width: "100%", color: "inherit", font: "inherit" }}>
            <span style={cell}>{r.name}</span>
            <strong style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{r.last4}</strong>
            <StatusWord status={r.status} />
          </button>
        ))}
    </section>
  );
}

/* ═══════════════════════════════ Tag units (the store, after a GRN line) ═══════════════════════════════ */

export function StoresTagUnits(): React.ReactElement {
  const { t } = useTranslation();
  const search = useSearch({ strict: false }) as { grnLineId?: string };
  const lines = useQuery({ queryKey: ["stores", "assets", "grns"], queryFn: tagLines, retry: false, enabled: search.grnLineId === undefined });
  const one = useQuery({ queryKey: ["stores", "assets", "grn-line", search.grnLineId], queryFn: () => tagLine(search.grnLineId!), retry: false, enabled: search.grnLineId !== undefined });
  const [picked, setPicked] = useState<WireTagLine | null>(null);
  const line = picked ?? one.data ?? null;
  return (
    <div data-testid="stores-tag-units" className="stores-ui" style={page}>
      <Offline />
      <h1 style={{ margin: 0, fontSize: 18 }}>{t("stores.assets.tagUnits")}</h1>
      {line !== null ? <TagForm line={line} onDone={() => setPicked(null)} />
        : (search.grnLineId !== undefined ? one : lines).isLoading ? <GreyRows />
        : (lines.data?.lines ?? []).length === 0 ? <p style={{ margin: 0 }}>{t("stores.assets.noLines")}</p>
        : lines.data!.lines.map((l) => (
          <div key={l.grnLineId} style={rowStyle}>
            <span style={cell}>{`${l.itemName} · ${l.grnNo.slice(-4)}`}</span>
            <span style={dim}>{t("stores.assets.taggedOf", { tagged: l.tagged, qty: l.qty })}</span>
            <button type="button" style={primary} onClick={() => setPicked(l)}>{t("stores.assets.tagN", { n: l.qty - l.tagged })}</button>
          </div>
        ))}
    </div>
  );
}

function TagForm({ line, onDone }: { line: WireTagLine; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refusal = useRefusal();
  const owed = Math.max(0, line.qty - line.tagged);
  const [serials, setSerials] = useState<string[]>(() => Array.from({ length: owed }, () => ""));
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (): void => {
    setBusy(true);
    tagUnits(line.grnLineId, serials.map((s) => ({ serial: s.trim() === "" ? null : s.trim() })))
      .then(async (r) => {
        if (readPrintSetting().mode !== "relay") {
          for (const u of r.units) { const doc = await assetLabel(u.id).catch(() => null); if (doc !== null) void printDocumentHere(doc); }
        }
        setNotice({ text: t("stores.assets.printed"), ok: true });
        await qc.invalidateQueries({ queryKey: ["stores", "assets"] });
      })
      .catch((e: unknown) => setNotice({ text: refusal(e), ok: false }))
      .finally(() => setBusy(false));
  };
  return (
    <section data-testid="asset-tag-form" style={stack}>
      <strong style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{`${line.itemName} · ${line.grnNo}`}</strong>
      <span style={dim}>{t("stores.assets.taggedOf", { tagged: line.tagged, qty: line.qty })}</span>
      {notice?.ok !== true && serials.map((s, i) => (
        <label key={i} style={{ ...rowStyle, borderBottom: "none" }}>
          <span style={{ ...dim, minWidth: 64 }}>{t("stores.assets.unitN", { n: i + 1 })}</span>
          <input aria-label={`${t("stores.assets.serialBox")} ${String(i + 1)}`} placeholder={t("stores.assets.serialBox")} value={s}
            onChange={(e) => setSerials((x) => x.map((v, j) => (j === i ? e.target.value : v)))} style={{ ...input, flex: 1, minWidth: 0 }} />
        </label>
      ))}
      <Notice n={notice} />
      {notice?.ok === true
        ? <button type="button" style={btn} onClick={onDone}>{t("stores.shelf.back")}</button>
        : <button type="button" style={{ ...primary, minHeight: 48 }} disabled={busy || owed === 0} onClick={submit}>{t("stores.assets.tagPrint")}</button>}
    </section>
  );
}

/* ═══════════════════════════════ Verification round (phone) ═══════════════════════════════ */

export function StoresVerificationRound(): React.ReactElement {
  const { t } = useTranslation();
  const search = useSearch({ strict: false }) as { roundId?: string };
  const refusal = useRefusal();
  const [round, setRound] = useState<WireVerificationRound | null>(null);
  const [shelfId, setShelfId] = useState("");
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const shelves = useQuery({ queryKey: ["stores", "my-shelves"], queryFn: myShelves, retry: false });
  useEffect(() => { if (search.roundId !== undefined) getRound(search.roundId).then(setRound).catch((e: unknown) => setNotice({ text: refusal(e), ok: false })); }, [search.roundId]); // eslint-disable-line react-hooks/exhaustive-deps
  const mine = (shelves.data?.shelves ?? []).filter((s) => round === null || s.departmentId === round.department.id);
  const at = shelfId !== "" ? shelfId : mine.length === 1 ? mine[0]!.id : "";
  if (round === null) return <div data-testid="stores-round" className="stores-ui" style={page}><Offline /><Notice n={notice} />{notice === null && <GreyRows />}</div>;
  const closed = round.closedAt !== null;
  return (
    <div data-testid="stores-round" className="stores-ui" style={page}>
      <Offline />
      <h1 style={{ margin: 0, fontSize: 18, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{`${round.department.name} · ${t("stores.assets.seenOf", { seen: round.seen, expected: round.expected })}`}</h1>
      <Notice n={notice} />
      {!closed && (
        <>
          {mine.length > 1 && (
            <label style={stack}>
              <span>{t("stores.assets.atShelf")}</span>
              <select aria-label={t("stores.assets.atShelf")} value={shelfId} onChange={(e) => setShelfId(e.target.value)} style={input}>
                <option value="" />
                {mine.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          {at !== "" && <ScanOrType onCode={(c) => scanRound(round.roundId, c, at).then((r) => { setRound(r); setNotice(null); }).catch((e: unknown) => setNotice({ text: refusal(e), ok: false }))} />}
          <button type="button" style={{ ...primary, minHeight: 48 }}
            onClick={() => closeRound(round.roundId).then((r) => { setRound(r); setNotice({ text: t("stores.assets.roundClosed"), ok: true }); }).catch((e: unknown) => setNotice({ text: refusal(e), ok: false }))}>
            {t("stores.assets.closeRound")}
          </button>
        </>
      )}
      <RoundResult round={round} />
    </div>
  );
}

function RoundResult({ round }: { round: WireVerificationRound }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section data-testid="round-result" style={stack}>
      {round.notSeen.length > 0 && <h2 style={{ margin: "6px 0 0", fontSize: 15 }}>{t("stores.assets.notSeen")}</h2>}
      {round.notSeen.map((u) => (
        <div key={u.unitId} style={rowStyle}><span style={cell}>{`${u.tagNo.slice(-4)} · ${u.name}`}</span><span style={{ ...word, borderStyle: "dashed" }}>{t("stores.assets.notSeen")}</span></div>
      ))}
      {round.wrongPlace.length > 0 && <h2 style={{ margin: "6px 0 0", fontSize: 15 }}>{t("stores.assets.wrongPlace")}</h2>}
      {round.wrongPlace.map((u) => (
        <div key={u.unitId} style={rowStyle}>
          <span style={{ ...cell, display: "flex", flexDirection: "column" }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{`${u.tagNo.slice(-4)} · ${u.name}`}</span>
            <span style={{ ...dim, overflow: "hidden", textOverflow: "ellipsis" }}>{t("stores.assets.seenAt", { place: u.seenAt })}</span>
          </span>
          <span style={{ ...word, borderStyle: "dashed" }}>{t("stores.assets.wrongPlace")}</span>
        </div>
      ))}
    </section>
  );
}

/* ═══════════════════════════════ /stores/assets (desk, 16:9) ═══════════════════════════════ */

type Tab = "register" | "due" | "verification" | "condemnation" | "exports";
const TABS: readonly Tab[] = ["register", "due", "verification", "condemnation", "exports"];

export function StoresAssets(): React.ReactElement {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("register");
  return (
    <div data-testid="stores-assets" className="stores-ui" style={desk}>
      <Offline />
      <h1 style={{ margin: 0, fontSize: 20 }}>{t("stores.assets.deskTitle")}</h1>
      <div role="tablist" aria-label={t("stores.assets.deskTitle")} style={{ display: "flex", gap: 4, borderBottom: "2px solid var(--ink, #222)" }}>
        {TABS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            style={{ ...btn, border: "none", borderRadius: "6px 6px 0 0", fontWeight: tab === k ? 700 : 400, background: tab === k ? "var(--ink, #222)" : "transparent", color: tab === k ? "var(--paper, #fff)" : "var(--ink, #222)" }}>
            {t(`stores.assets.tab.${k}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "register" && <RegisterTab />}
        {tab === "due" && <DueTab />}
        {tab === "verification" && <VerificationTab />}
        {tab === "condemnation" && <CondemnationTab />}
        {tab === "exports" && <ExportsTab />}
      </div>
    </div>
  );
}

function QueryState({ q, empty, children }: { q: { data: unknown; isError: boolean; error: unknown }; empty: boolean; children: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  if (q.data === undefined && !q.isError) return <GreyRows n={5} />;
  if (q.isError) {
    return <p style={{ margin: 0, fontWeight: 700 }}>{t(storesErrorCode(q.error) === "not_permitted" ? "stores.assets.noPermission" : q.error instanceof ApiError ? "stores.err.failed" : "stores.ticket.offline")}</p>;
  }
  if (empty) return <p style={{ margin: 0 }}>{t("stores.assets.nothingYet")}</p>;
  return <>{children}</>;
}

function NextCell({ next }: { next: WireAssetNext | null }): React.ReactElement {
  const { t, i18n } = useTranslation();
  if (next === null) return <span style={dim}>{t("stores.assets.noDate")}</span>;
  return <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>{`${t(`stores.assets.what.${next.what}`)} ${assetDay(next.date, i18n.language)}`}<DueWord w={next.word} /></span>;
}

function RegisterTab(): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stores", "assets", "register"], queryFn: assetRegister, retry: false });
  const rows: WireAssetRegisterRow[] = q.data?.rows ?? [];
  return (
    <section style={stack}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ flex: 1 }} />
        <Link to="/stores/assets/tag" style={{ ...primary, display: "inline-flex", alignItems: "center", textDecoration: "none" }}>{t("stores.assets.tagUnits")}</Link>
      </div>
      <QueryState q={q} empty={rows.length === 0}>
        <div style={{ overflowX: "auto", maxWidth: "100%" }}>
          <table data-testid="asset-register" style={{ borderCollapse: "collapse", width: "100%", tableLayout: "auto" }}>
            <thead><tr>{["tag", "item", "category", "status", "place", "department", "next"].map((c) => <th key={c} style={th}>{t(`stores.assets.col.${c}`)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.unitId}>
                  <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}><Link to="/stores/asset" search={{ unit: r.unitId }}>{r.last4}</Link></td>
                  <td style={td}>{r.name}</td>
                  <td style={td}>{r.category}</td>
                  <td style={td}><StatusWord status={r.status} /></td>
                  <td style={td}>{r.place}</td>
                  <td style={td}>{r.department ?? "—"}</td>
                  <td style={td}><NextCell next={r.next} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
    </section>
  );
}

function DueTab(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const q = useQuery({ queryKey: ["stores", "assets", "due"], queryFn: assetsDue, retry: false });
  const rows = q.data?.rows ?? [];
  return (
    <QueryState q={q} empty={rows.length === 0}>
      <table data-testid="asset-due" style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr>{["tag", "item", "place", "what", "date"].map((c) => <th key={c} style={th}>{t(`stores.assets.col.${c}`)}</th>)}<th style={th}>{t("stores.assets.col.status")}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.unitId}-${r.what}`}>
              <td style={td}><Link to="/stores/asset" search={{ unit: r.unitId }}>{r.tagNo.slice(-4)}</Link></td>
              <td style={td}>{r.name}</td>
              <td style={td}>{r.place}</td>
              <td style={td}>{t(`stores.assets.what.${r.what}`)}</td>
              <td style={td}>{r.date === null ? "—" : assetDay(r.date, i18n.language)}</td>
              <td style={td}><DueWord w={r.word} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </QueryState>
  );
}

function VerificationTab(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const refusal = useRefusal();
  const q = useQuery({ queryKey: ["stores", "assets", "verification"], queryFn: verificationRounds, retry: false });
  const [dept, setDept] = useState("");
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const depts = q.data?.departments ?? [];
  const rounds = q.data?.rounds ?? [];
  return (
    <section style={stack}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ ...stack, minWidth: 240 }}>
          <span>{t("stores.assets.department")}</span>
          <select aria-label={t("stores.assets.department")} value={dept} onChange={(e) => setDept(e.target.value)} style={input}>
            <option value="" />
            {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <button type="button" style={{ ...primary, minHeight: 44 }} disabled={dept === ""}
          onClick={() => startRound(dept).then(() => qc.invalidateQueries({ queryKey: ["stores", "assets", "verification"] })).catch((e: unknown) => setNotice({ text: refusal(e), ok: false }))}>
          {t("stores.assets.startRound")}
        </button>
      </div>
      <Notice n={notice} />
      <QueryState q={q} empty={rounds.length === 0}>
        {rounds.map((r) => (
          <div key={r.roundId} style={rowStyle}>
            <span style={cell}>{`${r.department.name} · ${assetDay(r.startedAt.slice(0, 10), i18n.language)} · ${t("stores.assets.seenOf", { seen: r.seen, expected: r.expected })}`}</span>
            {r.closedAt === null
              ? <Link to="/stores/assets/round" search={{ roundId: r.roundId }} style={{ ...btn, display: "inline-flex", alignItems: "center", textDecoration: "none" }}>{t("stores.assets.openRound")}</Link>
              : <span style={word}>{`${t("stores.assets.roundClosed")} · ${t("stores.assets.notSeen")} ${String(r.notSeen.length)} · ${t("stores.assets.wrongPlace")} ${String(r.wrongPlace.length)}`}</span>}
          </div>
        ))}
      </QueryState>
    </section>
  );
}

/** Condemnation is S4b: the tab is in place, its one primary waits. */
function CondemnationTab(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <section style={stack}>
      <div style={{ display: "flex" }}><span style={{ flex: 1 }} /><button type="button" style={primary} disabled>{t("stores.assets.propose")}</button></div>
      <p style={{ margin: 0 }}>{t("stores.assets.nothingYet")}</p>
    </section>
  );
}

const lastMonth = (): string => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

function ExportsTab(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const refusal = useRefusal();
  const [month, setMonth] = useState(lastMonth());
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const q = useQuery({ queryKey: ["stores", "assets", "additions", month], queryFn: () => assetAdditions(month), retry: false });
  const rows = q.data?.rows ?? [];
  return (
    <section style={stack}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <label style={{ ...stack, width: 200 }}>
          <span>{t("stores.assets.month")}</span>
          <input type="month" aria-label={t("stores.assets.month")} value={month} onChange={(e) => setMonth(e.target.value)} style={input} />
        </label>
        <strong style={{ flex: 1 }}>{t("stores.assets.additions")}</strong>
        <button type="button" style={{ ...primary, minHeight: 44 }}
          onClick={() => apiDownload(`/stores/assets/exports/additions?month=${encodeURIComponent(month)}&format=csv`, `asset-additions-${month}.csv`).catch((e: unknown) => setNotice({ text: refusal(e), ok: false }))}>
          {t("stores.assets.download")}
        </button>
      </div>
      <Notice n={notice} />
      <QueryState q={q} empty={rows.length === 0}>
        <table data-testid="asset-additions" style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr>{["tag", "item", "category", "department", "date", "grn"].map((c) => <th key={c} style={th}>{t(`stores.assets.col.${c}`)}</th>)}<th style={th}>{t("stores.assets.cost")}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.unitId}>
                <td style={td}>{r.tagNo.slice(-4)}</td><td style={td}>{r.name}</td><td style={td}>{r.category}</td><td style={td}>{r.department}</td>
                <td style={td}>{assetDay(r.putToUse, i18n.language)}</td><td style={td}>{r.grnNo}</td>
                <td style={{ ...td, textAlign: "right" }}>{r.costPaise === null ? t("stores.assets.costUnknown") : money(r.costPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </QueryState>
      <p style={{ margin: 0, ...dim }}>{`${t("stores.assets.removals")}: ${t("stores.assets.nothingYet")}`}</p>
    </section>
  );
}
