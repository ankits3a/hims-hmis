import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { useAuth } from "../lib/auth";
import {
  cssdApi, fetchLinenFloor, fetchLinenHandler, fetchLinenLaundry, finishCycleApi, linenRefusal, machineDownApi, machineUpApi,
  recordQcApi, releaseBatchApi, startCycleApi, vendorBatchApi,
} from "../lib/linen-api";
import { itemName } from "./linen-board";
import { LinenTabs } from "./linen-store";
import type { LinenQcLine } from "../lib/linen-api";
import type { LinenBatchCard, LinenItem, LinenMachineCard, LinenPlantBatch } from "@hmis/contracts";
import "./linen.css";

/**
 * ═══ LD-1 (#978, decision 0087) — THE LAUNDRY FLOOR (desk, 16:9) ═══
 *
 * Left: the soiled room now and today. Centre: batches through the plant — waiting (and back for rewash), the washers,
 * the dryers and calender, fold and check. Right: what needs the supervisor. An infected batch carries the word
 * "Infected" beside its red edge; a batch that missed the disinfection temperature says "Cannot be released".
 * The plant view does not carry a running cycle's id: a cycle started from this screen is remembered here, so Finish
 * is offered on that machine; a cycle started elsewhere says so.
 */
type T = (k: string, o?: Record<string, unknown>) => string;
const PROGRAMS = ["thermal", "warm", "delicate"] as const;

