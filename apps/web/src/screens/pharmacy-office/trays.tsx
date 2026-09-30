import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  TRAYS_CHECK, TRAYS_MANAGE, TRAY_KEEPER_ROLES, addTray, fetchTrayChecks, fetchTrayItems, fetchTrays, previewLine, receiveTrayRestock,
  recordTrayCheck, restockTrayCheck, saveTrayLine, setTrayKeepers,
} from "../../lib/trays-api";
import { newIdempotencyKey } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { todayIst } from "../../lib/opd-api";
import { pharmacyErrorText } from "../../lib/pharmacy-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "./sheet";
import type { TrayCheckKind, WireTray, WireTrayTemplateLine } from "../../lib/trays-api";

/**
 * ═══ PHARMACY STAGE D4 — CRASH-CART AND EMERGENCY-TRAY CHECKS (an office page under Stock) ═══
 *
 * Every tray (OPD procedure room, CT room, OT, day care) with today's daily seal check and this month's full check,
 * its last check, anything short or expiring, and its restock; the check sheet (daily seal / monthly full / after
 * use) with the tray's list pre-filled at par — the sheet PREVIEWS what is short or expiring, the server decides;
 * the tray's history; "Restock from pharmacy" on a deficient check and "Receive restock" for the tray's keeper; and,
 * for a holder of `pharmacy.trays.manage`, setting up a tray and keeping its list.
 *
 * Self-contained and unrouted: the lead wires it into the office's Stock menu. Built on the office's legacy-side
 * primitives (shadcn + the paper-and-pine palette), as the D1–D3 pages.
 */
const areaCls = "min-h-16 w-full rounded-md border bg-background p-2 text-sm";
const stateCls: Record<string, string> = { done: "pill on", due: "pill gd", missed: "pill rd", not_due: "pill" };
const when = (iso: string): string => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

