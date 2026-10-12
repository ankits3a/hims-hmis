import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { printDocumentHere } from "../lib/browser-print";
import { BMW_CATEGORIES, bmwRefusal, collectBagApi, fetchBag, fetchBmwHandler, generateBagApi, kg, storeBagApi } from "../lib/bmw-api";
import { Swatch, clockWords } from "./bmw-board";
import { useServerNow } from "./my-tasks";
import type { BmwBagCard, BmwCategory } from "@hmis/contracts";
import "./bmw.css";

/**
 * ═══ E1.7 BIO-MEDICAL WASTE (issue #724) — THE HANDLER'S PHONE (390 px) ═══
 *
 * Two jobs, big buttons, Hindi first (each button's Hindi word is its main line, English under it):
 *   1. NEW BAG — pick the place once (remembered on this phone), tap the bag's colour: the label prints.
 *   2. SCAN BAG — the scanner types the code (or the handler does) → the next step shows: weigh and take it
 *      from the ward, or weigh it into the central store. Then "Done" and the box is ready for the next scan.
 * Notices are a few words on one line (owner rule).
 */
const PLACE_KEY = "hmis.bmw.place";
const readPlace = (): string => { try { return localStorage.getItem(PLACE_KEY) ?? ""; } catch { return ""; } };
const keepPlace = (id: string): void => { try { localStorage.setItem(PLACE_KEY, id); } catch { /* private window: forget it */ } };
const grams = (kgText: string): number | null => {
  const v = Number(kgText.replace(",", "."));
  return Number.isFinite(v) && v > 0 && v <= 100 ? Math.round(v * 1000) : null;
};

function Two({ k, o }: { k: string; o?: Record<string, unknown> }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <span className="bw-two">
      <span className="hi" lang="hi">{t(k, { ...o, lng: "hi" })}</span>
      <span className="en" lang="en">{t(k, { ...o, lng: "en" })}</span>
    </span>
  );
}

