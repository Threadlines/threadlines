import { Undo2Icon } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type SettingsSectionPath, settingsNavItemForPath } from "./settingsNavigation";

/**
 * The quiet filled block that settings sections and lists of like items sit in
 * (docs/design/design-language.md). Rows inside separate themselves with
 * `SETTINGS_GROUP_ROW_CLASS`; secondary text inside steps up for contrast.
 */
export function SettingsGroup({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      data-slot="settings-group"
      className={cn("relative surface-group", className)}
    />
  );
}

/**
 * A row in a group: the inset hairline above every row but the first starts at
 * the row's text edge (14px) and runs to the group's right edge. Rows that
 * draw their own layout (plugin cells, agent rows) use this for the divider.
 */
export const SETTINGS_GROUP_ROW_CLASS =
  "relative not-first:before:pointer-events-none not-first:before:absolute not-first:before:top-0 not-first:before:right-0 not-first:before:left-3.5 not-first:before:h-px not-first:before:bg-group-divider";

/**
 * The page's title with optional page-wide actions on its line (plain, as
 * toolbar actions), and one line under it saying what the page holds. Title
 * and description come from the settings menu entry; pages outside the menu
 * pass their own. Below `md` the mobile header already names the page, so the
 * title hides.
 */
export function SettingsPageHeader({
  section,
  title,
  description,
  actions,
}: {
  readonly section?: SettingsSectionPath;
  readonly title?: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}) {
  const navItem = section ? settingsNavItemForPath(section) : null;
  const resolvedTitle = title ?? navItem?.label;
  const resolvedDescription = description ?? navItem?.description;
  return (
    <header className="space-y-1 px-1">
      {resolvedTitle || actions ? (
        // Below `md` the title is hidden, so the line exists only for actions.
        <div className={cn("items-center gap-3 md:min-h-7", actions ? "flex" : "hidden md:flex")}>
          {resolvedTitle ? (
            <h1 className="hidden min-w-0 flex-1 truncate text-[22px] leading-7 font-semibold tracking-[-0.015em] text-foreground md:block">
              {resolvedTitle}
            </h1>
          ) : null}
          {actions ? (
            <div className="ms-auto flex shrink-0 items-center gap-1">{actions}</div>
          ) : null}
        </div>
      ) : null}
      {resolvedDescription ? (
        <p className="text-[13px] leading-[18px] text-muted-foreground">{resolvedDescription}</p>
      ) : null}
    </header>
  );
}

/**
 * A titled set of settings: the title (and an optional one-line description
 * and header action) above, the rows in a quiet group below. `bare` drops the
 * group for content that brings its own (a list split into several groups, a
 * grid of tiles).
 */
export function SettingsSection({
  title,
  description,
  headerAction,
  bare = false,
  children,
  className,
  contentClassName,
  ...sectionProps
}: ComponentPropsWithoutRef<"section"> & {
  title?: string;
  /** One line saying what this section is, for surfaces whose subject is not self-evident. */
  description?: ReactNode;
  /** An action on the whole section, drawn solid (Add agent, Browse catalog). */
  headerAction?: ReactNode;
  /** Render the content as is, without the group around it. */
  bare?: boolean;
  children: ReactNode;
  contentClassName?: string;
}) {
  const hasHeader = title !== undefined || description !== undefined || headerAction !== undefined;
  return (
    <section {...sectionProps} className={cn("flex flex-col gap-2", className)}>
      {hasHeader ? (
        <div className="flex items-end justify-between gap-3 px-1">
          <div className="min-w-0 space-y-0.5">
            {title !== undefined ? (
              <h2 className="text-[15px] leading-5 font-semibold text-foreground">{title}</h2>
            ) : null}
            {description ? (
              <p className="text-[12.5px] leading-[18px] text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {headerAction ? (
            <div className="flex shrink-0 items-center gap-1.5">{headerAction}</div>
          ) : null}
        </div>
      ) : null}
      {bare ? (
        <div className={cn("relative", contentClassName)}>{children}</div>
      ) : (
        <SettingsGroup className={contentClassName}>{children}</SettingsGroup>
      )}
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
        SETTINGS_GROUP_ROW_CLASS,
        "px-3.5",
        children ? "pt-2.5 pb-0" : "py-2.5",
        className,
      )}
    >
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-[13.5px] leading-[19px] font-medium text-foreground">{title}</h3>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          </div>
          <p className="text-[12.5px] leading-[18px] text-muted-foreground">{description}</p>
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

/**
 * The scrolling page every settings tab renders into: a 720px column, or 960px
 * for pages built around wide lists (Plugins & Skills, Instructions,
 * Keybindings).
 */
export function SettingsPageContainer({
  children,
  wide = false,
  className,
}: {
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  return (
    <div className="flex-1 overflow-y-auto px-4 pt-5 pb-8 sm:px-8 sm:pt-8 sm:pb-12">
      <div
        className={cn(
          "mx-auto flex w-full flex-col gap-7",
          wide ? "max-w-[960px]" : "max-w-[720px]",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