export function TrayChecksView(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const trays = useQuery({ queryKey: ["pharmacy", "trays", "list"], queryFn: () => fetchTrays() });
  const [selected, setSelected] = useState<string | null>(null);
  const [checking, setChecking] = useState<{ tray: WireTray; kind: TrayCheckKind } | null>(null);
  const [editing, setEditing] = useState<WireTray | "new" | null>(null);
  const [notice, setNotice] = useState<{ text: string; red: boolean } | null>(null);
  const items = trays.data?.items ?? [];
  const first = items[0]?.id ?? null;
  useEffect(() => { if (selected === null && first !== null) setSelected(first); }, [first, selected]);
  const current = items.find((x) => x.id === selected) ?? null;
  const mayCheck = can(TRAYS_CHECK);
  const mayManage = can(TRAYS_MANAGE);
  const refresh = async (): Promise<void> => { await qc.invalidateQueries({ queryKey: ["pharmacy", "trays"] }); };
  const restock = useMutation({
    mutationFn: (checkId: string) => restockTrayCheck(checkId),
    onSuccess: async (out) => { await refresh(); setNotice({ text: t("pharmacyOffice.trays.restocked", { count: out.units }), red: false }); },
  });
  const receive = useMutation({
    mutationFn: (checkId: string) => receiveTrayRestock(checkId),
    onSuccess: async () => { await refresh(); setNotice({ text: t("pharmacyOffice.trays.received"), red: false }); },
  });
  const actError = restock.error ?? receive.error;

  return (
    <div className="space-y-4" data-testid="trays-view">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{t("pharmacyOffice.trays.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("pharmacyOffice.trays.lead")}</p>
        </div>
        {mayManage && <Button type="button" variant="outline" data-testid="tray-add" onClick={() => setEditing("new")}>{t("pharmacyOffice.trays.addTray")}</Button>}
      </div>
      {trays.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(trays.error, t)}</p>}
      {actError !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(actError, t)}</p>}
      {notice !== null && <p role="status" className={`text-sm ${notice.red ? "text-red-700" : "text-green-700"}`} data-testid="tray-notice">{notice.text}</p>}
      {trays.data !== undefined && items.length === 0 && <p className="text-sm text-muted-foreground" data-testid="trays-empty">{t("pharmacyOffice.trays.empty")}</p>}
      {items.length > 0 && (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="trays-list">
          {items.map((x) => {
            const last = x.lastCheck;
            const inTransit = last?.restock?.status === "in_transit";
            return (
              <li key={x.id} className={`min-w-0 rounded border p-3 ${selected === x.id ? "border-emerald-700" : ""} ${x.needsRestock ? "bg-red-50/60" : ""}`} data-testid={`tray-${x.code}`}>
                <button type="button" className="w-full text-left" aria-current={selected === x.id ? "true" : undefined} onClick={() => setSelected(x.id)}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{x.name}</span>
                    <span className="text-xs text-muted-foreground">{x.location} · {x.code}</span>
                  </span>
                  <span className="mt-2 flex flex-wrap gap-2">
                    <span className={stateCls[x.daily] ?? "pill"} data-testid={`tray-daily-${x.code}`}>{t("pharmacyOffice.trays.dailyPill", { state: t(`pharmacyOffice.trays.state.${x.daily}`) })}</span>
                    <span className={stateCls[x.monthly] ?? "pill"} data-testid={`tray-monthly-${x.code}`}>{t("pharmacyOffice.trays.monthlyPill", { state: t(`pharmacyOffice.trays.state.${x.monthly}`) })}</span>
                    {x.needsRestock && <span className="pill rd" data-testid={`tray-deficient-${x.code}`}>{t("pharmacyOffice.trays.deficientPill", { no: last?.no ?? "" })}</span>}
                    {inTransit && <span className="pill gd" data-testid={`tray-transit-${x.code}`}>{t("pharmacyOffice.trays.inTransit")}</span>}
                    {x.expiring.length > 0 && <span className="pill gd">{t("pharmacyOffice.trays.expiringPill", { count: x.expiring.length })}</span>}
                  </span>
                  <span className="mt-2 block truncate text-xs text-muted-foreground">
                    {last === null
                      ? t("pharmacyOffice.trays.never")
                      : t("pharmacyOffice.trays.last", { no: last.no, kind: t(`pharmacyOffice.trays.kind.${last.kind}`), when: when(last.checkedAt), result: t(`pharmacyOffice.trays.result.${last.result}`) })}
                  </span>
                </button>
                <div className="mt-2 flex flex-wrap gap-2">
                  {mayCheck && (["daily_seal", "monthly_full", "after_use"] as const).map((k) => (
                    <Button key={k} type="button" size="sm" variant={k === "daily_seal" ? "default" : "outline"} data-testid={`tray-check-${x.code}-${k}`}
                      onClick={() => { setNotice(null); setChecking({ tray: x, kind: k }); }}>{t(`pharmacyOffice.trays.kind.${k}`)}</Button>
                  ))}
                  {mayCheck && x.needsRestock && last !== null && (
                    <Button type="button" size="sm" data-testid={`tray-restock-${x.code}`} disabled={restock.isPending} onClick={() => restock.mutate(last.id)}>{t("pharmacyOffice.trays.restock")}</Button>
                  )}
                  {mayCheck && inTransit && last !== null && (
                    <Button type="button" size="sm" variant="outline" data-testid={`tray-receive-${x.code}`} disabled={receive.isPending} onClick={() => receive.mutate(last.id)}>{t("pharmacyOffice.trays.receive")}</Button>
                  )}
                  {mayManage && <Button type="button" size="sm" variant="outline" data-testid={`tray-edit-${x.code}`} onClick={() => setEditing(x)}>{t("pharmacyOffice.trays.editList")}</Button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {current !== null && <TrayHistory tray={current} />}
      <p className="text-xs text-muted-foreground">{t("pharmacyOffice.trays.chargingNote")}</p>
      {checking !== null && (
        <Sheet title={`${t(`pharmacyOffice.trays.kind.${checking.kind}`)} · ${checking.tray.name}`} testId="tray-check-sheet" onClose={() => setChecking(null)}>
          <CheckForm tray={checking.tray} kind={checking.kind} onDone={(text, red) => { setChecking(null); setNotice({ text, red }); }} />
        </Sheet>
      )}
      {editing !== null && (
        <Sheet title={editing === "new" ? t("pharmacyOffice.trays.addTray") : `${t("pharmacyOffice.trays.editList")} · ${editing.name}`} testId="tray-edit-sheet" onClose={() => setEditing(null)}>
          {editing === "new" ? <NewTrayForm onDone={() => setEditing(null)} /> : <TemplateEditor tray={editing} />}
        </Sheet>
      )}
    </div>
  );
}

type LineState = { present: string; expiry: string };

function CheckForm({ tray, kind, onDone }: { tray: WireTray; kind: TrayCheckKind; onDone: (text: string, red: boolean) => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [key] = useState(() => newIdempotencyKey());
  const full = kind !== "daily_seal";
  const active = tray.template.filter((l) => l.active);
  const [lines, setLines] = useState<Record<string, LineState>>(() =>
    Object.fromEntries(active.map((l) => [l.itemId, { present: String(l.parQty), expiry: "" }])));
  const [sealSeen, setSealSeen] = useState("");
  const [sealNew, setSealNew] = useState("");
  const [event, setEvent] = useState("");
  const [note, setNote] = useState("");
  const today = todayIst();
  const parsed = active.map((l) => {
    const s = lines[l.itemId]!;
    const n = /^\d{1,6}$/.test(s.present.trim()) ? Number(s.present.trim()) : null;
    return { l, qty: n, expiry: s.expiry, preview: previewLine(l, n, s.expiry, today) };
  });
  const ready = full ? active.length > 0 && parsed.every((p) => p.qty !== null) : sealSeen.trim() !== "";
  const sealDiffers = !full && tray.expectedSeal !== null && sealSeen.trim() !== "" && sealSeen.trim() !== tray.expectedSeal;
  const m = useMutation({
    mutationFn: () => recordTrayCheck({
      trayId: tray.id, kind,
      sealSeen: sealSeen.trim() === "" ? null : sealSeen.trim(),
      sealNew: full && sealNew.trim() !== "" ? sealNew.trim() : null,
      ...(full ? { lines: parsed.map((p) => ({ itemId: p.l.itemId, qtyPresent: p.qty!, earliestExpiry: p.expiry === "" ? null : p.expiry })) } : {}),
      ...(kind === "after_use" ? { event: event.trim() === "" ? null : event.trim() } : {}),
      note: note.trim() === "" ? null : note.trim(),
    }, key),
    onSuccess: async (out) => {
      await qc.invalidateQueries({ queryKey: ["pharmacy", "trays"] });
      onDone(out.result === "ok" ? t("pharmacyOffice.trays.savedOk", { no: out.no }) : t("pharmacyOffice.trays.savedDeficient", { no: out.no, count: out.deficit }), out.result !== "ok");
    },
  });
  const set = (itemId: string, patch: Partial<LineState>): void => setLines((c) => ({ ...c, [itemId]: { ...c[itemId]!, ...patch } }));
  return (
    <form className="space-y-3" data-testid="tray-check-form" onSubmit={(e) => { e.preventDefault(); if (ready) m.mutate(); }}>
      <p className="text-sm text-muted-foreground">{tray.location} · {tray.code}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-sm">{t("pharmacyOffice.trays.f.sealSeen")}
          <Input autoComplete="off" data-testid="tray-seal-seen" value={sealSeen} onChange={(e) => setSealSeen(e.target.value)} />
          {tray.expectedSeal !== null && <span className="text-xs text-muted-foreground">{t("pharmacyOffice.trays.expectedSeal", { seal: tray.expectedSeal })}</span>}
        </label>
        {full && (
          <label className="text-sm">{t("pharmacyOffice.trays.f.sealNew")}
            <Input autoComplete="off" data-testid="tray-seal-new" value={sealNew} onChange={(e) => setSealNew(e.target.value)} />
          </label>
        )}
      </div>
      {sealDiffers && <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="tray-seal-warn">{t("pharmacyOffice.trays.sealWarn")}</p>}
      {full && active.length === 0 && <p className="text-sm text-red-700">{t("pharmacyOffice.trays.noList")}</p>}
      {full && active.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-2 font-normal">{t("pharmacyOffice.trays.f.item")}</th>
                <th className="py-1 pr-2 font-normal">{t("pharmacyOffice.trays.f.par")}</th>
                <th className="py-1 pr-2 font-normal">{t("pharmacyOffice.trays.f.present")}</th>
                <th className="py-1 pr-2 font-normal">{t("pharmacyOffice.trays.f.expiry")}</th>
                <th className="py-1 font-normal" />
              </tr>
            </thead>
            <tbody>
              {parsed.map(({ l, preview }) => (
                <tr key={l.itemId} className="border-t" data-testid={`tray-line-${l.itemCode}`}>
                  <td className="py-1 pr-2">{l.itemName} <span className="text-xs text-muted-foreground">({l.baseUom})</span></td>
                  <td className="py-1 pr-2 font-mono">{l.parQty}</td>
                  <td className="py-1 pr-2"><Input inputMode="numeric" className="w-20" data-testid={`tray-present-${l.itemCode}`} value={lines[l.itemId]!.present} onChange={(e) => set(l.itemId, { present: e.target.value })} /></td>
                  <td className="py-1 pr-2"><Input type="date" className="w-40" data-testid={`tray-expiry-${l.itemCode}`} value={lines[l.itemId]!.expiry} onChange={(e) => set(l.itemId, { expiry: e.target.value })} /></td>
                  <td className="py-1 space-x-1 whitespace-nowrap">
                    {preview.short && <span className="pill rd" data-testid={`tray-short-${l.itemCode}`}>{t("pharmacyOffice.trays.short")}</span>}
                    {preview.expiring && <span className="pill gd" data-testid={`tray-expiring-${l.itemCode}`}>{t("pharmacyOffice.trays.expiring")}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {kind === "after_use" && (
        <label className="block text-sm">{t("pharmacyOffice.trays.f.event")}
          <Input autoComplete="off" data-testid="tray-event" placeholder={t("pharmacyOffice.trays.f.eventHint")} value={event} onChange={(e) => setEvent(e.target.value)} />
        </label>
      )}
      <label className="block text-sm">{t("pharmacyOffice.trays.f.note")}
        <textarea className={areaCls} data-testid="tray-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {m.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(m.error, t)}</p>}
      <Button type="submit" data-testid="tray-check-save" disabled={!ready || m.isPending}>{t("pharmacyOffice.trays.save")}</Button>
    </form>
  );
}

function TrayHistory({ tray }: { tray: WireTray }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["pharmacy", "trays", "checks", tray.id], queryFn: () => fetchTrayChecks(tray.id) });
  const rows = q.data?.items ?? [];
  return (
    <section className="min-w-0 rounded border p-3" data-testid="tray-history">
      <h3 className="mb-2 text-sm font-semibold">{t("pharmacyOffice.trays.history", { name: tray.name })}</h3>
      {q.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(q.error, t)}</p>}
      {q.data !== undefined && rows.length === 0 && <p className="text-sm text-muted-foreground">{t("pharmacyOffice.trays.historyEmpty")}</p>}
      <ul className="divide-y empty:hidden">
        {rows.map((c) => (
          <li key={c.id} className={`space-y-1 py-2 text-sm ${c.result === "deficient" ? "text-red-800" : ""}`} data-testid={`tray-history-${c.no}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{c.no}</span>
              <span>{t(`pharmacyOffice.trays.kind.${c.kind}`)}</span>
              <span className="text-xs text-muted-foreground">{when(c.checkedAt)} · {c.checkedByName ?? "—"}</span>
              <span className={c.result === "ok" ? "pill on" : "pill rd"}>{t(`pharmacyOffice.trays.result.${c.result}`)}</span>
              {c.findings.map((f) => <span key={f} className="pill">{t(`pharmacyOffice.trays.finding.${f}`)}</span>)}
              {c.restock !== null && <span className="pill">{t("pharmacyOffice.trays.restockState", { status: t(`pharmacyOffice.trays.transfer.${c.restock.status}`) })}</span>}
            </div>
            {(c.sealSeen !== null || c.sealNew !== null) && (
              <p className="text-xs text-muted-foreground">{t("pharmacyOffice.trays.seals", { seen: c.sealSeen ?? "—", fresh: c.sealNew ?? "—" })}</p>
            )}
            {c.event !== null && <p className="text-xs">{c.event}</p>}
            {c.lines.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {c.lines.map((l) => t("pharmacyOffice.trays.lineSummary", { item: l.itemName, present: l.qtyPresent, par: l.parQty, used: l.qtyUsed, restock: l.qtyRestock })).join(" · ")}
              </p>
            )}
            {c.note !== null && <p className="text-xs">{c.note}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function KeeperPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <fieldset className="text-sm">
      <legend className="mb-1">{t("pharmacyOffice.trays.f.keepers")}</legend>
      <div className="flex flex-wrap gap-3">
        {TRAY_KEEPER_ROLES.map((r) => (
          <label key={r} className="flex items-center gap-1">
            <input type="checkbox" data-testid={`tray-keeper-${r}`} checked={value.includes(r)}
              onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))} />
            {t(`pharmacyOffice.trays.role.${r}`)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function NewTrayForm({ onDone }: { onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [keepers, setKeepers] = useState<string[]>([]);
  const ready = name.trim() !== "" && location.trim() !== "" && keepers.length > 0;
  const m = useMutation({
    mutationFn: () => addTray({ name: name.trim(), location: location.trim(), custodianRoles: keepers }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["pharmacy", "trays"] }); onDone(); },
  });
  return (
    <form className="space-y-3" data-testid="tray-new-form" onSubmit={(e) => { e.preventDefault(); if (ready) m.mutate(); }}>
      <label className="block text-sm">{t("pharmacyOffice.trays.f.name")}
        <Input autoComplete="off" data-testid="tray-name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="block text-sm">{t("pharmacyOffice.trays.f.location")}
        <Input autoComplete="off" data-testid="tray-location" placeholder={t("pharmacyOffice.trays.f.locationHint")} value={location} onChange={(e) => setLocation(e.target.value)} />
      </label>
      <KeeperPicker value={keepers} onChange={setKeepers} />
      {m.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(m.error, t)}</p>}
      <Button type="submit" data-testid="tray-new-save" disabled={!ready || m.isPending}>{t("pharmacyOffice.trays.saveTray")}</Button>
    </form>
  );
}

function TemplateEditor({ tray }: { tray: WireTray }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [keepers, setKeepers] = useState<string[]>(tray.custodianRoles);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<{ id: string; name: string } | null>(null);
  const [par, setPar] = useState("");
  const found = useQuery({ queryKey: ["pharmacy", "trays", "items", q], queryFn: () => fetchTrayItems(q), enabled: q.trim().length >= 2 && pick === null });
  const refresh = async (): Promise<void> => { await qc.invalidateQueries({ queryKey: ["pharmacy", "trays"] }); };
  const keep = useMutation({ mutationFn: () => setTrayKeepers(tray.id, keepers), onSuccess: refresh });
  const save = useMutation({
    mutationFn: (b: { itemId: string; parQty: number; minExpiryDays?: number | null; active?: boolean }) => saveTrayLine(tray.id, b),
    onSuccess: async () => { setPick(null); setQ(""); setPar(""); await refresh(); },
  });
  const parN = /^\d{1,5}$/.test(par.trim()) && Number(par) > 0 ? Number(par) : null;
  const err = keep.error ?? save.error;
  return (
    <div className="space-y-4" data-testid="tray-template-editor">
      <section className="space-y-2">
        <KeeperPicker value={keepers} onChange={setKeepers} />
        <Button type="button" size="sm" variant="outline" data-testid="tray-keepers-save" disabled={keepers.length === 0 || keep.isPending} onClick={() => keep.mutate()}>{t("pharmacyOffice.trays.saveKeepers")}</Button>
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("pharmacyOffice.trays.list")}</h3>
        {tray.template.length === 0 && <p className="text-sm text-muted-foreground">{t("pharmacyOffice.trays.noList")}</p>}
        <ul className="divide-y rounded border empty:hidden">
          {tray.template.map((l) => <TemplateRow key={l.id} line={l} onSave={(b) => save.mutate(b)} busy={save.isPending} />)}
        </ul>
        <div className="grid items-end gap-2 sm:grid-cols-[1fr_7rem_auto]">
          <label className="text-sm">{t("pharmacyOffice.trays.f.addItem")}
            {pick === null
              ? <Input autoComplete="off" data-testid="tray-item-search" value={q} onChange={(e) => setQ(e.target.value)} />
              : <span className="flex items-center gap-2 py-2"><span className="font-medium">{pick.name}</span><button type="button" className="text-xs underline" onClick={() => setPick(null)}>{t("pharmacyOffice.trays.change")}</button></span>}
          </label>
          <label className="text-sm">{t("pharmacyOffice.trays.f.par")}
            <Input inputMode="numeric" data-testid="tray-item-par" value={par} onChange={(e) => setPar(e.target.value)} />
          </label>
          <Button type="button" data-testid="tray-item-add" disabled={pick === null || parN === null || save.isPending} onClick={() => { if (pick !== null && parN !== null) save.mutate({ itemId: pick.id, parQty: parN }); }}>{t("pharmacyOffice.trays.addLine")}</Button>
        </div>
        {pick === null && (found.data?.items ?? []).length > 0 && (
          <ul className="max-h-48 overflow-y-auto rounded border text-sm" data-testid="tray-item-results">
            {found.data!.items.map((it) => (
              <li key={it.id}><button type="button" className="w-full px-2 py-1 text-left hover:bg-muted" onClick={() => setPick({ id: it.id, name: it.name })}>{it.name} <span className="text-xs text-muted-foreground">{it.code} · {it.baseUom}</span></button></li>
            ))}
          </ul>
        )}
      </section>
      {err !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(err, t)}</p>}
    </div>
  );
}

function TemplateRow({ line, onSave, busy }: { line: WireTrayTemplateLine; onSave: (b: { itemId: string; parQty: number; minExpiryDays: number | null; active: boolean }) => void; busy: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const [par, setPar] = useState(String(line.parQty));
  const [margin, setMargin] = useState(line.minExpiryDays === null ? "" : String(line.minExpiryDays));
  const [active, setActive] = useState(line.active);
  const parN = /^\d{1,5}$/.test(par.trim()) && Number(par) > 0 ? Number(par) : null;
  const marginN = margin.trim() === "" ? null : /^\d{1,3}$/.test(margin.trim()) && Number(margin) <= 365 ? Number(margin) : undefined;
  const changed = parN !== line.parQty || marginN !== line.minExpiryDays || active !== line.active;
  return (
    <li className="grid items-end gap-2 px-3 py-2 text-sm sm:grid-cols-[1fr_6rem_7rem_auto_auto]" data-testid={`tray-tpl-${line.itemCode}`}>
      <span className={`min-w-0 truncate ${line.active ? "" : "text-muted-foreground line-through"}`}>{line.itemName}</span>
      <label className="text-xs">{t("pharmacyOffice.trays.f.par")}<Input inputMode="numeric" data-testid={`tray-tpl-par-${line.itemCode}`} value={par} onChange={(e) => setPar(e.target.value)} /></label>
      <label className="text-xs">{t("pharmacyOffice.trays.f.margin")}<Input inputMode="numeric" placeholder="30" value={margin} onChange={(e) => setMargin(e.target.value)} /></label>
      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{t("pharmacyOffice.trays.f.active")}</label>
      <Button type="button" size="sm" variant="outline" data-testid={`tray-tpl-save-${line.itemCode}`} disabled={!changed || parN === null || marginN === undefined || busy}
        onClick={() => { if (parN !== null && marginN !== undefined) onSave({ itemId: line.itemId, parQty: parN, minExpiryDays: marginN, active }); }}>{t("pharmacyOffice.trays.saveLine")}</Button>
    </li>
  );
}
