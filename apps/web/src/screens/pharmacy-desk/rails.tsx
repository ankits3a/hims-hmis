import { useQuery } from "@tanstack/react-query";
import { fetchPatientRail } from "../../lib/pharmacy-api";
import { useTranslation } from "react-i18next";
import { FLOW_STEPS, flowIndex, holdOf, initialsOf, queuedDay, shelfFlag, stageOf, ticketLabel, waitLabel, waitTone, whoLabel } from "./model";
import type { WaitTone } from "./model";
import type { WireCounterSummary, WireDispense, WireQueueRow } from "../../lib/pharmacy-api";

const TONE: Record<WaitTone, string> = { calm: "var(--dim)", warm: "var(--gold)", late: "var(--red)" };
const rupees = (paise: number): string => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

/**
 * THE LEFT RAIL — nobody in hand: the pharmacist's day and the keys this desk binds; somebody in
 * hand: who they are, what they are allergic to, and how far the ticket has come. PD-D5: the
 * pharmacy's left rail is the PATIENT, because the right rail becomes the bill.
 */
export function Dossier({
  inHand, me, summary, queued, onClear, paletteBound,
}: {
  inHand: WireDispense | null;
  me: string | null;
  summary: WireCounterSummary | null;
  queued: number;
  onClear: () => void;
  paletteBound: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  /* Who is at the window — one read when the ticket opens, never polled: it records a PHI access. */
  const rail = useQuery({
    queryKey: ["pharmacy", "patient-rail", inHand?.id ?? ""],
    queryFn: () => fetchPatientRail(inHand!.id),
    enabled: inHand !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (inHand === null) {
    const day = summary === null ? [] : [
      { label: t("pharmacyDesk.day.handedOver"), value: String(summary.handedOver) },
      { label: t("pharmacyDesk.day.money"), value: rupees(summary.billedPaise) },
      { label: t("pharmacyDesk.day.declined"), value: String(summary.declinedLines) },
      { label: t("pharmacyDesk.day.inLine"), value: String(queued) },
    ];
    const keys = [
      { k: "Q", what: t("pharmacyDesk.keys.q") },
      ...(paletteBound ? [{ k: "F8", what: t("pharmacyDesk.keys.f8") }] : []),
      { k: "⏎", what: t("pharmacyDesk.keys.enter") },
      { k: "Esc", what: t("pharmacyDesk.keys.esc") },
    ];
    return (
      <aside className="rail" data-testid="desk-dossier" style={{ padding: "20px 18px" }}>
        <div className="tag">{t("pharmacyDesk.nobody")}</div>
        <p style={{ margin: "9px 0 0 0", fontSize: 12.5, lineHeight: "18px", color: "var(--dim)" }}>{t("pharmacyDesk.nobodyHint")}</p>
        <div className="tag" style={{ marginTop: 22 }}>{t("pharmacyDesk.day.title")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 10 }}>
          {day.map((d) => (
            <div key={d.label} style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ flexGrow: 1, fontSize: 12.5, color: "var(--dim)" }}>{d.label}</span>
              <span className="mo" style={{ fontSize: 14, fontWeight: 600 }}>{d.value}</span>
            </div>
          ))}
        </div>
        <div className="tag" style={{ marginTop: 22 }}>{t("pharmacyDesk.keys.title")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
          {keys.map((k) => (
            <div key={k.k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="kb">{k.k}</span>
              <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{k.what}</span>
            </div>
          ))}
        </div>
      </aside>
    );
  }

  const p = inHand.patient;
  const step = flowIndex(stageOf(inHand, me));
  return (
    <aside className="rail" data-testid="desk-dossier" style={{ padding: "18px 18px 26px 18px" }}>
      <div style={{ display: "flex", gap: 11 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 6, background: "var(--wash)", border: "1px solid var(--line)", display: "flex",
          alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 600, color: "var(--dim)", flexShrink: 0,
        }}>{initialsOf(p)}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{whoLabel(p)}</div>
          <div className="mo" style={{ fontSize: 11, color: "var(--dim)", marginTop: 2 }}>
            {[rail.data?.ageYears == null ? null : t("pharmacyDesk.years", { n: rail.data.ageYears }),
              rail.data?.sex == null ? null : t(`pharmacyDesk.sex.${rail.data.sex}`, { defaultValue: rail.data.sex }),
              p.uhid].filter((x) => x !== null).join(" · ")}
          </div>
          {p.restricted ? <span className="pill gd" style={{ marginTop: 5 }}>{t("pharmacyDesk.sealedRecord")}</span> : null}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }} data-testid="desk-allergies">
        {inHand.allergies.length === 0
          ? <span className="pill">{t("pharmacyDesk.noAllergy")}</span>
          : inHand.allergies.map((a) => (
            <span key={a.substance} className="pill rd">{t("pharmacyDesk.allergy", { substance: a.substance })}</span>
          ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 18 }} aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span key={i} style={{
            flexGrow: 1, height: 5, borderRadius: 3,
            background: i < step ? "var(--green)" : i === step ? "var(--ink)" : "var(--line)",
          }} />
        ))}
      </div>
      {/* One stage holds both "money owed" and "money taken"; a paid ticket's next act is the hand-over (walk finding). */}
      <div className="tag" style={{ marginTop: 7 }} data-testid="desk-flow">
        {t(`pharmacyDesk.flow.${inHand.status === "billed" && FLOW_STEPS[step] === "money" ? "handOver" : FLOW_STEPS[step]!}`)}
      </div>

      {/* WHO IS AT THE WINDOW (the board's rail): the visits behind this one, and the courses still running. */}
      {(rail.data?.alreadyTaking.length ?? 0) === 0 ? null : (
        <div data-testid="desk-taking" style={{ marginTop: 20 }}>
          <div className="tag">{t("pharmacyDesk.alreadyTaking")}</div>
          {rail.data!.alreadyTaking.map((m) => (
            <div key={`${m.drug}-${m.since}`} style={{ marginTop: 6 }}>
              <div style={{ fontSize: 12.5 }}>{m.drug}</div>
              <div className="mo" style={{ fontSize: 11, color: "var(--dim)" }}>{m.sig} · {t("pharmacyDesk.sinceDay", { day: m.since })}</div>
            </div>
          ))}
        </div>
      )}
      {(rail.data?.visits.length ?? 0) === 0 ? null : (
        <div data-testid="desk-visits" style={{ marginTop: 20 }}>
          <div className="tag">{t("pharmacyDesk.visits")}</div>
          {rail.data!.visits.map((v) => (
            <div key={v.encounterId} style={{ display: "flex", gap: 9, alignItems: "baseline", marginTop: 7, borderTop: "1px solid var(--line2)", paddingTop: 7 }}>
              <span className="mo" style={{ fontSize: 11, color: "var(--dim)", width: 62, flexShrink: 0 }}>{v.serviceDate}</span>
              <span style={{ flexGrow: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 12 }}>{v.departmentName ?? "—"}</span>
                <span style={{ display: "block", fontSize: 11, color: "var(--dim)" }}>{v.doctorName ?? "—"}</span>
              </span>
              <span className="pill">{t("pharmacyDesk.rxLines", { count: v.prescriptionLineCount })}</span>
            </div>
          ))}
        </div>
      )}

      <button className="sec" style={{ width: "100%", marginTop: 22 }} onClick={onClear}>
        {t("pharmacyDesk.clear")} <span className="kb">Esc</span>
      </button>
    </aside>
  );
}

