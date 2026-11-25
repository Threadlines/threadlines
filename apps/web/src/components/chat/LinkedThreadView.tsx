/**
 * A child on a computer this app can't see, read through the link
 * (docs/design/child-threads.md, "Opening a child on a computer the app
 * can't see"). The parent's computer reads it from the computer it runs on
 * (`links.readThread`), so its family's tab and its sidebar row open it even
 * where this app has no connection there. It shows the messages as the
 * thread tools read them: what was asked and what the agent answered, without
 * its tool steps, and with no message box. Connecting to that computer opens
 * the real thread instead.
 */
import { scopedThreadKey } from "@threadlines/client-runtime";
import type { AgentThreadReadResult, ScopedThreadRef } from "@threadlines/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CloudIcon } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ELECTRON_HEADER_HEIGHT_CLASS } from "../../desktopChrome";
import { describeComputerLinkFailure } from "../../environments/links/computerLinks";
import { readLinkedThread } from "../../environments/links/linkedThreads";
import { isElectron } from "../../env";
import { useInboxThreads } from "../../hooks/useInboxThreads";
import { useRemoteFamilyChildren } from "../../hooks/useRemoteFamilyChildren";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatMarkdown from "../ChatMarkdown";
import { type InboxRemoteChild, remoteChildStatusText } from "../Sidebar.logic";
import { openConnectComputerDialog } from "../settings/connections/JoinComputerDialog";
import {
  TitleBarContent,
  useTitleBarHeaderRef,
  useTitleBarRowPresent,
} from "../sidebar/titleBarSlot";
import { Button } from "../ui/button";
import { ComposerNoticeDock } from "./ComposerNoticeDock";
import { SidebarOpenTrigger } from "../ui/sidebar";
import { FamilyTabs } from "./FamilyTabs";

/** The newest messages read at once: thread_read's most. */
const LINKED_READ_LIMIT = 50;
/** How often an open child that is working is read again. */
const WORKING_REFRESH_MS = 4_000;
/** The most of one message "Show all" reads, in parts of up to 20,000 characters. */
const FULL_MESSAGE_PART_LIMIT = 10;

type LinkedMessage = AgentThreadReadResult["messages"][number];

/** Where the open child stands in this app: its parent's record of it, or a thread here. */
type LinkedChildPlace =
  | {
      readonly kind: "linked";
      readonly parentRef: ScopedThreadRef;
      readonly child: InboxRemoteChild;
    }
  | { readonly kind: "here" }
  | { readonly kind: "missing" };

/** Finds the parent that holds `childRef`, as the sidebar files the child. */
function useLinkedChildPlace(childRef: ScopedThreadRef): LinkedChildPlace {
  const { entries, nowIso } = useInboxThreads();
  const remoteFamilyChildren = useRemoteFamilyChildren(nowIso);
  const { environmentId, threadId } = childRef;
  return useMemo(
    () => findLinkedChildPlace(entries, { environmentId, threadId }, remoteFamilyChildren),
    [entries, environmentId, remoteFamilyChildren, threadId],
  );
}

function findLinkedChildPlace(
  entries: ReturnType<typeof useInboxThreads>["entries"],
  childRef: ScopedThreadRef,
  remoteFamilyChildren: ReturnType<typeof useRemoteFamilyChildren>,
): LinkedChildPlace {
  const childKey = scopedThreadKey(childRef);
  const keys = new Set(entries.map((entry) => entry.threadKey));
  if (keys.has(childKey)) return { kind: "here" };
  for (const entry of entries) {
    const parent = entry.thread;
    const holds = parent.remoteChildren?.some(
      (child) =>
        child.environmentId === childRef.environmentId && child.threadId === childRef.threadId,
    );
    if (holds !== true) continue;
    const child = remoteFamilyChildren(parent, (threadId) =>
      keys.has(scopedThreadKey({ environmentId: parent.environmentId, threadId })),
    ).find((candidate) => candidate.threadKey === childKey);
    if (child !== undefined) {
      return {
        kind: "linked",
        parentRef: { environmentId: parent.environmentId, threadId: parent.id },
        child,
      };
    }
  }
  return { kind: "missing" };
}

export function LinkedThreadView({ childRef }: { childRef: ScopedThreadRef }) {
  const place = useLinkedChildPlace(childRef);
  const navigate = useNavigate();

  // Connected to that computer now: its real thread opens instead.
  useEffect(() => {
    if (place.kind !== "here") return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(childRef),
      replace: true,
    });
  }, [childRef, navigate, place.kind]);

  if (place.kind !== "linked") {
    return (
      <LinkedThreadFrame title="Thread on another computer">
        {place.kind === "missing" ? (
          <p className="px-1 py-6 text-[13px] text-muted-foreground">
            No thread here started this one, so it can't be read from this app.
          </p>
        ) : null}
      </LinkedThreadFrame>
    );
  }
  return (
    <LinkedThreadFrame
      title={place.child.title}
      computerLabel={place.child.computerLabel}
      statusText={remoteChildStatusText(place.child)}
      familyRow={
        <FamilyTabs
          openKey={scopedThreadKey(childRef)}
          parentKey={scopedThreadKey(place.parentRef)}
        />
      }
    >
      <LinkedThreadMessages parentRef={place.parentRef} child={place.child} childRef={childRef} />
    </LinkedThreadFrame>
  );
}

