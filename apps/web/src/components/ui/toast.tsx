"use client";

import {
  Toast,
  type ToastManagerAddOptions,
  type ToastManagerUpdateOptions,
  type ToastObject,
} from "@base-ui/react/toast";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useParams } from "@tanstack/react-router";
import { type ScopedThreadRef, type ThreadId } from "@threadlines/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  InfoIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { buttonVariants } from "~/components/ui/button";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { usePageAttended } from "~/lib/pageAttention";
import { resolveThreadRouteTarget } from "~/threadRoutes";
import { useNoticesRaisedAboveBackdrops } from "./noticeLayer";
import {
  buildVisibleToastLayout,
  isAnotherThread,
  NOTICE_STACK_LIMIT,
  resolveHiddenNoticeVisibleMs,
  resolveNoticeVisibleMs,
  selectStackNotices,
  shouldHideCollapsedToastContent,
  shouldRenderThreadScopedToast,
  shouldStackNoticeBody,
} from "./toast.logic";

export type ThreadToastData = {
  /** Shows the notice only while this thread is open. */
  threadRef?: ScopedThreadRef | null;
  threadId?: ThreadId | null;
  /**
   * Shows the notice everywhere; while another thread is open it names this
   * one and offers to open it. For failures that land after the user moved on.
   */
  aboutThread?: {
    readonly threadRef: ScopedThreadRef;
    readonly title: string;
    readonly open: () => void;
  };
  leadingIcon?: ReactNode;
  tooltipStyle?: boolean;
  onClose?: (() => void) | undefined;
  /** How long the notice stays once on screen; overrides the default for its type. */
  dismissAfterVisibleMs?: number;
  hideCopyButton?: boolean;
  secondaryActionProps?: ComponentPropsWithoutRef<"button">;
  secondaryActionVariant?:
    | "default"
    | "destructive"
    | "destructive-outline"
    | "ghost"
    | "link"
    | "outline"
    | "secondary";
  /** Optional extra body shown after toggling “Show details” (e.g. a list of pending RPCs). */
  expandableContent?: ReactNode;
  expandableLabels?: { expand?: string; collapse?: string };
  /** When set with `expandableContent`, the summary + label act as one text disclosure (no separate chevron row). */
  expandableDescriptionTrigger?: boolean;
  /** Shows the whole title and reason even with no button; set by `stackedThreadToast`. */
  actionLayout?: "stacked-end";
  actionVariant?:
    | "default"
    | "destructive"
    | "destructive-outline"
    | "ghost"
    | "link"
    | "outline"
    | "secondary";
};

/**
 * Notices on the main stack time out by how long they have been on screen
 * (`resolveNoticeVisibleMs`), not by Base UI's wall clock, which keeps running
 * for a notice that is waiting for a slot or belongs to another thread. So
 * `timeout` only takes 0, "stay until closed"; a custom duration goes in
 * `data.dismissAfterVisibleMs`.
 */
type NoticeTimeout = { timeout?: 0 | undefined };
export type NoticeAddOptions = Omit<ToastManagerAddOptions<ThreadToastData>, "timeout"> &
  NoticeTimeout;
export type NoticeUpdateOptions = Omit<ToastManagerUpdateOptions<ThreadToastData>, "timeout"> &
  NoticeTimeout;
type NoticePromiseOption<Settled> =
  | string
  | NoticeUpdateOptions
  | ((settled: Settled) => string | NoticeUpdateOptions);
interface NoticeManager {
  readonly add: (options: NoticeAddOptions) => string;
  readonly close: (id?: string) => void;
  readonly update: (
    id: string,
    updates:
      | NoticeUpdateOptions
      | ((previous: ToastObject<ThreadToastData>) => NoticeUpdateOptions),
  ) => void;
  readonly promise: <Value>(
    promiseValue: Promise<Value>,
    options: {
      readonly loading: string | NoticeUpdateOptions;
      readonly success: NoticePromiseOption<Value>;
      readonly error: NoticePromiseOption<unknown>;
    },
  ) => Promise<Value>;
}

type BaseToastManager = ReturnType<typeof Toast.createToastManager<ThreadToastData>>;

/**
 * Base UI's manager drops anything sent before its provider subscribes, and
 * the provider subscribes in an effect, after its children's first effects
 * have run: a notice raised on page load (an update already running when the
 * window opens) vanished. Calls made before the provider listens wait, and
 * replay in order once it does.
 */
