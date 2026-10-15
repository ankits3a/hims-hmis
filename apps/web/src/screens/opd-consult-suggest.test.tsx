import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, stubFetch } from "../test-utils";
import { CopilotSuggestions } from "./opd-consult-suggest";
import { resetSuggestSignals } from "../lib/suggest-signals";
import { PaperLinesEditor, cleanLines, EMPTY_LINE } from "../components/paper-lines";
import type { WireRxLine } from "../lib/opd-api";
import { useState } from "react";

/**
 * ═══ DECISION 0050, PHASE P0 — EVERY CHIP HAS A ×, AND THE × IS COUNTED ═══
 *
 * Owner, 2026-10-07: "start the groundwork (P0) now." A suggestion the doctor does not want is
 * crossed off with one tap; that tap is told to the server WITH the chips that were on screen, the
 * other chips do not move, and a chip the doctor merely did not tap tells the server nothing.
 */
type Sent = { kind: string; outcome: string; itemKey?: string; items?: string[]; surface?: string; encounterId?: string; contextKey?: string; rankShown?: number };

const HITS = [
  { key: "urti", name: "Acute URTI", icd10: "J06.9", score: 3, matched: ["fever"] },
  { key: "viral", name: "Viral fever", icd10: "B34.9", score: 2, matched: ["fever"] },
];
const TESTS = { items: [
  { serviceId: "svc-cbc", code: "CBC", name: "CBC", pricePaise: 20000, mine: 3, hospital: 9 },
  { serviceId: "svc-crp", code: "CRP", name: "CRP", pricePaise: 40000, mine: 1, hospital: 4 },
] };

function mount(opts: { prefs?: unknown; diagnoses?: { text: string; icd10: string | null }[] } = {}): { sent: Sent[]; added: string[]; puts: unknown[] } {
  const sent: Sent[] = []; const added: string[] = []; const puts: unknown[] = [];
  stubFetch({
    "GET /api/opd/consult/suggestions": opts.prefs ?? { on: true, hospitalOn: true, hidden: [] },
    "PUT /api/opd/consult/suggestions": (init?: RequestInit) => { puts.push(JSON.parse(String(init?.body))); return { on: true }; },
    "POST /api/opd/consult/signals": (init?: RequestInit) => { sent.push(...(JSON.parse(String(init?.body)) as { suggestions: Sent[] }).suggestions); return { misses: 0, suggestions: 1 }; },
    "GET /api/opd/cds/suggest/tests": TESTS,
  });
  renderWithProviders(
    <CopilotSuggestions
      variant="pane" encounterId="enc-1" hits={HITS} diagnoses={opts.diagnoses ?? []}
      onAddDx={(name) => { added.push(name); }} advised={[]} onAddTest={(x) => { added.push(x.name); }}
      regimen={null} onOpenRegimen={() => undefined} onFillRx={() => undefined}
    />,
  );
  return { sent, added, puts };
}

