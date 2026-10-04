import { Undo2Icon } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SectionTick } from "../ui/threadline";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * A titled group of settings rows. Flat: a line under the heading and
 * hairlines between rows, no box. Rows and heading share one left edge.
 */
export function SettingsSection({
  title,
  description,
  icon,
  headerAction,
  children,
  className,
  headerClassName,
  contentClassName,
  ...sectionProps
}: ComponentPropsWithoutRef<"section"> & {
  title?: string;
  /** One line saying what this section is, for surfaces whose subject is not self-evident. */
  description?: ReactNode;
  icon?: ReactNode;
  headerAction?: ReactNode;
  children: ReactNode;
  /** For sections of tiles rather than rows, whose edge the heading follows. */
  headerClassName?: string;
  contentClassName?: string;
}) {
  return (
    <section {...sectionProps} className={cn("flex flex-col", className)}>
      {title !== undefined ? (
        <div className={cn("space-y-1 border-b border-border px-4 pb-2 sm:px-5", headerClassName)}>
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
              <SectionTick />
              {icon}
              {title}
            </h2>
            <div className="flex h-5 min-w-5 items-center justify-end">{headerAction}</div>
          </div>
          {description ? <p className="text-xs text-muted-foreground/80">{description}</p> : null}
        </div>
      ) : null}
      <div className={cn("relative", contentClassName)}>{children}</div>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  children,
  className,
  ...rowProps
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  title: ReactNode;
  description: ReactNode;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      {...rowProps}
      className={cn(
        "border-t border-border/60 px-4 first:border-t-0 sm:px-5",
        children ? "pt-3 pb-0" : "py-3",
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
              {title}
            </h3>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          </div>
          <p className="text-xs text-muted-foreground/80">{description}</p>
          {status ? <div className="pt-0.5 text-[11px] text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function SettingResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Reset ${label} to default`}
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">Reset to default</TooltipPopup>
    </Tooltip>
  );
}

export function SettingsPageContainer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-8">
      <div className={cn("mx-auto flex w-full max-w-3xl flex-col gap-6 sm:gap-8", className)}>
        {children}
      </div>
    </div>
  );
}
