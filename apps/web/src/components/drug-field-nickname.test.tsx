import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { setToken } from "../lib/api";
import { resetSuggestSignals } from "../lib/suggest-signals";
import { renderWithProviders, stubFetch } from "../test-utils";
import { DrugField } from "./drug-field";
import type { WireMedicineHit } from "../lib/formulary-api";

/**
 * A LEARNED NICKNAME IN THE DRUG FIELD (decisions 0051, 0055 — owner 2026-10-08).
 *
 * Only a prescribing field asks for nicknames. The row shows the product's FULL name with its
 * strength and form, a "nickname" tag and a cross; nothing is picked for the doctor; and what the
 * doctor does with it is told to the server against the nickname's id.
 */
const PAN: WireMedicineHit = {
  id: "m-pan40", name: "Pan (pantoprazole sodium) 40 mg gastro-resistant oral tablet", form: "Gastro-resistant oral tablet", strength: "40 mg",
  code: null, routeClass: "systemic", salts: ["Pantoprazole"], prefix: false, reviewed: true, alias: { id: "A1", state: "suggestion", lasaGuard: false },
};
const OTHER: WireMedicineHit = { id: "m-panx", name: "Panforte 80", form: "Oral tablet", strength: "80 mg", code: null, routeClass: "systemic", salts: ["Pantoprazole"], prefix: true, reviewed: true };

type Sent = { misses: { kind: string; term: string; stage: string }[]; suggestions: Record<string, unknown>[] };

function Harness({ nicknames = true }: { nicknames?: boolean }): React.ReactElement {
  const [value, setValue] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div>
      <DrugField
        value={value} onText={setValue} onPick={(h) => { setValue(h.name); setPicked(h.id); }} inputId="rx-drug"
        {...(nicknames ? { nicknames: { surface: "consult_web" as const, encounterId: "enc-1" } } : {})}
      />
      <output data-testid="picked">{picked ?? ""}</output>
      <button type="button">elsewhere</button>
    </div>
  );
}

describe("DrugField — a learned nickname", () => {
  let urls: string[];
  let sent: Sent[];
  const serve = (items: WireMedicineHit[]): void => {
    stubFetch({
      "GET /api/formulary/medicines/search": (_init?: RequestInit, url?: string) => { urls.push(url ?? ""); return { items }; },
      "POST /api/opd/consult/signals": (init?: RequestInit) => { sent.push(JSON.parse(String(init?.body)) as Sent); return { misses: 0, suggestions: 0 }; },
    });
  };
  beforeEach(() => { setToken("tok-1"); urls = []; sent = []; resetSuggestSignals(); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("an ordinary field asks the catalogue only: no `for=rx`, and it tells the server nothing", async () => {
    const user = userEvent.setup();
    serve([]);
    renderWithProviders(<Harness nicknames={false} />);
    await user.type(screen.getByRole("textbox"), "pan forty");
    await waitFor(() => { expect(urls.length).toBeGreaterThan(0); });
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(urls.every((u) => !u.includes("for="))).toBe(true);
    expect(sent).toEqual([]);
  });

  it("shows the nickname's medicine with its FULL name, strength and form, a tag and a cross — and picks nothing by itself", async () => {
    const user = userEvent.setup();
    serve([PAN]);
    renderWithProviders(<Harness />);
    await user.type(screen.getByRole("textbox"), "pan forty");

    const row = await screen.findByTestId("rx-drug-hit-m-pan40");
    expect(urls.at(-1)).toContain("for=rx");
    expect(row).toHaveTextContent("Pan (pantoprazole sodium) 40 mg gastro-resistant oral tablet");
    expect(screen.getByTestId("rx-drug-detail-m-pan40")).toHaveTextContent("40 mg · Gastro-resistant oral tablet");
    expect(screen.getByTestId("rx-drug-nickname-m-pan40")).toHaveTextContent("nickname");
    expect(screen.getByTestId("rx-drug-nickname-x-m-pan40")).toHaveAccessibleName("Not this medicine");
    // Nothing is pre-selected: the box still holds the doctor's own words and Enter picks nothing.
    await user.keyboard("{Enter}");
    expect(screen.getByRole("textbox")).toHaveValue("pan forty");
    expect(screen.getByTestId("picked")).toHaveTextContent("");
    expect(sent).toEqual([]);

    await user.click(row);
    expect(screen.getByTestId("picked")).toHaveTextContent("m-pan40");
    expect(sent).toEqual([{ misses: [], suggestions: [{ kind: "alias", source: "search", outcome: "accepted", surface: "consult_web", itemKey: "A1", encounterId: "enc-1" }] }]);
  });

  it("a nickname with a look-alike flag asks for a second tap", async () => {
    const user = userEvent.setup();
    serve([{ ...PAN, alias: { id: "A1", state: "trusted", lasaGuard: true } }]);
    renderWithProviders(<Harness />);
    await user.type(screen.getByRole("textbox"), "pan forty");
    await user.click(await screen.findByTestId("rx-drug-hit-m-pan40"));
    expect(screen.getByTestId("rx-drug-nickname-ask-m-pan40")).toHaveTextContent("Other medicines have a similar name. Tap again to pick this one.");
    expect(screen.getByTestId("picked")).toHaveTextContent("");
    expect(sent).toEqual([]);
    await user.click(screen.getByTestId("rx-drug-hit-m-pan40"));
    expect(screen.getByTestId("picked")).toHaveTextContent("m-pan40");
    expect(sent).toHaveLength(1);
  });

  it("the cross takes the row away for this visit and counts a dismissal; picking another row instead is told too", async () => {
    const user = userEvent.setup();
    serve([OTHER, PAN]);
    renderWithProviders(<Harness />);
    await user.type(screen.getByRole("textbox"), "panfor");
    await screen.findByTestId("rx-drug-hit-m-pan40");
    await user.click(screen.getByTestId("rx-drug-hit-m-panx"));
    expect(sent).toEqual([{ misses: [], suggestions: [{ kind: "alias", source: "search", outcome: "manual", surface: "consult_web", itemKey: "A1", encounterId: "enc-1", contextKey: "med:m-panx" }] }]);

    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "panfort");
    await user.click(await screen.findByTestId("rx-drug-nickname-x-m-pan40"));
    expect(screen.queryByTestId("rx-drug-hit-m-pan40")).toBeNull();
    expect(screen.getByTestId("rx-drug-hit-m-panx")).toBeInTheDocument();
    expect(sent.at(-1)).toEqual({ misses: [], suggestions: [{ kind: "alias", source: "search", outcome: "dismissed", surface: "consult_web", itemKey: "A1", encounterId: "enc-1" }] });
    expect(screen.getByTestId("picked")).toHaveTextContent("m-panx"); // the cross picked nothing new
  });

  it("a word the catalogue could not answer is told ONCE when the doctor leaves it standing — the word alone", async () => {
    const user = userEvent.setup();
    serve([]);
    renderWithProviders(<Harness />);
    await user.type(screen.getByRole("textbox"), "Dolo Six Fifty");
    await waitFor(() => { expect(urls.some((u) => u.includes(encodeURIComponent("Dolo Six Fifty")))).toBe(true); });
    await waitFor(() => { expect(screen.queryByTestId("rx-drug-busy")).toBeNull(); });
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    await user.click(screen.getByRole("textbox"));
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(sent).toEqual([{ misses: [{ kind: "medicine", term: "dolo six fifty", stage: "search" }], suggestions: [] }]);
  });
});
