import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { useAuth } from "../lib/auth";
import { radiologyErrorText } from "../lib/radiology-api";
import {
  SETUP_MODALITIES, SETUP_STATUSES, createSetupDevice, draftBook, editSetupDevice, fetchActiveBook,
  fetchSetupBooks, fetchSetupDevices, fetchSetupPrices, publishBook, rupees, setSetupDeviceStatus,
} from "../lib/radiology-setup-api";
import { Button } from "@/components/ui/button";
import type {
  WireBook, WireBookVersion, WireBookedStudy, WireSetupDevice, WireSetupRoom,
} from "../lib/radiology-setup-api";
import { RadiologyStation } from "./radiology-station";

/**
 * PLAN 18-S RS4 T4 — **THE SETUP STATION: machines, books and prices.** One route, three header
 * views (`?view=machines|books|prices`), each with the house layout: the thing in hand in the
 * centre, ONE list on the right, no filter tabs.
 *
 *   · **Machines** — the register from `GET /radiology/setup/devices`. Register a machine, edit its
 *     description (never its modality), set its status with a required reason; an out-of-service
 *     status answers with the booked studies to move, linked to the desk diary.
 *   · **Books** — the governed definitions, their active version and the three people behind it.
 *     "Draft a new version" posts to the EXISTING `/radiology/definitions/draft`, which files the
 *     medical superintendent's approval; the approval is decided in the kernel approvals inbox
 *     (linked), and a granted draft is published here. No second approval system.
 *   · **Prices** — the `RAD-` services, their GST category and price, read-only. Prices change
 *     through a tariff revision the owner approves; there is no tariff screen yet, and this view
 *     says so rather than offering an edit it cannot govern.
 */

export type SetupView = "machines" | "books" | "prices";
export const SETUP_VIEWS: readonly SetupView[] = ["machines", "books", "prices"];

function slotText(iso: string | null): string {
  if (iso === null) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
  });
}

const OUT_OF_SERVICE = new Set(["down", "maintenance", "qa_blocked", "retired"]);

const field = "w-full rounded border bg-background px-2 py-1 text-sm";

export function RadiologySetup({ view = "machines" }: { view?: SetupView }): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter({ warn: false });
  const go = (e: React.MouseEvent, v: SetupView): void => {
    if (router === undefined) return;
    e.preventDefault();
    void router.navigate({ to: "/radiology/setup", search: { view: v } });
  };
  const views = SETUP_VIEWS.map((v) => (
    <a
      key={v}
      href={`/radiology/setup?view=${v}`}
      className="st-nv"
      data-testid={`setup-view-${v}`}
      aria-current={v === view ? "page" : undefined}
      onClick={(e) => go(e, v)}
    >
      {t(`radiology.setup.views.${v}`)}
    </a>
  ));
  if (view === "books") return <BooksView views={views} />;
  if (view === "prices") return <PricesView views={views} />;
  return <MachinesView views={views} />;
}

/* ─────────────────────────────── Machines ─────────────────────────────── */

type Form = { code: string; name: string; modality: string; roomId: string; aeTitle: string; portable: boolean };
const EMPTY: Form = { code: "", name: "", modality: "xray", roomId: "", aeTitle: "", portable: false };

function formOf(d: WireSetupDevice): Form {
  return {
    code: d.code, name: d.name, modality: d.modality, roomId: d.roomId ?? "", aeTitle: d.aeTitle ?? "", portable: d.portable,
  };
}

