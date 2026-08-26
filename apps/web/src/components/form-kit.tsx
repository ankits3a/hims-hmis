import { useFormContext } from "react-hook-form";
import { cn } from "@/lib/utils";

/**
 * Keyboard-first form primitives (§15): Enter advances to the next [data-field] control
 * (desks tab through with one hand on the keyboard), Alt+S submits, errors are inline
 * role=alert. Built on react-hook-form context; screens wrap with FormProvider.
 */
export function FormKit({
  onSubmit,
  children,
  className,
}: {
  onSubmit: (e?: React.BaseSyntheticEvent) => Promise<void> | void;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLFormElement>): void => {
    if (e.altKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      void onSubmit();
      return;
    }
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      const fields = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-field]"));
      const idx = fields.indexOf(e.target);
      const next = fields[idx + 1];
      if (next) next.focus();
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(e);
      }}
      onKeyDown={handleKeyDown}
      className={cn("space-y-3", className)}
      noValidate
    >
      {children}
    </form>
  );
}

function fieldError(errors: Record<string, unknown>, name: string): string | undefined {
  const parts = name.split(".");
  let cur: unknown = errors;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  const msg = (cur as { message?: unknown } | undefined)?.message;
  return typeof msg === "string" ? msg : undefined;
}

export function TextField({
  name,
  label,
  type = "text",
  autoFocus,
  placeholder,
  className,
  onChange,
}: {
  name: string;
  label: string;
  type?: string;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
  /**
   * Runs BESIDE the form's own change handler, never instead of it — this is react-hook-form's
   * `register(name, { onChange })` affordance, exposed rather than re-implemented. Added by Plan
   * 16a's close remediation (C1): a field whose value invalidates a sibling field needs to say so
   * at the moment it changes, and the alternative was a `watch` subscription that re-renders the
   * whole form on every keystroke.
   */
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
}): React.ReactElement {
  const { register, formState } = useFormContext();
  const error = fieldError(formState.errors as Record<string, unknown>, name);
  return (
    <div className={className}>
      <label className="block text-sm font-medium" htmlFor={`f-${name}`}>{label}</label>
      <input
        id={`f-${name}`}
        data-field
        type={type}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className="w-full rounded border px-2 py-1"
        {...register(name, onChange === undefined ? {} : { onChange })}
      />
      {error !== undefined && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

export function SelectField({
  name,
  label,
  options,
  className,
}: {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  className?: string;
}): React.ReactElement {
  const { register, formState } = useFormContext();
  const error = fieldError(formState.errors as Record<string, unknown>, name);
  return (
    <div className={className}>
      <label className="block text-sm font-medium" htmlFor={`f-${name}`}>{label}</label>
      <select id={`f-${name}`} data-field className="w-full rounded border px-2 py-1" {...register(name)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {error !== undefined && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

export function CheckboxField({
  name,
  label,
  className,
}: {
  name: string;
  label: string;
  className?: string;
}): React.ReactElement {
  const { register } = useFormContext();
  return (
    <label className={cn("flex items-center gap-2 text-sm", className)}>
      <input type="checkbox" data-field {...register(name)} />
      {label}
    </label>
  );
}