function createNoticeManager(): BaseToastManager {
  const base = Toast.createToastManager<ThreadToastData>();
  let subscribers = 0;
  let waiting: Array<() => void> = [];
  let nextId = 1;
  const whenListening = (call: () => void) => {
    if (subscribers > 0) call();
    else waiting.push(call);
  };
  return {
    " subscribe": (listener) => {
      const unsubscribe = base[" subscribe"](listener);
      subscribers += 1;
      const calls = waiting;
      waiting = [];
      for (const call of calls) call();
      return () => {
        subscribers -= 1;
        unsubscribe();
      };
    },
    add: (options) => {
      // Known now, though the notice may only be sent later.
      const id = options.id ?? `notice-${nextId++}`;
      whenListening(() => base.add({ ...options, id }));
      return id;
    },
    close: (id) => whenListening(() => base.close(id)),
    update: (id, updates) => whenListening(() => base.update(id, updates)),
    promise: (promiseValue, options) => {
      if (subscribers > 0) return base.promise(promiseValue, options);
      // The caller holds `promiseValue`; this copy only drives the notice.
      whenListening(() => {
        base.promise(promiseValue, options).catch(() => undefined);
      });
      return promiseValue;
    },
  };
}

const baseToastManager = createNoticeManager();
const toastManager: NoticeManager = baseToastManager;
const anchoredToastManager = Toast.createToastManager<ThreadToastData>();
type ToastId = ReturnType<typeof toastManager.add>;

const TOAST_ICONS = {
  error: CircleAlertIcon,
  info: InfoIcon,
  loading: LoaderCircleIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
} as const;

/**
 * A reason is never cut short: past ten lines (a long Git failure, say) it
 * scrolls inside the notice instead of growing it further. Its element is
 * marked `data-base-ui-swipe-ignore`, so a finger scrolls it rather than
 * swiping the notice away.
 */
const toastReasonCapClassName = "max-h-40 overflow-y-auto overscroll-contain";

/** Corner controls kept inside the notice edge: close, and copy for an error. */
function toastCornerContainerClassName(singleLine: boolean): string {
  return cn(
    "absolute right-1.5 z-20 flex items-center gap-0.5",
    // Beside the title line, so opening a compact notice doesn't move them.
    singleLine ? "top-1/2 -translate-y-1/2" : "top-1.5",
  );
}
const toastCornerOrbClass = cn(
  "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/50 opacity-60 outline-none sm:opacity-0",
  "transition-[color,background-color,opacity] hover:bg-accent/60 hover:text-foreground hover:opacity-100 group-hover/toast:opacity-100 focus-visible:opacity-100",
  "focus-ring",
);

function handleToastDismissClick(
  manager: typeof baseToastManager | typeof anchoredToastManager,
  toastId: ToastId,
  onClose: (() => void) | undefined,
) {
  onClose?.();
  manager.close(toastId);
}

function CopyErrorButton({ text, className }: { text: string; className?: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  return (
    <button
      className={cn(
        "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md p-0 text-muted-foreground/60 transition-colors hover:bg-accent/50 hover:text-foreground focus-ring",
        className,
      )}
      onClick={() => copyToClipboard(text)}
      title="Copy error"
      type="button"
    >
      {isCopied ? (
        <CheckIcon className="size-3 translate-y-px text-success" />
      ) : (
        <CopyIcon className="size-3 translate-y-px" />
      )}
    </button>
  );
}

function ToastCornerControls({
  manager,
  toastId,
  onClose,
  singleLine,
  copyErrorText,
}: {
  manager: typeof baseToastManager | typeof anchoredToastManager;
  toastId: ToastId;
  onClose: (() => void) | undefined;
  singleLine: boolean;
  copyErrorText: string | null;
}) {
  return (
    <div className={toastCornerContainerClassName(singleLine)}>
      {copyErrorText !== null ? (
        <CopyErrorButton className={toastCornerOrbClass} text={copyErrorText} />
      ) : null}
      <button
        aria-label="Dismiss notification"
        className={toastCornerOrbClass}
        data-slot="toast-close"
        onClick={() => handleToastDismissClick(manager, toastId, onClose)}
        type="button"
      >
        <XIcon className="size-3" strokeWidth={2.25} />
      </button>
    </div>
  );
}

function hasRenderableToastDescription(description: unknown): boolean {
  return (
    description !== undefined && description !== null && description !== false && description !== ""
  );
}

/** Scrollable cap for long expandable lists (~10rem); keeps the toast from growing without bound. */
const toastExpandablePanelClassName =
  "mt-1.5 max-h-32 min-h-0 overflow-y-auto overscroll-contain pr-0.5 select-text text-[11px] leading-relaxed";

function ToastExpandableSection({
  children,
  labels,
}: {
  children: ReactNode;
  labels: { expand?: string; collapse?: string };
}) {
  const [open, setOpen] = useState(false);
  const expandLabel = labels.expand ?? "Show details";
  const collapseLabel = labels.collapse ?? "Hide details";

  return (
    <div className="min-w-0">
      <button
        aria-expanded={open}
        className="inline-flex cursor-pointer items-center gap-1 rounded-md py-0.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        {open ? (
          <ChevronUpIcon className="size-3.5 shrink-0 opacity-80" strokeWidth={2.25} />
        ) : (
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-80" strokeWidth={2.25} />
        )}
        {open ? collapseLabel : expandLabel}
      </button>
      {open ? <div className={toastExpandablePanelClassName}>{children}</div> : null}
    </div>
  );
}

