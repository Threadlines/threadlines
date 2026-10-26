import { Link } from "@tanstack/react-router";
import {
  DownloadIcon,
  Link2OffIcon,
  LoaderCircleIcon,
  MonitorIcon,
  RefreshCwIcon,
  SmartphoneIcon,
  WifiOffIcon,
} from "lucide-react";
import { type ReactNode } from "react";

import { APP_BASE_NAME, APP_DISPLAY_NAME, DESKTOP_DOWNLOAD_URL } from "../branding";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { cn } from "../lib/utils";
import { openConnectComputerDialog } from "./settings/connections/JoinComputerDialog";
import { CONNECTIONS_SETTINGS_SECTION_PATH } from "./settings/settingsNavigation";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset, SidebarOpenTrigger } from "./ui/sidebar";

/**
 * Full-content status surfaces for sessions that cannot show the app yet: the
 * hosted (phone) app waiting on its relay bootstrap, a freshly paired browser
 * waiting on its first workspace snapshot, and a device whose access was taken
 * away. Routes render these instead of an empty shell that reads as "you have
 * nothing here".
 */
function ConnectionStatusState({
  icon,
  title,
  description,
  detail,
  body,
  action,
  chrome = "sidebar-inset",
}: {
  icon: ReactNode;
  title: string;
  description: string;
  detail?: string;
  /** Full-width content between the description and the action. */
  body?: ReactNode;
  action?: ReactNode;
  /**
   * `sidebar-inset` is for states a route renders inside the app shell, where
   * the sidebar is still there to navigate away to. `standalone` is for states
   * that replace the whole app, which have no sidebar to open and must not
   * depend on one being mounted.
   */
  chrome?: "sidebar-inset" | "standalone";
}) {
  const Shell = chrome === "standalone" ? StandaloneShell : SidebarInsetShell;

  return (
    <Shell>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 py-2 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5 sm:py-3",
          )}
        >
          <div className="flex items-center gap-2">
            {chrome === "sidebar-inset" ? <SidebarOpenTrigger className="size-7 shrink-0" /> : null}
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
              {body}
              {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </Shell>
  );
}

function SidebarInsetShell({ children }: { children: ReactNode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-auto">
      {children}
    </SidebarInset>
  );
}

function StandaloneShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden overscroll-y-none bg-background text-foreground">
      {children}
    </div>
  );
}

