import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import {
  canteenRefusal, createCostCentreApi, createDishApi, createFreeRuleApi, createOutletApi, createTillApi, fetchCanteenSetup, fetchMenu, issueBedQrApi,
  paiseOf, rupees, setBedClassMealsApi, setPriceApi,
} from "../lib/canteen-api";
import { FoodMark } from "./canteen-till";
import type { CanteenAllergen, CanteenFoodType, CanteenMeal, CanteenOutletKind, CanteenPriceList } from "@hmis/contracts";
import "./canteen.css";

/**
 * ═══ CN-1 CANTEEN (issue #977) — SETUP (canteen.manage) ═══
 *
 * Outlets (in-house, or a caterer with its GSTIN and monthly rent) and their tills; the menu per outlet with food type,
 * the FSSAI allergens and the three price lists (a new price applies from now; old sales keep theirs); cost centres,
 * free-meal rules, the attendant meals a bed class includes, and a bed's QR (printed for the bed; it orders only while
 * that bed's admission is open).
 */
const MEALS: readonly CanteenMeal[] = ["breakfast", "lunch", "snacks", "dinner", "all_day"];
const FOODS: readonly CanteenFoodType[] = ["veg", "egg", "non_veg"];
const ALLERGENS: readonly CanteenAllergen[] = ["gluten", "crustacean", "milk", "egg", "fish", "peanut", "tree_nut", "soy", "sulphite"];
const LISTS: readonly CanteenPriceList[] = ["public", "staff", "subsidised"];

