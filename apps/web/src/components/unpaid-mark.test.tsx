import { render, screen } from "@testing-library/react";
import { UnpaidMark } from "./unpaid-mark";
import "../lib/i18n";

/**
 * ═══ FD-32 — ONE WARNING, THREE DESKS (OWNER RULING 2026-09-13) ═══
 *
 * Owner: *"A symbol to symbolize in the vital dashboard that the user has not yet paid … also on
 * doctor consultation and the desk outside the consultation room."* One component so the three
 * cannot drift; these rows pin the three states it has to tell apart.
 */
describe("UnpaidMark", () => {
  it("says NOTHING for a paid patient — the mark must not become wallpaper", () => {
    const { container } = render(<UnpaidMark unpaid={false} bypass={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("a paid patient stays silent even if a bypass was once granted", () => {
    /* The waiver is history on a visit that has since been paid; a warning there is a false alarm,
       and a desk that learns the mark lies stops reading it. */
    const { container } = render(<UnpaidMark unpaid={false} bypass={{ by: "u-1", reason: "emergency" }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("UNPAID and not waived is the loud one — this patient should be at the counter", () => {
    render(<UnpaidMark unpaid bypass={null} />);
    expect(screen.getByTestId("unpaid-mark")).toHaveTextContent("NOT PAID");
    expect(screen.queryByTestId("unpaid-bypassed")).toBeNull();
  });

  it("UNPAID and WAIVED names the reason, so the desk does not send an emergency back", () => {
    render(<UnpaidMark unpaid bypass={{ by: "u-1", reason: "emergency — breathless, sent straight through" }} />);
    const mark = screen.getByTestId("unpaid-bypassed");
    /* The sentence is the point. A bare icon is ignored by the second week; a reason is acted on. */
    expect(mark).toHaveTextContent("emergency — breathless, sent straight through");
    /* And it is NOT the red one: the front desk did this on purpose and the desk reading it must
       not treat the patient as a fault to be corrected. */
    expect(screen.queryByTestId("unpaid-mark")).toBeNull();
  });
});
