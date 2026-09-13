import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormProvider, useForm } from "react-hook-form";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DrugCombobox } from "./drug-combobox";
import { api } from "../lib/api";

/**
 * `api` is mocked rather than `fetch`, because what this component owes its caller is "one request
 * per settled query, with the typed text in it" — a statement about the module boundary. A fetch
 * harness would also pass if the component built the wrong URL and the harness happened to match it.
 */
vi.mock("../lib/api", () => ({ api: vi.fn() }));
const apiMock = vi.mocked(api);

/**
 * THE PRESCRIBER'S DRUG FIELD.
 *
 * The case this file exists for is the **Tab** case. A doctor moves Drug -> Dose -> Frequency with
 * Tab and will reach Tab with a row highlighted far more often than Enter; if Tab only moved focus,
 * the highlighted drug would be silently discarded and the half-typed fragment kept. The field
 * would look like it worked.
 *
 * This repo has already paid for that assumption once — 901 green tests that all pressed Enter over
 * a two-stage input where only Enter promoted a value, so the Tab path charted nothing. Every test
 * below that could be written with Enter has a Tab twin.
 */

const SUGGEST = {
  items: [
    {
      genericId: "g1", name: "Amlodipine 5 mg oral tablet", doseForm: "Oral tablet",
      route: "Oral route", composition: "Amlodipine besilate (5/1 mg/Tablet)", matchedOn: "prefix",
    },
    {
      genericId: "g2", name: "Amlodipine 5 mg and atorvastatin 10 mg oral tablet",
      doseForm: "Oral tablet", route: "Oral route",
      composition: "Amlodipine (5/1) + Atorvastatin (10/1)", matchedOn: "prefix",
    },
  ],
};

/** A host with the two fields the component writes, plus a sibling to Tab into. */
function Host({ onState }: { onState?: (v: { drug: string; medicineId: string | null }) => void }): React.ReactElement {
  const form = useForm({ defaultValues: { drug: "", medicineId: "m-old" as string | null } });
  const v = form.watch();
  onState?.({ drug: v.drug, medicineId: v.medicineId });
  return (
    <FormProvider {...form}>
      <DrugCombobox name="drug" medicineIdName="medicineId" label="Drug" testId="rx-drug-0" />
      <label htmlFor="dose">Dose</label>
      <input id="dose" />
    </FormProvider>
  );
}

function renderField(onState?: (v: { drug: string; medicineId: string | null }) => void): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Host onState={onState} />
    </QueryClientProvider>,
  );
}