export function LinenPlant(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const laundry = useQuery({ queryKey: ["linen", "laundry"], queryFn: fetchLinenLaundry, refetchInterval: 30_000 });
  const floor = useQuery({ queryKey: ["linen", "floor"], queryFn: fetchLinenFloor, refetchInterval: 30_000 });
  const handler = useQuery({ queryKey: ["linen", "handler"], queryFn: fetchLinenHandler, enabled: can("linen.handle") });
  const [cycles, setCycles] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const plant = laundry.data?.plant;
  const items: readonly LinenItem[] = handler.data?.items ?? [];
  const cards = new Map((handler.data?.inTransit ?? []).map((b) => [b.id, b]));
  const queue = plant?.queue ?? [];
  const machines = plant?.machines ?? [];
  const washers = machines.filter((m) => m.kind === "washer");
  const others = machines.filter((m) => m.kind !== "washer");
  const waiting = queue.filter((b) => b.state === "sent" || b.state === "rewash");
  const washing = queue.filter((b) => b.state === "washing");
  const atQc = queue.filter((b) => b.state === "qc");
  const rewash = queue.filter((b) => b.state === "rewash");
  const soiled = floor.data?.soiledRoom;
  const bags = soiled?.infectedBags ?? [];
  const kg = bags.reduce((n, b) => n + (b.weightGrams ?? 0), 0) / 1000;
  const down = machines.filter((m) => m.state === "down");
  const rush = laundry.data?.rush;
  // LD-2 (#979, D1): with a vendor set up, work leaves for the vendor on a challan — pick the vendor and weigh it.
  const vendors = plant?.vendors ?? [];

  const act = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { setNotice({ ok: true, text: t("linen.plant.saved") }); setOpen(null); void qc.invalidateQueries({ queryKey: ["linen"] }); },
    onError: (e) => setNotice({ ok: false, text: t(`linen.refusal.${linenRefusal(e) ?? "failed"}`, { defaultValue: t("linen.refusal.failed") }) }),
  });
  const run = (fn: () => Promise<unknown>): void => { setNotice(null); act.mutate(fn); };
  /** No vendor set up: straight to the vendor, as in LD-1. With one: the challan form (vendor + weight). */
  const toVendor = (batchId: string): void => { if (vendors.length === 0) run(() => vendorBatchApi(batchId)); else setOpen(`vendor-${batchId}`); };
  const start = (machineId: string, batchId: string, program: string): void => run(async () => {
    const c = await startCycleApi(machineId, [batchId], program);
    setCycles((m) => ({ ...m, [machineId]: c.id }));
  });

  return (
    <PaperScreen testId="linen-plant" style={{ height: "var(--pp-h)" }}>
      <div className="lp-desk">
        <LinenTabs on="plant" />
        <div className="lp-grid">
          <aside className="box lp-aside" data-testid="plant-soiled">
            <span className="lp-tag">{t("linen.plant.soiledNow")}</span>
            {Object.entries(soiled?.general ?? {}).map(([code, n]) => (
              <div key={code} className="lp-kv"><span>{itemName(code, items, t)}</span><b className="mono">{n}</b></div>
            ))}
            {soiled !== undefined && Object.keys(soiled.general).length === 0 && <div className="lp-kv"><span>{t("linen.plant.noOrdinary")}</span></div>}
            <div className="lp-kv inf" data-testid="plant-infected-bags">
              <span>{t("linen.plant.infectedSealed")}</span>
              <b className="mono">{kg > 0 ? `${kg.toFixed(0)} kg · ` : ""}{t("linen.plant.bags", { count: bags.length })}</b>
            </div>
            <span className="lp-tag" style={{ marginTop: 18 }}>{t("linen.plant.today")}</span>
            <div className="lp-kv"><span>{t("linen.plant.bedsWaiting")}</span><b className={`mono${(laundry.data?.bedsWaiting.length ?? 0) > 0 ? " ln-err" : ""}`}>{laundry.data?.bedsWaiting.length ?? 0}</b></div>
            <div className="lp-kv"><span>{t("linen.plant.dueOut")}</span><b className="mono">{(rush?.wards ?? []).reduce((n, w) => n + w.discharges, 0)}</b></div>
            <div className="lp-kv"><span>{t("linen.plant.otCases")}</span><b className="mono">{rush?.theatreCases ?? 0}</b></div>
            <div className="lp-kv"><span>{t("linen.plant.inPlant")}</span><b className="mono">{t("linen.plant.batches", { count: queue.length })}</b></div>
          </aside>

          <section className="lp-centre">
            <div className="lp-title">
              <div><h1>{t("linen.plant.title")}</h1><p>{t("linen.plant.sub")}</p></div>
              {notice !== null && <p role="alert" className={notice.ok ? "ln-notice ok" : "ln-notice"} data-testid="plant-notice">{notice.text}</p>}
            </div>
            <div className="lp-lanes">
              <Lane title={t("linen.plant.lane.waiting")} note={t("linen.plant.batches", { count: waiting.length })} testId="lane-waiting">
                {waiting.map((b) => (
                  <BatchTile key={b.batchId} b={b} card={cards.get(b.batchId)} t={t}>
                    {b.state === "rewash" && <span className="ln-err">{t("linen.plant.cannotRelease")}</span>}
                    {open === `start-${b.batchId}` ? (
                      <StartForm infected={b.infected} washers={washers} onGo={(m, p) => start(m, b.batchId, p)} onCancel={() => setOpen(null)} t={t} />
                    ) : (
                      <span className="lp-acts">
                        <button type="button" className="ln-mini ok" onClick={() => setOpen(`start-${b.batchId}`)} data-testid={`start-${b.batchNo}`}>{t("linen.plant.start")}</button>
                        <button type="button" className="ln-mini" onClick={() => toVendor(b.batchId)} data-testid={`vendor-${b.batchNo}`}>{t("linen.plant.toVendor")}</button>
                      </span>
                    )}
                    {open === `vendor-${b.batchId}` && <VendorChallanForm vendors={vendors} onGo={(c) => run(() => vendorBatchApi(b.batchId, c))} onCancel={() => setOpen(null)} t={t} />}
                  </BatchTile>
                ))}
              </Lane>
              <Lane title={t("linen.plant.lane.washers")} note={t("linen.plant.running", { n: washers.filter((m) => m.running).length, of: washers.length })} testId="lane-washers">
                {washers.map((m) => (
                  <MachineTile key={m.id} m={m} cycleId={cycles[m.id]} open={open} setOpen={setOpen} run={run} t={t} />
                ))}
                {washing.map((b) => (
                  <BatchTile key={b.batchId} b={b} card={cards.get(b.batchId)} t={t}>
                    <span className="lp-acts">
                      <button type="button" className="ln-mini ok" onClick={() => run(() => releaseBatchApi(b.batchId))} data-testid={`release-${b.batchNo}`}>{t("linen.plant.release")}</button>
                    </span>
                  </BatchTile>
                ))}
              </Lane>
              <Lane title={t("linen.plant.lane.dryers")} note={t("linen.plant.machines", { count: others.length })} testId="lane-dryers">
                {others.map((m) => <MachineTile key={m.id} m={m} open={open} setOpen={setOpen} run={run} t={t} />)}
              </Lane>
              <Lane title={t("linen.plant.lane.check")} note={t("linen.plant.batches", { count: atQc.length })} testId="lane-check">
                {atQc.map((b) => (
                  <BatchTile key={b.batchId} b={b} card={cards.get(b.batchId)} t={t}>
                    {open === `qc-${b.batchId}` ? (
                      <QcForm card={cards.get(b.batchId)} items={items} t={t} onCancel={() => setOpen(null)} onGo={(lines) => run(() => recordQcApi(b.batchId, lines))} />
                    ) : open === `cssd-${b.batchId}` ? (
                      <SignForm t={t} label={t("linen.plant.cssdSigns")} onCancel={() => setOpen(null)} onGo={(sig) => run(() => cssdApi(b.batchId, sig))} />
                    ) : (
                      <span className="lp-acts">
                        <button type="button" className="ln-mini ok" onClick={() => setOpen(`qc-${b.batchId}`)} data-testid={`qc-${b.batchNo}`}>{t("linen.plant.check")}</button>
                        {b.stream === "theatre" && <button type="button" className="ln-mini" onClick={() => setOpen(`cssd-${b.batchId}`)} data-testid={`cssd-${b.batchNo}`}>{t("linen.plant.toCssd")}</button>}
                      </span>
                    )}
                  </BatchTile>
                ))}
              </Lane>
            </div>
          </section>

          <aside className="lp-side">
            <section className="box" data-testid="plant-needs">
              <header className="lp-h"><b>{t("linen.plant.needsYou")}</b></header>
              {rewash.map((b) => (
                <div key={b.batchId} className="lp-crow"><div><b>{t("linen.plant.rewashRow", { no: b.batchNo })}</b><small>{t("linen.plant.cannotRelease")}</small></div></div>
              ))}
              {(laundry.data?.bedsWaiting ?? []).map((w) => (
                <div key={w.bedId} className="lp-crow"><div><b>{t("linen.plant.bedWaitRow", { bed: w.bedName })}</b><small>{t("linen.plant.rushTopUp")}</small></div></div>
              ))}
              {down.map((m) => (
                <div key={m.id} className="lp-crow"><div><b>{t("linen.plant.downRow", { name: m.name })}</b><small>{m.downReason}</small></div></div>
              ))}
              {(plant?.vendorQueue ?? []).map((b) => (
                <div key={b.batchId} className="lp-crow" data-testid={`vq-${b.batchNo}`}>
                  <div><b>{t("linen.plant.vendorRow", { no: b.batchNo, n: b.pieces })}</b><small>{t("linen.plant.noWasher")}</small></div>
                  <button type="button" className="ln-mini" onClick={() => toVendor(b.batchId)}>{t("linen.plant.toVendor")}</button>
                  {open === `vendor-${b.batchId}` && <VendorChallanForm vendors={vendors} onGo={(c) => run(() => vendorBatchApi(b.batchId, c))} onCancel={() => setOpen(null)} t={t} />}
                </div>
              ))}
              {(laundry.data?.holds ?? []).map((h) => (
                <div key={h.id} className="lp-crow"><div><b>{t("linen.plant.holdRow", { bed: h.bedName, kind: t(`linen.hold.${h.kind}`) })}</b><small>{t("linen.plant.notLaundry")}</small></div><span className="mono ln-dim">{t("linen.plant.held")}</span></div>
              ))}
              {rush !== undefined && (rush.wards.length > 0 || rush.theatreCases > 0) && (
                <div className="lp-crow"><div><b>{t("linen.plant.rushRow", { n: rush.wards.reduce((x, w) => x + w.discharges, 0), ot: rush.theatreCases })}</b><small>{t("linen.plant.rushSub")}</small></div></div>
              )}
              {laundry.data !== undefined && rewash.length + laundry.data.bedsWaiting.length + down.length + laundry.data.holds.length === 0 && (
                <div className="ln-empty">{t("linen.plant.allClear")}</div>
              )}
            </section>
          </aside>
        </div>
      </div>
    </PaperScreen>
  );
}