export function CanteenSetup(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const setup = useQuery({ queryKey: ["canteen", "setup"], queryFn: fetchCanteenSetup });
  const outlets = setup.data?.outlets ?? [];
  const [outletId, setOutletId] = useState("");
  const current = outlets.find((o) => o.outletId === outletId) ?? outlets[0];
  const menu = useQuery({ queryKey: ["canteen", "menu", current?.outletId ?? ""], queryFn: () => fetchMenu(current!.outletId), enabled: current !== undefined });
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const done = (text: string) => { setNotice({ ok: true, text }); void qc.invalidateQueries({ queryKey: ["canteen"] }); };
  const fail = (e: unknown) => setNotice({ ok: false, text: t(`canteen.refusal.${canteenRefusal(e) ?? "failed"}`, { defaultValue: t("canteen.refusal.failed") }) });

  const [o, setO] = useState({ code: "", name: "", kind: "in_house" as CanteenOutletKind, catererName: "", catererGstin: "", rent: "" });
  const [till, setTill] = useState({ code: "", name: "" });
  const [dish, setDish] = useState({ code: "", name: "", meal: "lunch" as CanteenMeal, foodType: "veg" as CanteenFoodType, allergens: [] as CanteenAllergen[], price: "" });
  const [price, setPrice] = useState({ dishId: "", list: "staff" as CanteenPriceList, price: "" });
  const [cc, setCc] = useState({ code: "", name: "" });
  const [fr, setFr] = useState({ code: "", name: "", perDay: "1" });
  const [bc, setBc] = useState({ bedClass: "private", meals: "1" });
  const [qr, setQr] = useState({ bedCode: "", link: "" });

  const addOutlet = useMutation({
    mutationFn: () => createOutletApi(o.kind === "in_house" ? { code: o.code, name: o.name, kind: o.kind }
      : { code: o.code, name: o.name, kind: o.kind, catererName: o.catererName, catererGstin: o.catererGstin, monthlyRentPaise: paiseOf(o.rent) ?? 0 }),
    onSuccess: (r) => { setOutletId(r.outletId); done(t("canteen.setup.saved")); }, onError: fail,
  });
  const addTill = useMutation({ mutationFn: () => createTillApi({ outletId: current!.outletId, ...till }), onSuccess: () => done(t("canteen.setup.saved")), onError: fail });
  const addDish = useMutation({
    mutationFn: async () => {
      const { dishId } = await createDishApi({ outletId: current!.outletId, code: dish.code, name: dish.name, meal: dish.meal, foodType: dish.foodType, allergens: dish.allergens });
      await setPriceApi(dishId, "public", paiseOf(dish.price)!);
    },
    onSuccess: () => { setDish({ ...dish, code: "", name: "", allergens: [], price: "" }); done(t("canteen.setup.saved")); }, onError: fail,
  });
  const addPrice = useMutation({ mutationFn: () => setPriceApi(price.dishId, price.list, paiseOf(price.price)!), onSuccess: () => done(t("canteen.setup.saved")), onError: fail });
  const addCc = useMutation({ mutationFn: () => createCostCentreApi(cc.code, cc.name), onSuccess: () => done(t("canteen.setup.saved")), onError: fail });
  const addFr = useMutation({ mutationFn: () => createFreeRuleApi(fr.code, fr.name, Number(fr.perDay) || 1), onSuccess: () => done(t("canteen.setup.saved")), onError: fail });
  const saveBc = useMutation({ mutationFn: () => setBedClassMealsApi(bc.bedClass, Number(bc.meals) || 0), onSuccess: () => done(t("canteen.setup.saved")), onError: fail });
  const makeQr = useMutation({
    mutationFn: () => issueBedQrApi(qr.bedCode, current!.outletId),
    onSuccess: (r) => { setQr({ ...qr, link: `${window.location.origin}/canteen/bed#${r.token}` }); done(t("canteen.setup.qrIssued")); }, onError: fail,
  });

  return (
    <PaperScreen testId="canteen-setup">
      <div className="cn-page">
        <header className="cn-head"><h1>{t("canteen.setup.title")}</h1>
          <select value={current?.outletId ?? ""} onChange={(e) => setOutletId(e.target.value)} aria-label={t("canteen.setup.outlet")} data-testid="cn-outlet">
            {outlets.map((x) => <option key={x.outletId} value={x.outletId}>{x.name}{x.kind === "caterer" ? ` · ${t("canteen.outlet.caterer")}` : ""}</option>)}
          </select>
        </header>
        {notice !== null && <p role="alert" className={notice.ok ? "cn-notice ok" : "cn-notice"} data-testid="cn-notice">{notice.text}</p>}
        <div className="cn-grid">
          <section className="box cn-card">
            <h2>{t("canteen.setup.menu")}</h2>
            <div className="cn-table-wrap">
              <table className="cn-table" data-testid="cn-menu">
                <thead><tr><th>{t("canteen.setup.dish")}</th>{LISTS.map((l) => <th key={l}>{t(`canteen.list.${l}`)}</th>)}<th>{t("canteen.setup.allergens")}</th></tr></thead>
                <tbody>{(menu.data ?? []).map((d) => (
                  <tr key={d.dishId}><td><FoodMark type={d.foodType} /> {d.name} <span className="cn-dim">{t(`canteen.meal.${d.meal}`)}</span></td>
                    {LISTS.map((l) => <td key={l}>{d.prices[l] === undefined ? "—" : rupees(d.prices[l])}</td>)}
                    <td>{d.allergens.map((a) => t(`canteen.allergen.${a}`)).join(", ") || "—"}</td></tr>
                ))}</tbody>
              </table>
            </div>
            <h3>{t("canteen.setup.addDish")}</h3>
            <div className="cn-form">
              <input placeholder={t("canteen.finance.code")} value={dish.code} onChange={(e) => setDish({ ...dish, code: e.target.value })} aria-label={t("canteen.finance.code")} />
              <input placeholder={t("canteen.setup.dish")} value={dish.name} onChange={(e) => setDish({ ...dish, name: e.target.value })} aria-label={t("canteen.setup.dish")} />
              <select value={dish.meal} onChange={(e) => setDish({ ...dish, meal: e.target.value as CanteenMeal })} aria-label={t("canteen.setup.meal")}>{MEALS.map((m) => <option key={m} value={m}>{t(`canteen.meal.${m}`)}</option>)}</select>
              <select value={dish.foodType} onChange={(e) => setDish({ ...dish, foodType: e.target.value as CanteenFoodType })} aria-label={t("canteen.setup.foodType")}>{FOODS.map((f) => <option key={f} value={f}>{t(`canteen.food.${f}`)}</option>)}</select>
              <input inputMode="decimal" placeholder={t("canteen.setup.publicPrice")} value={dish.price} onChange={(e) => setDish({ ...dish, price: e.target.value })} aria-label={t("canteen.setup.publicPrice")} />
              <fieldset className="cn-allergens"><legend>{t("canteen.setup.allergens")}</legend>
                {ALLERGENS.map((a) => (
                  <label key={a} className="cn-check"><input type="checkbox" checked={dish.allergens.includes(a)}
                    onChange={(e) => setDish({ ...dish, allergens: e.target.checked ? [...dish.allergens, a] : dish.allergens.filter((x) => x !== a) })} /> {t(`canteen.allergen.${a}`)}</label>
                ))}
              </fieldset>
              <button type="button" className="cn-btn" disabled={current === undefined || dish.code.length < 2 || dish.name.length < 2 || paiseOf(dish.price) === null} onClick={() => addDish.mutate()} data-testid="cn-add-dish">{t("canteen.setup.addDish")}</button>
            </div>
            <h3>{t("canteen.setup.setPrice")}</h3>
            <div className="cn-form">
              <select value={price.dishId} onChange={(e) => setPrice({ ...price, dishId: e.target.value })} aria-label={t("canteen.setup.dish")}>
                <option value="">—</option>{(menu.data ?? []).map((d) => <option key={d.dishId} value={d.dishId}>{d.name}</option>)}
              </select>
              <select value={price.list} onChange={(e) => setPrice({ ...price, list: e.target.value as CanteenPriceList })} aria-label={t("canteen.setup.list")}>{LISTS.map((l) => <option key={l} value={l}>{t(`canteen.list.${l}`)}</option>)}</select>
              <input inputMode="decimal" value={price.price} onChange={(e) => setPrice({ ...price, price: e.target.value })} aria-label={t("canteen.finance.price")} />
              <button type="button" className="cn-btn" disabled={price.dishId === "" || paiseOf(price.price) === null} onClick={() => addPrice.mutate()}>{t("canteen.setup.savePrice")}</button>
            </div>
          </section>

          <section className="box cn-card">
            <h2>{t("canteen.setup.outlets")}</h2>
            {outlets.map((x) => (
              <p key={x.outletId} className="cn-line"><span>{x.name}{x.kind === "caterer" && <span className="cn-tag">{t("canteen.outlet.caterer")} · {x.catererName} · {rupees(x.monthlyRentPaise ?? 0)}</span>}</span>
                <span className="cn-dim">{x.tills.map((tl) => tl.code).join(", ") || t("canteen.setup.noTill")}</span></p>
            ))}
            <div className="cn-form">
              <input placeholder={t("canteen.finance.code")} value={o.code} onChange={(e) => setO({ ...o, code: e.target.value })} aria-label={t("canteen.finance.code")} />
              <input placeholder={t("canteen.finance.name")} value={o.name} onChange={(e) => setO({ ...o, name: e.target.value })} aria-label={t("canteen.finance.name")} />
              <select value={o.kind} onChange={(e) => setO({ ...o, kind: e.target.value as CanteenOutletKind })} aria-label={t("canteen.setup.kind")}>
                <option value="in_house">{t("canteen.outlet.in_house")}</option><option value="caterer">{t("canteen.outlet.caterer")}</option>
              </select>
              {o.kind === "caterer" && <>
                <input placeholder={t("canteen.setup.catererName")} value={o.catererName} onChange={(e) => setO({ ...o, catererName: e.target.value })} aria-label={t("canteen.setup.catererName")} />
                <input placeholder="GSTIN" value={o.catererGstin} onChange={(e) => setO({ ...o, catererGstin: e.target.value })} aria-label="GSTIN" />
                <input inputMode="decimal" placeholder={t("canteen.setup.rent")} value={o.rent} onChange={(e) => setO({ ...o, rent: e.target.value })} aria-label={t("canteen.setup.rent")} />
              </>}
              <button type="button" className="cn-btn" disabled={o.code.length < 2 || o.name.length < 2} onClick={() => addOutlet.mutate()}>{t("canteen.setup.addOutlet")}</button>
            </div>
            <div className="cn-form">
              <input placeholder={t("canteen.finance.code")} value={till.code} onChange={(e) => setTill({ ...till, code: e.target.value })} aria-label={t("canteen.finance.code")} />
              <input placeholder={t("canteen.finance.name")} value={till.name} onChange={(e) => setTill({ ...till, name: e.target.value })} aria-label={t("canteen.finance.name")} />
              <button type="button" className="cn-btn" disabled={current === undefined || till.code.length < 2 || till.name.length < 2} onClick={() => addTill.mutate()}>{t("canteen.setup.addTill")}</button>
            </div>
          </section>

          <section className="box cn-card">
            <h2>{t("canteen.setup.rules")}</h2>
            <p className="cn-dim">{(setup.data?.costCentres ?? []).map((c) => c.name).join(", ") || "—"}</p>
            <div className="cn-form">
              <input placeholder={t("canteen.finance.code")} value={cc.code} onChange={(e) => setCc({ ...cc, code: e.target.value })} aria-label={t("canteen.finance.code")} />
              <input placeholder={t("canteen.mode.cost_centre")} value={cc.name} onChange={(e) => setCc({ ...cc, name: e.target.value })} aria-label={t("canteen.mode.cost_centre")} />
              <button type="button" className="cn-btn" disabled={cc.code.length < 2 || cc.name.length < 2} onClick={() => addCc.mutate()}>{t("canteen.setup.addCostCentre")}</button>
            </div>
            <p className="cn-dim">{(setup.data?.freeRules ?? []).map((r) => `${r.name} (${String(r.perDay)})`).join(", ") || "—"}</p>
            <div className="cn-form">
              <input placeholder={t("canteen.finance.code")} value={fr.code} onChange={(e) => setFr({ ...fr, code: e.target.value })} aria-label={t("canteen.finance.code")} />
              <input placeholder={t("canteen.mode.free_rule")} value={fr.name} onChange={(e) => setFr({ ...fr, name: e.target.value })} aria-label={t("canteen.mode.free_rule")} />
              <label>{t("canteen.setup.perDay")}<input inputMode="numeric" value={fr.perDay} onChange={(e) => setFr({ ...fr, perDay: e.target.value })} /></label>
              <button type="button" className="cn-btn" disabled={fr.code.length < 2 || fr.name.length < 2} onClick={() => addFr.mutate()}>{t("canteen.setup.addFreeRule")}</button>
            </div>
            <p className="cn-dim">{(setup.data?.bedClassMeals ?? []).map((b) => `${b.bedClass}: ${String(b.mealsPerDay)}`).join(" · ") || "—"}</p>
            <div className="cn-form">
              <input placeholder={t("canteen.setup.bedClass")} value={bc.bedClass} onChange={(e) => setBc({ ...bc, bedClass: e.target.value })} aria-label={t("canteen.setup.bedClass")} />
              <label>{t("canteen.setup.mealsPerDay")}<input inputMode="numeric" value={bc.meals} onChange={(e) => setBc({ ...bc, meals: e.target.value })} /></label>
              <button type="button" className="cn-btn" onClick={() => saveBc.mutate()}>{t("canteen.setup.saveBedClass")}</button>
            </div>
            <h3>{t("canteen.setup.bedQr")}</h3>
            <div className="cn-form">
              <input placeholder={t("canteen.setup.bedCode")} value={qr.bedCode} onChange={(e) => setQr({ bedCode: e.target.value, link: "" })} aria-label={t("canteen.setup.bedCode")} data-testid="cn-qr-bed" />
              <button type="button" className="cn-btn" disabled={current === undefined || current.kind !== "in_house" || qr.bedCode.trim() === ""} onClick={() => makeQr.mutate()}>{t("canteen.setup.issueQr")}</button>
            </div>
            {qr.link !== "" && (
              <div className="cn-qr" data-testid="cn-qr-link">
                <QRCodeSVG value={qr.link} size={160} />
                <b>{qr.bedCode}</b>
                <span className="cn-dim">{t("canteen.setup.qrHint")}</span>
                <button type="button" className="cn-btn" onClick={() => window.print()}>{t("canteen.till.print")}</button>
              </div>
            )}
          </section>
        </div>
      </div>
    </PaperScreen>
  );
}
