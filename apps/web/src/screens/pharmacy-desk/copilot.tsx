import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchAlternatives } from "../../lib/pharmacy-api";
import { say } from "./log";
import { bestOffer } from "./model";
import { priceLabel } from "./substitute";
import { blockedOf, prescribedOf, substitutable } from "./work";
import type { Tick } from "./work";
import type { WireDispenseLine } from "../../lib/pharmacy-api";

/**
 * ═══ THE COUNTER AGENT SPEAKS ON THE TICKET (the approved Desk board's `agchip`) ═══
 *
 * Owner, 2026-09-20: the desk was a form, not a co-pilot. The board's agent does not list
 * equivalents and wait — it names the one medicine it would give, with what the bill will ask for
 * it, what it saves against the line as written, and the fact that it has already been put to this
 * patient's four books. One tap opens the sheet with that medicine ticked; the consent tick and the
 * sentence the pharmacist must say stay where they are, because consent is the patient's, not the
 * screen's.
 *
 * EVERY FIGURE IS THE SERVER'S — stock from the shelf read, price and saving from `quote.ts`, the
 * verdict from `refusalsOf`, the function verify refuses with. The desk computes none of them.
 */
export function firstLineNeedingHelp(lines: readonly WireDispenseLine[]): WireDispenseLine | null {
  return lines.find((l) => {
    if (l.status !== "open" || l.pickedBatch != null || !substitutable(l)) return false;
    const b = blockedOf(l);
    return b === "empty" || b === "not_stocked" || b === "not_saleable";
  }) ?? null;
}

export function CopilotOffer({
  dispenseId, line, tick, onSubstitute,
}: {
  dispenseId: string;
  line: WireDispenseLine;
  tick: Tick | undefined;
  onSubstitute: (medicineId: string) => void;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const want = (tick === undefined ? null : prescribedOf(line, tick)) ?? line.qtyBase ?? 1;
  const alts = useQuery({
    queryKey: ["pharmacy", "alternatives", dispenseId, line.lineIdx],
    queryFn: () => fetchAlternatives(dispenseId, line.lineIdx),
    retry: false,
  });
  const written = line.rxLine.drug;
  const offer = alts.data === undefined ? null : bestOffer(alts.data.items, want, alts.data.written);
  /* The dock carries the same voice as the chip: "watching the line" while the chip is speaking read as two agents. */
  const told = useRef<string | null>(null);
  useEffect(() => {
    const key = offer === null ? null : `${line.lineIdx}:${offer.alt.medicineId}`;
    if (key === null || told.current === key) return;
    told.current = key;
    say(t("pharmacyDesk.copilot.dock", { written, offer: offer!.alt.brandName, n: offer!.alt.available }));
  }, [offer, line.lineIdx, t, written]);
  if (alts.isPending || alts.error !== null || alts.data === undefined) return null;

  const blockedOnly = offer === null && alts.data.items.some((a) => a.check.verdict === "blocked");
  const says = offer !== null
    ? t("pharmacyDesk.copilot.offer", {
      written, offer: offer.alt.brandName, n: offer.alt.available, price: priceLabel(offer.alt.quote!, t),
    })
      + (offer.savingPerPackPaise === null || offer.alt.quote!.pack === null
        ? ""
        : ` ${t("pharmacyDesk.copilot.saving", { amount: `₹${(offer.savingPerPackPaise / 100).toFixed(2)}`, pack: offer.alt.quote!.pack.uom })}`)
      + (offer.alt.available >= want ? "" : ` ${t("pharmacyDesk.copilot.short", { n: offer.alt.available, want })}`)
    : blockedOnly ? t("pharmacyDesk.copilot.blockedOnly", { written }) : t("pharmacyDesk.copilot.none", { written });

  return (
    <div className="agchip" data-testid="desk-copilot" style={{ marginTop: 14, display: "flex", alignItems: "flex-start" }}>
      <span style={{ flexGrow: 1 }}>{says}</span>
      {offer === null ? null : (
        <button className="agdo" onClick={() => onSubstitute(offer.alt.medicineId)}>
          {t("pharmacyDesk.copilot.act", { offer: offer.alt.brandName })}
        </button>
      )}
    </div>
  );
}
