import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { useAuth } from "../lib/auth";
import { newIdempotencyKey } from "../lib/api";
import { fmtIst, fmtRupees } from "../lib/format";
import { acknowledgeAlert } from "../lib/alerts-api";
import { decideOverrideRequest, radiologyErrorCode, radiologyErrorText } from "../lib/radiology-api";
import {
  FLOOR_STAGES, fetchHodAccessLog, fetchHodApprovals, fetchHodEquipment, fetchHodEscalations, fetchHodFloor,
  fetchHodMoney, fetchHodQuality, fetchHodRoster,
} from "../lib/radiology-hod-api";
import type { WireApproval, WireEscalation, WireFloor, WireQuality } from "../lib/radiology-hod-api";
import { Refusal, SeatLink } from "../components/radiology/imaging-counter";
import { RadiologyStation } from "./radiology-station";

/**
 * PLAN 18-S RS10 T5 — **THE SUPERVISOR & HOD STATION** (board: `st-hod`). One route,
 * `/radiology/hod?view=`, eight header views, each on the owner's layout: the menu in the header,
 * the thing in hand on the left, the work in the centre with ONE next act docked (Enter), ONE list on
 * the right with no filter tabs.
 *
 *   · **Floor** — `GET /radiology/supervisor/floor`, live (30 s): the pipeline with each stage's
 *     longest wait, the rooms, the readers' load, turnaround against target, leakage, and the gaps.
 *   · **Escalated** — the kernel OBLIGATION spine's rows for radiology causes. The acts are the
 *     spine's own (`POST /alerts/:id/ack` — seen, take it, hand over); the one docked act opens the
 *     seat that closes the cause. Nothing is closed here: the obligation resolves when its cause clears.
 *   · **Approvals** — radiology's pending kernel approvals: a gate override is granted or refused
 *     here through the EXISTING decide route; a book is the medical superintendent's (a link).
 *   · **Quality / Equipment / Roster / Money / Access log** — reads; "not measured yet" where the
 *     data does not exist.
 *
 * No patient names except on the access log (which is PHI-logged server-side).
 */

export type HodView = "floor" | "escalations" | "approvals" | "quality" | "equipment" | "roster" | "money" | "audit";
export const HOD_VIEWS: readonly HodView[] = ["floor", "escalations", "approvals", "quality", "equipment", "roster", "money", "audit"];

const FLOOR_KEY = ["radiology", "hod", "floor"] as const;
const RED_CAUSES = new Set(["red_critical", "stat_unread", "licence_gap", "machine_down"]);

function mins(n: number | null): string {
  if (n === null) return "—";
  if (n < 60) return `${String(n)} min`;
  const h = Math.floor(n / 60);
  return h < 48 ? `${String(h)} h ${String(n % 60)} m` : `${String(Math.floor(h / 24))} d`;
}

function useFloor() {
  return useQuery({ queryKey: FLOOR_KEY, queryFn: fetchHodFloor, refetchInterval: 30_000 });
}

function useHeaderViews(view: HodView): React.ReactNode {
  const { t } = useTranslation();
  const router = useRouter({ warn: false });
  const floor = useFloor();
  const count: Partial<Record<HodView, number>> = {
    escalations: floor.data?.escalations.open, approvals: floor.data?.approvals.pending,
  };
  return HOD_VIEWS.map((v) => (
    <a
      key={v} href={`/radiology/hod?view=${v}`} className="st-nv" data-testid={`hod-view-${v}`}
      aria-current={v === view ? "page" : undefined}
      onClick={(e) => {
        if (router === undefined) return;
        e.preventDefault();
        void router.navigate({ to: "/radiology/hod", search: { view: v } });
      }}
    >
      {t(`radiology.hod.views.${v}`)}
      {count[v] !== undefined && count[v]! > 0 ? <span className={`mo ml-1 text-xs ${v === "escalations" ? "text-red-700" : ""}`}>{count[v]}</span> : null}
    </a>
  ));
}

export function RadiologyHod({ view = "floor", item = null }: { view?: HodView; item?: string | null }): React.ReactElement {
  if (view === "escalations") return <EscalationsView item={item} />;
  if (view === "approvals") return <ApprovalsView />;
  if (view === "quality") return <QualityView />;
  if (view === "equipment") return <EquipmentView />;
  if (view === "roster") return <RosterView />;
  if (view === "money") return <MoneyView />;
  if (view === "audit") return <AuditView />;
  return <FloorView />;
}

/* ─────────────────────────────── shared bits ─────────────────────────────── */

