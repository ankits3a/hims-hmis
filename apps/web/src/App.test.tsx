import { render, screen } from "@testing-library/react";
import { App } from "./App";

it("boots to the sign-in screen when no token is stored", async () => {
  render(<App />);
  // PLAN DEFECT: "Sign in" is both the login heading (t("login.title")) and the submit
  // button's label (t("login.submit")) in en.json, so a plain findByText("Sign in") matches
  // two elements. The plan's own prose says to "assert the login heading instead", so this
  // scopes the query to the heading role, which is unambiguous.
  expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
});
