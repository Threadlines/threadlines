import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import {
  endProviderUpdateRun,
  syncProviderUpdateRun,
  takeProviderUpdateNotice,
  useProviderUpdateRunStore,
} from "../providerUpdateRunStore";
import { useServerConfig, useServerProviders } from "../rpc/serverState";
import {
  describeProviderUpdateRun,
  type ProviderUpdateProgressItem,
  type ProviderUpdateProgressStatus,
  type ProviderUpdateRunView,
} from "./ProviderUpdateLaunchNotification.logic";
import { SETUP_ROUTE_PATH } from "./setup/firstRunGateState";
import { stackedThreadToast, toastManager, type NoticeAddOptions } from "./ui/toast";
import { cn } from "~/lib/utils";

const STATUS_TEXT: Record<ProviderUpdateProgressStatus, string> = {
  queued: "text-muted-foreground",
  running: "text-primary-readable",
  succeeded: "text-success",
  failed: "text-destructive",
  unchanged: "text-warning",
};

function StatusIcon({ status }: { status: ProviderUpdateProgressStatus }) {
  switch (status) {
    case "queued":
      return <CircleDashedIcon className="size-3 shrink-0 text-muted-foreground" />;
    case "running":
      return (
        <LoaderCircleIcon className="size-3 shrink-0 animate-spin text-primary-readable motion-reduce:animate-none" />
      );
    case "succeeded":
      return <CheckIcon className="size-3 shrink-0 text-success" />;
    case "failed":
      return <CircleAlertIcon className="size-3 shrink-0 text-destructive" />;
    case "unchanged":
      return <TriangleAlertIcon className="size-3 shrink-0 text-warning" />;
  }
}

/** One row per agent, with why a failed one stopped underneath. Spans: it sits in a `<p>`. */
function ProviderUpdateRows({
  items,
  footer,
}: {
  items: ReadonlyArray<ProviderUpdateProgressItem>;
  footer: string | null;
}) {
  return (
    <span className="grid gap-1 pt-0.5" data-testid="provider-update-rows">
      {items.map((item) => (
        <span
          className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1.5"
          key={item.key}
        >
          {/* Boxed: a turning icon's corners would otherwise poke out of the
              notice's scroll area and flash a scrollbar. */}
          <span className="inline-flex size-3 overflow-hidden">
            <StatusIcon status={item.status} />
          </span>
          <span className="min-w-0 truncate text-foreground">{item.label}</span>
          <span className={cn("shrink-0 font-medium", STATUS_TEXT[item.status])}>
            {item.statusLabel}
          </span>
          {item.message ? (
            <span className="col-span-2 col-start-2 wrap-break-word">{item.message}</span>
          ) : null}
        </span>
      ))}
      {footer ? <span>{footer}</span> : null}
    </span>
  );
}

function describeNotice(view: ProviderUpdateRunView): ReactNode {
  return view.items.length === 1 ? (
    view.detail
  ) : (
    <ProviderUpdateRows footer={view.detail} items={view.items} />
  );
}

/**
 * The notice for an agent update run, however it started: work in progress
 * while it runs, then its result in the same place. A failed or unfinished
 * update stays until closed and offers Settings; a finished one fades.
 */
function noticeForRun(
  view: ProviderUpdateRunView,
  input: { readonly onClose: (() => void) | undefined; readonly openSettings: () => void },
): NoticeAddOptions {
  const description = describeNotice(view);
  // Every phase sets its own timing and close callback: a launch prompt taken
  // over was "stay until closed", and an update keeps any field it doesn't
  // name. Base UI's `onClose` hears every way a notice closes (button, swipe,
  // Escape), which `data.onClose` doesn't.
  const notice = (options: NoticeAddOptions): NoticeAddOptions => ({
    ...options,
    timeout: undefined,
    onClose: input.onClose,
  });
  switch (view.phase) {
    case "running":
      return notice({
        ...stackedThreadToast({
          type: "loading",
          title: view.title,
          description,
          data: { hideCopyButton: true },
        }),
        // Taking over the launch prompt: its buttons go.
        actionProps: undefined,
      });
    case "succeeded":
      return notice({
        ...stackedThreadToast({
          type: "success",
          title: view.title,
          description,
          data: { hideCopyButton: true },
        }),
        actionProps: undefined,
      });
    case "failed":
    case "unchanged":
      return notice(
        stackedThreadToast({
          type: view.phase === "failed" ? "error" : "warning",
          title: view.title,
          description,
          actionProps: { children: "Settings", onClick: input.openSettings },
          actionVariant: "outline",
        }),
      );
  }
}