function Lane({ title, note, testId, children }: { title: string; note: string; testId: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="lp-lane" data-testid={testId}>
      <header><b>{title}</b><span className="mono">{note}</span></header>
      <div className="lp-lane-body">{children}</div>
    </div>
  );
}

function BatchTile({ b, card, t, children }: { b: LinenPlantBatch; card: LinenBatchCard | undefined; t: T; children?: React.ReactNode }): React.ReactElement {
  return (
    <div className={`lp-bt${b.infected ? " inf" : ""}`} data-testid={`pb-${b.batchNo}`}>
      <b className="mono">{b.batchNo}</b>
      <span>
        {b.infected && <span className="ln-tag inf">{t("linen.board.infectedBatch")}</span>}{" "}
        {t(`linen.stream.${b.stream}`)} · {t("linen.board.pieces", { count: b.pieces })}
        {card !== undefined && card.vendorName !== null ? ` · ${card.vendorName}` : ""}
      </span>
      {children}
    </div>
  );
}

/** A finished cycle's id stays remembered but harmless: Finish shows only while the machine is running. */
function MachineTile({ m, cycleId, open, setOpen, run, t }: {
  m: LinenMachineCard; cycleId?: string; open: string | null; setOpen: (k: string | null) => void;
  run: (fn: () => Promise<unknown>) => void; t: T;
}): React.ReactElement {
  const [reason, setReason] = useState("");
  const [temp, setTemp] = useState("71");
  const [hold, setHold] = useState("3");
  const [chem, setChem] = useState("");
  const state = m.state === "down" ? t("linen.plant.down") : m.running ? t("linen.plant.runningWord") : t("linen.plant.idle");
  return (
    <div className={`lp-bt${m.state === "down" ? " off" : ""}`} data-testid={`m-${m.code}`}>
      <b>{m.name} · {state}</b>
      {m.state === "down" && <span>{m.downReason}</span>}
      {open === `fin-${m.id}` && cycleId !== undefined ? (
        <span className="lp-form">
          <label>{t("linen.plant.temp")}<input inputMode="numeric" value={temp} onChange={(e) => setTemp(e.target.value.replace(/\D/g, ""))} data-testid={`temp-${m.code}`} /></label>
          <label>{t("linen.plant.holdMin")}<input inputMode="numeric" value={hold} onChange={(e) => setHold(e.target.value.replace(/\D/g, ""))} /></label>
          <label>{t("linen.plant.chemical")}<input value={chem} onChange={(e) => setChem(e.target.value)} data-testid={`chem-${m.code}`} /></label>
          <button type="button" className="ln-mini ok" disabled={chem.trim().length < 2} onClick={() => run(() => finishCycleApi(cycleId, Number(temp), Number(hold), chem.trim()))}>{t("linen.plant.finish")}</button>
          <button type="button" className="ln-mini" onClick={() => setOpen(null)}>{t("linen.plant.cancel")}</button>
        </span>
      ) : open === `down-${m.id}` ? (
        <span className="lp-form">
          <label>{t("linen.plant.reason")}<input value={reason} onChange={(e) => setReason(e.target.value)} data-testid={`reason-${m.code}`} /></label>
          <button type="button" className="ln-mini ok" disabled={reason.trim().length < 3} onClick={() => run(() => machineDownApi(m.id, reason.trim()))}>{t("linen.plant.markDown")}</button>
          <button type="button" className="ln-mini" onClick={() => setOpen(null)}>{t("linen.plant.cancel")}</button>
        </span>
      ) : (
        <span className="lp-acts">
          {m.running && (cycleId !== undefined
            ? <button type="button" className="ln-mini ok" onClick={() => setOpen(`fin-${m.id}`)} data-testid={`finish-${m.code}`}>{t("linen.plant.finish")}</button>
            : <span className="ln-dim">{t("linen.plant.startedElsewhere")}</span>)}
          {m.state === "up"
            ? <button type="button" className="ln-mini" onClick={() => setOpen(`down-${m.id}`)} data-testid={`down-${m.code}`}>{t("linen.plant.markDown")}</button>
            : <button type="button" className="ln-mini" onClick={() => run(() => machineUpApi(m.id))}>{t("linen.plant.markUp")}</button>}
        </span>
      )}
    </div>
  );
}

