import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSessionToggle, useViewportWidth, widthBand } from "./opd-consult-v2";

/*
  A doctor who snaps an open consult window to half the screen must not keep the wide layout's side
  columns: at 1024 they squeezed the brief's vitals tiles until "120/90" was cut, and at phone width
  the copilot drawer covered the whole screen (production, 2026-09-24). The defaults belong to the
  WIDTH BAND, and a choice is remembered per band, so crossing a band re-applies that band's default.
*/

function setWidth(w: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
  window.dispatchEvent(new Event("resize"));
}

function useRight(): [boolean, (next: boolean) => void] {
  const vw = useViewportWidth();
  return useSessionToggle("test.right", vw >= 1440, widthBand(vw));
}

describe("consult side columns follow the width band on resize", () => {
  afterEach(() => { window.sessionStorage.clear(); setWidth(1024); });

  it("names the four bands", () => {
    expect([widthBand(1920), widthBand(1440), widthBand(1300), widthBand(1100), widthBand(1023), widthBand(390)])
      .toEqual(["wide", "wide", "mid", "narrow", "drawer", "drawer"]);
  });

  it("folds an open column when an open window is narrowed, and re-opens it when widened back", () => {
    setWidth(1440);
    const { result } = renderHook(() => useRight());
    expect(result.current[0]).toBe(true);
    act(() => { setWidth(1024); });
    expect(result.current[0]).toBe(false);
    act(() => { setWidth(390); });
    expect(result.current[0]).toBe(false);
    act(() => { setWidth(1600); });
    expect(result.current[0]).toBe(true);
  });

  it("remembers a doctor's own choice within its band only", () => {
    setWidth(1440);
    const { result } = renderHook(() => useRight());
    act(() => { result.current[1](false); });
    expect(result.current[0]).toBe(false);
    act(() => { setWidth(1100); });
    act(() => { result.current[1](true); });
    act(() => { setWidth(1500); });
    expect(result.current[0]).toBe(false);
    act(() => { setWidth(1150); });
    expect(result.current[0]).toBe(true);
  });
});