function ToastDescriptionAndExpandable({ toastData }: { toastData: ThreadToastData | undefined }) {
  const expandableContent = toastData?.expandableContent;
  const labels = toastData?.expandableLabels ?? {};
  const descriptionTrigger = toastData?.expandableDescriptionTrigger ?? false;
  const descriptionClassName = cn(
    "min-w-0 select-text wrap-break-word text-xs leading-4 text-muted-foreground",
    toastReasonCapClassName,
  );
  const [open, setOpen] = useState(false);

  if (!expandableContent) {
    return (
      <Toast.Description
        className={descriptionClassName}
        data-base-ui-swipe-ignore=""
        data-slot="toast-description"
      />
    );
  }

  if (!descriptionTrigger) {
    return (
      <>
        <Toast.Description
          className={descriptionClassName}
          data-base-ui-swipe-ignore=""
          data-slot="toast-description"
        />
        <ToastExpandableSection labels={labels}>{expandableContent}</ToastExpandableSection>
      </>
    );
  }

  const expandLabel = labels.expand ?? "Show details";
  const collapseLabel = labels.collapse ?? "Hide details";

  const toggle = () => setOpen((v) => !v);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  };

  return (
    <>
      <div
        aria-expanded={open}
        className={cn(
          "group flex min-w-0 w-full cursor-pointer select-none items-start gap-1.5 rounded-sm text-left outline-none ring-offset-background",
          "transition-colors hover:bg-muted/30",
          "focus-ring",
        )}
        onClick={toggle}
        onKeyDown={onKeyDown}
        role="button"
        tabIndex={0}
        title={open ? collapseLabel : expandLabel}
      >
        <div className="min-w-0 flex-1">
          <Toast.Description
            className={cn(
              "min-w-0 select-none wrap-break-word text-xs leading-4 text-muted-foreground",
              toastReasonCapClassName,
              "group-hover:text-foreground/80",
            )}
            data-slot="toast-description"
          />
        </div>
        {open ? (
          <ChevronUpIcon
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-80"
            strokeWidth={2.25}
          />
        ) : (
          <ChevronDownIcon
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-80"
            strokeWidth={2.25}
          />
        )}
      </div>
      {open ? <div className={toastExpandablePanelClassName}>{expandableContent}</div> : null}
    </>
  );
}

const toastStatusIconClassName =
  "size-3.5 in-data-[type=loading]:animate-spin in-data-[type=error]:text-destructive/80 in-data-[type=info]:text-info/80 in-data-[type=success]:text-success/80 in-data-[type=warning]:text-warning/80 in-data-[type=loading]:text-muted-foreground/75";

function toastContentClassName({
  singleLine,
  hideCollapsedContent = false,
  animated = false,
}: {
  readonly singleLine: boolean;
  readonly hideCollapsedContent?: boolean;
  readonly animated?: boolean;
}): string {
  return cn(
    // `overflow-x: clip` avoids the CSS quirk where pairing `hidden` + `y: visible`
    // forces `y` to `auto`. Expandable detail panels can extend below without being cut off.
    "pointer-events-auto min-h-0 overflow-y-visible text-[13px] leading-5 [overflow-x:clip]",
    animated && "transition-opacity duration-250 data-expanded:opacity-100",
    singleLine ? "flex min-h-7 items-center py-1 pr-8 pl-3" : "flex flex-col gap-1.5 px-3 py-2",
    hideCollapsedContent && "not-data-expanded:pointer-events-none not-data-expanded:opacity-0",
  );
}