type RowProps = { row: WireQueueRow; me: string | null; now: Date; yesterday: string };

function rowMeta({ row, me, now, yesterday }: RowProps): { who: string; label: string | null; hold: ReturnType<typeof holdOf>; wait: string; tone: string } {
  const day = queuedDay(row.queuedOn, now);
  return {
    who: whoLabel(row.patient),
    label: ticketLabel(row.dispenseNo),
    hold: holdOf(row, me),
    /* An earlier day's ticket says its DAY: a count of hours past midnight reads as a wait it is not. */
    wait: day === null ? waitLabel(row.createdAt, now) : day.kind === "yesterday" ? yesterday : day.label,
    tone: TONE[day === null ? waitTone(row.createdAt, now) : "late"],
  };
}

/**
 * THE RIGHT RAIL, UNTIL THE BILL TAKES IT (PD-6). Every ticket at this counter today. A ticket
 * somebody else holds is DIMMED AND NAMED — the owner wants the line seen whole (PD-D9) — and a
 * sealed patient's ticket says so before anybody clicks it (PD-1, E3).
 */
export function QueueRail({
  rows, me, now, inHandId, onTake,
}: {
  rows: WireQueueRow[];
  me: string | null;
  now: Date;
  inHandId: string | null;
  onTake: (dispenseId: string, who: string, mine: boolean) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <aside
      data-testid="desk-queue"
      style={{ width: 296, flexShrink: 0, borderLeft: "1px solid var(--line)", background: "var(--card)", display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 15px 11px 15px" }}>
        <span className="tag" style={{ flexGrow: 1 }}>{t("pharmacyDesk.line", { count: rows.length })}</span>
      </div>
      <div style={{ flexGrow: 1, overflowY: "auto" }}>
        {rows.length === 0 ? (
          <p style={{ margin: 0, padding: "9px 15px", fontSize: 12, color: "var(--dim)" }}>{t("pharmacyDesk.lineEmpty")}</p>
        ) : null}
        {rows.map((row) => {
          const m = rowMeta({ row, me, now, yesterday: t("pharmacyDesk.queuedYesterday") });
          const theirs = m.hold.kind === "theirs";
          const here = row.dispenseId === inHandId;
          return (
            <button
              key={row.dispenseId}
              data-testid={`queue-row-${row.dispenseId}`}
              disabled={theirs}
              aria-current={here ? "true" : undefined}
              onClick={() => onTake(row.dispenseId, m.who, m.hold.kind === "mine")}
              style={{
                display: "flex", alignItems: "flex-start", gap: 9, width: "100%", padding: "9px 15px",
                borderTop: "1px solid var(--line2)",
                ...(theirs ? { opacity: 0.5 } : {}),
                ...(here ? { background: "var(--green-soft)", boxShadow: "inset 2px 0 0 var(--green)" } : {}),
              }}
            >
              <span style={{ flexGrow: 1, minWidth: 0 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  {m.label === null ? null : <span className="mo" style={{ fontSize: 11.5, fontWeight: 600 }}>{m.label}</span>}
                  <span style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.who}</span>
                  <span className="mo" style={{ fontSize: 10.5, color: m.tone, marginLeft: "auto" }}>{m.wait}</span>
                </span>
                <span style={{ display: "flex", gap: 5, marginTop: 5, flexWrap: "wrap" }}>
                  {m.hold.kind === "theirs" ? <span className="pill">{t("pharmacyDesk.heldBy", { name: m.hold.name })}</span> : null}
                  {m.hold.kind === "mine" ? <span className="pill on">{t("pharmacyDesk.yours")}</span> : null}
                  {row.patient.restricted ? <span className="pill gd">{t("pharmacyDesk.sealedRecord")}</span> : null}
                  <ShelfPill row={row} />
                  {row.transcribedBy !== null && row.transcribedBy !== undefined && row.slipConfirmedBy === null
                    ? <span className="pill gd">{t("pharmacyDesk.slipToConfirm")}</span> : null}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div style={{ padding: "11px 15px", borderTop: "1px solid var(--line2)", fontSize: 11, color: "var(--dim)", lineHeight: "16px" }}>
        {t("pharmacyDesk.lineFoot")}
      </div>
    </aside>
  );
}

/**
 * `Q` — the whole line in one sheet. "Open in a tab" CLAIMS here and opens the ticket in a new tab,
 * so this window keeps the patient it already has; a held ticket cannot be opened and says who has it.
 */
export function QueueOverlay({
  rows, me, now, onOpen, onClose,
}: {
  rows: WireQueueRow[];
  me: string | null;
  now: Date;
  onOpen: (dispenseId: string, who: string, mine: boolean) => void;
  onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  /* PD-2: tickets are numbered when queued. Only a line made wholly of pre-PD-2 tickets has no numbers — then no column of dashes. */
  const numbered = rows.some((r) => r.dispenseNo !== null);
  return (
    <div className="ovl" role="dialog" aria-modal="true" aria-label={t("pharmacyDesk.overlayTitle")} onClick={onClose}>
      <div className="box" style={{ width: 680, maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 70px rgba(19,36,32,.35)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "15px 18px", borderBottom: "1px solid var(--line2)" }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, flexGrow: 1 }}>{t("pharmacyDesk.overlayTitle")}</h2>
          <button className="pill" onClick={onClose}>{t("pharmacyDesk.close")} <span className="kb">Esc</span></button>
        </div>
        <div style={{ overflowY: "auto" }}>
          {rows.map((row) => {
            const m = rowMeta({ row, me, now, yesterday: t("pharmacyDesk.queuedYesterday") });
            return (
              <div key={row.dispenseId} className="drow" style={{ alignItems: "flex-start" }} data-testid={`overlay-row-${row.dispenseId}`}>
                {numbered ? <span className="mo" style={{ width: 58, flexShrink: 0, fontSize: 12, fontWeight: 600, paddingTop: 2 }}>{m.label ?? ""}</span> : null}
                <span style={{ flexGrow: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 500 }}>{m.who}</span>
                  <span className="mo" style={{ display: "block", fontSize: 11, color: "var(--dim)" }}>{row.patient.uhid}</span>
                  <span style={{ display: "flex", marginTop: 4 }}><ShelfPill row={row} /></span>
                </span>
                <span className="mo" style={{ fontSize: 11.5, color: m.tone, width: 52, textAlign: "right", paddingTop: 3 }}>{m.wait}</span>
                {m.hold.kind === "theirs" ? (
                  <span style={{ fontSize: 11, color: "var(--dim)", width: 124, textAlign: "right", paddingTop: 3 }}>{t("pharmacyDesk.heldBy", { name: m.hold.name })}</span>
                ) : (
                  <button className="sec grn" style={{ height: 26, width: 124 }} onClick={() => onOpen(row.dispenseId, m.who, m.hold.kind === "mine")}>
                    {m.hold.kind === "mine" ? t("pharmacyDesk.openMine") : t("pharmacyDesk.openInTab")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--line2)", fontSize: 11.5, color: "var(--dim)", lineHeight: "17px" }}>
          {t("pharmacyDesk.overlayFoot")}
        </div>
      </div>
    </div>
  );
}

/** PD-7 / C1 — the shelf's verdict on a WAITING ticket, before it is claimed. */
function ShelfPill({ row }: { row: WireQueueRow }): React.ReactElement | null {
  const { t } = useTranslation();
  const flag = shelfFlag(row.shelf);
  if (flag === null) return null;
  return (
    <span className={`pill ${flag.tone}`} data-testid={`shelf-${row.dispenseId}`}>
      {t(`pharmacyDesk.shelf.${flag.key}`, { names: flag.names, count: flag.n })}
    </span>
  );
}