/** The header, the family row and the scrolling body, laid out as a thread's chat is. */
function LinkedThreadFrame({
  title,
  computerLabel,
  statusText,
  familyRow,
  children,
}: {
  title: string;
  computerLabel?: string;
  statusText?: string;
  familyRow?: React.ReactNode;
  children: React.ReactNode;
}) {
  const titleRowPresent = useTitleBarRowPresent();
  const header = (
    <LinkedThreadHeader title={title} computerLabel={computerLabel} statusText={statusText} />
  );
  return (
    <div
      data-linked-thread-view=""
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background"
    >
      <TitleBarContent
        flexibleMinWidth={160}
        fallback={
          <header
            className={cn(
              "page-gutters relative [--side-gutter:--spacing(3)] sm:[--side-gutter:--spacing(5)]",
              isElectron || titleRowPresent
                ? cn("drag-region flex items-center", ELECTRON_HEADER_HEIGHT_CLASS)
                : "py-2 sm:py-3",
            )}
          >
            {header}
          </header>
        }
      >
        {header}
      </TitleBarContent>
      {familyRow}
      {children}
    </div>
  );
}

function LinkedThreadHeader({
  title,
  computerLabel,
  statusText,
}: {
  title: string;
  computerLabel: string | undefined;
  statusText: string | undefined;
}) {
  const titleBarHeaderRef = useTitleBarHeaderRef();
  return (
    <div ref={titleBarHeaderRef} className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
      <SidebarOpenTrigger className="size-7 shrink-0" />
      <h2 className="min-w-0 shrink truncate text-sm font-medium text-foreground" title={title}>
        {title}
      </h2>
      {computerLabel !== undefined ? (
        <span
          data-testid="linked-thread-place"
          className="inline-flex min-w-0 shrink-0 items-center gap-1 text-xs text-muted-foreground"
        >
          <CloudIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="max-w-40 truncate">{computerLabel}</span>
          {statusText !== undefined ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-[11px]">{statusText}</span>
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function LinkedThreadMessages({
  parentRef,
  child,
  childRef,
}: {
  parentRef: ScopedThreadRef;
  child: InboxRemoteChild;
  childRef: ScopedThreadRef;
}) {
  const working = child.phase === "working" && child.unlinked !== true;
  // Read again whenever the parent hears the child moved on: a new read, never
  // one already on its way, which may have started before the last turn ended.
  const movedOn = `${child.phase}|${child.settledAt ?? ""}|${child.isDone}`;
  const query = useQuery({
    queryKey: ["linkedThread", scopedThreadKey(parentRef), scopedThreadKey(childRef), movedOn],
    queryFn: () =>
      readLinkedThread(parentRef.environmentId, {
        parentThreadId: parentRef.threadId,
        environmentId: childRef.environmentId,
        threadId: childRef.threadId,
        limit: LINKED_READ_LIMIT,
      }),
    // The last page stays on screen while the next one is read.
    placeholderData: keepPreviousData,
    // While it works; a failed read waits for Try again, a focus or a move on.
    refetchInterval: (current) =>
      working && current.state.status !== "error" ? WORKING_REFRESH_MS : false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const { refetch } = query;

  const read = query.data;
  const messages = read?.outcome === "ok" ? read.messages : null;
  const failure = query.isError
    ? describeComputerLinkFailure(query.error, `Couldn't read it from ${child.computerLabel}.`)
    : read !== undefined && read.outcome !== "ok"
      ? (read.detail ?? `${child.computerLabel} didn't share this thread.`)
      : null;
  const failureRow =
    failure === null ? null : (
      <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
        <p data-testid="linked-thread-error">{failure}</p>
        <Button size="xs" variant="outline" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );

  // Kept at the newest message (its last turn) unless the user scrolled up.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  const messageCount = messages?.length ?? 0;
  const lastText = messages?.at(-1)?.text ?? "";
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null || !atBottomRef.current || messageCount + lastText.length === 0) return;
    el.scrollTop = el.scrollHeight;
  }, [lastText, messageCount]);

  return (
    <>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-testid="linked-thread-messages"
        className="page-gutters min-h-0 flex-1 overflow-y-auto [--side-gutter:--spacing(4)] sm:[--side-gutter:--spacing(6)]"
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 pt-4 pb-6">
          {messages === null ? (
            query.isPending ? (
              <p className="text-[13px] text-muted-foreground">
                Reading from {child.computerLabel}…
              </p>
            ) : (
              failureRow
            )
          ) : messages.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No messages yet.</p>
          ) : (
            <>
              {messages.length >= LINKED_READ_LIMIT ? (
                <p className="text-center font-mono text-[11px] text-muted-foreground">
                  The last {LINKED_READ_LIMIT} messages
                </p>
              ) : null}
              {messages.map((message) => (
                <LinkedMessageRow
                  key={message.messageId}
                  message={message}
                  parentRef={parentRef}
                  childRef={childRef}
                />
              ))}
              {/* The last page read stays; this says the newest couldn't be. */}
              {failureRow}
            </>
          )}
        </div>
      </div>
      {/* Where the message box would be: why there is none, and the way to one. */}
      <div className="page-gutters pb-[calc(var(--safe-area-bottom)+1rem)] [--side-gutter:--spacing(4)] sm:[--side-gutter:--spacing(6)]">
        <div className="mx-auto w-full max-w-4xl">
          <div
            data-testid="linked-thread-notice"
            className="rounded-4xl border border-border bg-card px-1 py-0.5"
          >
            <ComposerNoticeDock
              notices={[
                {
                  id: "linked-thread",
                  severity: "info",
                  lead: "Read through the link.",
                  detail: `Its messages from ${child.computerLabel}, without tool steps.`,
                  wrapActions: true,
                  actions: (
                    <Button size="xs" variant="outline" onClick={openConnectComputerDialog}>
                      Connect
                    </Button>
                  ),
                },
              ]}
            />
          </div>
        </div>
      </div>
    </>
  );
}

/** One message: the asker's in a bubble on the right, the agent's as the chat draws it. */
const LinkedMessageRow = memo(function LinkedMessageRow({
  message,
  parentRef,
  childRef,
}: {
  message: LinkedMessage;
  parentRef: ScopedThreadRef;
  childRef: ScopedThreadRef;
}) {
  // The whole message as read for one length of it: a message still being
  // written grows, and its newer page drops a whole read of it from before.
  const length = message.length ?? message.text.length;
  const [full, setFull] = useState<
    | { readonly forLength: number; readonly text: string; readonly cut: boolean }
    | { readonly error: string }
    | "loading"
    | null
  >(null);
  const whole =
    full !== null && full !== "loading" && "text" in full && full.forLength === length
      ? full
      : null;
  const text = whole?.text ?? message.text;
  const clipped = message.clipped === true && whole === null;

  const showAll = useCallback(async () => {
    setFull("loading");
    try {
      let joined = "";
      let offset: number | undefined = 0;
      for (let part = 0; part < FULL_MESSAGE_PART_LIMIT && offset !== undefined; part += 1) {
        const read = await readLinkedThread(parentRef.environmentId, {
          parentThreadId: parentRef.threadId,
          environmentId: childRef.environmentId,
          threadId: childRef.threadId,
          messageId: message.messageId,
          offset,
        });
        const piece = read.outcome === "ok" ? read.messages[0] : undefined;
        if (piece === undefined || piece.messageId !== message.messageId) {
          throw new Error(read.detail ?? "That message can't be read in full.");
        }
        joined += piece.text;
        offset = piece.nextOffset;
      }
      setFull({ forLength: length, text: joined, cut: offset !== undefined });
    } catch (error) {
      setFull({ error: describeComputerLinkFailure(error, "That message can't be read in full.") });
    }
  }, [childRef.environmentId, childRef.threadId, length, message.messageId, parentRef]);

  const footer = clipped ? (
    <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
      <button
        type="button"
        className="transition-colors hover:text-foreground disabled:hover:text-muted-foreground"
        disabled={full === "loading"}
        onClick={() => void showAll()}
      >
        {full === "loading"
          ? "Reading…"
          : `Show all${message.length !== undefined ? ` (${message.length.toLocaleString()} characters)` : ""}`}
      </button>
      {full !== null && full !== "loading" && "error" in full ? <span>{full.error}</span> : null}
    </div>
  ) : whole?.cut === true ? (
    <p className="mt-1.5 text-xs text-muted-foreground">
      The first {(FULL_MESSAGE_PART_LIMIT * 20_000).toLocaleString()} characters
    </p>
  ) : null;

  const markdown = (
    <ChatMarkdown
      text={text}
      cwd={undefined}
      environmentId={childRef.environmentId}
      isStreaming={message.streaming === true}
    />
  );

  if (message.role === "user") {
    return (
      <div data-linked-message-role="user" className="flex flex-col items-end gap-1">
        {message.origin !== "user" ? (
          <span className="pe-2 text-[11px] text-muted-foreground">{message.author}</span>
        ) : null}
        <div className="max-w-[80%] min-w-0 rounded-4xl bg-secondary px-3.5 py-2.5">
          {markdown}
          {footer}
        </div>
      </div>
    );
  }
  return (
    <div data-linked-message-role="assistant" className="min-w-0 px-1">
      {markdown}
      {footer}
    </div>
  );
});