type ToastIconComponent = (typeof TOAST_ICONS)[keyof typeof TOAST_ICONS];

interface ToastBodyDescriptor {
  readonly Icon: ToastIconComponent | null | undefined;
  /** The whole title and reason, buttons in a row underneath. */
  readonly stacked: boolean;
  /** Just a title: one row, close centred beside it. */
  readonly singleLine: boolean;
  readonly actionVariant: NonNullable<ThreadToastData["actionVariant"]>;
  readonly secondaryActionVariant: NonNullable<ThreadToastData["secondaryActionVariant"]>;
  readonly copyErrorText: string | null;
  /** The thread the notice is about, while a different thread is open. */
  readonly otherThread: NonNullable<ThreadToastData["aboutThread"]> | null;
  readonly hasButtons: boolean;
}

function deriveToastBodyDescriptor(
  toast: {
    readonly type?: string | undefined;
    readonly description?: unknown;
    readonly actionProps?: unknown;
    readonly data?: ThreadToastData | undefined;
  },
  activeThreadRef: ScopedThreadRef | null,
): ToastBodyDescriptor {
  const Icon = toast.type ? TOAST_ICONS[toast.type as keyof typeof TOAST_ICONS] : null;
  const aboutThread = toast.data?.aboutThread;
  const otherThread =
    aboutThread && isAnotherThread(aboutThread.threadRef, activeThreadRef) ? aboutThread : null;
  const hasDescription = hasRenderableToastDescription(toast.description);
  const hasButtons =
    toast.actionProps !== undefined ||
    toast.data?.secondaryActionProps !== undefined ||
    otherThread !== null;
  const stacked = shouldStackNoticeBody({
    type: toast.type,
    hasDescription,
    hasButtons,
    requestsStackedLayout: toast.data?.actionLayout === "stacked-end",
  });
  const singleLine = !stacked && !hasDescription && !toast.data?.expandableContent;
  const actionVariant: NonNullable<ThreadToastData["actionVariant"]> =
    toast.data?.actionVariant ?? "default";
  const secondaryActionVariant: NonNullable<ThreadToastData["secondaryActionVariant"]> =
    toast.data?.secondaryActionVariant ?? "outline";
  // An error with a reason is always stacked, so copy has its place beside close.
  const copyErrorText =
    toast.type === "error" &&
    typeof toast.description === "string" &&
    hasDescription &&
    !toast.data?.hideCopyButton
      ? toast.description
      : null;
  return {
    Icon,
    stacked,
    singleLine,
    actionVariant,
    secondaryActionVariant,
    copyErrorText,
    otherThread,
    hasButtons,
  };
}

interface ToastBodyContentProps extends ToastBodyDescriptor {
  readonly actionProps: { readonly children?: ReactNode } | undefined;
  readonly toastData: ThreadToastData | undefined;
  readonly toastDescription: unknown;
}

/**
 * The words and buttons of a notice. A stacked notice shows everything; a
 * compact one keeps its title and reason to a line each, and a click on them
 * opens the whole text. Buttons always get their own row underneath, so the
 * words keep the notice's full width.
 */
