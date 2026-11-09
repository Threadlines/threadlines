import type { ReactNode } from "react";

/**
 * One field in a dialog's form: its name over the control, "(optional)" when
 * it may stay empty, and a hint under it. The hint sits outside the label, so
 * a field's accessible name is only its label.
 */
export function LabeledField({
  label,
  hint,
  optional = false,
  children,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly optional?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">
          {label}
          {optional ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}
        </span>
        {children}
      </label>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}
