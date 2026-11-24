import { memo, type ReactNode, useMemo } from "react";

import { useEnvironmentProviders } from "../../hooks/useEnvironmentProviders";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { runtimeModeConfig } from "../../runtimeModeOptions";
import {
  formatThreadMoveAccess,
  formatThreadMoveArrival,
  formatThreadMoveChanges,
} from "../../threadMove";
import { useThreadMoveStagedApprovalCheck } from "../../environments/links/threadMoves";
import {
  groupPendingLinkRequests,
  type PendingMoveGroup,
  useComputerLabel,
  useLinkRequestAnswer,
  useMoveGroupAnswer,
  usePendingLinkRequests,
  type PendingLinkRequest,
} from "../sidebar/linkedComputers";
import { Button } from "../ui/button";
import { getPickerModelName } from "./providerIconUtils";

/**
 * A thread this thread's agent asked another computer to start, waiting for
 * that computer's user (docs/design/fleet.md, Part 2 "Ask first"). Docked
 * above the message box in the thread that asked, where the conversation
 * says why: what would start, the agent and access it would get, the
 * instructions in full, then Deny and Allow. The answer goes to the computer
 * it would run on; the card leaves when that computer drops the request.
 *
 * A move (`kind: "move"`, Part 3) docks in the thread being moved: which
 * computers, the thread, what goes with it, how much of it is here already
 * and where it lands, with the same Deny and Allow. When the same computer
 * asks to move other threads too (Part 3c), it says so and offers Allow all.
 */
export const ComposerRemoteStartPanel = memo(function ComposerRemoteStartPanel({
  pending,
}: {
  readonly pending: PendingLinkRequest;
}) {
  const { environmentId, request } = pending;
  const computerLabel = useComputerLabel()(environmentId, environmentId);
  const providersOn = useEnvironmentProviders();
  const agentLabel = useMemo(() => {
    const entry = deriveProviderInstanceEntries(providersOn(environmentId)).find(
      (candidate) => candidate.instanceId === request.agent.instanceId,
    );
    const model = entry?.models.find((candidate) => candidate.slug === request.agent.model);
    if (entry && model) return getPickerModelName(model, entry.driverKind);
    return entry?.displayName ?? request.agent.model ?? request.agent.instanceId;
  }, [environmentId, providersOn, request.agent.instanceId, request.agent.model]);
  // Shared with the inbox row: an answer sent from either holds both.
  const { answering, respond } = useLinkRequestAnswer(pending, computerLabel);
  const access = runtimeModeConfig[request.runtimeMode].label;
  const moveArrival = request.move ? formatThreadMoveArrival(request.move) : null;
  const moveGroup = useMoveGroupOf(pending);
  if (request.kind === "move") {
    return (
      <div
        className="px-4 py-3.5 sm:px-5 sm:py-4"
        data-testid="remote-start-panel"
        data-request-kind="move"
      >
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm tracking-[0.2em] uppercase">Request</span>
            <span className="text-sm font-medium" data-testid="remote-start-panel-heading">
              {request.fromLabel} wants to move a thread to {computerLabel}
            </span>
          </div>
          <p className="text-sm font-medium text-foreground" data-testid="remote-start-panel-title">
            {request.title}
          </p>
          {request.move ? (
            <p className="text-xs text-muted-foreground" data-testid="remote-start-panel-summary">
              {formatThreadMoveChanges(request.move)}
              {moveArrival !== null ? ` · ${moveArrival}` : null}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground" data-testid="remote-start-panel-where">
            Lands in {request.projectName} with up to {formatThreadMoveAccess(access)}.
          </p>
          {moveGroup !== null ? (
            <p className="text-xs text-muted-foreground" data-testid="remote-start-panel-group">
              {request.fromLabel} wants to move {moveGroup.requests.length} threads here in all.
            </p>
          ) : null}
        </div>
        <RemoteRequestAnswerButtons answering={answering} respond={respond}>
          {moveGroup !== null ? (
            <AllowAllButton group={moveGroup} computerLabel={computerLabel} />
          ) : null}
        </RemoteRequestAnswerButtons>
      </div>
    );
  }
  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4" data-testid="remote-start-panel">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm tracking-[0.2em] uppercase">Request</span>
          <span className="text-sm font-medium" data-testid="remote-start-panel-heading">
            needs your OK on {computerLabel}
          </span>
        </div>
        <p className="text-sm font-medium text-foreground" data-testid="remote-start-panel-title">
          {request.title}
        </p>
        <p className="text-xs text-muted-foreground" data-testid="remote-start-panel-where">
          {agentLabel} would start it in {request.projectName} on {computerLabel}, with up to{" "}
          {access} access.
        </p>
        <p
          className="max-h-40 overflow-y-auto border-l border-border pl-3 text-sm whitespace-pre-wrap break-words text-muted-foreground"
          data-testid="remote-start-panel-prompt"
        >
          {request.prompt}
        </p>
      </div>
      <RemoteRequestAnswerButtons answering={answering} respond={respond} />
    </div>
  );
});

/** The other moves the same computer asked of this one, with this one; null when it asked only this. */
function useMoveGroupOf(pending: PendingLinkRequest): PendingMoveGroup | null {
  const all = usePendingLinkRequests();
  const groupable = useThreadMoveStagedApprovalCheck();
  const { environmentId, request } = pending;
  return useMemo(() => {
    if (request.kind !== "move") return null;
    for (const item of groupPendingLinkRequests(all, groupable)) {
      if (
        item.kind === "moves" &&
        item.environmentId === environmentId &&
        item.requests.some((candidate) => candidate.requestId === request.requestId)
      ) {
        return item;
      }
    }
    return null;
  }, [all, environmentId, groupable, request.kind, request.requestId]);
}

/** Allow all of a computer's moves here at once (useMoveGroupAnswer). */
function AllowAllButton({
  group,
  computerLabel,
}: {
  readonly group: PendingMoveGroup;
  readonly computerLabel: string;
}) {
  const { answering, respond } = useMoveGroupAnswer(group, computerLabel);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={answering !== null}
      onClick={() => void respond(true)}
      data-testid="remote-start-panel-allow-all"
    >
      Allow all {group.requests.length}
    </Button>
  );
}

/** Deny and Allow, held once an answer is on its way (useLinkRequestAnswer). */
function RemoteRequestAnswerButtons({
  answering,
  respond,
  children,
}: {
  readonly answering: "allow" | "deny" | null;
  readonly respond: (allow: boolean) => Promise<void>;
  /** More answers, between Deny and Allow. */
  readonly children?: ReactNode;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={answering !== null}
        onClick={() => void respond(false)}
        data-testid="remote-start-panel-deny"
      >
        Deny
      </Button>
      {children}
      <Button
        size="sm"
        variant="default"
        disabled={answering !== null}
        onClick={() => void respond(true)}
        data-testid="remote-start-panel-allow"
      >
        Allow
      </Button>
    </div>
  );
}
