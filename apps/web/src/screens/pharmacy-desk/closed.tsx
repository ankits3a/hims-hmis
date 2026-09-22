import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchClosing } from "../../lib/pharmacy-api";
import { ticketLabel } from "./model";
import { istToday } from "./work";

const rupees = (paise: number): string => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const IST = { timeZone: "Asia/Kolkata" } as const;
const clock = (iso: string | null): string =>
  iso === null ? "—" : new Intl.DateTimeFormat("en-IN", { ...IST, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const istDay = (iso: string): string => new Intl.DateTimeFormat("en-CA", { ...IST, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

/**
 * A time alone lies across midnight: a ticket claimed at 03:31 yesterday and handed over at 03:16
 * today read as "closed 03:16, claimed 03:31" — backwards (walked on the demo, 2026-09-20). When the
 * two fall on different IST days, the earlier one says its day.
 */
const clockOn = (iso: string | null, sameDayAs: string | null): string => {
  if (iso === null) return "—";
  const day = sameDayAs !== null && istDay(iso) !== istDay(sameDayAs)
    ? `${new Intl.DateTimeFormat("en-GB", { ...IST, day: "numeric", month: "short" }).format(new Date(iso))} `
    : "";
  return `${day}${clock(iso)}`;
};

/**
 * ═══ WHAT CLOSED — the approved Desk board's three boxes ═══
 *
 * THE TICKET, THE MONEY, THE REGISTERS. The done screen is the last moment a pharmacist can catch a
 * wrong batch or a register row that was never written, and it used to say only "<name> has their
 * medicine". Every figure is read back off the rows the acts wrote (`closing.ts`), not remembered
 * from the screen's own state.
 */
export function Closed({ dispenseId }: { dispenseId: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const closing = useQuery({
    queryKey: ["pharmacy", "closing", dispenseId],
    queryFn: () => fetchClosing(dispenseId),
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (closing.data === undefined) return null;
  const { ticket, money, registers } = closing.data;

  const boxes: { label: string; body: string }[] = [
    {
      label: t("pharmacyDesk.closed.ticket"),
      body: [
        t("pharmacyDesk.closed.ticketBody", {
          count: ticket.lines,
          label: ticketLabel(ticket.dispenseNo, istToday()) ?? "—",
          at: clock(ticket.handedOverAt), who: ticket.claimedByName ?? "—", claimed: clockOn(ticket.claimedAt, ticket.handedOverAt),
        }),
        ticket.substituted === 0 ? "" : t("pharmacyDesk.closed.substituted", { count: ticket.substituted }),
        ticket.declined === 0 ? "" : t("pharmacyDesk.closed.declined", { count: ticket.declined }),
      ].filter((x) => x !== "").join(" "),
    },
    {
      label: t("pharmacyDesk.closed.money"),
      body: money === null
        ? t("pharmacyDesk.closed.noMoney")
        : [
          t("pharmacyDesk.closed.moneyBody", {
            invoice: money.invoiceNo, receipt: money.receiptNo ?? "—", amount: rupees(money.netPayablePaise),
            modes: money.tenders.map((x) => t(`pharmacyDesk.bill.mode.${x.mode}`, { defaultValue: x.mode })).join(" + "),
          }),
          money.changeGivenPaise === 0 ? "" : t("pharmacyDesk.closed.change", { amount: rupees(money.changeGivenPaise) }),
          t("pharmacyDesk.closed.tax", { cgst: rupees(money.cgstPaise), sgst: rupees(money.sgstPaise) }),
        ].filter((x) => x !== "").join(" "),
    },
    {
      label: t("pharmacyDesk.closed.registers"),
      body: [
        registers.h1Rows === 0 ? t("pharmacyDesk.closed.noH1") : t("pharmacyDesk.closed.h1", { count: registers.h1Rows }),
        t("pharmacyDesk.closed.batches", { count: registers.batches }),
      ].join(" "),
    },
  ];

  return (
    <div data-testid="desk-closed" style={{ display: "grid", gap: 10, marginTop: 18, maxWidth: 720 }}>
      {boxes.map((b) => (
        <div key={b.label} className="box" style={{ padding: "12px 14px" }}>
          <div className="tag">{b.label}</div>
          <div style={{ fontSize: 12.5, lineHeight: "18px", marginTop: 5 }}>{b.body}</div>
        </div>
      ))}
    </div>
  );
}
