import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import {
  canteenRefusal, confirmBedOrderApi, fetchBedOrders, fetchCanteenSetup, fetchMenu, fetchMySession, findAdmissionApi, openTillApi, paiseOf,
  rupees, sellApi,
} from "../lib/canteen-api";
import type { CanteenDish } from "../lib/canteen-api";
import type { CanteenAdmissionLookup, CanteenPayMode, CanteenPayment, CanteenSale } from "@hmis/contracts";
import "./canteen.css";

/**
 * ═══ CN-1 CANTEEN (issue #977) — THE COUNTER TILL ═══
 *
 * Open a till (opening cash) → tap dishes onto the order → pick how it is paid → Sell. The token and the bill print from
 * the browser. "For the patient" takes the IP number and is refused while the patient is NPO or for a dish with the
 * patient's allergen (the server says which). UPI orders from a bed's QR wait on the right until the cashier sees the
 * reference on the payer's phone. 1440 px two columns; 390 px one column. No diagnosis anywhere.
 */
const MODES: readonly CanteenPayMode[] = ["cash", "upi", "staff_card", "ipd_bill", "bed_class", "cost_centre", "free_rule", "charity"];
const NEEDS_ADMISSION: ReadonlySet<CanteenPayMode> = new Set(["ipd_bill", "bed_class"]);

export function FoodMark({ type }: { type: string }): React.ReactElement {
  const { t } = useTranslation();
  return <span className={`cn-food ${type}`} role="img" aria-label={t(`canteen.food.${type}`)} title={t(`canteen.food.${type}`)} />;
}