function Tile({ label, value, sub, tone = "plain" }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "plain" | "ok" | "warn" | "bad" }): React.ReactElement {
  const border = tone === "bad" ? "border-red-300 bg-red-50" : tone === "warn" ? "border-amber-300 bg-amber-50" : tone === "ok" ? "border-green-300 bg-green-50" : "bg-card";
  return (
    <div className={`min-w-0 rounded border p-2 ${border}`}>
      <div className="tag">{label}</div>
      <div className="mo mt-1 text-xl font-semibold">{value}</div>
      {sub !== undefined && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Card({ title, children, testId }: { title: React.ReactNode; children: React.ReactNode; testId?: string }): React.ReactElement {
  return (
    <section className="min-w-0 rounded border bg-card" data-testid={testId}>
      <h2 className="tag m-0 border-b p-2">{title}</h2>
      <div className="p-2">{children}</div>
    </section>
  );
}

/** A table that scrolls inside itself at 390 px, never the page. */
function Table({ head, children, label }: { head: string[]; children: React.ReactNode; label: string }): React.ReactElement {
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full text-left text-sm" aria-label={label}>
        <thead><tr>{head.map((h) => <th key={h} className="tag whitespace-nowrap border-b p-1">{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Loading({ q }: { q: { isPending: boolean; isError: boolean; error: unknown } }): React.ReactElement | null {
  const { t } = useTranslation();
  if (q.isError) return <Refusal code={radiologyErrorCode(q.error)} message={radiologyErrorText(q.error)} />;
  if (q.isPending) return <p className="text-sm text-muted-foreground">{t("radiology.hod.loading")}</p>;
  return null;
}

/** The owner's standing rule: every station shows how it meets the five priorities. */
function FivePriorities({ rows }: { rows: [string, string, string][] }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Card title={t("radiology.hod.five.title")} testId="hod-five">
      <Table label={t("radiology.hod.five.title")} head={[t("radiology.hod.five.priority"), t("radiology.hod.five.how"), t("radiology.hod.five.fails")]}>
        {rows.map(([p, how, fails]) => (
          <tr key={p} className="border-b align-top">
            <td className="p-1 font-semibold">{p}</td><td className="p-1">{how}</td><td className="p-1 text-muted-foreground">{fails}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

/** The escalations list the floor and the Escalated view share — one query, one source. */
function useEscalations() {
  return useQuery({ queryKey: ["radiology", "hod", "escalations"], queryFn: fetchHodEscalations, refetchInterval: 30_000 });
}

const keyOf = (e: WireEscalation): string => `${e.cause}:${e.subjectId}`;

function EscalationRow({ e, selected, onOpen }: { e: WireEscalation; selected: boolean; onOpen: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const red = RED_CAUSES.has(e.cause);
  return (
    <li
      data-acc={e.accessionNo ?? undefined} data-down={e.cause === "machine_down" ? e.deviceCode ?? undefined : undefined}
      data-gap={e.cause === "licence_gap" ? e.deviceCode ?? undefined : undefined} data-esc={e.cause}
    >
      <button
        type="button" onClick={onOpen}
        className={`flex w-full items-start gap-2 rounded border p-2 text-left text-sm ${selected ? "outline outline-2 outline-black" : ""} ${red ? "border-red-300 bg-red-50" : "bg-card"}`}
      >
        <span aria-hidden className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${red ? "bg-red-700" : "bg-amber-500"}`} />
        <span className="min-w-0 flex-1">
          <b className="block">{t(`radiology.hod.cause.${e.cause}`)}</b>
          <span className="block truncate text-xs text-muted-foreground">
            {e.accessionNo ?? e.deviceCode ?? ""}{e.studyTypeCode !== null ? ` · ${e.studyTypeCode}` : ""}
          </span>
        </span>
        <span className="mo shrink-0 text-xs">{mins(e.ageMin)}</span>
      </button>
    </li>
  );
}

/* ═══════════════════════════════ Floor ═══════════════════════════════ */

function FloorView(): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter({ warn: false });
  const views = useHeaderViews("floor");
  const q = useFloor();
  const esc = useEscalations();
  const f = q.data;
  const rows = esc.data?.rows ?? [];

  const openEsc = (e: WireEscalation): void => {
    if (router === undefined) return;
    void router.navigate({ to: "/radiology/hod", search: { view: "escalations", item: keyOf(e) } });
  };
  const list = (
    <section aria-label={t("radiology.hod.escalatedToYou")}>
      <h2 className="tag m-0 mb-2">{t("radiology.hod.escalatedToYou")} · {rows.length}</h2>
      {esc.isSuccess && rows.length === 0 && <p className="text-sm text-muted-foreground">{t("radiology.hod.nothingEscalated")}</p>}
      <ul className="m-0 list-none space-y-1 p-0">
        {rows.map((e) => <EscalationRow key={keyOf(e)} e={e} selected={false} onOpen={() => openEsc(e)} />)}
      </ul>
    </section>
  );

  return (
    <RadiologyStation
      station="hod" views={views} title={t("radiology.hod.title")} place={t("radiology.hod.views.floor")}
      stats={f === undefined ? [] : [
        { label: t("radiology.hod.stat.live"), value: f.pipeline.filter((p) => p.stage !== "published").reduce((n, p) => n + p.count, 0) },
        { label: t("radiology.hod.stat.stat"), value: f.readers.stat, tone: f.readers.stat > 0 ? "waiting" : "plain" },
        { label: t("radiology.hod.stat.held"), value: f.pipeline.find((p) => p.stage === "checked_in")?.held ?? 0, tone: "danger" },
        { label: t("radiology.hod.stat.escalated"), value: f.escalations.open, tone: f.escalations.open > 0 ? "danger" : "plain" },
      ]}
      list={list}
    >
      <div className="space-y-3" data-testid="hod-floor">
        <Loading q={q} />
        {f !== undefined && <FloorBody f={f} />}
      </div>
    </RadiologyStation>
  );
}

function FloorBody({ f }: { f: WireFloor }): React.ReactElement {
  const { t } = useTranslation();
  const stage = (s: string) => f.pipeline.find((p) => p.stage === s)!;
  const held = stage("checked_in");
  const out = f.rooms.filter((r) => r.status === "down" || r.status === "qa_blocked" || r.status === "maintenance");
  const brief = [
    t("radiology.hod.brief.live", { count: f.pipeline.filter((p) => p.stage !== "published").reduce((n, p) => n + p.count, 0), stat: f.readers.stat }),
    held.held > 0 && held.oldest !== null
      ? t("radiology.hod.brief.held", { count: held.held, acc: held.oldest.accessionNo, wait: mins(held.oldest.waitMin) })
      : t("radiology.hod.brief.noneHeld"),
    f.licenceGaps.length > 0
      ? t("radiology.hod.brief.gaps", { machines: f.licenceGaps.map((g) => g.code).join(", ") })
      : out.length > 0 ? t("radiology.hod.brief.out", { machines: out.map((r) => r.code).join(", ") }) : t("radiology.hod.brief.allWell"),
  ];
  return (
    <>
      <p className="m-0 rounded border bg-card p-2 text-sm" data-testid="hod-brief"><b>{t("radiology.hod.brief.title")}</b> {brief.join(" ")}</p>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-6">
        <Tile label={t("radiology.hod.tile.acted")} value={f.turnaround.northStar.orderToActed.n}
          sub={t("radiology.hod.tile.actedSub", { median: mins(f.turnaround.northStar.orderToActed.medianMin), unread: f.turnaround.northStar.signedUnreadOver24h })} />
        <Tile label={t("radiology.hod.tile.red")} value={f.criticals.openRed} tone={f.criticals.openRed > 0 ? "bad" : "ok"}
          sub={f.criticals.oldestRedMin === null ? t("radiology.hod.tile.noneOpen") : t("radiology.hod.tile.oldest", { wait: mins(f.criticals.oldestRedMin) })} />
        <Tile label={t("radiology.hod.tile.held")} value={held.held} tone={held.held > 0 ? "warn" : "ok"}
          sub={held.oldest === null ? "—" : t("radiology.hod.tile.oldest", { wait: mins(held.oldest.waitMin) })} />
        <Tile label={t("radiology.hod.tile.leakage")} value={fmtRupees(f.leakage.estimatedPaise)} tone={f.leakage.open > 0 ? "warn" : "ok"}
          sub={t("radiology.hod.tile.leakageSub", { count: f.leakage.open, unpriced: f.leakage.unpriced })} />
        <Tile label={t("radiology.hod.tile.pacs")} value={f.unmatchedPacs.measured ? f.unmatchedPacs.open : "—"}
          tone={f.unmatchedPacs.olderThan24h > 0 ? "warn" : "plain"}
          sub={f.unmatchedPacs.measured ? t("radiology.hod.tile.pacsOld", { count: f.unmatchedPacs.olderThan24h }) : t("radiology.hod.notMeasured")} />
        <Tile label={t("radiology.hod.tile.gaps")} value={f.licenceGaps.length + f.qaOverdue.length}
          tone={f.licenceGaps.length + f.qaOverdue.length > 0 ? "bad" : "ok"}
          sub={t("radiology.hod.tile.gapsSub", { licences: f.licenceGaps.length, qa: f.qaOverdue.length })} />
      </div>

      <Card title={t("radiology.hod.pipeline")} testId="hod-pipeline">
        <ol className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-4 xl:grid-cols-8">
          {FLOOR_STAGES.map((s) => {
            const p = stage(s);
            return (
              <li key={s} className="rounded border p-2" data-stage={s} data-acc={p.oldest?.accessionNo}>
                <div className="tag">{t(`radiology.hod.stage.${s}`)}</div>
                <div className="mo text-xl font-semibold">{p.count}</div>
                <div className={`text-xs ${p.held > 0 ? "text-red-700" : "text-muted-foreground"}`}>
                  {p.held > 0 ? t("radiology.hod.heldN", { count: p.held }) : p.oldest !== null ? t("radiology.hod.oldestShort", { wait: mins(p.oldest.waitMin) }) : " "}
                </div>
                {p.oldest !== null && <div className="mo truncate text-xs text-muted-foreground">{p.oldest.accessionNo}</div>}
              </li>
            );
          })}
        </ol>
      </Card>

      <div className="grid gap-3 xl:grid-cols-2">
        <Card title={t("radiology.hod.rooms")} testId="hod-rooms">
          <Table label={t("radiology.hod.rooms")} head={[t("radiology.hod.col.room"), t("radiology.hod.col.state"), t("radiology.hod.col.queue"), t("radiology.hod.col.onTable"), t("radiology.hod.col.nextFree"), t("radiology.hod.col.tech")]}>
            {f.rooms.map((r) => (
              <tr key={r.deviceId} className={`border-b ${r.status === "down" || r.status === "qa_blocked" ? "bg-red-50" : r.licensedNow === false ? "bg-amber-50" : ""}`}
                data-down={r.status === "down" || r.status === "qa_blocked" ? r.code : undefined}>
                <td className="p-1"><b>{r.code}</b><span className="block text-xs text-muted-foreground">{r.room ?? r.name}</span></td>
                <td className="p-1">{t(`radiology.setup.status.${r.status}`, { defaultValue: r.status })}{r.licensedNow === false ? <span className="block text-xs text-red-700">{t("radiology.hod.noLicence")}</span> : null}</td>
                <td className="mo p-1 text-right">{r.queue}</td>
                <td className="mo p-1">{r.onTable ?? "—"}</td>
                <td className="mo p-1">{r.nextFreeAt === null ? t("radiology.hod.outOfService") : fmtIst(r.nextFreeAt)}</td>
                <td className="p-1 text-xs text-muted-foreground">{t("radiology.hod.rosterSaysNot")}</td>
              </tr>
            ))}
          </Table>
        </Card>
        <div className="grid content-start gap-3">
          <Card title={t("radiology.hod.readers")} testId="hod-readers">
            <p className="m-0 text-sm">{t("radiology.hod.readersLine", { toRead: f.readers.toRead, stat: f.readers.stat, drafted: f.readers.drafted, unclaimed: f.readers.unclaimed })}</p>
            <ul className="m-0 mt-1 list-none p-0 text-sm">
              {f.readers.claimed.map((c) => <li key={c.userId}>{t("radiology.hod.reading", { name: c.name, count: c.studies })}</li>)}
              {f.readers.claimed.length === 0 && <li className="text-muted-foreground">{t("radiology.hod.nobodyReading")}</li>}
            </ul>
          </Card>
          <Card title={t("radiology.hod.turnaround", { from: f.turnaround.from, to: f.turnaround.to })} testId="hod-tat">
            {f.turnaround.rows.length === 0 ? <p className="m-0 text-sm text-muted-foreground">{t("radiology.hod.noOrders")}</p> : (
              <Table label={t("radiology.hod.turnaroundLabel")} head={[t("radiology.hod.col.modality"), t("radiology.hod.col.source"), "n", t("radiology.hod.col.median"), "P90", t("radiology.hod.col.target")]}>
                {f.turnaround.rows.map((r) => (
                  <tr key={`${r.modality}|${r.source}`} className={`border-b ${r.withinTarget === false ? "bg-red-50" : ""}`}>
                    <td className="p-1">{t(`radiology.setup.modality.${r.modality}`, { defaultValue: r.modality })}</td>
                    <td className="p-1">{r.source}</td>
                    <td className="mo p-1 text-right">{r.n}</td>
                    <td className="mo p-1">{mins(r.medianMin)}</td>
                    <td className="mo p-1">{mins(r.p90Min)}</td>
                    <td className="mo p-1">{mins(r.targetMin)}{r.withinTarget === null ? "" : r.withinTarget ? " ✓" : " ✗"}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      </div>

      {(f.licenceGaps.length > 0 || f.qaOverdue.length > 0) && (
        <Card title={t("radiology.hod.gaps")} testId="hod-gaps">
          <ul className="m-0 list-none space-y-1 p-0 text-sm">
            {f.licenceGaps.map((g) => <li key={g.deviceId} data-gap={g.code}>{t("radiology.hod.gapLine", { code: g.code, name: g.name, count: g.booked })}</li>)}
            {f.qaOverdue.map((q) => <li key={`${q.deviceCode}-${q.qaType}`}>{t("radiology.hod.qaLine", { code: q.deviceCode, type: q.qaType, due: q.dueOn })}</li>)}
          </ul>
          <div className="mt-2"><SeatLink to="/radiology/radiation-safety">{t("radiology.hod.openSafety")}</SeatLink></div>
        </Card>
      )}

      <FivePriorities rows={[
        [t("radiology.hod.five.accuracy"), t("radiology.hod.five.floor.accuracy"), t("radiology.hod.five.floor.accuracyFails")],
        [t("radiology.hod.five.speed"), t("radiology.hod.five.floor.speed"), t("radiology.hod.five.floor.speedFails")],
        [t("radiology.hod.five.auditable"), t("radiology.hod.five.floor.auditable"), t("radiology.hod.five.floor.auditableFails")],
        [t("radiology.hod.five.compliant"), t("radiology.hod.five.floor.compliant"), t("radiology.hod.five.floor.compliantFails")],
        [t("radiology.hod.five.ux"), t("radiology.hod.five.floor.ux"), t("radiology.hod.five.floor.uxFails")],
      ]} />
    </>
  );
}

/* ═══════════════════════════════ Escalated ═══════════════════════════════ */

function EscalationsView({ item }: { item: string | null }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const views = useHeaderViews("escalations");
  const q = useEscalations();
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const [sel, setSel] = useState<string | null>(item);
  useEffect(() => { if (item !== null) setSel(item); }, [item]);
  const inHand = rows.find((e) => keyOf(e) === sel) ?? null;
  const roster = useQuery({ queryKey: ["radiology", "hod", "roster"], queryFn: fetchHodRoster, enabled: inHand !== null });
  const people = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of roster.data?.roles ?? []) for (const p of r.people) seen.set(p.userId, p.name);
    return [...seen.entries()].map(([userId, name]) => ({ userId, name }));
  }, [roster.data]);
  const [until, setUntil] = useState(60);
  const [to, setTo] = useState("");
  const [error, setError] = useState<{ code: string | null; message: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const ack = useMutation({
    mutationFn: (v: { kind: "seen" | "owned" | "handed_over" }) => acknowledgeAlert(inHand!.myAlert!.alertId, {
      kind: v.kind,
      ...(v.kind === "owned" ? { untilMinutes: until } : {}),
      ...(v.kind === "handed_over" ? { handedToUserId: to } : {}),
    }, newIdempotencyKey()),
    onSuccess: (r) => {
      setError(null); setDone(t(`radiology.hod.acked.${r.kind}`));
      void qc.invalidateQueries({ queryKey: ["radiology", "hod", "escalations"] });
    },
    onError: (e) => setError({ code: radiologyErrorCode(e), message: radiologyErrorText(e) }),
  });

  const router = useRouter({ warn: false });
  const dockRun = useRef<(() => void) | null>(null);
  dockRun.current = inHand === null ? null : () => {
    if (router === undefined) { window.location.assign(inHand.seat); return; }
    void router.navigate({ to: inHand.seat });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag)) return;
      if (e.key === "Enter" && dockRun.current !== null) { e.preventDefault(); dockRun.current(); }
      if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const list = (
    <section aria-label={t("radiology.hod.escalatedRedFirst")}>
      <h2 className="tag m-0 mb-2">{t("radiology.hod.escalatedRedFirst")} · {rows.length}</h2>
      {q.isSuccess && rows.length === 0 && <p className="text-sm text-muted-foreground">{t("radiology.hod.nothingEscalated")}</p>}
      <ul className="m-0 list-none space-y-1 p-0">
        {rows.map((e) => <EscalationRow key={keyOf(e)} e={e} selected={keyOf(e) === sel} onOpen={() => { setSel(keyOf(e)); setDone(null); setError(null); }} />)}
      </ul>
    </section>
  );

  const lane = inHand === null ? undefined : (
    <div className="mt-4 space-y-1 border-t pt-3 text-sm" data-acc={inHand.accessionNo ?? undefined}>
      <b className="block">{t(`radiology.hod.cause.${inHand.cause}`)}</b>
      {inHand.accessionNo !== null && <span className="mo block text-xs">{inHand.accessionNo} · {inHand.studyTypeCode}</span>}
      {inHand.deviceCode !== null && <span className="mo block text-xs">{inHand.deviceCode}</span>}
      <span className="block text-xs">{t("radiology.hod.since", { at: fmtIst(inHand.since), wait: mins(inHand.ageMin) })}</span>
      <span className="block text-xs text-muted-foreground">
        {inHand.raisedAt === null ? t("radiology.hod.notRaisedYet") : t("radiology.hod.raisedAt", { at: fmtIst(inHand.raisedAt) })}
      </span>
    </div>
  );

  const a = inHand?.myAlert ?? null;
  const centre = inHand === null ? (
    <div className="space-y-2">
      <p className="m-0 text-sm">{t("radiology.hod.escIntro")}</p>
      <Loading q={q} />
      {(q.data?.notActive.length ?? 0) > 0 && (
        <Refusal warn code="escalation_not_active" message={t("radiology.hod.notActive", { causes: q.data!.notActive.map((c) => t(`radiology.hod.cause.${c}`)).join(", ") })} />
      )}
    </div>
  ) : (
    <section className="space-y-3" data-testid="hod-escalation">
      <div className="rounded border bg-card p-3 text-sm">
        <h2 className="m-0 text-base font-semibold">{t(`radiology.hod.cause.${inHand.cause}`)}</h2>
        <p className="m-0 mt-1">{inHand.detail}</p>
        <p className="m-0 mt-1 text-xs text-muted-foreground">{t("radiology.hod.closesAt", { seat: t(`radiology.hod.seat.${inHand.cause}`) })}</p>
      </div>
      <div className="rounded border bg-card p-3 text-sm space-y-2" data-testid="hod-acts">
        <h3 className="tag m-0">{t("radiology.hod.acts")}</h3>
        {a === null ? <p className="m-0 text-muted-foreground">{t("radiology.hod.notYours")}</p> : (
          <>
            {a.ackKind !== null && <p className="m-0" role="status">{t(`radiology.hod.state.${a.ackKind}`, { until: a.ownedUntil === null ? "" : fmtIst(a.ownedUntil) })}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="rounded border px-3 py-1" onClick={() => ack.mutate({ kind: "seen" })} disabled={ack.isPending}>{t("radiology.hod.act.seen")}</button>
              <label className="flex items-center gap-1 text-xs">{t("radiology.hod.act.for")}
                <select className="rounded border px-1 py-1" value={until} onChange={(e) => setUntil(Number(e.target.value))}>
                  {[15, 30, 60, 120, 240].map((m) => <option key={m} value={m}>{mins(m)}</option>)}
                </select>
              </label>
              <button type="button" className="rounded border px-3 py-1" onClick={() => ack.mutate({ kind: "owned" })} disabled={ack.isPending}>{t("radiology.hod.act.owned")}</button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex min-w-0 items-center gap-1 text-xs">{t("radiology.hod.act.to")}
                <select className="min-w-0 max-w-[14rem] rounded border px-1 py-1" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t("radiology.hod.act.to")}>
                  <option value="">—</option>
                  {people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
                </select>
              </label>
              <button type="button" className="rounded border px-3 py-1" disabled={to === "" || ack.isPending} onClick={() => ack.mutate({ kind: "handed_over" })}>{t("radiology.hod.act.handedOver")}</button>
            </div>
            <p className="m-0 text-xs text-muted-foreground">{t("radiology.hod.actsRule")}</p>
          </>
        )}
      </div>
      {done !== null && <p role="status" className="rounded border border-green-300 bg-green-50 p-2 text-sm">{done}</p>}
      {error !== null && <Refusal code={error.code} message={error.message} />}
      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 rounded border bg-card p-3 shadow-sm" data-testid="hod-dock">
        <span className="min-w-0 basis-full text-xs text-muted-foreground sm:flex-1 sm:basis-auto">{t("radiology.hod.dockHint")}</span>
        <button type="button" className="px-2 text-sm underline" onClick={() => setSel(null)}>{t("radiology.hod.back")}</button>
        <button type="button" data-testid="dock-act" className="rounded bg-green-800 px-4 py-2 text-sm font-semibold text-white" onClick={() => dockRun.current?.()}>
          {t(`radiology.hod.doIt.${inHand.cause}`)} <span className="kb">Enter</span>
        </button>
      </div>
    </section>
  );

  return (
    <RadiologyStation
      station="hod" views={views} title={t("radiology.hod.title")} place={t("radiology.hod.views.escalations")}
      stats={[
        { label: t("radiology.hod.stat.open"), value: rows.length },
        { label: t("radiology.hod.stat.red"), value: rows.filter((e) => RED_CAUSES.has(e.cause)).length, tone: "danger" },
        { label: t("radiology.hod.stat.unanswered"), value: rows.filter((e) => e.myAlert !== null && e.myAlert.ackKind === null).length, tone: "waiting" },
      ]}
      lane={lane} list={list} inHand={inHand !== null} closeListOn={sel}
    >
      {centre}
    </RadiologyStation>
  );
}

/* ═══════════════════════════════ Approvals ═══════════════════════════════ */

function ApprovalsView(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { can } = useAuth();
  const views = useHeaderViews("approvals");
  const q = useQuery({ queryKey: ["radiology", "hod", "approvals"], queryFn: fetchHodApprovals, refetchInterval: 30_000 });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const [sel, setSel] = useState<string | null>(null);
  const inHand: WireApproval | null = rows.find((r) => r.approvalId === sel) ?? null;
  const [reason, setReason] = useState("");
  const [error, setError] = useState<{ code: string | null; message: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const mayDecide = inHand !== null && inHand.typeKey === "imaging_gate_override" && can("radiology.gates.override");

  const decide = useMutation({
    mutationFn: (verdict: "grant" | "refuse") => decideOverrideRequest(inHand!.approvalId, verdict, reason.trim()),
    onSuccess: (r) => {
      setDone(r.verdict === "granted" ? t("radiology.hod.granted") : t("radiology.hod.refused"));
      setError(null); setSel(null); setReason("");
      void qc.invalidateQueries({ queryKey: ["radiology", "hod"] });
    },
    onError: (e) => setError({ code: radiologyErrorCode(e), message: radiologyErrorText(e) }),
  });
  const ready = mayDecide && reason.trim().length > 0 && !decide.isPending;
  const dockRun = useRef<(() => void) | null>(null);
  dockRun.current = ready ? () => decide.mutate("grant") : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag)) return;
      if (e.key === "Enter" && dockRun.current !== null) { e.preventDefault(); dockRun.current(); }
      if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const list = (
    <section aria-label={t("radiology.hod.waitingOnYou")}>
      <h2 className="tag m-0 mb-2">{t("radiology.hod.waitingOnYou")} · {rows.length}</h2>
      {q.isSuccess && rows.length === 0 && <p className="text-sm text-muted-foreground">{t("radiology.hod.nothingWaiting")}</p>}
      <ul className="m-0 list-none space-y-1 p-0">
        {rows.map((r) => (
          <li key={r.approvalId} data-approval={r.approvalId}>
            <button type="button" onClick={() => { setSel(r.approvalId); setError(null); setDone(null); }}
              className={`w-full rounded border p-2 text-left text-sm ${r.approvalId === sel ? "outline outline-2 outline-black" : ""} ${r.urgencyClass === "urgent" ? "border-amber-300 bg-amber-50" : "bg-card"}`}>
              <b className="block">{t(`radiology.hod.approvalType.${r.typeKey}`, { defaultValue: r.typeKey })}</b>
              <span className="block truncate text-xs text-muted-foreground">{r.subject} · {mins(r.ageMin)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );

  const bills = q.data?.billDecisions ?? [];
  return (
    <RadiologyStation
      station="hod" views={views} title={t("radiology.hod.title")} place={t("radiology.hod.views.approvals")}
      stats={[
        { label: t("radiology.hod.stat.approvals"), value: rows.length, tone: rows.length > 0 ? "waiting" : "plain" },
        { label: t("radiology.hod.stat.bills"), value: bills.length },
      ]}
      list={list} inHand={inHand !== null} closeListOn={sel}
      lane={inHand === null ? undefined : (
        <div className="mt-4 space-y-1 border-t pt-3 text-sm">
          <b className="block">{t(`radiology.hod.approvalType.${inHand.typeKey}`, { defaultValue: inHand.typeKey })}</b>
          <span className="block text-xs">{inHand.subject}</span>
          <span className="block text-xs">{t("radiology.hod.askedBy", { who: inHand.requesterName ?? "—", at: fmtIst(inHand.requestedAt) })}</span>
        </div>
      )}
    >
      <div className="space-y-3" data-testid="hod-approvals">
        <Loading q={q} />
        {done !== null && <p role="status" className="rounded border border-green-300 bg-green-50 p-2 text-sm">{done}</p>}
        {inHand !== null && (
          <section className="space-y-2 rounded border bg-card p-3 text-sm" data-testid="hod-approval">
            <h2 className="m-0 text-base font-semibold">{inHand.subject}</h2>
            <p className="m-0">{t("radiology.hod.theyWrote")} <q>{inHand.note ?? "—"}</q></p>
            {mayDecide ? (
              <>
                <label className="block text-xs" htmlFor="hod-reason">{t("radiology.hod.reason")}</label>
                <textarea id="hod-reason" className="w-full rounded border p-2" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
                <button type="button" className="rounded border px-3 py-1" disabled={reason.trim() === "" || decide.isPending} onClick={() => decide.mutate("refuse")}>{t("radiology.hod.refuse")}</button>
              </>
            ) : (
              <p className="m-0">{t("radiology.hod.decideElsewhere", { role: inHand.approverRole })} <SeatLink to={`/approvals?focus=${inHand.approvalId}`}>{t("radiology.hod.openInbox")}</SeatLink></p>
            )}
            {error !== null && <Refusal code={error.code} message={error.message} />}
            {mayDecide && (
              <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 rounded border bg-card p-3 shadow-sm" data-testid="hod-approval-dock">
                <span className="min-w-0 basis-full text-xs text-muted-foreground sm:flex-1 sm:basis-auto">{t("radiology.hod.grantHint")}</span>
                <button type="button" data-testid="dock-act" className="rounded bg-green-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={!ready} onClick={() => dockRun.current?.()}>
                  {t("radiology.hod.grant")} <span className="kb">Enter</span>
                </button>
              </div>
            )}
          </section>
        )}
        <Card title={t("radiology.hod.billDecisions")} testId="hod-bills">
          {bills.length === 0 ? <p className="m-0 text-sm text-muted-foreground">{t("radiology.hod.noBills")}</p> : (
            <Table label={t("radiology.hod.billDecisions")} head={[t("radiology.hod.col.decision"), t("radiology.hod.col.study"), t("radiology.hod.col.listPrice"), t("radiology.hod.col.age")]}>
              {bills.map((b) => (
                <tr key={b.billDecisionId} className={`border-b ${b.ageMin > 1440 ? "bg-amber-50" : ""}`} data-bill={b.billDecisionId}>
                  <td className="p-1">{t(`radiology.hod.bill.${b.kind}`, { defaultValue: b.kind })}</td>
                  <td className="mo p-1">{b.accessionNo}</td>
                  <td className="mo p-1 text-right">{b.listPricePaise === null ? "—" : fmtRupees(b.listPricePaise)}</td>
                  <td className="mo p-1">{mins(b.ageMin)}</td>
                </tr>
              ))}
            </Table>
          )}
          <p className="m-0 mt-2 text-xs text-muted-foreground">{t("radiology.hod.billsRule")} <SeatLink to="/radiology/room?view=rejects">{t("radiology.hod.openRejects")}</SeatLink></p>
        </Card>
        <p className="m-0 rounded border border-dashed p-2 text-xs text-muted-foreground" data-testid="hod-discount-note">{t("radiology.hod.discountNote")}</p>
      </div>
    </RadiologyStation>
  );
}

/* ═══════════════════════════════ Quality ═══════════════════════════════ */

function fmtIndicator(v: number | null, unit: "%" | "min"): string {
  if (v === null) return "—";
  return unit === "%" ? `${String(v)} %` : mins(v);
}

function QualityView(): React.ReactElement {
  const { t } = useTranslation();
  const views = useHeaderViews("quality");
  const q = useQuery({ queryKey: ["radiology", "hod", "quality"], queryFn: fetchHodQuality });
  const d: WireQuality | undefined = q.data;
  const tone = (s: string): string => (s === "ok" ? "bg-green-50" : s === "out" ? "bg-red-50" : "bg-muted/40");
  return (
    <RadiologyStation
      station="hod" views={views} title={t("radiology.hod.title")} place={t("radiology.hod.views.quality")}
      stats={d === undefined ? [] : [
        { label: t("radiology.hod.stat.inTarget"), value: d.indicators.filter((i) => i.status === "ok").length, tone: "live" },
        { label: t("radiology.hod.stat.outTarget"), value: d.indicators.filter((i) => i.status === "out").length, tone: "danger" },
        { label: t("radiology.hod.stat.notMeasured"), value: d.indicators.filter((i) => i.status === "not_measured").length },
      ]}
    >
      <div className="space-y-3" data-testid="hod-quality">
        <p className="m-0 text-sm">{t("radiology.hod.qualityIntro")}</p>
        <Loading q={q} />
        {d !== undefined && (
          <Card title={t("radiology.hod.qualityWeek", { from: d.from, to: d.to })}>
            <Table label={t("radiology.hod.views.quality")} head={[t("radiology.hod.col.indicator"), t("radiology.hod.col.value"), t("radiology.hod.col.target"), ...(d.indicators[0]?.days.map((x) => x.day.slice(5)) ?? [])]}>
              {d.indicators.map((i) => (
                <tr key={i.key} className="border-b align-top" data-indicator={i.key} data-status={i.status}>
                  <td className="p-1"><b>{t(`radiology.hod.qi.${i.key}`)}</b><span className="block text-xs text-muted-foreground">{i.note}</span></td>
                  <td className={`mo p-1 ${tone(i.status)}`}>{i.status === "not_measured" ? t("radiology.hod.notMeasured") : fmtIndicator(i.value, i.unit)}
                    {i.denominator !== null && i.numerator !== null ? <span className="block text-xs text-muted-foreground">{i.numerator}/{i.denominator}</span> : null}</td>
                  <td className="mo p-1 whitespace-nowrap">{i.comparator} {fmtIndicator(i.target, i.unit)}</td>
                  {i.days.map((x) => <td key={x.day} className={`mo p-1 text-xs ${tone(x.status)}`} title={`${x.day}`}>{fmtIndicator(x.value, i.unit)}</td>)}
                </tr>
              ))}
            </Table>
          </Card>
        )}
        <FivePriorities rows={[
          [t("radiology.hod.five.accuracy"), t("radiology.hod.five.quality.accuracy"), t("radiology.hod.five.quality.accuracyFails")],
          [t("radiology.hod.five.speed"), t("radiology.hod.five.quality.speed"), t("radiology.hod.five.quality.speedFails")],
          [t("radiology.hod.five.auditable"), t("radiology.hod.five.quality.auditable"), t("radiology.hod.five.quality.auditableFails")],
          [t("radiology.hod.five.compliant"), t("radiology.hod.five.quality.compliant"), t("radiology.hod.five.quality.compliantFails")],
          [t("radiology.hod.five.ux"), t("radiology.hod.five.quality.ux"), "—"],
        ]} />
      </div>
    </RadiologyStation>
  );
}

/* ═══════════════════════════════ Equipment ═══════════════════════════════ */

function EquipmentView(): React.ReactElement {
  const { t } = useTranslation();
  const views = useHeaderViews("equipment");
  const q = useQuery({ queryKey: ["radiology", "hod", "equipment"], queryFn: fetchHodEquipment, refetchInterval: 60_000 });
  const d = q.data;
  const out = (d?.machines ?? []).filter((m) => ["down", "qa_blocked", "maintenance"].includes(m.status));
  const list = (
    <section aria-label={t("radiology.hod.outNow")}>
      <h2 className="tag m-0 mb-2">{t("radiology.hod.outNow")} · {out.length}</h2>
      {q.isSuccess && out.length === 0 && <p className="text-sm text-muted-foreground">{t("radiology.hod.allInService")}</p>}
      <ul className="m-0 list-none space-y-1 p-0">
        {out.map((m) => (
          <li key={m.deviceId} data-down={m.code} className="rounded border border-red-300 bg-red-50 p-2 text-sm">
            <b className="block">{m.code} · {m.name}</b>
            <span className="block text-xs">{t(`radiology.setup.status.${m.status}`, { defaultValue: m.status })}{m.lastChange?.reason ? ` — ${m.lastChange.reason}` : ""}</span>
            <SeatLink to="/radiology/room?view=downtime">{t("radiology.hod.openDowntime")}</SeatLink>
          </li>
        ))}
      </ul>
    </section>
  );
  return (
    <RadiologyStation station="hod" views={views} title={t("radiology.hod.title")} place={t("radiology.hod.views.equipment")}
      stats={d === undefined ? [] : [
        { label: t("radiology.hod.stat.machines"), value: d.machines.length },
        { label: t("radiology.hod.stat.out"), value: out.length, tone: out.length > 0 ? "danger" : "plain" },
        { label: t("radiology.hod.stat.qaDue"), value: d.qa.length, tone: d.qa.length > 0 ? "waiting" : "plain" },
      ]}
      list={list}
    >
      <div className="space-y-3" data-testid="hod-equipment">
        <Loading q={q} />
        {d !== undefined && (
          <>
            <Card title={t("radiology.hod.machines")}>
              <Table label={t("radiology.hod.machines")} head={[t("radiology.hod.col.machine"), t("radiology.hod.col.state"), t("radiology.hod.col.uptime"), t("radiology.hod.col.licence"), t("radiology.hod.col.queue"), t("radiology.hod.col.lastChange")]}>
                {d.machines.map((m) => (
                  <tr key={m.deviceId} className="border-b align-top">
                    <td className="p-1"><b>{m.code}</b><span className="block text-xs text-muted-foreground">{m.name}{m.room ? ` · ${m.room}` : ""}</span></td>
                    <td className="p-1">{t(`radiology.setup.status.${m.status}`, { defaultValue: m.status })}</td>
                    <td className="mo p-1">{m.uptimePct === null ? t("radiology.hod.notMeasured") : `${String(m.uptimePct)} %`}</td>
                    <td className="p-1">{m.licensedNow === null ? "—" : m.licensedNow ? t("radiology.hod.licensed") : <span className="text-red-700">{t("radiology.hod.noLicence")}</span>}</td>
                    <td className="mo p-1 text-right">{m.queue}</td>
                    <td className="p-1 text-xs">{m.lastChange === null ? "—" : `${t(`radiology.setup.status.${m.lastChange.to}`, { defaultValue: m.lastChange.to })} · ${fmtIst(m.lastChange.at)}${m.lastChange.reason ? ` · ${m.lastChange.reason}` : ""}`}</td>
                  </tr>
                ))}
              </Table>
              <p className="m-0 mt-2 text-xs text-muted-foreground">{t("radiology.hod.uptimeRule")}</p>
            </Card>
            <Card title={t("radiology.hod.qaDue")}>
              {d.qa.length === 0 ? <p className="m-0 text-sm text-muted-foreground">{t("radiology.hod.qaNone")}</p> : (
                <ul className="m-0 list-none space-y-1 p-0 text-sm">
                  {d.qa.map((x) => <li key={`${x.deviceCode}-${x.qaType}`} className={x.state === "overdue" || x.state === "failed" ? "text-red-800" : ""}>{t("radiology.hod.qaLine", { code: x.deviceCode, type: x.qaType, due: x.dueOn })}</li>)}
                </ul>
              )}
              <p className="m-0 mt-2 text-xs">{t("radiology.hod.rsoCounts", { red: d.radiationSafety.red, amber: d.radiationSafety.amber })} <SeatLink to="/radiology/radiation-safety">{t("radiology.hod.openSafety")}</SeatLink></p>
            </Card>
            <p className="m-0 rounded border border-dashed p-2 text-xs text-muted-foreground" data-testid="hod-tickets">{t("radiology.hod.ticketsNote")}</p>
          </>
        )}
      </div>
    </RadiologyStation>
  );
}

/* ═══════════════════════════════ Roster ═══════════════════════════════ */

function RosterView(): React.ReactElement {
  const { t } = useTranslation();
  const views = useHeaderViews("roster");
  const q = useQuery({ queryKey: ["radiology", "hod", "roster"], queryFn: fetchHodRoster });
  const d = q.data;
  return (
    <RadiologyStation station="hod" views={views} title={t("radiology.hod.title")} place={t("radiology.hod.views.roster")}
      stats={d === undefined ? [] : [
        { label: t("radiology.hod.stat.source"), value: t(`radiology.hod.source.${d.source}`, { defaultValue: d.source }) },
        { label: t("radiology.hod.stat.onCall"), value: d.positions.reduce((n, p) => n + p.people.length, 0) },
      ]}
    >
      <div className="space-y-3" data-testid="hod-roster">
        <Loading q={q} />
        {d !== undefined && (
          <>
            <Card title={t("radiology.hod.onDuty", { dept: d.department?.name ?? "—" })}>
              {d.positions.length === 0 ? <p className="m-0 text-sm text-muted-foreground">{d.resolverEnabled ? t("radiology.hod.noPublished") : t("radiology.hod.resolverOff")}</p> : (
                <ul className="m-0 list-none space-y-1 p-0 text-sm">
                  {d.positions.map((p) => <li key={p.positionKey}><b>{t(`radiology.hod.position.${p.positionKey}`, { defaultValue: p.positionKey })}</b>: {p.people.map((x) => x.name).join(", ") || "—"}</li>)}
                </ul>
              )}
            </Card>
            <Card title={t("radiology.hod.holders")}>
              <ul className="m-0 list-none space-y-1 p-0 text-sm">
                {d.roles.map((r) => <li key={r.roleKey}><b>{t(`radiology.hod.role.${r.roleKey}`, { defaultValue: r.roleKey })}</b> · {r.people.length === 0 ? t("radiology.hod.nobody") : r.people.map((x) => x.name).join(", ")}</li>)}
              </ul>
              <p className="m-0 mt-2 text-xs text-muted-foreground">{t("radiology.hod.rosterNote")}</p>
            </Card>
          </>
        )}
      </div>
    </RadiologyStation>
  );
}

/* ═══════════════════════════════ Money ═══════════════════════════════ */

function MoneyView(): React.ReactElement {
  const { t } = useTranslation();
  const views = useHeaderViews("money");
  const q = useQuery({ queryKey: ["radiology", "hod", "money"], queryFn: fetchHodMoney, refetchInterval: 60_000 });
  const d = q.data;
  return (
    <RadiologyStation station="hod" views={views} title={t("radiology.hod.title")} place={t("radiology.hod.views.money")}
      stats={d === undefined ? [] : [
        { label: t("radiology.hod.stat.billedToday"), value: fmtRupees(d.billedTotal.netPaise), tone: "live" },
        { label: t("radiology.hod.stat.leakage"), value: fmtRupees(d.leakagePaise), tone: d.leakagePaise > 0 ? "waiting" : "plain" },
      ]}
    >
      <div className="space-y-3" data-testid="hod-money">
        <Loading q={q} />
        {d !== undefined && (
          <>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Tile label={t("radiology.hod.tile.billedToday")} value={fmtRupees(d.billedTotal.netPaise)} sub={t("radiology.hod.studiesN", { count: d.billedTotal.studies })} />
              <Tile label={t("radiology.hod.tile.mtd")} value={fmtRupees(d.monthToDate.reduce((n, m) => n + m.netPaise, 0))} sub={t("radiology.hod.studiesN", { count: d.monthToDate.reduce((n, m) => n + m.studies, 0) })} />
              <Tile label={t("radiology.hod.tile.leakage")} value={fmtRupees(d.leakagePaise)} tone={d.leakagePaise > 0 ? "warn" : "ok"} sub={t("radiology.hod.leakageAtList")} />
              <Tile label={t("radiology.hod.tile.decisions")} value={d.billDecisions.length} tone={d.billDecisions.some((b) => b.ageMin > 1440) ? "warn" : "plain"} />
            </div>
            <Card title={t("radiology.hod.billedBy", { day: d.day })}>
              {d.billed.length === 0 ? <p className="m-0 text-sm text-muted-foreground">{t("radiology.hod.nothingBilled")}</p> : (
                <Table label={t("radiology.hod.billedBy", { day: d.day })} head={[t("radiology.hod.col.modality"), t("radiology.hod.col.source"), t("radiology.hod.col.studies"), "₹"]}>
                  {d.billed.map((b) => (
                    <tr key={`${b.modality}|${b.source}`} className="border-b">
                      <td className="p-1">{t(`radiology.setup.modality.${b.modality}`, { defaultValue: b.modality })}</td><td className="p-1">{b.source}</td>
                      <td className="mo p-1 text-right">{b.studies}</td><td className="mo p-1 text-right">{fmtRupees(b.netPaise)}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
            <Card title={t("radiology.hod.mtdBy")}>
              <ul className="m-0 list-none space-y-1 p-0 text-sm">
                {d.monthToDate.map((m) => <li key={m.modality} className="flex justify-between gap-2"><span>{t(`radiology.setup.modality.${m.modality}`, { defaultValue: m.modality })} · {m.studies}</span><span className="mo">{fmtRupees(m.netPaise)}</span></li>)}
                {d.monthToDate.length === 0 && <li className="text-muted-foreground">{t("radiology.hod.nothingBilled")}</li>}
              </ul>
            </Card>
            <p className="m-0 text-xs text-muted-foreground">{t("radiology.hod.moneyRule")}</p>
          </>
        )}
      </div>
    </RadiologyStation>
  );
}

/* ═══════════════════════════════ Access log ═══════════════════════════════ */

function AuditView(): React.ReactElement {
  const { t } = useTranslation();
  const views = useHeaderViews("audit");
  const [day, setDay] = useState<string>("");
  const q = useQuery({ queryKey: ["radiology", "hod", "audit", day], queryFn: () => fetchHodAccessLog(day || undefined, day || undefined) });
  const d = q.data;
  const bg = (d?.rows ?? []).filter((r) => r.breakGlass);
  const list = (
    <section aria-label={t("radiology.hod.breakGlass")}>
      <h2 className="tag m-0 mb-2">{t("radiology.hod.breakGlass")} · {bg.length}</h2>
      {q.isSuccess && bg.length === 0 && <p className="text-sm text-muted-foreground">{t("radiology.hod.noBreakGlass")}</p>}
      <ul className="m-0 list-none space-y-1 p-0">
        {bg.map((r) => (
          <li key={`${r.at}-${r.who}-${r.what}`} className="rounded border border-red-300 bg-red-50 p-2 text-sm" data-alog={r.at}>
            <b className="block">{r.whoName}</b>
            <span className="block text-xs">{fmtIst(r.at)} · {r.patientName} · {r.what}</span>
          </li>
        ))}
      </ul>
    </section>
  );
  return (
    <RadiologyStation station="hod" views={views} title={t("radiology.hod.title")} place={t("radiology.hod.views.audit")}
      stats={d === undefined ? [] : [
        { label: t("radiology.hod.stat.openings"), value: d.counts.openings },
        { label: t("radiology.hod.stat.breakGlass"), value: d.counts.breakGlass, tone: d.counts.breakGlass > 0 ? "danger" : "plain" },
        { label: t("radiology.hod.stat.noContext"), value: d.counts.noCareContext, tone: d.counts.noCareContext > 0 ? "waiting" : "plain" },
      ]}
      list={list}
    >
      <div className="space-y-3" data-testid="hod-audit">
        <p className="m-0 text-sm">{t("radiology.hod.auditIntro")}</p>
        <label className="flex items-center gap-2 text-sm">{t("radiology.hod.day")}
          <input type="date" className="rounded border px-2 py-1" value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
        <Loading q={q} />
        {d !== undefined && (
          <Card title={t("radiology.hod.whoOpened", { count: d.rows.length })}>
            {d.rows.length === 0 ? <p className="m-0 text-sm text-muted-foreground">{t("radiology.hod.noOpenings")}</p> : (
              <Table label={t("radiology.hod.whoOpenedLabel")} head={[t("radiology.hod.col.time"), t("radiology.hod.col.who"), t("radiology.hod.col.patient"), t("radiology.hod.col.opened"), t("radiology.hod.col.why")]}>
                {d.rows.map((r, i) => (
                  <tr key={`${r.at}-${String(i)}`} className={`border-b align-top ${r.breakGlass ? "bg-red-50" : r.context === "none" ? "bg-amber-50" : ""}`} data-alog={r.at}>
                    <td className="mo p-1 whitespace-nowrap">{fmtIst(r.at)}</td>
                    <td className="p-1">{r.whoName}<span className="block text-xs text-muted-foreground">{r.roles.join(", ") || "—"}</span></td>
                    <td className="p-1">{r.patientName}<span className="mo block text-xs text-muted-foreground">{r.patientUhid}</span></td>
                    <td className="p-1">{r.kind === "images" ? t("radiology.hod.images") : r.what}{r.accessionNo ? <span className="mo block text-xs">{r.accessionNo}</span> : null}</td>
                    <td className="p-1 text-xs">
                      {r.breakGlass && <b className="block text-red-700">{t("radiology.hod.breakGlassWord")}</b>}
                      {r.context !== null ? t(`radiology.hod.context.${r.context}`, { defaultValue: r.context }) : "—"}
                      {r.sealed ? ` · ${t("radiology.hod.sealed")}` : ""}{r.reason ? ` · ${r.reason}` : ""}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
            {d.truncated && <p className="m-0 mt-2 text-xs">{t("radiology.hod.truncated")}</p>}
          </Card>
        )}
      </div>
    </RadiologyStation>
  );
}
