import { LoaderCircleIcon, MonitorIcon, RefreshCwIcon, WifiOffIcon } from "lucide-react";
import { type ReactNode } from "react";

import { APP_DISPLAY_NAME } from "../branding";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset, SidebarOpenTrigger } from "./ui/sidebar";

/**
 * Full-content status surfaces for hosted (phone) sessions, where the app has
 * no local backend and every route depends on the relay bootstrap. Routes
 * render these instead of nothing while that bootstrap is pending or failed.
 */
function HostedStaticStatusState({
  icon,
  title,
  description,
  detail,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 py-2 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5 sm:py-3",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex items-center gap-2">
            <SidebarOpenTrigger className="size-7 shrink-0" />
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                {icon}
              </div>
              <EmptyTitle className="text-xl text-foreground">{title}</EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                {description}
              </EmptyDescription>
              <p className="mx-auto mt-3 max-w-md text-xs leading-relaxed text-muted-foreground/62">
                {detail}
              </p>
              {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}

export function HostedStaticLoadingState({ label }: { label: string | null }) {
  return (
    <HostedStaticStatusState
      icon={<LoaderCircleIcon className="size-5 animate-spin" />}
      title="Loading your desktop"
      description={
        label
          ? `Connecting to ${label} and loading projects and threads.`
          : "Connecting to your desktop and loading projects and threads."
      }
      detail="This can take a few seconds after pairing while the relay opens and the first workspace snapshot arrives."
    />
  );
}

export function HostedStaticConnectionErrorState({
  label,
  message,
}: {
  label: string | null;
  message: string | null;
}) {
  return (
    <HostedStaticStatusState
      icon={<WifiOffIcon className="size-5" />}
      title="Could not load your desktop"
      description={
        label
          ? `${label} is paired, but this phone could not finish loading it.`
          : "This phone is paired, but could not finish loading the desktop app."
      }
      detail={
        message ??
        "Keep the desktop app open, then reload. If the phone link expired or the app restarted, create a new link."
      }
      action={
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          <RefreshCwIcon className="size-3.5" />
          Reload
        </Button>
      }
    />
  );
}

export function HostedStaticOnboardingState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 py-2 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5 sm:py-3",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex items-center gap-2">
            <SidebarOpenTrigger className="size-7 shrink-0" />
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <MonitorIcon className="size-5" />
              </div>
              <EmptyTitle className="text-foreground text-xl">
                Open the desktop app to get started
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                Threadlines is focused on the local desktop workflow. Start or resume a session from
                the desktop app.
              </EmptyDescription>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