export function CanteenTill(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const session = useQuery({ queryKey: ["canteen", "session"], queryFn: fetchMySession });
  const setup = useQuery({ queryKey: ["canteen", "setup"], queryFn: fetchCanteenSetup });
  const tills = useMemo(() => (setup.data?.outlets ?? []).flatMap((o) => o.tills.filter((x) => x.active).map((x) => ({ ...x, outletId: o.outletId, outlet: o.name, kind: o.kind }))), [setup.data]);
  const s = session.data ?? null;
  const till = tills.find((x) => x.tillId === s?.tillId);
  const menu = useQuery({ queryKey: ["canteen", "menu", till?.outletId ?? ""], queryFn: () => fetchMenu(till!.outletId), enabled: till !== undefined });
  const orders = useQuery({ queryKey: ["canteen", "bed-orders"], queryFn: fetchBedOrders, refetchInterval: 15_000, enabled: s !== null });

  const [pickTill, setPickTill] = useState("");
  const [opening, setOpening] = useState("0");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [mode, setMode] = useState<CanteenPayMode>("cash");
  const [ref, setRef] = useState("");
  const [tendered, setTendered] = useState("");
  const [ipNo, setIpNo] = useState("");
  const [admission, setAdmission] = useState<CanteenAdmissionLookup | null>(null);
  const [forPatient, setForPatient] = useState(false);
  const [costCentreId, setCostCentreId] = useState("");
  const [freeRuleId, setFreeRuleId] = useState("");
  const [freeNote, setFreeNote] = useState("");
  const [grantId, setGrantId] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [last, setLast] = useState<CanteenSale | null>(null);

  const dishes: CanteenDish[] = menu.data ?? [];
  const lines = Object.entries(cart).filter(([, q]) => q > 0).map(([dishId, qty]) => ({ dishId, qty }));
  const total = lines.reduce((n, l) => n + (dishes.find((d) => d.dishId === l.dishId)?.prices.public ?? 0) * l.qty, 0);
  const refusal = (e: unknown) => setNotice({ ok: false, text: t(`canteen.refusal.${canteenRefusal(e) ?? "failed"}`, { defaultValue: t("canteen.refusal.failed") }) });

  const open = useMutation({
    mutationFn: () => openTillApi(pickTill, paiseOf(opening) ?? 0),
    onSuccess: () => { setNotice(null); void qc.invalidateQueries({ queryKey: ["canteen"] }); },
    onError: refusal,
  });
  const lookup = useMutation({
    mutationFn: () => findAdmissionApi(ipNo),
    onSuccess: (a) => { setAdmission(a); setNotice(a.closed === null ? null : { ok: false, text: t(`canteen.refusal.${a.closed}`) }); },
    onError: (e) => { setAdmission(null); refusal(e); },
  });
  const payment = (): CanteenPayment | null => {
    switch (mode) {
      case "cash": { const p = paiseOf(tendered); return { mode, ...(p === null ? {} : { tenderedPaise: p }), ...(grantId ? { grantId } : {}) }; }
      case "upi": return ref.trim().length >= 6 ? { mode, reference: ref.trim(), ...(grantId ? { grantId } : {}) } : null;
      case "staff_card": return ref.trim().length >= 10 ? { mode, qr: ref.trim() } : null;
      case "ipd_bill": case "bed_class": return admission === null ? null : { mode, admissionId: admission.admissionId };
      case "cost_centre": return costCentreId ? { mode, costCentreId } : null;
      case "free_rule": return freeRuleId && freeNote.trim().length >= 3 ? { mode, freeRuleId, note: freeNote.trim() } : null;
      case "charity": return grantId ? { mode, grantId } : null;
    }
  };
  const sale = useMutation({
    mutationFn: () => sellApi(s!.sessionId, lines, payment()!, forPatient && admission !== null ? admission.admissionId : undefined),
    onSuccess: (done) => {
      setLast(done); setCart({}); setRef(""); setTendered(""); setGrantId("");
      setNotice({ ok: true, text: t("canteen.till.sold", { token: done.token }) });
      void qc.invalidateQueries({ queryKey: ["canteen", "session"] });
    },
    onError: refusal,
  });
  const confirm = useMutation({
    mutationFn: (orderId: string) => confirmBedOrderApi(orderId, s!.sessionId),
    onSuccess: (done) => { setLast(done); void qc.invalidateQueries({ queryKey: ["canteen"] }); },
    onError: refusal,
  });

  if (s === null) {
    return (
      <PaperScreen testId="canteen-till">
        <div className="cn-page cn-narrow">
          <h1>{t("canteen.till.title")}</h1>
          {notice !== null && <p role="alert" className="cn-notice">{notice.text}</p>}
          <section className="box cn-card">
            <label>{t("canteen.till.pickTill")}
              <select value={pickTill} onChange={(e) => setPickTill(e.target.value)} data-testid="cn-pick-till">
                <option value="">—</option>
                {tills.map((x) => <option key={x.tillId} value={x.tillId}>{x.outlet} · {x.name}{x.kind === "caterer" ? ` · ${t("canteen.outlet.caterer")}` : ""}</option>)}
              </select>
            </label>
            <label>{t("canteen.till.opening")}
              <input inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} data-testid="cn-opening" />
            </label>
            <button type="button" className="cn-btn big" disabled={pickTill === "" || paiseOf(opening) === null || open.isPending} onClick={() => open.mutate()} data-testid="cn-open">
              {t("canteen.till.open")}
            </button>
          </section>
        </div>
      </PaperScreen>
    );
  }

  const ready = lines.length > 0 && payment() !== null && (!NEEDS_ADMISSION.has(mode) || admission?.closed === null) && (!forPatient || admission !== null);
  const change = mode === "cash" && paiseOf(tendered) !== null ? paiseOf(tendered)! - total : null;
  const isCaterer = till?.kind === "caterer";

  return (
    <PaperScreen testId="canteen-till">
      <div className="cn-page cn-till">
        <header className="cn-head">
          <h1>{t("canteen.till.title")}</h1>
          <span className="cn-chip">{till?.outlet} · {till?.name}</span>
          <span className="cn-chip">{t("canteen.till.cashIn", { amount: rupees(s.expectedCashPaise) })}</span>
        </header>
        {notice !== null && <p role="alert" className={notice.ok ? "cn-notice ok" : "cn-notice"} data-testid="cn-notice">{notice.text}</p>}
        <div className="cn-cols">
          <section className="box cn-menu" aria-label={t("canteen.till.menu")}>
            {dishes.length === 0 && <div className="cn-empty">{t("canteen.till.noMenu")}</div>}
            <div className="cn-dishes">
              {dishes.filter((d) => d.prices.public !== undefined).map((d) => (
                <button key={d.dishId} type="button" className="cn-dish" onClick={() => setCart((c) => ({ ...c, [d.dishId]: (c[d.dishId] ?? 0) + 1 }))} data-testid={`cn-dish-${d.code}`}>
                  <span className="nm"><FoodMark type={d.foodType} /> {d.name}</span>
                  <span className="pr">{rupees(d.prices.public!)}</span>
                  {d.allergens.length > 0 && <span className="al">{d.allergens.map((a) => t(`canteen.allergen.${a}`)).join(" · ")}</span>}
                  {(cart[d.dishId] ?? 0) > 0 && <span className="qty">×{cart[d.dishId]}</span>}
                </button>
              ))}
            </div>
          </section>

          <section className="box cn-order" aria-label={t("canteen.till.order")}>
            <h2>{t("canteen.till.order")}</h2>
            {lines.length === 0 && <div className="cn-empty">{t("canteen.till.tapDish")}</div>}
            {lines.map((l) => {
              const d = dishes.find((x) => x.dishId === l.dishId)!;
              return (
                <div key={l.dishId} className="cn-line">
                  <span>{d.name}</span>
                  <button type="button" className="cn-pm" aria-label={t("canteen.till.less")} onClick={() => setCart((c) => ({ ...c, [l.dishId]: Math.max(0, l.qty - 1) }))}>−</button>
                  <b>{l.qty}</b>
                  <button type="button" className="cn-pm" aria-label={t("canteen.till.more")} onClick={() => setCart((c) => ({ ...c, [l.dishId]: l.qty + 1 }))}>+</button>
                  <span className="r">{rupees((d.prices.public ?? 0) * l.qty)}</span>
                </div>
              );
            })}
            <div className="cn-total"><span>{t("canteen.till.total")}</span><b data-testid="cn-total">{rupees(total)}</b></div>

            <div className="cn-modes" role="radiogroup" aria-label={t("canteen.till.payBy")}>
              {MODES.filter((m) => !isCaterer || m === "cash" || m === "upi").map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} className={`cn-mode${mode === m ? " on" : ""}`} onClick={() => { setMode(m); setRef(""); }} data-testid={`cn-mode-${m}`}>
                  {t(`canteen.mode.${m}`)}
                </button>
              ))}
            </div>

            {mode === "cash" && (
              <label>{t("canteen.till.tendered")}<input inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} data-testid="cn-tendered" />
                {change !== null && change >= 0 && <span className="cn-change">{t("canteen.till.change", { amount: rupees(change) })}</span>}
              </label>
            )}
            {mode === "upi" && <label>{t("canteen.till.upiRef")}<input value={ref} onChange={(e) => setRef(e.target.value)} data-testid="cn-upi-ref" /></label>}
            {mode === "staff_card" && <label>{t("canteen.till.scanCard")}<input value={ref} onChange={(e) => setRef(e.target.value)} autoComplete="off" data-testid="cn-card" /></label>}
            {mode === "cost_centre" && (
              <select value={costCentreId} onChange={(e) => setCostCentreId(e.target.value)} aria-label={t("canteen.mode.cost_centre")} data-testid="cn-cost-centre">
                <option value="">—</option>
                {(setup.data?.costCentres ?? []).map((c) => <option key={c.costCentreId} value={c.costCentreId}>{c.name}</option>)}
              </select>
            )}
            {mode === "free_rule" && (
              <>
                <select value={freeRuleId} onChange={(e) => setFreeRuleId(e.target.value)} aria-label={t("canteen.mode.free_rule")} data-testid="cn-free-rule">
                  <option value="">—</option>
                  {(setup.data?.freeRules ?? []).map((r) => <option key={r.freeRuleId} value={r.freeRuleId}>{r.name}</option>)}
                </select>
                <label>{t("canteen.till.note")}<input value={freeNote} onChange={(e) => setFreeNote(e.target.value)} /></label>
              </>
            )}
            {(mode === "charity" || mode === "cash" || mode === "upi") && (
              <label>{t(mode === "charity" ? "canteen.till.grant" : "canteen.till.grantOptional")}
                <input value={grantId} onChange={(e) => setGrantId(e.target.value.trim())} data-testid="cn-grant" />
              </label>
            )}

            <div className="cn-patient">
              <label>{t("canteen.till.ipNo")}
                <span className="cn-row">
                  <input value={ipNo} onChange={(e) => { setIpNo(e.target.value); setAdmission(null); }} placeholder="IP26-000123" data-testid="cn-ip" />
                  <button type="button" className="cn-btn" disabled={ipNo.trim().length < 4 || lookup.isPending} onClick={() => lookup.mutate()} data-testid="cn-ip-find">{t("canteen.till.find")}</button>
                </span>
              </label>
              {admission !== null && (
                <p className="cn-adm" data-testid="cn-adm">
                  {admission.admissionNo} · {admission.wardName ?? "—"} · {admission.bedCode ?? "—"}
                  {admission.closed === null && admission.bedClassMealsLeft > 0 && <> · {t("canteen.till.bedClassLeft", { count: admission.bedClassMealsLeft })}</>}
                </p>
              )}
              <label className="cn-check"><input type="checkbox" checked={forPatient} onChange={(e) => setForPatient(e.target.checked)} data-testid="cn-for-patient" /> {t("canteen.till.forPatient")}</label>
            </div>

            <button type="button" className="cn-btn big" disabled={!ready || sale.isPending} onClick={() => sale.mutate()} data-testid="cn-sell">
              {t("canteen.till.sell", { amount: rupees(total) })}
            </button>
          </section>

          <aside className="cn-side">
            {last !== null && (
              <section className="box cn-token" data-testid="cn-token">
                <div className="tk">{last.token}</div>
                <div className="no">{last.saleNo}</div>
                <div>{t(`canteen.mode.${last.payMode}`)} · {rupees(last.totalPaise)}</div>
                <button type="button" className="cn-btn" onClick={() => window.print()}>{t("canteen.till.print")}</button>
              </section>
            )}
            <section className="box cn-card">
              <h2>{t("canteen.till.bedOrders")}</h2>
              {(orders.data ?? []).length === 0 && <div className="cn-empty">{t("canteen.till.noBedOrders")}</div>}
              {(orders.data ?? []).map((o) => (
                <div key={o.saleId} className="cn-line" data-testid={`cn-bed-${o.token}`}>
                  <span>#{o.token} · {o.lines.map((l) => `${l.dishName} ×${l.qty}`).join(", ")}</span>
                  <span className="r">{rupees(o.totalPaise)}</span>
                  <button type="button" className="cn-btn" disabled={confirm.isPending} onClick={() => confirm.mutate(o.saleId)}>{t("canteen.till.upiSeen")}</button>
                </div>
              ))}
            </section>
          </aside>
        </div>
      </div>
    </PaperScreen>
  );
}
