import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { canteenRefusal, fetchBedMenu, placeBedOrderApi, rupees, storedFamilyToken } from "../lib/canteen-api";
import { FoodMark } from "./canteen-till";
import type { CanteenBedMenu, CanteenSale } from "@hmis/contracts";
import "./canteen.css";

/**
 * ═══ CN-1 CANTEEN (issue #977) — THE BED'S QR PAGE at `/canteen/bed#<token>` (no login; D3, D4) ═══
 *
 * The attendant scans the bed's QR: the menu, a cart and three ways to pay — UPI (the counter checks the reference
 * before the food goes), the bed class's included meals, or the hospital bill, which shows only when the family has
 * verified by OTP on this phone (the family page keeps its link here). "For the patient" is checked against NPO and the
 * patient's allergies by the server. The page names the bed only — never the patient. 390 px first, Hindi by default.
 */
type Lang = "hi" | "en";
const LANG_KEY = "hmis.family.lang";
function storedLang(): Lang { try { return localStorage.getItem(LANG_KEY) === "en" ? "en" : "hi"; } catch { return "hi"; } }
function tokenFromLocation(): string { return typeof window === "undefined" ? "" : decodeURIComponent(window.location.hash.replace(/^#/, "")); }

export function CanteenBed({ token: given }: { token?: string } = {}): React.ReactElement {
  const [token] = useState(() => given ?? tokenFromLocation());
  const { i18n } = useTranslation();
  const [lang, setLang] = useState<Lang>(storedLang);
  const t = useMemo(() => i18n.getFixedT(lang), [i18n, lang]);
  const [menu, setMenu] = useState<CanteenBedMenu | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [pay, setPay] = useState<"upi" | "bed_class" | "ipd_bill">("upi");
  const [ref, setRef] = useState("");
  const [forPatient, setForPatient] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [placed, setPlaced] = useState<CanteenSale | null>(null);
  const family = storedFamilyToken();

  useEffect(() => {
    fetchBedMenu(token).then(setMenu, (e: unknown) => setClosed(canteenRefusal(e) ?? "failed"));
  }, [token]);

  const lines = Object.entries(cart).filter(([, q]) => q > 0).map(([dishId, qty]) => ({ dishId, qty }));
  const total = lines.reduce((n, l) => n + (menu?.dishes.find((d) => d.dishId === l.dishId)?.pricePaise ?? 0) * l.qty, 0);
  const ready = lines.length > 0 && !busy && (pay !== "upi" || ref.trim().length >= 6);
  const order = (): void => {
    setBusy(true); setErr(null);
    placeBedOrderApi(token, { lines, pay, ...(pay === "upi" ? { upiReference: ref.trim() } : {}), forPatient }, family ?? undefined)
      .then((s) => { setPlaced(s); setCart({}); setRef(""); setBusy(false); }, (e: unknown) => { setErr(canteenRefusal(e) ?? "failed"); setBusy(false); });
  };
  const pickLang = (l: Lang) => { setLang(l); try { localStorage.setItem(LANG_KEY, l); } catch { /* private window */ } };

  return (
    <main className="cn-bed" lang={lang} data-testid="canteen-bed">
      <header className="cn-bed-head">
        <h1>{t("canteen.bed.title")}</h1>
        <div className="cn-lang">
          <button type="button" aria-pressed={lang === "hi"} onClick={() => pickLang("hi")}>हिंदी</button>
          <button type="button" aria-pressed={lang === "en"} onClick={() => pickLang("en")}>English</button>
        </div>
      </header>
      {closed !== null && <p role="alert" className="cn-notice" data-testid="cn-bed-closed">{t(`canteen.refusal.${closed}`, { defaultValue: t("canteen.refusal.bed_qr_invalid") })}</p>}
      {menu !== null && (
        <>
          <p className="cn-bed-label">{t("canteen.bed.bed", { bed: menu.bedLabel })}</p>
          {placed !== null && (
            <p role="status" className="cn-notice ok" data-testid="cn-bed-placed">
              {placed.state === "awaiting_confirmation" ? t("canteen.bed.waitingUpi", { token: placed.token }) : t("canteen.bed.placed", { token: placed.token })}
            </p>
          )}
          {err !== null && <p role="alert" className="cn-notice" data-testid="cn-bed-err">{t(`canteen.refusal.${err}`, { defaultValue: t("canteen.refusal.failed") })}</p>}
          <ul className="cn-bed-menu">
            {menu.dishes.map((d) => (
              <li key={d.dishId} className="cn-bed-dish">
                <span className="nm"><FoodMark type={d.foodType} /> {d.name}
                  {d.allergens.length > 0 && <span className="al">{d.allergens.map((a) => t(`canteen.allergen.${a}`)).join(" · ")}</span>}
                </span>
                <span className="pr">{rupees(d.pricePaise)}</span>
                <span className="cn-step">
                  <button type="button" className="cn-pm" aria-label={t("canteen.till.less")} onClick={() => setCart((c) => ({ ...c, [d.dishId]: Math.max(0, (c[d.dishId] ?? 0) - 1) }))}>−</button>
                  <b>{cart[d.dishId] ?? 0}</b>
                  <button type="button" className="cn-pm" aria-label={t("canteen.till.more")} onClick={() => setCart((c) => ({ ...c, [d.dishId]: (c[d.dishId] ?? 0) + 1 }))} data-testid={`cn-bed-add-${d.name}`}>+</button>
                </span>
              </li>
            ))}
          </ul>
          <section className="cn-bed-pay">
            <div className="cn-total"><span>{t("canteen.till.total")}</span><b>{rupees(total)}</b></div>
            <div className="cn-modes" role="radiogroup" aria-label={t("canteen.till.payBy")}>
              <button type="button" role="radio" aria-checked={pay === "upi"} className={`cn-mode${pay === "upi" ? " on" : ""}`} onClick={() => setPay("upi")}>{t("canteen.mode.upi")}</button>
              {menu.bedClassMealsLeft > 0 && (
                <button type="button" role="radio" aria-checked={pay === "bed_class"} className={`cn-mode${pay === "bed_class" ? " on" : ""}`} onClick={() => setPay("bed_class")} data-testid="cn-bed-included">
                  {t("canteen.bed.included", { count: menu.bedClassMealsLeft })}
                </button>
              )}
              {family !== null && (
                <button type="button" role="radio" aria-checked={pay === "ipd_bill"} className={`cn-mode${pay === "ipd_bill" ? " on" : ""}`} onClick={() => setPay("ipd_bill")}>{t("canteen.mode.ipd_bill")}</button>
              )}
            </div>
            {pay === "upi" && <label>{t("canteen.bed.upiRef")}<input value={ref} onChange={(e) => setRef(e.target.value)} inputMode="text" data-testid="cn-bed-ref" /></label>}
            {family === null && <p className="cn-dim">{t("canteen.bed.billAtCounter")}</p>}
            <label className="cn-check"><input type="checkbox" checked={forPatient} onChange={(e) => setForPatient(e.target.checked)} /> {t("canteen.till.forPatient")}</label>
            <button type="button" className="cn-btn big" disabled={!ready} onClick={order} data-testid="cn-bed-order">{t("canteen.bed.order", { amount: rupees(total) })}</button>
          </section>
        </>
      )}
    </main>
  );
}