/** LD-2 (#979, D1): the outward challan of plant work sent to the vendor — the vendor and the dock weight. */
function VendorChallanForm({ vendors, onGo, onCancel, t }: {
  vendors: { id: string; name: string }[]; onGo: (c: { linenVendorId: string; weightGrams: number }) => void; onCancel: () => void; t: T;
}): React.ReactElement {
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const [kg, setKg] = useState("");
  const grams = Math.round(Number(kg) * 1000);
  return (
    <span className="lp-form" data-testid="vendor-challan">
      <label>{t("linen.vendor.col.vendor")}<select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      <label>{t("linen.vendor.weight")}<input inputMode="decimal" value={kg} onChange={(e) => setKg(e.target.value)} data-testid="vendor-kg" /></label>
      <button type="button" className="ln-mini ok" disabled={!(grams > 0) || vendorId === ""} onClick={() => onGo({ linenVendorId: vendorId, weightGrams: grams })} data-testid="vendor-go">{t("linen.vendor.sendGo")}</button>
      <button type="button" className="ln-mini" onClick={onCancel}>{t("linen.plant.cancel")}</button>
    </span>
  );
}

function StartForm({ infected, washers, onGo, onCancel, t }: {
  infected: boolean; washers: LinenMachineCard[]; onGo: (machineId: string, program: string) => void; onCancel: () => void; t: T;
}): React.ReactElement {
  const free = washers.filter((w) => w.state === "up" && !w.running);
  const [machine, setMachine] = useState(free[0]?.id ?? "");
  const [program, setProgram] = useState<string>(infected ? "thermal" : "warm");
  return (
    <span className="lp-form">
      <select value={machine} onChange={(e) => setMachine(e.target.value)} aria-label={t("linen.plant.machine")} data-testid="start-machine">
        {free.length === 0 && <option value="">{t("linen.plant.noWasherFree")}</option>}
        {free.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select>
      <select value={program} onChange={(e) => setProgram(e.target.value)} aria-label={t("linen.plant.program")}>
        {PROGRAMS.map((p) => <option key={p} value={p}>{t(`linen.plant.prog.${p}`)}</option>)}
      </select>
      <button type="button" className="ln-mini ok" disabled={machine === ""} onClick={() => onGo(machine, program)} data-testid="start-go">{t("linen.plant.start")}</button>
      <button type="button" className="ln-mini" onClick={onCancel}>{t("linen.plant.cancel")}</button>
    </span>
  );
}

const QC_KEYS = ["pass", "rewash", "mend", "condemn"] as const;

function QcForm({ card, items, onGo, onCancel, t }: {
  card: LinenBatchCard | undefined; items: readonly LinenItem[]; onGo: (lines: LinenQcLine[]) => void; onCancel: () => void; t: T;
}): React.ReactElement {
  const start = (card?.lines ?? []).map((l) => ({ itemCode: l.itemCode, pass: l.sent, rewash: 0, mend: 0, condemn: 0 }));
  const [lines, setLines] = useState<LinenQcLine[]>(start);
  if (card === undefined) return <span className="ln-dim">{t("linen.plant.noLines")}</span>;
  const set = (i: number, k: (typeof QC_KEYS)[number], v: string): void =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: Number(v.replace(/\D/g, "")) || 0 } : l)));
  return (
    <span className="lp-form col" data-testid="qc-form">
      {lines.map((l, i) => (
        <span key={l.itemCode} className="lp-qc">
          <b>{itemName(l.itemCode, items, t)} · {card.lines[i]?.sent ?? 0}</b>
          {QC_KEYS.map((k) => (
            <label key={k}>{t(`linen.plant.qc.${k}`)}<input inputMode="numeric" value={String(l[k])} onChange={(e) => set(i, k, e.target.value)} data-testid={`qc-${k}-${l.itemCode}`} /></label>
          ))}
        </span>
      ))}
      <span className="lp-acts">
        <button type="button" className="ln-mini ok" onClick={() => onGo(lines)} data-testid="qc-go">{t("linen.plant.saveCheck")}</button>
        <button type="button" className="ln-mini" onClick={onCancel}>{t("linen.plant.cancel")}</button>
      </span>
    </span>
  );
}

export function SignForm({ t, label, onGo, onCancel }: {
  t: T; label: string; onGo: (sig: { username: string; pin: string }) => void; onCancel: () => void;
}): React.ReactElement {
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  return (
    <span className="lp-form" data-testid="sign-form">
      <span className="ln-dim">{label}</span>
      <label>{t("linen.sign.name")}<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" data-testid="sign-name" /></label>
      <label>{t("linen.sign.pin")}<input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} data-testid="sign-pin" /></label>
      <button type="button" className="ln-mini ok" disabled={username.trim().length < 2 || pin.length < 4} onClick={() => onGo({ username: username.trim(), pin })} data-testid="sign-go">{t("linen.sign.sign")}</button>
      <button type="button" className="ln-mini" onClick={onCancel}>{t("linen.plant.cancel")}</button>
    </span>
  );
}