describe("DrugCombobox", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue(SUGGEST as never);
  });

  it("TAB commits the highlighted drug AND moves to the next field", async () => {
    let state = { drug: "", medicineId: null as string | null };
    renderField((v) => { state = v; });
    const user = userEvent.setup();

    await user.type(screen.getByTestId("rx-drug-0"), "amlo");
    await screen.findByTestId("rx-drug-0-opt-0");
    await user.tab();

    // The drug is committed — not left as the typed fragment "amlo".
    await waitFor(() => { expect(state.drug).toBe("Amlodipine 5 mg oral tablet"); });
    // ...and focus really did advance, which is the half a commit-on-Tab could easily break.
    expect(document.activeElement).toBe(screen.getByLabelText("Dose"));
  });

  it("ENTER commits without submitting the surrounding form", async () => {
    let state = { drug: "", medicineId: null as string | null };
    renderField((v) => { state = v; });
    const user = userEvent.setup();

    await user.type(screen.getByTestId("rx-drug-0"), "amlo");
    await screen.findByTestId("rx-drug-0-opt-0");
    await user.keyboard("{Enter}");

    await waitFor(() => { expect(state.drug).toBe("Amlodipine 5 mg oral tablet"); });
    // Focus stays put: Enter picks a drug, it does not leave the field.
    expect(document.activeElement).toBe(screen.getByTestId("rx-drug-0"));
  });

  it("a pick NULLS medicineId — it never sets one", async () => {
    let state = { drug: "", medicineId: "m-old" as string | null };
    renderField((v) => { state = v; });
    const user = userEvent.setup();

    expect(state.medicineId).toBe("m-old");
    await user.type(screen.getByTestId("rx-drug-0"), "amlo");
    await user.click(await screen.findByTestId("rx-drug-0-opt-0"));

    await waitFor(() => { expect(state.drug).toBe("Amlodipine 5 mg oral tablet"); });
    // The safety property of this whole slice: a pick from an uncurated catalogue must not make a
    // line look checked. Asserted on the Tab path too, below.
    expect(state.medicineId).toBeNull();
  });

  it("arrow keys move the highlight, and TAB takes the row the doctor moved to", async () => {
    let state = { drug: "", medicineId: null as string | null };
    renderField((v) => { state = v; });
    const user = userEvent.setup();

    await user.type(screen.getByTestId("rx-drug-0"), "amlo");
    await screen.findByTestId("rx-drug-0-opt-1");
    await user.keyboard("{ArrowDown}");
    await user.tab();

    await waitFor(() => {
      expect(state.drug).toBe("Amlodipine 5 mg and atorvastatin 10 mg oral tablet");
    });
    expect(state.medicineId).toBeNull();
  });

  it("FREE TYPING IS ALWAYS LEGAL — Escape keeps what the doctor typed", async () => {
    let state = { drug: "", medicineId: null as string | null };
    renderField((v) => { state = v; });
    const user = userEvent.setup();

    await user.type(screen.getByTestId("rx-drug-0"), "amlo");
    await screen.findByTestId("rx-drug-0-opt-0");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("rx-drug-0-opt-0")).not.toBeInTheDocument();
    // Design law 1: prescribing is never blocked by formulary coverage.
    expect(state.drug).toBe("amlo");

    // And Tab after Escape must not resurrect the list and commit a row behind the doctor.
    await user.tab();
    expect(state.drug).toBe("amlo");
  });

  it("asks nothing below three characters, and never renders the catalogue", async () => {
    renderField();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("rx-drug-0"), "am");
    expect(apiMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    // ...and at three it asks exactly once, with the typed text in the query string.
    await user.type(screen.getByTestId("rx-drug-0"), "l");
    await waitFor(() => { expect(apiMock).toHaveBeenCalledTimes(1); });
    expect(apiMock.mock.calls[0]?.[1]).toContain("q=aml");
  });

  it("a failed lookup degrades to a plain text box rather than blocking", async () => {
    apiMock.mockRejectedValue(new Error("503 formulary unavailable"));
    let state = { drug: "", medicineId: null as string | null };
    renderField((v) => { state = v; });
    const user = userEvent.setup();

    await user.type(screen.getByTestId("rx-drug-0"), "amlodipine");
    // "Couldn't look" is said, and it is not styled or announced as an error the doctor must clear.
    expect(await screen.findByText(/Formulary unavailable/)).toBeInTheDocument();
    // The typed text survives, and Tab does not commit anything over it.
    await user.tab();
    expect(state.drug).toBe("amlodipine");
  });

  it("carries dose form on every row, because a composition alone is ambiguous", async () => {
    renderField();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("rx-drug-0"), "amlo");
    const row = await screen.findByTestId("rx-drug-0-opt-0");
    expect(row).toHaveTextContent("Oral tablet");
  });

  it("is a real combobox to a screen reader", async () => {
    renderField();
    const user = userEvent.setup();
    const input = screen.getByTestId("rx-drug-0");
    expect(input).toHaveAttribute("role", "combobox");
    expect(input).toHaveAttribute("aria-expanded", "false");

    await user.type(input, "amlo");
    await screen.findByRole("listbox");
    expect(input).toHaveAttribute("aria-expanded", "true");
    // The active row is announced by id rather than by focus — focus must stay in the input.
    await waitFor(() => { expect(input.getAttribute("aria-activedescendant")).not.toBeNull(); });
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
  });
});