describe("suggestion chips — the cross (decision 0050 P0)", () => {
  beforeEach(() => { resetSuggestSignals(); });

  it("the × takes ONE chip off, tells the server which and what else was shown, and adds nothing; the other chip does not move", async () => {
    const user = userEvent.setup();
    const { sent, added } = mount();
    await user.click(await screen.findByTestId("sug-dx-x-viral"));
    expect(screen.queryByTestId("sug-dx-viral")).toBeNull();
    expect(screen.getByTestId("sug-dx-urti")).toBeInTheDocument();
    expect(added).toEqual([]);
    await waitFor(() => { expect(sent.some((s) => s.outcome === "dismissed")).toBe(true); });
    expect(sent.find((s) => s.outcome === "shown")).toMatchObject({ kind: "diagnosis", surface: "consult_web", encounterId: "enc-1", items: ["dx:J06", "dx:B34"] });
    expect(sent.find((s) => s.outcome === "dismissed")).toMatchObject({ kind: "diagnosis", itemKey: "dx:B34", rankShown: 1, surface: "consult_web", encounterId: "enc-1" });
    // The cross is labelled for a screen reader with the thing it crosses.
    expect(screen.getByTestId("sug-dx-x-urti")).toHaveAccessibleName("Don't suggest Acute URTI");
  });

  it("a tap is told as ACCEPTED; chips that were only looked at are never told as crosses", async () => {
    const user = userEvent.setup();
    const { sent, added } = mount();
    await user.click(await screen.findByTestId("sug-dx-urti"));
    expect(added).toEqual(["Acute URTI"]);
    await waitFor(() => { expect(sent.some((s) => s.outcome === "accepted")).toBe(true); });
    expect(sent.filter((s) => s.outcome === "dismissed")).toEqual([]);
    expect(sent.filter((s) => s.outcome === "shown")).toHaveLength(1); // one row per set of chips, not one per render
  });

  it("a test chip's cross is counted under the diagnosis it was offered for", async () => {
    const user = userEvent.setup();
    const { sent } = mount({ diagnoses: [{ text: "Acute URTI", icd10: "J06.9" }] });
    await user.click(await screen.findByTestId("sug-test-x-svc-crp"));
    expect(screen.queryByTestId("sug-test-svc-crp")).toBeNull();
    expect(screen.getByTestId("sug-test-svc-cbc")).toBeInTheDocument();
    await waitFor(() => { expect(sent.find((s) => s.outcome === "dismissed")).toMatchObject({ kind: "test", contextKey: "dx:J06", itemKey: "svc-crp" }); });
  });

  it("what the doctor crossed three times (the server's list) is not offered", async () => {
    mount({ prefs: { on: true, hospitalOn: true, hidden: [{ kind: "diagnosis", contextKey: null, itemKey: "dx:b34" }] } });
    expect(await screen.findByTestId("sug-dx-urti")).toBeInTheDocument();
    await waitFor(() => { expect(screen.queryByTestId("sug-dx-viral")).toBeNull(); });
  });

  it("the doctor's own switch: off shows no chip and tells the server nothing was shown; one tap turns it back on", async () => {
    const user = userEvent.setup();
    const { sent, puts } = mount({ prefs: { on: false, hospitalOn: true, hidden: [] } });
    expect(await screen.findByTestId("sug-off")).toBeInTheDocument();
    expect(screen.queryByTestId("sug-dx-urti")).toBeNull();
    await user.click(screen.getByTestId("sug-turn-on"));
    expect(await screen.findByTestId("sug-dx-urti")).toBeInTheDocument();
    expect(puts).toEqual([{ suggestionsOn: true }]);
    await user.click(screen.getByTestId("sug-turn-off"));
    expect(await screen.findByTestId("sug-off")).toBeInTheDocument();
    expect(puts).toEqual([{ suggestionsOn: true }, { suggestionsOn: false }]);
    expect(sent.filter((s) => s.outcome === "dismissed")).toEqual([]);
  });
});

describe("the desk's line — one closed frequency set (decision 0050 P0)", () => {
  function Table(): React.ReactElement {
    const [lines, setLines] = useState<WireRxLine[]>([{ ...EMPTY_LINE, drug: "Paracetamol 500", dose: "1 tab" }]);
    return (<><PaperLinesEditor idPrefix="t" lines={lines} onChange={setLines} alerts={new Map()} /><output data-testid="out">{JSON.stringify(cleanLines(lines))}</output></>);
  }
  const out = (): WireRxLine[] => JSON.parse(screen.getByTestId("out").textContent ?? "[]") as WireRxLine[];

  it("what the scribe types as 1-0-1 is kept as BD when they leave the box; a sentence of the doctor's is left as typed; the line says it came from paper", async () => {
    const user = userEvent.setup();
    stubFetch({});
    renderWithProviders(<Table />);
    const freq = screen.getByTestId("t-freq-0");
    await user.type(freq, "1-0-1");
    await user.tab();
    expect(freq).toHaveValue("BD");
    await user.clear(freq);
    await user.type(freq, "twice daily");
    expect(out()[0]).toMatchObject({ frequency: "BD", source: "paper" }); // sent snapped even if the box was never left
    await user.clear(freq);
    await user.type(freq, "alternate days");
    await user.tab();
    expect(freq).toHaveValue("alternate days");
    expect(out()[0]!.frequency).toBe("alternate days");
  });
});
