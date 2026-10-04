import { type ApprovalRequestId, type ProviderApprovalDecision } from "@threadlines/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { type ComponentProps, memo } from "react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  /** The answers the provider accepts. Absent: all of them. */
  availableDecisions?: ReadonlyArray<ProviderApprovalDecision> | undefined;
  /** A risk the provider attached to an answer, shown on its button. */
  decisionWarnings?: Partial<Record<ProviderApprovalDecision, string>> | undefined;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}

const APPROVAL_ACTIONS: ReadonlyArray<{
  readonly decision: ProviderApprovalDecision;
  readonly label: string;
  readonly variant: ComponentProps<typeof Button>["variant"];
}> = [
  { decision: "cancel", label: "Cancel turn", variant: "ghost" },
  { decision: "decline", label: "Decline", variant: "destructive-outline" },
  { decision: "acceptForSession", label: "Always allow this session", variant: "outline" },
  { decision: "accept", label: "Approve once", variant: "default" },
];

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  availableDecisions,
  decisionWarnings,
  isResponding,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  return (
    <>
      {APPROVAL_ACTIONS.filter(
        (action) => !availableDecisions || availableDecisions.includes(action.decision),
      ).map((action) => {
        const warning = decisionWarnings?.[action.decision];
        const button = (
          <Button
            key={action.decision}
            size="sm"
            variant={action.variant}
            disabled={isResponding}
            onClick={() => void onRespondToApproval(requestId, action.decision)}
          >
            {warning ? <TriangleAlertIcon className="text-warning" aria-hidden /> : null}
            {action.label}
          </Button>
        );
        if (!warning) return button;
        return (
          <Tooltip key={action.decision}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top" className="max-w-xs">
              {warning}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </>
  );
});
