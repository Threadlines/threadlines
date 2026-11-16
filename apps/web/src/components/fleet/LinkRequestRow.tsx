import type { ComputerLinkPendingRequest } from "@threadlines/contracts";
import { useMemo } from "react";

import type { ComputerLinkTarget } from "../../environments/links/computerLinks";
import { useThreadMoveStagedApprovalCheck } from "../../environments/links/threadMoves";
import { cn } from "../../lib/utils";
import { runtimeModeConfig } from "../../runtimeModeOptions";
import {
  formatThreadMoveAccess,
  formatThreadMoveArrival,
  formatThreadMoveChanges,
} from "../../threadMove";
import { SETTINGS_GROUP_ROW_CLASS } from "../settings/settingsLayout";
import {
  groupPendingLinkRequests,
  type PendingMoveGroup,
  useLinkRequestAnswer,
  useMoveGroupAnswer,
} from "../sidebar/linkedComputers";
import { Button } from "../ui/button";

/**
 * A thread another computer's agent asked to start, waiting for this
 * computer's user (docs/design/fleet.md, Part 2 "Ask first"): who asks and
 * for what, the project, the asking thread and a one-line look at the
 * prompt, with Allow and Deny. A row in a group, never a card. `showWorker`
 * names the computer it would run on, where the row doesn't say it already.
 * A move (Part 3) names the thread, what goes with it, how much of it is
 * here already and where it lands; `inGroup`, under its group's row (Part
 * 3c), it leads with the thread's title alone.
 */
export function LinkRequestRow({
  request,
  worker,
  showWorker = false,
  inGroup = false,
  className,
}: {
  readonly request: ComputerLinkPendingRequest;
  readonly worker: ComputerLinkTarget;
  readonly showWorker?: boolean;
  readonly inGroup?: boolean;
  readonly className?: string;
}) {
  // Shared with the inbox row and the card: an answer sent from any holds all.
  const pending = useMemo(
    () => ({ environmentId: worker.environmentId, request }),
    [request, worker.environmentId],
  );
  const { answering, respond } = useLinkRequestAnswer(pending, worker.label);
  const prompt = request.prompt.replace(/\s+/gu, " ").trim();
  const isMove = request.kind === "move";
  const arrival = request.move ? formatThreadMoveArrival(request.move) : null;
  const heading = inGroup
    ? request.title
    : isMove
      ? showWorker
        ? `${request.fromLabel} wants to move a thread to ${worker.label}: ${request.title}`
        : `${request.fromLabel} wants to move a thread here: ${request.title}`
      : showWorker
        ? `${request.fromLabel} wants to start a thread on ${worker.label}: ${request.title}`
        : `${request.fromLabel} wants to start a thread: ${request.title}`;
  return (
    <div
      className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5", inGroup && "ps-7", className)}
      data-testid={`link-request-${request.requestId}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="truncate text-[13.5px] leading-[19px] font-medium text-foreground">
            {heading}
          </p>
          {isMove ? (
            <>
              {request.move ? (
                <p className="truncate text-[12.5px] leading-[18px] text-muted-foreground">
                  {formatThreadMoveChanges(request.move)}
                  {arrival !== null ? ` · ${arrival}` : null}
                </p>
              ) : null}
              <p className="truncate text-[12.5px] leading-[18px] text-muted-foreground">
                Lands in {request.projectName} with up to{" "}
                {formatThreadMoveAccess(runtimeModeConfig[request.runtimeMode].label)}
              </p>
            </>
          ) : (
            <p className="truncate text-[12.5px] leading-[18px] text-muted-foreground">
              {request.projectName} · from “{request.parentThreadTitle}”
            </p>
          )}
          {prompt.length > 0 ? (
            <p className="truncate text-[12.5px] leading-[18px] text-muted-foreground">{prompt}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={answering !== null}
            onClick={() => void respond(false)}
            data-testid={`link-request-deny-${request.requestId}`}
          >
            {answering === "deny" ? "Denying..." : "Deny"}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={answering !== null}
            onClick={() => void respond(true)}
            data-testid={`link-request-allow-${request.requestId}`}
          >
            {answering === "allow" ? "Allowing..." : "Allow"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Moves from one computer (Part 3c): "Mac wants to move 3 threads here",
 * with Allow all and Don't allow, then each move's own row, where it can be
 * answered on its own.
 */
function LinkRequestGroupRows({
  group,
  worker,
  showWorker,
}: {
  readonly group: PendingMoveGroup;
  readonly worker: ComputerLinkTarget;
  readonly showWorker: boolean;
}) {
  const { answering, respond } = useMoveGroupAnswer(group, worker.label);
  const first = group.requests[0];
  const count = group.requests.length;
  const testId = `link-request-group-${group.deviceId}`;
  return (
    <>
      <div className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5")} data-testid={testId}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <p className="min-w-0 flex-1 truncate text-[13.5px] leading-[19px] font-medium text-foreground">
            {showWorker
              ? `${first?.fromLabel ?? "A computer"} wants to move ${count} threads to ${worker.label}`
              : `${first?.fromLabel ?? "A computer"} wants to move ${count} threads here`}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={answering !== null}
              onClick={() => void respond(false)}
              data-testid={`${testId}-deny`}
            >
              {answering === "deny" ? "Turning down..." : "Don't allow"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={answering !== null}
              onClick={() => void respond(true)}
              data-testid={`${testId}-allow`}
            >
              {answering === "allow" ? "Allowing..." : "Allow all"}
            </Button>
          </div>
        </div>
      </div>
      {group.requests.map((request) => (
        <LinkRequestRow key={request.requestId} request={request} worker={worker} inGroup />
      ))}
    </>
  );
}

/**
 * Requests waiting for this user's Allow, each a LinkRequestRow, with the
 * moves one computer asked of another grouped under one row where that
 * computer answers several at once (Part 3c).
 */
export function LinkRequestRows({
  requests,
  showWorker = false,
}: {
  readonly requests: ReadonlyArray<{
    readonly request: ComputerLinkPendingRequest;
    readonly worker: ComputerLinkTarget;
  }>;
  readonly showWorker?: boolean;
}) {
  const groupable = useThreadMoveStagedApprovalCheck();
  const workerById = new Map(
    requests.map(({ worker }) => [worker.environmentId as string, worker] as const),
  );
  const items = groupPendingLinkRequests(
    requests.map(({ request, worker }) => ({ environmentId: worker.environmentId, request })),
    groupable,
  );
  return items.map((item) => {
    const worker = workerById.get(item.environmentId);
    if (worker === undefined) return null;
    return item.kind === "single" ? (
      <LinkRequestRow
        key={`${item.environmentId}:${item.request.requestId}`}
        request={item.request}
        worker={worker}
        showWorker={showWorker}
      />
    ) : (
      <LinkRequestGroupRows
        key={`${item.environmentId}:${item.deviceId}`}
        group={item}
        worker={worker}
        showWorker={showWorker}
      />
    );
  });
}