function MachinesView({ views }: { views: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["radiology", "setup", "devices"], queryFn: fetchSetupDevices });
  const devices = q.data?.devices ?? [];
  const rooms = q.data?.rooms ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = devices.find((d) => d.id === selectedId) ?? null;

  const list = (
    <div className="space-y-2" data-testid="setup-machines">
      <Button size="sm" variant="outline" className="w-full" data-testid="setup-new" onClick={() => setSelectedId(null)}>
        {t("radiology.setup.machines.new")}
      </Button>
      <ul className="space-y-1">
        {devices.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              data-testid={`machine-${d.code}`}
              aria-current={d.id === selectedId ? "true" : undefined}
              className={`w-full rounded border p-2 text-left text-sm hover:bg-muted ${d.id === selectedId ? "bg-muted" : "bg-card"} ${d.status === "retired" ? "opacity-60" : ""}`}
              onClick={() => setSelectedId(d.id)}
            >
              <span className="flex justify-between gap-2">
                <b className="truncate">{d.code} · {d.name}</b>
                <span className={`mo shrink-0 text-xs ${OUT_OF_SERVICE.has(d.status) ? "text-red-700" : ""}`}>
                  {t(`radiology.setup.status.${d.status}`, { defaultValue: d.status })}
                </span>
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {t(`radiology.setup.modality.${d.modality}`, { defaultValue: d.modality })}
                {" · "}{d.room ?? t("radiology.setup.machines.noRoom")}
                {" · "}{d.aeTitle ?? t("radiology.setup.machines.noAeTitle")}
                {d.portable ? ` · ${t("radiology.setup.machines.portable")}` : ""}
                {d.licensedNow === false ? ` · ${t("radiology.setup.machines.unlicensed")}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {!q.isPending && devices.length === 0 ? <p className="text-sm">{t("radiology.setup.machines.empty")}</p> : null}
    </div>
  );

  const live = devices.filter((d) => d.status !== "retired");
  return (
    <RadiologyStation
      station="setup"
      views={views}
      title={t("radiology.setup.title")}
      place={t("radiology.setup.machines.place")}
      stats={[
        { label: t("radiology.setup.machines.count"), value: live.length },
        { label: t("radiology.setup.machines.outOfService"), value: live.filter((d) => OUT_OF_SERVICE.has(d.status)).length, tone: "danger" },
        { label: t("radiology.setup.machines.withoutAe"), value: live.filter((d) => d.aeTitle === null).length, tone: "waiting" },
        { label: t("radiology.setup.machines.unlicensedCount"), value: live.filter((d) => d.licensedNow === false).length, tone: "danger" },
      ]}
      list={list}
      inHand={selected !== null}
      closeListOn={selectedId}
    >
      <div className="space-y-4">
        {q.isError ? <p role="alert" className="text-red-600">{radiologyErrorText(q.error)}</p> : null}
        {q.isPending ? <p>{t("common.loading")}</p> : null}
        <MachineForm
          key={selected?.id ?? "new"}
          device={selected}
          rooms={rooms}
          onSaved={(id) => { void qc.invalidateQueries({ queryKey: ["radiology", "setup", "devices"] }); setSelectedId(id); }}
        />
        {selected !== null && selected.status !== "retired"
          ? <StatusPanel key={`s-${selected.id}`} device={selected} onDone={() => void qc.invalidateQueries({ queryKey: ["radiology", "setup", "devices"] })} />
          : null}
      </div>
    </RadiologyStation>
  );
}

function MachineForm({ device, rooms, onSaved }: {
  device: WireSetupDevice | null; rooms: WireSetupRoom[]; onSaved: (id: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [f, setF] = useState<Form>(device === null ? EMPTY : formOf(device));
  const set = (patch: Partial<Form>) => setF((prev) => ({ ...prev, ...patch }));
  const retired = device?.status === "retired";
  const save = useMutation({
    mutationFn: async () => {
      const body = {
        code: f.code, name: f.name, roomId: f.roomId === "" ? null : f.roomId,
        aeTitle: f.aeTitle.trim() === "" ? null : f.aeTitle.trim(), portable: f.portable,
      };
      if (device === null) return (await createSetupDevice({ ...body, modality: f.modality })).deviceResourceId;
      await editSetupDevice(device.id, body);
      return device.id;
    },
    onSuccess: onSaved,
  });

  return (
    <form
      className="space-y-3 rounded border bg-card p-3"
      data-testid="machine-form"
      onSubmit={(e) => { e.preventDefault(); save.mutate(); }}
    >
      <h2 className="text-base font-semibold">
        {device === null ? t("radiology.setup.machines.registerTitle") : `${device.code} · ${device.name}`}
      </h2>
      {device !== null && device.ionising
        ? <p className="text-xs text-muted-foreground">{t("radiology.setup.machines.ionisingNote")}</p>
        : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          {t("radiology.setup.machines.code")}
          <input className={field} value={f.code} disabled={retired} required maxLength={32} data-testid="machine-code" onChange={(e) => set({ code: e.target.value })} />
        </label>
        <label className="block text-sm">
          {t("radiology.setup.machines.name")}
          <input className={field} value={f.name} disabled={retired} required maxLength={120} data-testid="machine-name" onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="block text-sm">
          {t("radiology.setup.machines.modality")}
          <select
            className={field} value={f.modality} disabled={device !== null} data-testid="machine-modality"
            onChange={(e) => set({ modality: e.target.value })}
          >
            {SETUP_MODALITIES.map((m) => <option key={m} value={m}>{t(`radiology.setup.modality.${m}`)}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          {t("radiology.setup.machines.room")}
          <select className={field} value={f.roomId} disabled={retired} data-testid="machine-room" onChange={(e) => set({ roomId: e.target.value })}>
            <option value="">{t("radiology.setup.machines.noRoom")}</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          {t("radiology.setup.machines.aeTitle")}
          <input
            className={`${field} mo`} value={f.aeTitle} disabled={retired} maxLength={16} placeholder="CT_1"
            data-testid="machine-ae" onChange={(e) => set({ aeTitle: e.target.value })}
          />
          <span className="block text-xs text-muted-foreground">{t("radiology.setup.machines.aeHint")}</span>
        </label>
        <label className="flex items-center gap-2 self-center text-sm">
          <input type="checkbox" checked={f.portable} disabled={retired} data-testid="machine-portable" onChange={(e) => set({ portable: e.target.checked })} />
          {t("radiology.setup.machines.portableLabel")}
        </label>
      </div>
      {device !== null ? <p className="text-xs text-muted-foreground">{t("radiology.setup.machines.modalityFixed")}</p> : null}
      {save.isError ? <p role="alert" className="text-sm text-red-600">{radiologyErrorText(save.error)}</p> : null}
      {save.isSuccess ? <p className="text-sm text-green-700" data-testid="machine-saved">{t("radiology.setup.machines.saved")}</p> : null}
      {!retired
        ? (
          <Button type="submit" disabled={save.isPending} data-testid="machine-save">
            {device === null ? t("radiology.setup.machines.register") : t("radiology.setup.machines.save")}
          </Button>
        )
        : <p className="text-sm">{t("radiology.setup.machines.retiredNote")}</p>}
    </form>
  );
}

function StatusPanel({ device, onDone }: { device: WireSetupDevice; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [status, setStatus] = useState<string>(device.status === "in_use" ? "available" : device.status);
  const [reason, setReason] = useState("");
  const [moved, setMoved] = useState<WireBookedStudy[] | null>(null);
  useEffect(() => { setMoved(null); }, [device.id]);
  const change = useMutation({
    mutationFn: () => setSetupDeviceStatus(device.id, status, reason),
    onSuccess: (out) => { setMoved(out.studiesToMove); setReason(""); onDone(); },
  });

  return (
    <section className="space-y-3 rounded border bg-card p-3" data-testid="machine-status" aria-label={t("radiology.setup.machines.statusTitle")}>
      <h3 className="text-sm font-semibold">
        {t("radiology.setup.machines.statusTitle")} · {t(`radiology.setup.status.${device.status}`, { defaultValue: device.status })}
      </h3>
      <form
        className="grid gap-3 sm:grid-cols-[12rem_1fr]"
        onSubmit={(e) => { e.preventDefault(); change.mutate(); }}
      >
        <label className="block text-sm">
          {t("radiology.setup.machines.newStatus")}
          <select className={field} value={status} data-testid="status-select" onChange={(e) => setStatus(e.target.value)}>
            {SETUP_STATUSES.map((s) => <option key={s} value={s}>{t(`radiology.setup.status.${s}`)}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          {t("radiology.setup.machines.reason")}
          <textarea
            className={field} rows={2} value={reason} maxLength={500} required data-testid="status-reason"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={change.isPending || reason.trim() === ""} data-testid="status-save">
            {t("radiology.setup.machines.setStatus")}
          </Button>
        </div>
      </form>
      {status === "qa_blocked" || device.status === "qa_blocked"
        ? <p className="text-xs text-muted-foreground">{t("radiology.setup.machines.qaNote")}</p>
        : null}
      {change.isError ? <p role="alert" className="text-sm text-red-600">{radiologyErrorText(change.error)}</p> : null}
      {moved !== null
        ? (
          <div data-testid="studies-to-move" className="space-y-1">
            {moved.length === 0
              ? <p className="text-sm">{t("radiology.setup.machines.nothingToMove")}</p>
              : (
                <>
                  <p className="text-sm font-semibold text-red-700">{t("radiology.setup.machines.toMove", { count: moved.length })}</p>
                  <ul className="space-y-1 text-sm">
                    {moved.map((s) => (
                      <li key={s.studyId} className="rounded border p-2">
                        <span className="mo">{s.accessionNo}</span> · {s.studyTypeCode} · {slotText(s.scheduledAt)} · {s.status}
                      </li>
                    ))}
                  </ul>
                  <a className="text-sm underline" href="/radiology/diary" data-testid="to-diary">{t("radiology.setup.machines.openDiary")}</a>
                </>
              )}
          </div>
        )
        : null}
    </section>
  );
}

/* ─────────────────────────────── Books ─────────────────────────────── */

function VersionLine({ v }: { v: WireBookVersion }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-2 gap-y-1 text-sm">
      <dt className="text-muted-foreground">{t("radiology.setup.books.version")}</dt><dd className="mo">v{v.version}</dd>
      <dt className="text-muted-foreground">{t("radiology.setup.books.draftedBy")}</dt><dd>{v.draftedBy ?? "—"}</dd>
      <dt className="text-muted-foreground">{t("radiology.setup.books.approvedBy")}</dt>
      <dd>{v.seeded ? t("radiology.setup.books.seeded") : v.approvedBy ?? t(`radiology.setup.books.approval.${v.approvalStatus ?? "none"}`, { defaultValue: v.approvalStatus ?? "—" })}</dd>
      {v.status === "active"
        ? (<><dt className="text-muted-foreground">{t("radiology.setup.books.publishedBy")}</dt><dd>{v.publishedBy ?? "—"} · {slotText(v.publishedAt)}</dd></>)
        : null}
    </dl>
  );
}

function BooksView({ views }: { views: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["radiology", "setup", "books"], queryFn: fetchSetupBooks });
  const books = q.data?.books ?? [];
  const [kind, setKind] = useState<string | null>(null);
  const book: WireBook | undefined = books.find((b) => b.kind === kind) ?? books[0];
  const mayDraft = can("radiology.definitions.manage");

  const list = (
    <ul className="space-y-1" data-testid="setup-books">
      {books.map((b) => (
        <li key={b.kind}>
          <button
            type="button" data-testid={`book-${b.kind}`}
            aria-current={b.kind === book?.kind ? "true" : undefined}
            className={`w-full rounded border p-2 text-left text-sm hover:bg-muted ${b.kind === book?.kind ? "bg-muted" : "bg-card"}`}
            onClick={() => setKind(b.kind)}
          >
            <span className="flex justify-between gap-2">
              <b className="truncate">{t(`radiology.setup.books.kind.${b.kind}`, { defaultValue: b.kind })}</b>
              <span className="mo shrink-0 text-xs">{b.active ? `v${b.active.version}` : t("radiology.setup.books.none")}</span>
            </span>
            {b.drafts.length > 0
              ? <span className="block text-xs text-amber-700">{t("radiology.setup.books.draftsWaiting", { count: b.drafts.length })}</span>
              : null}
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <RadiologyStation
      station="setup"
      views={views}
      title={t("radiology.setup.title")}
      place={t("radiology.setup.books.place")}
      stats={[
        { label: t("radiology.setup.books.active"), value: books.filter((b) => b.active !== null).length },
        { label: t("radiology.setup.books.missing"), value: books.filter((b) => b.active === null).length, tone: "waiting" },
        { label: t("radiology.setup.books.drafts"), value: books.reduce((n, b) => n + b.drafts.length, 0), tone: "waiting" },
      ]}
      list={list}
      closeListOn={kind}
    >
      <div className="space-y-4">
        {q.isError ? <p role="alert" className="text-red-600">{radiologyErrorText(q.error)}</p> : null}
        {q.isPending ? <p>{t("common.loading")}</p> : null}
        <p className="text-sm text-muted-foreground">{t("radiology.setup.books.governance")}</p>
        {book !== undefined
          ? (
            <section className="space-y-3 rounded border bg-card p-3" data-testid="book-detail" aria-label={book.kind}>
              <h2 className="text-base font-semibold">{t(`radiology.setup.books.kind.${book.kind}`, { defaultValue: book.kind })}</h2>
              {book.active !== null ? <VersionLine v={book.active} /> : <p className="text-sm">{t("radiology.setup.books.noActive")}</p>}
              {book.drafts.map((d) => (
                <DraftCard
                  key={d.definitionId} draft={d} mayPublish={mayDraft}
                  onPublished={() => void qc.invalidateQueries({ queryKey: ["radiology", "setup", "books"] })}
                />
              ))}
              {mayDraft
                ? <DraftEditor key={book.kind} kind={book.kind} onDrafted={() => void qc.invalidateQueries({ queryKey: ["radiology", "setup", "books"] })} />
                : <p className="text-sm text-muted-foreground">{t("radiology.setup.books.readOnly")}</p>}
            </section>
          )
          : null}
      </div>
    </RadiologyStation>
  );
}

function DraftCard({ draft, mayPublish, onPublished }: {
  draft: WireBookVersion; mayPublish: boolean; onPublished: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const publish = useMutation({
    mutationFn: () => publishBook(draft.definitionId, draft.approvalId!),
    onSuccess: onPublished,
  });
  return (
    <div className="space-y-2 rounded border border-dashed p-2" data-testid={`draft-${draft.version}`}>
      <p className="text-sm font-semibold">{t("radiology.setup.books.draftTitle", { version: draft.version })}</p>
      <VersionLine v={draft} />
      {draft.approvalStatus === "pending" && draft.approvalId !== null
        ? <a className="text-sm underline" href={`/approvals?focus=${encodeURIComponent(draft.approvalId)}`} data-testid="to-approvals">{t("radiology.setup.books.waitingMs")}</a>
        : null}
      {draft.approvalStatus === "granted" && mayPublish
        ? <Button size="sm" disabled={publish.isPending} data-testid="book-publish" onClick={() => publish.mutate()}>{t("radiology.setup.books.publish")}</Button>
        : null}
      {draft.approvalStatus === "rejected" ? <p className="text-sm text-red-700">{t("radiology.setup.books.rejected")}</p> : null}
      {publish.isError ? <p role="alert" className="text-sm text-red-600">{radiologyErrorText(publish.error)}</p> : null}
    </div>
  );
}

function DraftEditor({ kind, onDrafted }: { kind: string; onDrafted: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => fetchActiveBook(kind),
    onSuccess: (active) => { setText(JSON.stringify(active.body ?? {}, null, 2)); setOpen(true); },
  });
  const submit = useMutation({
    mutationFn: (body: unknown) => draftBook(kind, body),
    onSuccess: () => { setOpen(false); onDrafted(); },
  });
  if (!open) {
    return (
      <div>
        <Button size="sm" variant="outline" disabled={start.isPending} data-testid="book-draft-open" onClick={() => start.mutate()}>
          {t("radiology.setup.books.draftNew")}
        </Button>
        {start.isError ? <p role="alert" className="text-sm text-red-600">{radiologyErrorText(start.error)}</p> : null}
      </div>
    );
  }
  return (
    <form
      className="space-y-2" data-testid="book-draft-form"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          const body: unknown = JSON.parse(text);
          setParseError(null);
          submit.mutate(body);
        } catch (err) {
          setParseError(err instanceof Error ? err.message : String(err));
        }
      }}
    >
      <p className="text-xs text-muted-foreground">{t("radiology.setup.books.draftHint")}</p>
      <textarea className={`${field} mo`} rows={14} value={text} data-testid="book-draft-body" onChange={(e) => setText(e.target.value)} />
      {parseError !== null ? <p role="alert" className="text-sm text-red-600">{t("radiology.setup.books.notJson")} {parseError}</p> : null}
      {submit.isError ? <p role="alert" className="text-sm text-red-600">{radiologyErrorText(submit.error)}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={submit.isPending} data-testid="book-draft-submit">{t("radiology.setup.books.submitDraft")}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>{t("radiology.setup.books.cancel")}</Button>
      </div>
    </form>
  );
}

/* ─────────────────────────────── Prices ─────────────────────────────── */

function PricesView({ views }: { views: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["radiology", "setup", "prices"], queryFn: fetchSetupPrices });
  const rows = q.data?.services ?? [];
  const [code, setCode] = useState<string | null>(null);
  const selected = rows.find((r) => r.code === code) ?? null;
  const noGst = rows.filter((r) => r.gst === null).length;
  const unpriced = rows.filter((r) => r.pricePaise === null).length;

  const list = (
    <ul className="space-y-1" data-testid="setup-prices">
      {rows.map((r) => (
        <li key={r.serviceId}>
          <button
            type="button" data-testid={`price-${r.code}`}
            aria-current={r.code === code ? "true" : undefined}
            className={`w-full rounded border p-2 text-left text-sm hover:bg-muted ${r.code === code ? "bg-muted" : "bg-card"}`}
            onClick={() => setCode(r.code)}
          >
            <span className="flex justify-between gap-2">
              <b className="truncate">{r.name}</b>
              <span className="mo shrink-0 text-xs">{rupees(r.pricePaise)}</span>
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              <span className="mo">{r.code}</span> · {r.category}
              {r.gst === null ? ` · ${t("radiology.setup.prices.noGst")}` : ""}
              {r.ruledPricePaise !== null ? ` · ${t("radiology.setup.prices.ruled")} ${rupees(r.ruledPricePaise)}` : ""}
            </span>
          </button>
        </li>
      ))}
      {!q.isPending && rows.length === 0 ? <li className="text-sm">{t("radiology.setup.prices.empty")}</li> : null}
    </ul>
  );

  return (
    <RadiologyStation
      station="setup"
      views={views}
      title={t("radiology.setup.title")}
      place={t("radiology.setup.prices.place")}
      stats={[
        { label: t("radiology.setup.prices.services"), value: rows.length },
        { label: t("radiology.setup.prices.unpriced"), value: unpriced, tone: "waiting" },
        { label: t("radiology.setup.prices.noGstCount"), value: noGst, tone: "danger" },
      ]}
      list={list}
      inHand={selected !== null}
      closeListOn={code}
    >
      <div className="space-y-4">
        {q.isError ? <p role="alert" className="text-red-600">{radiologyErrorText(q.error)}</p> : null}
        {q.isPending ? <p>{t("common.loading")}</p> : null}
        <p className="rounded border border-dashed p-3 text-sm text-muted-foreground" data-testid="prices-note">
          {t("radiology.setup.prices.note")}
        </p>
        {selected !== null
          ? (
            <section className="rounded border bg-card p-3" data-testid="price-detail" aria-label={selected.code}>
              <h2 className="text-base font-semibold">{selected.name}</h2>
              <dl className="mt-2 grid grid-cols-[9rem_1fr] gap-x-2 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{t("radiology.setup.prices.code")}</dt><dd className="mo">{selected.code}</dd>
                <dt className="text-muted-foreground">{t("radiology.setup.prices.category")}</dt><dd>{selected.category}</dd>
                <dt className="text-muted-foreground">{t("radiology.setup.prices.gst")}</dt>
                <dd>
                  {selected.gst === null
                    ? <span className="text-red-700">{t("radiology.setup.prices.noGstLong")}</span>
                    : `${selected.gst.exempt ? t("radiology.setup.prices.exempt") : `${String(selected.gst.rateBps / 100)}%`} · SAC ${selected.gst.sacCode}`}
                </dd>
                <dt className="text-muted-foreground">{t("radiology.setup.prices.tariff")}</dt>
                <dd className={selected.pricePaise === null ? "text-amber-700" : "mo"}>{selected.pricePaise === null ? t("radiology.setup.prices.notInTariff") : rupees(selected.pricePaise)}</dd>
                {selected.ruledPricePaise !== null
                  ? (<><dt className="text-muted-foreground">{t("radiology.setup.prices.ruled")}</dt><dd className="mo">{rupees(selected.ruledPricePaise)}</dd></>)
                  : null}
              </dl>
              {selected.code === "RAD-FILM" ? <p className="mt-2 text-xs text-muted-foreground">{t("radiology.setup.prices.filmRule")}</p> : null}
            </section>
          )
          : null}
      </div>
    </RadiologyStation>
  );
}
