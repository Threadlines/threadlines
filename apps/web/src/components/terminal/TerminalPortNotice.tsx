/**
 * The line above a tab's output naming who holds the port its command found
 * taken (docs/terminal.md, "When a port is taken"). When another tab holds
 * it, Show goes there (in its own chat if need be) and Stop interrupts the
 * job holding it, as Ctrl+C in that tab would.
 */
import { scopeThreadRef } from "@threadlines/client-runtime";
import { ThreadId, type ScopedThreadRef, type TerminalPortInUse } from "@threadlines/contracts";
import { useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "~/components/ui/button";
import { readEnvironmentApi } from "~/environmentApi";
import { useThreadTitle } from "../../childThreads";
import { selectTerminalTabs, useTerminalStateStore } from "../../terminalStateStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { TerminalNotice } from "./TerminalNotice";

/**
 * The notice's sentence in parts: `code` (the program or job, shown as code,
 * or null when none is known) sits between `lead` and `rest`.
 */
export interface PortNoticeWords {
  readonly lead: string;
  readonly code: string | null;
  readonly rest: string;
}

/**
 * What the notice says. `tabLabel` is "Terminal N" for a terminal holder,
 * and `chatTitle` the title of its chat when that isn't this one.
 */
export function portNoticeWords(
  portInUse: Pick<TerminalPortInUse, "port" | "holders">,
  context: {
    readonly sameTab: boolean;
    readonly sameChat: boolean;
    readonly tabLabel: string | null;
    readonly chatTitle: string | null;
  },
): PortNoticeWords {
  const [holder] = portInUse.holders;
  const others = portInUse.holders.length - 1;
  const end =
    (others === 0 ? "" : others === 1 ? " and another program" : ` and ${others} other programs`) +
    ".";
  const lead = `Port ${portInUse.port} is in use by `;
  const named = (code: string | null, after: string, unnamed: string): PortNoticeWords =>
    code === null
      ? { lead, code, rest: `${unnamed}${end}` }
      : { lead, code, rest: `${after}${end}` };
  switch (holder?.kind) {
    case "terminal": {
      const code = holder.command ?? holder.name;
      if (context.sameTab) {
        return named(code, ", started in this terminal", "a program started in this terminal");
      }
      const tab = context.tabLabel ?? "a terminal";
      const chat = context.sameChat
        ? ""
        : context.chatTitle !== null
          ? ` of ${context.chatTitle}`
          : " of another chat";
      return named(code, ` in ${tab}${chat}`, `${tab}${chat}`);
    }
    case "agent":
      return named(
        holder.command ?? holder.name,
        ", which an agent started",
        "a program an agent started",
      );
    case "threadlines":
      return { lead, code: null, rest: `Threadlines itself${end}` };
    case "process":
      return named(
        holder.name ?? holder.command,
        ` (PID ${holder.pid})`,
        `another program (PID ${holder.pid})`,
      );
    case undefined:
      return { lead, code: null, rest: `another program${end}` };
  }
}

export function TerminalPortNotice({
  threadRef,
  terminalId,
  portInUse,
  onStopFailed,
}: {
  threadRef: ScopedThreadRef;
  terminalId: string;
  portInUse: TerminalPortInUse;
  /** Stop didn't free the port: says why in the tab. */
  onStopFailed: (message: string) => void;
}) {
  const navigate = useNavigate();
  const [first] = portInUse.holders;
  const holderTab = first?.kind === "terminal" ? first : null;
  const holderRef =
    holderTab === null
      ? null
      : scopeThreadRef(threadRef.environmentId, ThreadId.make(holderTab.threadId));
  const sameChat = holderTab !== null && holderTab.threadId === threadRef.threadId;
  const sameTab = sameChat && holderTab.terminalId === terminalId;
  const holderNumber = useTerminalStateStore((state) =>
    holderRef === null || holderTab === null
      ? null
      : (selectTerminalTabs(state.terminalTabsByThreadKey, holderRef).find(
          (tab) => tab.terminalId === holderTab.terminalId,
        )?.number ?? null),
  );
  const chatTitle = useThreadTitle(
    threadRef.environmentId,
    holderTab === null || sameChat ? null : ThreadId.make(holderTab.threadId),
  );
  // Hidden here at once, by id: a newer notice for the same tab still shows.
  const [settledId, setSettledId] = useState<string | null>(null);
  // The notice whose Stop is under way: a newer one gets its own button.
  const [stoppingId, setStoppingId] = useState<string | null>(null);

  const resolve = useCallback(
    (stop: boolean) => {
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) return;
      const noticeId = portInUse.id;
      if (stop) setStoppingId(noticeId);
      else setSettledId(noticeId);
      void api.terminal
        .resolvePortInUse({ threadId: threadRef.threadId, terminalId, noticeId, stop })
        .catch((error: unknown) => {
          if (!stop) {
            setSettledId((current) => (current === noticeId ? null : current));
            return;
          }
          onStopFailed(error instanceof Error ? error.message : "Couldn't stop it.");
        })
        .finally(() => {
          if (stop) setStoppingId((current) => (current === noticeId ? null : current));
        });
    },
    [onStopFailed, portInUse.id, terminalId, threadRef],
  );
  const stopping = stoppingId === portInUse.id;

  const show = useCallback(() => {
    if (holderRef === null || holderTab === null || holderNumber === null) return;
    // Opens the tab the server lists; never makes one (ensureTerminal makes
    // only a tab it doesn't list, and this one is listed).
    useTerminalStateStore
      .getState()
      .ensureTerminal(holderRef, holderTab.terminalId, { active: true, open: true });
    if (!sameChat) {
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(holderRef) });
    }
  }, [holderNumber, holderRef, holderTab, navigate, sameChat]);

  if (first === undefined || settledId === portInUse.id) return null;
  const words = portNoticeWords(portInUse, {
    sameTab,
    sameChat,
    tabLabel: holderNumber === null ? null : `Terminal ${holderNumber}`,
    chatTitle,
  });
  const canShow = holderTab !== null && !sameTab && holderNumber !== null;
  return (
    <TerminalNotice
      title={`${words.lead}${words.code ?? ""}${words.rest}`}
      message={
        <>
          {words.lead}
          {words.code !== null ? (
            <code className="font-mono text-foreground">{words.code}</code>
          ) : null}
          {words.rest}
        </>
      }
      actions={
        <>
          {canShow ? (
            <Button size="xs" variant="outline" onClick={show}>
              Show
            </Button>
          ) : null}
          {portInUse.canStop ? (
            <Button size="xs" variant="outline" disabled={stopping} onClick={() => resolve(true)}>
              {stopping ? "Stopping…" : "Stop it"}
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss"
            onClick={() => resolve(false)}
          >
            <XIcon />
          </Button>
        </>
      }
    />
  );
}
