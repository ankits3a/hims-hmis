import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm, FormProvider } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { FormKit, TextField } from "./form-kit";

const schema = z.object({ a: z.string().min(1, "A is required"), b: z.string().min(1) });

function Harness({ onSubmit }: { onSubmit: (v: unknown) => void }): React.ReactElement {
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { a: "", b: "" } });
  return (
    <FormProvider {...form}>
      <FormKit onSubmit={form.handleSubmit(onSubmit)}>
        <TextField name="a" label="Field A" autoFocus />
        <TextField name="b" label="Field B" />
        <button type="submit">Go</button>
      </FormKit>
    </FormProvider>
  );
}

it("Enter advances focus to the next field instead of submitting (keyboard-first, §15)", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<Harness onSubmit={onSubmit} />);
  await user.keyboard("hello{Enter}");
  expect(screen.getByLabelText("Field B")).toHaveFocus();
  expect(onSubmit).not.toHaveBeenCalled();
});

it("shows zod errors inline with role=alert", async () => {
  const user = userEvent.setup();
  render(<Harness onSubmit={vi.fn()} />);
  await user.click(screen.getByText("Go"));
  expect(await screen.findByText("A is required")).toHaveAttribute("role", "alert");
});

it("Alt+S submits from anywhere in the form", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<Harness onSubmit={onSubmit} />);
  await user.type(screen.getByLabelText("Field A"), "x");
  await user.type(screen.getByLabelText("Field B"), "y");
  await user.keyboard("{Alt>}s{/Alt}");
  expect(onSubmit).toHaveBeenCalled();
});