/**
 * Follows agent updates on the computer this window shows and reports them as
 * a notice: the launch prompt's Update, Settings, setup, another window or
 * device all end up here. Mounted once, in every kind of client.
 *
 * Closing the notice while it runs leaves the run going; a failure still
 * comes back as a new notice, a success finishes quietly. On the setup
 * screen, which shows its own progress, only failures appear.
 */
export function ProviderUpdateProgress() {
  const navigate = useNavigate();
  const environmentId = useServerConfig()?.environment.environmentId ?? null;
  const providers = useServerProviders();
  // Changes when a caller starts an update; with a snapshot to apply, the
  // effect takes the run as that snapshot leaves it instead.
  const storedRun = useProviderUpdateRunStore((state) => state.run);
  const onSetupScreen = useLocation({
    select: (location) => location.pathname === SETUP_ROUTE_PATH,
  });
  /** The running run's notice; `closed` once the user put it away. */
  const noticeRef = useRef<{
    id: string | null;
    readonly environmentId: string;
    closed: boolean;
    readonly onClose: () => void;
  } | null>(null);
  /** Every notice shown for a run, with its computer, so a switch can retire them. */
  const shownRef = useRef(new Map<string, string>());

  useEffect(() => {
    // Notices about another computer no longer apply once the window shows this one.
    for (const [id, shownEnvironmentId] of shownRef.current) {
      if (shownEnvironmentId === environmentId) continue;
      toastManager.close(id);
      shownRef.current.delete(id);
    }
    if (noticeRef.current && noticeRef.current.environmentId !== environmentId) {
      noticeRef.current = null;
    }
    // Apply this snapshot first, so a member that joined in it isn't lost to
    // another member finishing in it.
    const run =
      environmentId === null ? storedRun : syncProviderUpdateRun(environmentId, providers);
    if (!run || run.environmentId !== environmentId) {
      noticeRef.current = null;
      return;
    }

    const view = describeProviderUpdateRun(run, providers);
    const openSettings = () => void navigate({ to: "/settings/providers" });
    const remember = (id: string) => {
      shownRef.current.set(id, run.environmentId);
      return id;
    };

    if (view.phase === "running") {
      const notice = noticeRef.current;
      if (notice?.id) {
        if (!notice.closed) {
          toastManager.update(
            notice.id,
            noticeForRun(view, { onClose: notice.onClose, openSettings }),
          );
        }
        return;
      }
      if (onSetupScreen) return;
      const handle = {
        id: null as string | null,
        environmentId: run.environmentId,
        closed: false,
        onClose: () => {
          handle.closed = true;
          if (handle.id !== null) shownRef.current.delete(handle.id);
        },
      };
      const options = noticeForRun(view, { onClose: handle.onClose, openSettings });
      const adoptedId = takeProviderUpdateNotice();
      if (adoptedId !== null) toastManager.update(adoptedId, options);
      handle.id = remember(adoptedId ?? toastManager.add(options));
      noticeRef.current = handle;
      return;
    }

    // Finished. A run can end before it was ever seen running; the prompt it
    // started from then shows the result directly.
    const notice = noticeRef.current;
    const openNoticeId = notice ? (notice.closed ? null : notice.id) : takeProviderUpdateNotice();
    const options = noticeForRun(view, { onClose: undefined, openSettings });
    if (openNoticeId !== null) {
      toastManager.update(openNoticeId, options);
      remember(openNoticeId);
    } else if (view.phase !== "succeeded") {
      remember(toastManager.add(options));
    }
    noticeRef.current = null;
    endProviderUpdateRun();
  }, [environmentId, navigate, onSetupScreen, providers, storedRun]);

  return null;
}
