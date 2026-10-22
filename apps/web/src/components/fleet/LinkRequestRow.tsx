import type { ComputerLinkPendingRequest } from "@threadlines/contracts";
import { useState } from "react";

import {
  type ComputerLinkTarget,
  describeComputerLinkFailure,
  respondToComputerLinkRequest,
} from "../../environments/links/computerLinks";
import { cn } from "../../lib/utils";
import { SETTINGS_GROUP_ROW_CLASS } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * A thread another computer's agent asked to start, waiting for this
 * computer's user (docs/design/fleet.md, Part 2 "Ask first"): who asks and
 * for what, the project, the asking thread and a one-line look at the
 * prompt, with Allow and Deny. A row in a group, never a card. `showWorker`
 * names the computer it would run on, where the row doesn't say it already.
 */
export function LinkRequestRow({
  request,
  worker,
  showWorker = false,
  className,
}: {
  readonly request: ComputerLinkPendingRequest;
  readonly worker: ComputerLinkTarget;
  readonly showWorker?: boolean;
  readonly className?: string;
}) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const respond = async (allow: boolean) => {
    setBusy(allow ? "allow" : "deny");
    try {
      await respondToComputerLinkRequest(worker, {
        deviceId: request.deviceId,
        requestId: request.requestId,
        allow,
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: allow ? "Could not allow it" : "Could not deny it",
          description: describeComputerLinkFailure(error, "Try again."),
        }),
      );
    } finally {
      setBusy(null);
    }
  };
  const prompt = request.prompt.replace(/\s+/gu, " ").trim();
  return (
    <div
      className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5", className)}
      data-testid={`link-request-${request.requestId}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="truncate text-[13.5px] leading-[19px] font-medium text-foreground">
            {showWorker
              ? `${request.fromLabel} wants to start a thread on ${worker.label}: ${request.title}`
              : `${request.fromLabel} wants to start a thread: ${request.title}`}
          </p>
          <p className="truncate text-[12.5px] leading-[18px] text-muted-foreground">
            {request.projectName} · from “{request.parentThreadTitle}”
          </p>
          {prompt.length > 0 ? (
            <p className="truncate text-[12.5px] leading-[18px] text-muted-foreground">{prompt}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void respond(false)}
            data-testid={`link-request-deny-${request.requestId}`}
          >
            {busy === "deny" ? "Denying..." : "Deny"}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void respond(true)}
            data-testid={`link-request-allow-${request.requestId}`}
          >
            {busy === "allow" ? "Allowing..." : "Allow"}
          </Button>
        </div>
      </div>
    </div>
  );
}