function ToastBodyContent({
  stacked,
  singleLine,
  Icon,
  copyErrorText,
  otherThread,
  hasButtons,
  actionProps,
  actionVariant,
  secondaryActionVariant,
  toastData,
  toastDescription,
}: ToastBodyContentProps) {
  const secondaryActionProps = toastData?.secondaryActionProps;
  const leadingIcon = toastData?.leadingIcon;
  const { className: secondaryActionClassName, ...secondaryActionRest } =
    secondaryActionProps ?? {};
  const canOpen =
    !stacked && hasRenderableToastDescription(toastDescription) && !toastData?.expandableContent;
  const [opened, setOpened] = useState(false);
  const toggleOpened = () => setOpened((value) => !value);
  const onTextKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleOpened();
    }
  };
  const clamped = singleLine || (canOpen && !opened);

  return (
    <>
      <div className={cn("flex min-w-0 gap-2", singleLine && "flex-1 items-center")}>
        {leadingIcon ? (
          // `min-w-4`, not `w-4`: a row of agent logos is wider than one glyph.
          <div
            className="flex h-5 min-w-4 shrink-0 items-center justify-center text-muted-foreground/80 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5"
            data-slot="toast-icon"
          >
            {leadingIcon}
          </div>
        ) : Icon ? (
          <div
            className="flex h-5 w-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0"
            data-slot="toast-icon"
          >
            <Icon className={toastStatusIconClassName} strokeWidth={2.25} />
          </div>
        ) : null}
        <div
          aria-expanded={canOpen ? opened : undefined}
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col gap-0.5",
            canOpen &&
              "cursor-pointer rounded-sm outline-none ring-offset-background transition-colors hover:bg-muted/35 focus-ring",
          )}
          onClick={canOpen ? toggleOpened : undefined}
          onKeyDown={canOpen ? onTextKeyDown : undefined}
          role={canOpen ? "button" : undefined}
          tabIndex={canOpen ? 0 : undefined}
          title={canOpen ? (opened ? "Collapse notice" : "Expand notice") : undefined}
        >
          <Toast.Title
            className={cn(
              "min-w-0 text-[13px] leading-5 font-medium text-foreground/90",
              clamped ? "truncate" : "wrap-break-word",
              // Clear the corner controls: close, plus copy on an error.
              !singleLine && (copyErrorText !== null ? "pr-11" : "pr-6"),
            )}
            data-slot="toast-title"
          />
          {otherThread ? (
            <span
              className="min-w-0 truncate text-xs leading-4 text-muted-foreground"
              data-slot="toast-thread"
            >
              In {otherThread.title}
            </span>
          ) : null}
          {canOpen ? (
            <Toast.Description
              className={cn(
                "min-w-0 text-xs leading-4 text-muted-foreground",
                opened ? cn("select-text wrap-break-word", toastReasonCapClassName) : "truncate",
              )}
              data-base-ui-swipe-ignore={opened ? "" : undefined}
              data-slot="toast-description"
            />
          ) : (
            <ToastDescriptionAndExpandable toastData={toastData} />
          )}
        </div>
      </div>
      {hasButtons ? (
        <div className="flex w-full items-center justify-end gap-1 pt-0.5">
          {otherThread ? (
            <button
              className={buttonVariants({ size: "xs", variant: "outline" })}
              data-slot="toast-open-thread"
              onClick={otherThread.open}
              type="button"
            >
              Open thread
            </button>
          ) : null}
          {secondaryActionProps ? (
            <button
              {...secondaryActionRest}
              className={cn(
                buttonVariants({ size: "xs", variant: secondaryActionVariant }),
                secondaryActionClassName,
              )}
              type="button"
            />
          ) : null}
          {actionProps ? (
            <Toast.Action
              className={cn(buttonVariants({ size: "xs", variant: actionVariant }), "shrink-0")}
              data-slot="toast-action"
            >
              {actionProps.children}
            </Toast.Action>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

interface ToastProviderProps extends Toast.Provider.Props {
  position?: ToastPosition;
}

function useActiveThreadRefFromRoute(): ScopedThreadRef | null {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const activeDraftSession = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );

  return useMemo(() => {
    if (routeTarget?.kind === "server") {
      return routeTarget.threadRef;
    }
    if (routeTarget?.kind === "draft" && activeDraftSession) {
      return {
        environmentId: activeDraftSession.environmentId,
        threadId: activeDraftSession.threadId,
      };
    }
    return null;
  }, [activeDraftSession, routeTarget]);
}

/**
 * Time each notice has left, kept across unmounts: a notice drops out of the
 * stack while it waits for a slot, and picks up where it left off when it
 * gets one. A notice for another thread keeps counting while hidden
 * (`resolveHiddenNoticeVisibleMs`), so it can't hold a slot until its thread
 * is opened again. A different `key` (new content, a different duration,
 * hidden or drawn) starts it over.
 */
const noticeClockById = new Map<ToastId, { key: string; remainingMs: number }>();

/**
 * Whether the stack is held: open under the pointer or keyboard focus (Base
 * UI's own viewport state, so the clocks hold when Base UI's did), or under a
 * finger, which Base UI only tells its own timers about.
 */
const NoticeStackExpandedContext = createContext(false);

/** Closes a drawn notice once it has been on screen for `durationMs`. */
function NoticeClock({
  toastId,
  durationMs,
  clockKey,
  windowInFront,
}: {
  toastId: ToastId;
  durationMs: number | null;
  clockKey: string;
  windowInFront: boolean;
}) {
  const stackExpanded = useContext(NoticeStackExpandedContext);
  const running = windowInFront && !stackExpanded;
  useEffect(() => {
    if (durationMs === null) {
      noticeClockById.delete(toastId);
      return;
    }
    const saved = noticeClockById.get(toastId);
    const remainingMs = saved?.key === clockKey ? saved.remainingMs : durationMs;
    noticeClockById.set(toastId, { key: clockKey, remainingMs });
    if (!running) return;

    const startedAtMs = Date.now();
    const timeoutId = window.setTimeout(() => {
      noticeClockById.delete(toastId);
      toastManager.close(toastId);
    }, remainingMs);
    return () => {
      window.clearTimeout(timeoutId);
      const entry = noticeClockById.get(toastId);
      if (entry?.key === clockKey) {
        entry.remainingMs = Math.max(0, remainingMs - (Date.now() - startedAtMs));
      }
    };
  }, [clockKey, durationMs, running, toastId]);

  return null;
}

function ToastProvider({ children, position = "top-right", ...props }: ToastProviderProps) {
  // Base UI doesn't time these notices (its clock keeps running for one it
  // holds back); `NoticeClock` does. It still picks which ones wait for a slot,
  // so keyboard focus and drawing agree on the same notices.
  return (
    <Toast.Provider
      {...props}
      limit={NOTICE_STACK_LIMIT}
      timeout={0}
      toastManager={baseToastManager}
    >
      {children}
      <Toasts position={position} />
    </Toast.Provider>
  );
}

function Toasts({ position = "top-right" }: { position: ToastPosition }) {
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const activeThreadRef = useActiveThreadRefFromRoute();
  const isTop = position.startsWith("top");
  const visibleToasts = selectStackNotices(
    toasts.filter((toast) => shouldRenderThreadScopedToast(toast.data, activeThreadRef)),
  );
  const visibleToastLayout = buildVisibleToastLayout(visibleToasts);
  const raisedAboveBackdrops = useNoticesRaisedAboveBackdrops();
  const windowInFront = usePageAttended();
  const hiddenForThread = toasts.filter(
    (toast) =>
      toast.transitionStatus !== "ending" &&
      !toast.limited &&
      !shouldRenderThreadScopedToast(toast.data, activeThreadRef),
  );
  const [fingerOnStack, setFingerOnStack] = useState(false);
  useEffect(() => {
    if (!fingerOnStack) return;
    // Touch events, not pointer ones: a pointer is cancelled the moment the
    // page starts scrolling under the finger, which is still down.
    const lift = (event: TouchEvent) => {
      if (event.touches.length === 0) setFingerOnStack(false);
    };
    window.addEventListener("touchend", lift, true);
    window.addEventListener("touchcancel", lift, true);
    return () => {
      window.removeEventListener("touchend", lift, true);
      window.removeEventListener("touchcancel", lift, true);
    };
  }, [fingerOnStack]);

  useEffect(() => {
    const activeToastIds = new Set(toasts.map((toast) => toast.id));
    for (const toastId of noticeClockById.keys()) {
      if (!activeToastIds.has(toastId)) {
        noticeClockById.delete(toastId);
      }
    }
  }, [toasts]);

  return (
    <Toast.Portal data-slot="toast-portal">
      <Toast.Viewport
        className={cn(
          // Below every interactive overlay in the app, all of which sit at
          // z-50. A toast arrives on its own schedule and lands in the same
          // top-right corner the panel's tab menu opens into, so at z-100 it
          // was swallowing clicks meant for a menu the user had just opened.
          // Ambient notice yields to whatever the user is actually doing.
          // A dimmed backdrop is the exception: the user is in a dialog, and
          // a notice raised then must not sit blurred underneath it.
          raisedAboveBackdrops ? "z-60" : "z-40",
          "fixed mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-[20rem] [--toast-header-offset:52px] [--toast-inset:--spacing(4)] sm:[--toast-inset:--spacing(6)]",
          // Vertical positioning
          "data-[position*=top]:top-[calc(var(--toast-inset)+var(--toast-header-offset))]",
          "data-[position*=bottom]:bottom-(--toast-inset)",
          // Horizontal positioning. Right-anchored toasts sit beside the open
          // right panel rather than on top of it: the panel publishes its width
          // as `--right-panel-inset` (0px when closed) because this viewport is
          // fixed to the viewport and the layout cannot push it aside.
          "data-[position*=left]:left-(--toast-inset)",
          "data-[position*=right]:right-[calc(var(--toast-inset)+var(--right-panel-inset,0px))]",
          "data-[position*=center]:-translate-x-1/2 data-[position*=center]:left-1/2",
        )}
        data-position={position}
        data-slot="toast-viewport"
        onPointerDown={(event) => {
          if (event.pointerType === "touch") setFingerOnStack(true);
        }}
        render={(viewportProps, viewportState) => (
          <NoticeStackExpandedContext.Provider value={viewportState.expanded || fingerOnStack}>
            <div {...viewportProps} />
          </NoticeStackExpandedContext.Provider>
        )}
        style={
          {
            "--toast-frontmost-height": `${visibleToastLayout.frontmostHeight}px`,
          } as CSSProperties
        }
      >
        {visibleToastLayout.items.map(({ toast, visibleIndex, offsetY }) => {
          const hideCollapsedContent = shouldHideCollapsedToastContent(
            visibleIndex,
            visibleToastLayout.items.length,
          );
          const bodyDescriptor = deriveToastBodyDescriptor(toast, activeThreadRef);
          const { singleLine } = bodyDescriptor;
          // A button is a next step; the clock restarts if one appears or goes
          // (opening the thread an "Open thread" notice points at, say).
          const visibleMs =
            toast.transitionStatus === "ending"
              ? null
              : resolveNoticeVisibleMs(toast, bodyDescriptor.hasButtons);

          return (
            <Toast.Root
              className={cn(
                "group/toast absolute z-[calc(9999-var(--toast-index))] w-full overflow-visible select-none rounded-lg border border-border/75 bg-popover/96 not-dark:bg-clip-padding text-popover-foreground shadow-sm/5 [transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:bg-popover/94 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
                // Base positioning using data-position
                "data-[position*=right]:right-0 data-[position*=right]:left-auto",
                "data-[position*=left]:right-auto data-[position*=left]:left-0",
                "data-[position*=center]:right-0 data-[position*=center]:left-0",
                "data-[position*=top]:top-0 data-[position*=top]:bottom-auto data-[position*=top]:origin-top",
                "data-[position*=bottom]:top-auto data-[position*=bottom]:bottom-0 data-[position*=bottom]:origin-bottom",
                // Gap fill for hover
                "after:absolute after:left-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
                "data-[position*=top]:after:top-full",
                "data-[position*=bottom]:after:bottom-full",
                // `--toast-calc-height`: behind + collapsed = peek height only (content `opacity-0`);
                // max(front, own) there produced a tall empty shell for long bodies.
                visibleIndex > 0
                  ? "not-data-expanded:[--toast-calc-height:var(--toast-frontmost-height)] data-expanded:[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))]"
                  : "[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))]",
                "[--toast-gap:--spacing(2)] [--toast-peek:6px] [--toast-scale:calc(max(0,1-(var(--toast-index)*.035)))] [--toast-shrink:calc(1-var(--toast-scale))]",
                // Root height: never `min-h-(--toast-height)` — Base UI measures height by briefly forcing
                // `height: auto` on this node; an old `min-height` from `--toast-height` blocks shrinking,
                // so `recalculateHeight` keeps the inflated value after an expandable closes.
                // Behind + collapsed: fixed peek. Otherwise natural height (expand/collapse, hover stack).
                visibleIndex > 0
                  ? "not-data-expanded:h-(--toast-calc-height) data-expanded:h-auto"
                  : "h-auto",
                // Define offset-y variable
                "data-[position*=top]:[--toast-calc-offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--toast-gap)+var(--toast-swipe-movement-y))]",
                "data-[position*=bottom]:[--toast-calc-offset-y:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--toast-gap)*-1+var(--toast-swipe-movement-y))]",
                // Default state transform
                "data-[position*=top]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))+(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-[position*=bottom]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--toast-peek))-(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                // Expanded stack
                "data-position:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-calc-offset-y))]",
                // Starting and ending animations
                "data-[position*=top]:data-starting-style:transform-[translateY(calc(-100%-var(--toast-inset)))]",
                "data-[position*=bottom]:data-starting-style:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-starting-style:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:opacity-0",
                // Ending animations (direction-aware)
                "data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                // Ending animations (expanded)
                "data-expanded:data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
              )}
              data-position={position}
              key={toast.id}
              style={
                {
                  "--toast-index": visibleIndex,
                  "--toast-offset-y": `${offsetY}px`,
                } as CSSProperties
              }
              swipeDirection={
                position.includes("center")
                  ? [isTop ? "up" : "down"]
                  : position.includes("left")
                    ? ["left", isTop ? "up" : "down"]
                    : ["right", isTop ? "up" : "down"]
              }
              toast={toast}
            >
              <NoticeClock
                clockKey={`${toast.updateKey ?? 0}:${visibleMs ?? "held"}`}
                durationMs={visibleMs}
                toastId={toast.id}
                windowInFront={windowInFront}
              />
              <ToastCornerControls
                copyErrorText={bodyDescriptor.copyErrorText}
                manager={baseToastManager}
                onClose={toast.data?.onClose}
                singleLine={singleLine}
                toastId={toast.id}
              />
              <Toast.Content
                className={toastContentClassName({
                  singleLine,
                  hideCollapsedContent,
                  animated: true,
                })}
              >
                <ToastBodyContent
                  {...bodyDescriptor}
                  actionProps={toast.actionProps}
                  toastData={toast.data}
                  toastDescription={toast.description}
                />
              </Toast.Content>
            </Toast.Root>
          );
        })}
        {hiddenForThread.map((toast) => {
          const visibleMs = resolveHiddenNoticeVisibleMs(toast);
          return (
            <NoticeClock
              clockKey={`${toast.updateKey ?? 0}:hidden:${visibleMs ?? "held"}`}
              durationMs={visibleMs}
              key={toast.id}
              toastId={toast.id}
              windowInFront={windowInFront}
            />
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

function AnchoredToastProvider({ children, ...props }: Toast.Provider.Props) {
  return (
    <Toast.Provider toastManager={anchoredToastManager} {...props}>
      {children}
      <AnchoredToasts />
    </Toast.Provider>
  );
}

function AnchoredToasts() {
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const activeThreadRef = useActiveThreadRefFromRoute();

  return (
    <Toast.Portal data-slot="toast-portal-anchored">
      <Toast.Viewport className="outline-none" data-slot="toast-viewport-anchored">
        {toasts
          .filter((toast) => shouldRenderThreadScopedToast(toast.data, activeThreadRef))
          .map((toast) => {
            const tooltipStyle = toast.data?.tooltipStyle ?? false;
            const positionerProps = toast.positionerProps;
            const bodyDescriptor = deriveToastBodyDescriptor(toast, activeThreadRef);
            const { singleLine } = bodyDescriptor;

            if (!positionerProps?.anchor) {
              return null;
            }

            return (
              <Toast.Positioner
                className="z-100 max-w-[min(--spacing(64),var(--available-width))]"
                data-slot="toast-positioner"
                key={toast.id}
                sideOffset={positionerProps.sideOffset ?? 4}
                toast={toast}
              >
                <Toast.Root
                  className={cn(
                    "group/toast relative overflow-visible text-balance border border-border/75 bg-popover/96 not-dark:bg-clip-padding text-popover-foreground text-xs shadow-sm/5 transition-[scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-popover/94 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
                    tooltipStyle
                      ? "rounded-md before:rounded-[calc(var(--radius-md)-1px)]"
                      : "rounded-lg before:rounded-[calc(var(--radius-lg)-1px)]",
                  )}
                  data-slot="toast-popup"
                  toast={toast}
                >
                  {tooltipStyle ? (
                    <Toast.Content className="pointer-events-auto px-2 py-1">
                      <Toast.Title data-slot="toast-title" />
                    </Toast.Content>
                  ) : (
                    <>
                      <ToastCornerControls
                        copyErrorText={bodyDescriptor.copyErrorText}
                        manager={anchoredToastManager}
                        onClose={toast.data?.onClose}
                        singleLine={singleLine}
                        toastId={toast.id}
                      />
                      <Toast.Content className={toastContentClassName({ singleLine })}>
                        <ToastBodyContent
                          {...bodyDescriptor}
                          actionProps={toast.actionProps}
                          toastData={toast.data}
                          toastDescription={toast.description}
                        />
                      </Toast.Content>
                    </>
                  )}
                </Toast.Root>
              </Toast.Positioner>
            );
          })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export { failureNotice, stackedThreadToast } from "./toastHelpers";
export type { FailureNoticeOptions, FailureTitle, StackedThreadToastOptions } from "./toastHelpers";

export {
  ToastProvider,
  type ToastPosition,
  toastManager,
  AnchoredToastProvider,
  anchoredToastManager,
};
