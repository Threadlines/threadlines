import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { SETTINGS_GROUP_ROW_CLASS } from "../settings/settingsLayout";

/** One labelled field of the task form: the label (and a hint) on the left, the control on the right. */
export function FieldRow({
  label,
  hint,
  problem,
  warning,
  children,
  stacked = false,
  testId,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly problem?: string | undefined;
  /** Worth knowing before saving, but no reason not to. */
  readonly warning?: string | null | undefined;
  readonly children: ReactNode;
  /** The control below the label, full width (text fields). */
  readonly stacked?: boolean;
  readonly testId?: string;
}) {
  return (
    <div className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5")} data-testid={testId}>
      <div
        className={cn(
          "flex gap-2.5",
          stacked ? "flex-col" : "flex-col sm:flex-row sm:items-center sm:justify-between",
        )}
      >
        <div className={cn("min-w-0 space-y-0.5", !stacked && "sm:max-w-[45%]")}>
          <h3 className="text-[13.5px] leading-[19px] font-medium text-foreground">{label}</h3>
          {hint ? (
            <p className="text-[12.5px] leading-[18px] text-muted-foreground">{hint}</p>
          ) : null}
        </div>
        <div
          className={cn(
            "flex min-w-0 flex-wrap items-center gap-2",
            stacked ? "w-full" : "w-full sm:w-auto sm:justify-end",
          )}
        >
          {children}
        </div>
      </div>
      {problem ? <p className="pt-1.5 text-[12px] text-destructive-foreground">{problem}</p> : null}
      {warning && !problem ? (
        <p className="pt-1.5 text-[12px] text-warning-foreground">{warning}</p>
      ) : null}
    </div>
  );
}
