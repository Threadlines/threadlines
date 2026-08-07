import { Link } from "@tanstack/react-router";
import {
  DownloadIcon,
  LoaderCircleIcon,
  MonitorIcon,
  RefreshCwIcon,
  SmartphoneIcon,
  WifiOffIcon,
} from "lucide-react";
import { type ReactNode } from "react";

import { APP_DISPLAY_NAME, DESKTOP_DOWNLOAD_URL } from "../branding";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { cn } from "../lib/utils";
import { DEVICES_SETTINGS_SECTION_PATH } from "./settings/settingsNavigation";
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
  detail?: string;
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
              {detail ? (
                <p className="mx-auto mt-3 max-w-md text-xs leading-relaxed text-muted-foreground/62">
                  {detail}
                </p>
              ) : null}
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

/**
 * What a visitor who has never paired sees. The desktop app is the only place
 * that mints a setup link (Settings, then Devices, then Add device), so the
 * copy names that path rather than implying this browser can start pairing on
 * its own, and the two actions cover both halves of the setup: get the app,
 * then bring the link back here.
 */
export function HostedStaticOnboardingState() {
  return (
    <HostedStaticStatusState
      icon={<MonitorIcon className="size-5" />}
      title="Open the desktop app to get started"
      description="Threadlines runs on your computer. Install the desktop app there, then pair this browser so it can reach your projects and threads."
      detail="The desktop app creates the setup link: open Settings, then Devices, then Add device. Paste that link here to finish pairing."
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            size="sm"
            render={
              <a href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">
                <DownloadIcon className="size-3.5" />
                Download the desktop app
              </a>
            }
          />
          <Button size="sm" variant="outline" render={<Link to={DEVICES_SETTINGS_SECTION_PATH} />}>
            <SmartphoneIcon className="size-3.5" />
            Pair this browser
          </Button>
        </div>
      }
    />
  );
}