export function HostedStaticLoadingState({ label }: { label: string | null }) {
  return (
    <ConnectionStatusState
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

/**
 * What a browser paired directly to a computer sees between "the socket is up"
 * and "the first workspace snapshot arrived". Without it the index route falls
 * straight through to the cold-start empty state, so a phone that just scanned
 * a QR code is told it has no projects a second before its projects appear.
 */
export function WorkspaceLoadingState() {
  return (
    <ConnectionStatusState
      icon={<LoaderCircleIcon className="size-5 animate-spin" />}
      title="Loading your workspace"
      description="Connected. Loading projects and threads."
      detail="This takes a moment after pairing, while the first workspace snapshot arrives."
    />
  );
}

/**
 * What a device sees once the computer revokes its access. The socket is gone
 * for good, so this replaces the app shell rather than sitting behind a
 * reconnect spinner that can never succeed.
 */
export function AccessRemovedState() {
  return (
    <ConnectionStatusState
      chrome="standalone"
      icon={<WifiOffIcon className="size-5" />}
      title="Access removed"
      description="This device was disconnected from the computer. Pair again to reconnect."
      detail="On the computer, open Settings, then Connections, then Connect a device to pair again."
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
 * The root error screen while it recovers a page that outlived its build
 * (staleBuild.ts): checking the app can be reached, then reloading. It
 * replaces the whole app, since the error took the shell down.
 */
export function AppReloadingState() {
  return (
    <ConnectionStatusState
      chrome="standalone"
      icon={<LoaderCircleIcon className="size-5 animate-spin" />}
      title="Loading the latest version"
      description={`${APP_BASE_NAME} changed while this page was open.`}
    />
  );
}

/**
 * The same failure when the page can't reload on its own: the app can't be
 * reached (the page reloads once it can), or this reload already ran and the
 * page failed again.
 */
export function AppReloadNeededState({ unreachable }: { unreachable: boolean }) {
  return (
    <ConnectionStatusState
      chrome="standalone"
      icon={unreachable ? <WifiOffIcon className="size-5" /> : <RefreshCwIcon className="size-5" />}
      title={unreachable ? `Can't reach ${APP_BASE_NAME}` : `Part of ${APP_BASE_NAME} didn't load`}
      description={
        unreachable
          ? "Part of the app couldn't load. This page reloads by itself once it can connect again."
          : "Reloading usually fixes this. If it keeps happening, check your connection."
      }
      action={
        <Button size="sm" onClick={() => window.location.reload()}>
          <RefreshCwIcon className="size-3.5" />
          Reload
        </Button>
      }
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
    <ConnectionStatusState
      icon={<WifiOffIcon className="size-5" />}
      title="Could not load your desktop"
      description={
        label
          ? `${label} is paired, but this phone could not finish loading it.`
          : "This phone is paired, but could not finish loading the desktop app."
      }
      detail={
        message ??
        "Keep Threadlines open on your computer, then reload. If it still can't connect, open Settings › Connections › Connect a device there and scan the new QR code."
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

const PAIRING_STEPS = [
  {
    id: "install",
    body: (
      <>
        On your computer, install {APP_BASE_NAME} from{" "}
        <a
          className="font-mono text-foreground underline underline-offset-2"
          href={DESKTOP_DOWNLOAD_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          threadlines.dev/download
        </a>
      </>
    ),
  },
  {
    id: "add-device",
    body: (
      <>
        In the desktop app, open{" "}
        <span className="font-medium text-foreground">
          Settings → Connections → Connect a device
        </span>
      </>
    ),
  },
  {
    id: "scan",
    body: <>Scan the QR code it shows with this phone&rsquo;s camera</>,
  },
] as const;

/**
 * What a phone that has never paired sees.
 *
 * A phone cannot install the desktop app on itself, so there is no download
 * button here: its job is to receive a pairing, and the three steps name where
 * that pairing is minted. Scanning the QR code opens this page with the token
 * already filled in, so the one action is for people whose computer is in
 * another room.
 */
function HostedStaticPhoneOnboardingState() {
  return (
    <ConnectionStatusState
      icon={<SmartphoneIcon className="size-5" />}
      title="Pair with your computer"
      description={`${APP_BASE_NAME} runs on your computer; this phone connects to it.`}
      body={<PairingStepList steps={PAIRING_STEPS} />}
      action={
        <Button size="sm" render={<Link to={CONNECTIONS_SETTINGS_SECTION_PATH} />}>
          I have a setup link
        </Button>
      }
    />
  );
}

/** Numbered pairing steps, ruled like a settings list. */
function PairingStepList({
  steps,
}: {
  steps: ReadonlyArray<{ readonly id: string; readonly body: ReactNode }>;
}) {
  return (
    <ol className="mt-6 border-t border-border text-left">
      {steps.map((step, index) => (
        <li
          key={step.id}
          className="flex gap-3 border-b border-border py-3 text-sm text-muted-foreground"
        >
          <span className="pt-0.5 font-mono text-xs text-muted-foreground/62">{index + 1}</span>
          <span className="min-w-0">{step.body}</span>
        </li>
      ))}
    </ol>
  );
}

const LINK_PAIRING_STEPS = [
  {
    id: "connect-device",
    body: (
      <>
        On your computer, open{" "}
        <span className="font-medium text-foreground">
          Settings → Connections → Connect a device
        </span>
      </>
    ),
  },
  {
    id: "enter-code",
    body: (
      <>
        Here, tap <span className="font-medium text-foreground">Enter code</span> and type the code
        it shows
      </>
    ),
  },
] as const;

/**
 * What the hosted app shows for a link to a computer this browser hasn't
 * paired with, typically a thread address copied from another browser.
 *
 * Pairings live in the browser's own storage, so Safari and Chrome on the same
 * phone each pair separately. The code is the step that pairs this browser in
 * particular: a QR code opens in the phone's default browser, which may be the
 * other one.
 */
export function HostedStaticLinkNotPairedState({
  pairedElsewhere,
}: {
  /** Whether this browser is paired with some other computer. */
  pairedElsewhere: boolean;
}) {
  return (
    <ConnectionStatusState
      icon={<Link2OffIcon className="size-5" />}
      title={
        pairedElsewhere
          ? "This browser isn't paired with that computer"
          : "This browser isn't paired yet"
      }
      description="Each browser keeps its own pairing, even on the same phone. Pair this one and the link opens here."
      body={<PairingStepList steps={LINK_PAIRING_STEPS} />}
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" onClick={openConnectComputerDialog}>
            Enter code
          </Button>
          {pairedElsewhere ? (
            <Button size="sm" variant="outline" render={<Link to="/" />}>
              Go to your threads
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

/**
 * The same cold start on a computer, where installing the desktop app is
 * something this browser's machine can actually do. The desktop app is the
 * only place that mints a setup link (Settings, then Connections, then Connect
 * a device), so the copy names that path rather than implying this browser can
 * start pairing on its own.
 */
function HostedStaticDesktopOnboardingState() {
  return (
    <ConnectionStatusState
      icon={<MonitorIcon className="size-5" />}
      title="Open the desktop app to get started"
      description="Threadlines runs on your computer. Install the desktop app there, then pair this browser so it can reach your projects and threads."
      detail="The desktop app creates the setup link: open Settings, then Connections, then Connect a device. Paste that link here to finish pairing."
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
          <Button
            size="sm"
            variant="outline"
            render={<Link to={CONNECTIONS_SETTINGS_SECTION_PATH} />}
          >
            <SmartphoneIcon className="size-3.5" />
            Pair this browser
          </Button>
        </div>
      }
    />
  );
}

export function HostedStaticOnboardingState() {
  const isPhoneViewport = useMediaQuery("max-sm");
  return isPhoneViewport ? (
    <HostedStaticPhoneOnboardingState />
  ) : (
    <HostedStaticDesktopOnboardingState />
  );
}
