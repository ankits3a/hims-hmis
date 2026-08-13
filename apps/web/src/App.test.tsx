import { render, screen } from "@testing-library/react";
import { App } from "./App";

it("renders the app shell placeholder", () => {
  render(<App />);
  expect(screen.getByText("HMIS")).toBeInTheDocument();
});