export function BmwHandle(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["bmw", "handler"], queryFn: fetchBmwHandler });
  const now = useServerNow(q.data?.serverNow, 60_000);
  const [place, setPlace] = useState<string>(readPlace);
  const [cyto, setCyto] = useState(false);
  const [code, setCode] = useState("");
  const [bag, setBag] = useState<BmwBagCard | null>(null);
  const [weight, setWeight] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const scanRef = useRef<HTMLInputElement | null>(null);
  const places = q.data?.places ?? [];

  const fail = (e: unknown): void => {
    const c = bmwRefusal(e);
    setNotice({ ok: false, text: t(`bmw.refusal.${c ?? "failed"}`, { defaultValue: t("bmw.refusal.failed") }) });
  };

  const make = useMutation({
    mutationFn: (category: BmwCategory) => generateBagApi(category, place, category === "yellow" && cyto),
    onSuccess: (r) => {
      setNotice({ ok: true, text: t(r.label.via === "relay" ? "bmw.handle.labelSent" : "bmw.handle.labelHere", { code: r.bag.barcode }) });
      if (r.label.via === "browser") void printDocumentHere(r.label.document);
      setCyto(false);
      void qc.invalidateQueries({ queryKey: ["bmw"] });
    },
    onError: fail,
  });

  const find = useMutation({
    mutationFn: (c: string) => fetchBag(c),
    onSuccess: (b) => { setBag(b); setWeight(""); setNotice(null); },
    onError: (e) => { setBag(null); fail(e); },
  });

  const act = useMutation({
    mutationFn: ({ b, g }: { b: BmwBagCard; g: number | null }) =>
      b.state === "collected" ? storeBagApi(b.barcode, g!) : collectBagApi(b.barcode, b.deptWeightGrams === null ? g! : undefined),
    onSuccess: (b) => {
      setNotice({ ok: true, text: t(b.state === "stored" ? "bmw.handle.stored" : "bmw.handle.collected") });
      setBag(null); setCode(""); setWeight("");
      scanRef.current?.focus();
      void qc.invalidateQueries({ queryKey: ["bmw"] });
    },
    onError: fail,
  });

  const needsWeight = bag !== null && (bag.state === "collected" || (bag.state === "generated" && bag.deptWeightGrams === null));
  const canAct = bag !== null && (bag.state === "generated" || bag.state === "collected");
  const g = grams(weight);

  return (
    <PaperScreen testId="bmw-handle">
      <div className="bw-phone">
        <h1><Two k="bmw.handle.title" /></h1>
        {notice !== null && <p role="alert" className={notice.ok ? "bw-notice ok" : "bw-notice"} data-testid="bmw-notice">{notice.text}</p>}

        <section className="box bw-card" data-testid="bmw-scan">
          <h2><Two k="bmw.handle.scanTitle" /></h2>
          <form className="bw-scan" onSubmit={(e) => { e.preventDefault(); if (code.trim() !== "") find.mutate(code); }}>
            <input
              ref={scanRef} value={code} onChange={(e) => setCode(e.target.value)} inputMode="text" autoCapitalize="characters"
              placeholder={t("bmw.handle.scanPlaceholder")} aria-label={t("bmw.handle.scanTitle")} data-testid="bmw-scan-input"
            />
            <button type="submit" className="bw-btn" disabled={find.isPending || code.trim() === ""} data-testid="bmw-find">{t("bmw.handle.find")}</button>
          </form>
          {bag !== null && (
            <div className="bw-found" data-testid="bmw-found">
              <div className="what"><Swatch c={bag.category} />{t(`bmw.category.${bag.category}`)}{bag.cytotoxic ? ` · ${t("bmw.cytotoxic")}` : ""}</div>
              <div className="where">{bag.placeName} · <span className="mono">{bag.barcode}</span></div>
              <div className="meta">{t(`bmw.state.${bag.state}`)} · <span className={`bw-clock ${clockWords(bag.generatedAt, now, t).level}`}>{clockWords(bag.generatedAt, now, t).text}</span></div>
              {needsWeight && (
                <label className="bw-weight">
                  <span>{t(bag.state === "collected" ? "bmw.handle.centralWeight" : "bmw.handle.wardWeight")}</span>
                  <input value={weight} onChange={(e) => setWeight(e.target.value)} inputMode="decimal" placeholder="0.00" data-testid="bmw-weight" />
                  <b>kg</b>
                </label>
              )}
              {canAct ? (
                <button
                  type="button" className="bw-btn big" data-testid="bmw-act"
                  disabled={act.isPending || (needsWeight && g === null)} onClick={() => act.mutate({ b: bag, g })}
                >
                  <Two k={bag.state === "collected" ? "bmw.handle.store" : "bmw.handle.collect"} />
                </button>
              ) : <div className="bw-sub">{t("bmw.handle.nothingToDo")}</div>}
            </div>
          )}
        </section>

        <section className="box bw-card" data-testid="bmw-new">
          <h2><Two k="bmw.handle.newTitle" /></h2>
          <select value={place} onChange={(e) => { setPlace(e.target.value); keepPlace(e.target.value); }} aria-label={t("bmw.handle.place")} data-testid="bmw-place">
            <option value="">{t("bmw.handle.pickPlace")}</option>
            {places.map((p) => <option key={p.id} value={p.id}>{p.floorName === null ? p.name : `${p.name} · ${p.floorName}`}</option>)}
          </select>
          <div className="bw-cats">
            {BMW_CATEGORIES.map((c) => (
              <button
                key={c} type="button" className={`bw-cat ${c}`} disabled={place === "" || make.isPending}
                onClick={() => make.mutate(c)} data-testid={`bmw-new-${c}`}
              >
                <Two k={`bmw.category.${c}`} />
              </button>
            ))}
          </div>
          <label className="bw-cyto"><input type="checkbox" checked={cyto} onChange={(e) => setCyto(e.target.checked)} data-testid="bmw-cyto" /> {t("bmw.handle.cytoYellow")}</label>
        </section>

        {(q.data?.recent.length ?? 0) > 0 && (
          <section className="bw-recent" data-testid="bmw-recent">
            <h2 className="bw-h2">{t("bmw.handle.recent")}</h2>
            {q.data!.recent.map((b) => (
              <div key={b.id} className="bw-mini"><Swatch c={b.category} /><span className="mono">{b.barcode}</span><span>{t(`bmw.state.${b.state}`)}</span><span>{kg(b.centralWeightGrams ?? b.deptWeightGrams)}</span></div>
            ))}
          </section>
        )}
      </div>
    </PaperScreen>
  );
}
